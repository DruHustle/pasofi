import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {loadDeliveryKeys,seal,unseal,type DeliveryKeys} from './delivery-crypto.js';
import {renderInvoicePdf,type InvoiceSnapshot} from './invoice-pdf.js';

export class InvoiceError extends Error{constructor(public readonly code:string){super(code);}}
export type InvoiceDelivery={channel:'download'}|{channel:'email'|'sms';recipient:string};
export const invoiceDeliverySchema={type:'object',additionalProperties:false,required:['channel'],properties:{channel:{type:'string',enum:['download','email','sms']},recipient:{type:'string',maxLength:254}}} as const;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest();
export const invoiceTokenHash=(value:string)=>hash(value);
export function normalizeInvoiceDelivery(input:unknown):InvoiceDelivery{
 if(input===undefined)return {channel:'download'};
 if(!input||typeof input!=='object'||Array.isArray(input))throw new InvoiceError('invalid_invoice_delivery');
 const value=input as Record<string,unknown>;
 if(Object.keys(value).some(key=>!['channel','recipient'].includes(key)))throw new InvoiceError('invalid_invoice_delivery');
 if(value.channel==='download'){
  if(value.recipient!==undefined&&value.recipient!=='')throw new InvoiceError('invalid_invoice_delivery');
  return {channel:'download'};
 }
 if(typeof value.recipient!=='string'||value.recipient.length>254)throw new InvoiceError('invalid_invoice_delivery');
 if(value.channel==='email'){
  const recipient=value.recipient.trim(),at=recipient.lastIndexOf('@');
  if(!/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(recipient)||at>64||recipient.slice(0,at).startsWith('.')||recipient.slice(0,at).endsWith('.')||recipient.slice(0,at).includes('..'))throw new InvoiceError('invalid_invoice_delivery');
  return {channel:'email',recipient:recipient.slice(0,at+1)+recipient.slice(at+1).toLowerCase()};
 }
 if(value.channel==='sms'){
  const recipient=value.recipient.replace(/[\s()-]/g,'').replace(/^\+/,'').replace(/^0(?=7[0-9]{8}$)/,'263');
  if(!/^263[0-9]{9}$/.test(recipient))throw new InvoiceError('invalid_invoice_delivery');
  return {channel:'sms',recipient};
 }
 throw new InvoiceError('invalid_invoice_delivery');
}
const deliveryHash=(delivery:InvoiceDelivery)=>hash(JSON.stringify(delivery));
function decryptDelivery(row:Record<string,any>,keys:DeliveryKeys,aad:string):InvoiceDelivery{
 if(row.channel==='download')return {channel:'download'};
 const body=JSON.parse(unseal({keyId:row.key_id,iv:row.payload_iv,cipher:row.payload_cipher,tag:row.payload_tag},keys,aad));
 return normalizeInvoiceDelivery({channel:row.channel,recipient:body.recipient});
}
export async function assertOrderInvoiceIntent(client:PoolClient,orderId:string,input:unknown){
 const delivery=normalizeInvoiceDelivery(input),row=(await client.query('SELECT request_hash FROM invoice_delivery_intents WHERE order_id=$1',[orderId])).rows[0];
 // Older quotes had no delivery selection. Replays may recover them but must
 // not silently change a previously submitted contact or invent a new one.
 if(row?!timingSafeEqual(row.request_hash,deliveryHash(delivery)):delivery.channel!=='download')throw new InvoiceError('idempotency_conflict');
}
export async function saveOrderInvoiceIntent(client:PoolClient,orderId:string,input:unknown){
 const delivery=normalizeInvoiceDelivery(input),keys=loadDeliveryKeys();
 if(delivery.channel!=='download'&&!keys)throw new InvoiceError('invoice_delivery_unavailable');
 const encrypted=delivery.channel==='download'?null:seal(JSON.stringify({recipient:delivery.recipient}),keys!,`invoice-intent:${orderId}`);
 await client.query('INSERT INTO invoice_delivery_intents(order_id,channel,request_hash,key_id,payload_cipher,payload_iv,payload_tag) VALUES($1,$2,$3,$4,$5,$6,$7)',[orderId,delivery.channel,deliveryHash(delivery),encrypted?.keyId??null,encrypted?.cipher??null,encrypted?.iv??null,encrypted?.tag??null]);
}
async function orderDelivery(client:PoolClient,orderId:string):Promise<InvoiceDelivery>{
 const row=(await client.query('SELECT * FROM invoice_delivery_intents WHERE order_id=$1',[orderId])).rows[0];
 if(!row||row.channel==='download')return {channel:'download'};
 const keys=loadDeliveryKeys();if(!keys)throw new InvoiceError('invoice_delivery_unavailable');
 return decryptDelivery(row,keys,`invoice-intent:${orderId}`);
}
type InvoiceSource={type:'cash'|'digital';id:string;customerId:string|null;agentId:string|null;siteId:string|null;siteName:string|null;paidAt:Date;priceMinor:number;currency:string;bundleId:string;byteLimit:string;validitySeconds:number;simulation:boolean;payment:InvoiceSnapshot['payment']};
async function issue(client:PoolClient,source:InvoiceSource,delivery:InvoiceDelivery,keys:DeliveryKeys|null){
 const prior=(await client.query('SELECT id,number FROM paid_invoices WHERE sale_id=$1 OR order_id=$2',[source.type==='cash'?source.id:null,source.type==='digital'?source.id:null])).rows[0];
 if(prior)return prior as {id:string;number:string};
 if(delivery.channel!=='download'&&!keys)throw new InvoiceError('invoice_delivery_unavailable');
 const clock=(await client.query("SELECT nextval('paid_invoice_number_seq')::text AS serial,now() AS issued_at")).rows[0];
 const id=randomUUID(),number=`PFI-${clock.serial.padStart(10,'0')}`,issuedAt=(clock.issued_at as Date).toISOString();
 const snapshot:InvoiceSnapshot={schemaVersion:1,number,issuedAt,paidAt:source.paidAt.toISOString(),
  operator:{name:'Onesa',brand:'Pasofi',address:'3964 98th Crescent Kuwadzana 5',supportPhone:'+263 715 092 221'},
  source:{type:source.type,id:source.id,siteName:source.siteName},
  line:{bundleId:source.bundleId,description:'Prepaid Wi-Fi data',quantity:1,byteLimit:source.byteLimit,validitySeconds:source.validitySeconds,unitAmountMinor:source.priceMinor,totalMinor:source.priceMinor},
  payment:source.payment,currency:source.currency,totalMinor:source.priceMinor,simulation:source.simulation,notice:'Not a ZIMRA fiscal tax invoice.'};
 const pdf=await renderInvoicePdf(snapshot);
 await client.query(`INSERT INTO paid_invoices(id,number,source_type,sale_id,order_id,customer_id,agent_id,site_id,issued_at,paid_at,currency,total_minor,simulation,snapshot,pdf_bytes,pdf_sha256)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[id,number,source.type,source.type==='cash'?source.id:null,source.type==='digital'?source.id:null,source.customerId,source.agentId,source.siteId,issuedAt,source.paidAt,source.currency,source.priceMinor,source.simulation,JSON.stringify(snapshot),pdf,hash(pdf)]);
 const token=delivery.channel==='sms'?randomBytes(32).toString('base64url'):null;
 const encrypted=delivery.channel==='download'?null:seal(JSON.stringify({recipient:delivery.recipient,...(token?{token}:{})}),keys!,`invoice:${id}`);
 await client.query(`INSERT INTO invoice_deliveries(invoice_id,channel,key_id,payload_cipher,payload_iv,payload_tag,download_token_hash,token_expires_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7::bytea IS NULL THEN NULL ELSE $8::timestamptz+interval '7 days' END)`,[id,delivery.channel,encrypted?.keyId??null,encrypted?.cipher??null,encrypted?.iv??null,encrypted?.tag??null,token?invoiceTokenHash(token):null,issuedAt]);
 if(delivery.channel!=='download')await client.query("INSERT INTO event_outbox(id,event_type,event_version,aggregate_id,aggregate_version,correlation_id,payload) VALUES($1,'invoice.issued',1,$2,1,$3,$4)",[randomUUID(),id,randomUUID(),JSON.stringify({invoiceId:id})]);
 return {id,number};
}
// Call only inside the transaction that records the agent's cash attestation.
export async function issueCashInvoice(client:PoolClient,saleId:string,input:unknown,keys:DeliveryKeys){
 const delivery=normalizeInvoiceDelivery(input);
 const sale=(await client.query(`SELECT s.*,d.paired_customer_id FROM agent_sales s LEFT JOIN agent_sale_deliveries d ON d.sale_id=s.id
  WHERE s.id=$1 AND s.payment_method='cash' AND s.cash_received_minor=s.price_minor AND s.cash_confirmed_at IS NOT NULL`,[saleId])).rows[0];
 if(!sale)throw new InvoiceError('invoice_payment_unconfirmed');
 return issue(client,{type:'cash',id:sale.id,customerId:sale.paired_customer_id??null,agentId:sale.agent_id,siteId:sale.site_id,siteName:sale.site_name||null,paidAt:sale.cash_confirmed_at,priceMinor:sale.price_minor,currency:sale.currency,bundleId:sale.bundle_id,byteLimit:String(sale.byte_limit),validitySeconds:sale.validity_seconds,simulation:sale.simulation,payment:{method:'cash',evidence:'agent_attestation',reference:sale.id,provider:null}},delivery,keys);
}
// Call only after the verified charge and the exact entitlement are linked in
// the fulfillment transaction. Pending/failed/browser-return paths never call it.
export async function issueDigitalInvoice(client:PoolClient,chargeId:string){
 const row=(await client.query(`SELECT o.*,c.created_at AS paid_at,a.provider,a.method_code,a.provider_reference,a.site_id
  FROM verified_charges c JOIN purchase_orders o ON o.id=c.order_id JOIN provider_payment_attempts a ON a.id=c.attempt_id
  JOIN purchase_entitlements e ON e.id=c.fulfilled_entitlement_id AND e.order_id=o.id AND e.customer_id=o.customer_id
  WHERE c.id=$1 AND c.state='succeeded' AND c.amount_minor=o.price_minor AND c.currency=o.currency AND o.status='payment_confirmed'`,[chargeId])).rows[0];
 if(!row)throw new InvoiceError('invoice_payment_unconfirmed');
 return issue(client,{type:'digital',id:row.id,customerId:row.customer_id,agentId:null,siteId:row.site_id,siteName:null,paidAt:row.paid_at,priceMinor:row.price_minor,currency:row.currency,bundleId:row.bundle_id,byteLimit:String(row.byte_limit),validitySeconds:row.validity_seconds,simulation:['mock','stripe_test'].includes(row.provider)||row.purchase_mode==='demo',payment:{method:row.method_code,evidence:'provider_verified',reference:row.provider_reference,provider:row.provider}},await orderDelivery(client,row.id),loadDeliveryKeys());
}
export function invoiceDto(row:Record<string,any>){return {id:row.id,number:row.number,issuedAt:row.issued_at,paidAt:row.paid_at,currency:row.currency,totalMinor:row.total_minor,sourceType:row.source_type,saleId:row.sale_id,orderId:row.order_id,simulation:row.simulation,requestedChannel:row.channel??'download'};}
export function invoiceDeliveryDetails(row:Record<string,any>,demo:boolean){
 const base={invoiceId:row.id,invoiceNumber:row.number,simulation:row.simulation,filename:`${row.number}.pdf`,contentType:'application/pdf'};
 if(row.channel==='download')return {...base,channel:'none' as const};
 const keys=loadDeliveryKeys();if(!keys)throw new InvoiceError('invoice_delivery_unavailable');
 const plaintext=JSON.parse(unseal({keyId:row.key_id,iv:row.payload_iv,cipher:row.payload_cipher,tag:row.payload_tag},keys,`invoice:${row.id}`));
 const delivery=normalizeInvoiceDelivery({channel:row.channel,recipient:plaintext.recipient});
 if(delivery.channel==='download')throw new InvoiceError('invoice_delivery_unavailable');
 if(delivery.channel==='email')return {...base,channel:'email' as const,to:delivery.recipient};
 if(!(row.token_expires_at instanceof Date)||row.token_expires_at.getTime()<=Date.now())throw new InvoiceError('invoice_link_expired');
 if(typeof plaintext.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(plaintext.token)||!timingSafeEqual(invoiceTokenHash(plaintext.token),row.download_token_hash))throw new InvoiceError('invoice_delivery_unavailable');
 let origin:URL;try{origin=new URL(process.env.PUBLIC_ORIGIN??'');if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||(demo?!['http:','https:'].includes(origin.protocol):origin.protocol!=='https:'))throw Error();}catch{throw new InvoiceError('invoice_delivery_unavailable');}
 return {...base,channel:'sms' as const,to:delivery.recipient,link:`${origin.origin}/#invoice=${plaintext.token}`,expiresAt:row.token_expires_at.toISOString()};
}
