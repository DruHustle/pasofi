import {useEffect,useRef,useState} from 'react';
import {loadStripe} from '@stripe/stripe-js/pure';
import type {Stripe,StripeElements,StripePaymentElement} from '@stripe/stripe-js';

export type StripePayment={provider:'stripe';clientSecret:string;publishableKey:string;testMode:boolean;
 merchantCountryCode:string;merchantDisplayName:string;applePayMerchantId:string|null;googlePay:boolean};
export type StripeCheckoutProps={payment:StripePayment;owner:string;amount:string;disabled:boolean;
 verify:()=>Promise<string>;onBusy:(busy:boolean)=>void;onSubmitted:()=>Promise<void>};

export default function StripeCheckout({payment,owner,amount,disabled,verify,onBusy,onSubmitted}:StripeCheckoutProps){
 const host=useRef<HTMLDivElement>(null),mounted=useRef(false),generation=useRef(0),operation=useRef<object|null>(null);
 const stripe=useRef<Stripe|null>(null),elements=useRef<StripeElements|null>(null);
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{
  mounted.current=true;generation.current+=1;let current=true,element:StripePaymentElement|undefined;
  setReady(false);setMessage('');
  void loadStripe(payment.publishableKey).then(client=>{
   if(!current||!host.current)return;
   if(!client)throw Error('stripe_unavailable');
   stripe.current=client;
   elements.current=client.elements({clientSecret:payment.clientSecret,appearance:{theme:'stripe',variables:{colorPrimary:'#146e60'}}});
   element=elements.current.create('payment',{layout:'tabs',wallets:{applePay:'never',googlePay:'never',link:'never'}});
   element.on('ready',()=>{if(current)setReady(true);});
   element.on('loaderror',()=>{if(current)setMessage('The secure card form could not load. Retry this saved checkout.');});
   element.mount(host.current);
  }).catch(()=>{if(current)setMessage('The secure card form is unavailable. Retry this saved checkout.');});
  return()=>{current=false;mounted.current=false;element?.destroy();elements.current=null;stripe.current=null;};
 },[payment.clientSecret,payment.publishableKey,owner]);
 async function pay(event:React.FormEvent){
  event.preventDefault();if(operation.current||busy||disabled||!ready||!stripe.current||!elements.current)return;
  const revision=generation.current,client=stripe.current,form=elements.current,token={};operation.current=token;
  const current=()=>mounted.current&&generation.current===revision;
  setBusy(true);onBusy(true);setMessage('');
  try{
   const id=await verify();if(!current()||id!==owner)return;
   // Stripe's iframe owns card collection and 3DS. No card data reaches Pasofi.
   // Client completion never grants access; read the authoritative order next.
   const result=await client.confirmPayment({elements:form,redirect:'if_required'});
   if(!current())return;
   if(result.error){setMessage(result.error.type==='card_error'||result.error.type==='validation_error'
    ?result.error.message??'The card payment was not completed. Please check the secure form.'
    :'The payment response could not be confirmed. Check the saved order before trying again.');return;}
   setMessage('Payment submitted. Checking the verified order status…');
   await onSubmitted();
  }catch{if(current())setMessage('The payment response could not be confirmed. Check the saved order before trying again.');}
  finally{if(operation.current===token){operation.current=null;if(mounted.current)setBusy(false);onBusy(false);}}
 }
 return <form className="form-grid stripe-checkout" onSubmit={pay} aria-label="Secure card payment">
  <h4>Pay securely by card</h4>{payment.testMode&&<p role="status">Stripe test payment · no real money is collected.</p>}
  <div ref={host}/>{!ready&&!message&&<p role="status">Loading secure card form…</p>}
  <button className="primary" disabled={busy||disabled||!ready}>{busy?'Confirming payment…':`Pay ${amount}`}</button>
  {message&&<p role="status">{message}</p>}
 </form>;
}
