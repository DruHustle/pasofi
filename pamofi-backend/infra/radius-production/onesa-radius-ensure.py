#!/usr/bin/env python3
"""Check and, if necessary, start the two reviewed Onesa RADIUS containers."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

RADIUS='pamofi-production-radius-1'
AUTHORITY='pamofi-production-radius-api-1'
EXPECTED={RADIUS:'sha256:9e860a6d14ecbccc97448da1d0c5dd15b5e7e6b64777cea21b57e832187a2057',AUTHORITY:'sha256:8be2b1e92da61d4dc1063f911d3c02b1c4db85f176d1047cdcbea282502981aa'}
PORTS={'1812/udp':[{'HostIp':'10.77.254.1','HostPort':'1812'}],'1813/udp':[{'HostIp':'10.77.254.1','HostPort':'1813'}]}
NETWORKS={RADIUS:{'pamofi-production_radius_ingress','pamofi-production_radius_transport'},AUTHORITY:{'pamofi-production_database','pamofi-production_radius_transport','pamofi-production_services'}}
CERT_DIR=Path('/home/ubuntu/pamofi/production/radius-preparation-20261103/site01')

def validate_definition(name,obj):
    if obj.get('Name')!='/'+name or obj.get('Image')!=EXPECTED[name]:raise ValueError('Unexpected container identity')
    host=obj.get('HostConfig',{})
    if host.get('RestartPolicy',{}).get('Name')!='unless-stopped' or host.get('NetworkMode')=='host':raise ValueError('Unexpected container runtime')
    bindings=host.get('PortBindings') or {}
    if bindings!=(PORTS if name==RADIUS else {}):raise ValueError('Unexpected RADIUS port bindings')
    if set(obj.get('NetworkSettings',{}).get('Networks',{}))!=NETWORKS[name]:raise ValueError('Unexpected RADIUS networks')
    env=set(obj.get('Config',{}).get('Env',[]))
    if 'PAMOFI_RADIUS_QUALIFIED=true' not in env:raise ValueError('RADIUS transport is not qualified')
    if name==RADIUS and 'PAMOFI_RADIUS_TUNNEL_IP=10.77.254.1' not in env:raise ValueError('Unexpected tunnel binding')

def run(args):
    return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True).stdout

def inspect(name):
    data=json.loads(run(['docker','inspect',name]))
    if len(data)!=1:raise ValueError('Unexpected container count')
    validate_definition(name,data[0])
    return data[0]

def main():
    if os.geteuid()!=0 or sys.argv[1:]!=['ensure']:raise ValueError('Run as root with the ensure argument')
    for unit in ('pamofi-site01-guard.service','wg-quick@pfi-site01.service'):
        run(['systemctl','is-active','--quiet',unit])
    for cert in ('radius_ca','radius_client_cert','radius_server_cert'):
        run(['openssl','x509','-in',str(CERT_DIR/cert),'-noout','-checkend','2592000'])
    # Validate the stored container definitions before starting anything.
    authority=inspect(AUTHORITY);radius=inspect(RADIUS)
    if not authority['State']['Running']:run(['docker','start',AUTHORITY])
    for _ in range(60):
        authority=inspect(AUTHORITY)
        if authority['State'].get('Health',{}).get('Status')=='healthy':break
        time.sleep(1)
    else:raise ValueError('RADIUS authority is not healthy')
    if not radius['State']['Running']:run(['docker','start',RADIUS])
    radius=inspect(RADIUS)
    if not radius['State']['Running'] or radius['State'].get('Restarting'):raise ValueError('RADIUS is not running')
    lines=run(['ss','-H','-lun','( sport = :1812 or sport = :1813 )']).splitlines()
    addresses=[line.split()[3] for line in lines if len(line.split())>=4]
    if sorted(addresses)!=['10.77.254.1:1812','10.77.254.1:1813']:raise ValueError('Unexpected live RADIUS listeners')
    print('Private RADIUS containers and tunnel bindings are ready; NAS and customer eligibility are checked separately.')

if __name__=='__main__':
    try:main()
    except Exception as exc:
        print('PamoFi RADIUS readiness failed ('+type(exc).__name__+').',file=sys.stderr)
        sys.exit(1)
