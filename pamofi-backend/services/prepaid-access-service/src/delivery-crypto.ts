import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
export type DeliveryKeys=Buffer|{activeId:string;keys:Record<string,Buffer>};
export function keyId(keys:DeliveryKeys){return Buffer.isBuffer(keys)?'legacy':keys.activeId;}
function material(keys:DeliveryKeys,id:string){const value=Buffer.isBuffer(keys)?(id==='legacy'?keys:undefined):keys.keys[id];if(!value||value.length!==32)throw Error('delivery_key_unavailable');return value;}
export function loadDeliveryKeys():DeliveryKeys|null {
 try {
  const activeId=process.env.VOUCHER_DELIVERY_ACTIVE_KEY_ID;if(!activeId||!/^[A-Za-z0-9_-]{1,32}$/.test(activeId))return null;
  const raw:unknown=JSON.parse(process.env.VOUCHER_DELIVERY_KEYS_JSON??'{}');if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const keys:Record<string,Buffer>=Object.create(null);for(const [id,value] of Object.entries(raw)){if(!/^[A-Za-z0-9_-]{1,32}$/.test(id)||typeof value!=='string')return null;const b=Buffer.from(value,'base64');if(b.length!==32)return null;keys[id]=b;}
  if(!keys[activeId])return null;return {activeId,keys};
 }catch{return null;}
}
export function seal(value:string,keys:DeliveryKeys,aad:string){const id=keyId(keys),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',material(keys,id),iv);cipher.setAAD(Buffer.from(aad));return {keyId:id,iv,cipher:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]),tag:cipher.getAuthTag()};}
export function unseal(value:{keyId:string;iv:Buffer;cipher:Buffer;tag:Buffer},keys:DeliveryKeys,aad:string){const cipher=createDecipheriv('aes-256-gcm',material(keys,value.keyId),value.iv);cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(value.tag);return Buffer.concat([cipher.update(value.cipher),cipher.final()]).toString('utf8');}
