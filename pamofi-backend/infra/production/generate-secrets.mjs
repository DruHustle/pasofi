import { mkdir, lstat, readdir, writeFile, chmod, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  const [flag, target, confirmation] = process.argv.slice(2);
  if (flag !== '--directory' || !target || !isAbsolute(target) || confirmation !== '--new-install-only') throw Error('Use --directory /absolute/protected/path --new-install-only.');
  const root = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  // Compare the real parent path, so an outside symlink into a checkout cannot
  // accidentally turn a deployment secret directory into repository contents.
  const directory = join(await realpath(dirname(resolve(target))), basename(resolve(target)));
  if (directory === root || directory.startsWith(`${root}/`)) throw Error('Store deployment secrets outside the repository.');
  await mkdir(directory, { mode: 0o700 }); // Existing directories are never reused.
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 || (await readdir(directory)).length) throw Error('A new private directory is required.');
  const write = async (name, value) => { const file = join(directory, name); await writeFile(file, `${value}\n`, { flag: 'wx', mode: 0o444 }); await chmod(file, 0o444); };
  // Each file is mounted individually. The private0700 host parent protects it
  // from other host users; readable files work for distinct node/postgres UIDs.
  await write('postgres_password', randomBytes(32).toString('hex'));
  for (const [name, suffix] of [['identity', 'identity'], ['prepaid', 'prepaid_access'], ['network', 'network'], ['notification', 'notification'], ['assistant', 'assistant']]) {
    for (const role of ['migrate', 'runtime']) {
      const password = randomBytes(32).toString('hex');
      await write(`${name}_${role}_password`, password);
      const url = new URL(`postgresql://postgres:5432/pamofi_${suffix}`);
      url.username = `pamofi_${suffix}_${role}`; url.password = password;
      await write(`${name}_${role}_url`, url.toString());
    }
  }
  for (const name of ['internal_identity_secret', 'session_creation_secret', 'internal_events_secret', 'internal_network_secret', 'internal_delivery_secret', 'staff_mfa_encryption_key']) await write(name, randomBytes(32).toString('hex'));
  await write('voucher_delivery_keys_json', JSON.stringify({ initial: randomBytes(32).toString('base64') }));
  await write('radius_credential_keys', JSON.stringify({ 1: randomBytes(32).toString('hex') }));
  await chmod(directory, 0o700);
  console.log('Created independent database and application secret files. Supply qualified TLS certificate files separately; no secret values were printed.');
}
main().catch(() => { console.error('Secret generation refused or failed. Use a new absolute directory outside the repository; inspect and retain any already-created files, never overwrite a live secret set.'); process.exitCode = 1; });
