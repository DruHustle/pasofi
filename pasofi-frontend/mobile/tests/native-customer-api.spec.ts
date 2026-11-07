import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const apiOrigin = 'https://api.pamofi.test';
const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type NativeRequest = { requestId: string; path: string; method: string; data?: string; idempotencyKey?: string; responseType: 'json' | 'pdf' };
type NativeReply = { requestId?: string; status: number; data: unknown; contentType: string; retryAfterMs?: number };
type NativeFailure = { nativeFailure: { code: string; message?: string } };
const reply = (data: unknown, status = 200): NativeReply => ({ status, data, contentType: 'application/json' });
const capabilities = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true,
  staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: true, nativeCustomerApiVersion: 1 };

const test = base.extend<{}, { configuredBaseURL: string }>({
  configuredBaseURL: [async ({}, use) => {
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => {
        const address = socket.address(); if (!address || typeof address === 'string') return reject(Error('No loopback address'));
        socket.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const directory = fileURLToPath(new URL('../', import.meta.url));
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: directory, env: { ...process.env, VITE_PAMOFI_API_BASE_URL: apiOrigin }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; server.stdout.on('data', data => { output = (output + data).slice(-4000); }); server.stderr.on('data', data => { output = (output + data).slice(-4000); });
    const origin = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        if (server.exitCode !== null) throw Error(`Native test preview exited: ${output}`);
        try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw Error(`Native test preview unavailable: ${output}`);
      await use(origin);
    } finally {
      server.kill('SIGTERM');
      await new Promise<void>(resolve => { if (server.exitCode !== null) return resolve(); const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000); server.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  }, { scope: 'worker' }],
});

// This fixture mocks only the Capacitor boundary. The production API/session
// modules and React capability gate execute unchanged. Platform cookie/Keychain
// behavior is covered separately by the Android and Swift policy tests.
async function nativeBridge(page: Page, handler: (request: NativeRequest) => NativeReply | NativeFailure | Promise<NativeReply | NativeFailure>,
  options: { platform?: 'ios' | 'android'; availability?: Record<string, unknown>; absent?: boolean; cancel?: (requestId: string) => void } = {}) {
  const calls: { method: string; options: Record<string, unknown> }[] = [];
  await page.exposeFunction('__syntheticCustomerApi', async (method: string, input: Record<string, unknown>) => {
    calls.push({ method, options: input });
    if (method === 'availability') return { requestId: input.requestId, configured: true, origin: apiOrigin, protocol: 1, ...options.availability };
    if (method === 'cancel') { options.cancel?.(String(input.requestId)); return { requestId: input.requestId }; }
    if (method === 'request') return { requestId: input.requestId, ...await handler(input as NativeRequest) };
    throw Error('Unexpected native method');
  });
  await page.addInitScript(({ platform, absent, apiOrigin }) => {
    const runtime = window as any;
    runtime.CapacitorCustomPlatform = { name: platform };
    runtime.Capacitor = {
      PluginHeaders: absent ? [] : [{ name: 'PasoFiCustomerApi', methods: ['availability', 'request', 'cancel'].map(name => ({ name, rtype: 'promise' })) }],
      nativePromise: (plugin: string, method: string, input: Record<string, unknown>) => {
        if (plugin !== 'PasoFiCustomerApi' || absent) return Promise.reject(Error('Native plugin unavailable'));
        return runtime.__syntheticCustomerApi(method, input).then((value: any) => {
          if (value?.nativeFailure) throw Object.assign(new Error(value.nativeFailure.message || value.nativeFailure.code), { code: value.nativeFailure.code });
          return value;
        });
      },
    };
    runtime.browserApiFetches = 0;
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).startsWith(apiOrigin)) { runtime.browserApiFetches++; return Promise.reject(Error('Unexpected browser API fallback')); }
      return originalFetch(input, init);
    };
  }, { platform: options.platform || 'ios', absent: !!options.absent, apiOrigin });
  return calls;
}

