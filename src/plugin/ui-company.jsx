import React, { useEffect, useState } from 'react';
import { usePluginAction, useHostContext, useHostNavigation } from '@paperclipai/plugin-sdk/ui';
import { GraphDiagram } from './ui-graph.jsx';
import {useGraphData} from './ui-data.mjs';
import {ChannelSettings} from './ui-channels.jsx';
import {EvidenceSettings} from './ui-evidence.jsx';

const name = value => String(value ?? '').replaceAll(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());
const array = value => Array.isArray(value) ? value : [];
const css = `
.pfg-company{max-width:1440px;margin:auto;padding:28px clamp(16px,3vw,42px) 48px;color:var(--foreground,#1e293b);font:inherit}.pfg-company *{box-sizing:border-box}.pfg-company h1{font-size:26px;letter-spacing:-.025em;margin:0 0 6px}.pfg-company h2{font-size:19px;margin:0 0 8px}.pfg-company h3{font-size:15px;margin:0 0 8px}.pfg-company p{line-height:1.6}.pfg-company-head{display:flex;justify-content:space-between;align-items:start;gap:16px}.pfg-company-muted{color:var(--muted-foreground,#64748b);font-size:13px;margin:0 0 16px;line-height:1.6}.pfg-company button,.pfg-company input,.pfg-company select,.pfg-company textarea{font:inherit}.pfg-company button{cursor:pointer;min-height:36px;border:1px solid var(--border,#d5dce5);border-radius:8px;padding:7px 12px;background:var(--card,#fff);color:inherit;font-size:13px;font-weight:600}.pfg-company button:hover{background:var(--accent,#eff6ff)}.pfg-company button:disabled{opacity:.5;cursor:not-allowed}.pfg-company .pfg-primary{background:var(--primary,#2563eb);color:var(--primary-foreground,#fff);border-color:var(--primary,#2563eb)}.pfg-company :is(button,input,select,textarea,a,summary):focus-visible{outline:2px solid var(--ring,#2563eb);outline-offset:3px}.pfg-company-nav{display:flex;gap:4px;overflow:auto;border-bottom:1px solid var(--border,#d5dce5);margin:22px 0}.pfg-company-nav button{border:0;border-radius:6px 6px 0 0;white-space:nowrap;padding:10px 14px;margin-bottom:1px;background:transparent}.pfg-company-nav button[aria-current=page]{background:var(--accent,#eff6ff);color:var(--primary,#2563eb)}.pfg-company-section{padding:22px 0;border-bottom:1px solid var(--border,#d5dce5)}.pfg-company-section:first-child{padding-top:0}.pfg-company-section:last-child{border:0}.pfg-company-split{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(290px,1fr);gap:30px}.pfg-company-form{display:grid;gap:14px;padding:20px;background:var(--muted,#f1f5f9);border-radius:12px;align-self:start}.pfg-company-form label,.pfg-company-field{display:grid;gap:6px;font-size:12px;font-weight:600}.pfg-company input:not([type=checkbox]),.pfg-company select,.pfg-company textarea{min-height:38px;width:100%;padding:8px 10px;border:1px solid var(--border,#d5dce5);border-radius:7px;background:var(--card,#fff);color:inherit;font-size:13px}.pfg-company textarea{min-height:80px;resize:vertical}.pfg-company-inline{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pfg-company-fieldrow{display:grid;grid-template-columns:1fr 1fr;gap:12px}.pfg-company-table-wrap{overflow:auto}.pfg-company table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}.pfg-company th{font-weight:600;color:var(--muted-foreground,#64748b);font-size:11px;padding:10px 10px;border-bottom:1px solid var(--border,#d5dce5);white-space:nowrap}.pfg-company td{padding:13px 10px;border-bottom:1px solid var(--border,#d5dce5);vertical-align:top;line-height:1.5}.pfg-company tbody tr:last-child td{border:0}.pfg-company td small{display:block;color:var(--muted-foreground,#64748b);font-size:11px;margin-top:3px;overflow-wrap:anywhere}.pfg-company-status{font-size:12px;white-space:nowrap}.pfg-company-empty{padding:30px 0;color:var(--muted-foreground,#64748b);font-size:13px}.pfg-company-notice{background:var(--muted,#f1f5f9);padding:12px 14px;border-radius:8px;font-size:13px;margin:12px 0}.pfg-company-notice[role=alert]{color:var(--destructive,#b91c1c)}.pfg-company-pack{padding:20px 0;border-bottom:1px solid var(--border,#d5dce5)}.pfg-company-pack-head{display:flex;justify-content:space-between;gap:16px}.pfg-company-metrics{display:flex;flex-wrap:wrap;gap:26px;margin:18px 0}.pfg-company-metric{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--muted-foreground,#64748b)}.pfg-company-metric strong{font-size:20px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--foreground,#1e293b)}.pfg-company-list{list-style:none;padding:0;margin:0}.pfg-company-list>li{padding:14px 0;border-bottom:1px solid var(--border,#d5dce5);font-size:13px;line-height:1.6}.pfg-company-list>li:last-child{border:0}.pfg-company-list details{margin-top:8px}.pfg-company-list summary{cursor:pointer;font-size:12px;font-weight:600}.pfg-company pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.6;max-height:280px;overflow:auto;background:var(--muted,#f1f5f9);padding:12px;border-radius:8px}.pfg-company a{color:var(--primary,#2563eb);text-underline-offset:3px}.pfg-company-goal{padding:16px 0;border-bottom:1px solid var(--border,#d5dce5)}.pfg-company-goal h3{margin-bottom:5px}.pfg-company-goal ul{padding-left:20px;font-size:13px;line-height:1.7}.pfg-company .pfg-map h3{margin:0}.pfg-company .pfg-map-node{min-height:0}.pfg-company-shadow-tree{padding-left:18px;border-left:1px solid var(--border,#d5dce5);margin:12px 0}.pfg-company-search{max-width:560px;margin-bottom:20px}@media(max-width:900px){.pfg-company-split{grid-template-columns:1fr}.pfg-company-form{max-width:100%}.pfg-company-head{flex-wrap:wrap}}@media(max-width:540px){.pfg-company-fieldrow{grid-template-columns:1fr}.pfg-company-pack-head{flex-direction:column}.pfg-company{padding:22px 16px}.pfg-company-nav{margin:18px 0}.pfg-company-nav button{padding:10px}.pfg-company th,.pfg-company td{padding:10px 7px}.pfg-company-metrics{gap:16px}}
`;

