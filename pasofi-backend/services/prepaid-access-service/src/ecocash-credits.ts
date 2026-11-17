import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { seal, unseal, type DeliveryKeys } from './delivery-crypto.js';
import { createEcoCashVoucher } from './vouchers.js';

// This is the normalized input to the disposable simulation, not an EcoCash
// wire format or proof of payment. No HTTP route or provider adapter calls it.
export type SimulatedEcoCashObservation = {
  kind: 'credit' | 'reversal';
  transactionId: string;
  merchantCode: string;
  currency: string;
  amountMinor: number;
  payerPhone?: string | null;
  paidAt: string; // Both kinds refer to the original payment and payment time.
};
export type EcoCashOffer = {
  bundleId: string;
  amountMinor: number;
  byteLimit: string;
  validitySeconds: number;
  validFrom: string;
  validUntil: string;
};
export type EcoCashCreditConfig = { merchantCode: string; currency: 'USD'; offers: EcoCashOffer[] };
type StoredState = 'issued' | 'review' | 'reversed';
type Outcome = { creditId: string | null; state: StoredState | 'ignored'; reason: string | null };
type CreditRow = {
  id: string; state: StoredState; reason: string | null; reversed_at: Date | null;
  paid_at: Date; currency: string; merchant_code: string; amount_minor: number;
  phone_key_id: string | null; phone_iv: Buffer; phone_cipher: Buffer; phone_tag: Buffer;
};
const merchant = /^[a-zA-Z0-9_-]{1,32}$/;
const reference = /^[a-zA-Z0-9._-]{1,128}$/;
const startWindowMs = 30 * 24 * 60 * 60 * 1000;

function utc(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) {
    throw Error('invalid_ecocash_timestamp');
  }
  const ms = Date.parse(value);
  const canonical = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== canonical) {
    throw Error('invalid_ecocash_timestamp');
  }
  return ms;
}
function positiveInt(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 2147483647;
}
function validateConfig(config: EcoCashCreditConfig) {
  if (!config || typeof config.merchantCode !== 'string' || !merchant.test(config.merchantCode) ||
      config.currency !== 'USD' || !Array.isArray(config.offers) || config.offers.length > 1000) throw Error('invalid_ecocash_credit_config');
  for (const offer of config.offers) {
    if (!offer || typeof offer.bundleId !== 'string' || !offer.bundleId.length || offer.bundleId.length > 128 ||
        !positiveInt(offer.amountMinor) || !positiveInt(offer.validitySeconds) ||
        typeof offer.byteLimit !== 'string' || !/^[1-9]\d{0,18}$/.test(offer.byteLimit) ||
        BigInt(offer.byteLimit) > 9223372036854775807n || utc(offer.validFrom) >= utc(offer.validUntil)) {
      throw Error('invalid_ecocash_offer');
    }
  }
}
function normalizedPhone(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const digits = /^(?:\+?263|0)?(7\d{8})$/.exec(value);
  return digits ? '263' + digits[1] : null;
}
function originalPhone(row: CreditRow, keys: DeliveryKeys) {
  if (!row.phone_key_id) return null;
  return unseal({keyId: row.phone_key_id, iv: row.phone_iv, cipher: row.phone_cipher, tag: row.phone_tag},
    keys, `ecocash:phone:${row.id}`);
}

async function findOffer(client: PoolClient, config: EcoCashCreditConfig, input: SimulatedEcoCashObservation,
  paidAt: number, phone: string | null): Promise<{offer: EcoCashOffer | null; reason: string | null}> {
  if (input.currency !== config.currency) return {offer: null, reason: 'unsupported_currency'};
  if (!phone) return {offer: null, reason: 'payer_unavailable'};
  const now = Date.now();
  if (paidAt > now || paidAt + startWindowMs <= now) return {offer: null, reason: 'payment_time_outside_window'};
  const matches = config.offers.filter(offer => offer.amountMinor === input.amountMinor &&
    utc(offer.validFrom) <= paidAt && paidAt < utc(offer.validUntil));
  if (!matches.length) return {offer: null, reason: 'unmatched_amount'};
  if (matches.length !== 1) return {offer: null, reason: 'ambiguous_amount'};
  const offer = matches[0];
  // A delayed transfer is valued under the offer active at payment time. If
  // the corresponding catalogue version was withdrawn or edited, hold it.
  const bundle = await client.query(`SELECT id FROM bundle_versions
    WHERE id=$1 AND published AND price_minor=$2 AND currency=$3 AND byte_limit=$4 AND validity_seconds=$5 FOR SHARE`,
    [offer.bundleId, offer.amountMinor, input.currency, offer.byteLimit, offer.validitySeconds]);
  return bundle.rowCount ? {offer, reason: null} : {offer: null, reason: 'bundle_terms_unavailable'};
}

