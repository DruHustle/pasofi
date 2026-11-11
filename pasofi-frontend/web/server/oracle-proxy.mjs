import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

// This module is server-only. Vite never imports it into the customer bundle.
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const rules = [
  [/^\/api\/(bundles|capabilities|sites|access|usage|help|payments\/methods)$/, ['GET']],
  [/^\/api\/orders$/, ['GET', 'POST']],
  [new RegExp(`^/api/orders/${UUID}/status$`), ['GET']],
  [new RegExp(`^/api/orders/${UUID}/(demo-confirm|checkout|mock-payment|expire-unused)$`), ['POST']],
  [/^\/api\/session$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/recovery\/status$/, ['GET']],
  [/^\/api\/(recovery(?:\/(setup|rotate))?|handoff(?:\/redeem)?)$/, ['POST']],
  [/^\/api\/onesa\/availability$/, ['GET']],
  [/^\/api\/onesa\/(start|complete)$/, ['POST']],
  [/^\/api\/staff\/onesa\/availability$/, ['GET']],
  [/^\/api\/staff\/onesa\/(start|complete)$/, ['POST']],
  [/^\/api\/staff\/(register|login|mfa\/(setup|confirm|verify))$/, ['POST']],
  [/^\/api\/staff\/password-reset\/availability$/, ['GET']],
  [/^\/api\/staff\/password-reset\/(request|confirm)$/, ['POST']],
  [/^\/api\/staff\/session$/, ['GET', 'DELETE']],
  [/^\/api\/staff\/(users|audit|sites|inventory)$/, ['GET']],
  [new RegExp(`^/api/staff/users/${UUID}/(decision|revoke-sessions|recover-mfa)$`), ['POST']],
  [/^\/api\/staff\/cash-refunds$/, ['GET', 'POST']],
  [new RegExp(`^/api/staff/cash-refunds/${UUID}/(prepare-payout|payout)$`), ['POST']],
  [new RegExp(`^/api/admin/cash-refunds/${UUID}/decision$`), ['POST']],
  [/^\/api\/staff\/cash-shifts$/, ['GET', 'POST']],
  [new RegExp(`^/api/staff/cash-shifts/${UUID}/close$`), ['POST']],
  [/^\/api\/staff\/sales$/, ['GET', 'POST']],
  [new RegExp(`^/api/staff/sales/${UUID}/(receipt|delivery)$`), ['GET']],
  [new RegExp(`^/api/staff/sales/${UUID}/resend$`), ['POST']],
  [new RegExp(`^/api/(customer|staff)/invoices(?:/${UUID}(?:/pdf)?)?$`), ['GET']],
  [/^\/api\/invoice-downloads$/, ['POST']],
  [/^\/api\/admin\/(sites|inventory\/allocations)$/, ['POST']],
  [new RegExp(`^/api/admin/sites/${UUID}$`), ['PATCH']],
  [/^\/api\/admin\/network\/reviews$/, ['GET']],
  [new RegExp(`^/api/admin/network/reviews/${UUID}/resolve$`), ['POST']],
  [/^\/api\/admin\/routers$/, ['GET']],
  [new RegExp(`^/api/admin/routers/${UUID}$`), ['GET']],
  [new RegExp(`^/api/admin/routers/${UUID}/changes$`), ['GET', 'POST']],
  [new RegExp(`^/api/admin/routers/${UUID}/changes/${UUID}$`), ['GET']],
  [new RegExp(`^/api/admin/routers/${UUID}/changes/${UUID}/(apply|reconcile|rollback)$`), ['POST']],
  [/^\/api\/admin\/bundles$/, ['GET', 'POST']],
  [/^\/api\/admin\/bundles\/[a-z][a-z0-9-]{0,39}$/, ['PATCH']],
  [/^\/api\/receipt-pairings$/, ['POST']],
  [new RegExp(`^/api/receipt-pairings/${UUID}/cancel$`), ['POST']],
  [/^\/api\/staff\/cash-references\/lookup$/, ['POST']],
  [new RegExp(`^/api/receipt-pairings/${UUID}$`), ['GET']],
  [/^\/api\/vouchers\/redeem$/, ['POST']],
  [/^\/api\/network\/(sites|session)$/, ['GET']],
  [/^\/api\/network\/(credentials|disconnect)$/, ['POST']],
];
// The native marker selects a narrower public customer protocol. It is not an
// authentication credential and cannot grant staff or service authority.
const nativeCustomerRules = [
  [/^\/api\/onesa\/availability$/, ['GET']],
  [/^\/api\/(bundles|capabilities|sites|access|usage|help|payments\/methods)$/, ['GET']],
  [/^\/api\/orders$/, ['GET', 'POST']],
  [new RegExp(`^/api/orders/${UUID}/status$`), ['GET']],
  [new RegExp(`^/api/orders/${UUID}/(checkout|mock-payment|expire-unused)$`), ['POST']],
  [/^\/api\/session$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/recovery\/status$/, ['GET']],
  [/^\/api\/(recovery(?:\/(setup|rotate))?|handoff(?:\/redeem)?)$/, ['POST']],
  [new RegExp(`^/api/customer/invoices(?:/${UUID}(?:/pdf)?)?$`), ['GET']],
  [/^\/api\/invoice-downloads$/, ['POST']],
  [/^\/api\/receipt-pairings$/, ['POST']],
  [new RegExp(`^/api/receipt-pairings/${UUID}/cancel$`), ['POST']],
  [new RegExp(`^/api/receipt-pairings/${UUID}$`), ['GET']],
  [/^\/api\/vouchers\/redeem$/, ['POST']],
  [/^\/api\/network\/(sites|session)$/, ['GET']],
  [/^\/api\/network\/(credentials|disconnect)$/, ['POST']],
];
const BODY_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const cookieNames = new Set(['__Host-pamofi_session', '__Host-pamofi_staff_session', '__Host-pamofi_staff_challenge', '__Host-pasofi_onesa_flow', '__Host-pasofi_onesa_customer_flow']);
const nativeCookieNames = new Set(['__Host-pamofi_session']);

