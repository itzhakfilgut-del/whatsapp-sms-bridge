// Integrated phone bridge on the existing Worker; D1 database is provided as env.DB.
import { registerVerifiedDevice, revokeDevice } from "./device-auth.js";
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const uid=()=>crypto.randomUUID();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
function bearer(request){const v=request.headers.get('Authorization')||'';return v.startsWith('Bearer ')?v.slice(7):''}
async function authorized(request,env){let t=bearer(request);if(!t) return null;let h=await hash(t);return await env.DB.prepare('SELECT id,sender,enabled,approved,revoked,fcm_token FROM devices WHERE token_hash=?').bind(h).first()}
const isAdmin=(request,env)=>env.ADMIN_TOKEN && bearer(request)===env.ADMIN_TOKEN;
async function body(request){try{return await request.json()}catch{return null}}
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/health')return json({ok:true,service:'sms-bridge'});
 if(!env.DB)return json({error:'missing DB'},503);
 try{
  // Existing registration semantics preserved.
  if(path==='/device/register' && request.method==='POST'){
   return registerVerifiedDevice(request,env);
  }
  if(path==='/admin/job' && request.method==='POST'){
   if(!isAdmin(request,env))return json({error:'unauthorized'},401);
   let d=await body(request);let sender=String(d?.sender||'').trim(),phone=String(d?.phone||''),text=String(d?.text||'');
   if(!/^\+?[0-9]{9,15}$/.test(phone)||!text||text.length>800)return json({error:'invalid recipient/message'},400);
   let device=await env.DB.prepare('SELECT id,fcm_token FROM devices WHERE sender=? AND enabled=1 AND approved=1 AND revoked=0 ORDER BY created_at DESC LIMIT 1').bind(sender).first();
   if(!device)return json({error:'no active device; job not created'},409);
   let id=uid();await env.DB.prepare("INSERT INTO jobs(id,device_id,phone,text,status,created_at) VALUES(?,?,?,?, 'PENDING', ?)").bind(id,device.id,phone,text,Date.now()).run();
   let pushed=false;
   if(device.fcm_token){try{await push(env,device.fcm_token);pushed=true}catch(e){console.error('FCM failed',String(e))}}
   return json({id,status:'PENDING',pushRequested:pushed});
  }
  if(path==='/admin/jobs' && request.method==='GET'){
   if(!isAdmin(request,env))return json({error:'unauthorized'},401);
   let r=await env.DB.prepare('SELECT id,status,created_at,claimed_at,completed_at FROM jobs ORDER BY created_at DESC LIMIT 100').all();return json({jobs:r.results});
  }
  let device=await authorized(request,env);if(!device)return json({error:'unauthorized'},401);
  if(path==='/device/status' && request.method==='GET'){
   return json({status:device.revoked?'revoked':device.approved?'approved':'pending',approved:device.approved===1,enabled:device.enabled===1});
  }
  if(path==='/device/revoke' && request.method==='POST') return revokeDevice(request,env,device);
  if(path==='/device/heartbeat' && request.method==='POST'){
   if(device.revoked) return json({error:'device revoked'},403);
   let d=await body(request);let fcm=String(d?.fcmToken||'').slice(0,4096);let enabled=d?.enabled===true?1:0;
   await env.DB.prepare('UPDATE devices SET fcm_token=?,enabled=?,last_seen_at=? WHERE id=?').bind(fcm,enabled,Date.now(),device.id).run();
   console.log('PHONE HEARTBEAT',JSON.stringify({sender:device.sender,enabled,hasFcm:Boolean(fcm)}));
   return json({ok:true});
  }
  // Unapproved devices may report diagnostics but may never see or claim SMS jobs.
  if(device.revoked) return json({error:'device revoked'},403);
  if(path!=='/device/diagnostic' && (!device.approved || !device.enabled)) {
   return json({error:'device not approved or disabled'},403);
  }
  // Debug events: no tokens, phone destinations or message bodies are recorded.
  if(path==='/device/diagnostic' && request.method==='POST'){
   const d=await body(request)||{};
   const stage=String(d.stage||'UNKNOWN').slice(0,40);
   const result=String(d.result||'UNKNOWN').slice(0,24);
   const detail=String(d.detail||'').slice(0,220);
   const seen=Math.max(0,Math.min(100,Number(d.seen)||0));
   const claimed=Math.max(0,Math.min(100,Number(d.claimed)||0));
   const dispatched=Math.max(0,Math.min(100,Number(d.dispatched)||0));
   const reportedAt=Date.now();
   await env.DB.prepare('INSERT INTO device_diagnostics(device_id,reported_at,stage,result,detail,seen,claimed,dispatched) VALUES(?,?,?,?,?,?,?,?)')
     .bind(device.id,reportedAt,stage,result,detail,seen,claimed,dispatched).run();
   console.log('PHONE DIAGNOSTIC',JSON.stringify({sender:device.sender,stage,result,detail,seen,claimed,dispatched}));
   return json({ok:true});
  }
  if(path==='/device/jobs' && request.method==='GET'){
   // Safety: never suddenly send days-old SMS after a phone reconnects.
   // Older PENDING entries remain in D1 for manual review.
   const cutoff=Date.now()-24*60*60*1000;
   let r=await env.DB.prepare("SELECT id,phone,text FROM jobs WHERE device_id=? AND status='PENDING' AND created_at>=? ORDER BY created_at LIMIT 10")
     .bind(device.id,cutoff).all();
   console.log('PHONE JOBS FETCH',JSON.stringify({sender:device.sender,count:(r.results||[]).length}));
   return json({jobs:r.results});
  }
  if(path==='/device/claim' && request.method==='POST'){
   let d=await body(request);let r=await env.DB.prepare("UPDATE jobs SET status='CLAIMED',claimed_at=? WHERE id=? AND device_id=? AND status='PENDING'").bind(Date.now(),d?.id,device.id).run();
   console.log('PHONE JOB CLAIM',JSON.stringify({sender:device.sender,claimed:r.meta.changes===1}));
   return json({claimed:r.meta.changes===1});
  }
  if(path==='/device/dispatched' && request.method==='POST'){
   let d=await body(request);await env.DB.prepare("UPDATE jobs SET status='DISPATCHED' WHERE id=? AND device_id=? AND status='CLAIMED'").bind(d?.id,device.id).run();return json({ok:true});
  }
  if(path==='/device/result' && request.method==='POST'){
   let d=await body(request);
   if(d?.status!=='UNKNOWN')return json({error:'unsupported result'},400);
   await env.DB.prepare("UPDATE jobs SET status='UNKNOWN', completed_at=? WHERE id=? AND device_id=? AND status IN ('CLAIMED','DISPATCHED')").bind(Date.now(),d.id,device.id).run();return json({ok:true});
  }
  if(path==='/device/part-result' && request.method==='POST'){
   let d=await body(request);let part=Number(d?.part),total=Number(d?.total),status=d?.status;
   if(!Number.isInteger(part)||!Number.isInteger(total)||part<0||total<1||total>20||part>=total||!['MODEM_ACCEPTED','FAILED_UNCERTAIN'].includes(status))return json({error:'invalid part'},400);
   let row=await env.DB.prepare('SELECT id,status FROM jobs WHERE id=? AND device_id=?').bind(d.id,device.id).first();
   if(!row || !['CLAIMED','DISPATCHED','UNKNOWN','MODEM_ACCEPTED','FAILED_UNCERTAIN'].includes(row.status))return json({error:'job not found'},404);
   await env.DB.prepare('INSERT INTO job_parts(job_id,part,status) VALUES(?,?,?) ON CONFLICT(job_id,part) DO UPDATE SET status=excluded.status').bind(d.id,part,status).run();
   let result=await env.DB.prepare('SELECT COUNT(*) AS count, SUM(CASE WHEN status=? THEN 1 ELSE 0 END) AS errors FROM job_parts WHERE job_id=?').bind('FAILED_UNCERTAIN',d.id).first();
   let finalStatus=result.errors>0?'FAILED_UNCERTAIN':result.count===total?'MODEM_ACCEPTED':'DISPATCHED';
   await env.DB.prepare('UPDATE jobs SET status=?,completed_at=? WHERE id=? AND device_id=?').bind(finalStatus,finalStatus==='DISPATCHED'?null:Date.now(),d.id,device.id).run();return json({ok:true,status:finalStatus});
  }
  return json({error:'not found'},404);
 }catch(error){console.error('BRIDGE ERROR',String(error));return json({error:'internal'},500)}
}};

function base64url(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}
async function getGoogleToken(serviceAccount){
 const pem=serviceAccount.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'');
 const binary=Uint8Array.from(atob(pem),c=>c.charCodeAt(0));
 const key=await crypto.subtle.importKey('pkcs8',binary,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
 const now=Math.floor(Date.now()/1000);
 const h=base64url(new TextEncoder().encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
 const p=base64url(new TextEncoder().encode(JSON.stringify({iss:serviceAccount.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
 const content=h+'.'+p,signature=base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(content))));
 const form=new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:content+'.'+signature});
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:form});if(!response.ok)throw Error('oauth failed');return (await response.json()).access_token;
}
async function push(env,token){
 if(!env.GOOGLE_SERVICE_ACCOUNT_JSON)throw Error('missing firebase service account');
 let sa=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);let access=await getGoogleToken(sa);
 let response=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,{method:'POST',headers:{Authorization:'Bearer '+access,'Content-Type':'application/json'},body:JSON.stringify({message:{token,data:{type:'sms_job'},android:{priority:'HIGH'}}})});
 if(!response.ok)throw Error('FCM HTTP '+response.status);
}

export async function notifyPhone(env, token) {
  if (token) await push(env, token);
}
