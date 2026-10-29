import React, { useEffect, useState } from 'react';

const rows = value => Array.isArray(value) ? value : value?.items ?? [];
const endpoint = '/api/plugins/pohlee.polyforge-graph';
async function request(path, body, signal) {
  const response = await fetch(path, { credentials: 'same-origin', signal,
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}
const Field = ({ label, children }) => <label className="pfg-company-field">{label}{children}</label>;

export function ChannelSettings({ companyId, data }) {
  const [config,setConfig]=useState(null),[issues,setIssues]=useState([]),[secrets,setSecrets]=useState([]);
  const [projectId,setProjectId]=useState(''),[issueId,setIssueId]=useState(''),[assigneeId,setAssigneeId]=useState('');
  const [chatId,setChatId]=useState(''),[telegramUserId,setTelegramUserId]=useState(''),[secretId,setSecretId]=useState('');
  const [email,setEmail]=useState(''),[mode,setMode]=useState('disabled'),[reason,setReason]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const administrator=data.viewer?.kind==='human'&&data.viewer.roles?.includes('human-owner');
  const subjectId=data.viewer?.id;
  useEffect(()=>{
    if(!administrator)return;
    const controller=new AbortController();
    setConfig(null);setError('');
    Promise.all([
      request(`${endpoint}/api/channels?companyId=${encodeURIComponent(companyId)}`,undefined,controller.signal),
      request(`/api/companies/${encodeURIComponent(companyId)}/issues?limit=100`,undefined,controller.signal),
      request(`/api/companies/${encodeURIComponent(companyId)}/secrets`,undefined,controller.signal),
    ]).then(([settings,tasks,availableSecrets])=>{
      setConfig(settings);setMode(settings.outboundMode??'disabled');setIssues(rows(tasks));setSecrets(rows(availableSecrets));
    }).catch(failure=>{if(failure.name!=='AbortError')setError(failure.message);});
    return ()=>controller.abort();
  },[companyId,administrator]);
  if(!administrator)return null;
  const telegramRequested=Boolean(chatId||telegramUserId||secretId);
  const bindings=Object.entries(data.config?.roleBindings??{}).filter(([role])=>role.includes(':')||role==='ceo');
  async function save(event) {
    event.preventDefault();setBusy(true);setError('');setNotice('');
    try {
      if(!config)throw new Error('Channel settings have not loaded.');
      if(!projectId)throw new Error('Choose a project for incoming work.');
      if(!issueId&&!telegramRequested)throw new Error('Choose a Paperclip conversation or add a Telegram sender.');
      if(telegramRequested&&(!chatId||!telegramUserId||!secretId))throw new Error('Telegram requires a chat, sender and stored webhook secret.');
      const secretRef=secretId?{type:'secret_ref',secretId,version:'latest'}:undefined;
      // Native configuration binds the secret and company scope for background
      // jobs; this never copies a secret value into plugin configuration.
      const native=await request(`${endpoint}/config?companyId=${encodeURIComponent(companyId)}`);
      const configJson={...(native?.configJson??{})};
      if(secretRef)configJson.telegram={...configJson.telegram,webhookSecretRef:secretRef};
      await request(`${endpoint}/config`,{companyId,configJson});
      const next={...config,outboundMode:mode};
      if(issueId)next.paperclip={...config.paperclip,bindings:[
        ...rows(config.paperclip?.bindings).filter(item=>item.issueId!==issueId),
        {issueId,projectId,assigneeId:assigneeId||null,enabled:true},
      ]};
      if(telegramRequested)next.telegram={...config.telegram,webhookSecretRef:secretRef,bindings:[
        ...rows(config.telegram?.bindings).filter(item=>!(String(item.chatId)===chatId&&String(item.telegramUserId)===telegramUserId)),
        {chatId,telegramUserId,userId:subjectId,projectId,assigneeId:assigneeId||null,enabled:true},
      ]};
      const newRecipients=[...(issueId?[{subjectId,channel:'paperclip',issueId}]:[]),
        ...(chatId?[{subjectId,channel:'telegram',chatId}]:[]),...(email?[{subjectId,channel:'email',email}]:[])];
      next.recipients=[...rows(config.recipients).filter(item=>!newRecipients.some(recipient=>recipient.subjectId===item.subjectId&&recipient.channel===item.channel)),...newRecipients];
      const saved=await request(`${endpoint}/api/channels`,{companyId,settings:next,reason,idempotencyKey:crypto.randomUUID()});
      setConfig(saved);setNotice('Channel bindings saved. External notifications use the delivery mode shown below.');setReason('');
    }catch(failure){setError(failure.message);}finally{setBusy(false);}
  }
  return <section className="pfg-company-section"><h2>Channel connections</h2>
    <p className="pfg-company-muted">Link a Paperclip conversation or your Telegram identity to a project and recipient. A stored secret is required for Telegram. Native secret binding requires instance administrator access.</p>
    {error&&<p className="pfg-company-notice" role="alert">{error}</p>}{notice&&<p className="pfg-company-notice" role="status">{notice}</p>}
    <div className="pfg-company-split"><div><h3>Configured intake</h3>
      {!config?<p>Loading channel settings…</p>:<>
        <ul className="pfg-company-list">{rows(config.paperclip?.bindings).map(item=><li key={item.issueId}><strong>Paperclip</strong> · {issues.find(issue=>issue.id===item.issueId)?.title??item.issueId}<br/>{item.enabled===false?'Disabled':'Enabled'}</li>)}
          {rows(config.telegram?.bindings).map(item=><li key={`${item.chatId}:${item.telegramUserId}`}><strong>Telegram</strong> · {item.chatId}<br/>Sender {item.telegramUserId} · {item.enabled===false?'Disabled':'Enabled'}</li>)}</ul>
        {!rows(config.paperclip?.bindings).length&&!rows(config.telegram?.bindings).length&&<p>No conversations connected yet.</p>}
        <p className="pfg-company-muted">External delivery: <strong>{config.outboundMode==='simulate'?'Simulation only':'Disabled'}</strong>. Real email and Telegram delivery are unavailable in this build. Paperclip notifications are posted to the configured conversation.</p>
      </>}
      <h3>Delivery receipts</h3><ul className="pfg-company-list">{rows(data.channels?.deliveries).slice(0,12).map(item=><li key={item.id??`${item.notificationId}:${item.channel}`}><strong>{item.channel}</strong> · {item.status}<br/>{item.error??item.receipt?.status??''}</li>)}</ul>
    </div><form className="pfg-company-form" onSubmit={save}><h3>Add or update a connection</h3>
      <Field label="Project"><select required value={projectId} onChange={e=>{setProjectId(e.target.value);setIssueId('');}}><option value="">Choose project</option>{rows(data.nativeProjects).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      <Field label="Paperclip conversation"><select value={issueId} onChange={e=>setIssueId(e.target.value)}><option value="">No Paperclip connection</option>{issues.filter(item=>item.projectId===projectId).map(item=><option key={item.id} value={item.id}>{item.identifier??''} {item.title}</option>)}</select></Field>
      <Field label="Requests go to"><select value={assigneeId} onChange={e=>setAssigneeId(e.target.value)}><option value="">CEO for delegation</option>{bindings.map(([role,id])=><option key={role} value={id}>{role.replaceAll(':',' · ').replaceAll('-',' ')}</option>)}</select></Field>
      <details><summary>Telegram connection</summary><div className="pfg-company-form">
        <Field label="Telegram chat ID"><input value={chatId} onChange={e=>setChatId(e.target.value)}/></Field>
        <Field label="Your Telegram user ID"><input value={telegramUserId} onChange={e=>setTelegramUserId(e.target.value)}/></Field>
        <Field label="Stored webhook secret"><select value={secretId} onChange={e=>setSecretId(e.target.value)}><option value="">Choose an existing Paperclip secret</option>{secrets.filter(item=>item.status!=='deleted').map(item=><option key={item.id} value={item.id}>{item.name??item.key}</option>)}</select></Field>
      </div></details>
      <Field label="Email recipient for simulation (optional)"><input type="email" value={email} onChange={e=>setEmail(e.target.value)}/></Field>
      <Field label="External notification mode"><select value={mode} onChange={e=>setMode(e.target.value)}><option value="disabled">Disabled</option><option value="simulate">Simulate delivery locally</option></select></Field>
      <Field label="Reason"><input required value={reason} onChange={e=>setReason(e.target.value)}/></Field>
      <button className="pfg-primary" disabled={busy||!config}>{busy?'Saving…':'Save channel connections'}</button>
    </form></div>
  </section>;
}
