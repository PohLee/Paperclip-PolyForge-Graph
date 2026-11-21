import React, { useEffect, useRef, useState } from 'react';
import { usePluginAction, useHostContext, useHostNavigation, useHostLocation } from '@paperclipai/plugin-sdk/ui';
import { GraphDiagram } from './ui-graph.jsx';
import {useGraphData as useGraph} from './ui-data.mjs';
import { graphHostIssue, runHostActions } from './ui-host-support.mjs';
import { isStaleReviewError, reviewCandidate, reviewHandoff, reviewRequest, reviewSourceUrl } from './ui-review.mjs';
import { dispatchReceiptNotice } from './ui-dispatch-notice.mjs';
import { selectableRunPacks } from '../core/pack-activation.mjs';
import { WorkspaceNav } from './ui-workspace.jsx';
export { WorkspaceToolbarLink } from './ui-workspace.jsx';
export { CompanyDashboardPage, CompanySidebarLink } from './ui-company.jsx';

const colors = {
  text: 'var(--foreground, #1e293b)', muted: 'var(--muted-foreground, #64748b)',
  surface: 'var(--card, #fff)', line: 'var(--border, #d5dce5)',
  accent: 'var(--primary, #2563eb)', accentText: 'var(--primary-foreground, #fff)',
};
const frame = { color: colors.text, maxWidth: 1000, margin: '0 auto', padding: '24px 20px', fontFamily: 'inherit' };
const panel = { background: colors.surface, border: `1px solid ${colors.line}`, borderRadius: 12, padding: 20, marginTop: 16 };
const label = { display: 'block', fontWeight: 650, fontSize: 13, marginBottom: 6 };
const field = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8, border: `1px solid ${colors.line}`, color: colors.text, background: colors.surface, font: 'inherit' };
const button = { border: 0, background: colors.accent, color: colors.accentText, borderRadius: 8, padding: '9px 14px', fontWeight: 650, cursor: 'pointer' };
const secondary = { ...button, background: colors.surface, color: colors.text, border: `1px solid ${colors.line}` };
const small = { fontSize: 13, color: colors.muted, lineHeight: 1.5 };
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' };

const graphNames = { 'ui-ux-design': 'UI / UX design', implementation: 'Implementation', verification: 'Verification',
  'system-architecture': 'System architecture', 'code-delivery': 'Code delivery' };
