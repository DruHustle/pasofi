import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ResendInvoiceAdapter, invoiceEmailAddress, invoiceSender, type InvoiceSendResult } from './invoice-email.js';
import { SendaiAdapter } from './sendai.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Config = { enabled: boolean; email: 'disabled' | 'mock' | 'resend'; sms: 'disabled' | 'mock' | 'sendai'; from: string; smsFrom: string };
type Details = { invoiceId: string; invoiceNumber: string; channel: 'email' | 'sms' | 'none'; simulation: boolean; to?: string; link?: string; expiresAt?: string; filename: string; contentType: 'application/pdf' };
function invoiceOrigin(demo: boolean) {
  const origin = new URL(process.env.PUBLIC_ORIGIN ?? '');
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || (!demo && origin.protocol !== 'https:') || (demo && !['http:', 'https:'].includes(origin.protocol))) throw Error('invalid_invoice_origin');
  return origin;
}
function sourceConfiguration(demo: boolean) {
  const base = process.env.PREPAID_URL, secret = process.env.INTERNAL_DELIVERY_SECRET ?? '';
  if (!base || Buffer.byteLength(secret) < 32 || (!demo && secret.startsWith('DEMO_ONLY_'))) throw Error('invalid_invoice_source_configuration');
  const target = new URL(base);
  if (target.username || target.password || target.search || target.hash || target.pathname !== '/' || (!demo && target.protocol !== 'https:') || (demo && !['http:', 'https:'].includes(target.protocol))) throw Error('invalid_invoice_source_configuration');
  return { base: target, secret };
}
export function invoiceDeliveryConfiguration(demo: boolean): Config {
  const from = process.env.INVOICE_EMAIL_FROM ?? '', smsFrom = process.env.INVOICE_SMS_FROM ?? '';
  const config: Config = { enabled: false, email: 'disabled', sms: 'disabled', from, smsFrom };
  if (process.env.INVOICE_DELIVERY_WORKER_ENABLED !== 'true') return config;
  try { sourceConfiguration(demo); } catch { return config; }
  const live = !demo && process.env.APP_ENV === 'production' && process.env.NODE_ENV === 'production';
  if (demo && process.env.INVOICE_EMAIL_MODE === 'mock') config.email = 'mock';
  else if (live && process.env.INVOICE_EMAIL_MODE === 'resend' && process.env.INVOICE_EMAIL_QUALIFIED === 'true' && invoiceSender(from)) {
    try { new ResendInvoiceAdapter(process.env.RESEND_API_KEY ?? ''); config.email = 'resend'; } catch { /* Unqualified credentials never advertise delivery. */ }
  }
  if (demo && process.env.INVOICE_SMS_MODE === 'mock') config.sms = 'mock';
  else if (live && process.env.INVOICE_SMS_MODE === 'sendai' && process.env.INVOICE_SMS_QUALIFIED === 'true' && /^[A-Za-z0-9]{1,11}$/.test(smsFrom) && process.env.SENDAI_LIVE_ENABLED === 'true' && process.env.SENDAI_QUALIFIED === 'true' && process.env.SENDAI_API_KEY) config.sms = 'sendai';
  if (config.sms !== 'disabled') {
    try { invoiceOrigin(demo); if (config.sms === 'sendai') new SendaiAdapter(process.env.SENDAI_API_KEY!); } catch { config.sms = 'disabled'; }
  }
  config.enabled = config.email !== 'disabled' || config.sms !== 'disabled';
  return config;
}
async function source(reference: string, suffix: '' | '/pdf', demo: boolean) {
  if (!uuid.test(reference)) throw Error('invalid_invoice_reference');
  const { base, secret } = sourceConfiguration(demo);
  const token = await new SignJWT({ scope: 'invoice:read' }).setProtectedHeader({ alg: 'HS256' }).setIssuer('notification').setSubject('notification').setAudience('prepaid-access').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
  const response = await fetch(new URL(`/internal/v1/invoices/${reference}${suffix}`, base), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok || !response.body) throw Error('invoice_source_unavailable');
  const expected = suffix ? /^application\/pdf(?:;\s*charset=utf-8)?$/i : /^application\/json(?:;\s*charset=utf-8)?$/i;
  if (!expected.test(response.headers.get('content-type') ?? '')) throw Error('invalid_invoice_source');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > (suffix ? 1048576 : 16384)) { await reader.cancel(); throw Error('invoice_too_large'); } chunks.push(item.value); }
  const bytes = Buffer.concat(chunks);
  if (suffix) { if (bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('invalid_invoice_pdf'); return bytes; }
  const data = JSON.parse(bytes.toString('utf8')) as Details;
  if (!data || data.invoiceId !== reference || !/^[A-Z0-9-]{1,80}$/.test(data.invoiceNumber) || !['none', 'email', 'sms'].includes(data.channel) || data.simulation !== demo
    || data.contentType !== 'application/pdf' || data.filename !== `${data.invoiceNumber}.pdf`) throw Error('invalid_invoice_details');
  if (data.channel === 'email' && !invoiceEmailAddress(data.to)) throw Error('invalid_invoice_recipient');
  if (data.channel === 'sms') {
    if (typeof data.to !== 'string' || !/^263[0-9]{9}$/.test(data.to) || typeof data.link !== 'string') throw Error('invalid_invoice_recipient');
    const link = new URL(data.link), origin = invoiceOrigin(demo);
    if (link.origin !== origin.origin || link.username || link.password || link.search || link.pathname !== '/' || !/^#invoice=[A-Za-z0-9_-]{43}$/.test(link.hash) || (!demo && link.protocol !== 'https:')) throw Error('invalid_invoice_link');
    if (typeof data.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.expiresAt) || !Number.isFinite(Date.parse(data.expiresAt)) || Date.parse(data.expiresAt) <= Date.now()) throw Error('invoice_link_expired');
  }
  return data;
}

