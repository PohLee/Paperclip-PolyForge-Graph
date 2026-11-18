// Demonstration fixture: the caller supplies check observations; no real tests run here.
const candidate = {
  type: 'object', properties: { id: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 } },
  required: ['id', 'version'], additionalProperties: false,
};
const inputSchema = { type: 'object', properties: { candidate }, required: ['candidate'], additionalProperties: false };
const outputSchema = {
  type: 'object', properties: { candidate, checkPassed: { type: 'boolean' } },
  required: ['candidate', 'checkPassed'], additionalProperties: false,
};

export const compositionPack = {
  id: 'composition-demo', version: '1.0.0',
  compatibility: { requiredCapabilities: { 'workflow-composition': '^1.0.0' } },
  graphStartRoles: { delivery: ['owner'], verification: ['owner'] },
  graphs: [
    {
      id: 'verification', version: '1.0.0', start: 'check',
      workflowContract: {
        version: 1, inputSchema, outputSchema,
        outputMapping: {
          candidate: { source: 'input', path: ['candidate'] },
          checkPassed: { source: 'node', nodeId: 'check', path: ['checkPassed'] },
        },
      },
      nodes: [{ id: 'check', type: 'task', role: 'verifier' }, { id: 'end', type: 'end' }],
      edges: [{ from: 'check', to: 'end' }],
    },
    {
      id: 'delivery', version: '1.0.0', start: 'verify',
      workflowContract: {
        version: 1, inputSchema, outputSchema,
        outputMapping: {
          candidate: { source: 'node', nodeId: 'verify', path: ['candidate'] },
          checkPassed: { source: 'node', nodeId: 'verify', path: ['checkPassed'] },
        },
      },
      nodes: [
        { id: 'verify', type: 'workflow',
          workflow: { packId: 'composition-demo', packVersion: '1.0.0', graphId: 'verification', graphVersion: '1.0.0' },
          inputMapping: { candidate: { source: 'input', path: ['candidate'] } } },
        { id: 'approve', type: 'decision', role: 'owner', decisionType: 'delivery-approval', outcomes: ['accept'] },
        { id: 'end', type: 'end' },
      ],
      edges: [{ from: 'verify', to: 'approve' }, { from: 'approve', to: 'end', when: 'accept' }],
    },
  ],
  decisionRules: [{ type: 'delivery-approval', mode: 'manual', requiresHuman: true,
    allowedKinds: ['human'], allowedRoles: ['owner'], requiredEvidence: ['verification'] }],
};
