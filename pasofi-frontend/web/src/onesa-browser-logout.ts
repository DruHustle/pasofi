export type LogoutResponse = { endSessionUrl?: unknown } | undefined;

export function onesaLogoutHeaders(optIn = true): HeadersInit | undefined {
  if (optIn) return { 'X-PasoFi-End-Session': 'onesa' };
}

export function followOnesaLogout(response: LogoutResponse, browser: Pick<Location, 'origin' | 'replace'> = location) {
  if (typeof response?.endSessionUrl !== 'string') return;
  try {
    const target = new URL(response.endSessionUrl);
    const parameters = target.searchParams;
    if (target.origin !== 'https://auth.onesa.eu' || target.pathname !== '/v2/logout' ||
        target.username || target.password || target.hash || Array.from(parameters).length !== 2 ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(parameters.get('client_id') ?? '') ||
        parameters.get('returnTo') !== new URL('/', browser.origin).href) return;
    browser.replace(target.href);
  } catch { /* Local revocation has already completed. */ }
}
