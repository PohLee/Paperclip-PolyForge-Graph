import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkflowContract, validateWorkflowInput, projectWorkflowOutput, resolveWorkflowMapping,
} from '../../src/core/workflow-contracts.mjs';

const inputSchema = {
  type: 'object', additionalProperties: false, required: ['request'],
  properties: {
    request: { type: 'object', additionalProperties: false, required: ['title', 'tasks'], properties: {
      title: { type: 'string', minLength: 2, maxLength: 40 },
      tasks: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', additionalProperties: false,
        required: ['priority'], properties: { priority: { type: 'integer', minimum: 1, maximum: 3 } } } },
    } },
  },
};
const outputSchema = { type: 'object', additionalProperties: false, required: ['title', 'result'], properties: {
  title: { type: 'string' }, result: { type: 'string', enum: ['minor', 'major'] },
} };
const graph = () => ({ start: 'route', nodes: [{ id: 'route' }, { id: 'minor' }, { id: 'major' }, { id: 'end' }], edges: [
  { from: 'route', to: 'minor', when: 'minor' }, { from: 'route', to: 'major', when: 'major' },
  { from: 'minor', to: 'end' }, { from: 'major', to: 'end' },
], workflowContract: { version: 1, inputSchema, outputSchema, outputMapping: {
  title: { source: 'input', path: ['request', 'title'] },
  result: { source: 'node', nodeId: 'minor', path: ['kind'] },
} } });
const input = () => ({ request: { title: 'Update', tasks: [{ priority: 2 }] } });
const run = () => ({ graph: graph(), input: { workflowInput: input() }, nodeStates: {
  route: { status: 'completed', outcome: 'minor' }, minor: { status: 'completed', output: { kind: 'minor' } },
  major: { status: 'pending' }, end: { status: 'completed' },
} });

test('legacy graphs are compatible without inventing a workflow result', () => {
  assert.equal(validateWorkflowContract({}), undefined);
  assert.equal(validateWorkflowInput({}, undefined), undefined);
  assert.equal(projectWorkflowOutput({ graph: {} }), undefined);
});

test('nested input validation enforces required fields, bounds and strict objects', () => {
  const g = graph();
  assert.doesNotThrow(() => validateWorkflowContract(g));
  assert.doesNotThrow(() => validateWorkflowInput(g, input()));
  assert.throws(() => validateWorkflowInput(g, undefined), /JSON value/);
  assert.throws(() => validateWorkflowInput(g, { request: { title: 'A', tasks: [{ priority: 2 }] } }), /too short/);
  assert.throws(() => validateWorkflowInput(g, { request: { title: 'Good', tasks: [{ priority: 4 }] } }), /above maximum/);
  assert.throws(() => validateWorkflowInput(g, { request: { title: 'Good', tasks: [] } }), /too few items/);
  assert.throws(() => validateWorkflowInput(g, { request: { title: 'Good', tasks: [{ priority: 1, extra: true }] } }), /not allowed/);
  assert.throws(() => validateWorkflowInput(g, { request: { title: 'Good', tasks: [{ priority: 1 }] }, trusted: true }), /not allowed/);
  assert.throws(() => validateWorkflowInput(g, { request: { title: 'Good' } }), /tasks is required/);
  assert.throws(() => validateWorkflowInput(g, { request: { title: 'Good', tasks: [{ priority: 1.5 }] } }), /integer/);
});

test('registration rejects unsupported keywords and invalid schema declarations', () => {
  const cases = [
    [{ ...inputSchema, oneOf: [{ type: 'string' }] }, /Unsupported.*oneOf/],
    [{ type: ['object', 'null'] }, /supported JSON type/],
    [{ type: 'object', required: ['missing'], properties: {} }, /no property schema/],
    [{ type: 'string', minimum: 1 }, /requires numeric type/],
    [{ type: 'array', minItems: 3, maxItems: 2 }, /bounds/],
    [{ type: 'object', additionalProperties: 'false' }, /must be an object/],
    [{ type: 'number', enum: [Infinity] }, /JSON value/],
    [{ type: 'object', $ref: '#/$defs/example' }, /Unsupported.*\$ref/],
  ];
  for (const [schema, expected] of cases) {
    const g = graph(); g.workflowContract.inputSchema = schema;
    assert.throws(() => validateWorkflowContract(g), expected);
  }
  const deep = { type: 'string' };
  let nested = deep;
  for (let i = 0; i < 26; i++) nested = { type: 'array', items: nested };
  const g = graph(); g.workflowContract.inputSchema = nested;
  assert.throws(() => validateWorkflowContract(g), /schema depth limit/);
  g.workflowContract.version = 2;
  assert.throws(() => validateWorkflowContract(g), /Unsupported workflowContract.version/);
  const nonObjectOutput = graph(); nonObjectOutput.workflowContract.outputSchema = { type: 'string' };
  assert.throws(() => validateWorkflowContract(nonObjectOutput), /outputSchema must be object/);
});

