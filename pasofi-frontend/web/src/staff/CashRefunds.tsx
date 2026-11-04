import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from '../api';
import {type Staff,finishMutation,localDate,messageFor,money,mutationIntent} from '../business';
type Refund={id:string;saleId:string;siteName:string;bundleId:string;amountMinor:number;currency:string;reason:string;state:'requested'|'approved'|'rejected'|'paying'|'paid';requestedAt:string;decisionNote:string|null;auditHead:string;events:{sequence:number;state:string;actorId:string;recordedAt:string;hash:string}[]};
type Draft={path:string;body:Record<string,unknown>};
export default function CashRefunds({staff}:{staff:Staff}) {
 const [refunds,setRefunds]=useState<Refund[]>([]),[saleId,setSaleId]=useState(''),[reason,setReason]=useState('');
 const [selected,setSelected]=useState<Refund|null>(null),[action,setAction]=useState<'approved'|'rejected'|'prepare'|'payout'>('approved');
 const [draft,setDraft]=useState<Draft|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const live=useRef(false),owner=`staff:${staff.staffId}`;
 async function verify(){const current=await api<Staff>('/api/staff/session');if(current.staffId!==staff.staffId||current.version!==staff.version||current.role!==staff.role||current.status!=='approved')throw new ApiError(401,'staff_changed');}
 async function refresh(){await verify();const result=await api<{refunds:Refund[]}>('/api/staff/cash-refunds');if(live.current)setRefunds(result.refunds);}
 async function load(){setBusy(true);try{await refresh();const saved=sessionStorage.getItem(`pamofi.operation:${owner}:cash-refund`);if(live.current&&saved)setDraft(JSON.parse(JSON.parse(saved).payload) as Draft);}catch(error){if(live.current){setRefunds([]);setMessage(messageFor(error));}}finally{if(live.current)setBusy(false);}}
 useEffect(()=>{live.current=true;void load();return()=>{live.current=false;};},[staff.staffId,staff.version]);
 function choose(refund:Refund,next:typeof action){setSelected(refund);setAction(next);setReason('');setConfirmed(false);setMessage('');}
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy||!confirmed)return;
  const request:Draft=draft??(selected?(action==='prepare'?{path:`/api/staff/cash-refunds/${selected.id}/prepare-payout`,body:{}}:action==='payout'?{path:`/api/staff/cash-refunds/${selected.id}/payout`,body:{confirmed:true}}:{path:`/api/admin/cash-refunds/${selected.id}/decision`,body:{decision:action,note:reason.trim()}}):{path:'/api/staff/cash-refunds',body:{saleId:saleId.trim(),reason:reason.trim()}});
  setBusy(true);setMessage('');
  try{
   await verify();const key=mutationIntent(owner,'cash-refund',request);setDraft(request);
   const result=await api<{refund:Refund}>(request.path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(request.body)});
   finishMutation(owner,'cash-refund');if(!live.current)return;
   setDraft(null);setSelected(null);setReason('');setSaleId('');setConfirmed(false);
   setMessage(result.refund.state==='paying'?`Cash reserved. Return ${money(result.refund.amountMinor,result.refund.currency)} once, then record that it was returned. This shift stays open until confirmation.`:result.refund.state==='paid'?'Cash return recorded. Do not return the money again.':'Refund decision saved. Review its status before returning any cash.');await refresh();
  }catch(error){
   const rejected=error instanceof ApiError&&error.status===409&&['refund_sale_unavailable','refund_site_forbidden','refund_already_requested','refund_usage_review_required','refund_access_unavailable','independent_supervisor_required','refund_insufficient_cash','shift_required','refund_not_approved','refund_payout_not_prepared'].includes(error.code);
   if(rejected){finishMutation(owner,'cash-refund');if(live.current){setDraft(null);setConfirmed(false);}}
   if(live.current)setMessage(messageFor(error,'The refund result is unconfirmed. Retry the saved request; do not return cash twice.'));
  }finally{if(live.current)setBusy(false);}
 }
 return <section className="workspace-card"><div className="workspace-section-head"><div><h3>Cash refunds and voucher voids</h3><p>A separate administrator approves withdrawal of unused access. Reserve the refund against an open shift before returning cash, then confirm the actual return once.</p></div><button className="secondary" disabled={busy} onClick={load}>Refresh refunds</button></div>
  {message&&<p className="feedback" role="status">{message}</p>}
  {(staff.role==='agent'||selected||draft)&&<form className="form-grid" onSubmit={submit}>
   <h4>{draft?'Recover saved refund request':selected?action==='prepare'?'Prepare cash return':action==='payout'?'Record cash returned':`${action==='approved'?'Approve':'Reject'} refund`:'Request a refund'}</h4>
   {draft?<p className="notice">The original request is saved. Retry it to recover the result without issuing another refund.</p>:<fieldset disabled={busy} onChange={()=>setConfirmed(false)}>
    {selected?<p>{selected.siteName} · {selected.bundleId.toUpperCase()} · {money(selected.amountMinor,selected.currency)}<br/>Sale: {selected.saleId}</p>:<label>Refund sale reference<input required value={saleId} onChange={event=>setSaleId(event.target.value)} autoComplete="off"/></label>}
    {(!selected||['approved','rejected'].includes(action))&&<label>Refund reason<textarea required minLength={10} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label>}
    {selected&&action==='prepare'&&<p className="notice">Prepare only when the customer is present and you can return this amount. Preparation reserves the cash and prevents this shift from closing until the return is recorded.</p>}
   </fieldset>}
   <label className="check-label"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>{draft?'I am recovering the saved request and will not return cash a second time.':selected&&action==='payout'?`I have returned ${money(selected.amountMinor,selected.currency)} in cash to this customer.`:selected&&action==='prepare'?'The customer is present and I am ready to return the approved amount.':'I have checked this sale and confirm the recorded reason.'}</label>
   <button className="primary" disabled={busy||!confirmed}>{draft?'Retry saved refund request':selected?action==='prepare'?'Reserve cash for refund':action==='payout'?'Confirm cash returned':`${action==='approved'?'Approve and withdraw unused access':'Reject refund'}`:'Submit refund for approval'}</button>
   {selected&&!draft&&<button type="button" className="secondary" disabled={busy} onClick={()=>{setSelected(null);setConfirmed(false);setReason('');}}>Cancel review</button>}
  </form>}
  {!refunds.length?<p>No refund requests recorded.</p>:<ul className="audit-list">{refunds.map(refund=><li key={refund.id}><strong>{refund.siteName} · {refund.bundleId.toUpperCase()} · {money(refund.amountMinor,refund.currency)} · {refund.state==='paying'?'cash reserved; return awaiting confirmation':refund.state==='paid'?'cash returned':refund.state}</strong><p>{refund.reason}</p>{refund.decisionNote&&<p>Supervisor: {refund.decisionNote}</p>}<small>Sale: {refund.saleId} · {localDate(refund.requestedAt)}</small>
   <div className="purchase-actions">{staff.role==='admin'&&refund.state==='requested'&&<><button className="secondary" disabled={busy||!!draft} onClick={()=>choose(refund,'approved')}>Review approval</button><button className="secondary" disabled={busy||!!draft} onClick={()=>choose(refund,'rejected')}>Review rejection</button></>}{staff.role==='agent'&&refund.state==='approved'&&<button className="secondary" disabled={busy||!!draft} onClick={()=>choose(refund,'prepare')}>Prepare cash return</button>}{staff.role==='agent'&&refund.state==='paying'&&<button className="secondary" disabled={busy||!!draft} onClick={()=>choose(refund,'payout')}>Record returned cash</button>}</div>
   <details><summary>Refund audit trail</summary><ol>{refund.events.map(entry=><li key={entry.sequence}>{entry.state} · {localDate(entry.recordedAt)}<small>Actor: {entry.actorId}</small><small>Record hash: {entry.hash}</small></li>)}</ol><small>Audit head: {refund.auditHead}</small></details>
  </li>)}</ul>}
 </section>;
}
