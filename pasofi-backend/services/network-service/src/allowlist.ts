import type {IpBinding} from './routeros.js';

// Approved devices bypass the HotSpot captive portal on every configured site
// router. The router stores each one as an ip-binding (type=bypassed,
// server=all) whose comment starts with this tag and the entry's UUID. The
// reconciler owns tagged bindings only: an untagged or malformed binding is
// operator configuration (for example K0's bypass for K1's uplink) and is
// never created, changed or removed here.
export const ALLOWLIST_TAG='pasofi-allowlist:';
export const MAX_APPROVED_DEVICES=200;
export const LABEL_MAX=80;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAGGED=new RegExp(`^${ALLOWLIST_TAG}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?: |$)`);

export class AllowlistError extends Error {
 constructor(public code:string,public status=400){super(code);}
}

// Accepts AA:BB:CC:DD:EE:FF, aa-bb-cc-dd-ee-ff, aabb.ccdd.eeff or aabbccddeeff.
// Returns upper-case colon form. Broadcast, multicast (I/G bit set) and the
// all-zero address can never identify one device, so they are rejected.
export function normalizeMac(value:unknown):string {
 if(typeof value!=='string')throw new AllowlistError('invalid_mac_address');
 const raw=value.trim();
 let hex:string;
 if(/^[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}$/.test(raw))hex=raw.replace(/[:-]/g,'');
 else if(/^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/.test(raw))hex=raw.replace(/\./g,'');
 else if(/^[0-9A-Fa-f]{12}$/.test(raw))hex=raw;
 else throw new AllowlistError('invalid_mac_address');
 hex=hex.toUpperCase();
 if(hex==='000000000000')throw new AllowlistError('invalid_mac_address');
 if(hex==='FFFFFFFFFFFF')throw new AllowlistError('broadcast_mac_address');
 if(parseInt(hex.slice(0,2),16)&1)throw new AllowlistError('multicast_mac_address');
 return hex.match(/../g)!.join(':');
}
export function normalizeLabel(value:unknown):string {
 if(typeof value!=='string')throw new AllowlistError('invalid_label');
 const label=value.trim().replace(/\s+/g,' ');
 if(!label||[...label].length>LABEL_MAX||/[\u0000-\u001f\u007f-\u009f]/.test(value))throw new AllowlistError('invalid_label');
 return label;
}
export function normalizeReason(value:unknown):string {
 if(typeof value!=='string')throw new AllowlistError('invalid_reason');
 const reason=value.trim();
 if(reason.length<10||Buffer.byteLength(reason)>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw new AllowlistError('invalid_reason');
 return reason;
}
export function bindingComment(id:string,label:string){
 if(!UUID.test(id))throw new AllowlistError('invalid_request');
 return `${ALLOWLIST_TAG}${id} ${label}`;
}
// Returns the owning entry ID only for the exact tag format this service writes.
export function taggedId(comment:string|undefined):string|null {
 const match=comment?TAGGED.exec(comment):null;
 return match?match[1]:null;
}
function macOf(binding:IpBinding){try{return binding.macAddress?normalizeMac(binding.macAddress):null;}catch{return null;}}

export type DesiredDevice={id:string;macAddress:string;label:string};
export type DeviceState='applied'|'conflict'|'missing';
export type BindingPlan={
 remove:{bindingId:string;entryId:string;macAddress:string|null}[];
 add:DesiredDevice[];
 states:Map<string,DeviceState>;
};
// Pure diff from the router's current bindings to the wanted list. Removals
// come first so a MAC that moved to a new entry is never bound twice.
export function planBindings(observed:IpBinding[],desired:DesiredDevice[]):BindingPlan {
 const wanted=new Map(desired.map(device=>[device.id,device]));
 const kept=new Set<string>(),untaggedMacs=new Set<string>(),remove:BindingPlan['remove']=[];
 for(const binding of observed){
  const owner=taggedId(binding.comment),mac=macOf(binding);
  if(!owner){if(mac)untaggedMacs.add(mac);continue;}
  const device=wanted.get(owner);
  const exact=!!device&&!kept.has(owner)&&mac===device.macAddress&&binding.type==='bypassed'&&binding.server==='all'&&!binding.disabled;
  if(exact)kept.add(owner);
  else remove.push({bindingId:binding.id,entryId:owner,macAddress:mac});
 }
 const add:DesiredDevice[]=[],states=new Map<string,DeviceState>();
 for(const device of desired){
  if(kept.has(device.id))states.set(device.id,'applied');
  else if(untaggedMacs.has(device.macAddress))states.set(device.id,'conflict');
  else {states.set(device.id,'missing');add.push(device);}
 }
 return {remove,add,states};
}

export interface BindingRouter {
 bindings(signal?:AbortSignal):Promise<IpBinding[]>;
 addBypassBinding(macAddress:string,comment:string,signal?:AbortSignal):Promise<void>;
 removeBinding(id:string,signal?:AbortSignal):Promise<void>;
}
export type RouterSyncResult={
 status:'synced'|'attention'|'unreachable';
 errorCode:string|null;
 states:Map<string,DeviceState>;
 added:DesiredDevice[];
 removed:BindingPlan['remove'];
 conflicts:number;
 pendingRemovals:number;
};
// Idempotent: reading, applying the diff and independently re-reading. A
// successful write response alone is not treated as proof of the outcome.
export async function reconcileRouter(router:BindingRouter,desired:DesiredDevice[],signal?:AbortSignal):Promise<RouterSyncResult> {
 let plan:BindingPlan;
 try {plan=planBindings(await router.bindings(signal),desired);}
 catch {return {status:'unreachable',errorCode:'router_unavailable',states:new Map(),added:[],removed:[],conflicts:0,pendingRemovals:0};}
 const added:DesiredDevice[]=[],removed:BindingPlan['remove']=[];let failed=false;
 for(const item of plan.remove){
  if(signal?.aborted)break;
  try {await router.removeBinding(item.bindingId,signal);removed.push(item);}catch{failed=true;}
 }
 for(const device of plan.add){
  if(signal?.aborted)break;
  try {await router.addBypassBinding(device.macAddress,bindingComment(device.id,device.label),signal);added.push(device);}catch{failed=true;}
 }
 let verified:BindingPlan;
 try {verified=planBindings(await router.bindings(signal),desired);}
 catch {return {status:'unreachable',errorCode:'verification_unavailable',states:new Map(),added,removed,conflicts:0,pendingRemovals:0};}
 const conflicts=[...verified.states.values()].filter(state=>state==='conflict').length;
 const settled=!verified.add.length&&!verified.remove.length&&!conflicts;
 return {status:settled?'synced':'attention',errorCode:settled?null:failed?'write_failed':conflicts?'untagged_conflict':'not_converged',
  states:verified.states,added,removed,conflicts,pendingRemovals:verified.remove.length};
}
