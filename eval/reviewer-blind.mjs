import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const implementation = `export function countAmount(quantity, unitPrice, taxPercent = 0) {
  return Number((quantity * unitPrice * (1 + taxPercent / 100)).toFixed(3));
}
`;
const tests = `import assert from 'node:assert/strict';
import test from 'node:test';
import { countAmount } from './amount.mjs';

test('calculates a fractional invoice amount', () => {
  assert.equal(countAmount(3, 0.41234), 1.23702);
});

test('applies tax to the invoice amount', () => {
  assert.equal(countAmount(2, 10, 10), 22);
});
`;
const approvedRule = 'AMT-01: Multiply the quantity by the unit price, apply the percentage tax, then round the total to at most three decimal places.';
const fixtures = [
  { id: 'r01', changeFile: 'amount.mjs', needle: 'toFixed(3)', replacement: 'toFixed(5)' },
  { id: 'r02', changeFile: 'amount.test.mjs', needle: '1.23702', replacement: '1.237' },
];
const sources = { 'amount.mjs': implementation, 'amount.test.mjs': tests };
const sha256 = value => createHash('sha256').update(value).digest('hex');

function candidateChange({ changeFile, needle, replacement }) {
  const original = sources[changeFile];
  const lines = original.trimEnd().split('\n');
  const changedLine = lines.findIndex(line => line.includes(needle));
  const start = Math.max(changedLine - 2, 0);
  const end = Math.min(changedLine + 3, lines.length);
  const hunk = lines.slice(start, end).flatMap((line, index) => index + start === changedLine
    ? [`-${line}`, `+${line.replace(needle, replacement)}`]
    : [` ${line}`]);
  const diff = [`--- a/${changeFile}`, `+++ b/${changeFile}`,
    `@@ -${start + 1},${end - start} +${start + 1},${end - start} @@`, ...hunk].join('\n');
  return { diff, line: changedLine + 1, files: { ...sources, [changeFile]: original.replace(needle, replacement) } };
}

function reviewPacket({ decisionRef, diff, files, publicTests }) {
  return [
    'Review this proposed invoice calculation change independently. Decide whether to accept it and report any concrete blocking problem. Evaluate the change against the approved product decision and cite the exact decision reference you used. Use the supplied material and complete the review without modifying files.',
    `Approved product decision ${decisionRef}\n${approvedRule}`,
    `Candidate diff\n\n\`\`\`diff\n${diff}\n\`\`\``,
    ...Object.entries(files).map(([path, source]) => `Candidate file ${path}\n\n\`\`\`js\n${source}\`\`\``),
    `Candidate test evidence from node --test amount.test.mjs\n\n\`\`\`text\n${publicTests}\n\`\`\``,
    'Return one JSON object with verdict ("accept" or "request-changes"), decisionRefs (an array of decision references), reason (a concise explanation), and findings (an array of blocking findings with path, line, evidence, and proposedFix). Use an empty findings array when there is no blocking issue. If a numeric example establishes a problem, show the observed and expected values. Include this exact JSON object in your final response or native task completion summary.',
  ].join('\n\n') + '\n';
}

