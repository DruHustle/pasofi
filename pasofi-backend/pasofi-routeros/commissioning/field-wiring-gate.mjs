#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {validateTargetTopology} from './topology.mjs';
import {validateBaseline} from './baseline.mjs';

// Run before prepare.mjs with a private device baseline and plan. It checks
// wiring intent only and never accesses a router or emits secrets.
export function validateCurrentSiteWiring(siteLabel,topology,baselineInput,commissioningPlan){
 validateTargetTopology(topology);
 if(siteLabel!=='K0'&&siteLabel!=='G0')throw Error('site_must_be_current_K0_or_G0');
 const selected=topology.sites.find(s=>s.gateway.label===siteLabel);
 if(!selected)throw Error('site_not_in_topology');
 const baseline=validateBaseline(baselineInput);
 // G0 ether2 currently carries a CPE through the management bridge, while the
 // only enabled HotSpot is on a separate inactive pilot bridge. Neither the
 // remote endpoint of CPE1 nor the second live ether4 device has been proven.
 // An interface-name match must NEVER approve this path as a customer bridge.
 // Commission a separately inspected VLAN/guest bridge with management
 // recovery, then update this gate from verified live acceptance evidence.
 if(siteLabel==='G0')throw Error('g0_current_cpe1_transit_on_management_bridge_not_qualified_for_guest_hotspot');
 const expected=['ether2','ether3','ether4'];
 if(baseline.router.wanPort!=='ether1')throw Error('actual_WAN_must_be_reconciled_before_using_port_contract');
 const interfaces=commissioningPlan?.customer?.interfaces;
 if(!Array.isArray(interfaces)||interfaces.length!==expected.length||new Set(interfaces).size!==expected.length||
   expected.some(port=>!interfaces.includes(port)))throw Error('guest_interfaces_do_not_match_current_wiring');
 const protectedInterfaces=[baseline.router.wanPort,baseline.router.managementBridge,baseline.router.cpeTransitPort,baseline.router.recoveryPort];
 if(interfaces.some(port=>protectedInterfaces.includes(port)))throw Error('guest_interface_overlaps_protected_path');
 if(siteLabel==='K0'&&selected.ports[3].present!==false)throw Error('K0_LAN4_must_be_empty');
 if(siteLabel==='G0'&&selected.plannedTopology?.status!=='proposed-not-installed')throw Error('G0_future_not_installed');
 return {status:'plan-review-only',siteLabel,expectedGuestInterfaces:expected,routerChangesPerformed:false,physicalAcceptance:false,paymentActivation:false};
}

const self=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(self){
 const [label,privateBaselinePath,privatePlanPath,...extra]=process.argv.slice(2);
 if(extra.length||!label||!privateBaselinePath||!privatePlanPath){
  console.error('Usage: node field-wiring-gate.mjs K0|G0 PRIVATE_BASELINE.json PRIVATE_PLAN.json');process.exitCode=2;
 }else{
  try{
   const read=path=>JSON.parse(readFileSync(path,'utf8'));
   const topology=read(new URL('./topology.target.json',import.meta.url));
   const result=validateCurrentSiteWiring(label,topology,read(privateBaselinePath),read(privatePlanPath));
   process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){console.error('Field wiring preflight failed: '+error.message);process.exitCode=1;}
 }
}
