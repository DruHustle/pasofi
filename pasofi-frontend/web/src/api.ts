export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterMs?: number) { super(code); }
}

// Captive browsers and older WebViews may lack AbortSignal.any/timeout.
// Compose cancellation explicitly and retain the timeout through response parsing.
async function request<T>(path: string, init: RequestInit | undefined, read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const source = init?.signal;
  const forwardAbort = () => controller.abort();
  if (source?.aborted) forwardAbort();
  else source?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(forwardAbort, 10_000);
  try {
    // The dedicated hotspot build stays on the gateway's own HTTPS origin.
    // No browser credential or arbitrary upstream is added to this public path.
    const endpoint = import.meta.env.VITE_PASOFI_HOTSPOT_PORTAL === '1' && path.startsWith('/api/')
      ? '/portal-api/' + path.slice(5) : path;
    const response = await fetch(endpoint, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter ? /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : NaN;
      throw new ApiError(response.status, typeof body?.error === 'string' ? body.error : 'request_failed', Number.isFinite(delay) && delay > 0 ? Math.min(delay, 300_000) : undefined);
    }
    return await read(response);
  } finally {
    clearTimeout(timer);
    source?.removeEventListener('abort', forwardAbort);
  }
}

export function api<T>(path: string, init?: RequestInit): Promise<T> {
  return request(path, init, async response => response.status === 204 ? undefined as T : await response.json());
}

export function apiPdf(path: string, init?: RequestInit): Promise<Blob> {
  return request(path, { ...init, redirect: 'error' }, async response => {
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/pdf' || !response.body) throw new ApiError(502, 'invalid_invoice_pdf');
    const reader = response.body.getReader(), chunks: ArrayBuffer[] = []; let size = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new ApiError(502, 'invalid_invoice_pdf'); }
      chunks.push(new Uint8Array(part.value).buffer);
    }
    const blob = new Blob(chunks, { type: 'application/pdf' });
    if (await blob.slice(0, 5).text() !== '%PDF-') throw new ApiError(502, 'invalid_invoice_pdf');
    return blob;
  });
}
