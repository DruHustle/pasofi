// Direct EcoCash Online Payments client, based only on the official
// https://developers.ecocash.co.zw/docs/online-payments contract (2026-11-02).
// The sandbox class below remains deliberately NOT a PaymentAdapter. Checkout
// uses this client only through ecocash-checkout.ts, which keeps the journey
// switched off unless every activation gate is explicitly satisfied.
export type EcoCashSandboxConfig={
 environment:'sandbox';username:string;password:string;merchantCode:string;merchantPin:string;
 merchantNumber:string;terminalID:string;location:string;superMerchantName:string;merchantName:string;
};
// Production endpoints are issued by EcoCash after merchant registration and
// testing review (Go Live). No production base URL is assumed or committed.
export type EcoCashProductionConfig=Omit<EcoCashSandboxConfig,'environment'>&{environment:'production';baseUrl:string};
export type EcoCashClientConfig=EcoCashSandboxConfig|EcoCashProductionConfig;
export type EcoCashEnvironment=EcoCashClientConfig['environment'];
export type PreparedEcoCashAdjustment=Readonly<{
 environment:EcoCashEnvironment;adjustmentId:string;clientCorrelator:string;referenceCode:string;
 kind:'REF'|'REV';original:PreparedEcoCashPayment;originalEcocashReference:string;amountMinor:number;
}>;
export type PreparedEcoCashPayment=Readonly<{
 environment:EcoCashEnvironment;attemptId:string;orderId:string;clientCorrelator:string;referenceCode:string;
 endUserId:string;amountMinor:number;currency:'USD';
}>;
export type EcoCashSettlementObservation={state:'unknown'}|
 {state:'charged';providerReference:string;amountMinor:number|null;currency:string|null;merchantCode:string|null};
