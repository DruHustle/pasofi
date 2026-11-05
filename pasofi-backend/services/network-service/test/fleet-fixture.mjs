import https from 'node:https';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validateFleetRows} from '../dist/fleet-routeros.js';

export async function fleetFixture(nasId='11111111-1111-4111-8111-111111111111'){
 const dir=mkdtempSync(join(tmpdir(),'pasofi-fleet-')),file=name=>join(dir,name);
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',file('key'),'-out',file('cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
 const state={serial:'TEST-SERIAL-123',identity:'PasoFi test',model:'hAP lite',version:'7.25.1',comment:'Customer access point',ssid:'PasoFi',wifiSsid:'PasoFi modern',disabled:false,rate:'5M/5M',idle:'5m',keepalive:'2m',mode:'normal',pending:null,pendingCompletion:null,cancelPending:null,requests:[],writes:0};
 const server=https.createServer({key:readFileSync(file('key')),cert:readFileSync(file('cert'))},async(request,response)=>{
  const path=new URL(request.url,'https://router.invalid');
  const entry={method:request.method,path:path.pathname,query:Object.fromEntries(path.searchParams),authorization:request.headers.authorization,body:null};state.requests.push(entry);
  // The supported RouterOS contract serializes this account's commands.
  // A later GET cannot overtake an abandoned but still executing setter.
  if(state.pendingCompletion)await state.pendingCompletion;
  response.setHeader('content-type','application/json');
  if(state.mode==='redirect'){response.writeHead(302,{location:'https://public.example/'});response.end();return;}
  if(state.mode==='oversize'){response.end(JSON.stringify({data:'x'.repeat(300000)}));return;}
  if(request.method!=='GET'){
   let data='';for await(const chunk of request)data+=chunk;entry.body=JSON.parse(data);state.writes++;
   const mutate=()=>{
    switch(path.pathname){
     case '/rest/system/identity/set':state.identity=entry.body.name;break;
     case '/rest/interface/*A':state.comment=entry.body.comment;break;
     case '/rest/interface/wireless/*B':state.ssid=entry.body.ssid;state.disabled=entry.body.disabled;break;
     case '/rest/interface/wifi/*C':state.wifiSsid=entry.body['configuration.ssid'];state.disabled=entry.body.disabled;break;
     case '/rest/ip/hotspot/user/profile/*D':state.rate=entry.body['rate-limit'];state.idle=entry.body['idle-timeout'];state.keepalive=entry.body['keepalive-timeout'];break;
     default:throw Error('Unexpected mutating fixture path');
    }
   };
   if(state.mode==='late'){
    let complete,settled=false,timer;
    state.pendingCompletion=new Promise(resolve=>{complete=resolve;});
    const settle=apply=>{
     if(settled)return;settled=true;clearTimeout(timer);if(apply)mutate();
     state.pending=null;state.pendingCompletion=null;state.cancelPending=null;complete();
    };
    // Tests complete this promptly within the real 60-second upper bound;
    // retaining the bound here prevents an impossible infinitely late write.
    timer=setTimeout(()=>settle(false),60000);timer.unref();
    state.pending=()=>settle(true);state.cancelPending=()=>settle(false);request.socket.destroy();return;
   }
   if(state.mode==='drop-before'){request.socket.destroy();return;}
   if(state.mode!=='ignore')mutate();
   if(state.mode==='drop-after'){request.socket.destroy();return;}
   response.end('{}');return;
  }
  let value;
  switch(path.pathname){
   case '/rest/system/routerboard':value={'serial-number':state.serial,model:state.model};break;
   case '/rest/system/identity':value={name:state.identity};break;
   case '/rest/system/resource':value={version:state.version,'board-name':state.model};break;
   case '/rest/interface':value=[{'.id':'*A',name:'customer-ap',comment:state.comment}];break;
   case '/rest/interface/wireless':value=[{'.id':'*B',name:'wlan1',ssid:state.ssid,disabled:String(state.disabled)}];break;
   case '/rest/interface/wifi':value=[{'.id':'*C',name:'wifi1','configuration.ssid':state.wifiSsid,disabled:String(state.disabled)}];break;
   case '/rest/ip/hotspot/user/profile':value=[{'.id':'*D',name:'pasofi-customer','rate-limit':state.rate,'idle-timeout':state.idle,'keepalive-timeout':state.keepalive}];break;
   default:response.writeHead(404);response.end('{}');return;
  }
  if(state.mode==='foreign'&&Array.isArray(value))value[0].name='management';
  if(state.mode==='bad-id'&&Array.isArray(value))value[0]['.id']='*A/../../system/reset';
  response.end(JSON.stringify(value));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const row={nasId,url:`https://127.0.0.1:${server.address().port}/rest/`,username:'fleet-operator',password:'fixture-password-not-production',caFile:file('cert'),expectedSerial:state.serial,allowWrites:true,targets:[{key:'identity',kind:'identity'},{key:'ap-comment',kind:'interface',name:'customer-ap'},{key:'customer-radio',kind:'wireless',name:'wlan1'},{key:'modern-radio',kind:'wifi',name:'wifi1'},{key:'customer-profile',kind:'hotspot-profile',name:'pasofi-customer'}]};
 const config=validateFleetRows([row],true)[0],registry=file('fleet.json');
 writeFileSync(registry,JSON.stringify([row]),{mode:0o600});
 return {dir,file,registry,row,config,state,async close(){state.cancelPending?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}};
}
