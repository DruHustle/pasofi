import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from '../api';
import {type Capabilities,type Site,type Staff,finishMutation,messageFor,mutationIntent} from '../business';

type Draft={siteId:string;body:{enabled:boolean;expectedVersion:string;reason:string}};
const versionPattern=/^[1-9][0-9]{0,18}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validVersion(value:unknown):value is string{return typeof value==='string'&&versionPattern.test(value)&&BigInt(value)<=9223372036854775807n;}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function restoredDraft(raw:string):Draft{
 if(raw.length>5000)throw Error('invalid_saved_decision');
 const saved:unknown=JSON.parse(raw);
 if(!object(saved)||Object.keys(saved).some(key=>!['key','payload'].includes(key))||typeof saved.key!=='string'||!uuidPattern.test(saved.key)||typeof saved.payload!=='string'||saved.payload.length>3000)throw Error('invalid_saved_decision');
 const value:unknown=JSON.parse(saved.payload);
 if(!object(value)||Object.keys(value).some(key=>!['siteId','body'].includes(key))||typeof value.siteId!=='string'||!uuidPattern.test(value.siteId)||!object(value.body))throw Error('invalid_saved_decision');
 const body=value.body;
 if(Object.keys(body).some(key=>!['enabled','expectedVersion','reason'].includes(key))||typeof body.enabled!=='boolean'||!validVersion(body.expectedVersion)||typeof body.reason!=='string'||body.reason.length<10||body.reason.length>500||body.reason.trim()!==body.reason)throw Error('invalid_saved_decision');
 return value as Draft;
}
function reviewable(site:Site):site is Site&{enabled:boolean;version:string}{return typeof site.enabled==='boolean'&&validVersion(site.version);}

