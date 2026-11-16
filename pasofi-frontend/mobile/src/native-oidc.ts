// The native application is a public client. Retain only a short-lived PKCE
// transaction and destination in this tab. Never persist a provider token.
import * as oidc from 'openid-client';
import type { CustomerTab } from './CustomerAccess';

export const callback = 'com.onesa.pasofi.identity://login/callback';
export const flowKey = 'pasofi-native-oidc-v1';
export type NativeRegistration = { issuer: string; audience: string; ios: string | null; android: string | null };
export type Platform = 'ios' | 'android';
type Flow = {
  state: string;
  nonce: string;
  verifier: string;
  created: number;
  destination: CustomerTab;
  clientId: string;
  issuer: string;
};
const destinations = new Set<CustomerTab>([
  'access',
  'wifi',
  'history',
  'voucher',
  'receipt',
  'purchase',
  'recovery',
]);

async function publicClient(registration: NativeRegistration, platform: Platform, transport?: oidc.CustomFetch) {
  const id = registration[platform],
    issuer = new URL(registration.issuer);
  if (
    !id ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(id) ||
    issuer.protocol !== 'https:' ||
    issuer.origin + '/' !== registration.issuer ||
    !registration.audience
  )
    throw Error('Invalid native registration');
  const client = await oidc.discovery(
    issuer,
    id,
    { token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'RS256' },
    oidc.None(),
    {
      timeout: 5,
      execute: [oidc.enableNonRepudiationChecks],
      ...(transport ? { [oidc.customFetch]: transport } : {}),
    },
  );
  const meta = client.serverMetadata();
  if (
    meta.issuer !== issuer.href ||
    ![meta.authorization_endpoint, meta.token_endpoint, meta.jwks_uri].every((raw) => {
      if (!raw) return false;
      const url = new URL(raw);
      return url.origin === issuer.origin && !url.username && !url.password && !url.hash;
    })
  )
    throw Error('Unexpected identity endpoint');
  return client;
}
export async function startNativeSignIn(
  registration: NativeRegistration,
  platform: Platform,
  destination: CustomerTab,
  storage: Storage,
  transport?: oidc.CustomFetch,
) {
  if (!destinations.has(destination)) throw Error('Invalid customer destination');
  const client = await publicClient(registration, platform, transport);
  const flow: Flow = {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    verifier: oidc.randomPKCECodeVerifier(),
    created: Date.now(),
    destination,
    clientId: registration[platform]!,
    issuer: registration.issuer,
  };
  const url = oidc.buildAuthorizationUrl(client, {
    redirect_uri: callback,
    response_type: 'code',
    scope: 'openid',
    state: flow.state,
    nonce: flow.nonce,
    audience: registration.audience,
    code_challenge_method: 'S256',
    code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
  });
  storage.setItem(flowKey, JSON.stringify(flow));
  return url.href;
}
export function isNativeCallback(value: string) {
  try {
    const u = new URL(value);
    return value.split('?')[0] === callback && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}
export function pendingNativeDestination(storage: Storage): CustomerTab | null {
  try {
    const flow = JSON.parse(storage.getItem(flowKey) || 'null') as Flow | null;
    if (
      flow &&
      Date.now() >= flow.created &&
      Date.now() - flow.created < 300000 &&
      destinations.has(flow.destination)
    )
      return flow.destination;
  } catch {
    /* Invalid or unavailable storage cannot resume. */
  }
  return null;
}
export async function finishNativeSignIn(
  registration: NativeRegistration,
  platform: Platform,
  value: string,
  storage: Storage,
  establish: (accessToken: string, platform: Platform) => Promise<void>,
  transport?: oidc.CustomFetch,
) {
  if (!isNativeCallback(value)) throw Error('Wrong return address');
  const url = new URL(value),
    destination = pendingNativeDestination(storage);
  const flow = JSON.parse(storage.getItem(flowKey) || 'null') as Flow | null;
  if (
    !flow ||
    !destination ||
    registration[platform] !== flow.clientId ||
    registration.issuer !== flow.issuer ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.get('state') !== flow.state
  )
    throw Error('Sign-in transaction unavailable');
  storage.removeItem(flowKey);
  const client = await publicClient(registration, platform, transport);
  const tokens = await oidc.authorizationCodeGrant(client, url, {
    expectedState: flow.state,
    expectedNonce: flow.nonce,
    pkceCodeVerifier: flow.verifier,
    idTokenExpected: true,
  });
  if (tokens.token_type.toLowerCase() !== 'bearer') throw Error('Unexpected token type');
  await establish(tokens.access_token, platform);
  return destination;
}
