// A deliberately small, non-coercing JSON Schema subset. Keep declarations
// explicit so a typo or an unsupported assertion cannot silently weaken one.
const SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties',
  'maxProperties', 'minimum', 'maximum']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SCHEMA_DEPTH = 24;
const MAX_VALUE_DEPTH = 64;
const MAX_COLLECTION_ENTRIES = 10000;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function ownData(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`${label} must be an own data property`);
  return descriptor.value;
}

function safeKey(key, label) {
  if (typeof key !== 'string' || !key || UNSAFE_KEYS.has(key)) throw new Error(`Unsafe ${label}: ${String(key)}`);
}

function fields(value, allowed, label) {
  if (!object(value)) throw new Error(`${label} must be an object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`Unsupported ${label} key: ${String(key)}`);
    ownData(value, key, label);
  }
}

function jsonValue(value, label, depth = 0, seen = new Set()) {
  if (depth > MAX_VALUE_DEPTH) throw new Error(`${label} exceeds JSON depth limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new Error(`${label} must be a JSON value`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ENTRIES) throw new Error(`${label} exceeds JSON collection limit`);
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new Error(`${label} contains a sparse array`);
      jsonValue(ownData(value, String(i), label), label, depth + 1, seen);
    }
    if (Reflect.ownKeys(value).some((key) => key !== 'length' &&
      !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length))) {
      throw new Error(`${label} has non-JSON array properties`);
    }
  } else {
    if (!object(value)) throw new Error(`${label} must be a plain JSON object`);
    if (Reflect.ownKeys(value).length > MAX_COLLECTION_ENTRIES) throw new Error(`${label} exceeds JSON collection limit`);
    for (const key of Reflect.ownKeys(value)) {
      safeKey(key, `${label} property`);
      jsonValue(ownData(value, key, label), `${label}.${key}`, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function jsonIdentity(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

function bounds(schema, min, max, integer, label) {
  for (const key of [min, max]) if (Object.hasOwn(schema, key) &&
    (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]) ||
      (integer && (!Number.isSafeInteger(schema[key]) || schema[key] < 0)))) {
    throw new Error(`Invalid ${label}.${key}`);
  }
  if (Object.hasOwn(schema, min) && Object.hasOwn(schema, max) && schema[min] > schema[max]) {
    throw new Error(`Invalid ${label} bounds`);
  }
}

function validateSchema(schema, label, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${label} exceeds schema depth limit`);
  fields(schema, SCHEMA_KEYS, label);
  if (!TYPES.has(schema.type)) throw new Error(`${label}.type must be a supported JSON type`);
  if (Object.hasOwn(schema, 'description') && typeof schema.description !== 'string') throw new Error(`Invalid ${label}.description`);
  for (const key of ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties']) {
    if (schema.type !== 'object' && Object.hasOwn(schema, key)) throw new Error(`${label}.${key} requires object type`);
  }
  for (const key of ['items', 'minItems', 'maxItems']) {
    if (schema.type !== 'array' && Object.hasOwn(schema, key)) throw new Error(`${label}.${key} requires array type`);
  }
  for (const key of ['minLength', 'maxLength']) {
    if (schema.type !== 'string' && Object.hasOwn(schema, key)) throw new Error(`${label}.${key} requires string type`);
  }
  for (const key of ['minimum', 'maximum']) {
    if (!['number', 'integer'].includes(schema.type) && Object.hasOwn(schema, key)) throw new Error(`${label}.${key} requires numeric type`);
  }
  bounds(schema, 'minLength', 'maxLength', true, label);
  bounds(schema, 'minItems', 'maxItems', true, label);
  bounds(schema, 'minProperties', 'maxProperties', true, label);
  bounds(schema, 'minimum', 'maximum', false, label);
  if (Object.hasOwn(schema, 'properties')) {
    if (!object(schema.properties)) throw new Error(`${label}.properties must be an object`);
    for (const key of Reflect.ownKeys(schema.properties)) {
      safeKey(key, `${label} property`);
      validateSchema(ownData(schema.properties, key, label), `${label}.properties.${key}`, depth + 1);
    }
  }
  if (Object.hasOwn(schema, 'required')) {
    if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length) throw new Error(`Invalid ${label}.required`);
    for (const key of schema.required) {
      safeKey(key, `${label} required key`);
      if (!Object.hasOwn(schema.properties ?? {}, key)) throw new Error(`${label}.required key has no property schema: ${key}`);
    }
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    validateSchema(schema.additionalProperties, `${label}.additionalProperties`, depth + 1);
  }
  if (Object.hasOwn(schema, 'items')) validateSchema(schema.items, `${label}.items`, depth + 1);
  if (Object.hasOwn(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new Error(`Invalid ${label}.enum`);
    for (const item of schema.enum) {
      jsonValue(item, `${label}.enum`);
      if (!matchesType(item, schema.type)) throw new Error(`${label}.enum contains the wrong type`);
    }
    const serialized = schema.enum.map(jsonIdentity);
    if (new Set(serialized).size !== serialized.length) throw new Error(`${label}.enum contains duplicates`);
  }
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return object(value);
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(schema, value, label, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) throw new Error(`${label} exceeds JSON depth limit`);
  if (!matchesType(value, schema.type)) throw new Error(`${label} must be ${schema.type}`);
  if (Object.hasOwn(schema, 'enum') && !schema.enum.some((item) => jsonIdentity(item) === jsonIdentity(value))) {
    throw new Error(`${label} is not in enum`);
  }
  if (schema.type === 'object') {
    const keys = Object.keys(value);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) throw new Error(`${label} has too few properties`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) throw new Error(`${label} has too many properties`);
    for (const key of keys) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateValue(schema.properties[key], value[key], `${label}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`${label}.${key} is not allowed`);
      else if (object(schema.additionalProperties)) validateValue(schema.additionalProperties, value[key], `${label}.${key}`, depth + 1);
    }
  } else if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${label} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${label} has too many items`);
    if (schema.items) value.forEach((item, index) => validateValue(schema.items, item, `${label}[${index}]`, depth + 1));
  } else if (schema.type === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) throw new Error(`${label} is too short`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) throw new Error(`${label} is too long`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${label} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${label} is above maximum`);
  }
}

