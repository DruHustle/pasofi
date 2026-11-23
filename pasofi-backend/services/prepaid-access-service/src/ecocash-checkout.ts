// EcoCash Online Payments checkout inside PasoFi ("Pay in PasoFi" journey).
//
// Built for later activation and switched OFF by default. New checkout needs
// every gate in ecocashCheckoutConfiguration(); see ECOCASH_ACTIVATION.md.
// The independent Pay Merchant/USSD credit journey (ecocash-credits.ts) has its
// own path and never shares this switch.
//
// Trust rules:
// - The payer's number is sealed and committed with the attempt BEFORE the POST.
// - The charge POST is never repeated: an ambiguous initiation is resolved only
//   by the read-only lookup for the original correlator.
// - Fulfilment requires the documented Charged/00 lookup, matched identities and
//   the provider's own charged amount, currency and merchant code equal to the
//   stored order terms. Anything less stays unverified and is retried/reviewed.
import type {Pool,PoolClient} from 'pg';
import {loadDeliveryKeys,seal,unseal,type DeliveryKeys} from './delivery-crypto.js';
import {EcoCashOnlinePaymentsClient,normalizeEcoCashMsisdn,prepareEcoCashPayment,type EcoCashClientConfig} from './ecocash.js';
import type {PaymentAdapter,PaymentInput,PaymentTerms,VerifiedStatus} from './payment-provider.js';

export const ECOCASH_METHOD_CODE='ECOCASH';
// Bundle prices are USD 0.50–10.00. Confirm the merchant agreement's limits
// during qualification; these are conservative application bounds.
export const ECOCASH_METHOD={active:true,code:ECOCASH_METHOD_CODE,name:'EcoCash',currencies:['USD'],minimumAmount:'0.50',maximumAmount:'500.00'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type EcoCashCheckoutConfiguration={client:EcoCashClientConfig;live:boolean;siteIds:Set<string>;newCheckout:boolean;keys:DeliveryKeys};

function field(name:string,max=256):string|null{const value=process.env[name];return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)?value:null;}

// Returns null unless EcoCash is fully and consistently configured. A non-null
// configuration with newCheckout=false keeps reconciliation of existing
// attempts running while new EcoCash checkout stays closed.
export function ecocashCheckoutConfiguration(demo:boolean):EcoCashCheckoutConfiguration|null {
 const env=process.env,environment=env.ECOCASH_ENVIRONMENT;
 const live=environment==='production';
 if(live){
  if(demo||env.APP_ENV!=='production'||env.NODE_ENV!=='production'||env.PAMOFI_PAYMENT_MODE!=='production'||env.ECOCASH_PRODUCTION_QUALIFIED!=='true')return null;
 } else if(environment!=='sandbox'||!demo)return null;
 const keys=loadDeliveryKeys();if(!keys)return null;
 const username=field('ECOCASH_API_USERNAME'),password=field('ECOCASH_API_PASSWORD',1024),merchantCode=field('ECOCASH_MERCHANT_CODE',64),
  merchantPin=field('ECOCASH_MERCHANT_PIN',16),merchantNumber=field('ECOCASH_MERCHANT_NUMBER',16),terminalID=field('ECOCASH_TERMINAL_ID',64),
  location=field('ECOCASH_LOCATION',120),superMerchantName=field('ECOCASH_SUPER_MERCHANT_NAME',120),merchantName=field('ECOCASH_MERCHANT_NAME',120);
 if(!username||!password||!merchantCode||!merchantPin||!merchantNumber||!terminalID||!location||!superMerchantName||!merchantName)return null;
 const base={username,password,merchantCode,merchantPin,merchantNumber,terminalID,location,superMerchantName,merchantName};
 const client:EcoCashClientConfig=live?{...base,environment:'production',baseUrl:env.ECOCASH_API_BASE_URL??''}:{...base,environment:'sandbox'};
 // Validate every value exactly as the client will use it, without any network call.
 try{new EcoCashOnlinePaymentsClient(client,async()=>{throw Error('configuration check only');});}catch{return null;}
 let sites:unknown;try{sites=JSON.parse(env.ECOCASH_QUALIFIED_SITE_IDS_JSON??'[]');}catch{return null;}
 if(!Array.isArray(sites)||sites.length>1000||!sites.every(id=>typeof id==='string'&&uuid.test(id))||new Set(sites).size!==sites.length)return null;
 // The journey's own switch plus the global new-payment switch. Live checkout
 // additionally needs the same physical customer-network gates as Stripe.
 const physical=!live||(env.PAMOFI_CUSTOMER_NETWORK_ENABLED==='true'&&env.PAMOFI_RADIUS_QUALIFIED==='true'&&env.PAMOFI_ROUTER_CONTROL_QUALIFIED==='true');
 const newCheckout=env.PAMOFI_ECOCASH_CHECKOUT_ENABLED==='true'&&env.PAMOFI_PAYMENTS_ENABLED==='true'&&sites.length>0&&physical;
 return {client,live,siteIds:new Set(sites.map(id=>id.toLowerCase())),newCheckout,keys};
}

export class EcoCashCheckoutError extends Error {constructor(public readonly code:string){super(code);}}

