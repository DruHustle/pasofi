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
function render(source, vars, response = {}) {
  source = source.replace(/^\$\(if http-(status|header) == (\d{3}|"[^"]+")\)([^\n]*)\$\(endif\)\n/gm,
    (_, kind, target, value) => {
      if (kind === 'status') response.status = Number(target);
      else (response.headers ??= {})[JSON.parse(target)] = value;
      return '';
    });
  const stack = []; let active = true;
  return source.split(/(\$\([^)]*\))/g).map(part => {
    if (!part.startsWith('$(')) return active ? part : '';
    const token = part.slice(2, -1);
    if (token.startsWith('if ')) {
      const [, key, operator, quoted, literal] = /^if ([\w-]+)(?: (==|!=) (?:'([^']*)'|(\d+)))?$/.exec(token) ?? [];
      if (!key) throw Error(`Unsupported conditional ${token}`);
      const value = vars[key] ?? '';
      const expected = quoted ?? literal;
      const pass = operator === '==' ? value === expected : operator === '!=' ? value !== expected : !!value && value !== '0';
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
  assert.match(eligible, /Your first<br>5 minutes are on us/);
  assert.match(eligible, /Start my free 5 minutes/);
  assert.match(eligible, /5 minutes per device every 24 hours/);
  assert.doesNotMatch(render(source, { trial: 'no' }), /Start my free 5 minutes/);
  assert.match(eligible, /id="welcome" action="https:\/\/login\.pasofi\.mobile\.onesa\.eu\/login" method="post"/);
  assert.match(eligible, /getElementById\('welcome'\).submit/);
  for (const vars of [{ trial: 'no' }, { trial: 'yes', error: 'failed' }]) {
    assert.doesNotMatch(render(source, vars), /<script>/);
  }
  assert.doesNotMatch(render(source, { trial: 'no' }), /id="welcome"/);
  for (const label of ['View bundles', 'Redeem a voucher']) assert.match(render(source, { trial: 'no' }), new RegExp(label));
  assert.doesNotMatch(source, /\$\((?:link-orig|error|username)\)/);
});
function statusPage(template, vars, supportsModal = true) {
  const source = render(template, vars);
  const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1];
  const page = { now: 0, opened: 0, events: {}, elements: { 'connection-title': {}, 'connection-message': {}, expiry: {} } };
  const { elements } = page;
  if (vars['login-by'] === 'trial') {
    elements.remaining = {};
    elements['trial-clock'] = {};
  }
  if (supportsModal) elements.expiry.showModal = () => page.opened++;
  page.document = { getElementById: id => elements[id] ?? null,
    addEventListener: (event, callback) => { page.events[event] = callback; } };
  vm.runInNewContext(script, {
    Date: { now: () => page.now },
    document: page.document,
    window: { addEventListener: (event, callback) => { page.events[event] = callback; } },
    setInterval: callback => { page.tick = callback; return 42; },
    clearInterval: timer => { page.cancelled = timer; },
  });
  return Object.assign(page, { source });
}

test('the expiry dialog opens once when the trial status page returns to the foreground', async () => {
  const state = statusPage(await read('status.html'),
    { 'login-by': 'trial', 'session-time-left-secs': '300' });
  const { source, elements } = state;
  const dialog = /<dialog[^>]*>([\s\S]*?)<\/dialog>/.exec(source)[1];
  assert.match(dialog, /#bundles" autofocus>View bundles/);
  assert.match(dialog, /#voucher">Redeem a voucher/);
  assert.match(dialog, /method="dialog"><button>Dismiss/);
  assert.equal(elements.remaining.textContent, '5:00');
  state.now = 65_000;
  state.tick();
  assert.equal(elements.remaining.textContent, '3:55');
  assert.equal(state.opened, 0);
  state.document.hidden = true;
  state.now = 330_000;
  state.tick();
  assert.equal(state.opened, 0);
  state.document.hidden = false;
  state.events.visibilitychange();
  state.events.pageshow();
  assert.equal(elements['connection-title'].textContent, 'Your welcome time has ended.');
  assert.match(elements['connection-message'].textContent, /redeem a voucher/);
  assert.equal(elements['trial-clock'].hidden, true);
  assert.equal(state.cancelled, 42);
  assert.equal(state.opened, 1);
});

test('timed sessions prompt while open and untimed sessions stay online', async () => {
  const template = await read('status.html');
  const timed = statusPage(template, { 'login-by': 'https', 'session-time-left-secs': '2' });
  timed.now = 2000;
  timed.tick();
  assert.equal(timed.opened, 1);
  assert.equal(timed.elements['connection-title'].textContent, 'Your PasoFi session has ended.');
  const fallback = statusPage(template, { 'login-by': 'trial', 'session-time-left-secs': '0' }, false);
  assert.match(fallback.elements['connection-message'].textContent, /redeem a voucher/);
  for (const duration of ['', '0', 'invalid']) {
    const untimed = statusPage(template, { 'login-by': 'https', 'session-time-left-secs': duration });
    assert.equal(untimed.tick, undefined);
    assert.equal(untimed.opened, 0);
  }
});
test('installer escapes templates, preserves the original folder, and changes no access controls', async () => {
  assert.equal(routerString('$x"\\\n'), '"\\$x\\"\\\\\\n"');
  assert.equal(routerString('→'), '"\\E2\\86\\92"');
  const script = await buildInstall({ source: 'old-portal', target: 'new-portal', profile: 'https-pilot' });
  assert.ok(script.indexOf('Target exists') < script.indexOf('/file copy'));
  assert.ok(script.indexOf('A separate portal override is active') < script.indexOf('/file copy'));
  assert.ok(script.indexOf('Portal file verification failed') < script.indexOf('html-directory=$target'));
  for (const page of ['api.json', 'rlogin.html', 'fstatus.html', 'flogout.html', 'flogin.html']) {
    assert.ok(script.includes(`/${page}"`), page);
  }
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
  const fallback = { 'fstatus.html': 'rlogin.html', 'flogout.html': 'rlogin.html', 'flogin.html': 'login.html' };
  for (const [name, content] of Object.entries(pages)) assert.equal(content, await read(fallback[name] ?? name), name);
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
  for (const name of ['login.html', 'flogin.html', 'status.html', 'logout.html']) {
    const page = render(pages[name], { trial: 'no' });
    assert.match(page, /href="https:\/\/portal\.example\.com\/connect#bundles"/);
    assert.match(page, /href="https:\/\/portal\.example\.com\/connect#voucher"/);
  }
  assert.match(pages['alogin.html'], /content="0;url=https:\/\/hotspot-lawfield\.example\.com\/status"/);
  const installer = await buildInstall({ source: 'hotspot', target: 'flash/lawfield-welcome', profile: 'lawfield-https', site });
  assert.match(installer, /dns-name\] != "hotspot-lawfield\.example\.com"/);
  assert.doesNotMatch(installer, /login-by=|\/ip firewall|walled-garden|\/radius|disabled=no|password=/);
  // Swapping the two default names must not replace an inserted origin twice.
  const swapped = await buildPages({ hotspotOrigin: 'https://hotspot.pasofi.mobile.onesa.eu', appOrigin: 'https://login.pasofi.mobile.onesa.eu' });
  assert.match(swapped['login.html'], /action="https:\/\/hotspot\.pasofi\.mobile\.onesa\.eu\/login"/);
  assert.match(swapped['login.html'], /href="https:\/\/login\.pasofi\.mobile\.onesa\.eu\/connect#voucher"/);
});

test('captive network detection and status retries lead to the site’s trusted login after expiry', async () => {
  for (const site of [
    { siteLabel: 'Kuwadzana', hotspotOrigin: 'https://kuwadzana.example.net' },
    { siteLabel: 'Goromonzi', hotspotOrigin: 'https://goromonzi.example.net' },
  ]) {
    const pages = await buildPages({ ...site, appOrigin: 'https://portal.example.net' });
    for (const name of ['rlogin.html', 'fstatus.html', 'flogout.html']) {
      const response = {};
      const page = render(pages[name], { 'link-orig': 'https://outside.example.net/?session=private' }, response);
      assert.equal(response.status, 302);
      assert.equal(response.headers.Location, `${site.hotspotOrigin}/login`);
      assert.match(page, /href="https:\/\/portal\.example\.net\/connect#voucher"/);
      assert.doesNotMatch(page, /outside\.example\.net|session=private/);
    }

    const response = {};
    const venue = { 'venue-info-url': 'https://portal.example.net/connect' };
    const active = { 'logged-in': 'yes', 'session-timeout-secs': '167', 'remain-bytes-total': '8123' };
    assert.deepEqual(JSON.parse(render(pages['api.json'], active, response)), {
      ...venue, captive: false, 'user-portal-url': `${site.hotspotOrigin}/status`,
      'seconds-remaining': 167, 'bytes-remaining': 8123,
    });
    assert.deepEqual(response.headers, { 'Content-Type': 'application/captive+json', 'Cache-Control': 'private, no-store' });
    for (const state of [{ 'logged-in': 'yes', 'session-timeout-secs': '0' }, { 'logged-in': 'yes' }]) {
      assert.deepEqual(JSON.parse(render(pages['api.json'], state)), {
        ...venue, captive: false, 'user-portal-url': `${site.hotspotOrigin}/status`,
      });
    }
    assert.deepEqual(JSON.parse(render(pages['api.json'], { ...active, 'logged-in': 'no' })), {
      ...venue, captive: true, 'user-portal-url': `${site.hotspotOrigin}/login`,
    });
  }
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
