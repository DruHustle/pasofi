import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateTargetTopology} from './topology.mjs';

const original=JSON.parse(readFileSync(new URL('./topology.target.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(original);
const at=slug=>clone().sites.find(s=>s.slug===slug);
test('K0 and G0 plan is a non-activation draft with separate captive NAS owners',()=>{
 const result=validateTargetTopology(clone());
 assert.deepEqual(result,{status:'design-unverified',sites:['kuwadzana','goromonzi'],physicalAcceptance:false,routersChanged:false,commerceEnabled:false});
 assert.equal(at('kuwadzana').gateway.label,'K0');
 assert.equal(at('goromonzi').gateway.label,'G0');
 assert.equal(at('kuwadzana').ports.filter(x=>x.present).length,1);
 assert.equal(at('goromonzi').ports[0].purpose,'home');
});
test('G2 and G3 are Mercusys bridged guest APs, never NAS or 5 GHz receivers by assumption',()=>{
 const g=at('goromonzi');
 for(const label of ['G2','G3']){
  const n=g.nodes.find(x=>x.label===label);
  assert.match(n.device,/^Mercusys router /);
  assert.equal(n.nat,false);assert.equal(n.hotspot,false);
  assert.equal(n.dhcp,false);assert.equal(n.radius,false);
  assert.equal(n.wirelessClientQualified,false);
 }
 assert.equal(g.radioLinks.find(x=>x.to==='CPE2').state,'existing-preserve');
 assert.equal(g.radioLinks.find(x=>x.to==='G2-RX').state,'planned-needs-receiver');
});
test('unsafe changes cannot silently bypass physical and payment acceptance',()=>{
 for(const [name,mutation] of Object.entries({
  enableStock:x=>{x.releaseGate='ready';},
  convertG2ToNAS:x=>{x.sites[1].nodes.find(n=>n.label==='G2').hotspot=true;},
  convertG3ToNAT:x=>{x.sites[1].nodes.find(n=>n.label==='G3').nat=true;},
  mixHomeAndGuest:x=>{x.sites[1].nodes.find(n=>n.label==='G1').guestNetwork=true;},
  removeExistingCPE2:x=>{x.sites[1].radioLinks.splice(0,1);},
  markNewReceiverInstalled:x=>{x.sites[1].nodes.find(n=>n.label==='G2-RX').present=true;x.sites[1].nodes.find(n=>n.label==='G2-RX').device='unqualified';},
  replaceMercusysG3:x=>{x.sites[1].nodes.find(n=>n.label==='G3').device='other brand';},
  replaceG0WithG1:x=>{x.sites[1].gateway.label='G1';},
  moveK1ToLAN4:x=>{x.sites[0].ports[0].target='K4';},
  enableUninstalledAP:x=>{x.sites[0].ports[2].present=true;},
  markExistingRadioLive:x=>{x.sites[1].radioLinks[0].physicalVerified=true;},
  putG2OnSameCPE2:x=>{x.sites[1].wiredLinks[1].from='CPE2';},
  removeG2Link:x=>{x.sites[1].radioLinks.pop();},
  duplicateLabels:x=>{x.sites[1].nodes.find(n=>n.label==='G2').label='G3';}
 })){
  const value=clone();mutation(value);
  assert.throws(()=>validateTargetTopology(value),undefined,name);
 }
});
