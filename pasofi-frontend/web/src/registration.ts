import { api, hotspotPortal } from './api';

const storageKey = 'pasofi.registration';
const hotspotScreens = ['/connect', '/connect#bundles', '/connect#voucher'];
export const registrationUrl = (audience:'user'|'admin') =>
  'https://account.onesa.eu/register?audience='+audience+'&product=pasofi&platform=web'+
  (hotspotPortal && audience === 'user' ? '&entry=pasofi-hotspot' : '');

type Availability = { origin: string | null; hotspotOrigin?: string; signup?: boolean };

export async function accountEntryAvailability(staff = false, signal?: AbortSignal) {
  const value = await api<Availability>(staff ? '/api/staff/onesa/availability' : '/api/onesa/availability', {signal});
  const expectedOrigin = hotspotPortal && !staff ? value.hotspotOrigin : value.origin;
  const signIn = expectedOrigin === location.origin;
  return { signIn, signup: signIn && !staff && value.signup === true };
}

export async function signInAvailable(staff = false, signal?: AbortSignal) {
  return (await accountEntryAvailability(staff, signal)).signIn;
}

export function currentCustomerScreen() {
  const path = location.pathname + location.hash;
  if (hotspotPortal && hotspotScreens.includes(path)) return path;
  return path === '/connect' ? '/#connect' : '/' + (location.hash || '#home');
}

function destination(value:string) {
  if(value==='/#staff' || value==='/#connect' || (hotspotPortal && hotspotScreens.includes(value)))return value;
  return /^\/#(?:home|bundles|history|account|wifi|voucher|checkout|receipt)(?:\?bundle=[a-z][a-z0-9-]{0,39})?$/.test(value) ? value : '/#account';
}
export function rememberRegistration(staff=false) {
  const path=staff?'/#staff':currentCustomerScreen();
  try { sessionStorage.setItem(storageKey,JSON.stringify({path:destination(path),expires:Date.now()+30*60*1000})); } catch {}
}
export async function startProductSignIn(staff:boolean,returnTo:string,reauthenticate=false,claimGuest=false, signup=false) {
  if(staff)sessionStorage.removeItem('pasofi-onesa-customer');
  const flow=await api<{authorizationUrl:string}>(staff?'/api/staff/onesa/start':'/api/onesa/start',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(staff ? (reauthenticate ? {reauthenticate:true} : {}) : {
      returnTo, ...(claimGuest ? {claimGuest:true} : {}), ...(signup ? {signup:true} : {}),
    }),
  });
  const target=new URL(flow.authorizationUrl);
  if(target.protocol!=='https:' || target.username || target.password)throw Error('Invalid sign-in destination');
  if(hotspotPortal && !staff &&
    (target.origin !== 'https://auth.onesa.eu' || target.pathname !== '/authorize' || target.hash)) {
    throw Error('Invalid hotspot sign-in destination');
  }
  if (hotspotPortal && !staff && reauthenticate) target.searchParams.set('prompt', 'login');
  const state = target.searchParams.get('state');
  if (!hotspotPortal && state && /^[A-Za-z0-9_-]{43}$/.test(state)) {
    sessionStorage.setItem('pasofi-onesa-flow:' + state, JSON.stringify({
      staff, returnTo: staff ? '/#staff' : destination(returnTo), expires: Date.now() + 300000,
    }));
  }
  // Older callback assets can still complete a customer sign-in during rollout.
  if(!staff && !hotspotPortal)sessionStorage.setItem('pasofi-onesa-customer','1');
  location.assign(target.href);
}
export function resumeRegistration() {
  if(location.pathname!=='/' || location.search!=='?registration=complete')return;
  let path=hotspotPortal ? '/connect' : '/#account', valid=false;
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
  void signInAvailable(staff)
    .then(available=>{if(available)return startProductSignIn(staff,path);})
    .catch(()=>{}); // The restored screen retains its ordinary sign-in and retry controls.
}
