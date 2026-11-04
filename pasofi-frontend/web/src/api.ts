export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterMs?: number) { super(code); }
}

// Captive browsers and older WebViews may lack AbortSignal.any/timeout.
// Compose cancellation explicitly and retain the timeout through response parsing.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const source = init?.signal;
  const forwardAbort = () => controller.abort();
  if (source?.aborted) forwardAbort();
  else source?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(forwardAbort, 10_000);
  try {
    const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter ? /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : NaN;
      throw new ApiError(response.status, typeof body?.error === 'string' ? body.error : 'request_failed', Number.isFinite(delay) && delay > 0 ? Math.min(delay, 300_000) : undefined);
    }
    return response.status === 204 ? undefined as T : await response.json();
  } finally {
    clearTimeout(timer);
    source?.removeEventListener('abort', forwardAbort);
  }
}
