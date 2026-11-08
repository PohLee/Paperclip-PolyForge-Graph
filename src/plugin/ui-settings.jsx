import React, { useEffect, useState } from 'react';
import { useHostContext, useHostNavigation, usePluginAction } from '@paperclipai/plugin-sdk/ui';
import { companyCss } from './ui-styles.mjs';
import { AgentDocuments, nativeRequest } from './ui-documents.jsx';

const sections = [['execution','Execution & limits'],['roles','Roles & people'],['documents','Agent documents'],['updates','Packs & updates']];
const groups = [
  ['Time & progress', [['sliceMs','Delivery time budget','minutes',60000],['idleMs','Stop after no progress','minutes',60000],['noProgressRuns','Runs without progress','runs'],['runResets','Resets per run','resets']]],
  ['Concurrency & resources', [['parallelAgents','Parallel Graph agents','agents'],['concurrentRuns','Concurrent Graph runs','runs'],['testDatabases','Retained test databases','databases'],['sourceSnapshots','Retained source snapshots','snapshots']]],
  ['Review & recovery', [['fixRounds','Fix and reverify rounds','rounds'],['fullRegressions','Full regression checks','checks'],['implementationCorrections','Corrections per implementation agent','corrections']]],
];
const modeHelp = { manual: 'Human approval controls execution. Required Pack gates always apply.', assisted: 'Agents advance eligible work and hand decisions to authorized people.', autonomous: 'Agents advance eligible work automatically. Mandatory human gates still apply.' };

export function GraphSettingsPage({ context }) {
  const host = useHostContext(), navigation = useHostNavigation();
  const companyId = context?.companyId ?? host.companyId;
  return <main className="pfg-company pfg-settings"><style>{companyCss}</style><header className="pfg-company-head"><div><h1>PolyForge Graph settings</h1><p className="pfg-company-muted">Configure how this company runs, who owns each role and which Packs it uses.</p></div><a {...navigation.linkProps('/company-operations')}>Company operations</a></header>
    {companyId ? <SettingsWorkspace key={companyId} companyId={companyId} /> : <p>Select a company to configure Graph.</p>}
  </main>;
}

