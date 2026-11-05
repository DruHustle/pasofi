import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Keep HTML template dollars literal when RouterOS imports the file.
export function routerString(value) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replace(/[^\x00-\x7f]/gu, char => encodeURIComponent(char).replaceAll('%', '\\')) + '"';
}
export async function buildInstall({ source, target, profile }) {
  for (const value of [source, target, profile]) if (!/^[A-Za-z0-9_./-]{1,100}$/.test(value)) throw Error('Invalid router name or directory');
  if (source === target) throw Error('A new directory is required');
  const commands = [
    '{',
    `:local source ${routerString(source)}`,
    `:local target ${routerString(target)}`,
    `:local profile ${routerString(profile)}`,
    ':if ([:len [/ip hotspot profile find where name=$profile]] != 1) do={ :error "Expected one HotSpot profile" }',
    ':if ([/ip hotspot profile get [find name=$profile] html-directory] != $source) do={ :error "Portal directory changed; inspect before retrying" }',
    ':if ([/ip hotspot profile get [find name=$profile] dns-name] != "hotspot.pasofi.onesa.eu") do={ :error "Unexpected HTTPS hostname" }',
    ':if ([:len [/file find where name=($source . "/login.html")]] != 1) do={ :error "Source portal missing" }',
    ':if ([:len [/file find where name=$target]] != 0) do={ :error "Target exists; inspect before retrying" }',
    '/file copy $source name=$target',
  ];
  for (const name of ['pasofi.css', 'login.html', 'status.html', 'alogin.html', 'logout.html']) {
    const contents = await readFile(new URL(name, import.meta.url), 'utf8');
    if (Buffer.byteLength(contents) > 4000) throw Error(`${name} exceeds bounded RouterOS upload size`);
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, target, profile, output] = process.argv.slice(2);
  if (!output) throw Error('Usage: node build-install.mjs SOURCE_DIRECTORY NEW_DIRECTORY PROFILE OUTPUT.rsc');
  await writeFile(output, await buildInstall({ source, target, profile }), { mode: 0o600 });
}