class ProxyError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function origin(value) {
  if (typeof value !== 'string' || value.length > 253) throw new ProxyError(503, 'api_unconfigured');
  let url;
  try { url = new URL(value); } catch { throw new ProxyError(503, 'api_unconfigured'); }
  if (value !== url.origin || url.protocol !== 'https:' || url.username || url.password || url.port ||
      isIP(url.hostname) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
      url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) throw new ProxyError(503, 'api_unconfigured');
  return url;
}

function configuration(env) {
  if (env.VERCEL !== '1' || env.NODEJS_HELPERS !== '0' || typeof env.PAMOFI_VERCEL_PROXY_TOKEN !== 'string' || !/^[0-9a-f]{64}$/.test(env.PAMOFI_VERCEL_PROXY_TOKEN)) {
    throw new ProxyError(503, 'api_unconfigured');
  }
  const upstream = origin(env.PAMOFI_ORACLE_API_ORIGIN), frontend = origin(env.PAMOFI_PUBLIC_ORIGIN);
  let aliases;
  try { aliases = env.PASOFI_PUBLIC_ORIGIN_ALIASES ? JSON.parse(env.PASOFI_PUBLIC_ORIGIN_ALIASES) : []; }
  catch { throw new ProxyError(503, 'api_unconfigured'); }
  if (!Array.isArray(aliases) || aliases.length > 3) throw new ProxyError(503, 'api_unconfigured');
  const frontends = [frontend, ...aliases.map(origin)];
  if (frontends.some(value => upstream.origin === value.origin)) throw new ProxyError(503, 'api_unconfigured');
  return { upstream, frontends, token: env.PAMOFI_VERCEL_PROXY_TOKEN,
    nativeCustomerEnabled: env.PAMOFI_NATIVE_CUSTOMER_ENABLED === 'true' && env.PAMOFI_NATIVE_CUSTOMER_QUALIFIED === 'true' };
}

