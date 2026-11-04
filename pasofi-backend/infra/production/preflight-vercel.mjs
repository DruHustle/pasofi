#!/usr/bin/env node
import { inspectVercelConfiguration } from './vercel-config.mjs';

if (process.argv.length !== 2) {
  console.error('Configure PAMOFI_PUBLIC_HOST, PAMOFI_PUBLIC_ORIGIN and PAMOFI_SECRETS_DIR; this preflight accepts no arguments.');
  process.exitCode = 1;
} else {
  try {
    const report = await inspectVercelConfiguration();
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error('Vercel/Oracle preflight failed. Privately check the separate canonical HTTPS origins, protected token file and matching current Oracle certificate/key. No credential values were printed.');
    process.exitCode = 1;
  }
}
