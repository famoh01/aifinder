// AIFinder V2 backend. Uses allowlisted Docker operations; uploaded code is never executed.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const app = express();
// --- V2.4 security / production basics (no extra deps) ---
const rateLimitMap = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let bucket = rateLimitMap.get(key);
  if (!bucket || now > bucket.reset) bucket = { count: 0, reset: now + windowMs };
  bucket.count++;
  rateLimitMap.set(key, bucket);
  if (rateLimitMap.size > 5000) {
    for (const [k, v] of rateLimitMap) if (now > v.reset) rateLimitMap.delete(k);
  }
  return bucket.count <= max;
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-AIFinder-Version', '2.4.0');
  next();
});
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.socket.remoteAddress || 'local';
  const heavy = req.path.includes('/chat') || req.path.includes('/research') || req.path.includes('/models/live');
  const ok = rateLimit(ip + ':' + (heavy ? 'heavy' : 'api'), heavy ? 30 : 120, 60_000);
  if (!ok) return res.status(429).json({ error: 'คำขอถี่เกินไป กรุณารอสักครู่ (rate limit)' });
  next();
});

const PORT = Number(process.env.PORT || 8080);
const DATA = path.join(__dirname,'data');
fs.mkdirSync(DATA,{recursive:true});
app.use(express.json({limit:'8mb'}));
app.use(express.static(path.join(__dirname,'public')));
const dbPath=path.join(DATA,'store.json');
function load(){try{return JSON.parse(fs.readFileSync(dbPath,'utf8'))}catch{return {projects:[],history:[],servers:[]}}}
function save(d){fs.writeFileSync(dbPath,JSON.stringify(d,null,2),{mode:0o600});}
function id(){return crypto.randomUUID();}
function requireAdmin(req,res,next){if(!process.env.ADMIN_TOKEN)return res.status(503).json({error:'Backend ยังไม่ได้ตั้ง ADMIN_TOKEN'});const supplied=Buffer.from(String(req.headers['x-admin-token']||''));const expected=Buffer.from(String(process.env.ADMIN_TOKEN));
 if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return res.status(401).json({error:'Admin token ไม่ถูกต้อง'});next();}
function providerStatus(){return [{id:'openai',name:'OpenAI',configured:!!process.env.OPENAI_API_KEY},{id:'anthropic',name:'Anthropic',configured:!!process.env.ANTHROPIC_API_KEY},{id:'google',name:'Google Gemini',configured:!!process.env.GOOGLE_API_KEY}];}
app.get('/api/health',(req,res)=>res.json({ok:true,version:'2.4.0',features:['chat','models','advisor','live-hf','products','links','compare','export','research','analyzer','servers'],rateLimit:true}));
app.get('/api/providers',(req,res)=>res.json({providers:providerStatus()}));

async function callOpenAI({model,message,system,reasoning}){
 const body={model,input:[{role:'system',content:system||'You are a helpful assistant.'},{role:'user',content:message}]};
 if(/^o[34]/.test(model))body.reasoning={effort:reasoning==='max'?'high':reasoning};
 else if(['low','medium','high'].includes(reasoning))body.reasoning_effort=reasoning;
 const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const d=await r.json();if(!r.ok)throw Error(d.error?.message||'OpenAI API error');
 return (d.output||[]).flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n')||'(โมเดลไม่ส่งข้อความกลับมา)';
}
async function callAnthropic({model,message,system,reasoning}){
 const body={model,max_tokens:4096,system:system||'You are a helpful assistant.',messages:[{role:'user',content:message}]};
 // Extended thinking is enabled only for the supported Claude 3.7 Sonnet model.
 if(model==='claude-3-7-sonnet-20250219' && ['high','max'].includes(reasoning)){body.thinking={type:'enabled',budget_tokens:4000};body.max_tokens=5000;}
 const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify(body)});
 const d=await r.json();if(!r.ok)throw Error(d.error?.message||'Anthropic API error');
 return (d.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n')||'(โมเดลไม่ส่งข้อความกลับมา)';
}
async function callGoogle({model,message,system,reasoning}){
 const key=process.env.GOOGLE_API_KEY;
 const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
 const generationConfig={};
 if(model.includes('2.5'))generationConfig.thinkingConfig={thinkingBudget:reasoning==='low'?1024:reasoning==='medium'?4096:8192};
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:system||'You are a helpful assistant.'}]},contents:[{role:'user',parts:[{text:message}]}],generationConfig})});
 const d=await r.json();if(!r.ok)throw Error(d.error?.message||'Google API error');
 return (d.candidates||[]).flatMap(c=>c.content?.parts||[]).map(p=>p.text||'').join('\n')||'(โมเดลไม่ส่งข้อความกลับมา)';
}

