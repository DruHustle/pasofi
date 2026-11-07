// Pesepay remains a historical ledger identity, not a selectable checkout.
// No direct provider joins this settlement interface until independently
// verifiable paid terms and its production contract have been qualified.
export type PaymentProvider='mock'|'pesepay'|'stripe'|'stripe_test';
export type MethodEligibility={method:unknown;merchantEnabledCodes:Set<string>;siteQualifiedCodes:Set<string>};
export type PaymentInput={attemptId:string;orderId:string;customerId:string;siteId:string;amountMinor:number;currency:string;methodCode:string;eligibility:MethodEligibility};
export type PaymentTerms={referenceNumber:string;amountMinor:number;currency:string;attemptId?:string;orderId?:string;customerId?:string;siteId?:string;methodCode?:string};
export type VerifiedStatus={state:'verified_success'|'pending'|'failed'|'reversed'|'unknown';providerStatus:string|null};
export type InitiationResult={state:'initiated';referenceNumber:string;redirectUrl:string}|{state:'unknown';referenceNumber?:string};
export interface PaymentAdapter {
 readonly provider:PaymentProvider;
 // Only providers with an independently documented idempotency retention may
 // opt in. The persisted attempt ID, never a browser-supplied key, is replayed.
 readonly initiationReplaySeconds?:number;
 initiate(input:PaymentInput):Promise<InitiationResult>;
 check(terms:PaymentTerms):Promise<VerifiedStatus>;
}
export function parseMinorUnits(value:unknown):number|null {
 if(typeof value!=='number'&&typeof value!=='string')return null;
 const str=String(value);if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(str))return null;
 const [whole,frac='']=str.split('.'),result=Number(whole)*100+Number(frac.padEnd(2,'0'));
 return Number.isSafeInteger(result)?result:null;
}
export function eligibleMethod(method:unknown,currency:string,amountMinor:number,enabledCodes:Set<string>,qualifiedCodes:Set<string>):boolean {
 if(!method||typeof method!=='object'||Array.isArray(method))return false;
 const m=method as Record<string,unknown>,low=parseMinorUnits(m.minimumAmount),high=parseMinorUnits(m.maximumAmount);
 return m.active===true&&typeof m.code==='string'&&enabledCodes.has(m.code)&&qualifiedCodes.has(m.code)&&Array.isArray(m.currencies)&&m.currencies.includes(currency)&&low!==null&&high!==null&&amountMinor>=low&&amountMinor<=high;
}
