import {useState} from 'react';
import {App} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
import {Capacitor,type PluginListenerHandle} from '@capacitor/core';
import type {CustomerTab} from './CustomerAccess';
import {nativePlatform} from './native-oidc-ui';
import {isCustomerDestination} from './native-oidc';
import {registerWithAppleBrowser} from './native-api';

const returnUrl='com.onesa.pasofi.identity://login/registered';
const key='pasofi.native.registration';
const lifetime=30*60*1000;
const appleReturn=new EventTarget();
export type RegistrationReturn={tab:CustomerTab;audience:'user'|'admin'};

export async function watchRegistrationReturn(onReturn:(value:RegistrationReturn)=>void) {
  const platform=nativePlatform();
  if(!platform)return ()=>{};
  let active=true;
  async function receive(url:string) {
    if(!active || url!==returnUrl)return;
    try {
      const raw=localStorage.getItem(key);
      localStorage.removeItem(key);
      if(!raw)return;
      const pending=JSON.parse(raw);
      const audience=pending.audience ?? 'user';
      const now=Date.now();
      if(!isCustomerDestination(pending.tab) || !['user','admin'].includes(audience) ||
         !Number.isSafeInteger(pending.expires) || pending.expires<now || pending.expires>now+lifetime)return;
      if(platform==='android')await Browser.close().catch(()=>{});
      if(active)onReturn({tab:pending.tab,audience});
    } catch {}
  }
  const appleListener=(event:Event)=>{void receive((event as CustomEvent<string>).detail);};
  if(platform==='ios')appleReturn.addEventListener('registered',appleListener);
  let listener:PluginListenerHandle|undefined;
  try {
    if(Capacitor.isPluginAvailable('App')){
      listener=await App.addListener('appUrlOpen',event=>{void receive(event.url);});
      const launch=await App.getLaunchUrl();
      if(launch)void receive(launch.url);
    }
  } catch {
    await listener?.remove().catch(()=>{});
    listener=undefined;
  }
  return ()=>{
    active=false;
    if(platform==='ios')appleReturn.removeEventListener('registered',appleListener);
    void listener?.remove().catch(()=>{});
  };
}

function RegistrationChoice({tab,audience}:{tab:CustomerTab;audience:'user'|'admin'}) {
  const platform=nativePlatform();
  const [failed,setFailed]=useState(false);
  const href='https://account.onesa.eu/register?audience='+audience+'&product=pasofi&platform='+(platform??'web');
  return <><a href={href} onClick={event=>{
    if(!platform)return;
    event.preventDefault();
    try {
      localStorage.setItem(key,JSON.stringify({tab,audience,expires:Date.now()+lifetime}));
      setFailed(false);
      // On iOS use the same cookie-sharing authentication session as sign-in.
      const opening=platform==='ios'
        ? registerWithAppleBrowser(audience).then(url=>{appleReturn.dispatchEvent(new CustomEvent('registered',{detail:url}));})
        : Browser.open({url:href});
      void opening.catch(()=>setFailed(true));
    } catch {setFailed(true);}
  }}>{audience==='admin'?'Request administrator access':'Register an Onesa account'}</a>{failed&&<span role="status">Registration could not open. Please try again.</span>}</>;
}

export default function RegistrationLink({tab}:{tab:CustomerTab}) {
  return <><RegistrationChoice tab={tab} audience="user"/> · <RegistrationChoice tab={tab} audience="admin"/></>;
}