const graphInputHelp = {
  implementation: 'Include requirement, product decision references, final design identity and architecture_context (accepted baseline or a reason it does not apply).',
  verification: 'Include requirement, product decision references, the fixed implementation candidate and acceptance_criteria with IDs, descriptions and requirement IDs.',
  'system-architecture': 'Include system_id and architecture_brief. For a revision, reference the previous accepted architecture and its decision.',
  'code-delivery': 'Include implementation_candidate, delivery_target (repository, PR URL, full head SHA), required_checks and required_approvals. This records code delivery evidence.',
};
const title = (value) => graphNames[value] ?? String(value ?? '').replaceAll(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const statusText = (value) => String(value ?? 'pending').replaceAll('_', ' ');
const statusTone = (value) => value === 'completed' || value === 'accepted' ? 'done'
  : value === 'paused' || value === 'awaiting_supervisor_review' || value === 'awaiting_self_review' || value === 'blocked' ? 'attention'
    : value === 'running' || value === 'woken' || value === 'ready' ? 'active' : value === 'rework_required' || value === 'failed' ? 'error' : 'quiet';
const dateText = (value) => value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Time unavailable';
const icon = (name) => <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
  {name === 'plus' ? <path d="M12 5v14M5 12h14" /> : name === 'refresh' ? <><path d="M20 11a8 8 0 0 0-14.4-4.8L4 8" /><path d="M4 4v4h4M4 13a8 8 0 0 0 14.4 4.8L20 16" /><path d="M20 20v-4h-4" /></> : <path d="m9 18 6-6-6-6" />}
</svg>;

const styles = `
.pfg { color: var(--foreground, #1e293b); --pfg-done: #278264; --pfg-active: #245ca8; --pfg-attention: #89520a; max-width: 1480px; margin: 0 auto; padding: 26px clamp(18px, 3vw, 42px) 48px; font-family: inherit; }
.dark .pfg { --pfg-done: #5ccba0; --pfg-active: #86b7ff; --pfg-attention: #e5b770; }
.pfg * { box-sizing: border-box; }
.pfg h1,.pfg h2,.pfg h3,.pfg p { margin-top: 0; }
.pfg button,.pfg input,.pfg select,.pfg textarea { font: inherit; }
.pfg button { cursor: pointer; }
.pfg button:disabled { cursor: not-allowed; opacity: .55; }
.pfg button:focus-visible,.pfg a:focus-visible,.pfg summary:focus-visible,.pfg input:focus-visible,.pfg select:focus-visible,.pfg textarea:focus-visible { outline: 2px solid var(--ring, var(--primary, #2563eb)); outline-offset: 2px; }
.pfg .pfg-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 25px; }
.pfg .pfg-header h1 { font-size: 26px; font-weight: 680; letter-spacing: -.025em; margin-bottom: 4px; }
.pfg .pfg-subtitle { color: var(--muted-foreground, #64748b); font-size: 13px; line-height: 1.5; margin: 0; }
.pfg .pfg-header-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.pfg .pfg-button { min-height: 36px; border: 1px solid var(--border, #d5dce5); border-radius: 8px; background: var(--card, #fff); color: var(--foreground, #1e293b); padding: 7px 12px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-weight: 600; font-size: 13px; white-space: nowrap; }
.pfg .pfg-button:hover { background: var(--accent, var(--muted, #f1f5f9)); }
.pfg .pfg-button-primary { background: var(--primary, #2563eb); color: var(--primary-foreground, #fff); border-color: var(--primary, #2563eb); }
.pfg .pfg-button-primary:hover { filter: brightness(.94); background: var(--primary, #2563eb); }
.pfg .pfg-new-run { margin-bottom: 18px; border: 1px solid var(--border, #d5dce5); border-radius: 11px; background: var(--card, #fff); padding: 19px 21px; }
.pfg .pfg-new-run h2 { font-size: 16px; margin-bottom: 4px; }
.pfg .pfg-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }
.pfg .pfg-workspace { display: grid; grid-template-columns: minmax(235px, 292px) minmax(0, 1fr); align-items: start; gap: 16px; }
.pfg .pfg-run-list,.pfg .pfg-detail { border: 1px solid var(--border, #d5dce5); border-radius: 11px; background: var(--card, #fff); min-width: 0; }
.pfg .pfg-list-head { padding: 17px 17px 12px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.pfg .pfg-list-head h2 { font-size: 15px; margin: 0; }
.pfg .pfg-list-scroll { max-height: min(73vh, 860px); overflow-y: auto; padding: 0 7px 8px; scrollbar-color: var(--border, #d5dce5) transparent; }
.pfg .pfg-run-item { width: 100%; display: block; text-align: left; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--foreground, #1e293b); padding: 10px 11px; margin-bottom: 2px; }
.pfg .pfg-run-item:hover { background: var(--accent, var(--muted, #f1f5f9)); }
.pfg .pfg-run-item[aria-current="true"] { background: var(--accent, var(--muted, #f1f5f9)); border-color: var(--border, #d5dce5); }
.pfg .pfg-run-title { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; font-size: 13px; font-weight: 630; }
.pfg .pfg-run-meta { display: flex; justify-content: space-between; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--muted-foreground, #64748b); }
.pfg .pfg-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 620; white-space: nowrap; color: var(--muted-foreground, #64748b); text-transform: capitalize; }
.pfg .pfg-status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.pfg .pfg-status[data-tone="done"] { color: var(--pfg-done, #278264); }
.pfg .pfg-status[data-tone="active"] { color: var(--pfg-active, #4485d8); }
.pfg .pfg-status[data-tone="attention"] { color: var(--pfg-attention, #bb7a22); }
.pfg .pfg-status[data-tone="error"] { color: var(--destructive, #cb4545); }
.pfg .pfg-detail { padding: 23px 26px 28px; }
.pfg .pfg-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; padding-bottom: 17px; border-bottom: 1px solid var(--border, #d5dce5); }
.pfg .pfg-detail-head h2 { font-size: 21px; letter-spacing: -.02em; margin: 0 0 7px; }
.pfg .pfg-detail-meta { color: var(--muted-foreground, #64748b); font-size: 12px; line-height: 1.5; }
.pfg .pfg-section { padding-top: 23px; }
.pfg .pfg-section + .pfg-section { margin-top: 24px; border-top: 1px solid var(--border, #d5dce5); }
.pfg .pfg-section h3 { font-size: 15px; margin-bottom: 8px; }
.pfg .pfg-section > p { color: var(--muted-foreground, #64748b); font-size: 12px; line-height: 1.5; }
.pfg .pfg-work-list { display: grid; gap: 6px; margin-top: 11px; }
.pfg .pfg-work-row,.pfg .pfg-node-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 11px; border: 1px solid var(--border, #d5dce5); border-radius: 7px; font-size: 13px; }
.pfg .pfg-work-row > span:first-child,.pfg .pfg-node-row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.pfg .pfg-quiet { color: var(--muted-foreground, #64748b); font-size: 12px; line-height: 1.55; }
.pfg .pfg-review-guide { display: grid; grid-template-columns: minmax(0, 1fr); gap: 11px; margin: 12px 0 16px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.pfg .pfg-review-guide dt { font-weight: 650; }
.pfg .pfg-review-guide dd { margin: 2px 0 0; }
.pfg .pfg-review-guide ul { margin: 3px 0 0; padding-inline-start: 18px; }
.pfg .pfg-review-guide li + li { margin-top: 5px; }
.pfg .pfg-review-guide a { color: var(--pfg-active); text-decoration: underline; text-underline-offset: 2px; }
.pfg .pfg-review-actions { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; }
.pfg .pfg-disclosure { border-top: 1px solid var(--border, #d5dce5); padding-top: 15px; margin-top: 20px; }
.pfg .pfg-disclosure summary { cursor: pointer; font-size: 13px; font-weight: 630; display: list-item; }
.pfg .pfg-disclosure-body { padding: 13px 0 2px; }
.pfg .pfg-node-group { margin-bottom: 17px; }
.pfg .pfg-node-group h4 { font-size: 11px; color: var(--muted-foreground, #64748b); font-weight: 650; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 6px; }
.pfg .pfg-node-rows { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 5px; }
.pfg .pfg-node-row { border: 0; background: var(--muted, #f1f5f9); padding: 7px 9px; font-size: 12px; }
.pfg .pfg-dispatch-row { border-bottom: 1px solid var(--border, #d5dce5); padding: 9px 0; font-size: 12px; line-height: 1.6; }
.pfg .pfg-dispatch-row:last-child { border-bottom: 0; }
.pfg .pfg-code { font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.pfg .pfg-json { margin: 8px 0 0; padding: 10px; border-radius: 6px; background: var(--muted, #f1f5f9); font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; }
.pfg .pfg-history { margin: 0; padding-left: 20px; }
.pfg .pfg-history li { padding: 5px 0 11px; font-size: 12px; }
.pfg .pfg-history li + li { border-top: 1px solid var(--border, #d5dce5); padding-top: 11px; }
.pfg .pfg-empty { min-height: 155px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; padding: 22px; color: var(--muted-foreground, #64748b); font-size: 13px; line-height: 1.5; }
.pfg .pfg-empty strong { color: var(--foreground, #1e293b); margin-bottom: 3px; }
.pfg .pfg-empty h2 {margin:0 0 4px;font-size:17px;color:var(--foreground)}
.pfg .pfg-empty p {margin:0 0 12px}
.pfg {container-type:inline-size}
@container (max-width:720px) {
  .pfg .pfg-workspace {grid-template-columns:minmax(0,1fr)}
  .pfg .pfg-list-scroll {max-height:245px}
  .pfg .pfg-detail-head {flex-wrap:wrap}
}
.pfg .pfg-loading { display: grid; gap: 8px; padding: 18px; }
.pfg .pfg-loading span { height: 12px; border-radius: 4px; background: var(--muted, #f1f5f9); }
@media (max-width: 850px) { .pfg { padding: 20px 16px 36px; } .pfg .pfg-workspace { grid-template-columns: 1fr; } .pfg .pfg-list-scroll { max-height: 245px; } .pfg .pfg-detail { padding: 20px; } }
@media (max-width: 540px) { .pfg .pfg-header { align-items: stretch; flex-direction: column; } .pfg .pfg-header-actions { width: 100%; } .pfg .pfg-header-actions .pfg-button { flex: 1; } .pfg .pfg-form-grid,.pfg .pfg-node-rows { grid-template-columns: 1fr; } .pfg .pfg-detail-head { flex-direction: column; gap: 5px; } }
`;

function Status({ value }) { return <span className="pfg-status" data-tone={statusTone(value)}>{statusText(value)}</span>; }
function LoadingRows() { return <div className="pfg-loading" role="status" aria-label="Loading Graph data"><span style={{ width: '70%' }} /><span style={{ width: '92%' }} /><span style={{ width: '57%' }} /></div>; }

function Message({ kind, children }) {
  if (!children) return null;
  return <p role={kind === 'error' ? 'alert' : 'status'} style={{
    marginTop: 12, padding: '9px 12px', borderRadius: 8,
    background: kind === 'error' ? 'var(--destructive-muted, #fef2f2)' : 'var(--muted, #f1f5f9)',
    color: kind === 'error' ? 'var(--destructive, #991b1b)' : colors.text,
  }}>{children}</p>;
}



function DecisionHistory({ decisions = [], heading = 'Decision history', scope = 'run' }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const search = query.trim().toLowerCase();
  const matches = [...decisions].filter((decision) => !search || JSON.stringify(decision).toLowerCase().includes(search))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  if (!decisions.length) return null;
  return <details className="pfg-disclosure"><summary>{heading} ({decisions.length})</summary><div className="pfg-disclosure-body">
    <label htmlFor={`${scope}-decision-search`} style={label}>Find a decision</label>
    <input id={`${scope}-decision-search`} type="search" style={field} value={query}
      placeholder="Search by type, actor, reason, or record ID"
      onChange={(event) => { setQuery(event.target.value); setLimit(20); }} />
    <p className="pfg-quiet" style={{ margin: '9px 0' }} aria-live="polite">{matches.length ? `Showing ${Math.min(limit, matches.length)} of ${matches.length} matching records, newest first.` : 'No decisions match this search.'}</p>
    <ol className="pfg-history">{matches.slice(0, limit).map((decision) => <li key={decision.id}>
      <strong>{title(decision.type)}: {title(decision.outcome ?? decision.status)}</strong>
      <div className="pfg-quiet">{decision.actor?.kind ?? 'Unknown actor'} {decision.actor?.id} · {dateText(decision.at)}</div>
      {decision.question ? <p style={{ margin: '7px 0 3px', fontWeight: 600 }}>{decision.question}</p> : null}
      <div>{decision.reason}</div>
      {decision.nodeId ? <div className="pfg-quiet">{title(decision.nodeId)}{decision.attemptNumber ? ` · attempt ${decision.attemptNumber}` : ''}</div> : null}
      <details><summary className="pfg-quiet">Evidence, alternatives, and linked records</summary>
        <div className="pfg-quiet">Decision ID: <span className="pfg-code">{decision.id}</span></div>
        {decision.supersedes ? <div className="pfg-quiet">Previous decision: <span className="pfg-code">{decision.supersedes}</span></div> : null}
        {decision.options?.length ? <><div className="pfg-quiet" style={{ marginTop: 8 }}>Considered alternatives</div><pre className="pfg-json">{JSON.stringify(decision.options, null, 2)}</pre></> : null}
        <div className="pfg-quiet" style={{ marginTop: 8 }}>Evidence: {decision.evidence?.length ? null : 'None recorded'}</div>
        {decision.evidence?.length ? <pre className="pfg-json">{JSON.stringify(decision.evidence, null, 2)}</pre> : null}
        <div className="pfg-quiet" style={{ marginTop: 8 }}>Artifacts: {decision.artifacts?.length ? null : 'None recorded'}</div>
        {decision.artifacts?.length ? <pre className="pfg-json">{JSON.stringify(decision.artifacts, null, 2)}</pre> : null}
        <details style={{ marginTop: 10 }}><summary className="pfg-quiet">Complete record and version context</summary><pre className="pfg-json">{JSON.stringify(decision, null, 2)}</pre></details>
      </details>
    </li>)}</ol>
    {matches.length > limit ? <button className="pfg-button" type="button" onClick={() => setLimit((value) => value + 20)}>Show more records</button> : null}
  </div></details>;
}

function ConflictDossier({ conflict }) {
  const dimensions = { scope: 'Scope', timeline: 'Timeline', resources: 'Resources', risk: 'Risk', successCriteria: 'Success criteria' };
  return <div style={{ margin: '14px 0 18px', overflowWrap: 'anywhere' }}>
    <h4 style={{ margin: '0 0 10px' }}>Why this needs your decision</h4>
    <div className="pfg-form-grid">{[['cpo', 'CPO'], ['cto', 'CTO + CAIO']].map(([key, name]) => {
      const position = conflict.positions?.[key];
      if (!position) return null;
      return <section key={key} style={{ border: '1px solid var(--border, #d5dce5)', borderRadius: 8, padding: 12, minWidth: 0 }} aria-label={`${name} position`}>
        <strong>{name}{position.outcome ? ` · ${title(position.outcome)}` : ''}</strong>
        <p style={{ margin: '7px 0', fontSize: 13 }}>{typeof position === 'string' ? position : position.reason}</p>
        {Object.entries(position.dimensions ?? {}).map(([dimension, value]) => <p className="pfg-quiet" style={{ margin: '5px 0' }} key={dimension}><strong>{dimensions[dimension] ?? title(dimension)}:</strong> {value}</p>)}
        {position.nonNegotiables?.length ? <p className="pfg-quiet" style={{ margin: '7px 0' }}><strong>Required constraints:</strong> {position.nonNegotiables.join('; ')}</p> : null}
        {position.id ? <div className="pfg-quiet">Position record: <span className="pfg-code">{position.id}</span></div> : null}
      </section>;
    })}</div>
    <p style={{ margin: '13px 0 5px', fontSize: 13, fontWeight: 600 }}>Unresolved issues</p>
    <ul className="pfg-quiet" style={{ margin: 0, paddingLeft: 19 }}>{(conflict.unresolved ?? []).map((item, index) => <li key={index}>{typeof item === 'string' ? item : `${title(item.dimension)}: ${item.issue}`}</li>)}</ul>
    {conflict.negotiation?.length ? <details style={{ marginTop: 10 }}><summary className="pfg-quiet">Negotiation and supporting evidence ({conflict.negotiation.length})</summary>
      {conflict.negotiation.map((round, index) => <div key={index} style={{ marginTop: 10 }}>
        <strong style={{ fontSize: 12 }}>{title(round.dimension)}: {round.issue}</strong>
        <p className="pfg-quiet" style={{ margin: '5px 0' }}>Proposal: {round.proposal}</p>
        <p className="pfg-quiet" style={{ margin: '5px 0' }}>CPO response: {round.cpoResponse}</p>
        <p className="pfg-quiet" style={{ margin: '5px 0' }}>CTO response: {round.ctoResponse}</p>
        <pre className="pfg-json">{JSON.stringify(round.evidence, null, 2)}</pre>
      </div>)}
    </details> : null}
  </div>;
}

function ReviewGuide({ candidate, choices }) {
  const text = value => typeof value === 'string' && value.trim() ? value : null;
  const versions = [...new Set(candidate.artifacts.map(item => item.version))];
  return <dl className="pfg-review-guide">
    <div><dt>What to decide</dt><dd>{text(candidate.question) ?? 'No question provided.'}</dd></div>
    {text(candidate.proposal) ? <div><dt>Proposed behavior</dt><dd>{candidate.proposal}</dd></div> : null}
    {text(candidate.reason) && candidate.reason !== candidate.question ? <div><dt>Reason for review</dt><dd>{candidate.reason}</dd></div> : null}
    {choices.length ? <div><dt>Available outcomes</dt><dd>{choices.join(' · ')}</dd></div> : null}
    <div><dt>Candidate version</dt><dd>{versions.length ? versions.map((value, index) =>
      <React.Fragment key={value}>{index > 0 ? ' · ' : ''}<code className="pfg-code" title={value}>
        {value.length > 12 ? `${value.slice(0, 12)}…` : value}
      </code></React.Fragment>) : 'Unavailable'}</dd></div>
    <div><dt>Candidate artifacts</dt><dd>{candidate.artifacts.length ? <>
      <ul>{candidate.artifacts.map(item => {
        const href = reviewSourceUrl(item.url ?? item.sourceRef?.url);
        const name = text(item.title) ?? title(text(item.kind) ?? item.id);
        return <li key={JSON.stringify([item.id, item.version])}>
          {href ? <a href={href}>{name}</a> : name}
          <div className="pfg-quiet"><code className="pfg-code">{item.id}@{item.version}</code>
            {href ? null : typeof item.path === 'string' ? <> · {item.path}</> : ' · Link unavailable'}</div>
        </li>;
      })}</ul>
      {candidate.missingArtifacts ? <span className="pfg-quiet">Some required candidate artifacts are unavailable.</span> : null}
    </> : 'No candidate artifacts available.'}</dd></div>
    <div><dt>Evidence linked to this candidate</dt><dd>{candidate.evidence.length ? <ul>{candidate.evidence.map(item => {
      const summary = text(item.summary) ?? text(item.reason) ?? title(text(item.kind) ?? 'Recorded evidence');
      const href = reviewSourceUrl(item.sourceRef?.url ?? item.url);
      return <li key={JSON.stringify(item)}>
        {href ? <a href={href}>{summary}</a> : summary}
        {typeof item.sourceRef?.id === 'string' ? <div className="pfg-quiet">{title(item.sourceRef.kind ?? 'Source')} <code className="pfg-code">{item.sourceRef.id}</code></div> : null}
      </li>;
    })}</ul> : 'No candidate-linked evidence available.'}</dd></div>
  </dl>;
}

function StandardRouteEvidence({ route }) {
  const refs = [
    ['Scope evidence', route.scopeEvidenceRef],
    ['Check evidence', route.evidenceRef],
  ].filter(([, value]) => typeof value === 'string' && value);
  const diff = Array.isArray(route.diff) ? route.diff : [];
  if (!route.baseSha && !route.headSha && !diff.length && !refs.length) return null;
  return <dl className="pfg-review-guide">
    {route.baseSha ? <div><dt>Base commit</dt><dd><code className="pfg-code">{route.baseSha}</code></dd></div> : null}
    {route.headSha ? <div><dt>Candidate commit</dt><dd><code className="pfg-code">{route.headSha}</code></dd></div> : null}
    {diff.length ? <div><dt>Recorded diff</dt><dd><ul>
      {diff.map((item, index) => <li key={`${item.path}:${index}`}>
        <code className="pfg-code">{item.status} {item.path}</code>
      </li>)}
    </ul></dd></div> : null}
    {refs.map(([name, value]) => {
      const href = reviewSourceUrl(value);
      return <div key={name}><dt>{name}</dt><dd>{href
        ? <a href={href}>{value}</a> : <code className="pfg-code">{value}</code>}</dd></div>;
    })}
  </dl>;
}

function RunLesson({ run, companyId }) {
  const command = usePluginAction('graph-company-command');
  const submission = useRef(null);
  const [selected, setSelected] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [saving, setSaving] = useState(false);
  const candidates = Object.entries(run.nodeStates).flatMap(([nodeId, state]) =>
    (state.attempts ?? []).flatMap((attempt, index) => (attempt.artifacts ?? [])
      .filter(item => item.id && item.version).map(item => ({
        nodeId, attemptNumber: index + 1, candidate: { id: item.id, version: item.version }
      }))));
  if (!candidates.length) return null;

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const observation = values.get('observation').trim();
    const request = {
      companyId, operation: 'record-run-lesson', projectId: run.input.projectId, runId: run.id,
      ...JSON.parse(selected), title: values.get('title').trim(), observation,
      suggestedChange: values.get('suggestedChange').trim(), reason: observation,
    };
    const identity = JSON.stringify(request);
    if (submission.current?.identity !== identity) submission.current = { identity, key: crypto.randomUUID() };
    setSaving(true);
    setFeedback(null);
    try {
      await command({ ...request, idempotencyKey: submission.current.key });
      submission.current = null;
      form.reset();
      setSelected('');
      setFeedback({ text: 'Run lesson saved to Company operations → Knowledge.' });
    } catch (error) {
      setFeedback({ kind: 'error', text: error?.message || 'Unable to save this lesson. Try again.' });
    } finally { setSaving(false); }
  }

  return <details className="pfg-disclosure"><summary>Record a run lesson</summary><div className="pfg-disclosure-body">
    <form onSubmit={save}>
      <div className="pfg-form-grid">
        <label><span style={label}>Source attempt and artifact</span>
          <select style={field} value={selected} onChange={event => setSelected(event.target.value)} required disabled={saving}>
            <option value="">Choose an artifact</option>
            {candidates.map(item => <option key={JSON.stringify(item)} value={JSON.stringify(item)}>
              {title(item.nodeId)} · attempt {item.attemptNumber} · {item.candidate.id}@{item.candidate.version}
            </option>)}
          </select>
        </label>
        <label><span style={label}>Lesson title</span><input name="title" style={field} required disabled={saving} /></label>
        <label><span style={label}>What happened</span><textarea name="observation" style={field} required disabled={saving} /></label>
        <label><span style={label}>What to change next time</span><textarea name="suggestedChange" style={field} required disabled={saving} /></label>
      </div>
      <button className="pfg-button" type="submit" disabled={saving || !selected}>{saving ? 'Saving…' : 'Save run lesson'}</button>
      <Message kind={feedback?.kind}>{feedback?.text}</Message>
    </form>
  </div></details>;
}

