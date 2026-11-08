import React, { useEffect, useState } from 'react';

export async function nativeRequest(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Paperclip request failed (${response.status})`);
  return body;
}
const preferredFiles = ['AGENTS.md', 'instruction.md', 'role.md', 'soul.md', 'goal.md', 'decision_model.md'];

export function AgentDocuments({ agents, canEdit, onDirty }) {
  const [agentId, setAgentId] = useState(''), [bundle, setBundle] = useState(null), [path, setPath] = useState('');
  const [file, setFile] = useState(null), [content, setContent] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [revision, setRevision] = useState(0);
  const dirty = file !== null && content !== file.content;
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty, onDirty]);
  useEffect(() => {
    setBundle(null); setFile(null); setContent(''); setPath(''); setError(''); setNotice('');
    if (!agentId) { setBusy(false); return; }
    const controller = new AbortController(); setBusy(true);
    nativeRequest(`/api/agents/${encodeURIComponent(agentId)}/instructions-bundle`, { signal: controller.signal })
      .then(result => { setBundle(result); setPath(result.entryFile || result.files[0]?.path || ''); })
      .catch(err => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [agentId]);
  useEffect(() => {
    if (!agentId || !path) return;
    const controller = new AbortController(); setFile(null); setContent(''); setBusy(true); setError('');
    nativeRequest(`/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(result => { setFile(result); setContent(result.content); })
      .catch(err => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [agentId, path, revision]);
  const leave = () => !dirty || window.confirm('Discard unsaved document changes?');
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const saved = await nativeRequest(`/api/agents/${encodeURIComponent(agentId)}/instructions-bundle/file`, {
        method: 'PUT', body: JSON.stringify({ path, content, baseHash: file.contentHash ?? null,
          ...(file.revisionId !== undefined ? { baseRevisionId: file.revisionId } : {}) }) });
      setFile(saved); setContent(saved.content); setNotice(`${path} saved to Paperclip.`);
    } catch (err) { setError(`${err.message}. Your draft is still here. Copy it before reloading the saved file.`); }
    finally { setBusy(false); }
  }
  return <section><h2>Agent documents</h2><p className="pfg-company-muted">Read and edit the files stored in an agent’s Paperclip instruction bundle. Pack templates and pinned run goals keep their original versions.</p>
    <label className="pfg-company-field">Agent<select value={agentId} disabled={busy} onChange={e => { if (leave()) setAgentId(e.target.value); }}><option value="">Choose an agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.status}</option>)}</select></label>
    {error && <p role="alert" className="pfg-company-notice">{error}</p>}{notice && <p role="status" className="pfg-company-notice">{notice}</p>}
    {busy && <p role="status">Loading or saving document…</p>}
    {bundle && <><p className="pfg-company-muted">{bundle.mode === 'managed' ? 'Managed by Paperclip' : 'External instruction bundle'} · Entry file: {bundle.entryFile}</p>
      {bundle.warnings?.map(warning => <p key={warning} className="pfg-company-notice">{warning}</p>)}
      <div className="pfg-document-layout"><nav className="pfg-document-files" aria-label="Agent files">{[...bundle.files].sort((a,b) => (preferredFiles.indexOf(a.path) < 0 ? 99 : preferredFiles.indexOf(a.path)) - (preferredFiles.indexOf(b.path) < 0 ? 99 : preferredFiles.indexOf(b.path))).map(item => <button type="button" key={item.path} disabled={busy} aria-current={path === item.path ? 'page' : undefined} onClick={() => { if (leave()) { setPath(item.path); setNotice(''); } }}>{item.path}</button>)}</nav>
      <form onSubmit={save}><label className="pfg-company-field">{path}<textarea className="pfg-document-editor" spellCheck={false} value={content} readOnly={!file?.editable || !canEdit || busy} onChange={e => setContent(e.target.value)} /></label>
        <div className="pfg-company-inline pfg-settings-footer"><button className="pfg-primary" disabled={busy || !canEdit || !file?.editable || !dirty}>Save document</button><button type="button" disabled={busy} onClick={() => { if (leave()) setRevision(v => v + 1); }}>Reload saved file</button><span className="pfg-company-muted">{dirty ? 'Unsaved changes' : file ? 'Saved version' : ''}</span></div>
      </form></div>
      <p className="pfg-company-muted">AGENTS.md is the entry point. Editing instruction.md does not rewrite AGENTS.md; make sure the entry file references the supporting files. Re-provisioning a Pack may restore its templates.</p>
    </>}
    {!agentId && <p className="pfg-company-empty">Choose an agent to browse its instructions, role, soul, goal and decision model.</p>}
  </section>;
}
