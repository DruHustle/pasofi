#!/usr/bin/env node
import {inspectRouterFleet} from './router-fleet-config.mjs';
try {
  if (process.argv.length !== 2) throw Error('This preflight accepts no arguments.');
  console.log(JSON.stringify(await inspectRouterFleet(), null, 2));
} catch {
  console.error('Router-fleet preflight failed. Privately check the explicit read/write gates, protected registry, serials, managed targets and public trust files. Credential values were not printed.');
  process.exitCode = 1;
}