function validateMapping(mapping, graph, label) {
  if (!object(mapping)) throw new Error(`${label} must be an object`);
  const allowed = mapping.source === 'node' ? new Set(['source', 'nodeId', 'path']) : new Set(['source', 'path']);
  fields(mapping, allowed, label);
  if (mapping.source !== 'node' && mapping.source !== 'input') throw new Error(`Invalid ${label}.source`);
  if (mapping.source === 'node') {
    safeKey(mapping.nodeId, `${label}.nodeId`);
    if (!graph.nodes.some((node) => node?.id === mapping.nodeId)) throw new Error(`Unknown ${label}.nodeId`);
  }
  if (!Array.isArray(mapping.path)) throw new Error(`${label}.path must be a string array`);
  if (mapping.path.length > MAX_VALUE_DEPTH) throw new Error(`${label}.path exceeds depth limit`);
  for (const segment of mapping.path) safeKey(segment, `${label} path segment`);
}

function validateMappingSet(mappings, graph, label) {
  if (!object(mappings)) throw new Error(`${label} must be an object`);
  for (const key of Reflect.ownKeys(mappings)) {
    safeKey(key, `${label} key`);
    validateMapping(ownData(mappings, key, label), graph, `${label}.${key}`);
  }
}

export function validateWorkflowContract(graph) {
  const contract = graph?.workflowContract;
  if (contract === undefined) return;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || typeof graph.start !== 'string') {
    throw new Error('Contracted graph needs nodes, edges and start');
  }
  jsonValue(contract, 'workflowContract');
  fields(contract, new Set(['version', 'inputSchema', 'outputSchema', 'outputMapping']), 'workflowContract');
  if (contract.version !== 1) throw new Error('Unsupported workflowContract.version');
  validateSchema(contract.inputSchema, 'workflowContract.inputSchema');
  validateSchema(contract.outputSchema, 'workflowContract.outputSchema');
  if (contract.outputSchema.type !== 'object') throw new Error('workflowContract.outputSchema must be object type');
  validateMappingSet(contract.outputMapping, graph, 'workflowContract.outputMapping');
}

