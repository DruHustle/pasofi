export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
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
      throw new ApiError(response.status, typeof body?.error === 'string' ? body.error : 'request_failed');
    }
    return response.status === 204 ? undefined as T : await response.json();
  } finally {
    clearTimeout(timer);
    source?.removeEventListener('abort', forwardAbort);
  }
}