// ===== Model Advisor: retrieve from 50k catalog (RAG, not weight training) =====
function scoreModelForQuery(m, tokens) {
  const hay = (m.id + ' ' + m.name + ' ' + m.provider + ' ' + (m.category||'') + ' ' + (m.pipeline||'') + ' ' + (m.tags||[]).join(' ')).toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t || t.length < 2) continue;
    if (hay.includes(t)) score += 3;
    if ((m.name||'').toLowerCase().includes(t)) score += 2;
    if ((m.category||'').toLowerCase() === t) score += 4;
  }
  score += Math.log10((m.downloads || 0) + 10) * 0.4;
  score += Math.log10((m.likes || 0) + 2) * 0.3;
  if (m.openSource) score += 0.2;
  return score;
}
function retrieveModelsForTask(task, limit = 8) {
  const models = loadModels();
  const raw = String(task || '').toLowerCase();
  const tokens = raw.split(/[^a-z0-9\u0e00-\u0e7f+._-]+/i).filter(Boolean).slice(0, 24);
  const hints = [];
  if (/code|coding|โปรแกรม|โค้ด|python|javascript|bug|refactor/.test(raw)) hints.push('coding');
  if (/image|รูป|ภาพ|generate image|วาด|diffusion|flux|sdxl/.test(raw)) hints.push('image');
  if (/video|วิดีโอ|คลิป|animate/.test(raw)) hints.push('video');
  if (/audio|เสียง|speech|whisper|tts|พูด/.test(raw)) hints.push('audio');
  if (/reason|คิด|math|คณิต|logic|วิเคราะห์ลึก|r1|o1/.test(raw)) hints.push('reasoning');
  if (/chat|คุย|แชท|assistant|เขียน|สรุป|translate|แปล/.test(raw)) hints.push('chat');
  const allTokens = [...new Set([...tokens, ...hints])];
  return models
    .map(m => ({ m, score: scoreModelForQuery(m, allTokens) }))
    .filter(x => x.score > 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ m, score }) => ({
      id: m.id, name: m.name, provider: m.provider, category: m.category,
      pipeline: m.pipeline, downloads: m.downloads, likes: m.likes,
      openSource: !!m.openSource, url: m.url, score: Math.round(score * 100) / 100
    }));
}
function formatCatalogContext(models) {
  const lines = (models || []).map((m, i) =>
    `${i + 1}. ${m.id} | ${m.category || '-'} | ↓${m.downloads || 0} ♥${m.likes || 0} | ${m.openSource ? 'open' : 'closed'} | ${m.url || ''}`
  );
  const knowledge = loadKnowledge();
  const parts = [
    'You are an AI model advisor inside AIFinder. Prefer real model IDs only.',
    'Do not invent model names. If unsure, say so and suggest how to verify on Hugging Face.',
    'When recommending: pick 2-5 fits, say why, note open vs closed, and point to pipeline (transformers/diffusers) when useful.'
  ];
  if (lines.length) {
    parts.push('Catalog matches for this request:');
    parts.push(...lines);
  } else {
    parts.push('No strong catalog matches; still give principled advice without inventing model names.');
  }
  if (knowledge) {
    parts.push('--- Knowledge base (selection principles) ---');
    parts.push(knowledge.slice(0, 6000));
  }
  return parts.join('\n');
}
app.post('/api/models/advise', (req, res) => {
  try {
    const task = String(req.body?.task || req.body?.query || '').trim().slice(0, 2000);
    if (!task) return res.status(400).json({ error: 'กรุณาระบุ task หรือคำถาม' });
    const limit = Math.min(20, Math.max(3, parseInt(req.body?.limit, 10) || 8));
    const matches = retrieveModelsForTask(task, limit);
    const insights = loadCatalogInsights();
    res.json({
      task,
      count: matches.length,
      models: matches,
      catalogSummary: insights ? {
        totalModels: insights.totalModels,
        categoryCounts: insights.categoryCounts,
        topProviders: (insights.topProviders || []).slice(0, 10),
        overallTopDownloads: (insights.overallTopDownloads || []).slice(0, 8)
      } : null,
      note: 'retrieval จาก local catalog จริง ~50k + insights สรุปจากชุดเดียวกัน — ไม่ใช่การเทรนโมเดลใหม่'
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'advise failed' });
  }
});

app.post('/api/chat',async(req,res)=>{
 try{const {provider,model,message,system,reasoning='medium',useCatalog=false}=req.body||{};
 if(!['openai','anthropic','google'].includes(provider))return res.status(400).json({error:'ไม่รองรับ provider'});
 if(typeof message!=='string'||!message.trim()||message.length>20000)return res.status(400).json({error:'ข้อความว่างหรือยาวเกินกำหนด'});
 const key=provider==='openai'?process.env.OPENAI_API_KEY:provider==='anthropic'?process.env.ANTHROPIC_API_KEY:process.env.GOOGLE_API_KEY;
 if(!key)return res.status(503).json({error:`ยังไม่ได้ตั้งค่า ${provider.toUpperCase()} API Key บน Backend`});
 let sys = String(system||'').slice(0,6000);
 let catalogMatches = [];
 if(useCatalog){
   catalogMatches = retrieveModelsForTask(message, 8);
   const ctx = formatCatalogContext(catalogMatches);
   if(ctx) sys = (sys ? sys + '\n\n' : '') + ctx;
   sys = sys.slice(0, 14000);
 }
 const args={model:String(model||''),message,system:sys,reasoning:['low','medium','high','max'].includes(reasoning)?reasoning:'medium'};
 const reply=provider==='openai'?await callOpenAI(args):provider==='anthropic'?await callAnthropic(args):await callGoogle(args);
 let advisorTip = '';
 if (useCatalog && catalogMatches.length) {
   advisorTip = catalogMatches.slice(0, 5).map(m => m.id + ' (' + (m.category || '-') + ')').join(', ');
 }
 res.json({ reply, catalogUsed: !!useCatalog, catalogMatches, advisorTip });
 }catch(e){res.status(502).json({error:e.message||'AI provider request failed'});}
});

