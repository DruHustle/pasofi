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
 assert.equal(at('kuwadzana').ports.filter(x=>x.present).length,3);
 assert.equal(at('kuwadzana').ports[3].purpose,'reserved');
 assert.equal(at('kuwadzana').ports[3].target,null);
 assert.equal(at('goromonzi').ports[0].purpose,'home');
});
test('G2 and G3 are Mercusys bridged guest APs, never NAS or 5 GHz receivers by assumption',()=>{
 const g=at('goromonzi');
 for(const label of ['G2','G3']){
  const n=g.nodes.find(x=>x.label===label);
  assert.equal(n.device,'Mercusys MR20 AC750');
  assert.equal(n.nat,false);assert.equal(n.hotspot,false);
  assert.equal(n.dhcp,false);assert.equal(n.radius,false);
  assert.equal(n.wirelessClientQualified,false);
 }
 for(const label of ['CPE1','CPE2']){
  const n=g.nodes.find(x=>x.label===label);
  assert.equal(n.device,'Tenda OS3 5GHz directional CPE');
  assert.equal(n.targetDevice,'Tenda O1-5G 11AC outdoor CPE');
  assert.equal(n.migrationStatus,'existing-OS3-link-must-be-preserved-until-O1-qualified');
 }
 assert.equal(original.radioReassignment.status,'proposed-not-installed');
 assert.equal(g.radioLinks.find(x=>x.to==='CPE2').state,'existing-preserve');
 assert.equal(g.radioLinks.find(x=>x.to==='G2-RX').state,'planned-needs-receiver');
});
test('K2/K3 target OS3 radios and K4/K5 wireless repeaters are not falsely commissioned',()=>{
 const k=at('kuwadzana');
 for(const label of ['K2','K3']){
  const n=k.nodes.find(x=>x.label===label);
  assert.equal(n.device,'Tenda O1-5G 11AC outdoor CPE');
  assert.equal(n.targetDevice,'Tenda OS3 5GHz 12dBi outdoor CPE');
  assert.equal(n.migrationStatus,'pending-physical-swap');
  assert.deepEqual(n.wirelessBandsGHz,[5]);
  assert.equal(n.antenna.gainDbi,12);
  assert.equal(n.antenna.horizontalBeamwidthDegrees,30);
  assert.equal(n.physicalVerified,false);
  assert.equal(n.hotspot,false);
 }
 assert.deepEqual(k.ports.slice(0,3).map(x=>x.target),['K1','K2','K3']);
 assert.equal(k.ports[3].target,null);
 assert.equal(k.nodes.find(x=>x.label==='K4').device,'Technicolor TG789vac v2');
 assert.equal(k.nodes.find(x=>x.label==='K5').device,'Mercusys MW301R');
 assert.deepEqual(k.repeaterLinks.map(x=>x.from),[null,null]);
 assert.ok(k.repeaterLinks.every(x=>x.physicalVerified===false));
});
test('unsafe changes cannot silently bypass physical and payment acceptance',()=>{
 for(const [name,mutation] of Object.entries({
  enableStock:x=>{x.releaseGate='ready';},
  convertG2ToNAS:x=>{x.sites[1].nodes.find(n=>n.label==='G2').hotspot=true;},
  convertG3ToNAT:x=>{x.sites[1].nodes.find(n=>n.label==='G3').nat=true;},
  mixHomeAndGuest:x=>{x.sites[1].nodes.find(n=>n.label==='G1').guestNetwork=true;},
  removeExistingCPE2:x=>{x.sites[1].radioLinks.splice(0,1);},
  prematurelyClaimOS3AtK2:x=>{x.sites[0].nodes.find(n=>n.label==='K2').migrationStatus='completed';},
  prematurelyClaimO1AtCPE1:x=>{x.sites[1].nodes.find(n=>n.label==='CPE1').device='Tenda O1-5G 11AC outdoor CPE';},
  deleteRadioSwapSafeguard:x=>{x.radioReassignment.prerequisites=[];},
  markNewReceiverInstalled:x=>{x.sites[1].nodes.find(n=>n.label==='G2-RX').present=true;x.sites[1].nodes.find(n=>n.label==='G2-RX').device='unqualified';},
  replaceMercusysG3:x=>{x.sites[1].nodes.find(n=>n.label==='G3').device='other brand';},
  replaceG0WithG1:x=>{x.sites[1].gateway.label='G1';},
  moveK1ToLAN4:x=>{x.sites[0].ports[0].target='K4';},
  enableReservedLAN4:x=>{x.sites[0].ports[3].present=true;},
  wireK4ToLAN4:x=>{x.sites[0].ports[3]={name:'LAN4',interface:'ether5',target:'K4',purpose:'guest',present:true};},
  k2NAT:x=>{x.sites[0].nodes.find(n=>n.label==='K2').nat=true;},
  k3WrongBand:x=>{x.sites[0].nodes.find(n=>n.label==='K3').wirelessBandsGHz=[2.4];},
  k4UnverifiedUpstream:x=>{x.sites[0].nodes.find(n=>n.label==='K4').upstream='K1';},
  k5BypassHotSpot:x=>{x.sites[0].nodes.find(n=>n.label==='K5').hotspot=true;},
  k4ClaimBridgeVerified:x=>{x.sites[0].repeaterLinks[0].physicalVerified=true;},
  removeK5Repeater:x=>{x.sites[0].repeaterLinks.pop();},
  markExistingRadioLive:x=>{x.sites[1].radioLinks[0].physicalVerified=true;},
  putG2OnSameCPE2:x=>{x.sites[1].wiredLinks[1].from='CPE2';},
  removeG2Link:x=>{x.sites[1].radioLinks.pop();},
  duplicateLabels:x=>{x.sites[1].nodes.find(n=>n.label==='G2').label='G3';}
 })){
  const value=clone();mutation(value);
  assert.throws(()=>validateTargetTopology(value),undefined,name);
 }
});
