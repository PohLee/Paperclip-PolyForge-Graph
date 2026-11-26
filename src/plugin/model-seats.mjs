const defaultEffortFields = { claude_local: 'effort', codex_local: 'modelReasoningEffort', opencode_local: 'variant' };
const defaultVendors = { claude_local: 'anthropic', codex_local: 'openai' };

export function infrastructureFailure(error) {
  const status = error?.status ?? error?.statusCode;
  if (status === 429 || (Number.isInteger(status) && status >= 500 && status < 600)) return 'http_' + status;
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') return 'timeout';
  if (['auth_expired', 'model_offline'].includes(error?.code)) return error.code;
  return null;
}

function agentSettings(agent) {
  return agent && { harness: agent.adapterType, model: agent.adapterConfig?.model };
}

function choices({ seat, layers, boundAgent, agents, project, rules, pinned, failure }) {
  if (pinned && !failure) return agents.some(agent => agent.id === pinned.agentId) ? [pinned] : [];
  const requested = rules.resolveSeatOrder({ ...layers });
  const fallbackReason = infrastructureFailure(failure);
  if (failure && (!fallbackReason || (fallbackReason === 'timeout' && failure.effectState !== 'absent'))) return [];
  const configurations = failure ? (requested.fallback ?? []).slice((pinned?.fallbackIndex ?? -1) + 1)
    .map((profile, index) => ({ ...requested, ...profile, fallbackIndex: (pinned?.fallbackIndex ?? -1) + index + 1 })) : [requested];
  return configurations.flatMap(profile => {
    const available = agent => agent && !['paused', 'terminated', 'error'].includes(agent.status);
    const matching = profile.harness
      ? [boundAgent, ...agents.filter(agent => agent.id !== boundAgent?.id)].filter(agent => available(agent) && agent.adapterType === profile.harness)
      : [boundAgent].filter(available);
    return matching.map(agent => {
      const resolved = rules.resolveSeatOrder({ paperclipAgent: agentSettings(agent), ...layers,
        ...(failure ? { runOverride: profile } : {}) });
      const model = resolved.model;
      const vendor = project.modelVendors?.[model] ?? project.adapterVendors?.[agent.adapterType]
        ?? defaultVendors[agent.adapterType];
      const effortField = project.effortFields?.[agent.adapterType] ?? defaultEffortFields[agent.adapterType];
      if (resolved.reasoning !== undefined && !effortField) return null;
      const adapterConfig = {
        ...(profile.model !== undefined ? { model } : {}),
        ...(resolved.reasoning !== undefined ? { [effortField]: resolved.reasoning } : {}),
      };
      return { name: seat.name, vendor, agentId: agent.id, requested: resolved, adapterConfig,
        fallbackIndex: profile.fallbackIndex, fallbackReason, actual: { harness: 'unverified', model: 'unverified' } };
    }).filter(Boolean);
  });
}

export function planModelSeats({ seats, agents, project = {}, rules, pinned = {}, failureBySeat = {} }) {
  const options = seats.map(seat => choices({ ...seat, seat,
    agents: agents.filter(agent => (seat.roleAgentIds ?? [seat.boundAgentId]).includes(agent.id)), project, rules,
    boundAgent: agents.find(agent => agent.id === seat.boundAgentId),
    pinned: pinned[seat.name], failure: failureBySeat[seat.name] }));
  function assign(index, selected) {
    if (index === seats.length) {
      try {
        for (const { declaration } of seats) {
          const constraintNeedsVendor = declaration.distinctVendor || declaration.judgeVendorNotIn?.length;
          if (constraintNeedsVendor && selected.some(seat => !seat.vendor)) return null;
          rules.checkSeatConstraints(selected.map(seat => ({ ...seat, vendor: seat.vendor ?? 'unverified' })), declaration);
        }
        return selected;
      } catch {
        return null;
      }
    }
    for (const option of options[index]) {
      const result = assign(index + 1, [...selected, option]);
      if (result) return result;
    }
    return null;
  }
  return assign(0, []);
}

export function seatUnavailable(declaration, firstWaitAt, now) {
  if (declaration.onUnavailable !== 'wait') return 'blocked';
  return now >= firstWaitAt + (declaration.waitDeadlineMs ?? 0) ? 'escalate' : 'waiting_seats';
}