function header(req, name, limit = 8192) {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  // Reject duplicated headers even where Node would otherwise join/drop them.
  let count = 0;
  for (let i = 0; i < (req.rawHeaders?.length || 0); i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  if (count > 1 || typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new ProxyError(400, 'invalid_request');
  return value;
}

export function canonicalClientIp(value) {
  if (typeof value !== 'string' || value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) throw new ProxyError(400, 'invalid_client_address');
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) throw new ProxyError(400, 'invalid_client_address');
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // Nginx and Node differ in textual formatting of mapped addresses. Send IPv4.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
  }
  return canonical;
}

export function publicRoute(rawUrl, method) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096 || /[\x00-\x20\x7f\\#]/.test(rawUrl) || /%(?![0-9a-fA-F]{2})/.test(rawUrl)) {
    throw new ProxyError(400, 'invalid_request');
  }
  const separator = rawUrl.indexOf('?');
  let path = separator < 0 ? rawUrl : rawUrl.slice(0, separator);
  const query = separator < 0 ? '' : rawUrl.slice(separator + 1);
  const remaining = [], rewritten = [], sourcePaths = [];
  for (const part of query ? query.split('&') : []) {
    const equals = part.indexOf('='), key = equals < 0 ? part : part.slice(0, equals), value = equals < 0 ? '' : part.slice(equals + 1);
    let decoded;
    try { decoded = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { throw new ProxyError(400, 'invalid_request'); }
    if (decoded === '__pamofi_path' || decoded === 'path') {
      // Vercel appends the named :path* source capture as `path` in
      // addition to our explicit rewrite parameter. Neither is application data.
      try { (decoded === 'path' ? sourcePaths : rewritten).push(decodeURIComponent(value.replace(/\+/g, ' '))); }
      catch { throw new ProxyError(400, 'invalid_request'); }
    } else remaining.push(part);
  }
  if (rewritten.length > 1 || sourcePaths.length > 1) throw new ProxyError(400, 'invalid_request');
  // Vercel may present the original URL or the internal rewrite destination.
  // The reserved rewrite value can choose only a public route, never an origin.
  if (path === '/api/gateway') {
    if (rewritten.length !== 1) throw new ProxyError(404, 'not_found');
    path = `/api/${rewritten[0]}`;
  } else if (rewritten.length && path !== `/api/${rewritten[0]}`) throw new ProxyError(400, 'invalid_request');
  if (!/^\/api\/[A-Za-z0-9/-]+$/.test(path)) throw new ProxyError(404, 'not_found');
  if (sourcePaths.length && sourcePaths[0] !== path.slice('/api/'.length)) throw new ProxyError(400, 'invalid_request');
  const rule = rules.find(([pattern]) => pattern.test(path));
  if (!rule) throw new ProxyError(404, 'not_found');
  const methods = rule[1].includes('GET') ? [...rule[1], 'HEAD'] : rule[1];
  if (!methods.includes(method)) throw new ProxyError(405, 'method_not_allowed');
  return { path, target: `${path}${remaining.length ? `?${remaining.join('&')}` : ''}` };
}

export function nativeCustomerRoute(path, method) {
  return nativeCustomerRules.some(([pattern, methods]) => pattern.test(path) && methods.includes(method));
}

function validateNativeQuery(route, method) {
  const query = new URL(route.target, 'https://native.invalid').searchParams;
  if ([...query].length === 0) return;
  if (method !== 'GET') throw new ProxyError(400, 'invalid_request');
  const uuid = new RegExp(`^${UUID}$`), limit = /^(?:[1-9][0-9]?|100)$/, offset = /^(?:0|[1-9][0-9]{0,5}|1000000)$/;
  const pagination = [['limit', limit], ['offset', offset]];
  const allowed = new Map([
    ['/api/access', pagination],
    ['/api/usage', [['entitlementIds', new RegExp(`^${UUID}(,${UUID}){0,99}$`)]]],
    ['/api/orders', [['requestKey', /^[A-Za-z0-9_-]{16,128}$/]]],
    ['/api/payments/methods', [['siteId', uuid], ['bundleId', /^[a-z][a-z0-9-]{0,39}$/]]],
    ['/api/customer/invoices', [...pagination, ['saleId', uuid], ['orderId', uuid]]],
    ['/api/help', [['q', /^[^\x00-\x1f\x7f]{0,200}$/]]],
  ]);
  const fields = new Map(allowed.get(route.path) || []), seen = new Set();
  for (const [name, value] of query) {
    const pattern = fields.get(name);
    if (seen.has(name) || !pattern?.test(value)) throw new ProxyError(400, 'invalid_request');
    seen.add(name);
  }
}

