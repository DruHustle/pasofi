// Transport-only fixture. It has no database, ledger, customer or provider access.
import {createServer} from 'node:https';
import {readFileSync,appendFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
if(process.env.PAMOFI_RADIUS_TRANSPORT_LAB!=='disposable-fixture')throw Error('Lab fixture is disabled');
const expected=Buffer.from(readFileSync('/run/secrets/radius_client_fingerprint','utf8').trim(),'hex');
const record=event=>appendFileSync('/lab-events/events.jsonl',JSON.stringify(event)+'\n');
const server=createServer({key:readFileSync('/run/secrets/radius_server_key'),cert:readFileSync('/run/secrets/radius_server_cert'),ca:readFileSync('/run/secrets/radius_ca'),requestCert:true,rejectUnauthorized:true},(request,response)=>{
  const fingerprint=request.socket.getPeerCertificate().fingerprint256?.replaceAll(':','').toLowerCase();
  if(!request.socket.authorized||!fingerprint||!timingSafeEqual(Buffer.from(fingerprint,'hex'),expected)){record({result:'pin-rejected'});response.writeHead(401,{'content-type':'application/json'});response.end('{"error":"rejected"}');return;}
  let body='',length=0;
  request.on('data',chunk=>{length+=chunk.length;if(length>16384)request.destroy();else body+=chunk;});
  request.on('end',()=>{
    let payload;try{payload=JSON.parse(body);}catch{response.writeHead(400);response.end();return;}
    const name=request.headers['x-pamofi-nas'];
    record({result:'received',nas:name,path:request.url});
    if(name!=='nas_a'){response.writeHead(401,{'content-type':'application/json'});response.end('{"error":"rejected"}');return;}
    if(request.method==='POST'&&request.url==='/radius/authorize'&&payload['User-Name']?.value?.[0]==='fixture_user_123456'&&payload['User-Password']?.value?.[0]==='fixture_password_32_characters_safe'){
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({'reply:Session-Timeout':60,'reply:Mikrotik-Total-Limit':1000000}));return;
    }
    if(request.method==='POST'&&request.url==='/radius/accounting'){
      response.writeHead(204);response.end();return;
    }
    response.writeHead(401,{'content-type':'application/json'});response.end('{"error":"rejected"}');
  });
});
server.on('tlsClientError',()=>record({result:'tls-rejected'}));
server.listen(3443,'0.0.0.0');
