import { Capacitor, registerPlugin } from '@capacitor/core';

type NativeResponse = { requestId: string; status: number; data: unknown; contentType: string; retryAfterMs?: number };
type NativeRequest = { requestId: string; path: string; method: 'GET' | 'POST' | 'DELETE'; responseType: 'json' | 'pdf'; data?: string; idempotencyKey?: string };
interface CustomerApiPlugin {
  availability(options: { requestId: string }): Promise<{ requestId: string; configured: boolean; origin?: string; protocol: number }>;
  request(options: NativeRequest): Promise<NativeResponse>;
  cancel(options: { requestId: string }): Promise<{ requestId: string }>;
}
const bridge = registerPlugin<CustomerApiPlugin>('PasoFiCustomerApi');
export const usesNativeCustomerApi = Capacitor.isNativePlatform();
export class NativeApiError extends Error { constructor(public code: string) { super(code); } }
let ready: Promise<void> | undefined;

function configured(origin: string): Promise<void> {
  if (!Capacitor.isPluginAvailable('PasoFiCustomerApi')) return Promise.reject(new NativeApiError('mobile_api_not_configured'));
  if (!ready) {
    const requestId = crypto.randomUUID();
    ready = bridge.availability({ requestId }).then(value => {
      if (value.requestId !== requestId || value.configured !== true || value.origin !== origin || value.protocol !== 1) throw new NativeApiError('mobile_api_not_configured');
    }).catch(() => { ready = undefined; throw new NativeApiError('mobile_api_not_configured'); });
  }
  return ready;
}

// Native code owns the session cookie and account-creation retry credential.
// JavaScript passes only customer operation data; no URL, cookie or arbitrary header.
export async function nativeApiResponse(origin: string, path: string, init: RequestInit | undefined, responseType: 'json' | 'pdf', signal: AbortSignal): Promise<NativeResponse> {
  const method = init?.method ?? 'GET';
  if (!['GET', 'POST', 'DELETE'].includes(method) || (init && Object.keys(init).some(key => !['method', 'body', 'headers', 'signal', 'redirect'].includes(key)))) throw new NativeApiError('native_request_rejected');
  const headers = new Headers(init?.headers);
  for (const [name, value] of headers) {
    if (name !== 'idempotency-key' && name !== 'content-type') throw new NativeApiError('native_request_rejected');
    if (name === 'content-type' && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)) throw new NativeApiError('native_request_rejected');
  }
  const key = headers.get('idempotency-key');
  if (key && (!/^[A-Za-z0-9_-]{16,128}$/.test(key) || (path === '/api/session' && method === 'POST'))) throw new NativeApiError('native_request_rejected');
  if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new NativeApiError('native_request_rejected');
  const requestId = crypto.randomUUID();
  const options: NativeRequest = { requestId, path, method: method as NativeRequest['method'], responseType };
  if (typeof init?.body === 'string') options.data = init.body;
  if (key) options.idempotencyKey = key;

  return new Promise<NativeResponse>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true; cleanup();
      void bridge.cancel({ requestId }).catch(() => undefined);
      reject(new DOMException('The request was cancelled.', 'AbortError'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    void configured(origin).then(() => {
      if (signal.aborted) throw new DOMException('The request was cancelled.', 'AbortError');
      return bridge.request(options);
    }).then(response => {
      if (settled) return;
      if (!response || response.requestId !== requestId || !Number.isInteger(response.status) || response.status < 200 || response.status > 599 || typeof response.contentType !== 'string') throw new NativeApiError('native_response_rejected');
      settled = true; cleanup(); resolve(response);
    }).catch(error => {
      if (settled) return;
      settled = true; cleanup();
      // Native failures use fixed codes, never URLs, response bodies or OS errors.
      const allowed = new Set(['mobile_api_not_configured', 'native_request_rejected', 'native_response_rejected', 'native_session_storage_unavailable', 'session_changed', 'logout_pending', 'request_failed']);
      reject(new NativeApiError(typeof error?.code === 'string' && allowed.has(error.code) ? error.code : 'request_failed'));
    });
  });
}
