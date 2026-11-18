import { api } from './api';

const storageKey = 'pasofi.registration';
export const registrationUrl = (audience:'user'|'admin') =>
  'https://account.onesa.eu/register?audience='+audience+'&product=pasofi&platform=web';

function destination(value:string) {
  if(value==='/#staff' || value==='/#connect')return value;
  return /^\/#(?:home|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(value) ? value : '/#account';
}
export function rememberRegistration(staff=false) {
  const path=staff?'/#staff':location.pathname==='/connect'&&!location.hash?'/#connect':'/'+location.hash;
  try { sessionStorage.setItem(storageKey,JSON.stringify({path:destination(path),expires:Date.now()+30*60*1000})); } catch {}
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
export function resumeRegistration() {
  if(location.pathname!=='/' || location.search!=='?registration=complete')return;
  let path='/#account', valid=false;
  try {
    const raw=sessionStorage.getItem(storageKey);
    sessionStorage.removeItem(storageKey);
    if(raw){
      const pending=JSON.parse(raw);
      const now=Date.now();
      if(typeof pending?.path==='string' && Number.isFinite(pending.expires) &&
          pending.expires>=now && pending.expires<=now+30*60*1000){
        path=destination(pending.path);
        valid=true;
      }
    }
  } catch { /* Blocked browser storage cannot authorize a registration return. */ }
  // A registration-complete query is not proof of account access. Always remove
  // it, even when the browser has no pending receipt or its receipt expired.
  history.replaceState(null,'',path);
  if(!valid)return;
  const staff=path==='/#staff';
  void api<{origin:string|null}>(staff?'/api/staff/onesa/availability':'/api/onesa/availability')
    .then(value=>{if(value.origin===location.origin)return startProductSignIn(staff,path);})
    .catch(()=>{}); // The restored screen retains its ordinary sign-in and retry controls.
}