function readBody(req, signal, method) {
  const length = header(req, 'content-length', 16), encoding = header(req, 'content-encoding', 32);
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > BODY_LIMIT)) throw new ProxyError(413, 'request_too_large');
  if (encoding !== undefined && encoding !== 'identity') throw new ProxyError(415, 'unsupported_content_encoding');
  const type = header(req, 'content-type', 128);
  if (type !== undefined && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new ProxyError(415, 'unsupported_content_type');
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); signal.removeEventListener('abort', abort); };
    const fail = (reason) => { cleanup(); req.pause(); reject(reason); };
    const error = () => fail(new ProxyError(400, 'invalid_request'));
    const aborted = () => fail(new ProxyError(499, 'request_cancelled'));
    const abort = () => fail(signal.reason);
    const data = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > BODY_LIMIT) return fail(new ProxyError(413, 'request_too_large'));
      chunks.push(bytes);
    };
    const end = () => {
      cleanup();
      if (length !== undefined && Number(length) !== size) return reject(new ProxyError(400, 'invalid_request'));
      if (size && (method === 'GET' || method === 'HEAD')) return reject(new ProxyError(400, 'unexpected_body'));
      if (size && !type) return reject(new ProxyError(415, 'unsupported_content_type'));
      resolve(Buffer.concat(chunks));
    };
    if (signal.aborted) return abort();
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
    signal.addEventListener('abort', abort, { once: true });
    if (req.readableEnded) end();
  });
}

function privateHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function publicCookies(value, allowedNames = cookieNames) {
  if (value === undefined) return undefined;
  const kept = [], seen = new Set();
  for (const part of value.split(';')) {
    const trimmed = part.trim(), equals = trimmed.indexOf('='), name = trimmed.slice(0, equals);
    if (equals < 1 || !allowedNames.has(name)) continue;
    if (seen.has(name)) throw new ProxyError(400, 'invalid_request');
    seen.add(name); kept.push(trimmed);
  }
  return kept.length ? kept.join('; ') : undefined;
}

function validateCookies(cookies, nativeCustomer = false) {
  if (!Array.isArray(cookies) || cookies.length > (nativeCustomer ? 1 : 8)) throw new ProxyError(502, 'upstream_unavailable');
  const allowedNames = nativeCustomer ? nativeCookieNames : cookieNames;
  for (const cookie of cookies) {
    if (typeof cookie !== 'string' || cookie.length > 8192 || /[\r\n\0]/.test(cookie)) throw new ProxyError(502, 'upstream_unavailable');
    const parts = cookie.split(';').map(part => part.trim()), name = parts[0].split('=', 1)[0];
    const attributes = parts.slice(1).map(part => part.toLowerCase());
    const keys = attributes.map(part => part.split('=', 1)[0].trim());
    if (!allowedNames.has(name) || !attributes.includes('secure') || !attributes.includes('httponly') ||
        !attributes.includes('path=/') || !attributes.includes('samesite=lax') || keys.includes('domain') || new Set(keys).size !== keys.length) {
      throw new ProxyError(502, 'upstream_unavailable');
    }
  }
  return cookies;
}

