import React, { useEffect, useState } from 'react';
const list=value=>Array.isArray(value)?value:value?.items??[];
const endpoint='/api/plugins/pohlee.polyforge-graph';
const Field=({label,children})=><label className="pfg-company-field">{label}{children}</label>;
async function nativeRequest(path,body,signal){
  const response=await fetch(path,{credentials:'same-origin',signal,...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok)throw new Error(result.error??`Request failed (${response.status})`);return result;
}
export function EvidenceSettings({data,companyId,command,busy}){
  const [secrets,setSecrets]=useState([]),[providerId,setProviderId]=useState(''),[secretId,setSecretId]=useState('');
  const [projectId,setProjectId]=useState(''),[kinds,setKinds]=useState(['metric']),[reason,setReason]=useState('');
  const [receiptText,setReceiptText]=useState(''),[signature,setSignature]=useState(''),[importReason,setImportReason]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[saving,setSaving]=useState(false);
  const administrator=data.viewer?.kind==='human'&&data.viewer.roles?.includes('human-owner');
  useEffect(()=>{
    if(!administrator)return;const controller=new AbortController();
    nativeRequest(`/api/companies/${encodeURIComponent(companyId)}/secrets`,undefined,controller.signal)
      .then(value=>setSecrets(list(value))).catch(failure=>{if(failure.name!=='AbortError')setError(failure.message);});
    return ()=>controller.abort();
  },[companyId,administrator]);
  if(!administrator)return null;
  async function configure(event){
    event.preventDefault();setSaving(true);setError('');setNotice('');
    try{
      const secretRef={type:'secret_ref',secretId,version:'latest'};
      const native=await nativeRequest(`${endpoint}/config?companyId=${encodeURIComponent(companyId)}`),prior=native?.configJson??{};
      await nativeRequest(`${endpoint}/config`,{companyId,configJson:{...prior,evidence:{...prior.evidence,providers:{...prior.evidence?.providers,[providerId]:{secretRef}}}}});
      await command('configure-evidence-providers',{provider:{id:providerId,companyId,projectIds:[projectId],kinds,secretRef,maxAgeSeconds:7*86400},reason});
      setNotice('Evidence source saved. Its signed receipts can now be verified for this project.');
    }catch(failure){setError(failure.message);}finally{setSaving(false);}
  }
  async function importReceipt(event){
    event.preventDefault();setSaving(true);setError('');setNotice('');
    try{
      const receipt=JSON.parse(receiptText);
      if(receipt.companyId!==companyId)throw new Error('This receipt belongs to a different company.');
      await command('import-evidence',{projectId:receipt.projectId,receipt,signature:signature.trim(),reason:importReason});
      setNotice('Receipt verified and recorded. It is available in outcome reviews and eligible handoffs.');
    }catch(failure){setError(failure.message);}finally{setSaving(false);}
  }
  return <section className="pfg-company-section"><h2>Evidence sources</h2><p className="pfg-company-muted">Connect the sources that report measurements or release events. Receipts must be signed by a configured source; unsupported or missing measurements remain unknown.</p>
    {error&&<p className="pfg-company-notice" role="alert">{error}</p>}{notice&&<p className="pfg-company-notice" role="status">{notice}</p>}
    <ul className="pfg-company-list">{list(data.evidenceProviders).map(provider=><li key={provider.id}><strong>{provider.id}</strong> · {provider.kinds.join(', ')}<br/>{provider.projectIds?.map(id=>list(data.nativeProjects).find(project=>project.id===id)?.name??id).join(', ')||'All company projects'}</li>)}</ul>
    <div className="pfg-company-split"><form className="pfg-company-form" onSubmit={configure}><h3>Add or update a source</h3>
      <Field label="Source ID"><input required pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,63}" value={providerId} onChange={e=>setProviderId(e.target.value)} placeholder="subscription-analytics"/></Field>
      <Field label="Project"><select required value={projectId} onChange={e=>setProjectId(e.target.value)}><option value="">Choose project</option>{list(data.nativeProjects).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></Field>
      <Field label="Stored signing secret"><select required value={secretId} onChange={e=>setSecretId(e.target.value)}><option value="">Choose a Paperclip secret</option>{secrets.filter(item=>item.status!=='deleted').map(secret=><option key={secret.id} value={secret.id}>{secret.name??secret.key}</option>)}</select></Field>
      <p className="pfg-company-muted">Create the shared signing secret in Paperclip first. Binding it to this plugin requires instance administrator access. Receipts are accepted for seven days.</p>
      {['metric','release'].map(kind=><label key={kind}><span><input type="checkbox" checked={kinds.includes(kind)} onChange={e=>setKinds(e.target.checked?[...kinds,kind]:kinds.filter(item=>item!==kind))}/> {kind==='metric'?'Outcome measurements':'Release events'}</span></label>)}
      <Field label="Reason"><input required value={reason} onChange={e=>setReason(e.target.value)}/></Field><button className="pfg-primary" disabled={busy||saving||!kinds.length}>Save evidence source</button>
    </form><form className="pfg-company-form" onSubmit={importReceipt}><h3>Import a signed receipt</h3>
      <Field label="Receipt from the source (JSON)"><textarea required value={receiptText} onChange={e=>setReceiptText(e.target.value)} spellCheck={false}/></Field>
      <Field label="Source signature"><input required value={signature} onChange={e=>setSignature(e.target.value)} spellCheck={false}/></Field>
      <Field label="Reason"><input required value={importReason} onChange={e=>setImportReason(e.target.value)}/></Field>
      <p className="pfg-company-muted">Import the receipt and signature supplied by your source. The plugin verifies the signature, project, time window and referenced versions before accepting it.</p>
      <button disabled={busy||saving}>Verify & import receipt</button>
    </form></div>
  </section>;
}
