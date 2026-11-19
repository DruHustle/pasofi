import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateCurrentSiteWiring} from './field-wiring-gate.mjs';
const topology=JSON.parse(readFileSync(new URL('./topology.target.json',import.meta.url),'utf8'));
const sample=JSON.parse(readFileSync(new URL('./baseline.example.json',import.meta.url),'utf8'));
const baseline=()=>{const b=structuredClone(sample);b.router.wanPort='ether1';return b;};
const plan=interfaces=>({customer:{interfaces}});
const verify=(site,interfaces,b=baseline(),t=structuredClone(topology))=>validateCurrentSiteWiring(site,t,b,plan(interfaces));
test('K0 current guest links pass a review-only guard, with ether5 explicitly excluded',()=>{
 const x=verify('K0',['ether2','ether3','ether4']);
 assert.deepEqual(x,{status:'plan-review-only',siteLabel:'K0',expectedGuestInterfaces:['ether2','ether3','ether4'],routerChangesPerformed:false,physicalAcceptance:false,paymentActivation:false});
 assert.throws(()=>verify('K0',['ether2','ether3','ether4','ether5']),/guest_interfaces/);
 assert.throws(()=>verify('K0',['ether2','ether3','ether5']),/guest_interfaces/);
 assert.throws(()=>verify('K0',['ether1','ether2','ether3']),/guest_interfaces/);
});
test('G0 CPE1 transit on management bridge cannot be approved as a guest interface',()=>{
 assert.throws(()=>verify('G0',['ether2']),/g0_current_cpe1_transit_on_management_bridge_not_qualified/);
 assert.throws(()=>verify('G0',['ether2','ether3']),/g0_current_cpe1_transit_on_management_bridge_not_qualified/);
 const inspected=baseline();inspected.router.cpeTransitPort='ether2';
 assert.throws(()=>verify('G0',['ether2'],inspected),/g0_current_cpe1_transit_on_management_bridge_not_qualified/);
 const swapped=structuredClone(topology);swapped.sites[1].plannedTopology.status='installed';
 assert.throws(()=>verify('G0',['ether2'],baseline(),swapped),/future|unqualified|planned/i);
});
test('refuse a protected management interface and unverified WAN mapping',()=>{
 let x=baseline();x.router.recoveryPort='ether3';
 assert.throws(()=>verify('K0',['ether2','ether3','ether4'],x),/protected_path/);
 x=baseline();x.router.wanPort='fixture-wan';
 assert.throws(()=>verify('K0',['ether2','ether3','ether4'],x),/actual_WAN/);
 assert.throws(()=>verify('G1',['ether2']),/site_must_be_current/);
});