/** One durable send per invoice; ambiguous delivery is reconciled, never resubmitted. */
export async function processInvoiceDelivery(pool: Pool, demo: boolean, config = invoiceDeliveryConfiguration(demo)): Promise<boolean> {
  if (!config.enabled) return false;
  await pool.query("UPDATE invoice_jobs SET state='unknown',last_error='delivery_unconfirmed',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE state='submitting' AND attempted_at<now()-interval '60 seconds' AND (lease_until IS NULL OR lease_until<now())");
  const lease = randomUUID();
  const claimed = await pool.query(`UPDATE invoice_jobs SET lease_token=$1,lease_until=now()+interval '45 seconds'
    WHERE id=(SELECT id FROM invoice_jobs WHERE state IN ('queued','submitted','unknown') AND next_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`, [lease]);
  if (!claimed.rowCount) return false;
  const job = claimed.rows[0];
  const release = async (error: string | null, seconds: number) => pool.query("UPDATE invoice_jobs SET lease_token=NULL,lease_until=NULL,last_error=$3,next_at=now()+make_interval(secs=>$4),updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, lease, error, seconds]);
  try {
    if (job.state === 'submitted' || job.state === 'unknown') {
      if (!job.provider_id) { await release('manual_review_required', 3600); return true; }
      let result: InvoiceSendResult;
      if (job.provider === 'resend' && config.email === 'resend') result = await new ResendInvoiceAdapter(process.env.RESEND_API_KEY!).retrieve(job.provider_id);
      else if (job.provider === 'sendai' && config.sms === 'sendai') { const sms = await new SendaiAdapter(process.env.SENDAI_API_KEY!).retrieve(job.provider_id); result = { state: sms.state, providerId: sms.providerId, error: sms.state === 'unknown' ? 'delivery_unconfirmed' : sms.state === 'failed' ? 'provider_delivery_failed' : null }; }
      else { await release('provider_configuration_changed', 3600); return true; }
      await pool.query("UPDATE invoice_jobs SET state=$3,last_error=$4,delivered_at=CASE WHEN $3='delivered' THEN COALESCE(delivered_at,now()) ELSE delivered_at END,lease_token=NULL,lease_until=NULL,next_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, lease, result.state, result.error]);
      return true;
    }
    const details = await source(job.invoice_id, '', demo) as Details;
    if (details.channel === 'none') { await pool.query("UPDATE invoice_jobs SET state='canceled',last_error='download_only',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, lease]); return true; }
    const provider = details.channel === 'email' ? config.email : config.sms;
    if (provider === 'disabled') { await release(`${details.channel}_delivery_disabled`, 300); return true; }
    const pdf = details.channel === 'email' ? await source(job.invoice_id, '/pdf', demo) as Buffer : null;
    const message = details.channel === 'sms' ? `PasoFi paid invoice ${details.invoiceNumber}: ${details.link} Valid until ${details.expiresAt!.slice(0, 16).replace('T', ' ')} UTC. Keep private.` : null;
    const ready = await pool.query("UPDATE invoice_jobs SET state='submitting',channel=$3,provider=$4,attempted_at=now(),last_error=NULL,lookup_attempts=0,updated_at=now() WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='queued' RETURNING id", [job.id, lease, details.channel, provider]);
    if (!ready.rowCount) return true;
    let result: InvoiceSendResult;
    if (provider === 'mock') {
      await pool.query('INSERT INTO mock_invoice_sink(job_id,channel,content_hash,recipient_hash) VALUES($1,$2,$3,$4) ON CONFLICT(job_id) DO NOTHING', [job.id, details.channel, createHash('sha256').update(pdf ?? message!).digest(), createHash('sha256').update(details.to!).digest()]);
      result = { state: 'delivered', providerId: job.id, error: null };
    } else if (provider === 'resend') result = await new ResendInvoiceAdapter(process.env.RESEND_API_KEY!).send({ id: job.id, to: details.to!, from: config.from, number: details.invoiceNumber, filename: details.filename, pdf: pdf! });
    else { const sms = await new SendaiAdapter(process.env.SENDAI_API_KEY!).send({ to: details.to!, from: config.smsFrom, message: message! }); result = { state: sms.state, providerId: sms.providerId, error: sms.state === 'unknown' ? 'delivery_unconfirmed' : sms.state === 'failed' ? 'provider_rejected' : null }; }
    await pool.query("UPDATE invoice_jobs SET state=$3,provider_id=$4,last_error=$5,delivered_at=CASE WHEN $3='delivered' THEN now() ELSE NULL END,lease_token=NULL,lease_until=NULL,next_at=now()+make_interval(secs=>$6),updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='submitting'", [job.id, lease, result.state === 'retry' ? 'queued' : result.state, result.providerId, result.error, result.retryAfter ?? 60]);
    return true;
  } catch {
    await pool.query("UPDATE invoice_jobs SET lookup_attempts=lookup_attempts+1,state=CASE WHEN state='submitting' THEN 'unknown' WHEN state='queued' AND lookup_attempts>=9 THEN 'failed' ELSE state END,last_error=CASE WHEN state='submitting' THEN 'delivery_unconfirmed' ELSE 'invoice_source_unavailable' END,lease_token=NULL,lease_until=NULL,next_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND lease_token=$2", [job.id, lease]);
    return true;
  }
}

export function registerInvoiceDelivery(app: FastifyInstance, pool: Pool | null, demo: boolean) {
  const config = invoiceDeliveryConfiguration(demo);
  async function authorize(request: FastifyRequest, reply: FastifyReply) {
    const secret = process.env.INTERNAL_DELIVERY_SECRET ?? '';
    if (!pool || Buffer.byteLength(secret) < 32 || (!demo && secret.startsWith('DEMO_ONLY_'))) { reply.code(503).send({ error: 'unavailable' }); return false; }
    try { const header = request.headers.authorization; if (!header?.startsWith('Bearer ')) throw Error(); const { payload } = await jwtVerify(header.slice(7), new TextEncoder().encode(secret), { algorithms: ['HS256'], issuer: 'prepaid-access', subject: 'prepaid-access', audience: 'notification', requiredClaims: ['iat', 'exp', 'sub'], maxTokenAge: '30s' }); if (payload.scope !== 'invoice:status') { reply.code(403).send({ error: 'forbidden' }); return false; } return true; }
    catch { reply.code(401).send({ error: 'unauthorized' }); return false; }
  }
  app.get('/internal/v1/invoice-delivery/capabilities', async (request, reply) => { if (!await authorize(request, reply)) return; return { email: config.enabled && config.email !== 'disabled', sms: config.enabled && config.sms !== 'disabled', simulation: demo }; });
  app.get<{ Params: { id: string } }>('/internal/v1/invoices/:id/status', async (request, reply) => {
    if (!await authorize(request, reply)) return;
    if (!uuid.test(request.params.id)) return reply.code(404).send({ error: 'not_found' });
    try {
      const row = (await pool!.query('SELECT state,channel,provider,provider_id AS "providerId",last_error AS "lastError",attempted_at AS "attemptedAt",delivered_at AS "deliveredAt" FROM invoice_jobs WHERE invoice_id=$1', [request.params.id])).rows[0];
      const { provider, ...status } = row ?? { state: 'queued', channel: null };
      // A retained mock result never becomes real delivery evidence after a
      // configuration change. The provider records the attempt's provenance.
      return { ...status, simulation: provider ? provider === 'mock' : demo };
    }
    catch { return reply.code(503).send({ error: 'unavailable' }); }
  });
  let stopped = false, timer: NodeJS.Timeout | undefined, active: Promise<void> | undefined;
  const tick = () => {
    active = (async () => { try { if (pool && !stopped) await processInvoiceDelivery(pool, demo, config); } catch { /* readiness reports database outages; never log invoice data */ } finally { if (!stopped) { timer = setTimeout(tick, 1000); timer.unref(); } } })();
  };
  if (pool && config.enabled && process.env.INVOICE_DELIVERY_WORKER_AUTOSTART !== 'false') { timer = setTimeout(tick, 1000); timer.unref(); }
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active; };
}
