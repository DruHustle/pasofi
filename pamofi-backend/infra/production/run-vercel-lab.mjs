#!/usr/bin/env node
if (process.argv.length !== 2) throw Error('The Vercel/Oracle lab accepts no arguments.');
process.argv.push('--vercel');
await import('./run-lab.mjs');