// Public web research. Restrict fetches to public HTTPS destinations and cap response sizes.
function decodeHtml(v=''){return String(v).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));}
function stripHtml(v=''){return decodeHtml(String(v).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());}
function isPrivateIp(ip){
 if(net.isIPv4(ip)){const a=ip.split('.').map(Number);return a[0]===10||a[0]===127||a[0]===0||a[0]>=224||(a[0]===169&&a[1]===254)||(a[0]===172&&a[1]>=16&&a[1]<=31)||(a[0]===192&&a[1]===168)||(a[0]===100&&a[1]>=64&&a[1]<=127);}
 if(net.isIPv6(ip)){const x=ip.toLowerCase();return x==='::1'||x==='::'||x.startsWith('fc')||x.startsWith('fd')||x.startsWith('fe8')||x.startsWith('fe9')||x.startsWith('fea')||x.startsWith('feb')||x.startsWith('::ffff:127.')||x.startsWith('::ffff:10.')||x.startsWith('::ffff:192.168.');}
 return true;
}
async function checkedUrl(raw){
 let u;try{u=new URL(raw)}catch{throw Error('URL ไม่ถูกต้อง');}
 if(u.protocol!=='https:'||u.username||u.password)throw Error('อนุญาตเฉพาะ URL แบบ HTTPS สาธารณะ');
 const host=u.hostname.toLowerCase();if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local'))throw Error('ไม่อนุญาต localhost หรือเครือข่ายภายใน');
 const ips=net.isIP(host)?[host]:(await dns.lookup(host,{all:true,verbatim:true})).map(x=>x.address);
 if(!ips.length||ips.some(isPrivateIp))throw Error('ปลายทางไม่ใช่ IP สาธารณะที่อนุญาต');
 return u;
}
async function safeFetch(raw,maxBytes=1500000){
 let current=raw,response;
 for(let hop=0;hop<4;hop++){
  const u=await checkedUrl(current);
  response=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'User-Agent':'AIFinderResearch/1.0 (+public web research)','Accept':'text/html,text/plain,application/pdf,application/json;q=0.9,*/*;q=0.5'}});
  if([301,302,303,307,308].includes(response.status)){const loc=response.headers.get('location');if(!loc)throw Error('เว็บส่ง redirect ที่ไม่มีปลายทาง');current=new URL(loc,u).href;continue;}
  if(!response.ok)throw Error(`เว็บไซต์ตอบกลับ HTTP ${response.status}`);
  const len=Number(response.headers.get('content-length')||0);if(len>maxBytes)throw Error('ไฟล์จากเว็บไซต์มีขนาดเกินขีดจำกัด');
  const reader=response.body?.getReader();if(!reader)throw Error('เว็บไซต์ไม่ส่งข้อมูลกลับมา');
  const chunks=[];let total=0;while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>maxBytes){await reader.cancel();throw Error('ข้อมูลจากเว็บไซต์มีขนาดเกินขีดจำกัด');}chunks.push(Buffer.from(part.value));}
  const buf=Buffer.concat(chunks,total);
  return {buffer:buf,url:u.href,type:response.headers.get('content-type')||''};
 }
 throw Error('มี redirect มากเกินไป');
}
app.post('/api/research/search',async(req,res)=>{
 try{
  const query=String(req.body?.query||'').trim().slice(0,300);if(!query)return res.status(400).json({error:'กรุณาระบุคำค้น'});
  const region=String(req.body?.region||'').match(/^[a-z]{2}-[a-z]{2}$/i)?.[0]||'';
  const searchUrl='https://html.duckduckgo.com/html/?q='+encodeURIComponent(query)+(region?'&kl='+encodeURIComponent(region):'');
  const {buffer}=await safeFetch(searchUrl,1800000);const body=buffer.toString('utf8');
  const results=[];const re=/<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;let m;
  while((m=re.exec(body))&&results.length<15){
   let url=decodeHtml(m[1]);try{if(url.startsWith('//'))url='https:'+url;const parsed=new URL(url);if(parsed.hostname.includes('duckduckgo.com')&&parsed.searchParams.has('uddg'))url=parsed.searchParams.get('uddg');const target=new URL(url);if(!['http:','https:'].includes(target.protocol))continue;
    const around=body.slice(Math.max(0,m.index-100),Math.min(body.length,re.lastIndex+1600));const sm=around.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
    results.push({title:stripHtml(m[2]).slice(0,300),url:target.href,domain:target.hostname,snippet:sm?stripHtml(sm[1]).slice(0,700):''});
   }catch{}
  }
  res.json({source:'DuckDuckGo HTML',results});
 }catch(e){res.status(502).json({error:'ค้นหาเว็บไม่สำเร็จ: '+e.message});}
});
app.post('/api/research/fetch',async(req,res)=>{
 try{
  const raw=String(req.body?.url||'');if(raw.length>2048)return res.status(400).json({error:'URL ยาวเกินกำหนด'});
  const {buffer,url,type}=await safeFetch(raw,1500000);
  if(/application\/pdf|application\/octet-stream|application\/zip|image\//i.test(type))return res.status(415).json({error:'ชนิดไฟล์นี้ไม่ใช่หน้าเว็บข้อความที่นำเข้าได้'});
  let text=buffer.toString('utf8');
  if(/html/i.test(type)||/<html[\s>]/i.test(text)){text=text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i,' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ');text=stripHtml(text);}
  else text=text.replace(/\0/g,'').slice(0,250000);
  if(!text.trim())return res.status(422).json({error:'ไม่พบข้อความที่อ่านได้จากหน้าเว็บ'});
  res.json({url,type,text:text.slice(0,250000),characters:Math.min(text.length,250000)});
 }catch(e){res.status(502).json({error:'อ่านหน้าเว็บไม่สำเร็จ: '+e.message});}
});