export function SettingsWorkspace({ companyId, onDirty, initialSection = 'execution' }) {
  const action = usePluginAction('graph-company-command');
  const [data,setData] = useState(null), [draft,setDraft] = useState(null), [section,setSection] = useState(initialSection);
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [revision,setRevision] = useState(0), [documentDirty,setDocumentDirty] = useState(false), [reason,setReason] = useState('');
  const [filter,setFilter] = useState('');
  const dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(data?.config));
  useEffect(() => { onDirty?.(dirty || documentDirty); return () => onDirty?.(false); }, [dirty, documentDirty, onDirty]);
  useEffect(() => {
    const handler = event => { if (dirty || documentDirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty, documentDirty]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    nativeRequest(`/api/plugins/pohlee.polyforge-graph/api/settings?companyId=${encodeURIComponent(companyId)}`, { signal: controller.signal })
      .then(result => { setData(result); setDraft(structuredClone(result.config)); })
      .catch(err => { if (err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [companyId, revision]);
  async function command(operation, fields = {}) {
    setBusy(true); setError(''); setNotice('');
    try { return await action({ companyId, operation, ...fields, reason: fields.reason || 'Company administrator updated Graph configuration', idempotencyKey: crypto.randomUUID() }); }
    catch (err) { setError(err.message); throw err; } finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault();
    try {
      const changes = [];
      if (draft.defaultMode !== data.config.defaultMode) changes.push(`Decision mode: ${data.config.defaultMode} → ${draft.defaultMode}`);
      for (const [key,label,unit,scale = 1] of groups.flatMap(([,fields]) => fields)) {
        if (draft.deliveryLimits[key] !== data.config.deliveryLimits[key]) changes.push(`${label}: ${data.config.deliveryLimits[key]/scale} → ${draft.deliveryLimits[key]/scale} ${unit}`);
      }
      for (const [key,label] of [['roleBindings','Agent assignments'],['userRoles','Human permissions']]) {
        const changed = [...new Set([...Object.keys(data.config[key]),...Object.keys(draft[key])])]
          .filter(id => JSON.stringify(data.config[key][id]) !== JSON.stringify(draft[key][id]));
        if (changed.length) changes.push(`${label}: ${changed.length} mapping(s) updated`);
      }
      const result = await command('configure-settings', { ...draft, expectedRevision: data.config.revision ?? 0,
        reason: reason.trim() || changes.join('; ') || 'Company settings reviewed; no values changed' });
      setData(current => ({ ...current, config: result.config })); setDraft(structuredClone(result.config)); setReason(''); setNotice('Company settings saved. Existing runs keep their pinned settings.');
    } catch {}
  }
  const reload = () => { if ((!dirty && !documentDirty) || window.confirm('Discard unsaved changes and reload settings?')) setRevision(v => v + 1); };
  if (!data) return <section className="pfg-company-section">{error ? <><p role="alert">{error}</p><button onClick={reload}>Retry loading settings</button></> : <p role="status">Loading company settings…</p>}</section>;
  const patch = fields => setDraft(current => ({ ...current, ...fields }));
  const roles = data.roles.filter(role => `${role.name} ${role.id}`.toLowerCase().includes(filter.toLowerCase()));
  function bind(role, id) {
    const bindings = { ...draft.roleBindings };
    if (role.packId === 'adlc') delete bindings[role.localId];
    if (id) bindings[role.id] = id; else delete bindings[role.id];
    patch({ roleBindings: bindings });
  }
  function suggest() {
    const additions = Object.fromEntries(Object.entries(data.suggestions).filter(([role]) => !draft.roleBindings[role]));
    patch({ roleBindings: { ...draft.roleBindings, ...additions } });
    setNotice(`${Object.keys(additions).length} managed role mappings filled. Review them, then save. Human access is assigned explicitly.`);
  }
  return <>
    <nav className="pfg-company-nav" aria-label="Graph settings">{sections.map(([id,label]) => <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => { if (!documentDirty || window.confirm('Discard unsaved document changes?')) setSection(id); }}>{label}</button>)}</nav>
    <div className="pfg-company-inline pfg-settings-status"><span>{data.canEdit ? 'Company administrator' : 'Read-only access'}</span>{dirty && <strong>Unsaved settings</strong>}<button type="button" onClick={reload} disabled={busy || loading}>Reload settings</button></div>
    {error && <p className="pfg-company-notice" role="alert">{error}</p>}{notice && <p className="pfg-company-notice" role="status">{notice}</p>}
    {['execution','roles'].includes(section) && <form onSubmit={save}><fieldset className="pfg-settings-fields" disabled={!data.canEdit || loading || busy}>
      {section === 'execution' ? <>
        <section className="pfg-settings-section"><div><h2>Default execution</h2><p className="pfg-company-muted">Used by new Graph runs. Each run keeps its chosen mode.</p></div><div><label className="pfg-company-field">Decision mode<select value={draft.defaultMode} onChange={e => patch({ defaultMode: e.target.value })}>{Object.keys(modeHelp).map(mode => <option key={mode} value={mode}>{mode[0].toUpperCase()+mode.slice(1)}</option>)}</select></label><p className="pfg-company-muted">{modeHelp[draft.defaultMode]}</p></div></section>
        <section className="pfg-settings-section"><div><h2>Delivery limits</h2><p className="pfg-company-muted">The first run pins these limits for a delivery. Core validates the allowed ranges.</p><button type="button" onClick={() => patch({ deliveryLimits: { ...data.deliveryDefaults } })}>Restore default limits</button></div><div>{groups.map(([title,fields]) => <fieldset className="pfg-limit-group" key={title}><legend>{title}</legend><div className="pfg-company-fieldrow">{fields.map(([key,label,unit,scale = 1]) => <label className="pfg-company-field" key={key}>{label}<div className="pfg-input-unit"><input required type="number" min={1} max={data.deliveryLimitHardMax[key]/scale} step="1" value={draft.deliveryLimits[key] === '' ? '' : draft.deliveryLimits[key]/scale} onChange={e => patch({ deliveryLimits: { ...draft.deliveryLimits, [key]: e.target.value === '' ? '' : Number(e.target.value)*scale } })}/><span>{unit}</span></div><small>Default {data.deliveryDefaults[key]/scale} · Maximum {data.deliveryLimitHardMax[key]/scale}</small></label>)}</div></fieldset>)}</div></section>
      </> : <>
        <section className="pfg-company-section"><div className="pfg-company-head"><div><h2>Agent roles</h2><p className="pfg-company-muted">Assign each Pack role to an existing Paperclip agent. Verified managed identities can be filled automatically.</p></div><button type="button" disabled={!Object.keys(data.suggestions).length} onClick={suggest}>Fill managed mappings</button></div>
          <label className="pfg-company-field pfg-company-search">Find a role<input type="search" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Role or Pack name"/></label>
          <div className="pfg-role-list">{roles.map(role => { const value = draft.roleBindings[role.id] ?? (role.packId === 'adlc' ? draft.roleBindings[role.localId] : '') ?? ''; return <div className="pfg-role-row" key={role.id}><div><strong>{role.name}</strong><small>{role.packId ?? 'Company'} · {role.id}</small></div><label className="pfg-company-field"><span className="pfg-sr-only">Agent for {role.name} ({role.id})</span><select value={value} onChange={e => bind(role,e.target.value)}><option value="">Unassigned</option>{value && !data.agents.some(a => a.id === value) && <option value={value}>Unavailable agent · {value}</option>}{data.agents.filter(agent => !role.historical || agent.id === value).map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.status}</option>)}</select></label></div>; })}</div>{!roles.length && <p>No roles match this search.</p>}
        </section>
        <section className="pfg-company-section"><h2>Human permissions</h2><p className="pfg-company-muted">Company owners and admins already have human-owner authority. Assign additional Pack roles only to people who should act in that role.</p>
          {data.unavailableMembers.filter(member => Object.hasOwn(draft.userRoles, member.id)).map(member => <div className="pfg-human-row" key={member.id}>
            <p>{member.name} · {member.status}. Remove this former member’s permissions before saving.</p>
            <button type="button" onClick={() => { const next = { ...draft.userRoles }; delete next[member.id]; patch({ userRoles: next }); }}>Remove permissions for {member.name}</button>
          </div>)}
          {data.members.map(member => { const selected = draft.userRoles[member.id] ?? []; return <details className="pfg-human-row" key={member.id}><summary><strong>{member.id === data.viewerId ? 'You' : member.name}</strong> · {member.membershipRole} · {selected.length} assigned roles</summary><small>{member.id}</small><div className="pfg-human-roles">{[{id:'human-owner',name:'Human owner'},...data.roles.filter(r => r.id !== 'ceo' && (!r.historical || selected.includes(r.id)))].map(role => <label key={role.id}><input type="checkbox" checked={selected.includes(role.id) || (role.packId === 'adlc' && selected.includes(role.localId))} onChange={e => { const current = selected.filter(id => id !== role.id && !(role.packId === 'adlc' && id === role.localId)); const next = { ...draft.userRoles, [member.id]: e.target.checked ? [...current,role.id] : current }; if (!next[member.id].length) delete next[member.id]; patch({ userRoles: next }); }}/><span>{role.name}<small>{role.packId ?? 'Company'}</small></span></label>)}</div></details>; })}
        </section>
      </>}
      <div className="pfg-settings-footer"><label className="pfg-company-field">Note (optional)<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Add context if helpful"/><small>A summary of your changes is recorded automatically.</small></label><div className="pfg-company-inline"><button className="pfg-primary" disabled={!dirty}>{busy ? 'Saving…' : 'Save company settings'}</button><button type="button" disabled={!dirty} onClick={() => { setDraft(structuredClone(data.config)); setReason(''); }}>Discard changes</button></div></div>
    </fieldset></form>}
    {section === 'documents' && <AgentDocuments key={`${companyId}:${revision}`} agents={data.agents} canEdit={data.canEdit} onDirty={setDocumentDirty}/>}
    {section === 'updates' && dirty && <p role="status" className="pfg-company-notice">Save or discard your settings changes before updating Packs or Core.</p>}
    {section === 'updates' && !dirty && <PackUpdates data={data} command={command} busy={busy} refresh={() => setRevision(v => v + 1)} />}
  </>;
}

function PackUpdates({ data, command, busy, refresh }) {
  const navigation = useHostNavigation();
  const [source,setSource] = useState({ repository:'', ref:'main', path:'pack.json' }), [preview,setPreview] = useState(null);
  const [version,setVersion] = useState(''), [upgradeBusy,setUpgradeBusy] = useState(false), [message,setMessage] = useState(''), [error,setError] = useState('');
  const [acknowledged,setAcknowledged] = useState(false), [preflight,setPreflight] = useState(null);
  async function checkRuntime(event) {
    const file = event.target.files?.[0]; if (!file) return;
    setError(''); setPreflight(null); setAcknowledged(false);
    try { if (file.size > 256 * 1024) throw new Error('Runtime metadata is too large');
      const artifact = JSON.parse(await file.text());
      const result = await command('preflight-runtime', { runtime: artifact.runtime ?? artifact });
      setPreflight(result);
    } catch (err) { setError(err.message); }
  }
  const editSource = fields => { setSource(current => ({...current,...fields})); setPreview(null); };
  async function inspect(event) { event.preventDefault(); try { setPreview(await command('preview-github-pack',{source})); } catch {} }
  async function install() { try { await command('import-github-pack',{source:preview.source,digest:preview.digest}); setPreview(null); setMessage('Pack imported. Enable its version in Company operations, then map agents to its roles.'); refresh(); } catch {} }
  async function upgrade(event) {
    event.preventDefault(); setUpgradeBusy(true); setError(''); setMessage('');
    try { const result = await nativeRequest('/api/plugins/pohlee.polyforge-graph/upgrade',{method:'POST',body:JSON.stringify(version.trim()?{version:version.trim()}:{})}); setMessage(`Paperclip upgrade requested. Version ${result.version ?? 'reported by host'} · ${result.status ?? 'check plugin status'}. Reload this page when the worker is ready.`); }
    catch (err) { setError(err.message); } finally { setUpgradeBusy(false); }
  }
  return <>
    {message && <p role="status" className="pfg-company-notice">{message}</p>}{error && <p role="alert" className="pfg-company-notice">{error}</p>}
    <section className="pfg-settings-section"><div><h2>Installed Packs</h2><p className="pfg-company-muted">Refresh deployed releases, then choose the version each company uses. Existing runs retain their pinned Pack.</p></div><div><ul className="pfg-company-list">{data.catalog.map(pack => <li key={`${pack.id}@${pack.version}`}><strong>{pack.name ?? pack.id}</strong> · {pack.version}</li>)}</ul><div className="pfg-company-inline"><button disabled={busy || !data.canEdit} onClick={async () => { try { await command('reload-catalog'); refresh(); } catch {} }}>Refresh deployed Packs</button><a {...navigation.linkProps('/company-operations?view=packs')}>Choose active versions</a></div></div></section>
    <section className="pfg-settings-section"><div><h2>Load from GitHub</h2><p className="pfg-company-muted">Import a public repository’s exported Pack JSON. Preview resolves a commit and validates the Graph contract before import. Imported releases become available to the instance; activation is company-specific.</p><p className="pfg-company-muted">JavaScript Packs can be exported with scripts/export-pack.mjs. New roles can be mapped to existing agents; automatic provisioning requires their declarations in the installed plugin manifest.</p></div><form onSubmit={inspect} className="pfg-company-form"><fieldset className="pfg-settings-fields" disabled={busy || !data.canEdit}><label>GitHub repository<input required value={source.repository} onChange={e => editSource({repository:e.target.value})} placeholder="owner/repository"/></label><div className="pfg-company-fieldrow"><label>Branch, tag or commit<input required value={source.ref} onChange={e => editSource({ref:e.target.value})}/></label><label>Pack JSON path<input required value={source.path} onChange={e => editSource({path:e.target.value})}/></label></div><button>Preview Pack</button></fieldset>
      {preview && <div className="pfg-pack-preview"><h3>{preview.packId} · {preview.version}</h3><p>{preview.roles.length} roles · {preview.graphs.length} workflows · Core {preview.coreRange}</p><p className="pfg-company-muted">Commit {preview.source.ref.slice(0,12)}</p><button type="button" className="pfg-primary" disabled={busy || !data.canEdit} onClick={install}>Import this release</button></div>}
    </form></section>
    {data.sources.length > 0 && <section className="pfg-company-section"><h3>Imported sources</h3><ul className="pfg-company-list">{data.sources.map(item => <li key={`${item.packId}@${item.version}`}><strong>{item.packId} · {item.version}</strong><p>{item.source.repository} / {item.source.path}</p><button type="button" disabled={busy} onClick={() => { setSource({...item.source,ref:'main'}); setPreview(null); }}>Check another ref</button></li>)}</ul></section>}
    <section className="pfg-settings-section"><div><h2>Graph Core</h2><p>Running version <strong>{data.runtime.version}</strong></p><p className="pfg-company-muted">Paperclip’s instance administrator manages Core upgrades. For a local-path installation, deploy and build the new source on the host first. This action reloads the installed package; it does not pull GitHub source.</p></div><form className="pfg-company-form" onSubmit={upgrade}><label>Check candidate compatibility (runtime-artifact.json)<input type="file" accept=".json,application/json" onChange={checkRuntime} disabled={busy || upgradeBusy || !data.canEdit}/></label>{preflight && <div role="status"><strong>{preflight.ok ? 'Compatible with this company' : 'Compatibility issues'}</strong><ul>{preflight.issues.map(issue => <li key={issue}>{issue}</li>)}</ul><p className="pfg-company-muted">Checks supplied metadata against this company and unfinished runs. It does not verify installed package bytes or other companies.</p></div>}<label>Target package version (registry installations)<input value={version} onChange={e => setVersion(e.target.value)} placeholder="Leave empty to use the installed source"/></label><label className="pfg-checkbox"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/><span>I have checked Pack compatibility. This update affects the whole Paperclip instance.</span></label><button disabled={upgradeBusy || busy || !acknowledged || !data.canEdit || preflight?.ok === false}>{upgradeBusy?'Requesting upgrade…':'Request Core upgrade'}</button></form></section>
  </>;
}