test('supported primitive types, object bounds and object enums validate without coercion', () => {
  const g = graph();
  g.workflowContract.inputSchema = { type: 'object', minProperties: 2, maxProperties: 2,
    properties: { enabled: { type: 'boolean' }, note: { type: 'null' } },
    required: ['enabled'], additionalProperties: { type: 'number', minimum: 0 } };
  assert.doesNotThrow(() => validateWorkflowInput(g, { enabled: true, extra: 0.5 }));
  assert.throws(() => validateWorkflowInput(g, { enabled: 1, extra: 0.5 }), /boolean/);
  assert.throws(() => validateWorkflowInput(g, { enabled: true, extra: -1 }), /below minimum/);
  assert.throws(() => validateWorkflowInput(g, { enabled: true, note: null, extra: 1 }), /too many properties/);
  g.workflowContract.inputSchema = { type: 'object', enum: [{ a: 1, b: 2 }] };
  assert.doesNotThrow(() => validateWorkflowInput(g, { b: 2, a: 1 }));
  assert.throws(() => validateWorkflowInput(g, { a: 1 }), /not in enum/);
});

test('mapping declarations reject unknown nodes, malformed paths and prototype keys', () => {
  const bad = [
    [{ source: 'node', nodeId: 'missing', path: [] }, /Unknown.*nodeId/],
    [{ source: 'input', path: 'request.title' }, /string array/],
    [{ source: 'input', path: ['request', '__proto__'] }, /Unsafe/],
    [{ source: 'input', path: [0] }, /Unsafe/],
    [{ source: 'input', path: [], eval: 'anything' }, /Unsupported/],
  ];
  for (const [mapping, expected] of bad) {
    const g = graph(); g.workflowContract.outputMapping.result = mapping;
    assert.throws(() => validateWorkflowContract(g), expected);
  }
  const g = graph();
  g.workflowContract.outputMapping = JSON.parse('{"__proto__":{"source":"input","path":[]}}');
  assert.throws(() => validateWorkflowContract(g), /Unsafe/);
  g.workflowContract.outputMapping = { result: { source: 'input', path: ['constructor'] } };
  assert.throws(() => validateWorkflowContract(g), /Unsafe/);
  const accessor = graph();
  Object.defineProperty(accessor.workflowContract.outputMapping.result.path, '0', { get() { throw new Error('getter executed'); } });
  assert.throws(() => validateWorkflowContract(accessor), /own data property/);
});

test('projection is deterministic, detached and limited to the chosen completed branch', () => {
  const r = run();
  assert.deepEqual(projectWorkflowOutput(r), { result: 'minor', title: 'Update' });
  const alternate = resolveWorkflowMapping({ copy: { source: 'input', path: [] }, index: { source: 'input', path: ['request', 'tasks', '0', 'priority'] } }, r);
  assert.deepEqual(alternate, { copy: input(), index: 2 });
  alternate.copy.request.title = 'Changed';
  assert.equal(r.input.workflowInput.request.title, 'Update');
  const switched = run(); switched.nodeStates.route.outcome = 'major';
  switched.nodeStates.major = { status: 'completed', output: { kind: 'major' } };
  assert.throws(() => projectWorkflowOutput(switched), /outside the selected branch/);
  switched.graph.workflowContract.outputMapping.result.nodeId = 'major';
  assert.deepEqual(projectWorkflowOutput(switched), { result: 'major', title: 'Update' });
  switched.nodeStates.major.status = 'pending';
  assert.throws(() => projectWorkflowOutput(switched), /not completed/);
});

test('projection fails closed on missing paths, invalid output and non-JSON values', () => {
  const r = run();
  delete r.nodeStates.minor.output.kind;
  assert.throws(() => projectWorkflowOutput(r), /Mapping path is missing/);
  r.nodeStates.minor.output.kind = 'other';
  assert.throws(() => projectWorkflowOutput(r), /not in enum/);
  r.nodeStates.minor.output.kind = undefined;
  assert.throws(() => projectWorkflowOutput(r), /JSON value/);
  assert.throws(() => validateWorkflowInput(r.graph, JSON.parse('{"__proto__":true}')), /Unsafe/);
  assert.throws(() => validateWorkflowInput(r.graph, { request: { title: 'Good', tasks: [new Date()] } }), /plain JSON object/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => validateWorkflowInput(r.graph, cycle), /cycle/);
});