type LookupResult={state:'unknown';reason:'unverified_response';clientCorrelator:string}|
 {state:'review_required';reason:'settlement_terms_unverified';clientCorrelator:string;providerReference:string;reportedStatus:'Charged'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sandboxBase='https://developers.ecocash.co.zw/sandbox/payment/v1/';
function productionBase(value:unknown):string{
 if(typeof value!=='string')throw Error('invalid_ecocash_production_configuration');
 let url:URL;try{url=new URL(value);}catch{throw Error('invalid_ecocash_production_configuration');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/')||url.hostname==='developers.ecocash.co.zw'&&url.pathname.startsWith('/sandbox/'))throw Error('invalid_ecocash_production_configuration');
 return url.toString();
}
function text(value:unknown,max:number){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);}
// Zimbabwean EcoCash wallets are 07x numbers; store only the 9-digit subscriber form.
export function normalizeEcoCashMsisdn(value:string):string{return msisdn(value.replace(/^\+/,''));}
function msisdn(value:string){const match=/^(?:263|0)?(7[0-9]{8})$/.exec(value);if(!match)throw Error('invalid_ecocash_msisdn');return match[1];}
function validatePrepared(p:PreparedEcoCashPayment){
 if(!['sandbox','production'].includes(p.environment)||!uuid.test(p.attemptId)||!uuid.test(p.orderId)||p.clientCorrelator!==p.attemptId||p.referenceCode!==p.attemptId||p.endUserId!==msisdn(p.endUserId)||!Number.isSafeInteger(p.amountMinor)||p.amountMinor<1||p.amountMinor>1000000000||p.currency!=='USD')throw Error('invalid_prepared_ecocash_payment');
}
// The caller must durably store these immutable terms and this unique attempt
// identity before any POST. Recovery polls this identity; it never re-POSTs.
export function prepareEcoCashPayment(input:{attemptId:string;orderId:string;customerMsisdn:string;amountMinor:number;currency:string},environment:EcoCashEnvironment='sandbox'):PreparedEcoCashPayment{
 const prepared={environment,attemptId:input.attemptId,orderId:input.orderId,
  clientCorrelator:input.attemptId,referenceCode:input.attemptId,endUserId:msisdn(input.customerMsisdn),amountMinor:input.amountMinor,currency:input.currency as 'USD'};
 validatePrepared(prepared);return Object.freeze(prepared);
}
// Sandbox request preparation only. The caller must persist the unique
// adjustment and original payment before any POST; this module has no refund
// ledger, cannot verify total prior refunds, and must not retry an ambiguous POST.
export function prepareEcoCashAdjustment(input:{adjustmentId:string;kind:'REF'|'REV';original:PreparedEcoCashPayment;originalEcocashReference:string;amountMinor:number}):PreparedEcoCashAdjustment {
 validatePrepared(input.original);
 if(!uuid.test(input.adjustmentId)||input.adjustmentId===input.original.attemptId||!['REF','REV'].includes(input.kind)||
   typeof input.originalEcocashReference!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(input.originalEcocashReference)||
   !Number.isSafeInteger(input.amountMinor)||input.amountMinor<1||input.amountMinor>input.original.amountMinor)throw Error('invalid_ecocash_adjustment');
 return Object.freeze({environment:input.original.environment,adjustmentId:input.adjustmentId,clientCorrelator:input.adjustmentId,referenceCode:input.adjustmentId,
   kind:input.kind,original:Object.freeze({...input.original}),originalEcocashReference:input.originalEcocashReference,amountMinor:input.amountMinor});
}
function validateAdjustment(a:PreparedEcoCashAdjustment){
 if(a.environment!==a.original.environment||a.clientCorrelator!==a.adjustmentId||a.referenceCode!==a.adjustmentId)throw Error('invalid_ecocash_adjustment');
 prepareEcoCashAdjustment(a);
}
// Provider amounts are major units (e.g. 1.25). Accept at most two decimals.
function minorUnits(value:unknown):number|null{
 if(typeof value!=='number'&&typeof value!=='string')return null;
 const text=String(value);if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(text))return null;
 const [whole,fraction='']=text.split('.');const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 return Number.isSafeInteger(result)?result:null;
}
function settlementTerms(data:Record<string,unknown>){
 const amount=data.paymentAmount&&typeof data.paymentAmount==='object'&&!Array.isArray(data.paymentAmount)?data.paymentAmount as Record<string,unknown>:null;
 const charging=amount?.charginginformation&&typeof amount.charginginformation==='object'&&!Array.isArray(amount.charginginformation)?amount.charginginformation as Record<string,unknown>:null;
 // Prefer the provider's charged total; never fall back to request values held locally.
 const charged=minorUnits(amount?.totalAmountCharged)??minorUnits(charging?.amount);
 const currency=typeof charging?.currency==='string'&&/^[A-Z]{3}$/.test(charging.currency)?charging.currency:null;
 const merchantCode=typeof data.merchantCode==='string'&&text(data.merchantCode,64)?data.merchantCode:null;
 return {amountMinor:charged,currency,merchantCode};
}
async function boundedJson(response:Response):Promise<Record<string,unknown>>{
 if(!response.body)throw Error('empty_ecocash_response');
 const reader=response.body.getReader(),chunks:Buffer[]=[];let length=0;
 try{while(true){const item=await reader.read();if(item.done)break;length+=item.value.length;if(length>65536)throw Error('oversized_ecocash_response');chunks.push(Buffer.from(item.value));}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const data:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('invalid_ecocash_response');
 return data as Record<string,unknown>;
}
function matched(data:Record<string,unknown>,p:PreparedEcoCashPayment):data is Record<string,unknown>&{ecocashReference:string}{
 return data.clientCorrelator===p.clientCorrelator&&data.referenceCode===p.referenceCode&&data.endUserId===p.endUserId&&
  typeof data.ecocashReference==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(data.ecocashReference);
}
export class EcoCashOnlinePaymentsClient {
 readonly supportsAutomaticFulfillment=false;
 readonly supportsAutomaticRefunds=false;
 readonly environment:EcoCashEnvironment;
 #config:EcoCashClientConfig;
 #base:string;
 #authorization:string;
 #fetcher:typeof fetch;
 constructor(config:EcoCashClientConfig,fetcher:typeof fetch=fetch){
  const sandbox=config.environment==='sandbox';
  if(!['sandbox','production'].includes(config.environment))throw Error('invalid_ecocash_configuration');
  const invalid=sandbox?'invalid_ecocash_sandbox_configuration':'invalid_ecocash_production_configuration';
  // Sandbox PINs are the published test values. A production PIN is private
  // merchant configuration loaded from a protected secret file.
  if(!text(config.username,256)||config.username.includes(':')||!text(config.password,1024)||!text(config.merchantCode,64)||
    !(sandbox?['0000','1111','2222','9999'].includes(config.merchantPin):/^[0-9]{4,8}$/.test(config.merchantPin))||!text(config.terminalID,64)||!text(config.location,120)||
    !text(config.superMerchantName,120)||!text(config.merchantName,120))throw Error(invalid);
  this.#base=sandbox?sandboxBase:productionBase((config as EcoCashProductionConfig).baseUrl);
  this.environment=config.environment;
  this.#config={...config,merchantNumber:msisdn(config.merchantNumber)};
  this.#authorization=`Basic ${Buffer.from(`${config.username}:${config.password}`,'utf8').toString('base64')}`;
  this.#fetcher=fetcher;
 }
 get merchantCode(){return this.#config.merchantCode;}
 #own(p:PreparedEcoCashPayment){validatePrepared(p);if(p.environment!==this.environment)throw Error('invalid_prepared_ecocash_payment');}
 async initiate(p:PreparedEcoCashPayment):Promise<{state:'lookup_required';clientCorrelator:string;referenceCode:string;providerReference?:string}>{
  this.#own(p);
  const recover={state:'lookup_required' as const,clientCorrelator:p.clientCorrelator,referenceCode:p.referenceCode};
  const c=this.#config,body={clientCorrelator:p.clientCorrelator,referenceCode:p.referenceCode,tranType:'MER',endUserId:p.endUserId,
   paymentAmount:{charginginformation:{amount:Number((p.amountMinor/100).toFixed(2)),currency:p.currency,description:`Pasofi order ${p.orderId}`},
    chargeMetaData:{channel:'WEB',purchaseCategoryCode:'Online Payment',onBeHalfOf:c.superMerchantName}},
   merchantCode:c.merchantCode,merchantPin:c.merchantPin,merchantNumber:c.merchantNumber,countryCode:'ZW',terminalID:c.terminalID,
   location:c.location,superMerchantName:c.superMerchantName,merchantName:c.merchantName};
  // notifyUrl is deliberately omitted: no public authenticated callback/replay
  // contract has been published for this endpoint family. Never collect a
  // customer's wallet PIN; merchantPin is private merchant sandbox configuration.
  try{
   const response=await this.#fetcher(`${this.#base}transactions/amount/`,{method:'POST',headers:{authorization:this.#authorization,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000),redirect:'error'});
   if(!response.ok)return recover;
   const data=await boundedJson(response);
   return matched(data,p)?{...recover,providerReference:data.ecocashReference}:recover;
  }catch{return recover;}
 }
 async adjust(a:PreparedEcoCashAdjustment):Promise<{state:'unknown'|'review_required';adjustmentId:string}> {
  validateAdjustment(a);this.#own(a.original);
  const c=this.#config,p=a.original,unknown={state:'unknown' as const,adjustmentId:a.adjustmentId};
  const body={clientCorrelator:a.clientCorrelator,referenceCode:a.referenceCode,tranType:a.kind,endUserId:p.endUserId,
   originalEcocashReference:a.originalEcocashReference,
   paymentAmount:{charginginformation:{amount:Number((a.amountMinor/100).toFixed(2)),currency:p.currency,description:`Pasofi order ${p.orderId}`},chargeMetaData:{channel:'WEB'}},
   merchantCode:c.merchantCode,merchantPin:c.merchantPin,merchantNumber:c.merchantNumber,countryCode:'ZW',terminalID:c.terminalID,
   location:c.location,superMerchantName:c.superMerchantName,merchantName:c.merchantName};
  try{
   const response=await this.#fetcher(`${this.#base}transactions/refund/`,{method:'POST',headers:{authorization:this.#authorization,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000),redirect:'error'});
   if(!response.ok)return unknown;
   const data=await boundedJson(response);
   if(data.clientCorrelator!==a.clientCorrelator||data.originalEcocashReference!==a.originalEcocashReference||
      typeof data.ecocashReference!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(data.ecocashReference)||
      data.responseCode!=='00'||a.kind!=='REF'||data.transactionOperationStatus!=='Refunded')return unknown;
   // Response examples do not independently prove amount, currency or
   // merchant. Never mark a real ledger entry refunded from this observation.
   return {state:'review_required',adjustmentId:a.adjustmentId};
  }catch{return unknown;}
 }
 async lookup(p:PreparedEcoCashPayment):Promise<LookupResult>{
  this.#own(p);
  const unknown:LookupResult={state:'unknown',reason:'unverified_response',clientCorrelator:p.clientCorrelator};
  try{
   const response=await this.#fetcher(`${this.#base}${p.endUserId}/transactions/amount/${p.clientCorrelator}`,{method:'GET',headers:{authorization:this.#authorization,accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});
   if(!response.ok)return unknown;
   const data=await boundedJson(response);
   if(!matched(data,p)||data.responseCode!=='00'||data.transactionOperationStatus!=='Charged')return unknown;
   // Even an authenticated, reference-matched Charged response lacks paid
   // amount/currency/merchant evidence. Request values are not independent
   // confirmation. Unknown extra fields cannot silently qualify a contract.
   return {state:'review_required',reason:'settlement_terms_unverified',clientCorrelator:p.clientCorrelator,providerReference:data.ecocashReference,reportedStatus:'Charged'};
  }catch{return unknown;}
 }
 // Checkout settlement evidence: the reference-matched documented Charged/00
 // result plus the provider's own charged amount, currency and merchant code.
 // Missing fields are null, so the caller can refuse fulfilment. Qualification
 // with real sandbox credentials must confirm these fields before go-live.
 async lookupSettlement(p:PreparedEcoCashPayment):Promise<EcoCashSettlementObservation>{
  this.#own(p);
  try{
   const response=await this.#fetcher(`${this.#base}${p.endUserId}/transactions/amount/${p.clientCorrelator}`,{method:'GET',headers:{authorization:this.#authorization,accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});
   if(!response.ok)return {state:'unknown'};
   const data=await boundedJson(response);
   if(!matched(data,p)||data.responseCode!=='00'||data.transactionOperationStatus!=='Charged')return {state:'unknown'};
   return {state:'charged',providerReference:data.ecocashReference,...settlementTerms(data)};
  }catch{return {state:'unknown'};}
 }
}
// Retained sandbox-only preparation adapter: never accepts production input.
export class EcoCashSandboxAdapter extends EcoCashOnlinePaymentsClient {
 constructor(config:EcoCashSandboxConfig,fetcher:typeof fetch=fetch){
  if(config.environment!=='sandbox')throw Error('ecocash_production_contract_unqualified');
  super(config,fetcher);
 }
}
