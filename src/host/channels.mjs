import { createHash, timingSafeEqual } from 'node:crypto';

const required = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`); return value; };
const digest = value => createHash('sha256').update(String(value)).digest();
const sameSecret = (a,b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && b.length > 0 && timingSafeEqual(digest(a),digest(b));

/** Only operator-configured identity bindings may turn a Telegram message into company intake. */
export function telegramIntake({ headers, update, secret, bindings }) {
  const header = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'x-telegram-bot-api-secret-token')?.[1];
  if (!sameSecret(header,secret)) throw new Error('Telegram webhook authentication failed');
  if (!Number.isSafeInteger(update?.update_id)) throw new Error('Telegram update ID is required');
  const message=update.message;
  if (!message || !Number.isSafeInteger(message.message_id) || !message.from?.id || message.from.is_bot || message.chat?.id === undefined) throw new Error('A Telegram message from a bound human is required');
  const matches=(bindings??[]).filter(binding=>binding.enabled!==false&&String(binding.chatId)===String(message.chat.id)&&String(binding.telegramUserId)===String(message.from.id));
  if (matches.length!==1) throw new Error('Telegram sender and chat must have exactly one authorized company binding');
  const binding=matches[0];
  for(const key of ['companyId','userId','projectId'])required(binding[key],`binding.${key}`);
  const text=required(message.text??message.caption,'Telegram request text');
  const attachments=[];
  if(message.document)attachments.push({kind:'telegram-document',fileId:message.document.file_id,fileName:message.document.file_name??null,mimeType:message.document.mime_type??null});
  if(message.photo?.length)attachments.push({kind:'telegram-photo',fileId:message.photo.at(-1).file_id});
  return {companyId:binding.companyId,userId:binding.userId,projectId:binding.projectId,assigneeId:binding.assigneeId??null,
    title:text.split('\n')[0].slice(0,180),description:text,attachments,
    source:{channel:'telegram',senderId:String(message.from.id),chatId:String(message.chat.id),messageId:String(message.message_id),updateId:String(update.update_id),replyToMessageId:message.reply_to_message?.message_id?String(message.reply_to_message.message_id):null},
    idempotencyKey:`telegram:${binding.companyId}:${update.update_id}`};
}

function providerUrl(value,{allowLoopback=false}={}) {
  const url=new URL(value);
  if(url.username||url.password||url.hash)throw new Error('Provider URL cannot contain credentials or a fragment');
  if(url.protocol!=='https:'&&!(allowLoopback&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Provider URL must use HTTPS');
  return url;
}

/** Transport only. The caller must durably claim delivery and verify the recipient before calling. */
export async function deliverNotification({channel,notification,destination,config={},resolveSecret,fetchImpl=fetch,postPaperclip,allowLoopback=false}) {
  required(notification?.id,'notification.id');required(notification?.companyId,'notification.companyId');
  if(destination?.companyId!==notification.companyId||destination?.subjectId!==notification.subjectId)throw new Error('Notification destination identity mismatch');
  const text=required(notification.text??notification.summary??notification.eventKind,'notification.text');
  if(channel==='in-app'||channel==='paperclip') {
    if(!postPaperclip||!destination.issueId)return {status:'unconfigured',channel,reason:'A Paperclip issue destination is required'};
    const result=await postPaperclip({companyId:notification.companyId,issueId:destination.issueId,body:text,idempotencyKey:`notification:${notification.id}:paperclip`});
    if(!result?.id)return {status:'unknown',channel,reason:'Paperclip did not return a comment receipt'};
    return {status:'delivered',channel,receipt:{provider:'paperclip',id:result.id}};
  }
  if(!['telegram','email'].includes(channel))throw new Error('Unsupported notification channel');
  if(!config.tokenSecretRef||!resolveSecret)return {status:'unconfigured',channel,reason:'Provider credentials are not configured'};
  const token=await resolveSecret(config.tokenSecretRef);
  if(!token)return {status:'unconfigured',channel,reason:'Provider credential reference could not be resolved'};
  let url,body,headers={'Content-Type':'application/json'};
  if(channel==='telegram') {
    if(destination.chatId===undefined)return {status:'unconfigured',channel,reason:'Telegram chat is not bound to this recipient'};
    if(!/^[\d]+:[\w-]+$/.test(token))throw new Error('Invalid Telegram credential format');
    const origin=config.apiBase??'https://api.telegram.org';
    const parsed=providerUrl(origin,{allowLoopback});
    if(parsed.hostname!=='api.telegram.org'&&!allowLoopback)throw new Error('Telegram API origin must be api.telegram.org');
    url=`${parsed.href.replace(/\/$/,'')}/bot${token}/sendMessage`;
    body={chat_id:destination.chatId,text:text.slice(0,4096),link_preview_options:{is_disabled:true}};
  } else {
    if(!config.endpoint||!destination.email)return {status:'unconfigured',channel,reason:'Email gateway or recipient is not configured'};
    url=providerUrl(config.endpoint,{allowLoopback}).href;
    headers={...headers,Authorization:`Bearer ${token}`,'Idempotency-Key':`polyforge:${notification.companyId}:${notification.id}:email`};
    body={to:destination.email,...(config.from?{from:config.from}:{}),subject:notification.title??'PolyForge work update',text,idempotencyKey:`polyforge:${notification.companyId}:${notification.id}:email`};
  }
  let response;
  try { response=await fetchImpl(url,{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)}); }
  catch { return {status:'unknown',channel,reason:'Provider response was not received; inspect provider delivery before retrying'}; }
  let result;
  try { result=await response.json(); } catch { return {status:'unknown',channel,reason:'Provider returned no readable delivery receipt'}; }
  if(!response.ok||(channel==='telegram'&&result.ok!==true))return {status:'failed',channel,reason:`Provider rejected delivery (HTTP ${response.status})`,retryAfter:result.parameters?.retry_after??null};
  const id=channel==='telegram'?result.result?.message_id:result.id??result.messageId;
  if(id===undefined||id===null)return {status:'unknown',channel,reason:'Provider accepted the request without a message receipt'};
  return {status:'delivered',channel,receipt:{provider:channel,id:String(id)}};
}
