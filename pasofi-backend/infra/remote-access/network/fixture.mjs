// Synthetic public identifiers for offline tests only. Never a site allocation.
export function fixture() {
  const key=n=>Buffer.alloc(32,n).toString('base64');
  return {
    schemaVersion:1,planId:'synthetic-review',
    owner:{tailscaleLogin:'owner@example.com',ipv4Routes:['192.168.240.0/24','100.64.0.0/10']},
    hub:{endpoint:'vpn.example.com',listenPort:51873,interface:'pfi-owner-hub',publicKey:key(1),tunnelIp:'10.210.0.1',tailscaleNodeId:'nSyntheticCNTRL',ipv4Routes:['172.20.0.0/24','100.64.0.0/10'],existingAdvertisedRoutes:['172.21.40.0/24','fd7a:115c:a1e0:beef::/64']},
    gateways:[
      {id:'gateway-a',name:'Synthetic gateway A',expectedSerial:'SYNTHETIC-A',verifiedAt:'2026-11-01T12:00:00Z',interface:'pfi-owner',listenPort:51874,publicKey:key(2),tunnelIp:'10.210.0.2',wanInterface:'ether1',ipv4Routes:['192.168.20.0/24','172.16.1.0/24'],management:{tcpPorts:[8291,22],icmp:true},targets:[
        {id:'bridge-a',name:'Synthetic bridge A',vendor:'tenda',address:'192.168.20.10',management:{tcpPorts:[80],icmp:true},expectedIdentity:{kind:'mac',value:'02:00:00:00:00:01'},verifiedAt:'2026-11-01T12:01:00.000Z',path:{egressInterface:'bridge',connectedCidr:'192.168.20.0/24',gatewayLanIp:'192.168.20.1',returnPath:'source-nat'}},
      ]},
      {id:'gateway-b',name:'Synthetic gateway B',expectedSerial:'SYNTHETIC-B',verifiedAt:'2026-11-01T12:02:00Z',interface:'pfi-owner',listenPort:51874,publicKey:key(3),tunnelIp:'10.210.0.3',wanInterface:'ether1',ipv4Routes:['192.168.30.0/24','172.16.1.0/24'],management:{tcpPorts:[80],icmp:false},targets:[
        {id:'ap-b',name:'Synthetic AP B',vendor:'mercusys',address:'192.168.30.20',management:{tcpPorts:[443,80],icmp:false},expectedIdentity:{kind:'mac',value:'02:00:00:00:00:02'},verifiedAt:'2026-11-01T12:03:00Z',path:{egressInterface:'bridge',connectedCidr:'192.168.30.0/24',gatewayLanIp:'192.168.30.1',returnPath:'verified-gateway-route'}},
      ]},
    ],
  };
}
