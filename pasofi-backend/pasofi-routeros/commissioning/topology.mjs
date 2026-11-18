import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
function must(ok,code){if(!ok)throw Error(code);}
function get(s,name){return s.nodes.find(n=>n.label===name);}
function port(s,i,target,purpose,present){
 const p=s.ports[i];
 must(p?.name==='LAN'+(i+1)&&p.interface==='ether'+(i+2)&&p.target===target&&p.purpose===purpose&&p.present===present,'bad_port_'+s.gateway.label+'_'+(i+1));
 return p;
}
export function validateTargetTopology(d){
 must(d?.schemaVersion===2&&d.status==='design-unverified'&&d.releaseGate==='physical-acceptance-required','must_remain_non_activating');
 const e=d.wiringEvidence;
 must(e?.kind==='owner-reported'&&e.routerConfigReadback===false&&e.radioQualified===false&&e.hotspotQualified===false&&e.customerGo===false,'must_not_claim_live_acceptance');
 must(d.sites?.length===2,'two_logical_sites_required');
 const k=d.sites.find(s=>s.slug==='kuwadzana'),g=d.sites.find(s=>s.slug==='goromonzi');
 must(k&&g&&d.sites.every(s=>['kuwadzana','goromonzi'].includes(s.slug)),'unexpected_site');
 const allLabels=new Set();
 for(const s of [k,g]){
  must(s.gateway?.role==='captive-portal-nas'&&s.gateway.hotspotOwner===true&&s.gateway.radiusClient===true&&s.gateway.present==='awaiting-live-inventory','unverified_gateway_required');
  must(Array.isArray(s.ports)&&Array.isArray(s.nodes)&&Array.isArray(s.radioLinks)&&s.radioLinks.length===0,'unreported_radio_link');
  for(const p of s.ports)must(/^LAN[1-4]$/.test(p.name)&&/^ether[2-5]$/.test(p.interface),'invalid_ether_port');
  for(const n of s.nodes){
   must(!allLabels.has(n.label)&&n.present===true,'duplicate_or_unverified_node');
   allLabels.add(n.label);
   must(n.dhcp===false&&n.nat===false&&n.hotspot===false&&n.radius===false,'secondary_hotspot_or_nat_forbidden');
  }
 }
 must(k.gateway.label==='K0'&&k.gateway.device==='MikroTik hEX'&&k.gateway.wan==='ether1'&&k.internet==='Starlink','k0_gateway_wrong');
 must(k.ports.length===4&&k.nodes.length===5,'k0_inventory_wrong');
 for(const [i,name] of ['K1','K2','K3'].entries()){port(k,i,name,'guest',true);must(get(k,name)?.role==='guest-access-point','guest_ap_missing');}
 port(k,3,null,'reserved',false);
 must(get(k,'K1').device==='MikroTik hAP lite','k1_wrong');
 for(const name of ['K2','K3']){
  const n=get(k,name);
  must(n.device==='Tenda OS3 5GHz 12dBi outdoor CPE'&&n.currentDevice===n.device&&n.targetDevice===n.device&&n.ethernetPorts==='4x10/100'&&n.migrationStatus==='owner-reported-connected-config-unverified'&&n.physicalVerified===false&&n.antenna?.gainDbi===12&&n.wirelessBandsGHz?.[0]===5,'os3_unverified_owner_report_required');
 }
 for(const [name,model] of [['K4','Technicolor TG789vac v2'],['K5','Mercusys MW301R']]){
  const n=get(k,name);
  must(n?.device===model&&n.role==='wireless-repeater'&&n.upstream===null&&n.upstreamVerified===false&&n.physicalVerified===false,'repeaters_not_verified');
 }
 must(k.repeaterLinks?.length===2&&k.repeaterLinks.every(l=>l.from===null&&l.physicalVerified===false),'repeaters_unqualified');
 must(g.gateway.label==='G0'&&g.gateway.device==='MikroTik hAP lite'&&g.gateway.wan==='ether1'&&g.gateway.upstream==='Starlink'&&g.gateway.upstreamVerified===false&&g.internet==='Starlink','g0_independent_starlink');
 must(g.ports.length===3&&g.nodes.length===2,'g0_device_graph_wrong');
 must(port(g,0,'G2','guest',true).physicalVerified===false,'g0_link_unverified');
 for(const i of [1,2])port(g,i,null,'unreported',null);
 for(const name of ['G2','G3']){const n=get(g,name);must(n?.device==='Mercusys MR20 AC750'&&n.role==='guest-access-point'&&n.uplinkPort===null&&n.physicalVerified===false,'mr20_must_be_unverified_ap');}
 must(g.wiredLinks?.length===1&&g.wiredLinks[0].from==='G2'&&g.wiredLinks[0].fromPort==='LAN1'&&g.wiredLinks[0].to==='G3'&&g.wiredLinks[0].toPort===null&&g.wiredLinks[0].reportedConnected===true&&g.wiredLinks[0].physicalVerified===false,'g2_lan1_must_feed_g3');
 const p=g.plannedTopology;
 must(p?.status==='proposed-not-installed'&&p.internet==='Starlink'&&p.gateway==='G0','g0_future_unqualified');
 must(p.ports?.length===2&&p.ports[0].target==='G1'&&p.ports[0].present===null&&p.ports[0].interface==='ether2'&&p.ports[1].target==='CPE1'&&p.ports[1].present===false&&p.ports[1].interface==='ether3','planned_g0_ports_not_live');
 must(p.nodes?.length===5&&p.nodes.some(n=>n.label==='G1'&&n.present===null&&n.device===null)&&p.nodes.some(n=>n.label==='CPE1'&&n.present===false&&n.device==='Tenda O1-5G 11AC outdoor CPE')&&p.nodes.some(n=>n.label==='CPE2'&&n.present===false&&n.device==='Tenda O1-5G 11AC outdoor CPE'),'future_hardware_not_installed');
 must(p.branchToG2?.from==='CPE1'&&p.branchToG2.to==='G2'&&p.branchToG2.medium===null&&p.branchToG2.receiver===null&&p.branchToG2.qualified===false&&p.branchToG2.requiresReceiverOrVerifiedEquivalent===true,'g2_receiving_link_unknown');
 must(p.radioLinks?.length===1&&p.radioLinks[0].from==='CPE1'&&p.radioLinks[0].to==='CPE2'&&p.radioLinks[0].bandGHz===5&&p.radioLinks[0].qualified===false,'future_rf_not_qualified');
 must(p.wiredLinks?.length===1&&p.wiredLinks[0].from==='CPE2'&&p.wiredLinks[0].to==='G3'&&p.wiredLinks[0].qualified===false,'future_g3_not_qualified');
 must(p.cutover==='Keep current wired G0-G2-G3 path operational until replacement is verified','must_preserve_current_g2_g3');
 must(d.radioReassignment?.status==='Kuwadzana-OS3-owner-reported; Goromonzi-O1-5G-proposed-not-installed','goromonzi_radio_migration_not_live');
 return {status:'design-unverified',sites:['kuwadzana','goromonzi'],physicalAcceptance:false,routersChanged:false,commerceEnabled:false};
}
const self=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(self){try{const input=process.argv[2]??new URL('./topology.target.json',import.meta.url);process.stdout.write(JSON.stringify(validateTargetTopology(JSON.parse(readFileSync(input,'utf8'))))+'\n');}catch(err){process.stderr.write(err.message+'\n');process.exitCode=1;}}
