import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildInstall, buildPages, routerString } from './build-install.mjs';
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
  for (const [source, target, profile] of [['a', 'a/nested', 'p'], ['a/nested', 'a', 'p'], ['a', '../b', 'p'], ['/a', 'b', 'p'], ['a', 'b', undefined]]) {
    await assert.rejects(buildInstall({ source, target, profile }));
  }
});

test('default welcome output preserves the existing templates byte for byte', async () => {
  const pages = await buildPages();
  for (const [name, content] of Object.entries(pages)) assert.equal(content, await read(name), name);
});

test('site-specific pages keep every login, countdown and app link on its selected origin', async () => {
  const site = { siteLabel: 'Lawfield Farm', hotspotOrigin: 'https://hotspot-lawfield.example.com', appOrigin: 'https://portal.example.com/' };
  const pages = await buildPages(site);
  const all = Object.values(pages).join('\n');
  assert.doesNotMatch(all, /Kuwadzana|https:\/\/(?:hotspot\.)?pasofi\.onesa\.eu/);
  for (const name of ['login.html', 'status.html']) assert.match(pages[name], /<span class="place">Lawfield Farm<\/span>/);
  const eligible = render(pages['login.html'], { trial: 'yes', mac: 'AA:BB:CC:DD:EE:FF' });
  assert.match(eligible, /action="https:\/\/hotspot-lawfield\.example\.com\/login" method="post"/);
  assert.match(eligible, /name="username" value="T-AA:BB:CC:DD:EE:FF"/);
  assert.match(render(pages['login.html'], { trial: 'no' }), /href="https:\/\/portal\.example\.com\/connect"/);
  assert.match(pages['status.html'], /href="https:\/\/portal\.example\.com\/connect#voucher"/);
  assert.match(pages['alogin.html'], /content="0;url=https:\/\/hotspot-lawfield\.example\.com\/status"/);
  assert.match(pages['logout.html'], /href="https:\/\/hotspot-lawfield\.example\.com\/login"/);
  const script = /<script>([\s\S]*?)<\/script>/.exec(render(pages['status.html'], { 'login-by': 'trial', 'session-time-left-secs': '0' }))[1];
  let redirect;
  vm.runInNewContext(script, { Number, Math, String, Date, document: { getElementById: () => ({}) }, setInterval() {}, location: { replace: url => { redirect = url; } } });
  assert.equal(redirect, 'https://hotspot-lawfield.example.com/login');
  const installer = await buildInstall({ source: 'hotspot', target: 'flash/lawfield-welcome', profile: 'lawfield-https', site });
  assert.match(installer, /dns-name\] != "hotspot-lawfield\.example\.com"/);
  assert.doesNotMatch(installer, /login-by=|\/ip firewall|walled-garden|\/radius|disabled=no|password=/);
  // Swapping the two default names must not replace an inserted origin twice.
  const swapped = await buildPages({ hotspotOrigin: 'https://pasofi.onesa.eu', appOrigin: 'https://hotspot.pasofi.onesa.eu' });
  assert.match(swapped['login.html'], /action="https:\/\/pasofi\.onesa\.eu\/login"/);
  assert.match(swapped['login.html'], /href="https:\/\/hotspot\.pasofi\.onesa\.eu\/connect"/);
});

test('site inputs reject unsafe origins and escape HTML and RouterOS portal tokens', async () => {
  const unsafe = ['http://portal.example.com', 'javascript:alert(1)', 'https://user:password@portal.example.com',
    'https://portal.example.com:443', 'https://portal.example.com:8443', 'https://portal.example.com/connect',
    'https://portal.example.com?x=1', 'https://portal.example.com#voucher', 'https://portal.example.com//',
    'https://portal.example.com/../', 'https://portal.example.com/%22', 'https://portal.example.com/\n',
    ' https://portal.example.com', 'https://portal.example.com"; /system reboot', 'https://$(error).example.com',
    'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://bad..example.com', null, 443];
  for (const origin of unsafe) for (const field of ['hotspotOrigin', 'appOrigin']) {
    await assert.rejects(buildPages({ [field]: origin }), `${field}: ${String(origin)}`);
  }
  await assert.rejects(buildPages({ hotspotOrigin: 'https://portal.example.com', appOrigin: 'https://portal.example.com/' }));
  for (const siteLabel of ['', '   ', ' leading', 'trailing ', 'a'.repeat(81), 'line\nbreak', 'hidden\u202Etext', null]) {
    await assert.rejects(buildPages({ siteLabel }));
  }
  await assert.rejects(buildPages({ privateKey: 'DO_NOT_COPY' }));
  const siteLabel = 'Lawfield & <West> "\' $(error) \\';
  const pages = await buildPages({ siteLabel });
  for (const name of ['login.html', 'status.html']) {
    assert.ok(pages[name].includes('<span class="place">Lawfield &amp; &lt;West&gt; &quot;&#39; &#36;(error) \\</span>'));
    assert.doesNotMatch(pages[name], /<West>|\$\(error\)/);
  }
  const script = await buildInstall({ source: 'hotspot', target: 'new-hotspot', profile: 'https', site: { siteLabel } });
  assert.match(script, /&#36;\(error\)/);
  assert.doesNotMatch(script, /DO_NOT_COPY|<West>/);
});

test('CLI uses the public site config, writes a private new file and refuses overwrite or malformed input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pasofi-welcome-'));
  try {
    const config = join(dir, 'site.json'), output = join(dir, 'welcome.rsc');
    await writeFile(config, JSON.stringify({ siteLabel: 'Lawfield Farm', hotspotOrigin: 'https://lawfield.example.com', appOrigin: 'https://portal.example.com' }));
    const cli = fileURLToPath(new URL('./build-install.mjs', import.meta.url));
    const args = [cli, 'hotspot', 'flash/lawfield-welcome', 'https-pilot', output, config];
    const generated = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const text = await readFile(output, 'utf8');
    assert.match(text, /Lawfield Farm/);
    assert.match(text, /dns-name\] != "lawfield\.example\.com"/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.notEqual(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0);
    assert.equal(await readFile(output, 'utf8'), text);
    await writeFile(config, 'not-json-DO_NOT_ECHO');
    const invalid = spawnSync(process.execPath, [cli, 'hotspot', 'new-portal', 'https', join(dir, 'bad.rsc'), config], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Invalid site configuration JSON/);
    assert.doesNotMatch(invalid.stderr, /DO_NOT_ECHO/);
    await assert.rejects(stat(join(dir, 'bad.rsc')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
