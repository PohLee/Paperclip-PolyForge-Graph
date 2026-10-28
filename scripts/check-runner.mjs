#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runChecks } from '../src/host/check-runner.mjs';

try {
  if (process.argv.length !== 3) throw new Error('Usage: node check-runner.mjs <host-owned-config.json>');
  const result = await runChecks(JSON.parse(await readFile(process.argv[2], 'utf8')));
  console.log(JSON.stringify({ status: result.status, summary: result.summary, manifestPath: result.manifestPath }));
  process.exitCode = { pass: 0, retry: 1, stop: 2 }[result.status];
} catch (error) {
  console.error(JSON.stringify({ status: 'stop', summary: error.message }));
  process.exitCode = 2;
}
