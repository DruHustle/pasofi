// Synthetic HTTPS NAS endpoint. No real RouterOS credentials or state.
import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
if(process.env.PAMOFI_RADIUS_TRANSPORT_LAB!=='disposable-fixture')throw Error('Lab fixture is disabled');
createServer({key:readFileSync('/run/secrets/nas_server_key'),cert:readFileSync('/run/secrets/nas_server_cert')},(request,response)=>{
  const source=request.socket.remoteAddress?.replace(/^::ffff:/,'');
  const allowed=source===process.env.EXPECTED_CONTROL_SOURCE&&request.headers['x-pamofi-lab']==='disposable-fixture'&&request.method==='GET'&&request.url==='/rest/system/resource';
  response.writeHead(allowed?200:403,{'content-type':'application/json'});
  response.end(JSON.stringify({source,fixture:'disposable-nas'}));
}).listen(443,'0.0.0.0');
