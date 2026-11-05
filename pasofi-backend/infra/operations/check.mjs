#!/usr/bin/env node
// Read-only operator diagnostic. Never restarts services, changes a ledger,
// replays a charge/message, exposes row identifiers, or sends an alert itself.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname,isAbsolute} from 'node:path';
import {isIP} from 'node:net';

const expected=['postgres','identity','prepaid-access','network','notification','assistant','web','gateway','internal-gateway'];
const healthRequired=new Set(['postgres','identity','prepaid-access','network','notification','assistant','web']);
export function parseRecords(raw){
 const text=raw.trim();if(!text)return [];
 const result=text.startsWith('[')?JSON.parse(text):text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
 if(!Array.isArray(result)||result.some(row=>!row||typeof row!=='object'))throw Error('invalid_diagnostic_data');return result;
}
export function checkContainers(rows,{radiusBind}={}){
 if(radiusBind!==undefined&&(isIP(radiusBind)!==4||!(/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(radiusBind))))throw Error('RADIUS monitoring requires the exact private IPv4 tunnel bind');
 const problems=[],services=[];
 for(const service of [...expected,...(radiusBind?['radius','radius-api']:[])]){
  const matches=rows.filter(row=>row.Service===service);
  if(matches.length!==1){problems.push(`${service}:missing_or_duplicate`);continue;}
  const row=matches[0];services.push({service,state:row.State,health:row.Health||null});
  if(row.State!=='running'||((healthRequired.has(service)||service==='radius-api')&&row.Health!=='healthy'))problems.push(`${service}:not_ready`);
 }
 for(const row of rows){
  const published=(row.Publishers||[]).filter(port=>Number(port.PublishedPort)>0);
  const allowed=port=>row.Service==='gateway'&&port.Protocol==='tcp'&&[80,443].includes(Number(port.TargetPort))||
   radiusBind&&row.Service==='radius'&&port.Protocol==='udp'&&[1812,1813].includes(Number(port.TargetPort))&&Number(port.PublishedPort)===Number(port.TargetPort)&&port.URL===radiusBind;
  if(published.some(port=>!allowed(port)))problems.push(`${row.Service}:unexpected_published_port`);
  if(radiusBind&&row.Service==='radius'&&(published.length!==2||new Set(published.map(port=>Number(port.TargetPort))).size!==2||published.some(port=>!allowed(port))))problems.push('radius:private_binding_missing_or_invalid');
 }
 return {services,problems};
}

function monitorOrigin(value){
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();return url;}
 catch{throw Error('A credential-free HTTPS monitoring origin is required');}
}