function Empty({ children }) { return <p className="pfg-company-empty">{children}</p>; }
function Field({ label, children }) { return <label className="pfg-company-field">{label}{children}</label>; }
function Evidence({ value }) { return <details><summary>Sources and recorded details</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>; }
function Table({ headings, children, minWidth }) { return <div className="pfg-company-table-wrap" tabIndex={minWidth?0:undefined} aria-label={minWidth?'Scrollable table':undefined}><table style={minWidth?{minWidth}:undefined}><thead><tr>{headings.map(text => <th key={text}>{text}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function ProjectSelect({data,value,onChange}) { return <select value={value} onChange={event=>onChange(event.target.value)} required><option value="">Choose project</option>{array(data.nativeProjects).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select>; }
function currentGoals(control) {
  const revisions = array(control.goalHistory ?? control.goals?.revisions ?? control.goals);
  return [...new Map(revisions.map(revision => [`${revision.scope}:${revision.subjectId}`, revision])).values()];
}

export function CompanySidebarLink({ context }) {
  const navigation = useHostNavigation();
  return context?.companyId ? <a {...navigation.linkProps('/company-operations')} style={{ display: 'block', padding: '7px 12px', fontWeight: 600, color: 'var(--foreground)', textDecoration: 'none' }}>Company operations</a> : null;
}

export function CompanyDashboardPage({ context }) {
  const host = useHostContext(), navigation = useHostNavigation();
  const companyId = context?.companyId ?? host.companyId;
  const [tab, setTab] = useState('overview'), [data, setData] = useState(null), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const action = usePluginAction('graph-company-command');
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    if (!companyId) { setLoading(false); return; }
    const controller = new AbortController(); setData(current=>current?.setup?.companyId===companyId?current:null); setLoading(true); setError('');
    fetch(`/api/plugins/pohlee.polyforge-graph/api/company?companyId=${encodeURIComponent(companyId)}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `Company data unavailable (${response.status})`); return body; })
      .then(value => { setData(value); setLoading(false); }).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false); } });
    return () => controller.abort();
  }, [companyId, revision]);
  async function command(operation, fields) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await action({ companyId, operation, ...fields, idempotencyKey: crypto.randomUUID() }); if(operation!=='query-knowledge'){setNotice('Saved. The decision and its reason are recorded.');refresh();}return result; }
    catch (err) { setError(err.message ?? String(err)); throw err; } finally { setBusy(false); }
  }
  const control = data?.control ?? {}, catalog = array(data?.catalog), enabled = array(data?.enabledPacks ?? data?.setup?.enabledPacks);
  const operations = { data, control, catalog, enabled, command, busy, navigation, companyId };
  return <main className="pfg-company"><style>{css}</style><header className="pfg-company-head"><div><h1>Company operations</h1><p className="pfg-company-muted">Goals, Packs and the work connecting them.</p></div><button type="button" onClick={refresh} disabled={loading}>Refresh</button></header>
    {!companyId ? <Empty>Select a company to view its work.</Empty> : <>
      <nav className="pfg-company-nav" aria-label="Company operations">{[['overview','Overview'],['packs','Packs & setup'],['plans','Work plans'],['goals','Goals & outcomes'],['knowledge','Knowledge'],['activity','Feedback & temporary agents'],['notifications','Notifications']].map(([id,label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {error && <p className="pfg-company-notice" role="alert">{error}</p>}{notice && <p className="pfg-company-notice" role="status">{notice}</p>}
      {loading && !data ? <p role="status">Loading company work…</p> : data ? <>
        {tab === 'overview' && <Overview {...operations} setTab={setTab} />}
        {tab === 'packs' && <Packs {...operations} />}
        {tab === 'plans' && <Plans {...operations} />}
        {tab === 'goals' && <><Goals {...operations} /><EvidenceSettings {...operations}/></>}
        {tab === 'knowledge' && <Knowledge {...operations} />}
        {tab === 'activity' && <Activity {...operations} />}
        {tab === 'notifications' && <><Notifications {...operations} /><ChannelSettings {...operations}/></>}
      </> : null}
    </>}
  </main>;
}

function Overview({ data, control, catalog, enabled, navigation, setTab }) {
  const [packId, setPackId] = useState('');
  const pack = catalog.find(item => item.id === packId && enabled.some(selection=>selection.packId===item.id&&selection.version===item.version)), runs = array(data.runs).filter(run => !packId || run.packId === packId);
  const intakes = array(control.intake ?? control.intakes), decisions = array(data.decisions ?? control.audit).filter(item=>!packId||item.packId===packId);
  const pending = array(data.nativeDecisions ?? data.decisions).filter(item => ['pending','open','awaiting_decision'].includes(item.status)&&(!packId||runs.some(run=>run.id===item.runId)));
  const active = runs.filter(run => ['running','paused'].includes(run.status));
  const views=array(pack?.dashboard?.views).filter(view=>view.kind==='run-list');
  const runTable=items=>items.length?<Table headings={['Workflow','Pack','Status','Started']}>{items.slice(0,15).map(run=><tr key={run.id}><td><a {...navigation.linkProps(`/graph-runs?issueId=${encodeURIComponent(run.input?.paperclipIssueId??run.issueId??'')}&runId=${encodeURIComponent(run.id)}`)}>{name(run.graphId??run.graph?.id)}</a></td><td>{name(run.packId)}<small>{run.packVersion}</small></td><td>{name(run.status)}</td><td>{run.startedAt?new Date(run.startedAt).toLocaleString():'—'}</td></tr>)}</Table>:<Empty>No work in this view yet.</Empty>;
  return <>
    {!data.setup?.ready && <section className="pfg-company-section"><h2>Set up this company</h2><p className="pfg-company-muted">Choose Packs, bind the organization and check its execution capabilities.</p><button className="pfg-primary" onClick={() => setTab('packs')}>Open setup</button></section>}
    <section className="pfg-company-section"><div className="pfg-company-head"><div><h2>{pack?.dashboard?.title ?? 'Company work'}</h2><p className="pfg-company-muted">{pack?.dashboard?.description ?? 'Follow active work, incoming requests and decisions that need attention.'}</p></div><Field label="Dashboard"><select value={packId} onChange={e => setPackId(e.target.value)}><option value="">All Packs</option>{enabled.map(item => <option key={item.packId} value={item.packId}>{name(item.packId)}</option>)}</select></Field></div>
      <div className="pfg-company-metrics">{pack?.dashboard?.metrics?.length?pack.dashboard.metrics.map(metric=><span key={metric.id} className="pfg-company-metric"><strong>{metric.availability==='available'?metric.value:'—'}</strong>{metric.label}</span>):<><span className="pfg-company-metric"><strong>{active.length}</strong>active runs</span><span className="pfg-company-metric"><strong>{pending.length}</strong>decisions waiting</span><span className="pfg-company-metric"><strong>{intakes.filter(item => !['accepted','cancelled','rejected'].includes(item.status)).length}</strong>requests to route</span></>}</div>
      {pending.length > 0 && <section><h3>Decisions awaiting review</h3><ul className="pfg-company-list">{pending.map(item => <li key={item.interactionId??item.id}><strong>{item.title ?? item.question ?? 'Review artifact'}</strong>{item.url && <p><a {...navigation.linkProps(item.url)}>Open Paperclip decision</a></p>}<Evidence value={item.artifacts ?? item.evidence ?? item} /></li>)}</ul></section>}
      {views.length?views.map(view=><section className="pfg-company-section" key={view.id}><h3>{view.label}</h3>{runTable(runs.filter(run=>!view.graphIds?.length||view.graphIds.includes(run.graphId??run.graph?.id)))}</section>):runTable(runs)}
    </section>
    <section className="pfg-company-section"><h2>Requests & delegation</h2>{intakes.length ? <Table headings={['Request','Channel','Assignee','Status']}>{intakes.map(item => <tr key={item.id}><td>{item.title}<small>{item.description}</small></td><td>{name(item.source?.channel ?? item.channel ?? 'Paperclip')}</td><td>{item.assigneeId ?? 'CEO'}</td><td>{name(item.status)}<Evidence value={item.history} /></td></tr>)}</Table> : <Empty>Requests from Paperclip chat and Telegram will appear here with their routing history.</Empty>}</section>
    <section className="pfg-company-section"><h2>{array(pack?.dashboard?.views).find(view=>view.kind==='decision-history')?.label??'Recent decisions'}</h2>{decisions.length ? <ul className="pfg-company-list">{decisions.slice().sort((a,b)=>(b.at??'').localeCompare(a.at??'')).slice(0,12).map(item => <li key={item.id}><strong>{name(item.kind ?? item.type)}</strong> · {item.reason}<Evidence value={item} /></li>)}</ul> : <Empty>No company decisions have been recorded.</Empty>}</section>
  </>;
}

function Packs({ data, catalog, enabled, command, busy, companyId, navigation }) {
  const [selected, setSelected] = useState('');
  const [aligning,setAligning]=useState(false),[alignmentMessage,setAlignmentMessage]=useState('');
  const org = data.setup?.organization;
  async function prepare(pack) { try { await command('enable-pack',{packId:pack.id,version:pack.version,reason:'Company owner selected this Pack during setup'}); await command('provision-pack',{packId:pack.id,version:pack.version,reason:'Provision the selected Pack roles and skills'}); } catch {} }
  async function align() {
    setAligning(true);setAlignmentMessage('');
    try {
      await command('configure-organization',{derive:true,organization:{board:org?.board,ceo:org?.ceo,authorityPolicy:org?.authorityPolicy},reason:'Company owner selected CEO and domain leaders'});
      const plan=await command('organization-reporting-plan',{reason:'Company owner requested native reporting alignment'});
      if(plan.conflicts?.length)throw new Error('Existing custom reporting links require review. No managers were changed.');
      for(const change of plan.changes??[]) {
        const response=await fetch(`/api/agents/${encodeURIComponent(change.agentId)}`,{credentials:'same-origin'});
        if(!response.ok)throw new Error('Could not verify current reporting link');
        const agent=await response.json();
        if(agent.companyId!==companyId)throw new Error('Agent belongs to another company');
        if((agent.reportsTo??null)===change.toReportsTo)continue;
        if((agent.reportsTo??null)!==change.fromReportsTo)throw new Error('Reporting changed after planning; refresh and review again');
        const updated=await fetch(`/api/agents/${encodeURIComponent(change.agentId)}`,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({reportsTo:change.toReportsTo})});
        if(!updated.ok)throw new Error('Paperclip could not apply this reporting link. Retry to verify the remaining links.');
      }
      await command('organization-reporting-confirm',{planDecisionId:plan.planDecisionId,reason:'Verified the native Paperclip organization matches the requested plan'});
      setAlignmentMessage('Paperclip reporting links are aligned and verified.');
    }catch(error){setAlignmentMessage(error.message);}finally{setAligning(false);}
  }
  return <>
    <section className="pfg-company-section"><h2>Choose the company’s Packs</h2><p className="pfg-company-muted">Each Pack keeps its own version. Compatibility and available capabilities are checked before work starts.</p>
      {catalog.map(pack => { const activation = enabled.find(item => item.packId === pack.id && item.version === pack.version); return <article className="pfg-company-pack" key={`${pack.id}@${pack.version}`}><div className="pfg-company-pack-head"><div><h3>{pack.displayName ?? name(pack.id)} · {pack.version}</h3><p className="pfg-company-muted">{pack.dashboard?.description ?? pack.description ?? `${pack.graphs?.length ?? 0} workflows`}</p><p className="pfg-company-muted">Core {pack.compatibility?.coreRange ?? 'Legacy declaration'} · {activation ? 'Enabled for this company' : 'Available to enable'}</p></div><div className="pfg-company-inline"><button onClick={() => prepare(pack)} disabled={busy}>{activation ? 'Provision roles' : 'Enable & provision'}</button><button onClick={() => setSelected(selected === pack.id ? '' : pack.id)} aria-expanded={selected === pack.id}>View workflows</button></div></div>{selected === pack.id && <>{array(pack.compatibilityReport?.issues).map(issue => <p key={issue} role="alert">{issue}</p>)}{array(pack.graphs).map(graph => <details key={graph.id}><summary>{name(graph.id)} · {graph.version}</summary>{graph.nodes ? <GraphDiagram graph={graph} /> : <p>Open a run to view this workflow’s pinned definition.</p>}</details>)}</>}</article>; })}
    </section>
    <section className="pfg-company-section"><h2>Organization</h2><p className="pfg-company-muted">Board → CEO → domain leaders. Review responsibilities remain explicit in each Graph.</p>{org ? <Table headings={['Role','Agent','Reports to']}><tr><td>CEO</td><td>{org.ceo?.name ?? org.ceo?.id}</td><td>Board</td></tr>{array(org.domainHeads).map(head => <tr key={`${head.domain}:${head.agentId}`}><td>{name(head.domain)}</td><td>{head.name ?? head.agentId}</td><td>CEO</td></tr>)}</Table> : <Empty>Provision the selected Pack roles, then align the company organization.</Empty>}<button disabled={busy || aligning || !enabled.length} onClick={align}>{aligning?'Aligning…':'Align Paperclip organization'}</button>{alignmentMessage&&<p role="status" className="pfg-company-notice">{alignmentMessage}</p>}</section>
    {org&&<CompanyAuthority organization={org} command={command} busy={busy}/>}
    <ExecutionSetup data={data} command={command} busy={busy} navigation={navigation}/>
  </>;
}

function CompanyAuthority({organization,command,busy}) {
  const [operations,setOperations]=useState(null),[decisions,setDecisions]=useState(null),[reason,setReason]=useState('');
  const policy=organization.authorityPolicy??{};
  const selected=operations??policy.ceoOperations??[],decisionTypes=decisions??policy.ceoDecisions??[];
  const scopes=[['intake','Receive and reassign requests'],['work-plan','Prioritize and start work plans'],['agent-goal','Update supporting Agent objectives'],['cross-pack','Coordinate work between Packs'],['strategy','Adjust strategy using verified results'],['decision','Resolve delegated disagreements']];
  async function save(event){event.preventDefault();try{await command('configure-organization',{organization:{...organization,authorityPolicy:{...policy,ceoOperations:selected,ceoDecisions:decisionTypes}},reason});setReason('');}catch{}}
  return <section className="pfg-company-section"><h3>CEO authority</h3><p className="pfg-company-muted">Choose which actions the company CEO may take. Mandatory human decisions and actions outside these permissions return to the Board.</p><form className="pfg-company-form" onSubmit={save}>{scopes.map(([id,label])=><label key={id}><span><input type="checkbox" checked={selected.includes(id)} onChange={e=>setOperations(e.target.checked?[...selected,id]:selected.filter(item=>item!==id))}/> {label}</span></label>)}{selected.includes('decision')&&<fieldset><legend>Disagreements the CEO may resolve</legend>{scopes.filter(([id])=>id!=='decision').map(([id,label])=><label key={id}><span><input type="checkbox" checked={decisionTypes.includes(id)} onChange={e=>setDecisions(e.target.checked?[...decisionTypes,id]:decisionTypes.filter(item=>item!==id))}/> {label}</span></label>)}</fieldset>}<Field label="Reason for this authority"><input required value={reason} onChange={e=>setReason(e.target.value)}/></Field><button disabled={busy} className="pfg-primary">Save CEO authority</button></form></section>;
}

function ExecutionSetup({data,command,busy,navigation}) {
  const [mode,setMode]=useState(''),[reason,setReason]=useState('');
  const readiness=data.readiness;
  async function save(event){event.preventDefault();try{await command('configure-execution',{defaultMode:mode||data.config?.defaultMode||'manual',reason});}catch{}}
  const issues=checks=>array(checks).filter(check=>check.status!=='ready');
  return <>
    <section className="pfg-company-section"><h2>Execution setup</h2><p className="pfg-company-muted">Configure each role and project in Paperclip, then refresh this page. Provider access remains unverified until the host can establish it.</p>
      {readiness?<><p role="status"><strong>{readiness.ready?'Configured for execution':`Setup ${name(readiness.status).toLowerCase()}`}</strong></p><ul>{issues(readiness.checks).map(check=><li key={check.id}>{check.reason} {check.action}</li>)}</ul></>:<Empty>Readiness has not been checked.</Empty>}
      <h3>1. Agent models, budget and tools</h3><Table headings={['Role','Adapter / model','Checks','Configure']} minWidth={660}>{array(readiness?.roles).map(role=><tr key={role.id}><td>{name(role.roleId)}<small>{role.id}</small></td><td>{role.adapterType??'Not selected'}<small>{role.synthetic?'Synthetic process fixture':role.model??'Model not selected'}</small></td><td>{name(role.status)}{issues(role.checks).map(check=><small key={check.id}>{check.reason} {check.action}</small>)}</td><td>{role.agentId?<a {...navigation.linkProps(`/agents/${encodeURIComponent(role.agentId)}/configuration`)}>Agent settings</a>:'Provision or bind this role first'}</td></tr>)}</Table>
    </section>
    <section className="pfg-company-section"><h3>2. Project repositories and workspaces</h3>{array(readiness?.projects).length?<Table headings={['Project','Checks','Configure']}>{readiness.projects.map(project=><tr key={project.projectId}><td>{project.name}</td><td>{name(project.status)}{issues(project.checks).map(check=><small key={check.id}>{check.reason} {check.action}</small>)}</td><td><a {...navigation.linkProps(`/projects/${encodeURIComponent(project.projectId)}/configuration`)}>Project settings</a><br/><a {...navigation.linkProps(`/projects/${encodeURIComponent(project.projectId)}/workspaces`)}>Workspaces</a><br/><a {...navigation.linkProps(`/projects/${encodeURIComponent(project.projectId)}/budget`)}>Project budget</a></td></tr>)}</Table>:<Empty><a {...navigation.linkProps('/projects')}>Create a Paperclip project</a> to configure its repository and workspace.</Empty>}</section>
    <section className="pfg-company-section"><h3>3. Decision mode</h3><form onSubmit={save} className="pfg-company-form"><Field label="Default for new work"><select value={mode||data.config?.defaultMode||'manual'} onChange={event=>setMode(event.target.value)}><option value="manual">Manual</option><option value="assisted">Assisted</option><option value="autonomous">Autonomous</option></select></Field><p className="pfg-company-muted">Existing runs retain their mode. Each Pack keeps its mandatory human decisions.</p><Field label="Reason"><input value={reason} onChange={event=>setReason(event.target.value)} required/></Field><button disabled={busy} className="pfg-primary">Save decision mode</button></form></section>
    <section className="pfg-company-section"><h3>4. Workflow tools and contracts</h3>{array(readiness?.packs).map(pack=><section key={`${pack.packId}@${pack.version}`}><h3>{name(pack.packId)} · {pack.version}</h3><Table headings={['Workflow','Readiness','Required action']}>{array(pack.graphs).map(graph=><tr key={graph.graphId}><td>{name(graph.graphId)}</td><td>{name(graph.status)}</td><td>{issues(graph.checks).length?issues(graph.checks).map((check,index)=><small key={`${check.id}:${index}`}>{check.reason} {check.action}</small>):'Requirements configured'}</td></tr>)}</Table></section>)}</section>
  </>;
}

function Plans({ data, control, catalog, enabled, command, busy }) {
  const [projectId,setProjectId]=useState(''),[packId,setPackId]=useState(''),[graphId,setGraphId]=useState(''),[title,setTitle]=useState(''),[depends,setDepends]=useState(''),[items,setItems]=useState([]),[reason,setReason]=useState('');
  const [inputText,setInputText]=useState('{}'),[inputError,setInputError]=useState('');
  const graphs = catalog.find(pack=>pack.id===packId)?.graphs ?? [];
  function addItem(){try{const input=JSON.parse(inputText);if(!input||Array.isArray(input)||typeof input!=='object')throw new Error('Workflow input must be an object');setItems([...items,{id:`work-${items.length+1}`,title,packId,graphId,input,priority:items.length+1,dependsOn:depends?[depends]:[]}]);setTitle('');setInputError('');}catch(error){setInputError(error.message);}}
  async function save(event){event.preventDefault();try{await command('create-plan',{projectId,items,reason});setItems([]);}catch{}}
  return <div className="pfg-company-split"><section><h2>Cross-Pack work plans</h2><p className="pfg-company-muted">Dependencies decide when work can start. Smaller priority numbers run first.</p>{array(control.plans).length ? array(control.plans).map(plan=><section className="pfg-company-section" key={plan.id}><h3>{plan.title ?? array(data.nativeProjects).find(project=>project.id===plan.projectId)?.name ?? `Project ${plan.projectId}`}</h3><Table headings={['Work','Pack','Priority','Dependencies','Status']}>{array(plan.items).map(item=><tr key={item.id}><td>{item.title ?? name(item.graphId)}</td><td>{name(item.packId)}</td><td>{item.priority}</td><td>{item.dependsOn?.join(', ') || 'None'}</td><td>{name(item.status)}{item.status==='pending'&&<button disabled={busy} onClick={()=>command('start-plan-item',{planId:plan.id,itemId:item.id,reason:'Company owner started ready planned work'}).catch(()=>{})}>Start</button>}</td></tr>)}</Table></section>):<Empty>No work plans yet. CEO can create a coordinated plan from a request.</Empty>}</section>
    <form className="pfg-company-form" onSubmit={save}><h3>Create a work plan</h3><Field label="Project"><ProjectSelect data={data} value={projectId} onChange={setProjectId}/></Field><Field label="Work title"><input value={title} onChange={e=>setTitle(e.target.value)} /></Field><div className="pfg-company-fieldrow"><Field label="Pack"><select value={packId} onChange={e=>{setPackId(e.target.value);setGraphId('');}}><option value="">Choose Pack</option>{enabled.map(pack=><option key={pack.packId} value={pack.packId}>{name(pack.packId)}</option>)}</select></Field><Field label="Workflow"><select value={graphId} onChange={e=>setGraphId(e.target.value)}><option value="">Choose workflow</option>{graphs.map(graph=><option key={graph.id} value={graph.id}>{name(graph.id)}</option>)}</select></Field></div><Field label="Wait for"><select value={depends} onChange={e=>setDepends(e.target.value)}><option value="">No dependency</option>{items.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}</select></Field><Field label="Workflow input (JSON)"><textarea value={inputText} onChange={e=>setInputText(e.target.value)} spellCheck={false}/></Field>{inputError&&<p role="alert">{inputError}</p>}<button type="button" disabled={!packId||!graphId||!title} onClick={addItem}>Add work item</button>{items.length>0&&<ol>{items.map(item=><li key={item.id}>{item.title} · {name(item.packId)}</li>)}</ol>}<Field label="Reason"><input value={reason} onChange={e=>setReason(e.target.value)} required /></Field><button className="pfg-primary" disabled={busy||!items.length}>Save work plan</button></form>
  </div>;
}

function Goals({ data, control, command, busy, companyId }) {
  const revisions=currentGoals(control),org=data.setup?.organization;
  const [subject,setSubject]=useState('company'),[objective,setObjective]=useState(''),[target,setTarget]=useState(''),[baseline,setBaseline]=useState(''),[unit,setUnit]=useState(''),[source,setSource]=useState(''),[window,setWindow]=useState(''),[parent,setParent]=useState(''),[reason,setReason]=useState('');
  const [reviewGoal,setReviewGoal]=useState(''),[reviewProject,setReviewProject]=useState(''),[receiptIds,setReceiptIds]=useState({}),[reviewRun,setReviewRun]=useState('');

  const goals=revisions.flatMap(revision=>revision.goals.map(goal=>({...goal,revisionId:revision.id,subjectId:revision.subjectId})));
  const delivery=useGraphData(reviewRun?companyId:null,undefined,reviewRun||undefined);
  const reviewGoals=reviewRun?array(delivery.data?.run?.goalContext?.revisions).flatMap(revision=>revision.goals.map(goal=>({...goal,revisionId:revision.id}))):goals;
  const selectedGoal=reviewGoals.find(goal=>goal.id===reviewGoal);
  const receipts=array(control.evidenceReceipts).map(item=>item.receipt).filter(Boolean).filter(receipt=>receipt.kind==='metric'&&receipt.projectId===reviewProject&&receipt.data?.goalId===reviewGoal&&receipt.data?.goalRevisionId===selectedGoal?.revisionId&&Date.parse(receipt.expiresAt)>Date.now());
  async function save(event){event.preventDefault();const subjectId=subject==='company'?control.companyId:subject;const prior=revisions.find(item=>item.subjectId===subjectId);try{await command('set-goals',{scope:subject==='company'?'company':'agent',subjectId,goals:[...(prior?.goals??[]),{id:crypto.randomUUID(),title:objective,...(parent?{parentGoalId:parent}:{}),keyResults:[{id:crypto.randomUUID(),target:Number(target),...(baseline!==''?{baseline:Number(baseline)}:{}),unit,source,window}]}],reason});setObjective('');}catch{}}
  async function review(event){event.preventDefault();if(!selectedGoal)return;const observations=receipts.filter(receipt=>receiptIds[receipt.data.keyResultId]===receipt.id).map(receipt=>({keyResultId:receipt.data.keyResultId,evidenceReceiptId:receipt.id}));try{await command('review-outcome',{projectId:reviewProject,goalId:selectedGoal.id,...(reviewRun?{runId:reviewRun}:{goalRevisionId:selectedGoal.revisionId}),observations,reason:observations.length?'Company owner reviewed verified measurement receipts':'Company owner recorded an outcome review with unavailable measurement'});}catch{}}
  return <><div className="pfg-company-split"><section><h2>Objectives & key results</h2><p className="pfg-company-muted">Goal changes apply to new work. Existing runs, retries and temporary agent sessions retain their original goal context.</p>{revisions.length?revisions.map(revision=><section key={revision.id} className="pfg-company-goal"><p className="pfg-company-muted">{revision.scope==='company'?'Company':revision.subjectId} · revision {revision.version}</p>{revision.goals.map(goal=><div key={goal.id}><h3>{goal.title}</h3>{goal.parentGoalId&&<p className="pfg-company-muted">Supports: {goals.find(item=>item.id===goal.parentGoalId)?.title??goal.parentGoalId}</p>}<ul>{goal.keyResults.map(kr=><li key={kr.id}>{kr.baseline??'Unknown baseline'} → <strong>{kr.target} {kr.unit}</strong><br/><span className="pfg-company-muted">{typeof kr.window==='string'?kr.window:JSON.stringify(kr.window)} · {typeof kr.source==='string'?kr.source:JSON.stringify(kr.source)}</span></li>)}</ul></div>)}</section>):<Empty>Add a measurable company objective, then assign supporting objectives to domain leaders.</Empty>}</section>
    <form className="pfg-company-form" onSubmit={save}><h3>Add an objective</h3><Field label="Owner"><select value={subject} onChange={e=>setSubject(e.target.value)}><option value="company">Company</option>{org?.ceo?.id&&<option value={org.ceo.id}>CEO</option>}{array(org?.domainHeads).map(head=><option key={head.agentId} value={head.agentId}>{name(head.domain)}</option>)}</select></Field><Field label="Objective"><input value={objective} onChange={e=>setObjective(e.target.value)} required /></Field><Field label="Supports company objective"><select value={parent} onChange={e=>setParent(e.target.value)}><option value="">Top-level objective</option>{goals.map(goal=><option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></Field><div className="pfg-company-fieldrow"><Field label="Baseline (if known)"><input type="number" step="any" value={baseline} onChange={e=>setBaseline(e.target.value)}/></Field><Field label="Target"><input type="number" step="any" value={target} onChange={e=>setTarget(e.target.value)} required/></Field></div><Field label="Measurement unit"><input value={unit} onChange={e=>setUnit(e.target.value)} required placeholder="Paid subscriptions"/></Field><Field label="Measurement source"><input value={source} onChange={e=>setSource(e.target.value)} required /></Field><Field label="Observation window"><input value={window} onChange={e=>setWindow(e.target.value)} required placeholder="10 days after verified launch"/></Field><Field label="Reason"><input value={reason} onChange={e=>setReason(e.target.value)} required /></Field><button className="pfg-primary" disabled={busy}>Save objective</button></form>
    </div><section className="pfg-company-section"><h2>Outcome reviews</h2><p className="pfg-company-muted">Measurements need a source and observation window. Unavailable data remains unknown.</p><div className="pfg-company-split"><div>{array(control.reviews??control.outcomes).length?<ul className="pfg-company-list">{array(control.reviews??control.outcomes).map(item=><li key={item.id}><strong>{goals.find(goal=>goal.id===item.goalId)?.title??item.goalId}</strong>{array(item.observations).map(observation=><p key={observation.keyResultId}>{observation.status==='unknown'?'Unknown':observation.value} / target {observation.target}<br/><span className="pfg-company-muted">{name(observation.status)}</span></p>)}<Evidence value={item}/></li>)}</ul>:<Empty>No measured outcomes yet.</Empty>}</div><form className="pfg-company-form" onSubmit={review}><h3>Record an observation</h3><Field label="Project"><ProjectSelect data={data} value={reviewProject} onChange={value=>{setReviewProject(value);setReceiptIds({});setReviewRun('');setReviewGoal('');}}/></Field><Field label="Related delivery (optional)"><select value={reviewRun} onChange={e=>{setReviewRun(e.target.value);setReviewGoal('');setReceiptIds({});}}><option value="">Company outcome without Pack attribution</option>{array(data.runs).filter(run=>run.projectId===reviewProject&&run.status==='completed').map(run=><option key={run.id} value={run.id}>{name(run.packId)} · {name(run.graphId)}</option>)}</select></Field><Field label="Objective"><select value={reviewGoal} onChange={e=>{setReviewGoal(e.target.value);setReceiptIds({});}} required><option value="">Choose objective</option>{reviewGoals.map(goal=><option key={goal.id} value={goal.id}>{goal.title}</option>)}</select></Field><p className="pfg-company-muted">{reviewRun?'Objectives and receipts below use the selected delivery’s original goal revisions.':'Select a verified measurement for each key result.'}</p>{array(selectedGoal?.keyResults).map(kr=><Field key={kr.id} label={`${kr.id} — target ${kr.target} ${kr.unit}`}><select value={receiptIds[kr.id]??''} onChange={e=>setReceiptIds({...receiptIds,[kr.id]:e.target.value})}><option value="">No verified measurement — record as unknown</option>{receipts.filter(receipt=>receipt.data.keyResultId===kr.id).map(receipt=><option key={receipt.id} value={receipt.id}>{receipt.data.value} · {receipt.providerId} · {receipt.data.observedAt}</option>)}</select></Field>)}<p className="pfg-company-muted">Measurements must come from a configured evidence provider. A manually entered URL is not a verified measurement.</p><button disabled={busy||!selectedGoal||!reviewProject||delivery.loading}>Record review</button></form></div></section></>;
}

function Knowledge({ control, data, command, busy }) {
  const [query,setQuery]=useState(''),[results,setResults]=useState(null);
  const items=(results??[...array(control.knowledge),...array(data.productDecisions)]).filter(item=>JSON.stringify(item).toLowerCase().includes(query.toLowerCase()));
  async function search(event){event.preventDefault();try{setResults(await command('query-knowledge',{q:query}));}catch{}}
  return <section><h2>Product knowledge & decisions</h2><p className="pfg-company-muted">Find product rules, their reasons and the records that support them.</p><form onSubmit={search} className="pfg-company-inline"><Field label="Search knowledge"><input className="pfg-company-search" type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search a feature, decision or past change"/></Field><button disabled={busy}>Search recorded knowledge & decisions</button></form>{items.length?<ul className="pfg-company-list">{items.map((item,index)=><li key={item.id??index}><h3>{item.title??item.outcome??name(item.kind)}</h3><p>{item.body??item.reason}</p><p className="pfg-company-muted">{name(item.status??'recorded')}{item.supersedes?` · supersedes ${item.supersedes}`:''}</p><Evidence value={item.sourceRefs??item.evidence??item}/></li>)}</ul>:<Empty>{query?'No sourced records match this query.':'No product knowledge has been recorded for this company.'}</Empty>}</section>;
}

const shadowAdapters = [
  ['process', 'Local process'], ['codex_local', 'Codex local'],
  ['claude_local', 'Claude local'], ['opencode_local', 'OpenCode local'],
];
const defaultShadowPolicy = { enabled:false, allowSameAgent:false, allowAgentTrigger:false,
  allowGraphTrigger:false, maxDurationSeconds:900,
  allowedAdapterTypes:shadowAdapters.map(([id])=>id) };

const defaultTemporaryAgentPolicy = {version:1,enabled:false,maxConcurrentChildren:3,maxDepth:1,
  maxDurationSeconds:900,allowSharedWorkspaceWrites:false,
  allowedPurposes:['review','research','analyze','implement']};

function TemporaryAgentRecord({item,viewer,command,busy}) {
  const [stopReason,setStopReason]=useState('');
  const owner=viewer?.kind==='human'&&array(viewer?.roles).includes('human-owner');
  const parent=viewer?.kind==='agent'&&viewer.id===item.parent?.agentId&&viewer.executionId===item.parent?.executionId;
  const canStop=item.temporaryAgentId&&item.status!=='closed'&&(owner||parent);
  async function stop(){try{await command('stop-temporary-agent',{temporaryAgentId:item.temporaryAgentId,reason:stopReason.trim()});setStopReason('');}catch{}}
  return <li><strong>{item.kind==='shadow-agent'?'Shadow-Agent':'Sub-Agent'}</strong> · {name(item.purpose)} · {name(item.status)}
    <small>Parent: {item.parent?.agentId??'Unknown'} · Session: {item.sessionId??'Awaiting session'} · Execution: {item.executionId??'Awaiting execution'}</small>
    <small>Context: {item.context?.mode==='snapshot'?'Frozen snapshot in a new session':'Fresh brief in a new session'}{item.context?.digest?` · ${item.context.digest}`:''}</small>
    {item.context?.capturedAt&&<small>Captured: {new Date(item.context.capturedAt).toLocaleString()} · Parent execution: {item.context.source?.executionId??'Unknown'} · Issue: {item.context.source?.taskId??'Unknown'}</small>}
    {item.deadlineAt&&<small>Deadline: {new Date(item.deadlineAt).toLocaleString()}</small>}
    {item.outcome&&<small>Outcome: {name(item.outcome)}</small>}
    {item.result?.summary&&<p>{item.result.summary}</p>}
    {item.repairReason&&<p role="alert">Needs repair: {item.repairReason}</p>}
    {canStop&&<div className="pfg-company-inline"><Field label="Reason to stop"><input value={stopReason} onChange={e=>setStopReason(e.target.value)} required/></Field><button type="button" disabled={busy||!stopReason.trim()} onClick={stop}>Request stop</button></div>}
  </li>;
}

function TemporaryAgentPolicy({control,data,command,busy}) {
  const policy=control.temporaryAgentPolicy??defaultTemporaryAgentPolicy;
  const capabilities=data.temporaryAgentCapabilities??{};
  const [draft,setDraft]=useState(null),[reason,setReason]=useState('');
  const selected=draft??policy;
  const owner=data.viewer?.kind==='human'&&array(data.viewer?.roles).includes('human-owner');
  const kinds=array(capabilities.availableKinds);
  const state=kind=>{
    if(!data.temporaryAgentCapabilities)return 'Unavailable: host runtime not connected';
    const hostSupports=capabilities.freshSession===true;
    if(!hostSupports)return 'Unavailable: this host cannot create a fresh task session';
    if(!policy.enabled)return 'Available on host · disabled by company policy';
    if(!kinds.includes(kind))return 'Unavailable on this host';
    return 'Available';
  };
  async function save(event){event.preventDefault();if(!owner)return;try{
    await command('configure-temporary-agent-policy',{policy:{...selected,maxConcurrentChildren:Number(selected.maxConcurrentChildren),maxDurationSeconds:Number(selected.maxDurationSeconds)},reason:reason.trim()});
    setDraft(null);setReason('');
  }catch{}}
  return <section className="pfg-company-section"><h2>Temporary agents</h2><p className="pfg-company-muted">Sub-Agents start fresh task sessions from a scoped brief. Shadow-Agents use a frozen parent context snapshot in a new session with the same company Agent. Neither holds a company position.</p>
    <ul className="pfg-company-list"><li><strong>Sub-Agent</strong><br/><span className="pfg-company-muted">{state('sub-agent')}</span></li><li><strong>Shadow-Agent</strong><br/><span className="pfg-company-muted">{state('shadow-agent')}</span></li></ul>
    {!capabilities.scopedNativeTools&&<p className="pfg-company-muted">Sessions inherit the Agent’s existing tools and credentials. Read-only work is an instruction, not a sandbox. Only review, research and analysis can be delegated on this host.</p>}
    {owner?<form className="pfg-company-form" onSubmit={save}>
      <label><span><input type="checkbox" checked={Boolean(selected.enabled)} onChange={e=>setDraft({...selected,enabled:e.target.checked})}/> Enable temporary agents for this company</span></label>
      <div className="pfg-company-fieldrow"><Field label="Maximum concurrent children"><input type="number" min="1" max="16" step="1" required value={selected.maxConcurrentChildren} onChange={e=>setDraft({...selected,maxConcurrentChildren:e.target.value})}/></Field><Field label="Maximum duration (seconds)"><input type="number" min="1" max="3600" step="1" required value={selected.maxDurationSeconds} onChange={e=>setDraft({...selected,maxDurationSeconds:e.target.value})}/></Field></div>
      <p className="pfg-company-muted">Workspace writes are unavailable through this control. Parent Agents can request only the purposes allowed by company policy and host capability.</p>
      <Field label="Reason for this policy"><input value={reason} onChange={e=>setReason(e.target.value)} required/></Field>
      <button className="pfg-primary" disabled={busy||!reason.trim()}>Save temporary agent policy</button>
    </form>:<p className="pfg-company-muted">Company policy: {policy.enabled?'enabled':'disabled'} · up to {policy.maxConcurrentChildren} concurrent children · {policy.maxDurationSeconds} seconds maximum. A human owner can change this policy.</p>}
    <h3>Temporary agent history</h3><p className="pfg-company-muted">A stop request blocks result acceptance. This host does not provide native cancellation, so a running session may continue past its deadline until the adapter exits.</p>{array(data.temporaryAgents).length?<ul className="pfg-company-list">{array(data.temporaryAgents).map(item=><TemporaryAgentRecord key={item.temporaryAgentId} item={item} viewer={data.viewer} command={command} busy={busy}/>)}</ul>:<Empty>No temporary agent executions have been recorded.</Empty>}
  </section>;
}

function ShadowPolicy({ control, data, command, busy }) {
  const policy=control.shadowPolicy??defaultShadowPolicy;
  const [draft,setDraft]=useState(null),[reason,setReason]=useState('');
  const selected=draft??policy;
  const owner=data.viewer?.kind==='human'&&array(data.viewer?.roles).includes('human-owner');
  const update=(key,value)=>setDraft({...selected,[key]:value});
  async function save(event){event.preventDefault();if(!owner)return;try{
    await command('configure-shadow-policy',{policy:{...selected,maxDurationSeconds:Number(selected.maxDurationSeconds)},reason:reason.trim()});
    setDraft(null);setReason('');
  }catch{}}
  return <section className="pfg-company-section"><div className="pfg-company-head"><div><h2>Pack review policy</h2><p className="pfg-company-muted">{policy.enabled?'Enabled for this company':'Disabled for this company'} · This setting governs Pack Graphs with the legacy `shadow` review declaration. Their reviews use fresh Sub-Agent sessions; changes apply to new reviews.</p></div></div>
    {owner?<form className="pfg-company-form" onSubmit={save}>
      <label><span><input type="checkbox" checked={Boolean(selected.enabled)} onChange={e=>update('enabled',e.target.checked)}/> Enable Sub-Agent reviews</span></label>
      <div className="pfg-company-fieldrow"><label><span><input type="checkbox" checked={Boolean(selected.allowSameAgent)} onChange={e=>update('allowSameAgent',e.target.checked)}/> Allow same Agent in a separate execution</span></label><label><span><input type="checkbox" checked={Boolean(selected.allowAgentTrigger)} onChange={e=>update('allowAgentTrigger',e.target.checked)}/> Allow Agent requests</span></label></div>
      <label><span><input type="checkbox" checked={Boolean(selected.allowGraphTrigger)} onChange={e=>update('allowGraphTrigger',e.target.checked)}/> Allow Graph triggered reviews before dispatch</span></label>
      <Field label="Maximum duration (seconds, up to 900)"><input type="number" min="1" max="900" step="1" required value={selected.maxDurationSeconds} onChange={e=>update('maxDurationSeconds',e.target.value)}/></Field>
      <fieldset><legend>Allowed local adapters</legend>{shadowAdapters.map(([id,label])=><label key={id}><span><input type="checkbox" checked={array(selected.allowedAdapterTypes).includes(id)} onChange={e=>update('allowedAdapterTypes',e.target.checked?[...array(selected.allowedAdapterTypes),id]:array(selected.allowedAdapterTypes).filter(value=>value!==id))}/> {label}</span></label>)}</fieldset>
      <Field label="Reason for this policy"><input value={reason} onChange={e=>setReason(e.target.value)} required/></Field>
      <button className="pfg-primary" disabled={busy||!reason.trim()||!array(selected.allowedAdapterTypes).length}>Save review policy</button>
    </form>:<p className="pfg-company-muted">A human owner can change this policy. Same Agent: {policy.allowSameAgent?'allowed':'off'} · Agent requests: {policy.allowAgentTrigger?'allowed':'off'} · Graph triggers: {policy.allowGraphTrigger?'allowed':'off'} · Maximum: {policy.maxDurationSeconds} seconds · Adapters: {array(policy.allowedAdapterTypes).map(name).join(', ')||'none'}.</p>}
  </section>;
}

function ShadowRecord({ shadow, launch, command, busy, navigation, owner }) {
  const [stopReason,setStopReason]=useState('');
  const status=launch?.status==='needs-repair'?'Needs repair':shadow?.status==='closed'?'Closed':shadow?.stopRequestedAt?'Stop requested':name(shadow?.status??launch?.status??'unknown');
  const shadowId=shadow?.id??launch?.shadowId;
  const deadline=shadow?.scope?.deadlineAt??launch?.deadlineAt;
  const executionId=shadow?.executionId??launch?.executionId;
  const nativeRunUrl=launch?.nativeRunUrl??launch?.runUrl??shadow?.nativeRunUrl??shadow?.runUrl;
  const canStop=owner&&shadowId&&['active','reserved'].includes(shadow?.status)&&!shadow?.stopRequestedAt;
  async function stop(){try{await command('stop-shadow',{shadowId,reason:stopReason.trim()});setStopReason('');}catch{}}
  return <li><strong>{name(shadow?.role??'Sub-Agent review')}</strong> · <span className="pfg-company-status">{status}</span> · Sub-Agent (fresh task session)
    <div className="pfg-company-shadow-tree">Parent: {(shadow?.parentRunId??launch?.parentRunId) ? <a {...navigation.linkProps(`/graph-runs?runId=${encodeURIComponent(shadow?.parentRunId??launch?.parentRunId)}`)}>{name(shadow?.parentTaskId??launch?.parentTaskId??'task')}</a> : name(shadow?.parentTaskId??launch?.parentTaskId??'unknown')}<br/>
      Session: {shadow?.sessionId??launch?.sessionId??'Awaiting session'}<br/>
      Native execution: {executionId ? nativeRunUrl?<a {...navigation.linkProps(nativeRunUrl)}>Open run</a>:executionId : 'Awaiting execution'}<br/>
      Deadline: {deadline?new Date(deadline).toLocaleString():'Not recorded'}<br/>
      Result: {shadow?.reviewResult?.status??shadow?.outcome??launch?.outcome??'Awaiting result'}
    </div>
    {canStop&&<div className="pfg-company-inline"><Field label="Reason to stop"><input value={stopReason} onChange={e=>setStopReason(e.target.value)} required/></Field><button type="button" disabled={busy||!stopReason.trim()} onClick={stop}>Request stop</button></div>}
    <Evidence value={{shadow,launch}}/>
  </li>;
}

function Activity({ control, data, command, busy, companyId, navigation }) {
  const [runId,setRunId]=useState(''),[body,setBody]=useState(''),[nodeId,setNodeId]=useState('');
  const details=useGraphData(companyId,undefined,runId||undefined);
  const selectedRun=details.data?.run?.id===runId?details.data.run:null;
  async function intervene(){try{await command(selectedRun?.takeover?'resolve-takeover':'take-over',{runId,nodeId,takeoverId:selectedRun?.takeover?.id,outcome:'resume',reason:body});details.refresh();}catch{}}
  const run=array(data.runs).find(item=>item.id===runId);
  async function submit(event){event.preventDefault();try{await command('append-feedback',{projectId:run?.input?.projectId??run?.projectId,subjectId:runId,runId,body,reason:'Company owner added execution feedback'});setBody('');}catch{}}
  const shadows=array(control.shadows),launches=array(data.shadowLaunches);
  const records=shadows.map(shadow=>({shadow,launch:launches.find(launch=>launch.shadowId===shadow.id||launch.sessionId&&launch.sessionId===shadow.sessionId)}));
  records.push(...launches.filter(launch=>!records.some(record=>record.launch===launch)).map(launch=>({shadow:null,launch})));
  const owner=data.viewer?.kind==='human'&&array(data.viewer?.roles).includes('human-owner');
  return <><TemporaryAgentPolicy control={control} data={data} command={command} busy={busy}/><ShadowPolicy control={control} data={data} command={command} busy={busy}/><div className="pfg-company-split"><div><section className="pfg-company-section"><h2>Sub-Agent reviews</h2><p className="pfg-company-muted">These existing review records used fresh, independent task sessions. They did not inherit the parent session, so they are Sub-Agent reviews. A stop request prevents acceptance. The session closes after the native run ends; running work may continue until its adapter timeout. A deadline or stop request is not a confirmed cancellation.</p>{records.length?<ul className="pfg-company-list">{records.map(({shadow,launch})=><ShadowRecord key={shadow?.id??launch?.requestKey} shadow={shadow} launch={launch} command={command} busy={busy} navigation={navigation} owner={owner}/>)}</ul>:<Empty>No Sub-Agent reviews have been created.</Empty>}</section><section className="pfg-company-section"><h2>Feedback history</h2>{array(control.feedback).length?<ul className="pfg-company-list">{array(control.feedback).map(item=><li key={item.id}>{item.body}<Evidence value={item}/></li>)}</ul>:<Empty>Feedback and human intervention are retained here.</Empty>}</section></div><form className="pfg-company-form" onSubmit={submit}><h3>Add feedback or take over</h3><Field label="Run"><select value={runId} onChange={e=>setRunId(e.target.value)} required><option value="">Choose run</option>{array(data.runs).map(item=><option key={item.id} value={item.id}>{name(item.graphId??item.graph?.id)} · {name(item.status)}</option>)}</select></Field><Field label="Feedback / reason"><textarea value={body} onChange={e=>setBody(e.target.value)} required/></Field><button className="pfg-primary" disabled={busy||!runId}>Record feedback</button>{selectedRun&&!selectedRun.takeover&&<Field label="Step to take over"><select value={nodeId} onChange={e=>setNodeId(e.target.value)}><option value="">Choose step</option>{selectedRun.graph.nodes.map(node=><option key={node.id} value={node.id}>{name(node.id)}</option>)}</select></Field>}<button type="button" disabled={busy||!selectedRun||!body||(!selectedRun.takeover&&!nodeId)} onClick={intervene}>{selectedRun?.takeover?'Resume after takeover':'Pause for human takeover'}</button><p className="pfg-company-muted">Taking over is an explicit intervention. Editing goals alone does not change this run.</p></form></div></>;
}

function Notifications({ control, data, command, busy }) {
  const subjectId=data.viewer?.id??data.viewer?.userId;
  const preferences=array(control.notificationPreferences).find(item=>item.subjectId===subjectId);
  const [channels,setChannels]=useState(null),[events,setEvents]=useState(null);
  const selectedChannels=channels??preferences?.channels??['in-app'],selectedEvents=events??preferences?.events??[];
  const outbox=array(control.outbox??control.notifications);
  const deliveries=array(data.channels?.deliveries);
  const deliveryLabel=item=>(item.channels??[]).map(channel=>{
    const receipt=deliveries.find(row=>row.notificationId===item.id&&row.channel===channel);
    return `${channel}: ${name(receipt?.status??'pending')}`;
  }).join(' · ');
  async function save(event){event.preventDefault();try{await command('set-notification-preferences',{subjectId,channels:selectedChannels,events:selectedEvents,reason:'Company member updated notification preferences'});}catch{}}
  return <div className="pfg-company-split"><section><h2>Progress notifications</h2><p className="pfg-company-muted">Each channel shows its recorded receipt. Simulated messages remain labelled as simulations.</p>{outbox.length?<Table headings={['Event','Channels','Delivery']}>{[...outbox].reverse().map(item=><tr key={item.id}><td>{name(item.eventKind)}<Evidence value={item.ref}/></td><td>{item.channels?.join(', ')}</td><td>{deliveryLabel(item)}</td></tr>)}</Table>:<Empty>No notifications have been queued.</Empty>}</section><form className="pfg-company-form" onSubmit={save}><h3>Notification preferences</h3>{[['in-app','In-app feed'],['paperclip','Paperclip conversation'],['email','Email'],['telegram','Telegram']].map(([id,label])=><label key={id} style={{display:'flex',alignItems:'center',gap:8}}><input type="checkbox" checked={selectedChannels.includes(id)} onChange={e=>setChannels(e.target.checked?[...selectedChannels,id]:selectedChannels.filter(item=>item!==id))}/> {label}</label>)}<Field label="Report"><select value={selectedEvents.length?'attention':'all'} onChange={e=>setEvents(e.target.value==='all'?[]:['decision.escalated','run.failed','run.completed','run.stopped','run.rework_required','outcome.reviewed','outcome-review.due'])}><option value="all">All work updates</option><option value="attention">Decisions, failures and completion</option></select></Field><button className="pfg-primary" disabled={busy||!subjectId}>Save preferences</button><Evidence value={data.channels??{}}/></form></div>;
}
