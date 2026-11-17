import {useState} from 'react';
import {App} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
import {Capacitor} from '@capacitor/core';
import type {CustomerTab} from './CustomerAccess';
import {nativePlatform} from './native-oidc-ui';
import {isCustomerDestination} from './native-oidc';

const returnUrl='com.onesa.pasofi.identity://login/registered';
const key='pasofi.native.registration';

export async function watchRegistrationReturn(onReturn:(tab:CustomerTab)=>void) {
  if(!nativePlatform() || !Capacitor.isPluginAvailable('App'))return ()=>{};
  let active=true;
  async function receive(url:string) {
    if(!active || url!==returnUrl)return;
    try {
      const raw=localStorage.getItem(key);
      localStorage.removeItem(key);
      if(!raw)return;
      const pending=JSON.parse(raw);
      if(!isCustomerDestination(pending.tab) || !Number.isFinite(pending.expires) || pending.expires<Date.now())return;
      await Browser.close().catch(()=>{});
      if(active)onReturn(pending.tab);
    } catch {}
  }
  const listener=await App.addListener('appUrlOpen',event=>{void receive(event.url);});
  try {
    const launch=await App.getLaunchUrl();
    if(launch)void receive(launch.url);
  } catch { active=false;await listener.remove().catch(()=>{});return ()=>{}; }
  return ()=>{active=false;void listener.remove();};
}

function RegistrationChoice({tab,audience}:{tab:CustomerTab;audience:'user'|'admin'}) {
  const platform=nativePlatform();
  const [failed,setFailed]=useState(false);
  const href='https://auth.onesa.eu/register?audience='+audience+'&product=pasofi&platform='+(platform??'web');
  return <><a href={href} onClick={event=>{
    if(!platform)return;
    event.preventDefault();
    try {
      localStorage.setItem(key,JSON.stringify({tab,expires:Date.now()+30*60*1000}));
      setFailed(false);
      void Browser.open({url:href}).catch(()=>setFailed(true));
    } catch {setFailed(true);}
  }}>{audience==='admin'?'Request administrator access':'Register an Onesa account'}</a>{failed&&<span role="status">Registration could not open. Please try again.</span>}</>;
}

export default function RegistrationLink({tab}:{tab:CustomerTab}) {
  return <><RegistrationChoice tab={tab} audience="user"/> · <RegistrationChoice tab={tab} audience="admin"/></>;
}