function RunDetails({ data, issueId, refresh, onNotice, retryAttempt, staleReview, onStaleReview }) {
  const navigation = useHostNavigation();
  const action = usePluginAction('graph-command');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const decisionAttempt = useRef(null);
  const [decisionError, setDecisionError] = useState('');
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState('');
  const [evidenceText, setEvidenceText] = useState('[]');
  const [retryNodeId, setRetryNodeId] = useState('');
  const [retryReason, setRetryReason] = useState('');
  const [retryFeedback, setRetryFeedback] = useState(null);
  const [validationReason, setValidationReason] = useState('');
  const [validationError, setValidationError] = useState('');
  const decisionContext = JSON.stringify([data?.runDigest,
    reviewRequest(data?.run, data?.work?.find(item => item.kind === 'human'))]);
  useEffect(() => {
    decisionAttempt.current = null;
    setReason(''); setOutcome(''); setEvidenceText('[]'); setDecisionError('');
  }, [decisionContext]);
  const run = data?.run;
  if (!run) return <div className="pfg-detail pfg-empty"><strong>Choose a run</strong>Select a run to see its current work and history.</div>;

  const hostActions = runHostActions(data.runHostSupport, data.viewer);

  const pendingHuman = run.pendingHuman;
  const waitingConflict = run.conflicts?.find((conflict) => conflict.status === 'waiting_human');
  const byId = (id) => run.graph.nodes.find((node) => node.id === id);
  const humanWork = data.work?.find((item) => item.kind === 'human') ?? null;
  const actionNode = humanWork?.nodeId ? byId(humanWork.nodeId) : null;
  const operation = humanWork?.operation ?? null;
  const needsAction = Boolean(operation) && !hostActions.blocked;
  const hasAdvancedDecision = ['decide', 'review', 'resolve-human-gate', 'resolve-rework-limit', 'resolve-conflict']
    .includes(operation);
  const request = reviewRequest(run, humanWork);
  const handoff = needsAction ? reviewHandoff(data, request, staleReview) : null;
  const candidate = needsAction ? reviewCandidate(data, humanWork, actionNode, request) : null;
  const refreshNeeded = handoff?.refreshNeeded;
  const actionTitles = {
    'resolve-rework-limit': 'Rework limit needs a decision',
    'resolve-conflict': 'CPO / CTO conflict needs a decision',
    'resolve-product-decision': 'Review proposed product behavior',
    'resolve-takeover': 'Human takeover needs a decision',
    review: `Review ${title(actionNode?.id)}`,
  };
  const actionTitle = actionTitles[operation] ?? `Decide ${title(actionNode?.id)}`;
  const conflictOptions = operation === 'resolve-conflict'
    ? waitingConflict?.options?.filter((item) => item && typeof item.id === 'string') ?? [] : [];
  const outcomes = conflictOptions.length ? conflictOptions.map((item) => item.id) : humanWork?.outcomes ?? [];
  const outcomeLabel = value => conflictOptions.find(item => item.id === value)?.label ?? title(value);
  const selectedConflictOption = operation === 'resolve-conflict' ? waitingConflict?.options?.find((item) => item.id === outcome) : null;
  const readyIds = new Set(data.ready?.map((node) => node.id) ?? []);
  const dispatchIds = new Set(data.dispatches?.map((item) => item.nodeId) ?? []);
  const current = run.status === 'running' && !hostActions.blocked
    ? run.graph.nodes.filter((node) => readyIds.has(node.id) || dispatchIds.has(node.id)) : [];
  const retryOptions = run.graph.nodes.filter((node) => ['task', 'decision'].includes(node.type) &&
    (run.nodeStates[node.id]?.status !== 'pending' || readyIds.has(node.id)));
  const canRetry = !hostActions.blocked && run.status === 'running' && !pendingHuman && !waitingConflict && issueId === run.input.paperclipIssueId;
  const canDispatch = canRetry && data.work?.some((item) => ['agent', 'automatic'].includes(item.kind));
  const groups = [
    { name: 'Active and awaiting review', nodes: run.graph.nodes.filter((node) => !['pending', 'completed'].includes(run.nodeStates[node.id]?.status)) },
    { name: 'Completed', nodes: run.graph.nodes.filter((node) => run.nodeStates[node.id]?.status === 'completed') },
    { name: 'Pending', nodes: run.graph.nodes.filter((node) => run.nodeStates[node.id]?.status === 'pending') },
  ].filter((group) => group.nodes.length);

  async function decide(event) {
    event.preventDefault();
    if (!hasAdvancedDecision || refreshNeeded || busy) return;
    setBusy(true); setDecisionError(''); onNotice('');
    try {
      const evidence = JSON.parse(evidenceText);
      if (!Array.isArray(evidence)) throw new Error('Evidence must be a JSON array');
      const expectedDecisionId = operation === 'resolve-human-gate' ? pendingHuman?.escalationDecisionId
        : operation === 'resolve-rework-limit' ? pendingHuman?.decisionId : undefined;
      const command = { issueId, operation, runId: run.id, nodeId: humanWork?.nodeId,
        conflictId: humanWork?.conflictId, expectedDecisionId, expectedRunDigest: data.runDigest, outcome, reason, evidence };
      const identity = JSON.stringify(command);
      if (decisionAttempt.current?.identity !== identity) decisionAttempt.current = { identity, args: {
        ...command, idempotencyKey: crypto.randomUUID() } };
      await action(decisionAttempt.current.args);
      decisionAttempt.current = null;
      setReason(''); setOutcome(''); onNotice('Decision recorded.'); refresh();
    } catch (err) {
      if (request?.requestId && isStaleReviewError(err)) {
        decisionAttempt.current = null;
        setReason(''); setOutcome(''); setEvidenceText('[]');
        onStaleReview({ ...request, runDigest: data.runDigest, interactionId: handoff?.native?.interactionId });
      } else {
        setDecisionError(typeof err?.message === 'string' ? err.message : String(err));
      }
    }
    finally { setBusy(false); }
  }

  async function retry(event) {
    event.preventDefault(); setBusy(true); setRetryFeedback(null); onNotice('');
    try {
      const request = { issueId: run.input.paperclipIssueId, operation: 'retry-node', runId: run.id,
        nodeId: retryNodeId, reason: retryReason };
      const identity = JSON.stringify(request);
      if (retryAttempt.current?.identity !== identity) {
        retryAttempt.current = { identity, key: crypto.randomUUID() };
      }
      const response = await action({ ...request, idempotencyKey: retryAttempt.current.key });
      if (response?.result?.dispatchCleanupPending) {
        setRetryFeedback({ message: 'Retry recorded. Cleanup is pending. Submit this same node and reason again to finish cleanup.' });
        return;
      }
      retryAttempt.current = null;
      const confirmation = response?.result?.nextAttempt === null
        ? 'The retry did not open a new attempt. Review the recorded decision.'
        : 'Node retry recorded.';
      onNotice([confirmation, dispatchReceiptNotice(response?.dispatch)].filter(Boolean).join(' '));
      setRetryNodeId(''); setRetryReason(''); refresh();
    } catch (err) { setRetryFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(false); }
  }

  async function dispatchReadyWork() {
    setBusy(true); setError(''); onNotice('');
    try {
      const response = await action({ issueId: run.input.paperclipIssueId, operation: 'dispatch', runId: run.id,
        reason: 'Requested dispatch of eligible Graph work from the run page', idempotencyKey: crypto.randomUUID() });
      onNotice(dispatchReceiptNotice(response?.dispatch) || 'Dispatch request recorded. See current work for its status.');
      refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function validateExistingRun(event) {
    event.preventDefault();
    if (busy || !hostActions.canValidate || !validationReason.trim()) return;
    setBusy(true); setValidationError(''); onNotice('');
    try {
      const response = await action({ issueId: run.input.paperclipIssueId, operation: 'revalidate-run',
        runId: run.id, reason: validationReason.trim(), idempotencyKey: crypto.randomUUID() });
      const validation = response?.validation ?? response?.result?.validation ?? response?.result ?? response;
      onNotice(validation?.valid === true
        ? 'Validation passed. Original attempts and decisions were preserved. Refreshing available actions…'
        : 'Validation finished. Review the recorded result and any remaining issues below.');
      refresh();
    } catch (err) { setValidationError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return <article className="pfg-detail" aria-label="Graph run details">
    <header className="pfg-detail-head"><div><h2>{title(run.graph.id)}</h2>
      <div className="pfg-detail-meta">Started {dateText(run.startedAt)} · {title(run.mode)} mode · Graph v{run.graph.version}</div>
      <div className="pfg-detail-meta">{run.graph.nodes.filter((node) => run.nodeStates[node.id]?.status === 'completed').length} completed nodes · {data.decisions?.length ?? 0} recorded decisions</div>
    </div><Status value={run.status} /></header>

    <Message kind="error">{validationError}</Message>

    {run.standardRoute ? <section className="pfg-section" aria-label="Standard workflow handoff">
      <h3>{run.standardRoute.targetRunId ? 'Moved to standard implementation' : 'Standard implementation needs attention'}</h3>
      <p>{run.standardRoute.reason}</p>
      <StandardRouteEvidence route={run.standardRoute} />
      {run.standardRoute.targetRunId
        ? <a {...navigation.linkProps(`/graph-runs?runId=${encodeURIComponent(run.standardRoute.targetRunId)}`)}>Open standard implementation run</a>
        : <p role="status">{run.standardRoute.blockedReason}</p>}
    </section> : run.admission?.outcome === 'standard' ? <section className="pfg-section" aria-label="Standard workflow handoff">
      <h3>Routed to standard implementation</h3>
      <p>{run.admission.reason}</p>
      <StandardRouteEvidence route={run.admission} />
      {run.admission.sourceRunId ? <a {...navigation.linkProps(`/graph-runs?runId=${encodeURIComponent(run.admission.sourceRunId)}`)}>Open original attempt and evidence</a> : null}
    </section> : null}

    {hostActions.blocked ? <section className="pfg-section" aria-label="Pack host validation" style={{ overflowWrap: 'anywhere' }}>
      <h3>{data.runHostSupport.recoverable ? 'Existing run needs validation' : 'Pack host unavailable'}</h3>
      <p role="status">{data.runHostSupport.reason || 'This run cannot continue until its trusted Pack host is available.'}</p>
      <p className="pfg-quiet">Existing attempts and decision history are preserved. Dispatch, decisions and node retries are unavailable while this run is blocked.</p>
      {data.runHostSupport.validation?.issues?.length ? <ul>
        {data.runHostSupport.validation.issues.map((item, index) => <li key={`${item.code ?? 'issue'}:${index}`}>
          {item.message}{item.path ? <span className="pfg-code"> · {item.path}</span> : null}
          {item.action ? <p className="pfg-quiet">{item.action}</p> : null}
        </li>)}
      </ul> : null}
      {hostActions.canValidate ? <form onSubmit={validateExistingRun}>
        <label htmlFor="host-validation-reason" style={label}>Reason for validating this run</label>
        <input id="host-validation-reason" style={field} value={validationReason}
          onChange={event => setValidationReason(event.target.value)} required disabled={busy}
          aria-describedby="host-validation-help" />
        <p id="host-validation-help" className="pfg-quiet" style={{ marginTop: 8 }}>An authorized owner can validate the pinned Pack and saved evidence. This does not dispatch work or rewrite its history.</p>
        <button className="pfg-button" type="submit" disabled={busy || !validationReason.trim()}>{busy ? 'Validating…' : 'Validate existing run'}</button>
      </form> : data.runHostSupport.recoverable ? <p className="pfg-quiet">Ask a human owner to validate this run.</p> : <p className="pfg-quiet">Ask the operator to configure the missing trusted adapter or service, then refresh.</p>}
    </section> : null}

    {needsAction && issueId ? <section className="pfg-section" aria-label="Human decision">
      <h3>{actionTitle}</h3>
      <ReviewGuide candidate={candidate} choices={outcomes.map(outcomeLabel)} />
      {operation === 'resolve-conflict' && waitingConflict ? <ConflictDossier conflict={waitingConflict} /> : null}
      {handoff.outdated ? <Message kind={refreshNeeded ? 'error' : undefined}>
        {handoff.replacement ? 'The previous review is out of date. Review the candidate above and open the new Paperclip Decision.'
          : handoff.refreshed ? 'The previous review is out of date. Review the refreshed candidate above before recording a decision.'
            : 'This review is out of date. Refresh the run to see the current candidate and decision.'}
      </Message> : null}
      {handoff.syncError || data.nativeDecisionError ? <Message kind="error">
        {handoff.syncError ?? data.nativeDecisionError}
      </Message> : null}
      <div className="pfg-review-actions">
        {handoff.native ? <a className="pfg-button pfg-button-primary"
          {...navigation.linkProps(`${handoff.native.url}#interaction-${encodeURIComponent(handoff.native.interactionId)}`)}>
          {handoff.replacement ? 'Open new Paperclip Decision' : 'Open Paperclip Decision'}
        </a> : null}
        {!handoff.native || handoff.syncError || data.nativeDecisionError ? <button className="pfg-button" type="button"
          onClick={() => { if (handoff.outdated) onStaleReview(handoff.outdated); refresh(); }}>Refresh run</button> : null}
      </div>
      {!handoff.native && !handoff.outdated && !handoff.syncError && !data.nativeDecisionError
        ? <p className="pfg-quiet" style={{ marginTop: 8 }}>A Paperclip Decision is unavailable for this request.</p> : null}
      {hasAdvancedDecision ? <details className="pfg-disclosure"><summary>Advanced decision entry</summary><p className="pfg-quiet">Use this form to include additional evidence. Paperclip checks your identity and assigned roles.</p><form onSubmit={decide}>
        <div className="pfg-form-grid">
          <div><label htmlFor="graph-outcome" style={label}>Outcome</label><select id="graph-outcome" style={field} value={outcome} onChange={(event) => setOutcome(event.target.value)} required>
            <option value="">Choose outcome</option>{outcomes.map((value) => {
              const option = operation === 'resolve-conflict' ? waitingConflict?.options?.find((item) => item.id === value) : null;
              return <option key={value} value={value}>{outcomeLabel(value)}{option?.disposition ? ` — ${title(option.disposition)}` : value === 'human' ? ' — pause for human resolution' : ''}</option>;
            })}
          </select></div>
          <div><label htmlFor="graph-reason" style={label}>Reason</label><input id="graph-reason" style={field} value={reason} onChange={(event) => setReason(event.target.value)} required /></div>
        </div>
        {selectedConflictOption?.disposition ? <p className="pfg-quiet" role="status" style={{ margin: '10px 0' }}>{selectedConflictOption.disposition === 'rework'
          ? `This restarts ${title(selectedConflictOption.targetNodeId)} and invalidates affected downstream evidence.`
          : selectedConflictOption.disposition === 'stop' ? 'This stops the Graph run.'
            : 'This resumes the current gate. Its normal review and evidence checks still apply.'}</p> : null}
        <label htmlFor="graph-evidence" style={{ ...label, marginTop: 12 }}>Evidence (JSON array)</label>
        {operation === 'resolve-conflict' && waitingConflict?.escalationDecisionId ? <button className="pfg-button" type="button" style={{ marginBottom: 8 }} onClick={() => setEvidenceText(JSON.stringify([
          { kind: 'conflict_dossier', summary: 'Recorded CPO/CTO positions, negotiation and unresolved options', sourceRef: { kind: 'decision', id: waitingConflict.escalationDecisionId } },
        ], null, 2))}>Attach conflict dossier</button> : null}
        <textarea id="graph-evidence" style={{ ...field, minHeight: 86, ...mono }} value={evidenceText} onChange={(event) => setEvidenceText(event.target.value)} spellCheck={false} />
        <button className="pfg-button pfg-button-primary" type="submit" style={{ marginTop: 12 }} disabled={busy || !outcome || refreshNeeded}>
          {busy ? 'Recording…' : decisionError && decisionAttempt.current ? 'Retry decision' : 'Record decision'}
        </button>
        <Message kind="error">{decisionError}</Message>
      </form></details> : null}
    </section> : null}

    <section className="pfg-section" aria-label="Current Graph work"><h3>Current work</h3>
      {data.blocked?.length ? <div className="pfg-work-list">{data.blocked.map((item) => <div className="pfg-work-row" key={item.id}>
        <span><strong>{title(item.id)}</strong><br /><span className="pfg-code">{item.id}</span><br /><span className="pfg-quiet">Missing: {item.missingInputs?.join(', ')}</span></span><Status value="blocked" />
      </div>)}</div> : null}
      {current.length ? <div className="pfg-work-list">{current.map((node) => {
        const item = data.work?.find((entry) => entry.nodeId === node.id && entry.kind === 'blocked');
        return <div className="pfg-work-row" key={node.id}>
          <span><strong>{title(node.id)}</strong><br /><span className="pfg-code">{node.id}</span>{node.purpose ? <><br /><span className="pfg-quiet">{node.purpose}</span></> : null}{item?.reason ? <><br /><span className="pfg-quiet">{item.reason}</span></> : null}</span>
          <Status value={item ? 'blocked' : run.nodeStates[node.id]?.status === 'pending' ? 'ready' : run.nodeStates[node.id]?.status} />
        </div>;
      })}</div> : !data.blocked?.length ? <p className="pfg-quiet">{hostActions.blocked ? 'Work is blocked by Pack host validation. See the explanation above.' : run.status === 'completed' ? 'All work in this run is complete.' : run.status === 'stopped' ? 'This run was stopped by a human decision. Previous node and dispatch records remain below.' : run.status === 'paused' ? 'This run is paused. See the decision or control record below.' : run.status === 'rework_required' ? 'This run requires rework. Previous work remains in the history below.' : 'No node is ready right now. Refresh to check for new work.'}</p> : null}
      {run.status === 'running' && data.dispatches?.length ? <p className="pfg-quiet" style={{ marginTop: 9 }}>Agent work is dispatched through Paperclip. A woken run may still be executing; inspect its host run before retrying.</p> : null}
      {canDispatch ? <div style={{ marginTop: 12 }}>
        <button className="pfg-button" type="button" onClick={dispatchReadyWork} disabled={busy}>{busy ? 'Dispatching…' : 'Dispatch ready work'}</button>
        <p className="pfg-quiet" style={{ marginTop: 8 }}>An authorized owner can dispatch pending work after an interruption. Existing attempts are preserved.</p>
        <Message kind="error">{error}</Message>
      </div> : null}
    </section>

    <GraphDiagram graph={run.graph} run={run} ready={data.ready} blocked={data.blocked} dispatches={data.dispatches} />
    <details className="pfg-disclosure"><summary>All nodes ({run.graph.nodes.length})</summary><div className="pfg-disclosure-body">
      {groups.map((group) => <div className="pfg-node-group" key={group.name}><h4>{group.name} · {group.nodes.length}</h4><div className="pfg-node-rows">
        {group.nodes.map((node) => <div className="pfg-node-row" key={node.id}><span>{title(node.id)}<br /><span className="pfg-code">{node.id}</span></span><Status value={run.nodeStates[node.id]?.status} /></div>)}
      </div></div>)}
      <p className="pfg-quiet">Pending can include routes not selected by an earlier decision. This view does not mark any route skipped.</p>
    </div></details>

    {data.dispatches?.length ? <details className="pfg-disclosure"><summary>Paperclip dispatch ({data.dispatches.length})</summary><div className="pfg-disclosure-body">
      {data.dispatches.map((item) => <div className="pfg-dispatch-row" key={`${item.nodeId}:${item.phase}`}><strong>{title(item.nodeId)}</strong> · <span className="pfg-code">{item.nodeId}</span> · {item.phase} · attempt {item.attempt} · <Status value={item.state} />
        <div className="pfg-quiet">Issue: <span className="pfg-code">{item.issueId ?? (item.receiptStatus === 'effect_unknown' ? 'Awaiting confirmation' : 'No linked issue')}</span></div>
        {item.receiptStatus === 'assignment_pending' ? <p className="pfg-quiet">Assignment awaiting confirmation.</p> : null}
        {item.agentRunId ? <div className="pfg-quiet">Host run: <span className="pfg-code">{item.agentRunId}</span></div> : null}
        {item.state === 'waking' ? <p className="pfg-quiet">Paperclip wakeup is awaiting confirmation. Inspect the agent's activity before retrying this node.</p> : null}
      </div>)}
    </div></details> : null}

    {canRetry ? <details className="pfg-disclosure"><summary>Retry a failed or interrupted node</summary><div className="pfg-disclosure-body">
      <p className="pfg-quiet">Requires an authorized human owner and a reason. Check any woken Paperclip host run first.</p>
      <form onSubmit={retry}><div className="pfg-form-grid"><div><label htmlFor="retry-node" style={label}>Node</label>
        <select id="retry-node" style={field} value={retryNodeId} onChange={(event) => setRetryNodeId(event.target.value)} required><option value="">Choose node</option>
          {retryOptions.map((node) => <option key={node.id} value={node.id}>{title(node.id)} ({node.id}) · {statusText(run.nodeStates[node.id]?.status)}</option>)}
        </select></div><div><label htmlFor="retry-reason" style={label}>Reason</label><input id="retry-reason" style={field} value={retryReason} onChange={(event) => setRetryReason(event.target.value)} required /></div></div>
        <button className="pfg-button" type="submit" style={{ marginTop: 12 }} disabled={busy || !retryNodeId || !retryReason}>{busy ? 'Requesting…' : 'Retry node'}</button>
        <Message kind={retryFeedback?.kind}>{retryFeedback?.message}</Message>
      </form>
    </div></details> : null}

    {run.input?.projectId && run.input.paperclipCompanyId && data.viewer?.kind === 'human' &&
      data.viewer.roles?.includes('human-owner') ? <RunLesson run={run} companyId={run.input.paperclipCompanyId} /> : null}
    <DecisionHistory decisions={data.decisions} />
    <details className="pfg-disclosure"><summary>Technical details</summary><div className="pfg-disclosure-body pfg-quiet">
      <div>Run ID: <span className="pfg-code">{run.id}</span></div>
      <div>Pack: <span className="pfg-code">{run.packId}@{run.packVersion}</span></div>
      <div>Root issue: <span className="pfg-code">{run.input.paperclipIssueId}</span></div>
      <div>Updated: {dateText(run.updatedAt)}</div>
    </div></details>
  </article>;
}

function GraphSurface({ companyId, issueId = undefined, title: pageTitle, initialRunId = '', standalone }) {
  const retryAttempt = useRef(null);
  const [selected, setSelected] = useState(initialRunId);
  const [creating, setCreating] = useState(false);
  const [graphId, setGraphId] = useState('');
  const [packKey, setPackKey] = useState('');
  const [mode, setMode] = useState('');
  const [inputText, setInputText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scopedNotice, setScopedNotice] = useState(null);
  const [staleReview, setStaleReview] = useState(null);
  const { data, loading, error: loadError, refresh } = useGraph(companyId, issueId);
  const action = usePluginAction('graph-command');
  const navigation = useHostNavigation();
  const listedRuns = [...(data?.runs ?? [])].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const activeId = selected || listedRuns[0]?.id;
  const notice = scopedNotice && scopedNotice.runId === activeId ? scopedNotice.text : '';
  const setNotice = (text, runId = activeId) => setScopedNotice({ runId, text });
  const detail = useGraph(activeId ? companyId : null, issueId, activeId);
  const receiptNotice = dispatchReceiptNotice(detail.data?.dispatches?.map(({ nodeId, receiptStatus }) => ({ nodeId, status: receiptStatus })));
  // A child task can point to a parent run outside its ordinary task list.
  const linkedRun = selected && detail.data?.runs?.find(run => run.id === selected);
  const runs = linkedRun && !listedRuns.some(run => run.id === selected) ? [linkedRun, ...listedRuns] : listedRuns;
  const availablePacks = selectableRunPacks(data ?? undefined);
  const selectedPack = packKey ? availablePacks.find(pack => `${pack.id}@${pack.version}` === packKey) : availablePacks[0];
  const selectedPackKey = selectedPack ? `${selectedPack.id}@${selectedPack.version}` : '';
  const selectedGraph = selectedPack?.graphs.find(graph => graph.id === graphId);
  const selectedGraphIssue = graphHostIssue(selectedPack, graphId);
  const canStart = Boolean(selectedGraph && !selectedGraphIssue && !busy);

  async function start(event) {
    event.preventDefault();
    if (!canStart) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const input = JSON.parse(inputText);
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Run input must be a JSON object');
      const response = await action({ issueId, operation: 'start', packId: selectedPack.id, packVersion: selectedPack.version, graphId, ...(mode ? { mode } : {}), input,
        idempotencyKey: crypto.randomUUID() });
      setSelected(response.run.id); setCreating(false); setNotice('Graph run started.', response.run.id); refresh(); detail.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return <section className="pfg" aria-label={pageTitle}><style>{styles}</style>
    {standalone && <WorkspaceNav active="runs" />}
    <header className="pfg-header"><div><h1>{pageTitle}</h1><p className="pfg-subtitle">{issueId ? 'Runs for this task' : 'Runs across all company tasks'}{issueId && standalone && <> · <a {...navigation.linkProps('/graph-runs')}>View all runs</a></>}</p></div>
      <div className="pfg-header-actions">{issueId && data ? <button className="pfg-button pfg-button-primary" type="button" onClick={() => setCreating(!creating)} aria-expanded={creating}>
        {icon('plus')}{creating ? 'Close new run' : 'New run'}</button> : null}
        <button className="pfg-button" type="button" disabled={loading} onClick={() => { setNotice(''); refresh(); detail.refresh(); }}>{icon('refresh')}{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div></header>
    <Message>{[notice, !notice.includes(receiptNotice) && receiptNotice].filter(Boolean).join(' ')}</Message>
    {creating && issueId && data ? <section className="pfg-new-run" aria-label="Start a Graph run"><h2>Start a Graph on this issue</h2>
      {availablePacks.length ? <>
        <p className="pfg-subtitle" style={{ marginBottom: 16 }}>Select a Graph and provide its versioned input.</p>
        <form onSubmit={start}>
          <label htmlFor="graph-pack" style={label}>Pack</label>
          <select id="graph-pack" style={{ ...field, marginBottom: 12 }} value={selectedPackKey}
            onChange={event => { setPackKey(event.target.value); setGraphId(''); }} required>
            {!selectedPack && <option value="" disabled>Choose an enabled Pack version</option>}
            {availablePacks.map(pack => <option key={`${pack.id}@${pack.version}`} value={`${pack.id}@${pack.version}`}>{title(pack.id)} · v{pack.version}</option>)}
          </select>
          <div className="pfg-form-grid">
            <div><label htmlFor="graph-type" style={label}>Graph</label>
              <select id="graph-type" style={field} value={selectedGraph?.id ?? ''} disabled={!selectedPack}
                onChange={event => { setPackKey(selectedPackKey); setGraphId(event.target.value); }} required>
                <option value="">Choose Graph</option>
                {selectedPack?.graphs.map(graph => <option key={graph.id} value={graph.id} disabled={Boolean(graphHostIssue(selectedPack, graph.id))}>{title(graph.id)} · v{graph.version}{graphHostIssue(selectedPack, graph.id) ? ' — host unavailable' : ''}</option>)}
              </select>
            </div>
            <div><label htmlFor="graph-mode" style={label}>Decision mode</label>
              <select id="graph-mode" style={field} value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="">Company default ({data.config?.defaultMode ?? 'manual'})</option><option value="manual">Manual</option><option value="assisted">Assisted</option><option value="autonomous">Autonomous</option>
              </select>
            </div>
          </div>
          {selectedPack?.hostSupport?.unsupportedGraphs?.length ? <div role="status" style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
            <p className="pfg-quiet">Some Graphs need additional trusted host services:</p>
            <details open={selectedPack.hostSupport.unsupportedGraphs.length <= 3}><summary className="pfg-quiet">Missing services for {selectedPack.hostSupport.unsupportedGraphs.length} Graphs</summary>
              <ul className="pfg-quiet">{selectedPack.hostSupport.unsupportedGraphs.map(item => <li key={item.id}><strong>{title(item.id)}</strong>: {item.reason}</li>)}</ul>
            </details>
          </div> : selectedGraphIssue ? <Message kind="error">{selectedGraphIssue}</Message> : null}
          <label htmlFor="graph-input" style={{ ...label, marginTop: 12 }}>Versioned run input (JSON)</label>
          <textarea id="graph-input" style={{ ...field, ...mono, minHeight: 96 }} value={inputText} onChange={(event) => setInputText(event.target.value)} spellCheck={false} />
          <p className="pfg-quiet" style={{ marginTop: 8 }}>{graphInputHelp[selectedGraph?.id] ?? 'Provide the versioned inputs required by the selected Graph. See the pack workflow and evidence contract for the input fields.'}</p>
          <button className="pfg-button pfg-button-primary" type="submit" disabled={!canStart}>{busy ? 'Starting…' : 'Start Graph'}</button>
          <Message kind="error">{error}</Message>
        </form>
      </> : <p role="status" className="pfg-quiet">Enable an installed Pack version in{' '}
        <a {...navigation.linkProps('/company-operations?view=packs')}>Company operations → Packs</a> to start a Graph.</p>}
    </section> : null}
    {loading ? <LoadingRows /> : loadError ? <section className="pfg-empty pfg-run-list">
      <h2>Couldn’t load runs</h2><Message kind="error">{String(loadError)}</Message>
      <button className="pfg-button" type="button" onClick={refresh}>Try again</button>
    </section> : !runs.length && !activeId ?
      <section className="pfg-empty pfg-run-list"><h2>No runs yet</h2>
        {issueId ? <p>Use New run to start a Graph on this task.</p> :
          <p>Choose a task, then open its Graph section to start a run.</p>}
        {!issueId && <a className="pfg-button" {...navigation.linkProps('/issues')}>Open tasks</a>}
      </section> :
    <div className="pfg-workspace"><aside className="pfg-run-list" aria-label="Graph runs"><div className="pfg-list-head"><h2>Runs</h2><span className="pfg-quiet">{runs.length}</span></div>
      {runs.length ? <div className="pfg-list-scroll">
        {runs.map((run) => <button className="pfg-run-item" type="button" key={run.id} onClick={() => { setNotice(''); setSelected(run.id); }} aria-current={activeId === run.id}>
          <span className="pfg-run-title"><span>{title(run.graphId)}</span><span aria-hidden="true">{icon('chevron')}</span></span>
          <span className="pfg-run-meta"><Status value={run.status} /><span>{dateText(run.startedAt)}</span></span>
          <span className="pfg-run-meta"><span>{title(run.mode)} mode</span><span>v{run.graphVersion}</span></span>
        </button>)}
      </div> : <div className="pfg-empty"><strong>No runs yet</strong>Open a Paperclip issue and start a Graph to see work here.</div>}
    </aside>
    {detail.loading ? <div className="pfg-detail"><LoadingRows /></div> : detail.error || (activeId && !detail.data?.run) ? <div className="pfg-detail">
      <h2>Run unavailable</h2>
      <Message kind="error">{detail.error || 'This run could not be found in the current scope.'}</Message>
      <div className="pfg-header-actions"><button className="pfg-button" type="button" onClick={detail.refresh}>Retry run details</button>
        {standalone && <a className="pfg-button" {...navigation.linkProps('/graph-runs')}>All company runs</a>}</div>
    </div>
      : <RunDetails key={activeId} data={detail.data} issueId={issueId || detail.data?.run?.input?.paperclipIssueId}
        retryAttempt={retryAttempt} onNotice={setNotice} staleReview={staleReview} onStaleReview={setStaleReview} refresh={() => { refresh(); detail.refresh(); }} />}
    </div>}
    <DecisionHistory decisions={data?.companyDecisions} heading="Company decision history" scope="company" />
  </section>;
}

export function GraphRunsPage({ context }) {
  const hostContext = useHostContext();
  const location = useHostLocation();
  const companyId = context?.companyId ?? hostContext.companyId;
  const issueId = new URLSearchParams(location.search).get('issueId') || undefined;
  const runId = new URLSearchParams(location.search).get('runId') || '';
  return companyId ? <GraphSurface key={JSON.stringify([companyId, issueId, runId])} standalone companyId={companyId} issueId={issueId} initialRunId={runId} title="Graph runs" /> : <p style={frame}>Select a company to view Graph runs.</p>;
}

export function GraphSidebarLink({ context }) {
  const navigation = useHostNavigation();
  if (!context?.companyId) return null;
  return <a {...navigation.linkProps('/graph-runs')} style={{ display: 'block', padding: '7px 12px', borderRadius: 8,
    color: colors.text, textDecoration: 'none', fontWeight: 600 }}>Graph runs</a>;
}

export function IssueGraphPanel({ context }) {
  const navigation = useHostNavigation();
  const hostContext = useHostContext();
  const location = useHostLocation();
  const { data, loading, error } = useGraph(context?.companyId, context?.entityId);
  if (!context?.companyId || !context?.entityId) return null;
  const companyPrefix = context.companyPrefix ?? hostContext.companyPrefix ?? location.pathname.split('/')[1];
  const href = `/${encodeURIComponent(companyPrefix)}/graph-runs?issueId=${encodeURIComponent(context.entityId)}`;
  const runs = data?.runs ?? [];
  return <section style={{ ...panel, marginTop: 8, padding: '12px 14px' }} aria-label="Issue Graph overview">
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', justifyContent: 'space-between' }}>
      <strong style={{ fontSize: 14 }}>Graph</strong><a {...navigation.linkProps(href)} style={{ fontSize: 13, color: colors.accent }}>Open Graph</a>
    </div>
    {loading ? <span style={small}>Loading runs…</span> : error ? <span style={small}>Graph unavailable. Open Graph for details.</span> :
      runs.length ? <span style={small}>{runs.length} run{runs.length === 1 ? '' : 's'} · latest {runs[0].graphId} {runs[0].status.replaceAll('_', ' ')}</span> :
        <span style={small}>No Graph run on this issue yet.</span>}
  </section>;
}

export function IssueGraphTab({ context }) {
  return context?.companyId && context?.entityId
    ? <GraphSurface key={`${context.companyId}:${context.entityId}`} companyId={context.companyId} issueId={context.entityId} title="Issue Graph" />
    : <p style={frame}>Open a Paperclip issue to view its Graph.</p>;
}

export { GraphSettingsPage, PluginSettingsEntry } from './ui-settings.jsx';