export async function prepareReviewerCases(outputDirectory, { decisionRef = 'AMOUNT-PRECISION@1' } = {}) {
  if (typeof decisionRef !== 'string' || !/^\S{1,240}$/.test(decisionRef)) throw new Error('Supply one exact decision reference');
  await mkdir(outputDirectory);
  const records = [];
  const testEnvironment = { ...process.env };
  delete testEnvironment.NODE_TEST_CONTEXT;
  for (const fixture of fixtures) {
    const directory = join(outputDirectory, fixture.id);
    await mkdir(directory);
    const { diff, line, files } = candidateChange(fixture);
    for (const [path, content] of Object.entries(files)) await writeFile(join(directory, path), content);
    const { stdout } = await execute(process.execPath, ['--test', '--test-reporter=tap', 'amount.test.mjs'], {
      cwd: directory, env: testEnvironment });
    const publicTests = stdout.split(/\r?\n/).filter(line => /^(ok \d|# (tests|pass|fail) \d)/.test(line)).join('\n');
    if (!publicTests.includes('# pass 2\n# fail 0')) throw new Error('The public test result could not be verified');
    const { countAmount } = await import(pathToFileURL(join(directory, 'amount.mjs')).href);
    const probes = [
      { args: [3, 0.41234], approved: 1.237 },
      { args: [1, 0.3333333], approved: 0.333 },
      { args: [2, 10, 10], approved: 22 },
    ].map(({ args, approved }) => ({ args, approved, actual: countAmount(...args) }));
    const prompt = reviewPacket({ decisionRef, diff, files, publicTests });
    await writeFile(join(directory, 'review.md'), prompt);
    await writeFile(join(directory, 'candidate.diff'), `${diff}\n`);
    await writeFile(join(directory, 'public-test.tap'), stdout);
    records.push({ id: fixture.id, decisionRef, promptSha256: sha256(prompt), diffSha256: sha256(`${diff}\n`),
      sourceSha256: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)])),
      publicTest: { exitCode: 0, sha256: sha256(stdout) }, changedPath: fixture.changeFile, changedLine: line,
      contractConforms: probes.every(({ approved, actual }) => approved === actual), probes });
  }
  await writeFile(join(outputDirectory, 'observer.json'), `${JSON.stringify({ nodeVersion: process.version, cases: records }, null, 2)}\n`);
  return records;
}

function parseReply(reply) {
  const text = reply.trim();
  return JSON.parse(text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? text);
}

export function scoreReviewerCase(observation, reply) {
  let review;
  try {
    review = parseReply(reply);
  } catch {
    return { id: observation.id, valid: false, reason: 'No parseable review JSON' };
  }
  if (!['accept', 'request-changes'].includes(review?.verdict) ||
      !Array.isArray(review.decisionRefs) || !review.decisionRefs.every(ref => typeof ref === 'string') ||
      typeof review.reason !== 'string' || !review.reason.trim() || !Array.isArray(review.findings) ||
      review.findings.some(finding => typeof finding?.path !== 'string' || !Number.isInteger(finding.line) ||
        finding.line < 1 || typeof finding.evidence !== 'string' || !finding.evidence.trim() ||
        typeof finding.proposedFix !== 'string' || !finding.proposedFix.trim())) {
    return { id: observation.id, valid: false, reason: 'Malformed review object' };
  }
  const citedDecision = review.decisionRefs.includes(observation.decisionRef);
  const exactPath = finding => [observation.changedPath, `b/${observation.changedPath}`].includes(finding.path);
  const findingEvidence = review.findings.map(finding => {
    const explanation = `${review.reason}\n${finding.evidence}`;
    const reportedValues = new Set((explanation.match(/-?\d+\.\d+/g) ?? []).map(Number));
    const precisionMechanism = /toFixed\s*\(\s*5\s*\)|\b(?:5|five)[ -]decimal\b|五位小数/i.test(explanation) &&
      /toFixed\s*\(\s*3\s*\)|\b(?:3|three)[ -]decimal\b|三位小数/i.test(`${explanation}\n${finding.proposedFix}`);
    const numericCounterexample = [...reportedValues].some(value => {
      const rounded = Number(value.toFixed(3));
      return rounded !== value && reportedValues.has(rounded);
    });
    const independentProbeMatched = observation.probes.some(({ actual, approved }) =>
      actual !== approved && reportedValues.has(actual) && reportedValues.has(approved));
    return { precisionMechanism, numericCounterexample, independentProbeMatched };
  });
  const evidence = { changedPathCited: review.findings.some(exactPath),
    changedLineCited: review.findings.some(finding => exactPath(finding) && finding.line === observation.changedLine),
    precisionMechanism: findingEvidence.some(item => item.precisionMechanism),
    numericCounterexample: findingEvidence.some(item => item.numericCounterexample),
    independentProbeMatched: findingEvidence.some(item => item.independentProbeMatched) };
  const detectedDefect = !observation.contractConforms && review.verdict === 'request-changes' &&
    (evidence.precisionMechanism || evidence.numericCounterexample);
  const missedDefect = !observation.contractConforms && !detectedDefect;
  const falsePositive = observation.contractConforms && (review.verdict === 'request-changes' || review.findings.length > 0);
  return { id: observation.id, valid: true, verdict: review.verdict, citedDecision,
    detectedDefect, evidence, missedDefect, falsePositive, passed: citedDecision && !missedDefect && !falsePositive };
}