app.post('/api/analyze',(req,res)=>{
 const files=Array.isArray(req.body?.files)?req.body.files:[];
 if(!files.length||files.length>250)return res.status(400).json({error:'ต้องส่งไฟล์ 1-250 รายการ'});
 let total=0,readable=0,findings=[],signals=new Set(),exts={};
 const names=files.map(f=>String(f.path||'').slice(0,300));
 for(const f of files){const p=String(f.path||'');const c=typeof f.content==='string'?f.content:null;total+=Number(f.size)||0;let ext=path.extname(p).toLowerCase();exts[ext||'(no extension)']=(exts[ext||'(no extension)']||0)+1;
 if(c!==null){readable++;if(c.length>200000)continue;
 if(/TODO|FIXME|XXX/.test(c))findings.push(`${p}: พบ TODO/FIXME ที่ควรตรวจสอบ`);
 if(/eval\s*\(|new Function\s*\(/.test(c))findings.push(`${p}: พบการเรียก dynamic code evaluation ควรตรวจสอบแหล่งที่มาของข้อมูล`);
 if(/child_process|exec\s*\(|spawn\s*\(/.test(c))findings.push(`${p}: มีการเรียกใช้ process/command execution ตรวจสอบ allowlist และ input validation`);
 if(/password\s*=\s*['"][^'"]+|api[_-]?key\s*[:=]\s*['"][^'"]+/i.test(c))findings.push(`${p}: อาจมี secret ฝังใน source code ให้ย้ายไป environment variables`);
 if(/require\(['"]express['"]\)|from ['"]express['"]/.test(c))signals.add('Node.js / Express');
 if(/extends\s+MonoBehaviour|using UnityEngine/.test(c))signals.add('Unity / C#');
 if(/UCLASS\s*\(|#include\s+"CoreMinimal\.h"/.test(c))signals.add('Unreal Engine / C++');
 if(/\[gd_scene|extends Node/.test(c))signals.add('Godot');
 }}
 const sample=names.slice(0,15).join(', ');
 const summary=`ตรวจพบ ${files.length} ไฟล์ รวม ${(total/1048576).toFixed(2)} MB อ่านเป็นข้อความได้ ${readable} ไฟล์; นามสกุลที่พบ ${Object.keys(exts).slice(0,12).join(', ')||'ไม่มีข้อมูล'}.`;
 if(!findings.length)findings.push('ไม่พบรูปแบบที่ตั้งกฎตรวจไว้ ทั้งนี้ไม่ใช่การรับรองว่าโค้ดปลอดภัย');
 findings.push('การวิเคราะห์นี้เป็น static heuristic ไม่ได้ compile, execute, run tests หรือยืนยันช่องโหว่');
 res.json({summary,signals:[...signals],findings:[...new Set(findings)].slice(0,40),readableFiles:readable,totalFiles:files.length,extensions:exts,fileSample:sample});
});
app.post('/api/inspect-game',(req,res)=>{
 const files=Array.isArray(req.body?.files)?req.body.files:[];const names=files.map(f=>String(f.path||'').toLowerCase());
 const has=s=>names.some(n=>n.endsWith(s.toLowerCase())||n.includes(s.toLowerCase()));
 let engine='โปรเจกต์เกมทั่วไป / ยังระบุ Engine ไม่ได้',confidence='ความเชื่อมั่นต่ำ',checks=[],recommendations=[];
 if(has('projectsettings/projectversion.txt')||has('assets/')){engine='Unity';confidence='พบโครงสร้างที่พบบ่อยของ Unity';checks=['ตรวจหา Assets และ ProjectSettings','ตรวจหา Packages/manifest.json'];recommendations=['ตรวจสอบ ProjectSettings และเวอร์ชัน Unity ให้ตรงกัน','ตรวจสอบแพ็กเกจและไฟล์ .meta ก่อนย้ายโปรเจกต์'];}
 else if(has('.uproject')){engine='Unreal Engine';confidence='พบไฟล์ .uproject';checks=['ตรวจหา Config, Content และ Source','ตรวจสอบไฟล์ plugin และ target'];recommendations=['เปิดด้วย Unreal Engine เวอร์ชันที่ตรงกับโปรเจกต์','ตรวจสอบไฟล์ binary asset และ plugin compatibility'];}
 else if(has('project.godot')){engine='Godot';confidence='พบ project.godot';checks=['ตรวจหา scenes, scripts และ addons','ตรวจสอบ autoload และ input map ใน project.godot'];recommendations=['เปิดด้วย Godot รุ่นที่รองรับ','ตรวจสอบ resource path และ plugin dependencies'];}
 else if(has('server.properties')||has('plugins/')||has('mods/')){engine='Minecraft Server / Modded';confidence='พบไฟล์หรือโฟลเดอร์ที่เกี่ยวข้องกับ Minecraft';checks=['ตรวจหา server.properties, plugins, mods','ตรวจสอบ loader และเวอร์ชันเกม'];recommendations=['ตรวจสอบความเข้ากันได้ของ mod/plugin กับเวอร์ชันเซิร์ฟเวอร์','สำรอง world และ config ก่อนอัปเดต'];}
 else if(has('package.json')){engine='JavaScript / Web Game หรือ Node Project';confidence='พบ package.json';checks=['ตรวจสอบ package.json และ source folders','ตรวจหา entry points เช่น server.js, src/main'];recommendations=['ตรวจสอบ scripts และ dependency versions','เพิ่ม automated tests และ environment config'];}
 else {checks=['ตรวจสอบชื่อไฟล์และโฟลเดอร์ที่ส่งมา','ไม่พบ signature ของ Engine หลัก'];recommendations=['เพิ่มไฟล์ project descriptor เช่น .uproject หรือ project.godot','แนบ README และไฟล์ manifest เพื่อให้จำแนกได้แม่นยำขึ้น'];}
 res.json({engine,confidence,checks,recommendations,fileCount:files.length});
});
app.get('/api/projects',(req,res)=>res.json({projects:load().projects}));
app.post('/api/projects',(req,res)=>{const {name,analysis,files=[]}=req.body||{};if(typeof name!=='string'||!name.trim())return res.status(400).json({error:'ต้องระบุชื่อโปรเจกต์'});const d=load(),p={id:id(),name:name.slice(0,100),analysis:analysis||null,files:Array.isArray(files)?files.slice(0,250):[],fileCount:Array.isArray(files)?files.length:0,createdAt:new Date().toISOString()};d.projects.unshift(p);save(d);res.json(p);});
app.delete('/api/projects/:id',(req,res)=>{const d=load();d.projects=d.projects.filter(p=>p.id!==req.params.id);save(d);res.json({ok:true});});
app.get('/api/history',(req,res)=>res.json({history:load().history.map(({id,provider,model,messages,createdAt,projectId})=>({id,provider,model,messages,createdAt,projectId}))}));
app.get('/api/history/:id',(req,res)=>{const item=load().history.find(x=>x.id===req.params.id);if(!item)return res.status(404).json({error:'ไม่พบประวัติ'});res.json({item});});
app.post('/api/history',(req,res)=>{const {provider,model,messages,projectId}=req.body||{};if(!Array.isArray(messages)||messages.length>100)return res.status(400).json({error:'รูปแบบประวัติไม่ถูกต้อง'});const d=load(),item={id:id(),provider:String(provider||''),model:String(model||''),messages:messages.slice(-100).map(m=>({role:m.role==='user'?'user':'assistant',content:String(m.content||'').slice(0,20000)})),projectId:projectId||null,createdAt:new Date().toISOString()};d.history.unshift(item);d.history=d.history.slice(0,300);save(d);res.json({id:item.id});});

// Docker management: fixed image, fixed ports, fixed commands. No arbitrary shell, image, mount, or command input.
const IMAGE='itzg/minecraft-server:java21';
async function docker(args,timeout=30000){return execFileAsync('docker',args,{timeout,maxBuffer:1024*1024,windowsHide:true});}
app.get('/api/servers',requireAdmin,async(req,res)=>{try{const d=load();let out=[];for(const s of d.servers){try{let {stdout}=await docker(['inspect','-f','{{.State.Status}}',s.id]);out.push({...s,status:stdout.trim()});}catch{out.push({...s,status:'not-found'});}}res.json({servers:out});}catch(e){res.status(500).json({error:'ตรวจสอบ Docker ไม่สำเร็จ: '+e.message});}});
app.post('/api/servers',requireAdmin,async(req,res)=>{
 try{const {name,type,maxPlayers,eula}=req.body||{};if(type!=='minecraft')return res.status(400).json({error:'อนุญาตเฉพาะเทมเพลต Minecraft ที่กำหนดไว้'});if(eula!==true)return res.status(400).json({error:'ต้องยืนยัน EULA'});const safe=String(name||'game-server').toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,40);if(!safe)return res.status(400).json({error:'ชื่อเซิร์ฟเวอร์ไม่ถูกต้อง'});const players=Math.max(1,Math.min(50,Number(maxPlayers)||10));const d=load();if(d.servers.some(s=>s.name===safe))return res.status(409).json({error:'มีชื่อเซิร์ฟเวอร์นี้แล้ว'});const {stdout}=await docker(['create','--name',safe,'--restart','unless-stopped','-p',`25565:25565`,'-e','EULA=TRUE','-e','TYPE=VANILLA','-e',`MAX_PLAYERS=${players}`,'-e','ONLINE_MODE=TRUE',IMAGE],60000);const item={id:stdout.trim(),name:safe,type:'minecraft',image:IMAGE,createdAt:new Date().toISOString()};d.servers.push(item);save(d);res.json(item);}catch(e){res.status(500).json({error:'สร้าง Docker container ไม่สำเร็จ: '+e.message});}
});
app.post('/api/servers/:id/:action',requireAdmin,async(req,res)=>{const d=load(),s=d.servers.find(x=>x.id===req.params.id);if(!s)return res.status(404).json({error:'ไม่พบเซิร์ฟเวอร์'});try{const a=req.params.action;if(a==='start'){await docker(['start',s.id]);return res.json({ok:true});}if(a==='stop'){await docker(['stop','--time','20',s.id]);return res.json({ok:true});}if(a==='logs'){const {stdout}=await docker(['logs','--tail','100',s.id]);return res.json({logs:stdout.slice(-20000)});}return res.status(400).json({error:'action ไม่รองรับ'});}catch(e){res.status(500).json({error:'Docker operation failed: '+e.message});}});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});


// ===== AI Model Directory (local seed + live Hugging Face API) =====
const modelsPath = path.join(DATA, 'models-seed.json');
const knowledgePath = path.join(DATA, 'ai-knowledge.md');
let knowledgeCache = null;
function loadKnowledge() {
  if (knowledgeCache !== null) return knowledgeCache;
  try {
    const base = fs.readFileSync(knowledgePath, 'utf8');
    let insights = '', products = '';
    try { insights = fs.readFileSync(path.join(DATA, 'catalog-insights.md'), 'utf8'); } catch (_) {}
    try { products = fs.readFileSync(path.join(DATA, 'ai-products.md'), 'utf8'); } catch (_) {}
    knowledgeCache = (base + '\n\n' + products + '\n\n' + insights).slice(0, 16000);
  } catch {
    knowledgeCache = '';
  }
  return knowledgeCache;
}
function loadAiProducts() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'ai-products.json'), 'utf8'));
  } catch {
    return { products: [], count: 0 };
  }
}
function loadCatalogInsights() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'catalog-insights.json'), 'utf8'));
  } catch {
    return null;
  }
}

