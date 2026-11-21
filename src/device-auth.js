// Verified WhatsApp registration for the SMS Bridge. Never place instance keys in the APK.
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const enc = new TextEncoder();
const dbFor = env => env.SMS_DB || env.DB;
const digits = value => String(value || '').replace(/[^0-9]/g, '');
const parseSender = value => {
  let s = digits(value);
  if(s.startsWith('9720')) s='972'+s.slice(4);
  else if(s.startsWith('0')) s='972'+s.slice(1);
  return /^972[0-9]{8,10}$/.test(s) ? s : '';
};
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
async function sha(value) {return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))))}
async function codeHash(env, deviceId, sender, code) {
  if(!env.DEVICE_OTP_PEPPER || String(env.DEVICE_OTP_PEPPER).length<24) throw new Error('Missing DEVICE_OTP_PEPPER');
  const k=await crypto.subtle.importKey('raw',enc.encode(env.DEVICE_OTP_PEPPER),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC',k,enc.encode([deviceId,sender,code].join('|')))));
}
export function allowedGroups(env) {
  return String(env.AUTH_GROUP_IDS||'').split(/[;,\s]+/).map(v=>v.trim()).filter(v=>/^[0-9-]{7,64}@g\.us$/.test(v));
}
function greenConfig(env) {
  const apiToken=String(env.GREEN_API_INSTANCE_TOKEN||env.GREEN_API_TOKEN||'');
  if(!/^[0-9]{3,20}$/.test(String(env.GREEN_API_INSTANCE_ID||'')) || !/^[a-zA-Z0-9_-]{12,256}$/.test(apiToken)) throw new Error('Green API instance credentials missing');
  const base=String(env.GREEN_API_BASE_URL||'https://api.greenapi.com').replace(/\/$/,'');
  if(!/^https:\/\/((?:[0-9]+\.)?api\.greenapi\.com|api\.green-api\.com)$/.test(base)) throw new Error('Green API host not allowed');
  return {base:`${base}/waInstance${env.GREEN_API_INSTANCE_ID}`,apiToken};
}
async function greenCall(env, action, payload) {
  const {base,apiToken}=greenConfig(env);
  const url=`${base}/${action}/${apiToken}`;
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
  if(!response.ok) throw new Error(`GREEN-API ${action} HTTP ${response.status}`);
  return await response.json();
}
function participantNumber(p) {
  // Green API sometimes exposes WhatsApp LIDs instead of phone numbers.
  // Only phoneNumber and @c.us identifiers are acceptable proof of membership.
  for(const v of [p?.phoneNumber,p?.id]) {
    if(typeof v==='string' && /^\d{9,15}@c\.us$/.test(v)) return digits(v);
  }
  return '';
}
export async function isMember(env, sender) {
  const groups=allowedGroups(env);
  if(!groups.length) throw new Error('AUTH_GROUP_IDS is empty');
  let failedLookups=0;
  for(const groupId of groups) {
    try {
      const data=await greenCall(env,'getGroupData',{groupId});
      if(data?.groupId!==groupId || !Array.isArray(data?.participants)) throw new Error('Invalid getGroupData response');
      if(data.participants.some(p=>participantNumber(p)===sender)) return true;
    } catch(error) {
      failedLookups++;
      console.error('GROUP MEMBERSHIP LOOKUP FAILED', groupId, String(error));
    }
  }
  if(failedLookups) throw new Error('One or more group lookups failed');
  return false;
}
async function limit(db, key, max, now, windowMs) {
  await db.prepare(`INSERT INTO device_auth_limits(key,window_at,count) VALUES(?,?,1)
   ON CONFLICT(key) DO UPDATE SET
   count=CASE WHEN window_at<? THEN 1 ELSE count+1 END,
   window_at=CASE WHEN window_at<? THEN excluded.window_at ELSE window_at END`)
    .bind(key,now,now-windowMs,now-windowMs).run();
  const row=await db.prepare('SELECT count FROM device_auth_limits WHERE key=?').bind(key).first();
  return Number(row?.count||0)<=max;
}
const randomToken = bytes => hex(crypto.getRandomValues(new Uint8Array(bytes)));
function code8() {const a=crypto.getRandomValues(new Uint32Array(1));return String(a[0]%100000000).padStart(8,'0')}

export async function registerVerifiedDevice(request,env) {
  const db=dbFor(env);
  let data; try{data=await request.json()}catch{return json({error:'Invalid JSON'},400)}
  const sender=parseSender(data?.sender);
  if(!sender) return json({error:'Invalid sender'},400);
  if(!env.GREEN_API_WEBHOOK_TOKEN || String(env.DEVICE_OTP_PEPPER||'').length<24) return json({error:'Verification not configured'},503);
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';
  const now=Date.now();
  if(!(await limit(db,`ip:${await sha(ip)}`,5,now,3600000)) ||
     !(await limit(db,`phone:${await sha(sender)}`,3,now,3600000))) return json({error:'Too many requests; try later'},429);
  let member=false;
  try {member=await isMember(env,sender)}catch(e){console.error('VERIFICATION GROUP LOOKUP FAILED',String(e));return json({error:'Verification temporarily unavailable'},503)}
  if(!member) return json({error:'Registration not permitted'},403);
  const id=crypto.randomUUID(),token=randomToken(32),code=code8();
  const digest=await codeHash(env,id,sender,code);
  await db.batch([
    db.prepare('INSERT INTO devices(id,sender,token_hash,enabled,approved,revoked,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id,sender,await sha(token),1,0,0,now),
    db.prepare('INSERT INTO device_auth_challenges(device_id,sender,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,0,?)')
      .bind(id,sender,digest,now+10*60*1000,now)
  ]);
  try {
    await greenCall(env,'sendMessage',{
      chatId:`${sender}@c.us`,
      message:`בקשה חדשה לחיבור SMS Bridge. אם אתה התקנת עכשיו את האפליקציה, השב כאן בדיוק:\nאישור ${code}\n\nהקוד תקף ל-10 דקות. אם לא ביקשת חיבור — אל תשיב. האפליקציה תוכל לשלוח SMS מהסים שלך רק לאחר האישור והסכמה מפורשת.`
    });
  } catch(e) {
    await db.prepare('UPDATE devices SET revoked=1 WHERE id=?').bind(id).run();
    console.error('VERIFY WHATSAPP SEND FAILED',String(e));
    return json({error:'Unable to send verification code'},503);
  }
  return json({token,sender,approval:'pending',message:'Reply to the private WhatsApp verification code'});
}

export async function verifyWhatsAppReply(webhook,env) {
  // Only private, incoming WhatsApp messages; never trust outgoing or group data.
  if(webhook?.typeWebhook!=='incomingMessageReceived') return false;
  const sender=parseSender(webhook?.senderData?.sender);
  const chatId=String(webhook?.senderData?.chatId||'');
  if(!sender || chatId!==`${sender}@c.us`) return false;
  const text=String(webhook?.messageData?.textMessageData?.textMessage || webhook?.messageData?.extendedTextMessageData?.text || '').trim();
  const match=text.match(/^אישור\s+([0-9]{8})$/u);
  if(!match) return false;
  const db=dbFor(env),now=Date.now();
  // Guard against webhook retries: once consumed, no second approval occurs.
  const challenges=(await db.prepare(`SELECT device_id,code_hash,attempts FROM device_auth_challenges
    WHERE sender=? AND expires_at>? AND attempts<5 ORDER BY created_at DESC LIMIT 3`).bind(sender,now).all()).results||[];
  for(const c of challenges) {
    if(await codeHash(env,c.device_id,sender,match[1])!==c.code_hash) continue;
    try {
      if(!(await isMember(env,sender))) return true;
    }catch(e){console.error('VERIFY MEMBERSHIP RETRY REQUIRED',String(e));return true}
    // Only the same pending device receives approval. Never approve by sender alone.
    await db.batch([
      db.prepare('UPDATE devices SET approved=1,revoked=0 WHERE id=? AND sender=? AND approved=0 AND revoked=0').bind(c.device_id,sender),
      db.prepare('DELETE FROM device_auth_challenges WHERE device_id=?').bind(c.device_id)
    ]);
    console.log('DEVICE VERIFIED',JSON.stringify({deviceId:c.device_id}));
    return true;
  }
  // Limit guessing even when the sender controls WhatsApp; count only the newest challenge.
  if(challenges.length) await db.prepare('UPDATE device_auth_challenges SET attempts=attempts+1 WHERE device_id=?').bind(challenges[0].device_id).run();
  return true;
}

export async function revokeDevice(request,env,device) {
  const db=dbFor(env);
  await db.prepare('UPDATE devices SET approved=0,revoked=1,enabled=0 WHERE id=?').bind(device.id).run();
  return json({ok:true,status:'revoked'});
}

// Optional daily membership reconciliation. Leave off until verification is tested.
// A temporary GREEN-API failure never revokes a device; confirmed removal does.
export async function auditMembership(env) {
  if (env.ENABLE_MEMBERSHIP_AUDIT !== 'true') return;
  const db=dbFor(env), now=Date.now();
  const rows=(await db.prepare(`SELECT id,sender FROM devices
    WHERE approved=1 AND revoked=0 AND last_group_checked_at<?
    ORDER BY last_group_checked_at ASC LIMIT 5`).bind(now-24*60*60*1000).all()).results||[];
  for(const row of rows) {
    try {
      const member=await isMember(env,row.sender);
      await db.prepare('UPDATE devices SET approved=?,revoked=?,last_group_checked_at=? WHERE id=? AND revoked=0')
        .bind(member?1:0,member?0:1,now,row.id).run();
      if(!member) console.warn('DEVICE GROUP MEMBERSHIP REVOKED',row.id);
    } catch(e) {
      console.error('MEMBERSHIP AUDIT RETRY LATER',String(e));
      // Prevent an outage from causing API hammering every minute.
      await db.prepare('UPDATE devices SET last_group_checked_at=? WHERE id=? AND revoked=0')
        .bind(now-23*60*60*1000,row.id).run();
    }
  }
}
