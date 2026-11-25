import type { Configuration } from './onesa-staff.js';

const managedIssuer = 'https://auth.onesa.eu/';

export function managedBrowserLogoutUrl(
  config: Configuration | undefined,
  options: { preference: unknown; publicOrigin?: string; requestOrigin?: string; revokedManagedSession: boolean; hotspotOrigin?: string },
): string | undefined {
  const { preference, publicOrigin, requestOrigin, revokedManagedSession } = options;
  if (preference !== 'onesa' || !revokedManagedSession || !config?.managed || config.issuer !== managedIssuer ||
      !publicOrigin || config.callback.origin !== publicOrigin || !requestOrigin) return;
  const isHotspot = requestOrigin === options.hotspotOrigin;
  if (requestOrigin !== publicOrigin && !isHotspot) return;

  // The browser must visit Auth0 to clear its SSO cookie. Only use the
  // configured public home and the existing confidential client's public ID.
  const logout = new URL('v2/logout', managedIssuer);
  logout.searchParams.set('client_id', config.clientId);
  logout.searchParams.set('returnTo', new URL('/', requestOrigin).href);
  return logout.href;
}
