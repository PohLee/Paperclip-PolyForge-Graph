const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`);
};
const object = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
};
const list = (value, name, nonempty = true) => {
  if (!Array.isArray(value) || (nonempty && !value.length)) throw new Error(`${name} must be an array${nonempty ? ' with entries' : ''}`);
};
const unique = (values, name) => {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`);
};
export function artifactRefs(value) {
  const items = value?.artifacts ?? (Array.isArray(value) ? value : [value]);
  list(items, 'candidate references');
  const refs = items.map(item => {
    object(item, 'candidate reference');
    const artifactId = item.artifactId ?? item.id;
    text(artifactId, 'artifactId'); text(item.version, 'artifact version');
    return { artifactId, version: item.version };
  });
  unique(refs.map(ref => JSON.stringify([ref.artifactId, ref.version])), 'candidate references');
  return refs;
}
const refKey = ref => JSON.stringify([ref.artifactId, ref.version]);
function sameRefs(actual, expected) {
  const a = artifactRefs(actual).map(refKey).sort(), b = artifactRefs(expected).map(refKey).sort();
  unique(a, 'candidate references');
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('Evidence must bind to the exact current candidate');
}
function criteria(input) {
  list(input.acceptance_criteria, 'acceptance_criteria');
  for (const row of input.acceptance_criteria) {
    text(row.id, 'criterion id'); text(row.description, 'criterion description');
    list(row.requirementIds, 'criterion requirementIds');
    row.requirementIds.forEach(id => text(id, 'requirement id'));
    unique(row.requirementIds, 'criterion requirementIds');
  }
  unique(input.acceptance_criteria.map(row => row.id), 'criterion IDs');
  return input.acceptance_criteria;
}
function matrix(run, output) {
  object(output, 'acceptance matrix');
  sameRefs(output.candidateRefs, run.input.implementation_candidate);
  const required = criteria(run.input);
  list(output.criteria, 'matrix criteria');
  unique(output.criteria.map(row => row.id), 'matrix criterion IDs');
  if (output.criteria.length !== required.length || required.some(row => !output.criteria.some(result => result.id === row.id))) {
    throw new Error('Acceptance matrix must cover every criterion exactly once');
  }
  for (const row of output.criteria) {
    if (!['pass', 'fail', 'unverified'].includes(row.result)) throw new Error('Invalid criterion result');
    list(row.evidence, 'criterion evidence', row.result !== 'unverified');
    for (const evidence of row.evidence) {
      if (!['command', 'browser', 'manual', 'report'].includes(evidence.kind)) throw new Error('Invalid proof kind');
      text(evidence.ref, 'proof source'); text(evidence.observed, 'observed result');
    }
    if (row.result !== 'pass') text(row.gap, 'criterion gap');
  }
}

function sourceRequest(state, input) {
  artifactRefs(input.source_request);
  if (input.previous_triage) {
    const [previousRef] = artifactRefs(input.previous_triage);
    artifactRefs(input.reporter_update);
    const previous = Object.values(state.runs).find(run => run.graph.id === 'request-triage' &&
      run.nodeStates['assess-request']?.artifacts?.some(item => item.id === previousRef.artifactId && item.version === previousRef.version));
    if (!previous || previous.status !== 'completed' || previous.nodeStates['assess-request'].output?.disposition !== 'needs-info' ||
        previous.nodeStates['triage-disposition']?.outcome !== 'needs-info' ||
        artifactRefs(previous.input.source_request)[0].artifactId !== artifactRefs(input.source_request)[0].artifactId) {
      throw new Error('Triage follow-up must reference a prior needs-info report for the same request');
    }
  }
}

function triageHandoff(state, graph, input) {
  if (input.triage_handoff === undefined) return;
  const [ref] = artifactRefs(input.triage_handoff);
  const source = Object.values(state.runs).find(run => run.graph.id === 'request-triage' &&
    run.nodeStates['assess-request']?.artifacts?.some(item => item.id === ref.artifactId && item.version === ref.version));
  if (!source || source.status !== 'completed' || source.nodeStates['triage-disposition']?.outcome !== 'ready' ||
      source.nodeStates['assess-request'].output?.brief?.nextGraph !== graph.id) {
    throw new Error('Triage handoff needs a ready report routed to this Graph');
  }
}