function validateNativeCookieTransition(path, method, response) {
  if (!response.cookies.length) return;
  const creating = method === 'POST' && ((path === '/api/session' && [200, 201].includes(response.status)) ||
    (['/api/recovery', '/api/handoff/redeem'].includes(path) && response.status === 200));
  const clearing = method === 'DELETE' && path === '/api/session' && response.status === 204;
  const parts = response.cookies[0].split(';').map(part => part.trim());
  if (!parts[0].startsWith('__Host-pamofi_session=')) throw new ProxyError(502, 'upstream_unavailable');
  const value = parts[0].slice('__Host-pamofi_session='.length);
  if (creating && /^[A-Za-z0-9_-]{43}$/.test(value)) return;
  if (clearing && value === '') {
    const attributes = parts.slice(1).map(part => part.toLowerCase());
    const maxAge = attributes.find(part => part.startsWith('max-age='));
    const expires = attributes.find(part => part.startsWith('expires='));
    if ((maxAge === undefined || maxAge === 'max-age=0') &&
        (maxAge === 'max-age=0' || (expires !== undefined && Date.parse(expires.slice('expires='.length)) <= Date.now()))) return;
  }
  throw new ProxyError(502, 'upstream_unavailable');
}

function oracleRequest(request, url, options, body, signal, allowPdf = false, nativeCustomer = false) {
  return new Promise((resolve, reject) => {
    let upstream, incoming, settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const fail = (error) => {
      if (settled) return;
      settled = true; cleanup(); incoming?.destroy(); upstream?.destroy();
      reject(error instanceof ProxyError ? error : new ProxyError(502, 'upstream_unavailable'));
    };
    const abort = () => fail(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      upstream = request(url, { ...options, rejectUnauthorized: true }, response => {
        incoming = response;
        const status = response.statusCode;
        if (!Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) return fail(new ProxyError(502, 'upstream_unavailable'));
        const type = response.headers['content-type'];
        const pdf = allowPdf && status === 200 && type === 'application/pdf';
        if (status !== 204 && !pdf && (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type))) return fail(new ProxyError(502, 'upstream_unavailable'));
        const disposition = pdf ? response.headers['content-disposition'] : undefined;
        if (pdf && (typeof disposition !== 'string' || !/^attachment; filename="[A-Za-z0-9-]{1,80}\.pdf"$/.test(disposition))) return fail(new ProxyError(502, 'upstream_unavailable'));
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return fail(new ProxyError(502, 'upstream_unavailable'));
        let cookies;
        try { cookies = validateCookies(response.headers['set-cookie'] || [], nativeCustomer); } catch (error) { return fail(error); }
        let size = 0; const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) return fail(new ProxyError(502, 'upstream_unavailable'));
          chunks.push(chunk);
        });
        response.once('error', fail);
        response.once('aborted', () => fail(new ProxyError(502, 'upstream_unavailable')));
        response.once('end', () => {
          if (settled) return;
          const bytes = Buffer.concat(chunks);
          if (pdf && options.method !== 'HEAD' && bytes.subarray(0, 5).toString() !== '%PDF-') return fail(new ProxyError(502, 'upstream_unavailable'));
          settled = true; cleanup();
          resolve({ status, type, disposition, cookies, retryAfter: response.headers['retry-after'], body: bytes });
        });
      });
      upstream.once('error', fail);
      // The request API makes one attempt and never follows redirects.
      upstream.end(body);
    } catch (error) { fail(error); }
  });
}