// Read-only probes. Split deployments check Oracle's direct-access denial and
// the frontend's real same-origin API separately; no proxy credential is sent.
export async function checkHttpsOrigins({gatewayOrigin,frontendOrigin,fetcher=fetch}){
 const gateway=monitorOrigin(gatewayOrigin),frontend=frontendOrigin?monitorOrigin(frontendOrigin):gateway;
 const split=frontend.origin!==gateway.origin;
 const checks=split?[
  [gateway,'/health/live',[200]],
  [gateway,'/api/session',[403]],
  [gateway,'/internal/v1/session',[404]],
  [gateway,'/api/internal/v1/session',[403,404]],
  [frontend,'/api/session',[401]],
  [frontend,'/api/internal/v1/session',[404]],
 ]:[
  [gateway,'/health/live',[200]],
  [gateway,'/api/session',[401]],
  [gateway,'/internal/v1/session',[404]],
  [gateway,'/api/internal/v1/session',[404]],
 ];
 try{
  for(const [origin,path,statuses]of checks){
   const response=await fetcher(new URL(path,origin),{redirect:'error',signal:AbortSignal.timeout(5000)});
   try{
    // A static SPA/HTML fallback is not a successful API/privacy check.
    if(!statuses.includes(response.status)||response.headers.has('set-cookie')||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw Error();
   }finally{await response.body?.cancel();}
  }
  return {ok:true,split};
 }catch{return {ok:false,split,problem:'public_https:contract_unavailable'};}
}
export function checkBackup(rows,{now=Date.now()/1000,maxAgeHours=30}={}){
 const stanza=rows.find(row=>row.name==='pamofi');
 if(!stanza||stanza.status?.code!==0||!Array.isArray(stanza.backup))return {ok:false,problem:'backup:repository_unavailable_or_empty'};
 const successful=stanza.backup.filter(item=>item.error!==true&&Number.isFinite(item.timestamp?.stop));
 const latest=Math.max(0,...successful.map(item=>item.timestamp.stop)),ageSeconds=now-latest;
 if(!latest||ageSeconds< -60||ageSeconds>maxAgeHours*3600)return {ok:false,problem:'backup:missing_stale_or_future_timestamp'};
 return {ok:true,latestCompletedAt:new Date(latest*1000).toISOString(),ageSeconds:Math.max(0,Math.floor(ageSeconds))};
}

// Each query runs as that service's existing runtime role, in its own database.
// No customer identity, phone number, voucher, key, provider payload or DSN leaves
// the container. Read-only transactions and a statement timeout are mandatory.
export const queueQueries={
 'prepaid-access':`SELECT
  (SELECT count(*)::int FROM event_outbox WHERE status='dead') AS outbox_dead,
  (SELECT count(*)::int FROM event_outbox WHERE status='pending' AND next_at<now()-interval '5 minutes') AS outbox_delayed,
  (SELECT count(*)::int FROM payment_reconciliation_jobs WHERE state='dead') AS payment_verification_dead,
  (SELECT count(*)::int FROM provider_payment_attempts WHERE state IN ('unknown','review')) AS payment_review,
  (SELECT count(*)::int FROM network_account_holds) AS account_holds,
  (SELECT count(*)::int FROM access_grants WHERE state='uncertain' OR (state IN ('pending','active') AND COALESCE(last_accounting_at,issued_at)<now()-interval '3 minutes')) AS network_review`,
 notification:`SELECT
  (SELECT count(*)::int FROM delivery_jobs WHERE state='unknown') AS sms_ambiguous,
  (SELECT count(*)::int FROM delivery_jobs WHERE state='failed') AS sms_failed,
  (SELECT count(*)::int FROM delivery_jobs WHERE state IN ('awaiting_delivery_details','ready','submitted') AND next_at<now()-interval '5 minutes') AS sms_delayed,
  (SELECT count(*)::int FROM invoice_jobs WHERE state='unknown') AS invoice_ambiguous,
  (SELECT count(*)::int FROM invoice_jobs WHERE state='failed') AS invoice_failed,
  (SELECT count(*)::int FROM invoice_jobs WHERE state IN ('queued','submitting','submitted') AND created_at<now()-interval '15 minutes') AS invoice_delayed`,
 network:`SELECT
  (SELECT count(*)::int FROM router_reconciliation_status WHERE result='unavailable') AS router_unavailable,
  (SELECT count(*)::int FROM router_reconciliation_status WHERE result='present') AS router_absence_unconfirmed`
};

export function aggregateProgram(query){return `
 import fs from 'node:fs';import pg from 'pg';
 const client=new pg.Client({connectionString:fs.readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim(),connectionTimeoutMillis:3000,statement_timeout:3000});
 client.on('error',()=>{});
 try{await client.connect();await client.query('BEGIN READ ONLY');const result=await client.query(${JSON.stringify(query)});await client.query('ROLLBACK');process.stdout.write(JSON.stringify(result.rows[0]));}
 catch{process.stderr.write('aggregate_check_unavailable');process.exitCode=1;}finally{await client.end().catch(()=>{});}
 `;}

async function main(){
 const args=process.argv.slice(2);if(args.some(arg=>!['--with-backups','--queues'].includes(arg)))throw Error('Usage: node check.mjs [--with-backups] [--queues]');
 const backup=args.includes('--with-backups'),queues=args.includes('--queues');
 const cwd=resolve(dirname(fileURLToPath(import.meta.url)),'../production');
 const file=process.env.PAMOFI_OPERATIONS_COMPOSE_FILE,project=process.env.PAMOFI_OPERATIONS_PROJECT;
 if(file&&!isAbsolute(file))throw Error('PAMOFI_OPERATIONS_COMPOSE_FILE must be an absolute rendered configuration path');
 if(project&&!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))throw Error('Invalid PAMOFI_OPERATIONS_PROJECT');
 const compose=['compose',...(project?['--project-name',project]:[]),'-f',file||'compose.yaml',...(backup&&!file?['-f','../backup-production/compose.yaml']:[])];
 function docker(command,timeout=15000){
  const result=spawnSync('docker',[...compose,...command],{cwd,encoding:'utf8',timeout,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error('docker_diagnostic_unavailable');return result.stdout;
 }
 const report={checkedAt:new Date().toISOString(),...checkContainers(parseRecords(docker(['ps','--all','--format','json'])),{radiusBind:process.env.PAMOFI_OPERATIONS_RADIUS_BIND||undefined}),publicHttps:false,queues:queues?{}:'not_checked',backup:backup?{}:'not_checked'};
 const https=await checkHttpsOrigins({gatewayOrigin:process.env.PAMOFI_MONITOR_ORIGIN||`https://${process.env.PAMOFI_PUBLIC_HOST||''}`,frontendOrigin:process.env.PAMOFI_MONITOR_FRONTEND_ORIGIN});
 report.publicHttps=https.ok;report.splitFrontend=https.split;if(!https.ok)report.problems.push(https.problem);
 if(queues)for(const [service,query]of Object.entries(queueQueries)){
  try{const result=JSON.parse(docker(['exec','-T',service,'node','--input-type=module','-e',aggregateProgram(query)]));
   if(!result||Object.values(result).some(value=>!Number.isSafeInteger(value)||value<0))throw Error();
   report.queues[service]=result;
   for(const [name,count]of Object.entries(result))if(count>0)report.problems.push(`${service}:${name}:${count}`);
  }catch{report.problems.push(`${service}:aggregate_unavailable`);}
 }
 if(backup){
  try{
   const maxAgeHours=Number(process.env.PAMOFI_BACKUP_MAX_AGE_HOURS||30);if(!Number.isFinite(maxAgeHours)||maxAgeHours<1||maxAgeHours>168)throw Error();
   report.backup=checkBackup(parseRecords(docker(['exec','-T','--user','postgres','postgres','pgbackrest','--stanza=pamofi','--output=json','info'],45000)),{maxAgeHours});
   if(!report.backup.ok)report.problems.push(report.backup.problem);
  }catch{report.problems.push('backup:check_unavailable');}
 }
 console.log(JSON.stringify({...report,ok:report.problems.length===0},null,2));if(report.problems.length)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({ok:false,error:error instanceof Error?error.message:'diagnostic_unavailable'}));process.exitCode=1;});
