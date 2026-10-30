import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInterviewHtml } from '../adapters/interview/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packRoot = path.resolve(here, '..');
const questionnaire = JSON.parse(await readFile(path.join(packRoot, 'templates/interview/questionnaire.json'), 'utf8'));
const output = path.resolve(process.argv[2] ?? path.join(packRoot, 'examples/interview-demo.html'));
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, renderInterviewHtml(questionnaire), 'utf8');
console.log(`Wrote local interview demo: ${output}`);
