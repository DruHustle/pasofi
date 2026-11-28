import {SignJWT} from 'jose';
import type {FastifyRequest} from 'fastify';

async function boundedJson(response:Response):Promise<Record<string,unknown>> {
 if(!response.body)throw Error('identity_unavailable');
 const chunks:Buffer[]=[];let size=0;
 for await(const part of response.body as unknown as AsyncIterable<Uint8Array>){
  size+=part.length;if(size>16384)throw Error('identity_unavailable');chunks.push(Buffer.from(part));
 }
 const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}

export async function identityStaff(request:Pick<FastifyRequest,'headers'>,demo:boolean,path='/internal/v1/staff/session',scope='staff:resolve') {
 const secret=process.env.INTERNAL_IDENTITY_SECRET,base=process.env.IDENTITY_URL;
 if(!secret||Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_'))||!base)throw Error('identity_unavailable');
 const target=new URL(base);
 if(target.username||target.password||target.search||target.hash||target.pathname!=='/'||(!demo&&target.protocol!=='https:')||(demo&&!['http:','https:'].includes(target.protocol)))throw Error('identity_unavailable');
 const token=await new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('identity').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
 const response=await fetch(new URL(path,target),{headers:{authorization:'Bearer '+token,cookie:request.headers.cookie??''},signal:AbortSignal.timeout(2000),redirect:'error'});
 if(response.status===401||response.status===403||response.status===404)return {status:response.status,data:null};
 if(!response.ok)throw Error('identity_unavailable');
 return {status:200,data:await boundedJson(response)};
}