let modelsCache = null;
function loadModels() {
  if (modelsCache) return modelsCache;
  try {
    const raw = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
    modelsCache = Array.isArray(raw.models) ? raw.models : [];
    return modelsCache;
  } catch (e) {
    console.error('models load failed', e.message);
    modelsCache = [];
    return modelsCache;
  }
}
const CATEGORIES = ['Chat', 'Coding', 'Image', 'Video', 'Audio', 'Reasoning', 'Open Source'];
const HF_PIPELINE_TO_CAT = {
  'text-generation': 'Chat', 'text2text-generation': 'Chat', 'conversational': 'Chat',
  'fill-mask': 'Chat', 'feature-extraction': 'Chat', 'sentence-similarity': 'Chat',
  'text-classification': 'Chat', 'token-classification': 'Chat', 'question-answering': 'Chat',
  'summarization': 'Chat', 'translation': 'Chat', 'zero-shot-classification': 'Chat',
  'code-generation': 'Coding',
  'text-to-image': 'Image', 'image-to-image': 'Image', 'image-classification': 'Image',
  'image-segmentation': 'Image', 'object-detection': 'Image', 'image-to-text': 'Image',
  'visual-question-answering': 'Image', 'image-text-to-text': 'Image',
  'text-to-video': 'Video', 'video-classification': 'Video', 'image-to-video': 'Video',
  'text-to-speech': 'Audio', 'automatic-speech-recognition': 'Audio', 'audio-classification': 'Audio',
  'audio-to-audio': 'Audio', 'text-to-audio': 'Audio', 'voice-activity-detection': 'Audio'
};
function categorizeModel(id, pipeline, tags) {
  const blob = (String(id||'') + ' ' + String(pipeline||'') + ' ' + (tags||[]).join(' ')).toLowerCase();
  if (/code|coding|starcoder|codegen|codellama|deepseek-coder|codestral/.test(blob)) return 'Coding';
  if (/reason|think|r1|o1|qwq|deepseek-r|reasoning/.test(blob)) return 'Reasoning';
  if (/image|stable-diffusion|flux|sdxl|midjourney|dall|diffusion|vision/.test(blob)) return 'Image';
  if (/video|sora|runway|pika|luma|gen-3|text-to-video|cogvideo|wan/.test(blob)) return 'Video';
  if (/audio|whisper|tts|speech|musicgen|bark|wav2vec|asr|xtts/.test(blob)) return 'Audio';
  return HF_PIPELINE_TO_CAT[pipeline] || 'Chat';
}
function buildCodeSnippet(m) {
  const id = m.id || '';
  const pipe = m.pipeline || m.pipeline_tag || '';
  const isDiffusers = /text-to-image|image-to-image|text-to-video|image-to-video|stable-diffusion|flux/i.test(pipe + ' ' + id);
  const isAudio = /speech|audio|whisper|tts|asr/i.test(pipe + ' ' + id);
  if (isDiffusers) {
    return {
      library: 'diffusers',
      install: 'pip install diffusers transformers accelerate safetensors',
      python: `from diffusers import DiffusionPipeline\nimport torch\n\npipe = DiffusionPipeline.from_pretrained(\n    "${id}",\n    torch_dtype=torch.float16\n)\npipe = pipe.to("cuda")  # or "cpu"\n\nimage = pipe("a photo of an astronaut riding a horse").images[0]\nimage.save("output.png")`
    };
  }
  if (isAudio && /whisper|asr|speech-recognition/i.test(pipe + ' ' + id)) {
    return {
      library: 'transformers',
      install: 'pip install transformers torch',
      python: `from transformers import pipeline\n\nasr = pipeline("automatic-speech-recognition", model="${id}")\nresult = asr("audio.wav")\nprint(result["text"])`
    };
  }
  if (isAudio) {
    return {
      library: 'transformers',
      install: 'pip install transformers torch',
      python: `from transformers import pipeline\n\nsynth = pipeline("${pipe || 'text-to-speech'}", model="${id}")\n# ดู model card บน Hugging Face สำหรับพารามิเตอร์ที่ถูกต้อง\nprint(synth)`
    };
  }
  return {
    library: 'transformers',
    install: 'pip install transformers torch accelerate',
    python: `from transformers import AutoModelForCausalLM, AutoTokenizer\nimport torch\n\nmodel_id = "${id}"\ntokenizer = AutoTokenizer.from_pretrained(model_id)\nmodel = AutoModelForCausalLM.from_pretrained(\n    model_id,\n    torch_dtype=torch.float16,\n    device_map="auto"\n)\n\nmessages = [{"role": "user", "content": "Hello"}]\ninputs = tokenizer.apply_chat_template(messages, return_tensors="pt", add_generation_prompt=True)\noutputs = model.generate(inputs.to(model.device), max_new_tokens=256)\nprint(tokenizer.decode(outputs[0], skip_special_tokens=True))`
  };
}
function normalizeHfItem(m) {
  const id = m.id || m.modelId || '';
  const parts = id.includes('/') ? id.split('/') : ['unknown', id];
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const pipeline = m.pipeline_tag || '';
  return {
    id,
    name: parts[1] || id,
    provider: parts[0],
    category: categorizeModel(id, pipeline, tags),
    pipeline: pipeline || null,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    tags: tags.filter(t => !String(t).startsWith('arxiv:') && !String(t).startsWith('dataset:')).slice(0, 12),
    openSource: true,
    source: 'huggingface-live',
    url: 'https://huggingface.co/' + id,
    createdAt: m.createdAt || null,
    lastModified: m.lastModified || m.createdAt || null
  };
}



