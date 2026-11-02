import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { protectedDirectory, protectedFile } from './vercel-config.mjs';
import { privateIpv4 } from '../remote-access/validation.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = ['nasId', 'url', 'username', 'password', 'caFile'];
const dns = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function validateRouterControlRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) throw Error('Provide 1–100 explicit RouterOS entries.');
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(name => !fields.includes(name)) ||
        typeof row.nasId !== 'string' || !uuid.test(row.nasId) || ids.has(row.nasId)) throw Error('Each router requires its own canonical registered NAS identifier.');
    let url;
    try { url = new URL(row.url); } catch { throw Error('Invalid RouterOS management URL.'); }
    const host = url.hostname;
    if (typeof row.url !== 'string' || row.url !== url.toString() || url.protocol !== 'https:' || url.username || url.password ||
        url.port || url.pathname !== '/rest/' || url.search || url.hash ||
        (isIP(host) ? !privateIpv4(host) : !dns.test(host) || host.endsWith('.local') || host.endsWith('.localhost'))) {
      throw Error('Use the reviewed HTTPS router host on TCP443 with the exact /rest/ path.');
    }
    if (typeof row.username !== 'string' || row.username.length < 1 || row.username.length > 128 || /[:\x00-\x20\x7f]/.test(row.username) ||
        typeof row.password !== 'string' || row.password.length < 1 || row.password.length > 4096 || /[\x00\r\n]/.test(row.password)) {
      throw Error('Supply the existing restricted per-device RouterOS credentials privately.');
    }
    if (row.caFile !== '/run/pamofi/routeros-ca/' + row.nasId + '.pem') throw Error('Each router requires its named public trust file inside the read-only CA mount.');
    ids.add(row.nasId);
  }
  return rows;
}

export async function inspectRouterControl(environment = process.env) {
  const flag = environment.PAMOFI_ROUTER_CONTROL_QUALIFIED;
  if (!['true', 'false'].includes(flag)) throw Error('Set explicit router-control qualification to true or false.');
  const directory = await protectedDirectory(environment.PAMOFI_ROUTER_CONTROL_DIR);
  const routersPath = join(directory, 'routers.json');
  const rows = validateRouterControlRows(JSON.parse(await protectedFile(directory, 'routers.json', 1024 * 1024)));
  // A private parent protects host access. The individually mounted JSON must
  // remain readable by the image's non-root UID despite host UID differences.
  if (((await lstat(routersPath)).mode & 0o777) !== 0o444) throw Error('The individually mounted router JSON must be mode0444 inside its private parent.');
  const caDirectory = join(directory, 'ca'), metadata = await lstat(caDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o055) !== 0o055 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw Error('The CA-only directory must be operator-owned and readable by the non-root container.');
  const names = rows.map(row => row.nasId + '.pem').sort();
  if (JSON.stringify((await readdir(caDirectory)).sort()) !== JSON.stringify(names)) throw Error('The CA mount must contain exactly the referenced public certificates, never private keys.');
  const expiries = [];
  for (const name of names) {
    const text = await protectedFile(caDirectory, name, 65536);
    if (((await lstat(join(caDirectory, name))).mode & 0o777) !== 0o444 ||
        !/^\s*-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----\s*$/.test(text)) throw Error('Each CA file must contain one public PEM certificate and be mode0444.');
    const certificate = new X509Certificate(text);
    if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw Error('Router trust material must be within its validity period.');
    expiries.push(new Date(certificate.validTo).toISOString());
  }
  return {
    status: 'prepared-only', routerCount: rows.length, activationRequested: flag === 'true',
    earliestCertificateExpiry: expiries.sort()[0],
    checks: ['existing-routeros-contract', 'private-credential-directory', 'per-device-public-trust-files', 'explicit-activation-switch'],
    remaining: ['nas-registration-and-device-identity', 'management-dns-and-private-tunnel-route', 'router-tls-hostname-and-restricted-account', 'disconnect-requery-and-accounting-acceptance'],
  };
}
