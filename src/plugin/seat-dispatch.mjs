import { planModelSeats, seatUnavailable } from './model-seats.mjs';

export function createSeatDispatch(host, rules) {
  return async function resolveSeat({ companyId, engine, run, node, config, attempt }) {
    if (run.packId !== 'adlc' || !node.seat) return null;
    const operator = await host.config?.get(companyId);
    const project = operator?.adlcProjects?.[run.input.projectId];
    const group = project?.seatGroups?.[run.graph.id]?.find(item => Object.hasOwn(item, node.id));
    if (!group) return { status: 'blocked', reason: 'Declared model seat has no project configuration' };
    if (!rules.resolveSeatOrder || !rules.checkSeatConstraints) return { status: 'blocked', reason: 'Installed Pack does not support model seats' };
    const declarations = Object.keys(group).map(nodeId =>
      [nodeId, run.graph.nodes.find(item => item.id === nodeId)?.seat]);
    const undeclared = declarations.find(([, seat]) => !seat);
    if (undeclared) return { status: 'blocked', reason: `Model seat group member ${undeclared[0]} has no Graph seat declaration` };
    const declaration = declarations.find(([nodeId]) => nodeId === node.id)[1];
    const seats = declarations.map(([nodeId, declaration]) => {
      const role = run.graph.nodes.find(item => item.id === nodeId)?.role;
      const roleAgentIds = [config.roleBindings?.[run.packId + ':' + role], config.roleBindings?.[role]].filter(Boolean);
      const slot = project.seats?.[nodeId] ?? project.seats?.[declaration.name];
      const profileName = typeof slot === 'string' ? slot : slot?.profile ?? declaration.name;
      return { name: declaration.name, declaration, roleAgentIds,
        boundAgentId: config.roleBindings?.[run.packId + ':' + role] ?? config.roleBindings?.[role],
        layers: { companyProfile: operator.adlcProfiles?.[profileName], projectProfile: project.profiles?.[profileName],
          projectNodeSeat: typeof slot === 'object' ? slot : undefined,
          runOverride: run.startedBy?.kind === 'human' && run.startedBy.roles.includes('human-owner')
            ? run.input.seatOverrides?.[nodeId] : undefined },
      };
    });
    const decisions = await engine.listDecisions({ runId: run.id });
    const pinned = Object.fromEntries(declarations.flatMap(([nodeId, declaration]) => {
      const record = decisions.findLast(item => item.type === 'model-seat-dispatch' && item.nodeId === nodeId && (nodeId !== node.id || item.evidence?.[0]?.attempt === attempt));
      const selection = record?.evidence?.[0]?.selection;
      return selection ? [[declaration.name, selection]] : [];
    }));
    const previous = decisions.findLast(item => item.type === 'model-seat-runtime' && item.nodeId === node.id
      && item.evidence?.[0]?.attempt === attempt - 1 && item.evidence[0].fallback)?.evidence[0];
    const name = declaration.name;
    const failureBySeat = previous && !pinned[name]
      ? { [name]: { ...(previous.failure.startsWith('http_') ? { status: Number(previous.failure.slice(5)) }
        : previous.failure === 'timeout' ? { code: 'ETIMEDOUT' } : { code: previous.failure }), effectState: 'absent' } }
      : {};
    if (failureBySeat[name]) pinned[name] = previous.selection;
    const plan = planModelSeats({ seats, agents: await host.agents.list(companyId), project, rules, pinned, failureBySeat });
    const actor = { id: host.manifest.id, kind: 'system', roles: [] };
    if (!plan) {
      const waiting = await engine.recordDecision({
        type: 'model-seat-unavailable', status: 'pending', runId: run.id, nodeId: node.id, actor,
        reason: 'Model seat constraints could not be satisfied',
        idempotencyKey: 'seat-wait:' + JSON.stringify([run.id, node.id, attempt, run.resumeCount ?? 0]),
      });
      const status = seatUnavailable(declaration, Date.parse(waiting.at), Date.now());
      if (status === 'escalate') await engine.pauseRun({ runId: run.id, actor,
        reason: 'Model seat wait deadline elapsed for ' + declaration.name,
        idempotencyKey: 'seat-escalation:' + JSON.stringify([run.id, node.id, attempt, run.resumeCount ?? 0]) });
      return { status: status === 'escalate' ? 'waiting_human' : status, reason: 'Model seat constraints could not be satisfied' };
    }
    return { selection: plan.find(item => item.name === declaration.name) };
  };
}