app.get('/api/all-links', (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA, 'all-links.json'), 'utf8'));
    const q = String(req.query.q || '').trim().toLowerCase();
    let links = data.links || [];
    if (q) links = links.filter(l => (l.name + ' ' + l.url + ' ' + l.category).toLowerCase().includes(q));
    res.json({ count: links.length, total: data.count, generatedAt: data.generatedAt, links });
  } catch (e) {
    res.status(500).json({ error: 'ไม่พบ all-links.json' });
  }
});
app.get('/api/ai-products', (req, res) => {
  const data = loadAiProducts();
  const q = String(req.query.q || '').trim().toLowerCase();
  const category = String(req.query.category || '').trim();
  let list = data.products || [];
  if (category) list = list.filter(p => p.category === category);
  if (q) list = list.filter(p => (p.name + ' ' + p.org + ' ' + p.url + ' ' + (p.note || '')).toLowerCase().includes(q));
  res.json({
    count: list.length,
    total: data.count || list.length,
    hubNote: data.hubNote || '',
    products: list,
    note: 'รายการผลิตภัณฑ์/เว็บ AI จริง · โมเดลระดับแสนรายการใช้โหมด Live Hugging Face'
  });
});

app.get('/api/models/meta', (req, res) => {
  const models = loadModels();
  const byCat = {};
  const providers = new Set();
  let openCount = 0;
  for (const m of models) {
    byCat[m.category] = (byCat[m.category] || 0) + 1;
    if (m.provider) providers.add(m.provider);
    if (m.openSource) openCount++;
  }
  res.json({
    total: models.length,
    categories: CATEGORIES,
    categoryCounts: byCat,
    providerCount: providers.size,
    openSourceCount: openCount,
    version: '2.4',
    liveSupported: true,
    knowledgeLoaded: !!loadKnowledge(),
    catalogInsights: !!loadCatalogInsights(),
    aiProducts: (loadAiProducts().count || 0),
    note: 'Local seed = snapshot จริงจาก HF + curated. โหมด Live ดึงสดจาก Hugging Face API (ไม่สร้างชื่อปลอม)'
  });
});

