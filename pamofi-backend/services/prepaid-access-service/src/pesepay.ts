import { createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
type Fetcher=typeof fetch;
type Config={environment:'sandbox'|'production';integrationKey:string;encryptionKey:string;applicationId:number;resultUrl:string;returnUrl:string;allowedCheckoutOrigins:string[]};
type Terms={referenceNumber:string;amountMinor:number;currency:string};
export type VerifiedStatus={state:'verified_success'|'pending'|'failed'|'reversed'|'unknown';providerStatus:string|null};
const statuses=new Set(['INITIATED','PROCESSING','PENDING','PARTIALLY_PAID','SUCCESS','FAILED','TERMINATED','TIME_OUT','CLOSED','CLOSED_PERIOD_ELAPSED','INSUFFICIENT_FUNDS','CANCELLED','ERROR','DECLINED','AUTHORIZATION_FAILED','SERVICE_UNAVAILABLE','REVERSED']);
function obj(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_response');return value as Record<string,unknown>;}
function keyBytes(key:string){const b=Buffer.from(key,'utf8');if(b.length!==32)throw Error('invalid_encryption_key');return b;}
// Fixed IV is required for compatibility with Pesepay's documented protocol.
// Never reuse this format for PamoFi's own data encryption.
export function encryptPesepay(data:unknown,key:string):string {const k=keyBytes(key),cipher=createCipheriv('aes-256-cbc',k,k.subarray(0,16));return Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]).toString('base64');}
export function decryptPesepay(payload:string,key:string):unknown {
 if(payload.length>100000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload))throw Error('invalid_payload');
 const k=keyBytes(key),cipher=createDecipheriv('aes-256-cbc',k,k.subarray(0,16));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(payload,'base64')),cipher.final()]).toString('utf8')) as unknown;
}
function minor(value:unknown):number|null {
 if(typeof value!=='number' && typeof value!=='string')return null;
 const str=String(value);if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(str))return null;
 const [whole,frac='']=str.split('.');const result=Number(whole)*100+Number(frac.padEnd(2,'0'));
 return Number.isSafeInteger(result)?result:null;
}
async function readJson(response:Response):Promise<unknown>{
 if(!response.body)throw Error('empty_response');const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
 while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536){await reader.cancel();throw Error('response_too_large');}chunks.push(Buffer.from(p.value));}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function httpsUrl(value:string):URL {const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.hash)throw Error('invalid_url');return url;}
