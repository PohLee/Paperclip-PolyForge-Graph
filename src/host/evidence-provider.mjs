import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function canonicalEvidence(value) {
  return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
}

/** Authenticate an external provider's scoped observation before the host records it as evidence. */
export async function verifyEvidenceReceipt({receipt,signature,provider,companyId,projectId,resolveSecret,now=()=>new Date().toISOString()}) {
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new Error('Evidence receipt is required');
  if(!provider?.id||provider.enabled===false||receipt.providerId!==provider.id)throw new Error('Evidence provider is not configured');
  if(!['release','metric'].includes(receipt.kind)||!provider.kinds?.includes(receipt.kind))throw new Error('Evidence kind is not allowed by this provider');
  if(receipt.companyId!==companyId||receipt.projectId!==projectId)throw new Error('Evidence company/project mismatch');
  if(provider.companyId!==companyId)throw new Error('Evidence provider belongs to another company');
  if(provider.projectIds?.length&&!provider.projectIds.includes(projectId))throw new Error('Evidence provider is not authorized for this project');
  if(typeof receipt.id!=='string'||!receipt.id.trim()||!Array.isArray(receipt.subjectRefs)||!receipt.subjectRefs.length||receipt.subjectRefs.some(item=>!item.id||!item.version))throw new Error('Versioned evidence subject references are required');
  const current=Date.parse(now()),issued=Date.parse(receipt.issuedAt),expires=Date.parse(receipt.expiresAt);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>current+60000||expires<=current||expires<=issued)throw new Error('Evidence receipt is expired or has an invalid observation time');
  if(provider.maxAgeSeconds&&current-issued>provider.maxAgeSeconds*1000)throw new Error('Evidence receipt is stale for this provider');
  const payload=canonicalEvidence(receipt);
  if(Buffer.byteLength(payload)>65536)throw new Error('Evidence receipt exceeds 64 KiB');
  const secret=provider.secretRef&&await resolveSecret(provider.secretRef);
  if(typeof secret!=='string'||secret.length<16)throw new Error('Evidence provider secret is unavailable');
  const supplied=String(signature??'').replace(/^sha256:/,'');
  if(!/^[a-f\d]{64}$/i.test(supplied))throw new Error('Evidence signature is invalid');
  const expected=createHmac('sha256',secret).update(payload).digest();
  if(!timingSafeEqual(expected,Buffer.from(supplied,'hex')))throw new Error('Evidence signature verification failed');
  const details=receipt.data;
  if(!details||typeof details!=='object'||Array.isArray(details))throw new Error('Evidence data is required');
  if(receipt.kind==='metric') {
    for(const key of ['goalRevisionId','goalId','keyResultId','source','window','observedAt'])if(details[key]===undefined||details[key]===null||details[key]==='')throw new Error(`Metric evidence requires ${key}`);
    if(typeof details.value!=='number'||!Number.isFinite(details.value))throw new Error('Metric value must be finite');
    const observed=Date.parse(details.observedAt);
    if(!Number.isFinite(observed)||observed>issued||provider.maxAgeSeconds&&current-observed>provider.maxAgeSeconds*1000)throw new Error('Metric observation is invalid or stale');
  } else {
    if(!details.sourceRunId||!details.releaseEvent?.id||!details.releaseEvent?.version||!details.candidate?.id||!details.candidate?.version||!details.authorizationDecisionId)throw new Error('Release evidence needs the exact run, event, candidate and authorization');
    if(!receipt.subjectRefs.some(ref=>/^sha256:[a-f\d]{64}$/i.test(ref.digest??'')))throw new Error('Release evidence must attest a versioned release record digest');
  }
  return {...structuredClone(receipt),verification:{providerId:provider.id,method:'hmac-sha256',receiptDigest:`sha256:${createHash('sha256').update(payload).digest('hex')}`,verifiedAt:now()}};
}
