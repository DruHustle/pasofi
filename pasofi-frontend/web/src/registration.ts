import { api } from './api';

const storageKey = 'pasofi.registration';
const receiptLifetime = 30 * 60 * 1000;
export const registrationUrl = (audience:'user'|'admin') =>
  'https://account.onesa.eu/register?audience='+audience+'&product=pasofi&platform=web';

function destination(value:string) {
  if(value==='/#staff' || value==='/#connect')return value;
  return /^\/#(?:home|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(value) ? value : '/#account';
}
export function rememberRegistration(staff=false) {
  const path=staff?'/#staff':location.pathname==='/connect'&&!location.hash?'/#connect':'/'+location.hash;
  const receipt=JSON.stringify({path:destination(path),expires:Date.now()+receiptLifetime});
  if (!staff) {
    // Email verification may open the return in another tab on this origin.
    try { localStorage.setItem(storageKey,receipt); return; } catch {}
  }
  try { sessionStorage.setItem(storageKey,receipt); } catch {}
}
export async function startProductSignIn(staff:boolean,returnTo:string) {
  if(staff)sessionStorage.removeItem('pasofi-onesa-customer');
  const flow=await api<{authorizationUrl:string}>(staff?'/api/staff/onesa/start':'/api/onesa/start',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(staff?{}:{returnTo}),
  });
  const target=new URL(flow.authorizationUrl);
  if(target.protocol!=='https:' || target.username || target.password)throw Error('Invalid sign-in destination');
  if(!staff)sessionStorage.setItem('pasofi-onesa-customer','1');
  location.assign(target.href);
}
function takeRegistration(storage:'sessionStorage'|'localStorage') {
  try {
    const raw=window[storage].getItem(storageKey);
    window[storage].removeItem(storageKey);
    if(!raw)return null;
    const pending=JSON.parse(raw);
    const now=Date.now();
    if(typeof pending?.path!=='string' || !Number.isSafeInteger(pending.expires) ||
        pending.expires<now || pending.expires>now+receiptLifetime)return null;
    if(storage==='localStorage' && pending.path==='/#staff')return null;
    return destination(pending.path);
  } catch { /* Blocked browser storage cannot authorize a registration return. */ }
  return null;
}
export function resumeRegistration() {
  if(location.pathname!=='/' || location.search!=='?registration=complete')return;
  const path=takeRegistration('sessionStorage') ?? takeRegistration('localStorage');
  // A registration-complete query is not proof of account access. Always remove
  // it, even when the browser has no pending receipt or its receipt expired.
  history.replaceState(null,'',path ?? '/#account');
  if(!path)return;
  const staff=path==='/#staff';
  void api<{origin:string|null}>(staff?'/api/staff/onesa/availability':'/api/onesa/availability')
    .then(value=>{if(value.origin===location.origin)return startProductSignIn(staff,path);})
    .catch(()=>{}); // The restored screen retains its ordinary sign-in and retry controls.
}