// Local catalog search (fast, offline)
app.get('/api/models', (req, res) => {
  const models = loadModels();
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 120);
  const category = String(req.query.category || '').trim();
  const provider = String(req.query.provider || '').trim().toLowerCase();
  const openOnly = req.query.openSource === '1' || req.query.openSource === 'true';
  const sort = String(req.query.sort || 'downloads');
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24));
  let list = models;
  if (category === 'Open Source') list = list.filter(m => m.openSource);
  else if (category && CATEGORIES.includes(category)) list = list.filter(m => m.category === category);
  if (openOnly) list = list.filter(m => m.openSource);
  if (provider) list = list.filter(m => String(m.provider || '').toLowerCase().includes(provider));
  if (q) {
    list = list.filter(m => {
      const hay = (m.id + ' ' + m.name + ' ' + m.provider + ' ' + (m.tags || []).join(' ') + ' ' + (m.pipeline || '')).toLowerCase();
      return hay.includes(q);
    });
  }
  if (sort === 'likes') list = [...list].sort((a, b) => (b.likes || 0) - (a.likes || 0));
  else if (sort === 'name') list = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  else if (sort === 'updated') list = [...list].sort((a, b) => String(b.lastModified || b.createdAt || '').localeCompare(String(a.lastModified || a.createdAt || '')));
  else list = [...list].sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  const total = list.length;
  const start = (page - 1) * limit;
  const items = list.slice(start, start + limit).map(m => ({
    id: m.id, name: m.name, provider: m.provider, category: m.category,
    pipeline: m.pipeline, downloads: m.downloads, likes: m.likes, tags: m.tags,
    openSource: !!m.openSource, source: m.source, url: m.url,
    createdAt: m.createdAt || null, lastModified: m.lastModified || m.createdAt || null
  }));
  res.json({ total, page, limit, pages: Math.ceil(total / limit) || 1, items, mode: 'local' });
});

// Live search against Hugging Face Hub API (real models only)
app.get('/api/models/live', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 120);
    const sort = String(req.query.sort || 'downloads'); // downloads | likes | updated
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 24));
    const category = String(req.query.category || '').trim();
    const openOnly = req.query.openSource === '1' || req.query.openSource === 'true';

    // Map UI category to HF pipeline filter when possible
    const pipelineMap = {
      Chat: 'text-generation',
      Coding: null,
      Image: 'text-to-image',
      Video: 'text-to-video',
      Audio: 'automatic-speech-recognition',
      Reasoning: null
    };
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('skip', String((page - 1) * limit));
    if (sort === 'likes') { params.set('sort', 'likes'); params.set('direction', '-1'); }
    else if (sort === 'updated') { params.set('sort', 'lastModified'); params.set('direction', '-1'); }
    else { params.set('sort', 'downloads'); params.set('direction', '-1'); }
    if (q) params.set('search', q);
    if (pipelineMap[category]) params.set('pipeline_tag', pipelineMap[category]);
    if (openOnly || category === 'Open Source') { /* HF public models are generally open weights */ }

    const url = 'https://huggingface.co/api/models?' + params.toString();
    const r = await fetch(url, {
      headers: { 'User-Agent': 'AIFinder-ModelDirectory/2.4 (+local catalog)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) return res.status(502).json({ error: 'Hugging Face API ตอบกลับ ' + r.status });
    let batch = await r.json();
    if (!Array.isArray(batch)) batch = [];

    let items = batch.map(normalizeHfItem);
    // Client-side category refine for Coding / Reasoning / Open Source
    if (category === 'Coding') items = items.filter(m => m.category === 'Coding' || /code|coder|starcoder/i.test(m.id));
    if (category === 'Reasoning') items = items.filter(m => m.category === 'Reasoning' || /reason|r1|qwq|o1/i.test(m.id));
    if (category && category !== 'Open Source' && !pipelineMap[category] && category !== 'Coding' && category !== 'Reasoning') {
      items = items.filter(m => m.category === category);
    }

    // HF does not always return exact total; approximate
    const totalHeader = r.headers.get('x-total-count');
    const total = totalHeader ? Number(totalHeader) : (items.length < limit ? (page - 1) * limit + items.length : page * limit + 1);

    res.json({
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      items,
      mode: 'live',
      source: 'huggingface.co/api/models'
    });
  } catch (e) {
    res.status(502).json({ error: 'ดึงข้อมูลสดจาก Hugging Face ไม่สำเร็จ: ' + (e.message || 'unknown') });
  }
});

