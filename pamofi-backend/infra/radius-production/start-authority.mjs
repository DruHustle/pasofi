import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

export async function loadEnvironment(env){
  if(env.APP_ENV!=='production'||env.NODE_ENV!=='production'||env.PAMOFI_RADIUS_QUALIFIED!=='true')throw Error('Explicit production qualification required');
  const value=async name=>{if(env[name]||!env[`${name}_FILE`])throw Error('Use only protected secret files');const text=(await readFile(env[`${name}_FILE`],'utf8')).replace(/\r?\n$/,'');if(!text||text.length>65536||/[\x00\r\n]/.test(text))throw Error('Invalid secret file');return text;};
  const prefix=env.PAMOFI_ROLE_PREFIX||'pamofi';if(!/^[a-z][a-z0-9_]{0,24}$/.test(prefix))throw Error('Invalid role prefix');
  const database=new URL(await value('DATABASE_URL'));
  if(!['postgres:','postgresql:'].includes(database.protocol)||database.username!==`${prefix}_network_runtime`||database.pathname!==`/${prefix}_network`||!database.password||database.search||database.hash)throw Error('Use the network runtime database role only');
  const secret=await value('INTERNAL_NETWORK_SECRET');if(!/^[a-f0-9]{64}$/.test(secret))throw Error('Invalid network service secret');
  const fingerprint=await value('RADIUS_CLIENT_FINGERPRINT');if(!/^[a-f0-9]{64}$/.test(fingerprint))throw Error('Invalid RADIUS client fingerprint');
  if(!env.RADIUS_CA_FILE||!env.RADIUS_SERVER_CERT_FILE||!env.RADIUS_SERVER_KEY_FILE||!env.NODE_EXTRA_CA_CERTS)throw Error('TLS trust and server identity are required');
  const upstream=new URL(env.PREPAID_URL||'');if(upstream.protocol!=='https:'||upstream.username||upstream.password||upstream.pathname!=='/'||upstream.search||upstream.hash)throw Error('A private HTTPS ledger origin is required');
  return {DATABASE_URL:database.toString(),INTERNAL_NETWORK_SECRET:secret,RADIUS_CLIENT_FINGERPRINT:fingerprint};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  loadEnvironment(process.env).then(async values=>{Object.assign(process.env,values);delete process.env.PGOPTIONS;await import(pathToFileURL(resolve('dist/radius-server.js')).href);}).catch(()=>{console.error('Production RADIUS authority refused startup; check qualification, protected runtime credentials and TLS configuration.');process.exitCode=1;});
}