export function eligibleMethod(method:unknown, currency:string, amountMinor:number, enabledCodes:Set<string>,qualifiedCodes:Set<string>):boolean {
 try {const m=obj(method), low=minor(m.minimumAmount),high=minor(m.maximumAmount);return m.active===true && typeof m.code==='string' && enabledCodes.has(m.code) && qualifiedCodes.has(m.code) && Array.isArray(m.currencies) && m.currencies.includes(currency) && low!==null && high!==null && amountMinor>=low && amountMinor<=high;}
 catch{return false;}
}
export class PesepayAdapter {
 private base:string;private allowed:Set<string>;
 constructor(private config:Config,private fetcher:Fetcher=fetch){
  if(!['sandbox','production'].includes(config.environment))throw Error('invalid_environment');
  keyBytes(config.encryptionKey);if(!config.integrationKey||config.integrationKey.length>4096||!Number.isSafeInteger(config.applicationId)||config.applicationId<=0)throw Error('invalid_configuration');
  httpsUrl(config.resultUrl);httpsUrl(config.returnUrl);
  this.allowed=new Set(config.allowedCheckoutOrigins.map(origin=>{const u=httpsUrl(origin);if(u.origin!==origin)throw Error('invalid_checkout_origin');return origin;}));
  if(!this.allowed.size)throw Error('checkout_origin_required');
  this.base=config.environment==='sandbox'?'https://api.test.sandbox.pesepay.com/payments-engine':'https://api.pesepay.com/api/payments-engine';
 }
 callbackAuthorized(header:unknown):boolean {if(typeof header!=='string')return false;const a=Buffer.from(header),b=Buffer.from(this.config.integrationKey);return a.length===b.length && timingSafeEqual(a,b);}
 async methods(currency:string):Promise<unknown[]> {
  if(this.config.environment!=='production'||!/^[A-Z]{3}$/.test(currency))return [];
  try{const u=new URL(`${this.base}/v1/payment-methods/for-currency`);u.searchParams.set('currencyCode',currency);const r=await this.fetcher(u,{headers:{'content-type':'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});if(!r.ok)return [];const data=await readJson(r);return Array.isArray(data)&&data.length<=100?data:[];}catch{return [];}
 }
 // Caller must durably persist the order and an initiation attempt first. An
 // unknown result is never permission to initiate another transaction.
 async initiate(input:{orderId:string;amountMinor:number;currency:string;methodCode:string;eligibility:{method:unknown;merchantEnabledCodes:Set<string>;siteQualifiedCodes:Set<string>}}):Promise<{state:'initiated';referenceNumber:string;redirectUrl:string}|{state:'unknown'}> {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.orderId)||!Number.isSafeInteger(input.amountMinor)||input.amountMinor<=0||input.amountMinor>1000000000||input.currency!=='USD'||!/^[A-Z0-9]{3,20}$/.test(input.methodCode))throw Error('invalid_order');
  const method=obj(input.eligibility?.method);
  if(method.code!==input.methodCode || !eligibleMethod(method,input.currency,input.amountMinor,input.eligibility.merchantEnabledCodes,input.eligibility.siteQualifiedCodes))throw Error('method_not_qualified');
  const body={amountDetails:{amount:Number((input.amountMinor/100).toFixed(2)),currencyCode:input.currency},reasonForPayment:`PamoFi order ${input.orderId}`,merchantReference:input.orderId,resultUrl:this.config.resultUrl,returnUrl:this.config.returnUrl,paymentMethodCode:input.methodCode};
  try{const response=await this.fetcher(`${this.base}/v1/payments/initiate`,{method:'POST',headers:{authorization:this.config.integrationKey,'content-type':'application/json'},body:JSON.stringify({payload:encryptPesepay(body,this.config.encryptionKey)}),signal:AbortSignal.timeout(8000),redirect:'error'});
   if(!response.ok)return {state:'unknown'};const outer=obj(await readJson(response));if(typeof outer.payload!=='string')return {state:'unknown'};const result=obj(decryptPesepay(outer.payload,this.config.encryptionKey));
   if(typeof result.referenceNumber!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(result.referenceNumber)||typeof result.redirectUrl!=='string')return {state:'unknown'};
   const redirect=httpsUrl(result.redirectUrl);if(!this.allowed.has(redirect.origin))return {state:'unknown'};
   return {state:'initiated',referenceNumber:result.referenceNumber,redirectUrl:redirect.toString()};
  }catch{return {state:'unknown'};}
 }
 async check(terms:Terms):Promise<VerifiedStatus>{
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(terms.referenceNumber)||!Number.isSafeInteger(terms.amountMinor)||terms.amountMinor<=0||!/^[A-Z]{3}$/.test(terms.currency))throw Error('invalid_terms');
  const unknown:VerifiedStatus={state:'unknown',providerStatus:null};
  try{const url=new URL(`${this.base}/v1/payments/check-payment`);url.searchParams.set('referenceNumber',terms.referenceNumber);
   const response=await this.fetcher(url,{headers:{authorization:this.config.integrationKey,'content-type':'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)return unknown;
   const outer=obj(await readJson(response));if(typeof outer.payload!=='string')return unknown;const data=obj(decryptPesepay(outer.payload,this.config.encryptionKey)),amount=obj(data.amountDetails);
   if(data.referenceNumber!==terms.referenceNumber || data.applicationId!==this.config.applicationId || amount.currencyCode!==terms.currency || minor(amount.amount)!==terms.amountMinor || typeof data.transactionStatus!=='string' || !statuses.has(data.transactionStatus))return unknown;
   const status=data.transactionStatus;
   if(status==='SUCCESS')return {state:'verified_success',providerStatus:status};
   if(status==='REVERSED')return {state:'reversed',providerStatus:status};
   if(['INITIATED','PROCESSING','PENDING','PARTIALLY_PAID'].includes(status))return {state:'pending',providerStatus:status};
   return {state:'failed',providerStatus:status};
  }catch{return unknown;}
 }
}
