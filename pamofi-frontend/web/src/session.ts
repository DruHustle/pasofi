// This short-lived secret is a credential for retrying initial session creation.
// Keep it only in this tab until the cookie is confirmed; never put it in a URL.
const storageKey='pamofi.sessionCreationRetry';
function retryKey(): string {
 const existing=sessionStorage.getItem(storageKey);
 if(existing){
  if(!/^[A-Za-z0-9_-]{43}$/.test(existing))throw Error('invalid_retry_key');
  return existing;
 }
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 const value=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 sessionStorage.setItem(storageKey,value);
 return value;
}
export async function ensureSession(): Promise<void> {
 const current=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'});
 if(current.ok){sessionStorage.removeItem(storageKey);return;}
 if(current.status!==401)throw Error('identity_unavailable');
 const response=await fetch('/api/session',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Idempotency-Key':retryKey()}});
 if(!response.ok)throw Error('identity_unavailable');
 // Browsers may reject a Set-Cookie even when the POST itself succeeded. Do
 // not discard the retry credential until the server sees the cookie again.
 const confirmed=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'});
 if(!confirmed.ok)throw Error('identity_unavailable');
 sessionStorage.removeItem(storageKey);
}
