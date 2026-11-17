import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateTargetTopology} from './topology.mjs';
const value=JSON.parse(readFileSync(new URL('./topology.target.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(value);
test('wiring is K0 K1/K2/K3 and LAN4 empty, G0 upstream Starlink',()=>{
 assert.deepEqual(validateTargetTopology(copy()),{status:'design-unverified',sites:['kuwadzana','goromonzi'],physicalAcceptance:false,routersChanged:false,commerceEnabled:false});
 const [k,g]=value.sites;
 assert.deepEqual(k.ports.map(p=>p.target),['K1','K2','K3',null]);
 assert.equal(k.ports[3].present,false);
 assert.equal(g.gateway.wan,'ether1');
 assert.equal(g.gateway.upstream,'Starlink');
 assert.deepEqual(g.ports.map(p=>p.target),['G2',null,null]);
 assert.equal(g.wiredLinks[0].from,'G2');
 assert.equal(g.wiredLinks[0].fromPort,'LAN1');
 assert.equal(g.wiredLinks[0].to,'G3');
 assert.equal(g.plannedTopology.status,'proposed-not-installed');
 assert.equal(g.plannedTopology.ports[0].target,'G1');
 assert.equal(g.plannedTopology.ports[1].target,'CPE1');
 assert.equal(g.plannedTopology.branchToG2.medium,null);
 for(const label of ['K2','K3'])assert.equal(k.nodes.find(n=>n.label===label).device,'Tenda OS3 5GHz 12dBi outdoor CPE');
});
test('reject obsolete diagrams and premature HotSpot/customer go',()=>{
 const failures={
  k0Lan4ToG0:d=>{const p=d.sites[0].ports[3];p.present=true;p.target='G0';p.purpose='guest';},
  k0Lan4Busy:d=>{d.sites[0].ports[3].present=true;},
  wrongK2Radio:d=>{d.sites[0].nodes.find(n=>n.label==='K2').device='Tenda O1-5G';},
  claimRadioPass:d=>{d.sites[0].nodes.find(n=>n.label==='K3').physicalVerified=true;},
  g0AssumedK0:d=>{d.sites[1].gateway.upstream='K0:LAN4';},
  g0WrongWAN:d=>{d.sites[1].gateway.wan=null;},
  g0OldCPE:d=>{d.sites[1].radioLinks.push({from:'CPE1',to:'CPE2'});},
  g0WrongLAN1:d=>{d.sites[1].ports[0].target='CPE1';},
  g2NAT:d=>{d.sites[1].nodes.find(n=>n.label==='G2').nat=true;},
  g3DHCP:d=>{d.sites[1].nodes.find(n=>n.label==='G3').dhcp=true;},
  chainBroken:d=>{d.sites[1].wiredLinks=[];},
  chainVerified:d=>{d.sites[1].wiredLinks[0].physicalVerified=true;},
  claimReady:d=>{d.releaseGate='ready';},
  customerGo:d=>{d.wiringEvidence.customerGo=true;},
  radioGo:d=>{d.wiringEvidence.radioQualified=true;},
  fakeG1Installed:d=>{d.sites[1].plannedTopology.nodes.find(n=>n.label==='G1').present=true;},
  fakeCPE1Installed:d=>{d.sites[1].plannedTopology.nodes.find(n=>n.label==='CPE1').present=true;},
  assumeG2Radio:d=>{d.sites[1].plannedTopology.branchToG2.medium='radio';},
  claimFutureCPELink:d=>{d.sites[1].plannedTopology.radioLinks[0].qualified=true;},
  skipEthernetPreservation:d=>{d.sites[1].plannedTopology.cutover='replace immediately';}
 };
 for(const [name,mutation] of Object.entries(failures)){const x=copy();mutation(x);assert.throws(()=>validateTargetTopology(x),undefined,name);}
});
