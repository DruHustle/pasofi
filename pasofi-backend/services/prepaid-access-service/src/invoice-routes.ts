import {SignJWT,jwtVerify} from 'jose';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {InvoiceError,invoiceDeliveryDetails,invoiceDto,invoiceTokenHash} from './invoices.js';
import {loadDeliveryKeys} from './delivery-crypto.js';

type Staff={staffId:string;role:'admin'|'agent'|'support';siteIds:string[]};
type StaffGuard=(request:FastifyRequest,reply:FastifyReply)=>Promise<Staff|null>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const columns='i.id,i.number,i.source_type,i.sale_id,i.order_id,i.issued_at,i.paid_at,i.currency,i.total_minor,i.simulation,d.channel';
const customerScope=`(i.customer_id=$1 OR EXISTS(SELECT 1 FROM issued_vouchers v JOIN purchase_entitlements e ON e.source_voucher_id=v.id WHERE v.sale_id=i.sale_id AND e.customer_id=$1))`;
const staffScope=`($1::boolean OR (i.agent_id=$2 AND i.site_id=ANY($3::uuid[])))`;
const querySchema={type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100,default:25},offset:{type:'integer',minimum:0,maximum:1000000,default:0},saleId:{type:'string',pattern:uuid.source},orderId:{type:'string',pattern:uuid.source}}};
async function notification(path:string,demo:boolean){
 const secret=process.env.INTERNAL_DELIVERY_SECRET??'',endpoint=new URL(process.env.NOTIFICATION_URL??'');
 if(Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_'))||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash||(demo?!['http:','https:'].includes(endpoint.protocol):endpoint.protocol!=='https:'))throw Error('unavailable');
 const token=await new SignJWT({scope:'invoice:status'}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('notification').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
 const response=await fetch(new URL(path,endpoint),{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000),redirect:'error'});
 if(!response.ok||!response.body)throw Error('unavailable');
 let size=0;const chunks:Buffer[]=[];for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){size+=chunk.length;if(size>4096)throw Error('unavailable');chunks.push(Buffer.from(chunk));}
 return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
}
export async function invoiceDeliveryCapabilities(demo:boolean){
 const secret=process.env.INTERNAL_EVENTS_SECRET??'',delivery=process.env.INTERNAL_DELIVERY_SECRET??'';
 if(process.env.OUTBOX_DISPATCH_ENABLED!=='true'||Buffer.byteLength(secret)<32||Buffer.byteLength(delivery)<32||(!demo&&(secret.startsWith('DEMO_ONLY_')||delivery.startsWith('DEMO_ONLY_')))||!process.env.NOTIFICATION_URL||!loadDeliveryKeys())return {invoiceEmail:false,invoiceSms:false};
 try{const capability=await notification('/internal/v1/invoice-delivery/capabilities',demo);return {invoiceEmail:capability.simulation===demo&&capability.email===true,invoiceSms:capability.simulation===demo&&capability.sms===true};}catch{return {invoiceEmail:false,invoiceSms:false};}
}
async function deliveryStatus(id:string,demo:boolean){
 if(!process.env.NOTIFICATION_URL)return {state:'unavailable'};
 try{
  const result=await notification(`/internal/v1/invoices/${id}/status`,demo),states=['queued','submitting','submitted','delivered','failed','unknown','canceled'];
  if(!states.includes(String(result.state))||result.simulation!==demo)throw Error();
  const deliveredAt=typeof result.deliveredAt==='string'&&Number.isFinite(Date.parse(result.deliveredAt))?result.deliveredAt:null;
  if(result.state==='delivered'&&!deliveredAt)throw Error();
  return {state:result.state,channel:['email','sms'].includes(String(result.channel))?result.channel:null,
   ...(typeof result.attemptedAt==='string'&&Number.isFinite(Date.parse(result.attemptedAt))?{attemptedAt:result.attemptedAt}:{}),...(result.state==='delivered'?{deliveredAt}:{})};
 }catch{return {state:'unavailable'};}
}
function sendPdf(reply:FastifyReply,row:Record<string,any>){return reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('Content-Disposition',`attachment; filename="${row.number}.pdf"`).type('application/pdf').send(row.pdf_bytes);}
export function registerInvoices(app:FastifyInstance,pool:Pool|null,demo:boolean,customer:(request:FastifyRequest)=>Promise<string|null>,staff:StaffGuard,originAllowed:(request:FastifyRequest)=>boolean){
 const unavailable=(reply:FastifyReply)=>reply.code(503).send({error:'invoices_unavailable'});
 for(const audience of ['customer','staff'] as const){
  const base=`/v1/${audience}/invoices`;
  async function principal(request:FastifyRequest,reply:FastifyReply){
   if(!pool){unavailable(reply);return null;}
   if(audience==='staff'){const actor=await staff(request,reply);return actor?{where:staffScope,values:[actor.role==='admin',actor.staffId,actor.siteIds]}:null;}
   const id=await customer(request);if(!id){reply.code(401).send({error:'not_authenticated'});return null;}
   return {where:customerScope,values:[id]};
  }
  app.get<{Querystring:{limit:number;offset:number;saleId?:string;orderId?:string}}>(base,{schema:{querystring:querySchema}},async(request,reply)=>{
   try{
    const actor=await principal(request,reply);if(!actor)return;
    const {limit,offset,saleId,orderId}=request.query,index=actor.values.length;
    // Only the paired customer can recover an outstanding cash voucher. The
    // invoice list never contains a code and redemption rechecks its live state.
    const receiptColumn = audience === 'customer' ? `, (
     SELECT p.id FROM receipt_pairings p
     JOIN agent_sales s ON s.id=p.sale_id
     WHERE p.sale_id=i.sale_id AND p.customer_id=$1 AND s.start_by>=now()
      AND EXISTS(SELECT 1 FROM issued_vouchers v WHERE v.sale_id=s.id AND v.state='valid')
      AND NOT EXISTS(SELECT 1 FROM cash_refunds r WHERE r.sale_id=s.id AND r.state IN ('approved','paying','paid'))
    ) AS pairing_id` : '';
    const result=await pool!.query(`SELECT ${columns}${receiptColumn} FROM paid_invoices i JOIN invoice_deliveries d ON d.invoice_id=i.id WHERE ${actor.where}
     AND ($${index+1}::uuid IS NULL OR i.sale_id=$${index+1}) AND ($${index+2}::uuid IS NULL OR i.order_id=$${index+2}) ORDER BY i.issued_at DESC,i.id DESC LIMIT $${index+3} OFFSET $${index+4}`,[...actor.values,saleId??null,orderId??null,limit+1,offset]);
    const hasMore=result.rows.length>limit;return {invoices:result.rows.slice(0,limit).map(row => ({...invoiceDto(row), ...(row.pairing_id ? {pairingId:row.pairing_id} : {})})),hasMore,nextOffset:hasMore?offset+limit:null};
   }catch{return unavailable(reply);}
  });
  for(const pdf of [false,true])app.get<{Params:{id:string}}>(`${base}/:id${pdf?'/pdf':''}`,{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async(request,reply)=>{
   try{
    const actor=await principal(request,reply);if(!actor)return;if(!uuid.test(request.params.id))return reply.code(404).send({error:'not_found'});
    const row=(await pool!.query(`SELECT i.*,d.channel FROM paid_invoices i JOIN invoice_deliveries d ON d.invoice_id=i.id WHERE ${actor.where} AND i.id=$${actor.values.length+1}`,[...actor.values,request.params.id])).rows[0];
    if(!row)return reply.code(404).send({error:'not_found'});
    if(pdf)return sendPdf(reply,row);
    return {invoice:{...invoiceDto(row),snapshot:row.snapshot,downloadPath:`${base}/${row.id}/pdf`,delivery:row.channel==='download'?{state:'download'}:await deliveryStatus(row.id,demo)}};
   }catch{return unavailable(reply);}
  });
 }
 async function internal(request:FastifyRequest,reply:FastifyReply){
  const secret=process.env.INTERNAL_DELIVERY_SECRET??'';
  if(!pool||Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_'))){unavailable(reply);return false;}
  try{
   const header=request.headers.authorization;if(!header?.startsWith('Bearer '))throw Error();
   const {payload}=await jwtVerify(header.slice(7),new TextEncoder().encode(secret),{algorithms:['HS256'],issuer:'notification',subject:'notification',audience:'prepaid-access',requiredClaims:['iat','exp','sub'],maxTokenAge:'30s'});
   if(payload.scope!=='invoice:read'){reply.code(403).send({error:'forbidden'});return false;}return true;
  }catch{reply.code(401).send({error:'unauthorized'});return false;}
 }
 for(const pdf of [false,true])app.get<{Params:{id:string}}>(`/internal/v1/invoices/:id${pdf?'/pdf':''}`,async(request,reply)=>{
  if(!await internal(request,reply))return;if(!uuid.test(request.params.id))return reply.code(404).send({error:'not_found'});
  try{
   const row=(await pool!.query('SELECT i.*,d.channel,d.key_id,d.payload_cipher,d.payload_iv,d.payload_tag,d.download_token_hash,d.token_expires_at FROM paid_invoices i JOIN invoice_deliveries d ON d.invoice_id=i.id WHERE i.id=$1',[request.params.id])).rows[0];
   if(!row)return reply.code(404).send({error:'not_found'});if(pdf)return sendPdf(reply,row);return invoiceDeliveryDetails(row,demo);
  }catch(error){return error instanceof InvoiceError&&error.code==='invoice_link_expired'?reply.code(410).send({error:error.code}):unavailable(reply);}
 });
 // Only a 256-bit, expiring, invoice-scoped token authorizes this anonymous
 // download. It is delivered in a fragment and submitted in a POST body, never
 // in an access-log URL, and grants no voucher/account/network capability.
 app.post<{Body:{token:string}}>('/v1/invoice-downloads',{config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false,required:['token'],properties:{token:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'}}}}},async(request,reply)=>{
  if(!pool)return unavailable(reply);if(!originAllowed(request))return reply.code(403).send({error:'origin_rejected'});
  try{const row=(await pool.query(`SELECT i.number,i.pdf_bytes FROM invoice_deliveries d JOIN paid_invoices i ON i.id=d.invoice_id
   WHERE d.download_token_hash=$1 AND d.channel='sms' AND d.token_expires_at>clock_timestamp()`,[invoiceTokenHash(request.body.token)])).rows[0];
   return row?sendPdf(reply,row):reply.code(404).send({error:'invoice_link_unavailable'});
  }catch{return unavailable(reply);}
 });
}