test('native build fails closed without its bridge or exact pinned origin/protocol and never falls back to browser fetch', async ({ page, configuredBaseURL }) => {
  const calls = await nativeBridge(page, () => reply(capabilities), { absent: true });
  await page.goto(configuredBaseURL);
  const result = await page.evaluate(async () => {
    const path = '/src/api.ts', { api } = await import(path);
    try { await api('/api/capabilities'); return { accepted: true }; } catch { return { accepted: false }; }
  });
  expect(result.accepted).toBe(false); expect(calls.filter(call => call.method === 'request')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).browserApiFetches)).toBe(0);
});

for (const availability of [{ configured: false }, { origin: 'https://different.pamofi.test' }, { protocol: 2 }, { requestId: orderId }]) {
  test(`native bridge refuses unqualified configuration ${JSON.stringify(availability)}`, async ({ page, configuredBaseURL }) => {
    const calls = await nativeBridge(page, () => reply(capabilities), { availability });
    await page.goto(configuredBaseURL);
    expect(await page.evaluate(async () => { const path = '/src/api.ts', { api } = await import(path); try { await api('/api/capabilities'); return true; } catch { return false; } })).toBe(false);
    expect(calls.filter(call => call.method === 'request')).toHaveLength(0);
    expect(await page.evaluate(() => (window as any).browserApiFetches)).toBe(0);
  });
}