function triage(run, output) {
  object(output, 'triage report');
  sameRefs(output.requestRefs, run.input.source_request);
  if (!['bug', 'enhancement'].includes(output.category)) throw new Error('Triage category must be bug or enhancement');
  if (!['issue', 'external-pr', 'feedback'].includes(output.surface)) throw new Error('Invalid triage surface');
  if (!['ready', 'needs-info', 'closed'].includes(output.disposition)) throw new Error('Invalid triage disposition');
  for (const name of ['duplicateCheck', 'priorDecisionCheck']) {
    object(output[name], name);
    text(output[name].result, `${name} result`);
    text(output[name].sourceRef, `${name} source`);
  }
  if (!['none', 'duplicate', 'already-implemented'].includes(output.duplicateCheck.result) ||
      !['none', 'rejected'].includes(output.priorDecisionCheck.result)) throw new Error('Invalid triage search result');
  object(output.claimCheck, 'claimCheck');
  if (!['confirmed', 'unverified', 'not-applicable'].includes(output.claimCheck.result)) throw new Error('Invalid claimCheck result');
  text(output.claimCheck.sourceRef, 'claimCheck source');
  if (output.disposition === 'ready') {
    object(output.brief, 'agent-ready brief');
    for (const field of ['problem', 'acceptanceBoundary', 'evidenceRef', 'owner']) text(output.brief[field], `brief ${field}`);
    if (!['product-discovery', 'implementation'].includes(output.brief.nextGraph)) throw new Error('Ready brief needs a valid next Graph');
    if (output.category === 'bug' && output.claimCheck.result !== 'confirmed') throw new Error('A ready bug needs confirmed reproduction');
    if (output.duplicateCheck.result !== 'none' || output.priorDecisionCheck.result === 'rejected') {
      throw new Error('Duplicate or previously rejected work is not ready');
    }
  }
  if (output.disposition === 'needs-info') {
    list(output.questions, 'triage questions'); output.questions.forEach((question, index) => text(question, `question ${index}`));
  }
  if (output.disposition === 'closed') text(output.reason, 'triage closure reason');
}

function workPlan(output) {
  object(output, 'work plan'); list(output.tickets, 'work tickets');
  output.tickets.forEach(ticket => object(ticket, 'work ticket'));
  unique(output.tickets.map(ticket => ticket.id), 'work ticket IDs');
  const ids = new Set(output.tickets.map(ticket => ticket.id));
  for (const ticket of output.tickets) {
    for (const field of ['id', 'deliverable', 'owner', 'verification']) text(ticket[field], `ticket ${field}`);
    list(ticket.blockers, 'ticket blockers', false);
    unique(ticket.blockers, 'ticket blockers');
    for (const blocker of ticket.blockers) {
      if (!ids.has(blocker) || blocker === ticket.id) throw new Error('Ticket blocker must name another ticket in the plan');
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Work ticket blockers contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const blocker of output.tickets.find(ticket => ticket.id === id).blockers) visit(blocker);
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id);
}

export function readyWorkTickets(plan, completedIds = []) {
  workPlan(plan);
  list(completedIds, 'completed ticket IDs', false);
  unique(completedIds, 'completed ticket IDs');
  const ids = new Set(plan.tickets.map(ticket => ticket.id));
  if (completedIds.some(id => !ids.has(id))) throw new Error('Completed ticket is outside the work plan');
  const completed = new Set(completedIds);
  return plan.tickets.filter(ticket => !completed.has(ticket.id) && ticket.blockers.every(id => completed.has(id))).map(ticket => ticket.id);
}

function workCompletion(run, output, artifacts) {
  object(output, 'work completion');
  const plan = run.nodeStates['implementation-plan']?.output;
  workPlan(plan);
  const candidate = artifacts?.filter(item => item.kind === 'implementation_candidate') ?? [];
  if (candidate.length !== 1) throw new Error('Work completion needs one integrated candidate');
  sameRefs(output.candidateRefs, candidate);
  list(output.tickets, 'ticket completion');
  output.tickets.forEach(row => object(row, 'ticket completion'));
  unique(output.tickets.map(row => row.id), 'ticket completion IDs');
  if (output.tickets.length !== plan.tickets.length || plan.tickets.some(ticket => !output.tickets.some(row => row.id === ticket.id))) {
    throw new Error('Work completion must cover every planned ticket exactly once');
  }
  for (const row of output.tickets) {
    if (row.result !== 'complete') throw new Error(`Ticket ${row.id} is not complete`);
    text(row.evidenceRef, 'ticket completion evidence');
    text(row.observed, 'ticket observed result');
  }
}

