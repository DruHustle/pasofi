import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildInstall, routerString } from './build-install.mjs';
const read = name => readFile(new URL(name, import.meta.url), 'utf8');
function render(source, vars) {
  const stack = []; let active = true;
  return source.split(/(\$\([^)]*\))/g).map(part => {
    if (!part.startsWith('$(')) return active ? part : '';
    const token = part.slice(2, -1);
    if (token.startsWith('if ')) {
      const [, key, match] = /^if ([\w-]+)(?: == '([^']*)')?$/.exec(token) ?? [];
      if (!key) throw Error(`Unsupported conditional ${token}`);
      const pass = match === undefined ? !!vars[key] : vars[key] === match;
      stack.push({ parent: active, pass }); active = active && pass; return '';
    }
    if (token === 'else') { const last = stack.at(-1); active = last.parent && !last.pass; return ''; }
    if (token === 'endif') { active = stack.pop().parent; return ''; }
    return active ? (vars[token] ?? '') : '';
  }).join('');
}
test('welcome auto-connects only when trial is eligible, with manual fallback and no error loop', async () => {
  const source = await read('login.html');
  const eligible = render(source, { trial: 'yes', mac: 'AA:BB:CC:DD:EE:FF' });
  assert.match(eligible, /name="username" value="T-AA:BB:CC:DD:EE:FF"/);
  assert.match(eligible, /id="welcome" action="https:\/\/hotspot\.pasofi\.onesa\.eu\/login" method="post"/);
  assert.match(eligible, /getElementById\('welcome'\).submit/);
  for (const vars of [{ trial: 'no' }, { trial: 'yes', error: 'failed' }]) {
    assert.doesNotMatch(render(source, vars), /<script>/);
  }
  assert.doesNotMatch(render(source, { trial: 'no' }), /id="welcome"/);
  assert.match(render(source, { trial: 'no' }), /Continue to PasoFi/);
  assert.doesNotMatch(source, /\$\((?:link-orig|error|username)\)/);
});
test('countdown uses router time and returns to login at expiry even after a background pause', async () => {
  const source = render(await read('status.html'), { 'login-by': 'trial', 'session-time-left-secs': '120' });
  const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1];
  let now = 0, tick, redirect; const node = {};
  vm.runInNewContext(script, { Number, Math, String, Date: { now: () => now }, document: { getElementById: () => node }, setInterval: fn => { tick = fn; }, location: { replace: url => { redirect = url; } } });
  assert.equal(node.textContent, '2:00'); now = 65_000; tick(); assert.equal(node.textContent, '0:55');
  now = 180_000; tick(); assert.equal(redirect, 'https://hotspot.pasofi.onesa.eu/login');
  assert.doesNotMatch(render(await read('status.html'), { 'login-by': 'https' }), /<script>/);
});
test('installer escapes templates, preserves the original folder, and changes no access controls', async () => {
  assert.equal(routerString('$x"\\\n'), '"\\$x\\"\\\\\\n"');
  assert.equal(routerString('→'), '"\\E2\\86\\92"');
  const script = await buildInstall({ source: 'old-portal', target: 'new-portal', profile: 'https-pilot' });
  assert.ok(script.indexOf('Target exists') < script.indexOf('/file copy'));
  assert.ok(script.indexOf('Portal file verification failed') < script.indexOf('html-directory=$target'));
  assert.match(script, /\\\$\(mac\)/);
  assert.doesNotMatch(script, /\/file remove|login-by=|\/ip firewall|walled-garden|password=/);
  await assert.rejects(buildInstall({ source: 'a', target: 'a', profile: 'p' }));
  await assert.rejects(buildInstall({ source: 'a', target: 'b"; :error "bad', profile: 'p' }));
});
