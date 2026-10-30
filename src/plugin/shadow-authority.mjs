/** A reviewer can return its result, but cannot acquire its parent's Graph authority. */
export async function assertNotShadowCommand(db, companyId, actor, pluginId) {
  const rows = await db.query(`SELECT context_snapshot->>'taskKey' AS task_key
    FROM public.heartbeat_runs WHERE company_id=$1 AND agent_id=$2 AND id=$3 LIMIT 1`,
  [companyId, actor.agentId, actor.runId]);
  if (['shadow', 'temporary'].some(kind => rows[0]?.task_key?.startsWith(`plugin:${pluginId}:session:${kind}:`))) {
    throw new Error('Independent Shadow / temporary execution may only return its bounded result');
  }
}