export function createProxyHandler({ env = process.env, request = httpsRequest, timeoutMs = 8000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 9000) throw new Error('Invalid proxy deadline');
  return async function proxy(req, res) {
    privateHeaders(res);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new ProxyError(504, 'upstream_timeout')), timeoutMs);
    timer.unref?.();
    const disconnected = () => { if (!res.writableEnded) controller.abort(new ProxyError(499, 'request_cancelled')); };
    res.once('close', disconnected);
    try {
      const config = configuration(env);
      const method = req.method || '';
      const route = publicRoute(req.url, method);
      const nativeMarker = header(req, 'x-pasofi-native-customer', 16);
      if (nativeMarker !== undefined && nativeMarker !== '1') throw new ProxyError(400, 'invalid_request');
      const nativeCustomer = nativeMarker === '1';
      const host = header(req, 'host', 253), sourceOrigin = header(req, 'origin', 253);
      const frontend = host && config.frontends.find(value => value.host === host.toLowerCase());
      if (!frontend) throw new ProxyError(403, 'origin_not_allowed');
      if ((sourceOrigin !== undefined && sourceOrigin !== frontend.origin) ||
          ((nativeCustomer || !['GET', 'HEAD'].includes(method)) && sourceOrigin !== frontend.origin)) throw new ProxyError(403, 'origin_not_allowed');
      if (nativeCustomer && !nativeCustomerRoute(route.path, method)) throw new ProxyError(404, 'not_found');
      if (nativeCustomer) validateNativeQuery(route, method);
      if (nativeCustomer && !config.nativeCustomerEnabled && route.path !== '/api/capabilities') throw new ProxyError(503, 'native_customer_disabled');
      const clientIp = canonicalClientIp(header(req, 'x-vercel-forwarded-for', 45));
      const body = await readBody(req, controller.signal, method);
      const allowPdf = route.path === '/api/invoice-downloads' || new RegExp(`^/api/(customer|staff)/invoices/${UUID}/pdf$`).test(route.path);
      const headers = { accept: allowPdf ? 'application/pdf, application/json' : 'application/json', 'accept-encoding': 'identity', 'x-pamofi-proxy-token': config.token, 'x-pamofi-client-ip': clientIp };
      for (const name of ['content-type', 'idempotency-key']) {
        const value = header(req, name);
        if (nativeCustomer && name === 'idempotency-key' && value !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new ProxyError(400, 'invalid_request');
        if (value !== undefined) headers[name] = value;
      }
      const cookies = publicCookies(header(req, 'cookie'), nativeCustomer ? nativeCookieNames : cookieNames);
      if (cookies !== undefined) headers.cookie = cookies;
      if (sourceOrigin !== undefined) headers.origin = sourceOrigin;
      if (body.length || ['POST', 'PATCH', 'DELETE'].includes(method)) headers['content-length'] = String(body.length);
      const response = await oracleRequest(request, new URL(route.target, config.upstream), { method, headers }, body, controller.signal, allowPdf, nativeCustomer);
      if (response.body.includes(Buffer.from(config.token)) || response.cookies.some(cookie => cookie.includes(config.token)) ||
          (typeof response.retryAfter === 'string' && response.retryAfter.includes(config.token))) throw new ProxyError(502, 'upstream_unavailable');
      if (nativeCustomer) validateNativeCookieTransition(route.path, method, response);
      if (nativeCustomer && route.path === '/api/capabilities' && response.status === 200) {
        let capabilities;
        try { capabilities = JSON.parse(response.body.toString('utf8')); } catch { throw new ProxyError(502, 'upstream_unavailable'); }
        if (!capabilities || Array.isArray(capabilities) || typeof capabilities !== 'object' || typeof capabilities.mobileCookies !== 'boolean') throw new ProxyError(502, 'upstream_unavailable');
        // Only this deployed edge can qualify its native cookie transport. The
        // owning backend retains every payment/commerce/network capability.
        response.body = Buffer.from(JSON.stringify({ ...capabilities, mobileCookies: config.nativeCustomerEnabled, nativeCustomerApiVersion: 1 }));
      }
      res.statusCode = response.status;
      if (response.type) res.setHeader('Content-Type', response.type);
      if (response.disposition) {
        res.setHeader('Content-Disposition', response.disposition);
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      }
      if (response.cookies.length) res.setHeader('Set-Cookie', response.cookies);
      if (typeof response.retryAfter === 'string' && response.retryAfter.length <= 64 && !/[\r\n\0]/.test(response.retryAfter)) res.setHeader('Retry-After', response.retryAfter);
      res.end(method === 'HEAD' || response.status === 204 ? undefined : response.body);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const safe = error instanceof ProxyError ? error : new ProxyError(502, 'upstream_unavailable');
        res.statusCode = safe.status === 499 ? 400 : safe.status;
        res.setHeader('Connection', 'close');
        res.end(JSON.stringify({ error: safe.code }));
        req.resume();
      }
    } finally {
      clearTimeout(timer); res.off('close', disconnected);
    }
  };
}
