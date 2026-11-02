export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterMs?: number) { super(code); }
}
export const mobileApiOrigin = (() => {
  const configured = import.meta.env.VITE_PAMOFI_API_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return null;
    return parsed.origin;
  } catch { return null; }
})();
export const mobileApiConfigured = !!import.meta.env.VITE_PAMOFI_API_BASE_URL?.trim();

// Only the configured HTTPS gateway receives API calls and credentialed cookies.
// No session or recovery credential is stored in native preferences or localStorage.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!mobileApiOrigin || !path.startsWith('/api/')) throw new ApiError(503, 'mobile_api_not_configured');
  const controller = new AbortController(), source = init?.signal;
  const abort = () => controller.abort();
  if (source?.aborted) abort(); else source?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    const response = await fetch(new URL(path, mobileApiOrigin), { ...init, mode: 'cors', credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const retryAfter = response.headers.get('Retry-After');
      const delay = retryAfter ? /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : NaN;
      throw new ApiError(response.status, typeof body?.error === 'string' ? body.error : 'request_failed', Number.isFinite(delay) && delay > 0 ? Math.min(delay, 300_000) : undefined);
    }
    return response.status === 204 ? undefined as T : await response.json();
  } finally { clearTimeout(timer); source?.removeEventListener('abort', abort); }
}