export function validateWorkflowInput(graph, input) {
  if (graph?.workflowContract === undefined) return;
  validateWorkflowContract(graph);
  jsonValue(input, 'workflowInput');
  validateValue(graph.workflowContract.inputSchema, input, 'workflowInput');
}

function selected(edge, state) {
  if (edge.when === undefined) return true;
  const direct = Object.hasOwn(state, 'outcome') ? ownData(state, 'outcome', 'Node outcome') : undefined;
  const output = Object.hasOwn(state, 'output') ? ownData(state, 'output', 'Node output') : undefined;
  if (output !== undefined) jsonValue(output, 'Node output');
  const outcome = direct ?? (object(output) && Object.hasOwn(output, 'route') ? ownData(output, 'route', 'Node route') : undefined);
  return (Array.isArray(edge.when) ? edge.when : [edge.when]).includes(outcome);
}

function applicableNodes(run) {
  const active = new Set([run.graph.start]);
  const pending = [run.graph.start];
  while (pending.length) {
    const id = pending.pop();
    const state = Object.hasOwn(run.nodeStates ?? {}, id) ? run.nodeStates[id] : undefined;
    for (const edge of run.graph.edges ?? []) {
      if (edge.from !== id || !state || state.status !== 'completed' || !selected(edge, state) || active.has(edge.to)) continue;
      active.add(edge.to);
      pending.push(edge.to);
    }
  }
  return active;
}

function resolveOne(mapping, run, active) {
  let value;
  if (mapping.source === 'input') value = run.input?.workflowInput;
  else {
    if (!active.has(mapping.nodeId)) throw new Error(`Mapping node ${mapping.nodeId} is outside the selected branch`);
    const state = Object.hasOwn(run.nodeStates ?? {}, mapping.nodeId) ? run.nodeStates[mapping.nodeId] : undefined;
    if (state?.status !== 'completed') throw new Error(`Mapping node ${mapping.nodeId} is not completed`);
    value = state.output;
  }
  if (value === undefined) throw new Error('Mapping source is missing');
  jsonValue(value, 'Mapping source');
  for (const segment of mapping.path) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= value.length || !Object.hasOwn(value, segment)) throw new Error(`Mapping path is missing: ${segment}`);
    } else if (!object(value) || !Object.hasOwn(value, segment)) throw new Error(`Mapping path is missing: ${segment}`);
    value = ownData(value, segment, 'Mapping path');
  }
  jsonValue(value, 'Mapped value');
  return structuredClone(value);
}

export function resolveWorkflowMapping(mapping, run) {
  if (!run?.graph || !object(run.input) || !object(run.nodeStates)) throw new Error('Run snapshot is required');
  jsonValue(mapping, 'mapping');
  validateMappingSet(mapping, run.graph, 'mapping');
  const active = applicableNodes(run);
  const result = {};
  for (const key of Object.keys(mapping).sort()) result[key] = resolveOne(mapping[key], run, active);
  return result;
}

export function projectWorkflowOutput(run) {
  if (run?.graph?.workflowContract === undefined) return undefined;
  validateWorkflowContract(run.graph);
  const result = resolveWorkflowMapping(run.graph.workflowContract.outputMapping, run);
  validateValue(run.graph.workflowContract.outputSchema, result, 'workflowOutput');
  return result;
}
