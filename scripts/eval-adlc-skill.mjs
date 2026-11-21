import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateAdlcSkill } from '../src/host/adlc-skill-eval.mjs';

const [baselinePath, candidatePath, configPath, adapterPath] = process.argv.slice(2);
if (process.argv.length !== 6) {
  throw new Error('Usage: node scripts/eval-adlc-skill.mjs BASELINE_PACK CANDIDATE_PACK CONFIG_JSON LOCAL_ADAPTER');
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const [baseline, candidate, config] = await Promise.all([baselinePath, candidatePath, configPath].map(json));
const { runCase, observe } = await import(pathToFileURL(resolve(adapterPath)).href);
const report = await evaluateAdlcSkill({ ...config, baseline, candidate }, { runCase, observe });
console.log(JSON.stringify(report, null, 2));
if (!report.eligible) process.exitCode = 1;
