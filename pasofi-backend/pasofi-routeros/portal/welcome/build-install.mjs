import { readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const defaults = Object.freeze({
  siteLabel: 'Kuwadzana',
  hotspotOrigin: 'https://hotspot.pasofi.onesa.eu',
  appOrigin: 'https://pasofi.onesa.eu',
});

function httpsOrigin(value, field) {
  if (typeof value !== 'string' || value.length > 262 || !/^https:\/\/[a-z0-9.-]+\/?$/.test(value)) {
    throw Error(`${field} must be an exact HTTPS DNS origin without credentials, port, path, query or fragment`);
  }
  const url = new URL(value), labels = url.hostname.split('.');
  if (isIP(url.hostname) || labels.length < 2 || url.hostname.length > 253 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      (value !== url.origin && value !== `${url.origin}/`)) {
    throw Error(`${field} must use a canonical DNS hostname`);
  }
  return url.origin;
}

function siteConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(defaults, key))) {
    throw Error('Site configuration accepts only siteLabel, hotspotOrigin and appOrigin');
  }
  const config = { ...defaults, ...input };
  if (typeof config.siteLabel !== 'string' || !config.siteLabel.length ||
      [...config.siteLabel].length > 80 || config.siteLabel !== config.siteLabel.trim() ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(config.siteLabel)) {
    throw Error('siteLabel must contain 1–80 printable characters without surrounding whitespace');
  }
  config.hotspotOrigin = httpsOrigin(config.hotspotOrigin, 'hotspotOrigin');
  config.appOrigin = httpsOrigin(config.appOrigin, 'appOrigin');
  if (config.hotspotOrigin === config.appOrigin) throw Error('HotSpot and customer-app origins must be distinct');
  return config;
}

// Escape the RouterOS template marker as well as HTML metacharacters. Encoding
// the dollar here prevents a site label from injecting a $(...) portal token.
const htmlText = value => value.replace(/[&<>"'$]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '$': '&#36;' })[char]);

async function renderPages(config) {
  const pages = {};
  for (const name of ['pasofi.css', 'login.html', 'status.html', 'alogin.html', 'logout.html']) {
    const template = await readFile(new URL(name, import.meta.url), 'utf8');
    // One replacement pass prevents a selected origin that resembles a default
    // origin from being replaced a second time.
    const contents = template.replace(/https:\/\/(?:hotspot\.)?pasofi\.onesa\.eu(?=\/)/g,
      origin => origin === defaults.hotspotOrigin ? config.hotspotOrigin : config.appOrigin)
      .replaceAll('<span class="place">Kuwadzana</span>', `<span class="place">${htmlText(config.siteLabel)}</span>`);
    if (Buffer.byteLength(contents) > 4000) throw Error(`${name} exceeds bounded RouterOS upload size`);
    pages[name] = contents;
  }
  return pages;
}

export async function buildPages(site = {}) {
  return renderPages(siteConfig(site));
}

// Keep HTML template dollars literal when RouterOS imports the file.
export function routerString(value) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replace(/[^\x00-\x7f]/gu, char => encodeURIComponent(char).replaceAll('%', '\\')) + '"';
}
export async function buildInstall({ source, target, profile, site = {} }) {
  for (const value of [source, target, profile]) if (typeof value !== 'string' || !/^[A-Za-z0-9_./-]{1,100}$/.test(value)) throw Error('Invalid router name or directory');
  for (const directory of [source, target]) if (directory.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Use a concrete router directory without traversal');
  if (source === target || source.startsWith(`${target}/`) || target.startsWith(`${source}/`)) throw Error('Separate source and target directories are required');
  const config = siteConfig(site), pages = await renderPages(config);
  const commands = [
    '{',
    `:local source ${routerString(source)}`,
    `:local target ${routerString(target)}`,
    `:local profile ${routerString(profile)}`,
    ':if ([:len [/ip hotspot profile find where name=$profile]] != 1) do={ :error "Expected one HotSpot profile" }',
    ':if ([/ip hotspot profile get [find name=$profile] html-directory] != $source) do={ :error "Portal directory changed; inspect before retrying" }',
    `:if ([/ip hotspot profile get [find name=$profile] dns-name] != ${routerString(new URL(config.hotspotOrigin).hostname)}) do={ :error "Unexpected HTTPS hostname" }`,
    ':if ([:len [/file find where name=($source . "/login.html")]] != 1) do={ :error "Source portal missing" }',
    ':if ([:len [/file find where name=$target]] != 0) do={ :error "Target exists; inspect before retrying" }',
    '/file copy $source name=$target',
  ];
  for (const [name, contents] of Object.entries(pages)) {
    commands.push(`:local page ${routerString(contents)}`,
      `:local path ($target . "/${name}")`,
      ':if ([:len [/file find where name=$path]] = 0) do={ /file add name=$path type=file }',
      '/file set [find name=$path] contents=$page',
      ':if ([/file get [find name=$path] contents] != $page) do={ :error "Portal file verification failed; profile unchanged" }');
  }
  // Failed authentication must use the same error-aware page, not the old fallback.
  commands.push(':if ([:len [/file find where name=($target . "/flogin.html")]] > 0) do={ /file set [find name=($target . "/flogin.html")] contents=[/file get [find name=($target . "/login.html")] contents] }',
    '/ip hotspot profile set [find name=$profile] html-directory=$target',
    ':put "PasoFi welcome portal installed. Network access policy is unchanged."', '}');
  return commands.join('\n') + '\n';
}
async function main() {
  const [source, target, profile, output, siteFile, extra] = process.argv.slice(2);
  if (!output || extra) throw Error('Usage: node build-install.mjs SOURCE_DIRECTORY NEW_DIRECTORY PROFILE OUTPUT.rsc [SITE_CONFIG.json]');
  let site = {};
  if (siteFile) {
    const raw = await readFile(siteFile, 'utf8');
    if (Buffer.byteLength(raw) > 16384) throw Error('Site configuration exceeds 16 KiB');
    site = JSON.parse(raw);
  }
  await writeFile(output, await buildInstall({ source, target, profile, site }), { mode: 0o600, flag: 'wx' });
  console.log('Prepared a site-specific welcome installer; no router settings changed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof SyntaxError ? 'Invalid site configuration JSON' : error.message); process.exitCode = 1; });
}
