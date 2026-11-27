/** Classify scoped heartbeat evidence before a recovery path can issue a Context Receipt. */
export async function readTemporaryAgentExecutionEvidence(db, { companyId, agentId, taskKey, sessionId }) {
  // Read all task-key candidates up to the ambiguity limit so a session filter cannot hide conflicts.
  const runs = await db.query(`SELECT id, status,
    context_snapshot->'paperclipAgentMessage'->>'sessionId' AS message_session_id,
    context_snapshot->'paperclipWake'->'agentMessage'->>'sessionId' AS wake_session_id
    FROM public.heartbeat_runs
    WHERE company_id=$1 AND agent_id=$2 AND context_snapshot->>'taskKey'=$3
    ORDER BY created_at DESC LIMIT 2`, [companyId, agentId, taskKey]);
  if (runs.length > 1) return { status: 'multiple-executions', run: null };
  const run = runs[0];
  if (!run) return { status: 'missing-execution', run: null };

  const sessionIds = [run.message_session_id ?? run.messageSessionId,
    run.wake_session_id ?? run.wakeSessionId]
    .filter((id) => typeof id === 'string' && id.trim());
  if (sessionIds.length === 0) return { status: 'missing-session', run };
  if (sessionIds.some((id) => id !== sessionId)) return { status: 'conflicting-session', run };
  return { status: 'matching-session', run };
}
