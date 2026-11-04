#!/usr/bin/env node
import { inspectRouterControl } from './router-control-config.mjs';

try {
  if (process.argv.length !== 2) throw Error('This preflight accepts no arguments.');
  console.log(JSON.stringify(await inspectRouterControl(), null, 2));
} catch {
  console.error('Router-control preflight failed. Privately inspect the explicit qualification switch, protected router JSON and per-device public trust files. No credential values were printed.');
  process.exitCode = 1;
}