app.get('/api/models/detail', async (req, res) => {
  try {
    const id = String(req.query.id || '').trim();
    if (!id || id.length > 200) return res.status(400).json({ error: 'ต้องระบุ id โมเดล' });

    // Prefer local seed first
    const local = loadModels().find(x => x.id === id);
    let model = local ? { ...local } : null;

    // Enrich / fallback from HF API
    if (!model || req.query.refresh === '1') {
      try {
        const r = await fetch('https://huggingface.co/api/models/' + encodeURIComponent(id), {
          headers: { 'User-Agent': 'AIFinder-ModelDirectory/2.4', 'Accept': 'application/json' },
          signal: AbortSignal.timeout(15000)
        });
        if (r.ok) {
          const hf = await r.json();
          const norm = normalizeHfItem(hf);
          model = model ? { ...norm, ...model, downloads: hf.downloads || model.downloads, likes: hf.likes || model.likes, tags: norm.tags, pipeline: norm.pipeline || model.pipeline } : norm;
          model.cardData = hf.cardData || null;
          model.siblings = Array.isArray(hf.siblings) ? hf.siblings.slice(0, 20).map(s => s.rfilename) : null;
        }
      } catch (_) { /* keep local */ }
    }

    if (!model) return res.status(404).json({ error: 'ไม่พบโมเดลใน local seed และ Hugging Face' });

    const snippet = buildCodeSnippet(model);
    res.json({
      ...model,
      code: snippet,
      hubUrl: 'https://huggingface.co/' + model.id,
      note: 'ข้อมูลจาก local seed และ/หรือ Hugging Face API — ไม่มีการสร้างชื่อโมเดลปลอม'
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'detail failed' });
  }
});



// ===== V2.4 max APIs =====
app.get('/api/stats', (req, res) => {
  const models = loadModels();
  const products = loadAiProducts();
  const insights = loadCatalogInsights();
  let linksCount = 0;
  try { linksCount = JSON.parse(fs.readFileSync(path.join(DATA, 'all-links.json'), 'utf8')).count || 0; } catch {}
  const byCat = {};
  for (const m of models) byCat[m.category] = (byCat[m.category] || 0) + 1;
  res.json({
    version: '2.4.0',
    modelsLocal: models.length,
    modelsLiveNote: 'Hugging Face public catalog 200k+ via /api/models/live',
    products: products.count || (products.products || []).length,
    links: linksCount,
    categoryCounts: byCat,
    openSourceCount: models.filter(m => m.openSource).length,
    knowledgeFiles: ['ai-knowledge.md', 'ai-products.md', 'catalog-insights.md', 'all-links.md'],
    features: ['chat','catalog-rag','live-hf','products','all-links','compare','export','advisor','research','analyzer','servers'],
    insightsTop: insights ? (insights.overallTopDownloads || []).slice(0, 5) : []
  });
});

app.get('/api/models/compare', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
  if (ids.length < 2) return res.status(400).json({ error: 'ส่ง ids อย่างน้อย 2 ค่า คั่นด้วย comma' });
  const models = loadModels();
  const found = ids.map(id => {
    const m = models.find(x => x.id === id);
    if (!m) return { id, missing: true };
    return {
      id: m.id, name: m.name, provider: m.provider, category: m.category,
      pipeline: m.pipeline, downloads: m.downloads, likes: m.likes,
      openSource: !!m.openSource, url: m.url, tags: (m.tags || []).slice(0, 8)
    };
  });
  res.json({ count: found.length, models: found });
});

app.get('/api/prompt-templates', (req, res) => {
  res.json({
    templates: [
      { id: 'code-review', title: 'รีวิวโค้ด', prompt: 'ช่วยรีวิวโค้ดนี้แบบตรงไปตรงมา ชี้ bug ความเสี่ยง และทางแก้เป็นข้อๆ' },
      { id: 'pick-model', title: 'เลือกโมเดล AI', prompt: 'จากงานที่อธิบาย แนะนำโมเดลจริง 3–5 ตัว พร้อมเหตุผล open/closed และข้อจำกัด' },
      { id: 'debug', title: 'ดีบัก', prompt: 'ช่วยหาสาเหตุ error นี้ และลำดับการตรวจ อย่าเดาเกินหลักฐาน' },
      { id: 'architecture', title: 'ออกแบบระบบ', prompt: 'เสนอสถาปัตยกรรมแบบ pragmatic สำหรับระบบนี้ พร้อม trade-offs' },
      { id: 'hf-howto', title: 'ใช้โมเดลบน HF', prompt: 'อธิบายวิธีโหลดและรันโมเดลนี้ด้วย transformers หรือ diffusers แบบขั้นตอน' },
      { id: 'secure', title: 'ตรวจความปลอดภัย', prompt: 'วิเคราะห์ความเสี่ยงด้านความปลอดภัยของโค้ด/ระบบนี้ และวิธีลดความเสี่ยง' }
    ]
  });
});

app.listen(PORT,()=>console.log(`AIFinder V2.4 listening on http://localhost:${PORT}`));
