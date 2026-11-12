import {useEffect,useRef,useState} from 'react';
import {Capacitor,registerPlugin} from '@capacitor/core';

export type StripePayment={provider:'stripe';clientSecret:string;publishableKey:string;testMode:boolean;
 merchantCountryCode:string;merchantDisplayName:string;applePayMerchantId:string|null;googlePay:boolean};
export type StripeCheckoutProps={payment:StripePayment;owner:string;amount:string;disabled:boolean;
 verify:()=>Promise<string>;onBusy:(busy:boolean)=>void;onSubmitted:()=>Promise<void>};
type WalletOptions=Omit<StripePayment,'provider'|'clientSecret'|'merchantDisplayName'>;
const native=registerPlugin<{availability:(options:WalletOptions)=>Promise<{applePay:boolean;googlePay:boolean}>;
 present:(options:Omit<StripePayment,'provider'>)=>Promise<{status:'completed'|'cancelled'|'failed'}>}>('PasoFiStripe');

export default function StripeCheckout({payment,owner,amount,disabled,verify,onBusy,onSubmitted}:StripeCheckoutProps){
 const mounted=useRef(false),generation=useRef(0),operation=useRef<object|null>(null);
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [wallet,setWallet]=useState('');
 useEffect(()=>{
  mounted.current=true;generation.current+=1;let current=true;setReady(false);setMessage('');setWallet('');
  if(!Capacitor.isNativePlatform()||!Capacitor.isPluginAvailable('PasoFiStripe'))setMessage('Secure app payments are available in the installed PasoFi app. Your saved order is unchanged.');
  else{
   const {publishableKey,testMode,merchantCountryCode,applePayMerchantId,googlePay}=payment;
   void native.availability({publishableKey,testMode,merchantCountryCode,applePayMerchantId,googlePay}).then(result=>{
    if(current){setWallet(result.applePay?'Apple Pay':result.googlePay?'Google Pay':'');setReady(true);}
   }).catch(()=>{if(current)setMessage('Secure payment options are unavailable. Retry this saved checkout.');});
  }
  return()=>{current=false;mounted.current=false;};
 },[payment.clientSecret,payment.publishableKey,payment.testMode,payment.merchantCountryCode,payment.merchantDisplayName,payment.applePayMerchantId,payment.googlePay,owner]);
 async function pay(){
  if(operation.current||busy||disabled||!ready)return;
  const revision=generation.current,token={};operation.current=token;
  const current=()=>mounted.current&&generation.current===revision;
  const {provider:_,...options}=payment;
  setBusy(true);onBusy(true);setMessage('');
  try{
   const id=await verify();if(!current()||id!==owner)return;
   const result=await native.present(options);
   if(!current())return;
   if(result.status==='cancelled'){setMessage('Payment cancelled. You can retry the same saved checkout.');return;}
   if(result.status!=='completed'){setMessage('Payment was not completed. Check the saved order before trying again.');return;}
   setMessage('Payment submitted. Checking the verified order status…');await onSubmitted();
  }catch{if(current())setMessage('The payment response could not be confirmed. Check the saved order before trying again.');}
  finally{if(operation.current===token){operation.current=null;if(mounted.current)setBusy(false);onBusy(false);}}
 }
 return <section className="form-grid stripe-checkout" aria-label="Secure app payment">
  <h4>Pay securely{wallet?` with ${wallet} or card`:' by card'}</h4>
  {payment.testMode&&<p role="status">Stripe test payment · no real money is collected.</p>}
  <button className="primary" disabled={busy||disabled||!ready} onClick={pay}>{busy?'Confirming payment…':`Pay ${amount}`}</button>
  {message&&<p role="status">{message}</p>}
 </section>;
}
