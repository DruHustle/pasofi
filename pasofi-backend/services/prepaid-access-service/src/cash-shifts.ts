import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {VoucherError} from './vouchers.js';

type Staff = {staffId: string; role: 'admin'|'agent'|'support'; siteIds: string[]};
export type CashStaffResolver = (request: FastifyRequest, reply: FastifyReply, roles: Staff['role'][]) => Promise<Staff|null>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type CashListQuery = {before?: string; active?: boolean; limit: number};
export const cashListSchema = {querystring:{type:'object',additionalProperties:false,properties:{
 before:{type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'}, active:{type:'boolean'}, limit:{type:'integer',minimum:1,maximum:50,default:50},
}}};
const minor = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value)>=0 && Number(value)<=1_000_000_000_000;
const body = (value: unknown): Record<string, unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export async function cashTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
 const client=await pool.connect();
 try { await client.query('BEGIN'); const result=await run(client); await client.query('COMMIT'); return result; }
 catch(error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
}
export async function shiftTotals(client: Pick<PoolClient,'query'>, id: string) {
 const result=await client.query(`SELECT count(*)::text AS "saleCount",COALESCE(sum(price_minor),0)::text AS "salesMinor",COALESCE(sum(commission_minor),0)::text AS "commissionMinor" FROM agent_sales WHERE shift_id=$1`,[id]);
 const refunds=(await client.query(`SELECT COALESCE(sum(s.price_minor),0)::text AS "refundsMinor",COALESCE(sum(s.commission_minor),0)::text AS "commissionReversedMinor" FROM cash_refunds r JOIN agent_sales s ON s.id=r.sale_id WHERE r.payout_shift_id=$1 AND r.state='paid'`,[id])).rows[0];
 const pending=(await client.query(`SELECT COALESCE(sum(s.price_minor),0)::text AS "pendingRefundsMinor" FROM cash_refunds r JOIN agent_sales s ON s.id=r.sale_id WHERE r.payout_shift_id=$1 AND r.state='paying'`,[id])).rows[0];
 return {...result.rows[0],...refunds,...pending} as {saleCount:string; salesMinor:string; commissionMinor:string; refundsMinor:string; commissionReversedMinor:string; pendingRefundsMinor:string};
}
export async function shiftDto(client: Pick<PoolClient,'query'>, row: Record<string, any>) {
 const totals=await shiftTotals(client,row.id),expected=BigInt(row.opening_minor)+BigInt(totals.salesMinor)-BigInt(totals.refundsMinor);
 return {id:row.id,agentId:row.agent_id,siteId:row.site_id,currency:row.currency,openingMinor:String(row.opening_minor),openedAt:row.opened_at,closedAt:row.closed_at,countedMinor:row.counted_minor===null?null:String(row.counted_minor),expectedMinor:String(row.expected_minor??expected),differenceMinor:row.counted_minor===null?null:String(BigInt(row.counted_minor)-BigInt(row.expected_minor)),closeNote:row.close_note,...totals};
}
export function registerCashShifts(app: FastifyInstance,pool:Pool|null,staff:CashStaffResolver,enabled:boolean,currencies:string[]) {
 const fail=(reply:FastifyReply,error:unknown)=>reply.code(error instanceof VoucherError?409:503).send({error:error instanceof VoucherError?error.code:'unavailable'});
 app.get<{Querystring:CashListQuery}>('/v1/staff/cash-shifts',{schema:cashListSchema},async(request,reply)=>{
  const s=await staff(request,reply,['agent','admin']);if(!s)return;
  const {before,active,limit}=request.query;
  try {
   const {rows}=await pool!.query(`SELECT * FROM cash_shifts
    WHERE ($1::boolean OR agent_id=$2) AND (NOT $3::boolean OR closed_at IS NULL)
      AND ($4::uuid IS NULL OR (opened_at,id)<(SELECT opened_at,id FROM cash_shifts WHERE id=$4 AND ($1 OR agent_id=$2)))
    ORDER BY opened_at DESC,id DESC LIMIT $5`,[s.role==='admin',s.staffId,active??false,before??null,limit+1]);
   const page=rows.slice(0,limit);
   return {shifts:await Promise.all(page.map(row=>shiftDto(pool!,row))),currencies,nextCursor:rows.length>limit?page[limit-1].id:null};
  }catch(error){return fail(reply,error);}
 });
 app.post('/v1/staff/cash-shifts',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{
  const s=await staff(request,reply,['agent']);if(!s)return;
  const b=body(request.body),key=request.headers['idempotency-key'];
  if(typeof key!=='string'||!uuid.test(key)||typeof b.siteId!=='string'||!uuid.test(b.siteId)||typeof b.currency!=='string'||!/^[A-Z]{3}$/.test(b.currency)||!minor(b.openingMinor))return reply.code(400).send({error:'invalid_shift'});
  if(!s.siteIds.includes(b.siteId))return reply.code(403).send({error:'site_forbidden'});
  try {
   const result=await cashTransaction(pool!,async client=>{
    // Serialize all open attempts by this agent, including different keys.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`cash-shift:${s.staffId}`]);
    const previous=(await client.query('SELECT * FROM cash_shifts WHERE agent_id=$1 AND request_key=$2',[s.staffId,key])).rows[0];
    if(previous){if(previous.site_id!==b.siteId||previous.currency!==b.currency||BigInt(previous.opening_minor)!==BigInt(b.openingMinor as number))throw new VoucherError('idempotency_conflict');return {shift:await shiftDto(client,previous),replayed:true};}
    if(!enabled)throw new VoucherError('commerce_disabled');
    if(!currencies.includes(b.currency as string))throw new VoucherError('currency_unavailable');
    if(!(await client.query('SELECT id FROM sales_locations WHERE id=$1 AND enabled',[b.siteId])).rowCount)throw new VoucherError('site_unavailable');
    if((await client.query('SELECT id FROM cash_shifts WHERE agent_id=$1 AND site_id=$2 AND currency=$3 AND closed_at IS NULL',[s.staffId,b.siteId,b.currency])).rowCount)throw new VoucherError('shift_already_open');
    const row=(await client.query('INSERT INTO cash_shifts(id,agent_id,site_id,currency,request_key,opening_minor) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),s.staffId,b.siteId,b.currency,key,b.openingMinor])).rows[0];
    await client.query("INSERT INTO commerce_audit(id,actor_id,action,target_id,reason,details) VALUES($1,$2,'cash.shift.open',$3,'Agent attested opening cash',$4)",[randomUUID(),s.staffId,row.id,JSON.stringify({siteId:b.siteId,currency:b.currency,openingMinor:b.openingMinor})]);
    return {shift:await shiftDto(client,row),replayed:false};
   });return reply.code(result.replayed?200:201).send(result);
  }catch(error){return fail(reply,error);}
 });
 app.post<{Params:{id:string}}>('/v1/staff/cash-shifts/:id/close',async(request,reply)=>{
  const s=await staff(request,reply,['agent']);if(!s)return;
  const b=body(request.body),key=request.headers['idempotency-key'];
  if(!uuid.test(request.params.id)||typeof key!=='string'||!uuid.test(key)||!minor(b.countedMinor)||typeof b.note!=='string'||b.note.trim().length<10||b.note.length>500)return reply.code(400).send({error:'invalid_shift_close'});
  try {
   const result=await cashTransaction(pool!,async client=>{
    const row=(await client.query('SELECT * FROM cash_shifts WHERE id=$1 AND agent_id=$2 FOR UPDATE',[request.params.id,s.staffId])).rows[0];
    if(!row)throw new VoucherError('shift_unavailable');
    // Closing the owner's existing shift remains possible after selling is paused
    // or site access is withdrawn; it cannot create a new sale or move money.
    if(row.closed_at){if(row.close_key!==key||BigInt(row.counted_minor)!==BigInt(b.countedMinor as number)||row.close_note!==(b.note as string).trim())throw new VoucherError('shift_already_closed');return {shift:await shiftDto(client,row),replayed:true};}
    const totals=await shiftTotals(client,row.id);if(BigInt(totals.pendingRefundsMinor)>0n)throw new VoucherError('refund_payout_pending');const expected=BigInt(row.opening_minor)+BigInt(totals.salesMinor)-BigInt(totals.refundsMinor);
    const closed=(await client.query('UPDATE cash_shifts SET closed_at=now(),close_key=$2,counted_minor=$3,expected_minor=$4,close_note=$5 WHERE id=$1 RETURNING *',[row.id,key,b.countedMinor,String(expected),(b.note as string).trim()])).rows[0];
    await client.query("INSERT INTO commerce_audit(id,actor_id,action,target_id,reason,details) VALUES($1,$2,'cash.shift.close',$3,$4,$5)",[randomUUID(),s.staffId,row.id,(b.note as string).trim(),JSON.stringify({expectedMinor:String(expected),countedMinor:b.countedMinor,differenceMinor:String(BigInt(b.countedMinor as number)-expected),...totals})]);
    return {shift:await shiftDto(client,closed),replayed:false};
   });return result;
  }catch(error){return fail(reply,error);}
 });
}
