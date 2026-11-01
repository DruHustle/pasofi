type Fetcher = typeof fetch;
export type Cost = { amount:string; scale:4; currency:string };
export type SmsResult = { state:'submitted'|'delivered'|'failed'|'unknown'; providerId:string|null; providerStatus:string|null; deliveredAt:string|null; cost:Cost|null };
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unknown=():SmsResult=>({state:'unknown',providerId:null,providerStatus:null,deliveredAt:null,cost:null});
async function boundedJson(response:Response):Promise<unknown>{
 if(!response.body) throw Error('empty_response');
 const reader=response.body.getReader(), chunks:Uint8Array[]=[];let size=0;
 while(true){const part=await reader.read();if(part.done) break;size+=part.value.length;if(size>65536){await reader.cancel();throw Error('response_too_large');}chunks.push(part.value);}
 return JSON.parse(Buffer.concat(chunks.map(b=>Buffer.from(b))).toString('utf8')) as unknown;
}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_response');return value as Record<string,unknown>;}
function parse(raw:unknown,mode:'send'|'retrieve',expectedId?:string):SmsResult {
 const root=record(raw), data=mode==='send'?root:record(root.data);
 if(typeof data.id!=='string' || !uuid.test(data.id) || (expectedId && data.id!==expectedId)) throw Error('invalid_provider_id');
 if(typeof data.status!=='string' || !['created','enqueued','processing','success','failed'].includes(data.status)) throw Error('invalid_status');
 if(data.delivered_at!==null && (typeof data.delivered_at!=='string' || !Number.isFinite(Date.parse(data.delivered_at)))) throw Error('invalid_delivery_timestamp');
 let cost:Cost|null=null;
 if(data.charge!==undefined || data.charge_currency!==undefined){
   const amount=typeof data.charge==='string'?data.charge:typeof data.charge==='number'&&Number.isSafeInteger(data.charge)?String(data.charge):'';
   if(!/^\d{1,30}$/.test(amount) || typeof data.charge_currency!=='string' || !/^[A-Z]{3}$/.test(data.charge_currency)) throw Error('invalid_cost');
   cost={amount,scale:4,currency:data.charge_currency};
 }
 const deliveredAt=typeof data.delivered_at==='string'?data.delivered_at:null;
 return {state:deliveredAt?'delivered':data.status==='failed'?'failed':'submitted',providerId:data.id,providerStatus:data.status,deliveredAt,cost};
}
export class SendaiAdapter {
 private readonly fetcher:Fetcher;
 constructor(private readonly apiKey:string,fetcher:Fetcher=fetch){if(!apiKey || apiKey.length>4096)throw Error('invalid_provider_configuration');this.fetcher=fetcher;}
 async send(input:{to:string;from:string;message:string}):Promise<SmsResult>{
  if(!/^\d{8,15}$/.test(input.to) || !input.from.trim() || input.from.length>32 || !input.message.trim() || input.message.length>1000) throw Error('invalid_sms');
  try{
   const response=await this.fetcher('https://api.sendai.co.zw/api/v1/sms',{method:'POST',headers:{authorization:`Bearer ${this.apiKey}`,'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(5000),redirect:'error'});
   if(response.status===400 || response.status===401) return {state:'failed',providerId:null,providerStatus:null,deliveredAt:null,cost:null};
   if(response.status!==202)return unknown();
   return parse(await boundedJson(response),'send');
  }catch{return unknown();}
 }
 async retrieve(id:string):Promise<SmsResult>{
  if(!uuid.test(id))throw Error('invalid_provider_id');
  try{
   const response=await this.fetcher(`https://api.sendai.co.zw/api/v1/sms/${id}`,{method:'GET',headers:{authorization:`Bearer ${this.apiKey}`},signal:AbortSignal.timeout(5000),redirect:'error'});
   if(response.status!==200)return {...unknown(),providerId:id};
   return parse(await boundedJson(response),'retrieve',id);
  }catch{return {...unknown(),providerId:id};}
 }
}
