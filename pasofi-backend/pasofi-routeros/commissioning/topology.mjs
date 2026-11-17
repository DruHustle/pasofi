import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

function requireCondition(ok,code){if(!ok)throw Error(code);}
function getNode(site,label){return site.nodes.find(n=>n.label===label);}
function assertNodePresent(site,label,role,present){
 const n=getNode(site,label);
 requireCondition(n?.role===role && n.present===present,'incorrect_node_'+label);
 return n;
}
// Only reviews owner-declared *intent*. No RouterOS config, sales capability,
// NAS identifier or physical acceptance may be derived from this plan alone.
export function validateTargetTopology(data){
 requireCondition(data?.schemaVersion===1 && data.status==='design-unverified' &&
   data.releaseGate==='physical-acceptance-required','topology_must_be_unqualified');
 requireCondition(Array.isArray(data.sites)&&data.sites.length===2,'exact_two_sites_required');
 const expectedSites=['kuwadzana','goromonzi'],labels=new Set();
 for(const slug of expectedSites)requireCondition(data.sites.some(s=>s.slug===slug),'site_missing_'+slug);
 for(const site of data.sites){
  requireCondition(expectedSites.includes(site.slug),'unexpected_site');
  requireCondition(site.internet==='Starlink','upstream_not_starlink');
  const gw=site.gateway;
  requireCondition(gw?.role==='captive-portal-nas'&&gw.hotspotOwner===true&&gw.radiusClient===true&&
    gw.wan==='ether1'&&gw.present==='awaiting-live-inventory','unqualified_gateway_required');
  requireCondition(!labels.has(gw.label),'duplicate_router_label');
  labels.add(gw.label);
  requireCondition(Array.isArray(site.ports)&&Array.isArray(site.nodes)&&Array.isArray(site.radioLinks),'missing_network_graph');
  const local=new Set(),interfaces=new Set();
  for(const n of site.nodes){
   requireCondition(/^[A-Z][A-Z0-9-]{1,15}$/.test(n.label)&&!labels.has(n.label),'invalid_or_duplicate_router_label');
   labels.add(n.label);local.add(n.label);
   requireCondition(typeof n.present==='boolean','node_presence_required');
   if(!n.present)requireCondition(n.device===null,'uninstalled_hardware_must_be_unspecified');
   if(['guest-access-point','backhaul-ap','backhaul-client'].includes(n.role)){
    requireCondition(n.dhcp===false&&n.nat===false&&n.hotspot===false&&n.radius!==true,'secondary_guest_gateway_forbidden');
   }
   if(n.role==='home-access-point')requireCondition(n.guestNetwork===false,'home_must_remain_separate');
  }
  for(const port of site.ports){
   requireCondition(/^LAN[1-4]$/.test(port.name)&&/^ether[2-5]$/.test(port.interface),'invalid_gateway_lan');
   requireCondition(!interfaces.has(port.interface),'duplicate_gateway_port');
   interfaces.add(port.interface);
   if(port.purpose==='reserved'){
    requireCondition(!port.present&&port.target===null,'reserved_port_must_stay_empty');
   }else{
    requireCondition(local.has(port.target) && port.present===getNode(site,port.target).present,'unresolved_gateway_port');
    const role=getNode(site,port.target).role;
    requireCondition(port.purpose==='home'?role==='home-access-point':role==='guest-access-point'||role==='backhaul-ap','lan_role_mismatch');
   }
  }
  for(const link of site.radioLinks){
   const a=getNode(site,link.from),b=getNode(site,link.to);
   requireCondition(a?.role==='backhaul-ap'&&b?.role==='backhaul-client','wireless_link_requires_cpe_ap_and_client');
   requireCondition(a.wirelessBandsGHz?.includes(5)&&b.wirelessBandsGHz?.includes(5)&&link.bandGHz===5,'wireless_bridge_must_be_5ghz');
   requireCondition(link.physicalVerified===false,'do_not_invent_radio_acceptance');
   if(link.state==='existing-preserve')requireCondition(a.present&&b.present,'existing_radio_link_must_be_preserved');
   else requireCondition(link.state==='planned-needs-receiver'&&!b.present,'planned_radio_requires_uninstalled_receiver');
  }
  if(site.slug==='kuwadzana'){
   requireCondition(gw.label==='K0'&&gw.device==='MikroTik hEX','k0_must_be_hex_gateway');
   requireCondition(site.ports.length===4 && site.ports.every((p,i)=>p.name==='LAN'+(i+1)&&
    p.interface==='ether'+(i+2)&&p.target==='K'+(i+1)&&p.purpose==='guest'&&p.present===(i===0)),'k0_lan1_through_lan4_mismatch');
   assertNodePresent(site,'K1','guest-access-point',true);
   for(const label of ['K2','K3','K4'])assertNodePresent(site,label,'guest-access-point',false);
   requireCondition(site.radioLinks.length===0,'k0_no_radio_backhaul');
  }else{
   requireCondition(gw.label==='G0'&&gw.device==='MikroTik hAP lite','g0_must_be_hap_lite_gateway');
   requireCondition(site.ports.length===3&&site.ports[0].target==='G1'&&site.ports[0].purpose==='home'&&
    site.ports[1].target==='CPE1'&&site.ports[1].purpose==='guest-backhaul'&&
    site.ports[2].purpose==='reserved','g0_ports_must_preserve_home_and_backhaul');
   assertNodePresent(site,'G1','home-access-point',true);
   assertNodePresent(site,'CPE1','backhaul-ap',true);
   assertNodePresent(site,'CPE2','backhaul-client',true);
   assertNodePresent(site,'G2-RX','backhaul-client',false);
   for(const label of ['G2','G3']){
    const node=assertNodePresent(site,label,'guest-access-point',true);
    requireCondition(node.device.startsWith('Mercusys router')&&node.wirelessClientQualified===false,'mercusys_client_mode_not_qualified');
   }
   requireCondition(site.radioLinks.length===2 &&
    site.radioLinks.some(l=>l.from==='CPE1'&&l.to==='CPE2'&&l.state==='existing-preserve') &&
    site.radioLinks.some(l=>l.from==='CPE1'&&l.to==='G2-RX'&&l.state==='planned-needs-receiver'),'existing_cpe_link_must_remain_and_g2_requires_rx');
   requireCondition(site.wiredLinks?.length===2 &&
    site.wiredLinks.some(l=>l.from==='CPE2'&&l.to==='G3'&&l.purpose==='guest') &&
    site.wiredLinks.some(l=>l.from==='G2-RX'&&l.to==='G2'&&l.present===false),'guest_access_points_need_bridged_receiver');
  }
 }
 return {status:'design-unverified',sites:expectedSites,physicalAcceptance:false,routersChanged:false,commerceEnabled:false};
}

const self=process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1];
if(self){
 const input=process.argv[2]??new URL('./topology.target.json',import.meta.url);
 try{
  const value=JSON.parse(readFileSync(input,'utf8'));
  process.stdout.write(JSON.stringify(validateTargetTopology(value))+'\n');
 }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=1;}
}