// Parses a customer-entered wallet number; throws EcoCashCheckoutError otherwise.
export function payerNumber(value:unknown):string {
 if(typeof value!=='string'||value.length>16)throw new EcoCashCheckoutError('invalid_ecocash_number');
 try{return normalizeEcoCashMsisdn(value.replace(/[\s-]/g,''));}catch{throw new EcoCashCheckoutError('invalid_ecocash_number');}
}

const aad=(attemptId:string)=>`ecocash:checkout:${attemptId}`;

// Runs inside the attempt-creation transaction, so the payer context exists
// before any provider call can be made for this attempt.
export async function persistEcoCashContext(client:PoolClient,config:EcoCashCheckoutConfiguration,attemptId:string,msisdn:string){
 const sealed=seal(msisdn,config.keys,aad(attemptId));
 await client.query(`INSERT INTO ecocash_checkout_contexts(attempt_id,environment,merchant_code,payer_key_id,payer_iv,payer_cipher,payer_tag,payer_hint)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[attemptId,config.client.environment,config.client.merchantCode,sealed.keyId,sealed.iv,sealed.cipher,sealed.tag,msisdn.slice(-3)]);
}

export class EcoCashCheckoutAdapter implements PaymentAdapter {
 readonly provider:'ecocash'|'ecocash_test';
 // Deliberately no initiationReplaySeconds: an ambiguous POST is never re-sent.
 readonly client:EcoCashOnlinePaymentsClient;
 constructor(readonly config:EcoCashCheckoutConfiguration,private readonly pool:Pool,fetcher?:typeof fetch){
  this.provider=config.live?'ecocash':'ecocash_test';
  this.client=new EcoCashOnlinePaymentsClient(config.client,fetcher);
 }
 private async prepared(attemptId:string,orderId:string,amountMinor:number,currency:string){
  const row=(await this.pool.query('SELECT environment,merchant_code,payer_key_id,payer_iv,payer_cipher,payer_tag FROM ecocash_checkout_contexts WHERE attempt_id=$1',[attemptId])).rows[0];
  if(!row||row.environment!==this.config.client.environment||row.merchant_code!==this.config.client.merchantCode)throw Error('ecocash_context_unavailable');
  const msisdn=unseal({keyId:row.payer_key_id,iv:row.payer_iv,cipher:row.payer_cipher,tag:row.payer_tag},this.config.keys,aad(attemptId));
  return prepareEcoCashPayment({attemptId,orderId,customerMsisdn:msisdn,amountMinor,currency},this.config.client.environment);
 }
 async initiate(input:PaymentInput) {
  const prepared=await this.prepared(input.attemptId,input.orderId,input.amountMinor,input.currency);
  // The client never throws for transport/provider errors and never retries.
  const result=await this.client.initiate(prepared);
  if(result.providerReference)await this.pool.query('UPDATE ecocash_checkout_contexts SET ecocash_reference=$2 WHERE attempt_id=$1 AND ecocash_reference IS NULL',[input.attemptId,result.providerReference]);
  // The lookup identity is our own committed correlator, known even when the
  // response was lost, so the attempt always proceeds to read-only lookup.
  return {state:'initiated' as const,referenceNumber:input.attemptId,redirectUrl:''};
 }
 async check(terms:PaymentTerms):Promise<VerifiedStatus> {
  if(!terms.attemptId||!terms.orderId||terms.referenceNumber!==terms.attemptId||terms.methodCode!==ECOCASH_METHOD_CODE)return {state:'unknown',providerStatus:null};
  let prepared;try{prepared=await this.prepared(terms.attemptId,terms.orderId,terms.amountMinor,terms.currency);}catch{return {state:'unknown',providerStatus:null};}
  const observed=await this.client.lookupSettlement(prepared);
  if(observed.state!=='charged')return {state:'unknown',providerStatus:null};
  const stored=(await this.pool.query('SELECT ecocash_reference FROM ecocash_checkout_contexts WHERE attempt_id=$1',[terms.attemptId])).rows[0];
  if(stored?.ecocash_reference&&stored.ecocash_reference!==observed.providerReference)return {state:'unknown',providerStatus:'reference_mismatch'};
  if(observed.amountMinor!==terms.amountMinor||observed.currency!==terms.currency||observed.merchantCode!==this.client.merchantCode)
   return {state:'unknown',providerStatus:'settlement_terms_unverified'};
  await this.pool.query('UPDATE ecocash_checkout_contexts SET ecocash_reference=$2 WHERE attempt_id=$1 AND ecocash_reference IS NULL',[terms.attemptId,observed.providerReference]);
  return {state:'verified_success',providerStatus:'Charged'};
 }
}

// Customer-safe presentation: never the full number or any provider credential.
export async function ecocashPresentation(pool:Pool,customerId:string,attemptId:string){
 const row=(await pool.query(`SELECT c.payer_hint,a.state FROM ecocash_checkout_contexts c JOIN provider_payment_attempts a ON a.id=c.attempt_id
  WHERE c.attempt_id=$1 AND a.customer_id=$2`,[attemptId,customerId])).rows[0];
 return row?{provider:'ecocash' as const,payerHint:row.payer_hint as string,awaitingApproval:['pending','unknown','initiating'].includes(row.state)}:null;
}