export default function SalesLocationStatus({staff,sites,capabilities,onSites}:{staff:Staff;sites:Site[];capabilities:Capabilities|null;onSites:(sites:Site[])=>void}) {
 const [selected,setSelected]=useState<(Site&{enabled:boolean;version:string})|null>(null),[reason,setReason]=useState('');
 const [draft,setDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [storageReady,setStorageReady]=useState(false),[storageProblem,setStorageProblem]=useState<'unreadable'|'unavailable'|null>(null),[reviewedRecovery,setReviewedRecovery]=useState(false);
 const live=useRef(false),owner=`staff:${staff.staffId}`;
 const canChange=capabilities?.salesLocationStatus===true&&staff.status==='approved'&&staff.role==='admin';
 useEffect(()=>{
  live.current=true;
  try{const saved=sessionStorage.getItem(`pamofi.operation:${owner}:sales-location-status`);if(saved){try{setDraft(restoredDraft(saved));}catch{setStorageProblem('unreadable');}}}
  catch{setStorageProblem('unavailable');}
  finally{setStorageReady(true);}
  return()=>{live.current=false;};
 },[owner]);
 async function verify(){const current=await api<Staff>('/api/staff/session');if(current.staffId!==staff.staffId||current.version!==staff.version||current.status!=='approved'||current.role!=='admin'||current.mfaVerified!==true)throw new ApiError(401,'staff_changed');}
 async function refresh(){await verify();const result=await api<{sites:Site[]}>('/api/staff/sites');if(live.current)onSites(result.sites);}
 async function reload(){if(busy)return;setBusy(true);try{await refresh();if(live.current){setReviewedRecovery(true);setMessage('Sales locations refreshed.');}}catch(error){if(live.current)setMessage(messageFor(error));}finally{if(live.current)setBusy(false);}}
 async function discardUnreadable(){if(busy||storageProblem!=='unreadable'||!reviewedRecovery)return;setBusy(true);try{await refresh();if(!live.current)return;finishMutation(owner,'sales-location-status');setStorageProblem(null);setReviewedRecovery(false);setMessage('Unreadable local decision discarded. An earlier server change may have completed. Review the current sales location before making another decision.');}catch(error){if(live.current)setMessage(messageFor(error,'The saved record could not be cleared. No change was sent to the server.'));}finally{if(live.current)setBusy(false);}}
 function choose(site:Site){if(!canChange||!storageReady||storageProblem||busy||draft||!reviewable(site))return;setSelected(site);setReason('');setMessage('');}
 async function submit(event:React.FormEvent){
  event.preventDefault();if(busy||!canChange||!storageReady||storageProblem||(!draft&&(!selected||reason.trim().length<10)))return;
  const request:Draft=draft??{siteId:selected!.id,body:{enabled:!selected!.enabled,expectedVersion:selected!.version,reason:reason.trim()}};
  setBusy(true);setMessage('');let attempted=false;
  try{
   await verify();if(!live.current)return;
   const key=mutationIntent(owner,'sales-location-status',request);setDraft(request);
   attempted=true;
   const result=await api<{site:Site;changed:boolean;replayed:boolean}>(`/api/admin/sites/${request.siteId}`,{method:'PATCH',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(request.body)});
   finishMutation(owner,'sales-location-status');if(!live.current)return;
   setDraft(null);setSelected(null);setReason('');
   const confirmation=result.replayed?'Saved sales location decision recovered.':'Sales location decision saved.';
   // A replay returns the original decision; another administrator may have
   // changed the location since. Display a fresh read, not the replayed status.
   try{await refresh();if(live.current)setMessage(`${confirmation} The list shows the latest status.`);}
   catch{if(live.current)setMessage(`${confirmation} Refresh sales locations to check the latest status.`);}
  }catch(error){
   const rejected=error instanceof ApiError&&((error.status===409&&error.code==='version_conflict')||(error.status===400&&error.code==='invalid_site_status')||(error.status===404&&error.code==='not_found'));
   if(rejected){finishMutation(owner,'sales-location-status');if(live.current){setDraft(null);setSelected(null);setReason('');}try{await refresh();}catch{/* Keep the authoritative rejection; refresh remains available. */}}
   if(live.current)setMessage(rejected?messageFor(error,'The sales location change was rejected. Refresh and review the current location.'):attempted?`${messageFor(error)} The saved decision remains available; retry it before making another change.`:error instanceof ApiError?`${messageFor(error)} No change was sent by this attempt.`:draft?'The saved decision could not be read in this browser. No change was sent by this attempt; the earlier decision may still have completed. Enable browser storage and reload.':'The decision could not be saved in this browser, so no change was sent. Enable browser storage before trying again.');
  }finally{if(live.current)setBusy(false);}
 }
 const pendingName=draft?(sites.find(site=>site.id===draft.siteId)?.name??draft.siteId):'';
 return <section className="workspace-card" aria-labelledby="sales-locations-heading">
  <div className="workspace-section-head"><h3 id="sales-locations-heading">Sales locations</h3><button className="secondary" disabled={busy} onClick={reload}>Refresh sales locations</button></div>
  <p>Enable or pause new sales at a location. Paid receipts, stock records and account history remain available. Router trust, customer Wi-Fi access and the overall sales switch are managed separately.</p>
  {!canChange&&<p className="notice">Sales location status controls require the service update.</p>}
  {storageProblem==='unreadable'&&<div className="notice" role="alert"><p>Saved sales location decision details are unreadable. An earlier change may have completed. Refresh sales locations and review the current list before discarding the unreadable local record. Discarding does not undo a server change.</p><button className="secondary" disabled={busy||!reviewedRecovery} onClick={discardUnreadable}>Discard unreadable local decision after review</button></div>}
  {storageProblem==='unavailable'&&<p className="notice" role="alert">Saved decisions cannot be checked because browser storage is unavailable. No change has been sent from this page. Enable browser storage and reload before making a decision; an earlier request may have completed.</p>}
  {message&&<p className="feedback" role="status">{message}</p>}
  {sites.length===0?<p>No sales locations configured.</p>:<ul className="inventory-list">{sites.map(site=><li key={site.id}><div><strong>{site.name}</strong><small>{site.id}</small><span>{site.enabled===true?'New sales enabled':site.enabled===false?'New sales paused':'Sales status unavailable'}</span></div>{canChange&&reviewable(site)&&<button className="secondary" disabled={busy||!!draft||!storageReady||!!storageProblem} onClick={()=>choose(site)} aria-label={`Review sales status for ${site.name}`}>Review sales status</button>}</li>)}</ul>}
  {(selected||draft)&&<form className="form-grid" onSubmit={submit}>
   <h4>{draft?`Recover saved decision for ${pendingName}`:`${selected!.enabled?'Pause':'Enable'} new sales at ${selected!.name}`}</h4>
   {draft?<div className="notice"><p>Saved decision: {draft.body.enabled?'enable':'pause'} new sales. Reviewed version: {draft.body.expectedVersion}.</p><p>Reason: {draft.body.reason}</p><p>Retry the same decision to recover its result. A retry cannot overwrite a later change.</p></div>:<fieldset disabled={busy||!canChange}><p>Reviewed sales status: {selected!.enabled?'enabled':'paused'} · version {selected!.version}. This decision does not change Wi-Fi availability.</p><label>Sales location reason<textarea required minLength={10} maxLength={500} rows={3} value={reason} onChange={event=>setReason(event.target.value)} aria-describedby="sales-location-reason-hint"/></label><p id="sales-location-reason-hint">Enter at least 10 characters explaining this sales location decision.</p></fieldset>}
   <button className="primary" disabled={busy||!canChange||!storageReady||!!storageProblem||(!draft&&reason.trim().length<10)}>{draft?'Retry saved sales location decision':selected!.enabled?'Pause new sales':'Enable new sales'}</button>
   {!draft&&<button type="button" className="secondary" disabled={busy} onClick={()=>{setSelected(null);setReason('');}}>Cancel sales location review</button>}
  </form>}
 </section>;
}