function verificationProfile(input) {
  const profile = input.project_verification;
  if (profile === undefined) return;
  object(profile, 'project_verification');
  artifactRefs(profile.identity);
  for (const field of ['surface', 'launchRef', 'doctorRef', 'driveRef', 'evidenceRef', 'cleanupRef']) {
    text(profile[field], `project_verification ${field}`);
  }
  list(profile.features, 'verification features');
  profile.features.forEach(feature => object(feature, 'verification feature'));
  unique(profile.features.map(feature => feature.id), 'verification feature IDs');
  for (const feature of profile.features) {
    text(feature.id, 'verification feature id'); text(feature.path, 'verification feature path');
    text(feature.proof, 'verification feature proof');
  }
  object(profile.proofRun, 'verification profile proof run');
  if (!profile.features.some(feature => feature.id === profile.proofRun.featureId)) throw new Error('Profile proof run needs a mapped feature');
  text(profile.proofRun.evidenceRef, 'profile proof evidence');
  if (profile.proofRun.cleanupPreservedEvidence !== true) throw new Error('Profile proof must preserve evidence after cleanup');
}
function acceptedArchitecture(state, context) {
  object(context, 'architecture context'); text(context.systemId, 'architecture systemId');
  const refs = artifactRefs(context.baseline);
  if (refs.length !== 1) throw new Error('Exactly one architecture baseline is required');
  text(context.decisionId, 'architecture decisionId');
  const decision = state.decisions.find(item => item.id === context.decisionId);
  const source = state.runs[decision?.runId];
  const gate = source?.graph.nodes.find(node => node.id === decision?.nodeId);
  if (decision?.outcome !== 'accept' || gate?.decisionContract?.type !== 'architecture-approval' ||
    !source.nodeStates[gate.id].attempts.some(attempt => attempt.decisionId === decision.id) ||
    source.input.system_id !== context.systemId) throw new Error('Architecture reference needs a recorded acceptance for this system');
  const attempt = source.nodeStates[gate.decisionContract.sourceNode].attempts.find(item =>
    item.artifacts?.some(artifact => artifact.id === refs[0].artifactId && artifact.version === refs[0].version));
  if (!attempt || !decision.evidence.some(item => item.subjectRefs?.some(ref => refKey(ref) === refKey(refs[0])))) {
    throw new Error('Architecture acceptance does not cover this baseline version');
  }
  return attempt.output;
}
function architectureContext(state, input) {
  const context = input.architecture_context;
  object(context, 'architecture_context');
  if (context.disposition === 'not-applicable') text(context.rationale, 'architecture non-applicability rationale');
  else if (context.disposition === 'baseline') acceptedArchitecture(state, context);
  else throw new Error('Architecture context must select baseline or not-applicable');
}
function architecture(state, run, output) {
  object(output, 'architecture baseline');
  text(run.input.system_id, 'system_id');
  if (output.systemId !== run.input.system_id) throw new Error('Architecture system must match the run');
  text(output.summary, 'architecture summary'); text(output.diagram, 'architecture/data-flow diagram');
  if (!['proposed', 'partial', 'implemented'].includes(output.implementationStatus)) throw new Error('Architecture implementation status is required');
  list(output.invariants, 'architecture invariants');
  unique(output.invariants.map(row => row.id), 'invariant IDs');
  for (const row of output.invariants) {
    if (!/^INV-[A-Za-z0-9-]+$/.test(row.id)) throw new Error('Invariant IDs must start with INV-');
    for (const field of ['rule', 'enforcement', 'proof']) text(row[field], `invariant ${field}`);
    if (!['active', 'retired'].includes(row.status)) throw new Error('Invariant status is required');
  }
  if (run.input.previous_architecture) {
    const previous = acceptedArchitecture(state, run.input.previous_architecture);
    if (previous.systemId !== output.systemId) throw new Error('Previous architecture belongs to another system');
    for (const old of previous.invariants) {
      const row = output.invariants.find(item => item.id === old.id);
      if (!row) throw new Error(`Preserve invariant ${old.id}, using retired status when appropriate`);
      if (row.rule !== old.rule || row.status !== old.status) text(row.changeReason, `changeReason for ${old.id}`);
    }
  }
}
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
function deliveryInput(input) {
  const target = input.delivery_target;
  object(target, 'delivery_target'); text(target.repository, 'repository'); text(target.prUrl, 'prUrl');
  if (!sha(target.headSha)) throw new Error('Delivery target needs a full head SHA');
  list(input.required_checks, 'required_checks'); input.required_checks.forEach(id => text(id, 'check name')); unique(input.required_checks, 'required checks');
  if (!Number.isInteger(input.required_approvals) || input.required_approvals < 0) throw new Error('required_approvals must be a nonnegative integer');
}
function delivery(run, output) {
  object(output, 'delivery report');
  sameRefs(output.candidateRefs, run.input.implementation_candidate);
  const target = run.input.delivery_target;
  if (output.headSha !== target.headSha || output.prUrl !== target.prUrl) throw new Error('Delivery report must match the pinned PR and head SHA');
  if (!['open', 'merged'].includes(output.state)) throw new Error('Delivery state must be open or merged');
  list(output.checks, 'delivery checks', false); unique(output.checks.map(row => row.name), 'check names');
  for (const check of output.checks) {
    text(check.name, 'check name'); text(check.sourceRef, 'check source');
    if (check.headSha !== target.headSha) throw new Error('Check is stale for the PR head');
    if (!['pass', 'fail', 'pending', 'unverified'].includes(check.result)) throw new Error('Invalid delivery check result');
  }
  list(output.approvals, 'approvals', false); unique(output.approvals.map(row => row.actorId), 'approval actors');
  for (const approval of output.approvals) {
    text(approval.actorId, 'approval actor'); text(approval.sourceRef, 'approval source');
    if (approval.headSha !== target.headSha) throw new Error('Approval is stale for the PR head');
  }
  object(output.review, 'independent review'); text(output.review.sourceRef, 'review source');
  if (output.review.headSha !== target.headSha) throw new Error('Independent review is stale for the PR head');
  if (!['approve', 'request-changes', 'blocked'].includes(output.review.verdict)) throw new Error('Invalid review verdict');
  if (!Number.isInteger(output.unresolvedFindings) || output.unresolvedFindings < 0 || typeof output.mergeable !== 'boolean') throw new Error('Delivery findings and mergeability are required');
  if (output.state === 'merged') {
    object(output.mergeEvent, 'merge event'); text(output.mergeEvent.sourceRef, 'merge event source');
    if (output.mergeEvent.headSha !== target.headSha || !sha(output.mergeEvent.mergeSha)) throw new Error('Merge event must identify the accepted head and merge commit');
  }
}

