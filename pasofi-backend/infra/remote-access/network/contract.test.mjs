import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildPlan} from './plan.mjs';
import {fixture} from './fixture.mjs';

test('real Node generator output is accepted unchanged by the Python Mac checker',()=>{
  const checker=process.env.PASOFI_OWNER_MAC_CHECKER
    ? resolve(process.env.PASOFI_OWNER_MAC_CHECKER)
    : fileURLToPath(new URL('../operator-mac/check_remote.py',import.meta.url));
  const python=[
    'import importlib.util, sys',
    'spec = importlib.util.spec_from_file_location("pasofi_contract_checker", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'sys.modules[spec.name] = module',
    'spec.loader.exec_module(module)',
    'value = module.strict_json(sys.stdin.buffer.read())',
    'assert module.validate_manifest(value) == value',
    'print("Manifest accepted unchanged")',
  ].join('\n');
  for(const login of ['owner@example.com','operator@github','operator@passkey','owner@company.test']) {
    const p=fixture();p.owner.tailscaleLogin=login;p.gateways[0].name='Synthetic gateway 🌍';
    const result=spawnSync('python3',['-I','-B','-S','-c',python,checker],{input:buildPlan(p)['owner-targets.json'],encoding:'utf8',timeout:10000,maxBuffer:16384});
    assert.equal(result.error,undefined,'The actual Python validation must execute');
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),'Manifest accepted unchanged');
  }
});