for (const patch of [{ nativeCustomerApiVersion: undefined }, { nativeCustomerApiVersion: 2 }, { mobileCookies: false }]) {
  test(`native account UI requires qualified cookie protocol version1 ${JSON.stringify(patch)}`, async ({ page, configuredBaseURL }) => {
    const requests: NativeRequest[] = [];
    await nativeBridge(page, request => { requests.push(request); return reply({ ...capabilities, ...patch }); });
    await page.goto(configuredBaseURL); await page.getByRole('button', { name: 'My PasoFi', exact: true }).click();
    await expect(page.getByText('Mobile account access is not enabled', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use a voucher' })).toHaveCount(0);
    expect(requests.length).toBeGreaterThan(0); expect(new Set(requests.map(request => request.path))).toEqual(new Set(['/api/capabilities']));
    expect(await page.evaluate(() => (window as any).browserApiFetches)).toBe(0);
  });
}

for (const platform of ['ios', 'android'] as const) {
  test(`${platform} account creation keeps retry custody native while customer mutations preserve their idempotency keys`, async ({ page, configuredBaseURL }) => {
    const requests: NativeRequest[] = []; let hasSession = false;
    await nativeBridge(page, request => {
      requests.push(request);
      if (request.path === '/api/session') {
        if (request.method === 'POST') { hasSession = true; return reply({ customerId }, 201); }
        return hasSession ? reply({ customerId }) : reply({ error: 'not_authenticated' }, 401);
      }
      if (request.path === '/api/orders') return reply({ order: { id: orderId } }, 201);
      throw Error('Unexpected request');
    }, { platform });
    await page.goto(configuredBaseURL);
    const result = await page.evaluate(async () => {
      const sessionPath = '/src/session.ts', apiPath = '/src/api.ts';
      const { ensureSession } = await import(sessionPath), { api } = await import(apiPath);
      const identities = await Promise.all([ensureSession(), ensureSession()]);
      const key = crypto.randomUUID();
      const order = await api('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ bundleId: 'flex' }) });
      return { identities, key, order, creationRetry: sessionStorage.getItem('pamofi.sessionCreationRetry'), local: JSON.stringify(localStorage), fetches: (window as any).browserApiFetches };
    });
    expect(result.identities).toEqual([customerId, customerId]); expect(result.order).toEqual({ order: { id: orderId } });
    expect(result.creationRetry).toBeNull(); expect(result.local).toBe('{}'); expect(result.fetches).toBe(0);
    expect(requests.filter(request => request.path === '/api/session').map(request => request.method)).toEqual(['GET', 'POST', 'GET']);
    const creation = requests.find(request => request.path === '/api/session' && request.method === 'POST')!;
    expect(creation).not.toHaveProperty('idempotencyKey');
    const order = requests.find(request => request.path === '/api/orders')!;
    expect(order.idempotencyKey).toBe(result.key); expect(JSON.parse(order.data!)).toEqual({ bundleId: 'flex' });
    for (const request of requests) {
      expect(request.requestId).toMatch(uuid); expect(request.responseType).toBe('json');
      expect(Object.keys(request).every(key => ['requestId', 'path', 'method', 'data', 'idempotencyKey', 'responseType'].includes(key))).toBe(true);
    }
  });
}

test('an ambiguous native account-creation failure retries through private native custody without minting a JS retry secret', async ({ page, configuredBaseURL }) => {
  const requests: NativeRequest[] = []; let creations = 0, hasSession = false;
  await nativeBridge(page, request => {
    requests.push(request);
    if (request.path !== '/api/session') throw Error('Unexpected request');
    if (request.method === 'POST') { creations++; if (creations === 1) throw Error('Synthetic lost response'); hasSession = true; return reply({ customerId }, 201); }
    return hasSession ? reply({ customerId }) : reply({ error: 'not_authenticated' }, 401);
  });
  await page.goto(configuredBaseURL);
  expect(await page.evaluate(async () => { const path = '/src/session.ts', { ensureSession } = await import(path); try { await ensureSession(); return false; } catch { return true; } })).toBe(true);
  // A restarted WebView has no JS retry credential to recover or accidentally replace.
  await page.reload();
  expect(await page.evaluate(async () => { const path = '/src/session.ts', { ensureSession } = await import(path); return ensureSession(); })).toBe(customerId);
  expect(creations).toBe(2);
  for (const request of requests.filter(request => request.method === 'POST')) expect(request).not.toHaveProperty('idempotencyKey');
  expect(await page.evaluate(() => sessionStorage.getItem('pamofi.sessionCreationRetry'))).toBeNull();
});

for (const code of ['session_changed', 'logout_pending']) {
  test(`native ${code} session read cannot create a replacement account`, async ({ page, configuredBaseURL }) => {
    const requests: NativeRequest[] = [];
    await nativeBridge(page, request => { requests.push(request); return { nativeFailure: { code } }; });
    await page.goto(configuredBaseURL);
    const result = await page.evaluate(async () => {
      const path = '/src/session.ts', { ensureSession } = await import(path);
      try { await ensureSession(); return { accepted: true }; } catch (error) { return { accepted: false, code: (error as { code?: string }).code }; }
    });
    expect(result).toEqual({ accepted: false, code });
    expect(requests.map(request => `${request.method} ${request.path}`)).toEqual(['GET /api/session']);
    expect(await page.evaluate(() => sessionStorage.getItem('pamofi.sessionCreationRetry'))).toBeNull();
  });
}

test('native OS failures expose only fixed error codes and reject JS attempts to supply authority headers', async ({ page, configuredBaseURL }) => {
  const requests: NativeRequest[] = [];
  await nativeBridge(page, request => { requests.push(request); return { nativeFailure: { code: 'untrusted_os_code', message: 'https://private.invalid/?cookie=SYNTHETIC_PRIVATE_MATERIAL' } }; });
  await page.goto(configuredBaseURL);
  const result = await page.evaluate(async () => {
    const path = '/src/api.ts', { api } = await import(path), failures = [];
    for (const headers of [{ Cookie: '__Host-pamofi_session=synthetic' }, { Origin: 'https://evil.test' }, { Authorization: 'Bearer synthetic' },
      { 'X-PasoFi-Native-Customer': '1' }, { 'X-Pamofi-Client-Ip': '192.0.2.1' }]) {
      try { await api('/api/session', { headers }); failures.push('accepted'); } catch (error) { failures.push((error as { code?: string }).code); }
    }
    let nativeFailure;
    try { await api('/api/session'); } catch (error) { nativeFailure = { code: (error as { code?: string }).code, message: (error as Error).message }; }
    return { failures, nativeFailure };
  });
  expect(result.failures).toEqual(Array(5).fill('native_request_rejected'));
  expect(result.nativeFailure).toEqual({ code: 'request_failed', message: 'request_failed' });
  expect(requests).toHaveLength(1);
});

test('native refuses an old response ID before releasing its private data to the caller', async ({ page, configuredBaseURL }) => {
  await nativeBridge(page, () => ({ ...reply({ customerId }), requestId: orderId }));
  await page.goto(configuredBaseURL);
  const result = await page.evaluate(async () => {
    const path = '/src/api.ts', { api } = await import(path);
    try { return { accepted: true, data: await api('/api/session') }; }
    catch (error) { return { accepted: false, code: (error as { code?: string }).code }; }
  });
  expect(result).toEqual({ accepted: false, code: 'native_response_rejected' });
});

test('native API preserves rate-limit errors and exact invoice PDF bytes without returning headers or browser cookies', async ({ page, configuredBaseURL }) => {
  const pdf = '%PDF-1.4\nsynthetic invoice\n%%EOF';
  const requests: NativeRequest[] = [];
  await nativeBridge(page, request => {
    requests.push(request);
    if (request.path === '/api/session') return { ...reply({ error: 'rate_limited' }, 429), retryAfterMs: 20_000 };
    if (request.path === `/api/customer/invoices/${orderId}/pdf`) return { status: 200, data: Buffer.from(pdf).toString('base64'), contentType: 'application/pdf' };
    throw Error('Unexpected request');
  });
  await page.goto(configuredBaseURL);
  const result = await page.evaluate(async ({ orderId }) => {
    const path = '/src/api.ts', { api, apiPdf } = await import(path);
    let failure;
    try { await api('/api/session'); } catch (error) { const value = error as { status: number; code: string; retryAfterMs?: number }; failure = { status: value.status, code: value.code, retryAfterMs: value.retryAfterMs }; }
    const invoice = await apiPdf(`/api/customer/invoices/${orderId}/pdf`);
    return { failure, text: await invoice.text(), type: invoice.type, cookie: document.cookie, fetches: (window as any).browserApiFetches };
  }, { orderId });
  expect(result.failure).toEqual({ status: 429, code: 'rate_limited', retryAfterMs: 20_000 });
  expect(result.text).toBe(pdf); expect(result.type).toBe('application/pdf'); expect(result.cookie).toBe(''); expect(result.fetches).toBe(0);
  expect(requests.at(-1)?.responseType).toBe('pdf');
});

test('native invoice decoding rejects disguised or excessive PDF data', async ({ page, configuredBaseURL }) => {
  let attempt = 0;
  await nativeBridge(page, () => {
    const body = attempt++ === 0 ? '<html>not a PDF</html>' : '%PDF-' + 'x'.repeat(2 * 1024 * 1024);
    return { status: 200, data: Buffer.from(body).toString('base64'), contentType: 'application/pdf' };
  });
  await page.goto(configuredBaseURL);
  const result = await page.evaluate(async ({ orderId }) => {
    const path = '/src/api.ts', { apiPdf } = await import(path), accepted = [];
    for (let i = 0; i < 2; i++) { try { await apiPdf(`/api/customer/invoices/${orderId}/pdf`); accepted.push(true); } catch { accepted.push(false); } }
    return accepted;
  }, { orderId });
  expect(result).toEqual([false, false]);
});

test('aborting an active native request cancels its exact request ID and cannot return a late private response', async ({ page, configuredBaseURL }) => {
  let pending: { requestId: string; resolve: (value: NativeReply) => void } | undefined;
  const calls = await nativeBridge(page, request => new Promise<NativeReply>(resolve => { pending = { requestId: request.requestId, resolve }; }));
  await page.goto(configuredBaseURL);
  await page.evaluate(async () => {
    const path = '/src/api.ts', { api } = await import(path), runtime = window as any;
    runtime.nativeAbort = new AbortController();
    runtime.nativePending = api('/api/session', { signal: runtime.nativeAbort.signal }).then((data: unknown) => ({ accepted: true, data }), () => ({ accepted: false }));
  });
  await expect.poll(() => pending?.requestId).toMatch(uuid);
  await page.evaluate(() => (window as any).nativeAbort.abort());
  await expect.poll(() => calls.filter(call => call.method === 'cancel').length).toBe(1);
  expect(calls.find(call => call.method === 'cancel')?.options.requestId).toBe(pending!.requestId);
  pending!.resolve(reply({ customerId }));
  expect(await page.evaluate(() => (window as any).nativePending)).toEqual({ accepted: false });
});
