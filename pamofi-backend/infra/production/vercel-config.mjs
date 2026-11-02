import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { X509Certificate, createPrivateKey } from 'node:crypto';

const dnsHostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const allowedHostname = value => dnsHostname.test(value) && !value.endsWith('.local') && !value.endsWith('.localhost');

export function splitOrigins(environment) {
  const host = environment.PAMOFI_PUBLIC_HOST;
  let hostUrl;
  try { hostUrl = new URL('https://' + host); } catch { /* rejected below */ }
  if (typeof host !== 'string' || host.length + 8 > 253 || isIP(host) ||
      !hostUrl || hostUrl.hostname !== host ||
      !allowedHostname(host)) {
    throw Error('Set a canonical DNS hostname for PAMOFI_PUBLIC_HOST.');
  }
  const value = environment.PAMOFI_PUBLIC_ORIGIN;
  let browser;
  try { browser = new URL(value); } catch { throw Error('Set the exact HTTPS frontend origin.'); }
  if (typeof value !== 'string' || value.length > 253 || browser.protocol !== 'https:' || browser.origin !== value ||
      browser.username || browser.password || browser.pathname !== '/' || browser.search || browser.hash ||
      isIP(browser.hostname) || browser.port || browser.hostname.length > 253 ||
      !allowedHostname(browser.hostname) || value === 'https://' + host) {
    throw Error('The frontend must use a canonical HTTPS DNS origin distinct from the Oracle API hostname.');
  }
  return { oracleOrigin: 'https://' + host, browserOrigin: value, host };
}

export async function protectedDirectory(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw Error('Use an absolute existing protected secret directory.');
  const original = resolve(value), metadata = await lstat(original);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw Error('The secret directory must be owned by this operator and private (0700).');
  }
  const directory = await realpath(original);
  const repository = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  if (directory === repository || directory.startsWith(repository + '/')) throw Error('Keep the secret directory outside the repository.');
  return directory;
}

export async function protectedFile(directory, name, maximum = 65536, privateOnly = false) {
  const path = join(directory, name), metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (metadata.mode & 0o022) !== 0 || (privateOnly && (metadata.mode & 0o077) !== 0) || metadata.size < 1 || metadata.size > maximum ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
    throw Error('Secret/certificate file has unsafe ownership, type, links, mode or size.');
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await handle.stat();
    if (current.ino !== metadata.ino || current.dev !== metadata.dev || current.size !== metadata.size) throw Error('Secret file changed during inspection.');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

export async function inspectVercelConfiguration(environment = process.env) {
  const origins = splitOrigins(environment);
  const directory = await protectedDirectory(environment.PAMOFI_SECRETS_DIR);
  const token = await protectedFile(directory, 'vercel_proxy_token', 65, true);
  if (!/^[0-9a-f]{64}\n?$/.test(token)) throw Error('The Vercel proxy token must be exactly 64 lowercase hexadecimal characters.');
  const certificate = new X509Certificate(await protectedFile(directory, 'public_tls_cert', 1048576));
  const key = createPrivateKey(await protectedFile(directory, 'public_tls_key', 65536));
  const now = Date.now();
  if (!certificate.checkHost(origins.host, { wildcards: false }) || !certificate.checkPrivateKey(key) ||
      Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw Error('The public certificate/key must match the exact Oracle hostname and be within its validity period.');
  }
  return {
    status: 'prepared-only', browserOrigin: origins.browserOrigin, oracleOrigin: origins.oracleOrigin,
    certificateExpires: new Date(certificate.validTo).toISOString(),
    checks: ['separate-https-origins', 'private-secret-directory', 'proxy-token-format', 'matching-current-certificate-and-key'],
    remaining: ['public-dns-and-certificate-chain', 'vercel-protected-environment', 'live-proxy-cookie-origin-and-client-ip-acceptance'],
  };
}
