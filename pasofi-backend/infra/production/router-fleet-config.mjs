import {lstat, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {protectedDirectory, protectedFile} from './vercel-config.mjs';
import {validateRouterControlRows} from './router-control-config.mjs';

const fields = ['nasId', 'url', 'username', 'password', 'caFile', 'expectedSerial', 'allowWrites', 'targets'];
const kinds = ['identity', 'interface', 'wireless', 'wifi', 'hotspot-profile'];
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value);

export function validateRouterFleetRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) throw Error('Provide 1–100 enrolled routers.');
  const serials = new Set(), urls = new Set();
  for (const row of rows) {
    if (!plain(row) || Object.keys(row).some(key => !fields.includes(key)) ||
        !text(row.expectedSerial, 64) || !text(row.password, 4096) || typeof row.allowWrites !== 'boolean' ||
        row.caFile !== '/run/pamofi/router-fleet-ca/' + row.nasId + '.pem' ||
        !Array.isArray(row.targets) || row.targets.length < 1 || row.targets.length > 16) throw Error('Each router requires its verified serial, explicit write policy, public trust file, and 1–16 managed targets.');
    // Match the fleet runtime's byte limit and full whitespace exclusion.
    if (!text(row.username, 128) || /[:\s]/.test(row.username)) throw Error('The fleet account name must contain 1–128 UTF-8 bytes without colons or whitespace.');
    if (serials.has(row.expectedSerial.toUpperCase()) || urls.has(row.url)) throw Error('Each physical router must use one registered NAS identity and management endpoint.');
    serials.add(row.expectedSerial.toUpperCase()); urls.add(row.url);
    const keys = new Set(), resources = new Set();
    for (const target of row.targets) {
      if (!plain(target) || Object.keys(target).some(key => !['key', 'kind', 'name'].includes(key)) ||
          typeof target.key !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(target.key) || !kinds.includes(target.kind) ||
          (target.kind === 'identity' ? target.name !== undefined : !text(target.name, 64))) throw Error('A managed target must name exactly one supported existing resource.');
      const resource = `${target.kind}:${target.name ?? ''}`;
      if (keys.has(target.key) || resources.has(resource)) throw Error('Managed target keys and resources must be unique per router.');
      keys.add(target.key); resources.add(resource);
    }
  }
  // Reuse the existing private HTTPS443 and per-device credential validation,
  // without sharing the reconciler account or its on-disk secret material.
  validateRouterControlRows(rows.map(row => ({nasId: row.nasId, url: row.url, username: row.username, password: row.password, caFile: '/run/pamofi/routeros-ca/' + row.nasId + '.pem'})));
  return rows;
}

export async function inspectRouterFleet(environment = process.env) {
  const read = environment.PAMOFI_ROUTER_FLEET_ENABLED, write = environment.PAMOFI_ROUTER_FLEET_WRITE_ENABLED;
  if (![read, write].every(flag => ['true', 'false'].includes(flag)) || (write === 'true' && read !== 'true')) throw Error('Set explicit fleet read/write gates; writes require reads.');
  const directory = await protectedDirectory(environment.PAMOFI_ROUTER_FLEET_DIR);
  const rows = validateRouterFleetRows(JSON.parse(await protectedFile(directory, 'routers.json', 512 * 1024)));
  if (((await lstat(join(directory, 'routers.json'))).mode & 0o777) !== 0o444) throw Error('The mounted JSON must be mode0444 within its private parent.');
  const caDirectory = join(directory, 'ca'), metadata = await lstat(caDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o055) !== 0o055 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) throw Error('The public CA-only directory must be operator-owned and readable by the non-root container.');
  const names = rows.map(row => row.nasId + '.pem').sort();
  if (JSON.stringify((await readdir(caDirectory)).sort()) !== JSON.stringify(names)) throw Error('The CA mount must contain exactly the named public certificates.');
  const expiries = [];
  for (const name of names) {
    const value = await protectedFile(caDirectory, name, 65536);
    if (((await lstat(join(caDirectory, name))).mode & 0o777) !== 0o444 || !/^\s*-----BEGIN CERTIFICATE-----[\sA-Za-z0-9+/=]+-----END CERTIFICATE-----\s*$/.test(value)) throw Error('Each trust file must be one public PEM certificate, mode0444.');
    const certificate = new X509Certificate(value);
    if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) throw Error('Router trust material must be within its validity period.');
    expiries.push(new Date(certificate.validTo).toISOString());
  }
  return {
    status: 'prepared-only', routerCount: rows.length, writableRouterCount: rows.filter(row => row.allowWrites).length,
    readsRequested: read === 'true', writesRequested: write === 'true', earliestCertificateExpiry: expiries.sort()[0],
    checks: ['private-credential-files', 'explicit-managed-targets', 'expected-device-serials', 'per-device-public-trust', 'independent-read-write-gates'],
    remaining: ['registered-nas-identifiers', 'private-route-and-tls-hostname', 'dedicated-router-account', 'read-only-physical-check', 'single-change-and-rollback-acceptance'],
  };
}
