import copy,importlib.util,pathlib,unittest
spec=importlib.util.spec_from_file_location('ensure',pathlib.Path(__file__).with_name('onesa-radius-ensure.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture(name):
    return {'Name':'/'+name,'Image':m.EXPECTED[name],
      'HostConfig':{'RestartPolicy':{'Name':'unless-stopped'},'NetworkMode':'bridge','PortBindings':copy.deepcopy(m.PORTS) if name==m.RADIUS else {}},
      'NetworkSettings':{'Networks':{n:{} for n in m.NETWORKS[name]}},
      'Config':{'Env':['PAMOFI_RADIUS_QUALIFIED=true']+(['PAMOFI_RADIUS_TUNNEL_IP=10.77.254.1'] if name==m.RADIUS else [])}}
class TestEnsure(unittest.TestCase):
    def test_reviewed_definitions_pass(self):
        for name in (m.RADIUS,m.AUTHORITY):m.validate_definition(name,fixture(name))
    def test_unexpected_exposure_identity_and_network_fail(self):
        for change in ('wildcard','extra_port','wrong_image','host_network','extra_network','unqualified','duplicate_gate'):
            x=fixture(m.RADIUS)
            if change=='wildcard':x['HostConfig']['PortBindings']['1812/udp'][0]['HostIp']='0.0.0.0'
            if change=='extra_port':x['HostConfig']['PortBindings']['22/tcp']=[{'HostIp':'0.0.0.0','HostPort':'22'}]
            if change=='wrong_image':x['Image']='sha256:other'
            if change=='host_network':x['HostConfig']['NetworkMode']='host'
            if change=='extra_network':x['NetworkSettings']['Networks']['unreviewed']={}
            if change=='unqualified':x['Config']['Env']=[]
            if change=='duplicate_gate':x['Config']['Env'].append('PAMOFI_RADIUS_QUALIFIED=false')
            with self.subTest(change=change),self.assertRaises(ValueError):m.validate_definition(m.RADIUS,x)
    def test_authority_must_not_publish_ports(self):
        x=fixture(m.AUTHORITY);x['HostConfig']['PortBindings']={'3443/tcp':[{'HostIp':'0.0.0.0','HostPort':'3443'}]}
        with self.assertRaises(ValueError):m.validate_definition(m.AUTHORITY,x)
if __name__=='__main__':unittest.main()
