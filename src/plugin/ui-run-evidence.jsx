import React from 'react';
import { runEvidenceReports } from './ui-run-evidence.mjs';

const label = value => String(value).replace(/([a-z\d])([A-Z])/g, '$1 $2')
  .replaceAll('_', ' ').replaceAll('-', ' ').replace(/^./, first => first.toUpperCase());
const identity = artifact => `${artifact.id}@${artifact.version}`;

function RecordedValue({ value }) {
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) =>
    <li key={index}><RecordedValue value={item} /></li>)}</ul> : <span>None recorded</span>;
  if (value !== null && typeof value === 'object') {
    return Object.keys(value).length ? <dl>{Object.entries(value).map(([key, item]) => <div key={key}>
      <dt>{label(key)}</dt><dd><RecordedValue value={item} /></dd>
    </div>)}</dl> : <span>None recorded</span>;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value == null || value === '' ? 'None recorded' : <span className="pfg-evidence-text">{String(value)}</span>;
}

function ArtifactBody({ body, omitCitations = false }) {
  if (!body) return <p className="pfg-quiet">The original artifact body is unavailable in this run.</p>;
  const fields = Object.fromEntries(Object.entries(body)
    .filter(([key]) => !['id', 'version'].includes(key) && !(omitCitations && key === 'researchRefs')));
  return <RecordedValue value={fields} />;
}

function openSource(event, targetId) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const target = event.currentTarget.ownerDocument.getElementById(targetId);
  if (!target) return;
  target.open = true;
}

function EvidenceReport({ report, runId }) {
  const reportId = `pfg-evidence-${encodeURIComponent(runId)}-${encodeURIComponent(report.node.id)}`;
  const targetIdFor = source => `${reportId}-${encodeURIComponent(source.node.id)}-${source.attemptNumber}`;
  const sources = new Map(report.citations.filter(({ source }) => source)
    .map(({ source }) => [targetIdFor(source), source]));
  return <section className="pfg-section pfg-run-evidence" aria-labelledby={reportId}>
    <h3 id={reportId}>{label(report.artifact.kind)}</h3>
    <p className="pfg-quiet">{label(report.node.id)} · Attempt {report.attemptNumber} ·
      {' '}<code className="pfg-code">{identity(report.artifact)}</code>
      {report.review?.outcome === 'accept' && ' · Accepted by supervisor'}
      {report.review?.outcome === 'rework' && ' · Rework requested'}</p>
    {report.citations.length ? <div>
      <h4>Cited research</h4>
      <ul>{report.citations.map(({ ref, source }, index) => {
        const targetId = source && targetIdFor(source);
        return <li key={index}>
          {targetId ? <a href={`#${targetId}`} onClick={event => openSource(event, targetId)}>{label(ref.kind)}</a>
            : <>{label(ref.kind)} · <span className="pfg-quiet">Accepted source unavailable</span></>}
          {' '}<code className="pfg-code">{identity(ref)}</code>
        </li>;
      })}</ul>
    </div> : <p className="pfg-quiet">No research versions cited.</p>}
    <details className="pfg-disclosure">
      <summary>Read {label(report.artifact.kind).toLowerCase()}</summary>
      <div className="pfg-disclosure-body"><ArtifactBody body={report.body} omitCitations /></div>
    </details>
    {[...sources].map(([targetId, source]) => <details className="pfg-disclosure" key={targetId} id={targetId} tabIndex={-1}>
      <summary>{label(source.node.id)} · Accepted attempt {source.attemptNumber}</summary>
      <div className="pfg-disclosure-body">
        {source.review.decisionId && <p className="pfg-quiet">Supervisor decision <code className="pfg-code">{source.review.decisionId}</code></p>}
        {source.artifacts.map(({ artifact, body }) => <section key={identity(artifact)}>
          <h4>{label(artifact.kind)}</h4>
          <p className="pfg-quiet"><code className="pfg-code">{identity(artifact)}</code></p>
          <ArtifactBody body={body} />
        </section>)}
      </div>
    </details>)}
    {report.related.length > 0 && <details className="pfg-disclosure">
      <summary>Other synthesis artifacts</summary>
      <div className="pfg-disclosure-body">{report.related.map(({ artifact, body }) => <section key={identity(artifact)}>
        <h4>{label(artifact.kind)}</h4>
        <p className="pfg-quiet"><code className="pfg-code">{identity(artifact)}</code></p>
        <ArtifactBody body={body} />
      </section>)}</div>
    </details>}
  </section>;
}

export function RunEvidence({ run }) {
  return runEvidenceReports(run).map(report => <EvidenceReport key={report.node.id} report={report} runId={run.id} />);
}
