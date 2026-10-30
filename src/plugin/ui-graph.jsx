import React, { useId, useMemo, useRef, useState } from 'react';
import { layoutGraph, graphNodeState } from './graph-layout.mjs';

const human = value => String(value ?? '').replaceAll(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
const css = `
.pfg-map{margin:22px 0 0;border-top:1px solid var(--border,#d5dce5);padding-top:20px}
.pfg-map-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.pfg-map-head h3{font-size:15px;margin:0}.pfg-map-tools{display:flex;align-items:center;gap:8px;font-size:12px}.pfg-map-tools button{border:1px solid var(--border,#d5dce5);border-radius:6px;padding:5px 9px;background:var(--card,#fff);color:inherit}.pfg-map-scroll{overflow:auto;max-height:540px;background:var(--background,#f8fafc);border:1px solid var(--border,#d5dce5);border-radius:10px;scrollbar-color:var(--border,#cbd5e1) transparent}.pfg-map-canvas{position:relative;isolation:isolate}.pfg-map-canvas svg{position:absolute;inset:0;overflow:visible;pointer-events:none}.pfg-map-node{position:absolute;display:flex;flex-direction:column;justify-content:center;gap:5px;text-align:left;padding:10px 12px;border:1px solid var(--border,#cbd5e1);border-radius:8px;background:var(--card,#fff);color:var(--foreground,#1e293b);cursor:pointer}.pfg-map-node strong{font-size:12px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.pfg-map-node span{font-size:10px;color:var(--muted-foreground,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pfg-map-node[data-status=completed]{border-color:var(--pfg-done,#278264)}.pfg-map-node[data-status=ready],.pfg-map-node[data-status=running]{border-color:var(--pfg-active,#245ca8);background:var(--accent,#eff6ff)}.pfg-map-node[data-status=blocked],.pfg-map-node[data-status=awaiting_supervisor_review],.pfg-map-node[data-status=awaiting_self_review]{border-color:var(--pfg-attention,#89520a)}.pfg-map-node[aria-pressed=true]{outline:2px solid var(--primary,#2563eb);outline-offset:3px}.pfg-map-node:focus-visible{outline:2px solid var(--ring,#2563eb);outline-offset:3px}.pfg-map-detail{padding:14px 0;font-size:12px;line-height:1.6}.pfg-map-detail h4{font-size:14px;margin:0 0 5px}.pfg-map-detail dl{display:grid;grid-template-columns:100px 1fr;gap:4px 12px;margin:8px 0}.pfg-map-detail dt{color:var(--muted-foreground,#64748b)}.pfg-map-detail dd{margin:0;overflow-wrap:anywhere}.pfg-map-note{font-size:11px;line-height:1.5;color:var(--muted-foreground,#64748b);margin:8px 0}.pfg-map-artifacts{padding-left:18px;margin:8px 0}.pfg-map-edge-label{font-size:10px;fill:var(--muted-foreground,#64748b);paint-order:stroke;stroke:var(--background,#f8fafc);stroke-width:5px;stroke-linejoin:round}
`;

export function GraphDiagram({ graph, run, ready = [], blocked = [], dispatches = [] }) {
  const [selected, setSelected] = useState(null);
  const [scale, setScale] = useState(0.85);
  const [definition, setDefinition] = useState(false);
  const viewport = useRef(null);
  const marker = `pfg-arrow-${useId().replaceAll(':', '')}`;
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  if (!graph) return null;
  const node = graph.nodes.find(item => item.id === selected);
  const state = node && run?.nodeStates?.[node.id];
  const attempts = state?.attempts ?? [];
  const dispatch = node && dispatches.filter(item => item.nodeId === node.id);
  return <section className="pfg-map" aria-label="Workflow graph"><style>{css}</style>
    <div className="pfg-map-head"><h3>Workflow graph</h3><div className="pfg-map-tools">
      <button type="button" onClick={() => setScale(Math.max(.15, Math.min(1, ((viewport.current?.clientWidth ?? 620) - 20) / layout.width)))}>Fit width</button>
      {run && <label><input type="checkbox" checked={definition} onChange={e => setDefinition(e.target.checked)} /> Definition only</label>}
      <button type="button" aria-label="Zoom out" onClick={() => setScale(v => Math.max(.35, v - .15))} disabled={scale <= .35}>−</button><span>{Math.round(scale * 100)}%</span><button type="button" aria-label="Zoom in" onClick={() => setScale(v => Math.min(1.4, v + .15))} disabled={scale >= 1.4}>+</button>
    </div></div>
    {layout.error ? <p role="alert">{layout.error}</p> : <div ref={viewport} className="pfg-map-scroll" tabIndex={0} aria-label="Scrollable workflow diagram"><div style={{ width: layout.width * scale, height: layout.height * scale }}><div className="pfg-map-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
      <svg width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground,#64748b)" /></marker></defs>
        {layout.edges.map(edge => {
          const sx = edge.source.x + edge.source.width / 2, sy = edge.source.y + edge.source.height;
          const tx = edge.target.x + edge.target.width / 2, ty = edge.target.y;
          const mid = (sy + ty) / 2;
          const path = edge.rework ? `M${edge.source.x},${edge.source.y + 41} C${Math.max(6,edge.source.x - 55)},${edge.source.y + 41} ${Math.max(6,edge.target.x - 55)},${edge.target.y + 41} ${edge.target.x},${edge.target.y + 41}` : `M${sx},${sy} C${sx},${mid} ${tx},${mid} ${tx},${ty - 5}`;
          const text = Array.isArray(edge.when) ? edge.when.join(' / ') : edge.when;
          return <g key={edge.key}><path d={path} fill="none" stroke="var(--muted-foreground,#94a3b8)" strokeWidth="1.3" strokeDasharray={edge.rework ? '5 4' : undefined} markerEnd={`url(#${marker})`} />{text && !edge.rework && <text x={(sx + tx) / 2} y={mid - 5} textAnchor="middle" className="pfg-map-edge-label">{human(text)}</text>}</g>;
        })}
      </svg>
      {layout.nodes.map(item => {
        const status = graphNodeState(item.id, { run: definition ? undefined : run, ready, blocked });
        return <button className="pfg-map-node" key={item.id} type="button" style={{ left: item.x, top: item.y, width: item.width, height: item.height }} data-status={status} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)} aria-label={`${human(item.id)}, ${human(status)}`}><strong>{item.label ?? human(item.id)}</strong><span>{human(item.type)}{item.role ? ` · ${human(item.role)}` : ''}</span>{status !== 'definition' && <span>{human(status)}</span>}</button>;
      })}
    </div></div></div>}
    <p className="pfg-map-note">{run ? `Pinned Graph v${graph.version}. ` : `Graph v${graph.version}. `}Select a step for its work and evidence. Dashed connections show rework. Pending steps may belong to routes that were not selected.</p>
    {node && <div className="pfg-map-detail" aria-live="polite"><h4>{node.label ?? human(node.id)}</h4>{node.purpose && <p>{node.purpose}</p>}<dl><dt>Owner</dt><dd>{human(node.role ?? 'Automatic')}</dd><dt>Review</dt><dd>{human(node.review?.supervisorRole ?? 'Not specified')}</dd><dt>Inputs</dt><dd>{node.requiredInputs?.join(', ') || 'No declared required inputs'}</dd><dt>Outputs</dt><dd>{node.produces?.join(', ') || 'No declared artifacts'}</dd>{run && <><dt>Attempts</dt><dd>{attempts.length}</dd><dt>Goal revision</dt><dd>{run.goalContext?.revisions?.map(revision=>`${human(revision.scope)} v${revision.version}`).join(', ') || 'No objectives pinned at start'}</dd></>}</dl>
      {attempts.map((attempt, i) => <details key={attempt.id ?? i}><summary>Attempt {attempt.attempt ?? i + 1} · {human(attempt.status ?? attempt.outcome ?? 'recorded')}</summary><ul className="pfg-map-artifacts">{(attempt.artifacts ?? []).map((artifact, j) => <li key={`${artifact.id}:${j}`}>{artifact.kind}: {artifact.id} · {artifact.version}</li>)}</ul>{attempt.actor && <p>Execution: {attempt.actor.executionId ?? attempt.actor.id}</p>}</details>)}
      {dispatch?.map((item,i) => <p key={i}>Host execution: {item.agentRunId ?? 'Awaiting dispatch'} · {human(item.state)}{item.shadowId ? ` · Sub-Agent review ${item.shadowId}` : ''}</p>)}
    </div>}
  </section>;
}