// The credit row is already locked. Use the same customer lock as accounting
// and grant issuance before fencing a redeemed entitlement or active session.
async function withdrawCreditAccess(client: PoolClient, creditId: string): Promise<boolean> {
  const voucher = (await client.query(
    'SELECT id,state,redeemed_by FROM issued_vouchers WHERE ecocash_credit_id=$1 FOR UPDATE', [creditId])).rows[0];
  if (!voucher || voucher.state === 'revoked') return false;
  if (voucher.state === 'valid') {
    await client.query("UPDATE issued_vouchers SET state='revoked' WHERE id=$1", [voucher.id]);
    return false;
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [voucher.redeemed_by]);
  const entitlement = (await client.query(`UPDATE purchase_entitlements SET revoked_at=COALESCE(revoked_at,now())
    WHERE source_voucher_id=$1 RETURNING id,activated_at,consumed_bytes`, [voucher.id])).rows[0];
  if (!entitlement) throw Error('ecocash_redemption_inconsistent');
  const openGrants = await client.query(`UPDATE access_grants SET state='uncertain',
    disconnect_requested_at=COALESCE(disconnect_requested_at,now()) WHERE entitlement_id=$1 AND state<>'closed' RETURNING id`,
  [entitlement.id]);
  if (openGrants.rows.length) {
    await client.query(`INSERT INTO network_account_holds(customer_id,grant_id,reason)
      VALUES($1,$2,'payment_reversal_active_access') ON CONFLICT(customer_id) DO NOTHING`,
    [voucher.redeemed_by, openGrants.rows[0].id]);
  }
  return Boolean(entitlement.activated_at) || BigInt(entitlement.consumed_bytes) > 0n || openGrants.rows.length > 0;
}

async function applyToExisting(client: PoolClient, row: CreditRow, keys: DeliveryKeys, input: SimulatedEcoCashObservation,
  paidAt: number, phone: string | null): Promise<Outcome> {
  const matching = row.merchant_code === input.merchantCode && row.currency === input.currency &&
    row.amount_minor === input.amountMinor && row.paid_at.getTime() === paidAt && originalPhone(row, keys) === phone;
  const prior = {creditId: row.id, state: row.state, reason: row.reason};
  if (matching && (input.kind === 'credit' || row.reversed_at)) return prior;
  // A conflicting reference cannot replace the original amount or recipient.
  // Keep the credit unavailable even if a matching old success arrives later.
  if (!matching) {
    if (row.reversed_at || row.reason === 'conflicting_observation') return prior;
    await withdrawCreditAccess(client, row.id);
    await client.query("UPDATE ecocash_credits SET state='review',reason='conflicting_observation' WHERE id=$1", [row.id]);
    return {creditId: row.id, state: 'review', reason: 'conflicting_observation'};
  }
  const consumed = await withdrawCreditAccess(client, row.id);
  const reason = consumed ? 'consumed_reversal' : null;
  const state = consumed ? 'review' : 'reversed';
  await client.query('UPDATE ecocash_credits SET state=$2,reason=$3,reversed_at=now() WHERE id=$1', [row.id, state, reason]);
  return {creditId: row.id, state, reason};
}

export async function applySimulatedEcoCashCredit(pool: Pool, keys: DeliveryKeys, config: EcoCashCreditConfig,
  input: SimulatedEcoCashObservation): Promise<Outcome> {
  if (process.env.APP_ENV !== 'demo' || process.env.NODE_ENV !== 'development') throw Error('isolated_demo_required');
  validateConfig(config);
  if (!input || !['credit','reversal'].includes(input.kind) || typeof input.transactionId !== 'string' ||
      !reference.test(input.transactionId) || typeof input.merchantCode !== 'string' || !merchant.test(input.merchantCode) ||
      typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency) || !positiveInt(input.amountMinor)) {
    throw Error('invalid_ecocash_observation');
  }
  const paidAt = utc(input.paidAt);
  if (input.merchantCode !== config.merchantCode) return {creditId: null, state: 'ignored', reason: 'merchant_mismatch'};
  const phone = normalizedPhone(input.payerPhone);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['ecocash:simulation:' + input.merchantCode + ':' + input.transactionId]);
    const existing = (await client.query<CreditRow>(`SELECT * FROM ecocash_credits
      WHERE environment='simulation' AND merchant_code=$1 AND transaction_id=$2 FOR UPDATE`, [input.merchantCode, input.transactionId])).rows[0];
    let result: Outcome;
    if (existing) {
      result = await applyToExisting(client, existing, keys, input, paidAt, phone);
    } else {
      const creditId = randomUUID();
      const reversed = input.kind === 'reversal';
      const {offer, reason} = reversed ? {offer: null, reason: null} : await findOffer(client, config, input, paidAt, phone);
      const state = reversed ? 'reversed' : offer ? 'issued' : 'review';
      const encrypted = phone ? seal(phone, keys, `ecocash:phone:${creditId}`) : null;
      await client.query(`INSERT INTO ecocash_credits(id,environment,transaction_id,merchant_code,currency,amount_minor,
        paid_at,phone_key_id,phone_iv,phone_cipher,phone_tag,bundle_id,byte_limit,validity_seconds,start_by,state,reason,reversed_at)
        VALUES($1,'simulation',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CASE WHEN $17 THEN now() END)`,
      [creditId, input.transactionId, input.merchantCode, input.currency, input.amountMinor, new Date(paidAt),
        encrypted?.keyId, encrypted?.iv, encrypted?.cipher, encrypted?.tag, offer?.bundleId, offer?.byteLimit,
        offer?.validitySeconds, offer ? new Date(paidAt + startWindowMs) : null, state, reason, reversed]);
      if (offer) {
        await createEcoCashVoucher(client, creditId, keys);
        await client.query(`INSERT INTO event_outbox(id,event_type,event_version,aggregate_id,aggregate_version,correlation_id,payload)
          VALUES($1,'ecocash.voucher.issued',1,$2,1,$3,$4)`,
        [randomUUID(), creditId, randomUUID(), {deliveryReference: creditId}]);
      }
      result = {creditId, state, reason};
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