const outputTypes = ['acceptance-matrix', 'architecture-baseline', 'delivery-report', 'triage-report', 'work-plan', 'work-completion'];
const decisionTypes = ['acceptance-proof', 'architecture-approval', 'delivery-readiness', 'triage-routing'];
const inputTypes = ['acceptance-criteria', 'architecture-context', 'delivery-target', 'source-request', 'triage-handoff-optional', 'project-verification-optional'];
export function validateContractConfiguration(graph) {
  if (graph.inputContracts !== undefined) list(graph.inputContracts, 'inputContracts', false);
  for (const type of graph.inputContracts ?? []) if (!inputTypes.includes(type)) throw new Error(`Unknown input contract: ${type}`);
  for (const node of graph.nodes) {
    if (node.outputContract && (node.type !== 'task' || !outputTypes.includes(node.outputContract))) throw new Error('Invalid output contract');
    if (node.decisionContract) {
      const contract = node.decisionContract;
      const source = graph.nodes.find(item => item.id === contract.sourceNode);
      if (node.type !== 'decision' || !decisionTypes.includes(contract.type) || !source?.outputContract) throw new Error('Invalid decision contract');
      const expected = { 'acceptance-proof': 'acceptance-matrix', 'architecture-approval': 'architecture-baseline', 'delivery-readiness': 'delivery-report', 'triage-routing': 'triage-report' }[contract.type];
      if (source.outputContract !== expected) throw new Error('Decision contract source has the wrong output contract');
      const pending = [node.id], ancestors = new Set();
      while (pending.length) {
        const id = pending.pop();
        for (const edge of graph.edges.filter(edge => edge.to === id)) {
          if (!ancestors.has(edge.from)) { ancestors.add(edge.from); pending.push(edge.from); }
        }
      }
      if (!ancestors.has(source.id)) throw new Error('Contract source must precede its decision');
    }
  }
}
export function validateRunContracts(state, graph, input) {
  for (const type of graph.inputContracts ?? []) {
    if (type === 'acceptance-criteria') { criteria(input); artifactRefs(input.implementation_candidate); }
    if (type === 'architecture-context') architectureContext(state, input);
    if (type === 'delivery-target') { deliveryInput(input); artifactRefs(input.implementation_candidate); }
    if (type === 'source-request') sourceRequest(state, input);
    if (type === 'triage-handoff-optional') triageHandoff(state, graph, input);
    if (type === 'project-verification-optional') verificationProfile(input);
  }
}
export function validateOutputContract(state, run, node, output, artifacts) {
  if (node.outputContract && artifacts) {
    const kind = { 'acceptance-matrix': 'acceptance_matrix', 'architecture-baseline': 'architecture_baseline', 'delivery-report': 'delivery_report', 'triage-report': 'triage_report', 'work-plan': 'implementation_plan', 'work-completion': 'integration_test_report' }[node.outputContract];
    const identities = artifacts.filter(item => item.kind === kind);
    if (identities.length !== 1) throw new Error(`Contract requires exactly one ${kind} artifact`);
    artifactRefs(identities);
    for (const prior of Object.values(state.runs).flatMap(item => Object.values(item.nodeStates).flatMap(ns => ns.attempts))) {
      if (prior.artifacts?.some(item => item.id === identities[0].id && item.version === identities[0].version)) {
        throw new Error('Contract artifact identity/version was already submitted; publish a new version');
      }
    }
  }
  if (node.outputContract === 'acceptance-matrix') matrix(run, output);
  if (node.outputContract === 'architecture-baseline') architecture(state, run, output);
  if (node.outputContract === 'delivery-report') delivery(run, output);
  if (node.outputContract === 'triage-report') triage(run, output);
  if (node.outputContract === 'work-plan') workPlan(output);
  if (node.outputContract === 'work-completion') workCompletion(run, output, artifacts);
}
export function validateDecisionContract(state, run, node, actor, outcome, evidence) {
  const contract = node.decisionContract;
  if (contract?.type === 'triage-routing') {
    const source = run.nodeStates[contract.sourceNode];
    if (source?.status !== 'completed') throw new Error('Triage report is not completed');
    triage(run, source.output);
    if (outcome !== source.output.disposition) throw new Error('Triage decision must match the report disposition');
  }
  if (!contract || !['accept', 'ready', 'merged'].includes(outcome)) return;
  const source = run.nodeStates[contract.sourceNode];
  if (source?.status !== 'completed') throw new Error('Contract evidence is not completed');
  const sourceNode = run.graph.nodes.find(item => item.id === contract.sourceNode);
  validateOutputContract(state, run, sourceNode, source.output);
  if (contract.type === 'acceptance-proof') {
    const matrixArtifact = source.artifacts.find(artifact => artifact.kind === 'acceptance_matrix');
    if (!matrixArtifact) throw new Error('Acceptance matrix artifact is missing');
    for (const row of source.output.criteria) {
      if (row.result === 'fail') throw new Error(`Failed criterion ${row.id} blocks acceptance`);
      if (row.result === 'unverified') {
        if (actor.kind !== 'human' || !actor.roles.includes('human-owner')) throw new Error('Unverified criteria require a human exception');
        const exception = evidence.find(item => item.kind === 'acceptance_exception' && item.criterionId === row.id);
        text(exception?.reason, `exception reason for ${row.id}`); text(exception?.risk, `exception risk for ${row.id}`);
        sameRefs(exception.subjectRefs, [matrixArtifact]);
      }
    }
  }
  if (contract.type === 'delivery-readiness') {
    const report = source.output;
    if (run.input.required_checks.some(name => !report.checks.some(check => check.name === name && check.result === 'pass')) ||
      report.review.verdict !== 'approve' || report.approvals.length < run.input.required_approvals || report.unresolvedFindings !== 0 || !report.mergeable && report.state !== 'merged') {
      throw new Error('Delivery gates have not passed on the pinned head');
    }
    if ((outcome === 'merged') !== (report.state === 'merged')) throw new Error('Delivery outcome must match the observed merge state');
  }
}
