// Direct EcoCash Online Payments preparation, based only on the official
// https://developers.ecocash.co.zw/docs/online-payments contract (2026-11-02).
// Deliberately NOT a PaymentAdapter: the published lookup does not independently
// verify paid amount/currency/merchant. This module has no runtime registration.
export type EcoCashSandboxConfig={
 environment:'sandbox';username:string;password:string;merchantCode:string;merchantPin:string;
 merchantNumber:string;terminalID:string;location:string;superMerchantName:string;merchantName:string;
};
export type PreparedEcoCashAdjustment=Readonly<{
 environment:'sandbox';adjustmentId:string;clientCorrelator:string;referenceCode:string;
 kind:'REF'|'REV';original:PreparedEcoCashPayment;originalEcocashReference:string;amountMinor:number;
}>;
export type PreparedEcoCashPayment=Readonly<{
 environment:'sandbox';attemptId:string;orderId:string;clientCorrelator:string;referenceCode:string;
 endUserId:string;amountMinor:number;currency:'USD';
}>;
type LookupResult={state:'unknown';reason:'unverified_response';clientCorrelator:string}|
 {state:'review_required';reason:'settlement_terms_unverified';clientCorrelator:string;providerReference:string;reportedStatus:'Charged'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sandboxBase='https://developers.ecocash.co.zw/sandbox/payment/v1/';
function text(value:unknown,max:number){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);}
function msisdn(value:string){const match=/^(?:263|0)?(7[0-9]{8})$/.exec(value);if(!match)throw Error('invalid_ecocash_msisdn');return match[1];}
function validatePrepared(p:PreparedEcoCashPayment){
 if(p.environment!=='sandbox'||!uuid.test(p.attemptId)||!uuid.test(p.orderId)||p.clientCorrelator!==p.attemptId||p.referenceCode!==p.attemptId||p.endUserId!==msisdn(p.endUserId)||!Number.isSafeInteger(p.amountMinor)||p.amountMinor<1||p.amountMinor>1000000000||p.currency!=='USD')throw Error('invalid_prepared_ecocash_payment');
}
// The caller must durably store these immutable terms and this unique attempt
// identity before any POST. Recovery polls this identity; it never re-POSTs.
export function prepareEcoCashPayment(input:{attemptId:string;orderId:string;customerMsisdn:string;amountMinor:number;currency:string}):PreparedEcoCashPayment{
 const prepared={environment:'sandbox' as const,attemptId:input.attemptId,orderId:input.orderId,
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
 return Object.freeze({environment:'sandbox',adjustmentId:input.adjustmentId,clientCorrelator:input.adjustmentId,referenceCode:input.adjustmentId,
   kind:input.kind,original:Object.freeze({...input.original}),originalEcocashReference:input.originalEcocashReference,amountMinor:input.amountMinor});
}
function validateAdjustment(a:PreparedEcoCashAdjustment){
 if(a.environment!=='sandbox'||a.clientCorrelator!==a.adjustmentId||a.referenceCode!==a.adjustmentId)throw Error('invalid_ecocash_adjustment');
 prepareEcoCashAdjustment(a);
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
export class EcoCashSandboxAdapter {
 readonly supportsAutomaticFulfillment=false;
 readonly supportsAutomaticRefunds=false;
 #config:EcoCashSandboxConfig;
 #authorization:string;
 #fetcher:typeof fetch;
 constructor(config:EcoCashSandboxConfig,fetcher:typeof fetch=fetch){
  if(config.environment!=='sandbox')throw Error('ecocash_production_contract_unqualified');
  if(!text(config.username,256)||config.username.includes(':')||!text(config.password,1024)||!text(config.merchantCode,64)||
    !['0000','1111','2222','9999'].includes(config.merchantPin)||!text(config.terminalID,64)||!text(config.location,120)||
    !text(config.superMerchantName,120)||!text(config.merchantName,120))throw Error('invalid_ecocash_sandbox_configuration');
  this.#config={...config,merchantNumber:msisdn(config.merchantNumber)};
  this.#authorization=`Basic ${Buffer.from(`${config.username}:${config.password}`,'utf8').toString('base64')}`;
  this.#fetcher=fetcher;
 }
 async initiate(p:PreparedEcoCashPayment):Promise<{state:'lookup_required';clientCorrelator:string;referenceCode:string;providerReference?:string}>{
  validatePrepared(p);
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
   const response=await this.#fetcher(`${sandboxBase}transactions/amount/`,{method:'POST',headers:{authorization:this.#authorization,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000),redirect:'error'});
   if(!response.ok)return recover;
   const data=await boundedJson(response);
   return matched(data,p)?{...recover,providerReference:data.ecocashReference}:recover;
  }catch{return recover;}
 }
 async adjust(a:PreparedEcoCashAdjustment):Promise<{state:'unknown'|'review_required';adjustmentId:string}> {
  validateAdjustment(a);
  const c=this.#config,p=a.original,unknown={state:'unknown' as const,adjustmentId:a.adjustmentId};
  const body={clientCorrelator:a.clientCorrelator,referenceCode:a.referenceCode,tranType:a.kind,endUserId:p.endUserId,
   originalEcocashReference:a.originalEcocashReference,
   paymentAmount:{charginginformation:{amount:Number((a.amountMinor/100).toFixed(2)),currency:p.currency,description:`Pasofi order ${p.orderId}`},chargeMetaData:{channel:'WEB'}},
   merchantCode:c.merchantCode,merchantPin:c.merchantPin,merchantNumber:c.merchantNumber,countryCode:'ZW',terminalID:c.terminalID,
   location:c.location,superMerchantName:c.superMerchantName,merchantName:c.merchantName};
  try{
   const response=await this.#fetcher(`${sandboxBase}transactions/refund/`,{method:'POST',headers:{authorization:this.#authorization,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000),redirect:'error'});
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
  validatePrepared(p);
  const unknown:LookupResult={state:'unknown',reason:'unverified_response',clientCorrelator:p.clientCorrelator};
  try{
   const response=await this.#fetcher(`${sandboxBase}${p.endUserId}/transactions/amount/${p.clientCorrelator}`,{method:'GET',headers:{authorization:this.#authorization,accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});
   if(!response.ok)return unknown;
   const data=await boundedJson(response);
   if(!matched(data,p)||data.responseCode!=='00'||data.transactionOperationStatus!=='Charged')return unknown;
   // Even an authenticated, reference-matched Charged response lacks paid
   // amount/currency/merchant evidence. Request values are not independent
   // confirmation. Unknown extra fields cannot silently qualify a contract.
   return {state:'review_required',reason:'settlement_terms_unverified',clientCorrelator:p.clientCorrelator,providerReference:data.ecocashReference,reportedStatus:'Charged'};
  }catch{return unknown;}
 }
}
