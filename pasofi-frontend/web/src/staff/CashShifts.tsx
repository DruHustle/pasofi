import {useEffect, useRef, useState} from 'react';
import {api, ApiError} from '../api';
import {type Staff, type Site, finishMutation, localDate, messageFor, mutationIntent} from '../business';

type Shift = {id:string;agentId:string;siteId:string;currency:string;openingMinor:string;openedAt:string;closedAt:string|null;countedMinor:string|null;expectedMinor:string;differenceMinor:string|null;closeNote:string|null;saleCount:string;salesMinor:string;commissionMinor:string;refundsMinor:string;commissionReversedMinor:string};
type Draft = {path:string;body:{siteId:string;currency:string;openingMinor:number}|{countedMinor:number;note:string}};
function cash(value:string,currency:string) { const number=BigInt(value),absolute=number<0n?-number:number;return `${currency} ${number<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`; }
function amount(value:string) { if(!/^\d{1,11}(?:\.\d{1,2})?$/.test(value))throw Error('Enter a cash amount with no more than two decimal places.');const [whole,fraction='']=value.split('.');const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));if(result>1_000_000_000_000)throw Error('The cash amount exceeds the supported limit.');return result; }
export default function CashShifts({staff,selling}:{staff:Staff;selling:boolean}) {
 const [shifts,setShifts]=useState<Shift[]>([]),[sites,setSites]=useState<Site[]>([]),[currencies,setCurrencies]=useState<string[]>([]);
 const [siteId,setSiteId]=useState(''),[currency,setCurrency]=useState(''),[opening,setOpening]=useState('0.00');
 const [closing,setClosing]=useState<Shift|null>(null),[counted,setCounted]=useState(''),[note,setNote]=useState('');
 const [draft,setDraft]=useState<Draft|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const live=useRef(false),owner=`staff:${staff.staffId}`;
 async function verify() { const current=await api<Staff>('/api/staff/session');if(current.staffId!==staff.staffId||current.version!==staff.version||current.role!==staff.role||current.status!=='approved')throw new ApiError(401,'staff_changed'); }
 async function refresh() {
  await verify();
  const [result,locations]=await Promise.all([api<{shifts:Shift[];currencies:string[]}>('/api/staff/cash-shifts'),api<{sites:Site[]}>('/api/staff/sites')]);
  if(!live.current)return;
  setShifts(result.shifts);setCurrencies(result.currencies);setSites(locations.sites);setCurrency(value=>value||result.currencies[0]||'');setSiteId(value=>value||locations.sites[0]?.id||'');
 }
 async function load() { setBusy(true);try{await refresh();const saved=sessionStorage.getItem(`pamofi.operation:${owner}:cash-shift`);if(live.current&&saved)setDraft(JSON.parse(JSON.parse(saved).payload) as Draft);}catch(error){if(live.current){setShifts([]);setMessage(messageFor(error));}}finally{if(live.current)setBusy(false);} }
 useEffect(()=>{live.current=true;void load();return()=>{live.current=false;};},[staff.staffId,staff.version]);
 async function submit(event:React.FormEvent) {
  event.preventDefault();if(busy||!confirmed)return;
  let request:Draft;
  try{request=draft??(closing?{path:`/api/staff/cash-shifts/${closing.id}/close`,body:{countedMinor:amount(counted),note:note.trim()}}:{path:'/api/staff/cash-shifts',body:{siteId,currency,openingMinor:amount(opening)}});}catch(error){setMessage((error as Error).message);return;}
  setBusy(true);setMessage('');
  try {
   await verify();const key=mutationIntent(owner,'cash-shift',request);setDraft(request);
   await api(request.path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(request.body)});
   finishMutation(owner,'cash-shift');if(!live.current)return;
   setDraft(null);setClosing(null);setConfirmed(false);setCounted('');setNote('');setMessage('Cash shift saved. Recorded amounts remain available for reconciliation.');await refresh();
  }catch(error){
   const rejected=error instanceof ApiError&&error.status===409&&['shift_already_open','currency_unavailable','site_unavailable','commerce_disabled'].includes(error.code);
   if(rejected){finishMutation(owner,'cash-shift');if(live.current)setDraft(null);}
   if(live.current)setMessage(messageFor(error,'The result is unconfirmed. Retry the saved shift request before making another adjustment.'));
  }finally{if(live.current)setBusy(false);}
 }
 return <section className="workspace-card"><div className="workspace-section-head"><div><h3>Cash shifts and reconciliation</h3><p>Expected cash is the opening float plus sales, minus cash refunds. Commission is recorded separately; it is not deducted from the cash drawer.</p></div><button className="secondary" disabled={busy} onClick={load}>Refresh shifts</button></div>
  {message&&<p role="status" className="feedback">{message}</p>}
  {staff.role==='agent'&&<form className="form-grid" onSubmit={submit}><h4>{draft?'Recover saved shift request':closing?'Close cash shift':'Open cash shift'}</h4>
   {draft?<p className="notice">The original request is saved. Retry it without opening a second shift or changing your counted cash.</p>:<fieldset disabled={busy} onChange={()=>setConfirmed(false)}>{closing?<><p>{sites.find(site=>site.id===closing.siteId)?.name??closing.siteId} · {closing.currency}</p><label>Counted cash<input required inputMode="decimal" value={counted} onChange={event=>setCounted(event.target.value)}/></label><label>Reconciliation note<textarea required minLength={10} maxLength={500} value={note} onChange={event=>setNote(event.target.value)}/></label></>:<><label>Shift site<select required value={siteId} onChange={event=>setSiteId(event.target.value)}>{sites.map(site=><option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Shift currency<select required value={currency} onChange={event=>setCurrency(event.target.value)}>{currencies.map(value=><option key={value}>{value}</option>)}</select></label><label>Opening cash float<input required inputMode="decimal" value={opening} onChange={event=>setOpening(event.target.value)}/></label></>}</fieldset>}
   <label className="check-label"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>{draft?'I am retrying the saved request without changing the cash count.':'I have counted the cash and confirm this amount.'}</label>
   <button className="primary" disabled={busy||!confirmed||(!draft&&!closing&&(!selling||!siteId||!currency))}>{draft?'Retry saved shift request':closing?'Confirm counted cash and close':'Open shift'}</button>{closing&&!draft&&<button type="button" className="secondary" disabled={busy} onClick={()=>{setClosing(null);setConfirmed(false);}}>Keep shift open</button>}
  </form>}
  {shifts.length===0?<p>No cash shifts recorded. An agent needs an open shift for the sale location and currency.</p>:<div className="table-scroll"><table><thead><tr><th>Shift</th><th>Cash sales</th><th>Refunds</th><th>Commission</th><th>Expected cash</th><th>Count and difference</th><th>Action</th></tr></thead><tbody>{shifts.map(shift=><tr key={shift.id}><td>{sites.find(site=>site.id===shift.siteId)?.name??shift.siteId}<small>{localDate(shift.openedAt)} · {shift.closedAt?'Closed':'Open'}</small><small>Agent: {shift.agentId}</small><small>Reference: {shift.id}</small></td><td>{cash(shift.salesMinor,shift.currency)}<small>{shift.saleCount} sales</small></td><td>{cash(shift.refundsMinor,shift.currency)}</td><td>{cash(shift.commissionMinor,shift.currency)}<small>Reversed: {cash(shift.commissionReversedMinor,shift.currency)}</small></td><td>{cash(shift.expectedMinor,shift.currency)}</td><td>{shift.countedMinor===null?'Awaiting count':<>{cash(shift.countedMinor,shift.currency)}<small>Difference: {cash(shift.differenceMinor!,shift.currency)}</small><small>{shift.closeNote}</small></>}</td><td>{staff.role==='agent'&&!shift.closedAt&&<button className="secondary" disabled={busy||!!draft} onClick={()=>{setClosing(shift);setCounted('');setNote('');setConfirmed(false);}}>Count and close</button>}</td></tr>)}</tbody></table></div>}
 </section>;
}
