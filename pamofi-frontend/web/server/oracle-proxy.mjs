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
  [/^\/api\/staff\/(register|login|mfa\/(setup|confirm|verify))$/, ['POST']],
  [/^\/api\/staff\/session$/, ['GET', 'DELETE']],
  [/^\/api\/staff\/(users|audit|sites|inventory)$/, ['GET']],
  [new RegExp(`^/api/staff/users/${UUID}/(decision|revoke-sessions|recover-mfa)$`), ['POST']],
  [/^\/api\/staff\/sales$/, ['GET', 'POST']],
  [new RegExp(`^/api/staff/sales/${UUID}/(receipt|delivery)$`), ['GET']],
  [new RegExp(`^/api/staff/sales/${UUID}/resend$`), ['POST']],
  [/^\/api\/admin\/(sites|inventory\/allocations)$/, ['POST']],
  [/^\/api\/admin\/network\/reviews$/, ['GET']],
  [new RegExp(`^/api/admin/network/reviews/${UUID}/resolve$`), ['POST']],
  [/^\/api\/admin\/bundles$/, ['GET', 'POST']],
  [/^\/api\/admin\/bundles\/[a-z][a-z0-9-]{0,39}$/, ['PATCH']],
  [/^\/api\/receipt-pairings$/, ['POST']],
  [new RegExp(`^/api/receipt-pairings/${UUID}$`), ['GET']],
  [/^\/api\/vouchers\/redeem$/, ['POST']],
  [/^\/api\/network\/(sites|session)$/, ['GET']],
  [/^\/api\/network\/(credentials|disconnect)$/, ['POST']],
];
const BODY_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const cookieNames = new Set(['__Host-pamofi_session', '__Host-pamofi_staff_session', '__Host-pamofi_staff_challenge']);

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
  if (upstream.origin === frontend.origin) throw new ProxyError(503, 'api_unconfigured');
  return { upstream, frontend, token: env.PAMOFI_VERCEL_PROXY_TOKEN };
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
  const remaining = [], rewritten = [];
  for (const part of query ? query.split('&') : []) {
    const equals = part.indexOf('='), key = equals < 0 ? part : part.slice(0, equals), value = equals < 0 ? '' : part.slice(equals + 1);
    let decoded;
    try { decoded = decodeURIComponent(key.replace(/\+/g, ' ')); } catch { throw new ProxyError(400, 'invalid_request'); }
    if (decoded === '__pamofi_path') {
      try { rewritten.push(decodeURIComponent(value.replace(/\+/g, ' '))); } catch { throw new ProxyError(400, 'invalid_request'); }
    } else remaining.push(part);
  }
  if (rewritten.length > 1) throw new ProxyError(400, 'invalid_request');
  // Vercel may present the original URL or the internal rewrite destination.
  // The reserved rewrite value can choose only a public route, never an origin.
  if (path === '/api/gateway') {
    if (rewritten.length !== 1) throw new ProxyError(404, 'not_found');
    path = `/api/${rewritten[0]}`;
  } else if (rewritten.length && path !== `/api/${rewritten[0]}`) throw new ProxyError(400, 'invalid_request');
  if (!/^\/api\/[A-Za-z0-9/-]+$/.test(path)) throw new ProxyError(404, 'not_found');
  const rule = rules.find(([pattern]) => pattern.test(path));
  if (!rule) throw new ProxyError(404, 'not_found');
  const methods = rule[1].includes('GET') ? [...rule[1], 'HEAD'] : rule[1];
  if (!methods.includes(method)) throw new ProxyError(405, 'method_not_allowed');
  return { path, target: `${path}${remaining.length ? `?${remaining.join('&')}` : ''}` };
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

function publicCookies(value) {
  if (value === undefined) return undefined;
  const kept = [], seen = new Set();
  for (const part of value.split(';')) {
    const trimmed = part.trim(), equals = trimmed.indexOf('='), name = trimmed.slice(0, equals);
    if (equals < 1 || !cookieNames.has(name)) continue;
    if (seen.has(name)) throw new ProxyError(400, 'invalid_request');
    seen.add(name); kept.push(trimmed);
  }
  return kept.length ? kept.join('; ') : undefined;
}

function validateCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length > 8) throw new ProxyError(502, 'upstream_unavailable');
  for (const cookie of cookies) {
    if (typeof cookie !== 'string' || cookie.length > 8192 || /[\r\n\0]/.test(cookie)) throw new ProxyError(502, 'upstream_unavailable');
    const parts = cookie.split(';').map(part => part.trim()), name = parts[0].split('=', 1)[0];
    const attributes = parts.slice(1).map(part => part.toLowerCase());
    const keys = attributes.map(part => part.split('=', 1)[0].trim());
    if (!cookieNames.has(name) || !attributes.includes('secure') || !attributes.includes('httponly') ||
        !attributes.includes('path=/') || !attributes.includes('samesite=lax') || keys.includes('domain') || new Set(keys).size !== keys.length) {
      throw new ProxyError(502, 'upstream_unavailable');
    }
  }
  return cookies;
}

function oracleRequest(request, url, options, body, signal) {
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
        if (status !== 204 && (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type))) return fail(new ProxyError(502, 'upstream_unavailable'));
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return fail(new ProxyError(502, 'upstream_unavailable'));
        let cookies;
        try { cookies = validateCookies(response.headers['set-cookie'] || []); } catch (error) { return fail(error); }
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
          settled = true; cleanup();
          resolve({ status, type, cookies, retryAfter: response.headers['retry-after'], body: Buffer.concat(chunks) });
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
      const host = header(req, 'host', 253), sourceOrigin = header(req, 'origin', 253);
      if (!host || host.toLowerCase() !== config.frontend.host) throw new ProxyError(403, 'origin_not_allowed');
      if ((sourceOrigin !== undefined && sourceOrigin !== config.frontend.origin) ||
          (!['GET', 'HEAD'].includes(method) && sourceOrigin !== config.frontend.origin)) throw new ProxyError(403, 'origin_not_allowed');
      const clientIp = canonicalClientIp(header(req, 'x-vercel-forwarded-for', 45));
      const body = await readBody(req, controller.signal, method);
      const headers = { accept: 'application/json', 'accept-encoding': 'identity', 'x-pamofi-proxy-token': config.token, 'x-pamofi-client-ip': clientIp };
      for (const name of ['content-type', 'idempotency-key']) {
        const value = header(req, name);
        if (value !== undefined) headers[name] = value;
      }
      const cookies = publicCookies(header(req, 'cookie'));
      if (cookies !== undefined) headers.cookie = cookies;
      if (sourceOrigin !== undefined) headers.origin = sourceOrigin;
      if (body.length || ['POST', 'PATCH', 'DELETE'].includes(method)) headers['content-length'] = String(body.length);
      const response = await oracleRequest(request, new URL(route.target, config.upstream), { method, headers }, body, controller.signal);
      if (response.body.includes(Buffer.from(config.token)) || response.cookies.some(cookie => cookie.includes(config.token)) ||
          (typeof response.retryAfter === 'string' && response.retryAfter.includes(config.token))) throw new ProxyError(502, 'upstream_unavailable');
      res.statusCode = response.status;
      if (response.type) res.setHeader('Content-Type', response.type);
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
