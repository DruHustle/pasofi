#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { protectedDirectory } from './vercel-config.mjs';

async function main() {
  const [flag, value, confirmation, ...extra] = process.argv.slice(2);
  if (flag !== '--directory' || !value || confirmation !== '--add-vercel-proxy' || extra.length) {
    throw Error('Use --directory /absolute/protected/path --add-vercel-proxy.');
  }
  const directory = await protectedDirectory(value);
  // This deliberately does not change the existing 29-file secret generator.
  // No overwrite or rotation: a second invocation fails without reading values.
  const file = await open(join(directory, 'vercel_proxy_token'), 'wx', 0o400);
  try {
    await file.writeFile(randomBytes(32).toString('hex') + '\n');
    await file.chmod(0o400);
    await file.sync();
  } finally { await file.close(); }
  console.log('Created vercel_proxy_token in the protected directory; no secret value was printed. Copy it through the approved private channel to the Vercel server-only environment.');
}
main().catch(() => {
  console.error('Vercel token generation refused or failed. Use an existing operator-owned private directory outside the repository; never overwrite an existing token.');
  process.exitCode = 1;
});
