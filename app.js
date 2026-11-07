const $=id=>document.getElementById(id);
const models={
 openai:[['gpt-4.1','GPT-4.1'],['gpt-4.1-mini','GPT-4.1 mini'],['o3','o3 reasoning'],['o4-mini','o4-mini reasoning']],
 anthropic:[['claude-sonnet-4-20250514','Claude Sonnet 4'],['claude-3-7-sonnet-20250219','Claude 3.7 Sonnet'],['claude-3-5-haiku-20241022','Claude 3.5 Haiku']],
 google:[['gemini-2.5-pro','Gemini 2.5 Pro'],['gemini-2.5-flash','Gemini 2.5 Flash'],['gemini-2.0-flash','Gemini 2.0 Flash']]
};
let codeFiles=[], lastAnalysis=null, projects=[];
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function token(){return sessionStorage.getItem('adminToken')||''}
async function api(url,opts={}){opts.headers={...(opts.headers||{}),...(opts.body&&!(opts.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...(token()?{'x-admin-token':token()}:{})};let r=await fetch(url,opts);let d=await r.json().catch(()=>({error:'Invalid server response'}));if(!r.ok)throw Error(d.error||`HTTP ${r.status}`);return d;}
function setModels(){let p=$('provider').value;$('model').innerHTML=models[p].map(([v,n])=>`<option value="${v}">${n}</option>`).join('');}
$('provider').onchange=setModels;setModels();
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.page').forEach(x=>x.classList.toggle('hidden',x.id!==b.dataset.tab));if(b.dataset.tab==='servers')loadServers();if(b.dataset.tab==='projects')loadProjects();if(b.dataset.tab==='settings')loadProviders();});
function addBubble(role,text){let d=document.createElement('div');d.className='bubble '+(role==='user'?'user':'assistant');let h=document.createElement('b');h.textContent=role==='user'?'คุณ':'AI';let p=document.createElement('div');p.textContent=text;d.append(h,p);$('messages').append(d);$('messages').scrollTop=$('messages').scrollHeight;}
$('chatForm').onsubmit=async e=>{e.preventDefault();let message=$('message').value.trim();if(!message)return;addBubble('user',message);$('message').value='';$('chatStatus').textContent='กำลังประมวลผล...';const useCatalog=!!$('useCatalog')?.checked;try{let d=await api('/api/chat',{method:'POST',body:JSON.stringify({provider:$('provider').value,model:$('model').value,reasoning:$('reasoning').value,system:$('systemPrompt').value,message,projectId:$('chatProject').value||null,useCatalog})});addBubble('assistant',d.reply);if(useCatalog&&d.catalogMatches&&d.catalogMatches.length){const tip=d.catalogMatches.slice(0,5).map(m=>`• ${m.id} (${m.category||'-'}, ↓${(m.downloads||0).toLocaleString()})`).join('\n');addBubble('assistant','📚 โมเดลจาก Directory ที่ระบบดึงมาช่วยตอบ:\n'+tip);}else if(useCatalog){addBubble('assistant','📚 เปิดใช้ Directory แล้ว แต่ไม่พบโมเดลที่คะแนนตรงกับคำถามนี้');}$('chatStatus').textContent=useCatalog?'ตอบกลับสำเร็จ (ใช้ Model Directory)':'ตอบกลับสำเร็จ';
if($('advisorStatus')){
  if(useCatalog&&d.catalogMatches&&d.catalogMatches.length){
    $('advisorStatus').textContent='Advisor ดึง '+d.catalogMatches.length+' โมเดลจาก Directory · '+(d.advisorTip||'');
  }else if(useCatalog){
    $('advisorStatus').textContent='Advisor เปิดอยู่ แต่ไม่พบโมเดลที่คะแนนตรง';
  }else{
    $('advisorStatus').textContent='';
  }
}}catch(e){addBubble('assistant','เกิดข้อผิดพลาด: '+e.message);$('chatStatus').textContent='เชื่อมต่อไม่สำเร็จ';}};
$('newChat').onclick=()=>{$('messages').innerHTML='';$('chatStatus').textContent='เริ่มบทสนทนาใหม่';};
$('saveChat').onclick=async()=>{let msgs=[...$('messages').children].map(x=>({role:x.querySelector('b')?.textContent==='คุณ'?'user':'assistant',content:x.querySelector('div')?.textContent||''}));try{let d=await api('/api/history',{method:'POST',body:JSON.stringify({provider:$('provider').value,model:$('model').value,messages:msgs,projectId:$('chatProject').value||null})});$('chatStatus').textContent='บันทึกแล้ว: '+d.id;}catch(e){$('chatStatus').textContent=e.message;}};
async function ingest(files){for(let f of files){if(f.name.toLowerCase().endsWith('.zip')){try{let z=await JSZip.loadAsync(f);for(let [path,obj] of Object.entries(z.files)){if(obj.dir||skipPath(path))continue;let blob=await obj.async('blob');codeFiles.push({path:path.replace(/^\/+/,''),size:blob.size,content:await readText(blob,path)});}}catch(e){alert('ZIP เปิดไม่ได้: '+e.message)}}else{let path=f.webkitRelativePath||f.name;if(skipPath(path))continue;codeFiles.push({path,size:f.size,content:await readText(f,path)});}}renderCode();}
function skipPath(p){return /(^|\/)(node_modules|\.git|\.next|dist|build|Library|Temp|obj|bin)(\/|$)/i.test(p)||p.split('/').length>12;}
async function readText(file,path){if(file.size>500000)return null;let ext=path.split('.').pop().toLowerCase();if(/^(png|jpg|jpeg|gif|webp|ico|pdf|dll|exe|so|dylib|class|jar|pak|uasset|umap|mp4|mp3|wav|zip|7z|rar|woff|ttf)$/i.test(ext))return null;try{let t=await file.text();return t.includes('\0')?null:t;}catch{return null;}}
$('codeFiles').onchange=e=>ingest(e.target.files);$('codeFolder').onchange=e=>ingest(e.target.files);$('codeZip').onchange=e=>ingest(e.target.files);
$('clearCode').onclick=()=>{codeFiles=[];lastAnalysis=null;renderCode();$('analysisResult').textContent='เพิ่มไฟล์เพื่อเริ่มวิเคราะห์';$('gameResult').textContent='รอไฟล์โปรเจกต์';};
let dz=$('codeDrop');dz.ondragover=e=>{e.preventDefault();dz.classList.add('border-sky-400')};dz.ondragleave=()=>dz.classList.remove('border-sky-400');dz.ondrop=e=>{e.preventDefault();dz.classList.remove('border-sky-400');ingest(e.dataTransfer.files)};
function renderCode(){$('codeCount').textContent=`${codeFiles.length} ไฟล์ · ${(codeFiles.reduce((a,x)=>a+x.size,0)/1048576).toFixed(2)} MB`; $('analyzeBtn').disabled=!codeFiles.length;$('codeList').innerHTML=codeFiles.map(f=>`<div class="py-1 border-b border-slate-800 flex justify-between gap-2"><span class="truncate">${esc(f.path)}</span><span class="shrink-0">${f.content===null?'binary':f.content.length+' chars'}</span></div>`).join('')||'ยังไม่มีไฟล์';}
$('analyzeBtn').onclick=async()=>{let files=codeFiles.filter(f=>f.content!==null).slice(0,250);if(!files.length){$('analysisResult').textContent='ไม่พบไฟล์ข้อความที่อ่านได้';return;}$('analysisResult').textContent='กำลังวิเคราะห์...';try{let d=await api('/api/analyze',{method:'POST',body:JSON.stringify({files})});lastAnalysis=d;$('analysisResult').innerHTML=`<div class="space-y-3"><div><b>สรุป</b><p>${esc(d.summary)}</p></div><div><b>โครงสร้างที่ตรวจพบ</b><p>${d.signals.map(esc).join(' · ')||'ไม่พบ signature เฉพาะ'}</p></div><div><b>ข้อสังเกต</b><ul class="list-disc pl-5">${d.findings.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div><div><b>ไฟล์ที่อ่านได้:</b> ${d.readableFiles} / ${d.totalFiles}</div></div>`;}catch(e){$('analysisResult').textContent=e.message;}};
$('saveAnalysis').onclick=async()=>{if(!lastAnalysis)return alert('วิเคราะห์ก่อน');let name=prompt('ชื่อโปรเจกต์','My Game Project');if(!name)return;try{let d=await api('/api/projects',{method:'POST',body:JSON.stringify({name,analysis:lastAnalysis,files:codeFiles.map(x=>({path:x.path,size:x.size}))})});alert('บันทึกโปรเจกต์แล้ว: '+d.id);loadProjects();}catch(e){alert(e.message)}};
$('inspectGame').onclick=async()=>{if(!codeFiles.length)return $('gameResult').textContent='กรุณาเพิ่มไฟล์ใน Code Analyzer ก่อน';try{let d=await api('/api/inspect-game',{method:'POST',body:JSON.stringify({files:codeFiles.map(x=>({path:x.path,size:x.size,content:x.content}))})});$('gameResult').innerHTML=`<h3 class="font-bold text-lg">${esc(d.engine)}</h3><p class="muted">${esc(d.confidence)}</p><ul class="list-disc pl-5 mt-2">${d.checks.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p class="mt-3"><b>คำแนะนำ</b></p><ul class="list-disc pl-5">${d.recommendations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;}catch(e){$('gameResult').textContent=e.message}};
$('saveToken').onclick=()=>{sessionStorage.setItem('adminToken',$('adminToken').value);$('tokenStatus').textContent='บันทึก token ใน session นี้แล้ว';};
$('createServer').onclick=async()=>{if(!$('eula').checked)return $('serverMsg').textContent='กรุณายืนยันว่าอ่านและยอมรับ EULA ก่อน';try{let d=await api('/api/servers',{method:'POST',body:JSON.stringify({name:$('serverName').value,type:$('serverType').value,maxPlayers:Number($('maxPlayers').value),eula:true})});$('serverMsg').textContent='สร้างเซิร์ฟเวอร์แล้ว: '+d.id;loadServers();}catch(e){$('serverMsg').textContent=e.message}};
async function loadServers(){try{let d=await api('/api/servers');$('serverList').innerHTML=d.servers.map(s=>`<div class="p-3 rounded-xl bg-slate-900 flex flex-wrap items-center justify-between gap-2"><div><b>${esc(s.name)}</b><div class="text-xs muted">${esc(s.status||'unknown')} · ${esc(s.id)}</div></div><div class="flex gap-2"><button class="btn2 text-xs" onclick="serverAction('${s.id}','start')">Start</button><button class="btn2 text-xs" onclick="serverAction('${s.id}','stop')">Stop</button><button class="btn2 text-xs" onclick="serverAction('${s.id}','logs')">Logs</button></div></div>`).join('')||'ยังไม่มีเซิร์ฟเวอร์';}catch(e){$('serverList').textContent=e.message;}}
window.serverAction=async(id,action)=>{try{let d=await api(`/api/servers/${encodeURIComponent(id)}/${action}`,{method:'POST'});if(action==='logs')alert(d.logs||'(ไม่มี log)');loadServers();}catch(e){alert(e.message)}};
$('refreshServers').onclick=loadServers;
async function loadProjects(){try{let d=await api('/api/projects');projects=d.projects;$('projectList').innerHTML=projects.map(p=>`<div class="p-3 bg-slate-900 rounded-lg"><b>${esc(p.name)}</b><p class="text-xs muted">${esc(p.createdAt)} · ${p.fileCount||0} files</p><button class="text-sky-300 text-xs" onclick="deleteProject('${p.id}')">ลบโปรเจกต์</button></div>`).join('')||'ยังไม่มีโปรเจกต์';$('chatProject').innerHTML='<option value="">ไม่ผูกกับโปรเจกต์</option>'+projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');let h=await api('/api/history');$('historyList').innerHTML=h.history.map(x=>`<div class="p-3 bg-slate-900 rounded-lg"><b>${esc(x.provider)} / ${esc(x.model)}</b><p class="text-xs muted">${esc(x.createdAt)} · ${x.messages.length} messages</p><button class="text-sky-300 text-xs" onclick="restoreHistory('${x.id}')">เปิดดู</button></div>`).join('')||'ยังไม่มีประวัติ';}catch(e){$('projectList').textContent=e.message;}}
window.deleteProject=async id=>{if(!confirm('ลบโปรเจกต์นี้?'))return;try{await api('/api/projects/'+id,{method:'DELETE'});loadProjects()}catch(e){alert(e.message)}};
window.restoreHistory=async id=>{try{let d=await api('/api/history/'+id);$('messages').innerHTML='';d.item.messages.forEach(m=>addBubble(m.role==='user'?'user':'assistant',m.content));document.querySelector('[data-tab="chat"]').click();}catch(e){alert(e.message)}};
$('refreshProjects').onclick=loadProjects;

// Global web research. Search results are untrusted external data; render with textContent/escaped HTML.
let researchResults=[], researchImports=[];
function saveBlob(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('researchForm').onsubmit=async e=>{e.preventDefault();const q=$('researchQuery').value.trim();if(!q)return;$('researchStatus').textContent='กำลังค้นหาเว็บไซต์ทั่วโลก...';$('researchResults').textContent='กำลังค้นหา...';try{const d=await api('/api/research/search',{method:'POST',body:JSON.stringify({query:q,region:$('researchRegion').value})});researchResults=d.results||[];renderResearch();$('researchStatus').textContent=`ค้นหาเสร็จแล้ว · ${d.source||'Web search'} · ตรวจสอบวันที่และแหล่งที่มาก่อนนำไปใช้อ้างอิง`; }catch(e){$('researchResults').textContent='ค้นหาไม่สำเร็จ: '+e.message;$('researchStatus').textContent='เกิดข้อผิดพลาด';}};
function renderResearch(){$('researchCount').textContent=researchResults.length+' รายการ';$('exportResearchJson').disabled=!researchResults.length&&!researchImports.length;$('exportResearchTxt').disabled=!researchResults.length&&!researchImports.length;$('researchResults').innerHTML=researchResults.map((r,i)=>`<article class="p-3 rounded-xl bg-slate-900 border border-slate-800"><a class="text-sky-300 font-semibold hover:underline" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a><p class="text-xs muted mt-1">${esc(r.domain||'')}</p><p class="mt-2">${esc(r.snippet||'')}</p><button class="btn2 text-xs mt-2" onclick="importResearch(${i})">นำเข้าเนื้อหา</button></article>`).join('')||'ไม่พบผลลัพธ์';$('researchImports').innerHTML=researchImports.map((x,i)=>`<div class="p-2 rounded bg-slate-900"><b>${esc(x.title)}</b><p class="muted">${esc(x.domain)} · ${x.text.length.toLocaleString()} ตัวอักษร</p><button class="text-rose-300 mt-1" onclick="removeResearch(${i})">นำออก</button></div>`).join('')||'ยังไม่มีข้อมูลที่นำเข้า';}
window.importResearch=async i=>{const r=researchResults[i];if(!r)return;const b=document.querySelectorAll('#researchResults article button')[i];if(b)b.disabled=true;$('researchStatus').textContent='กำลังอ่านหน้าเว็บ...';try{const d=await api('/api/research/fetch',{method:'POST',body:JSON.stringify({url:r.url})});researchImports.unshift({title:r.title,url:r.url,domain:r.domain,text:d.text, fetchedAt:new Date().toISOString()});renderResearch();$('researchStatus').textContent='นำเข้าเนื้อหาแล้ว';}catch(e){$('researchStatus').textContent='นำเข้าไม่ได้: '+e.message;if(b)b.disabled=false;}};
window.removeResearch=i=>{researchImports.splice(i,1);renderResearch();};
$('exportResearchJson').onclick=()=>saveBlob('aifinder-research.json',JSON.stringify({query:$('researchQuery').value,exportedAt:new Date().toISOString(),results:researchResults,imports:researchImports},null,2),'application/json;charset=utf-8');
$('exportResearchTxt').onclick=()=>{const out=['AIFinder Web Research',`Query: ${$('researchQuery').value}`,`Exported: ${new Date().toISOString()}`,'',...researchResults.map((r,i)=>`${i+1}. ${r.title}\n${r.url}\n${r.snippet||''}`), '', 'IMPORTED PAGE CONTENT',...researchImports.map(x=>`${x.title}\n${x.url}\n${x.text}`)];saveBlob('aifinder-research.txt',out.join('\n\n'),'text/plain;charset=utf-8');};
$('clearResearch').onclick=()=>{researchResults=[];researchImports=[];renderResearch();$('researchStatus').textContent='ล้างข้อมูลแล้ว';};

async function loadProviders(){try{let d=await api('/api/providers');$('providerStatus').innerHTML=d.providers.map(p=>`<div class="flex justify-between border-b border-slate-800 py-2"><span>${esc(p.name)}</span><span class="${p.configured?'text-emerald-400':'text-amber-300'}">${p.configured?'ตั้งค่าแล้ว':'ยังไม่มี API Key'}</span></div>`).join('');}catch(e){$('providerStatus').textContent=e.message;}}
$('checkProviders').onclick=loadProviders;
(async()=>{try{let d=await api('/api/health');$('health').textContent='Backend online · '+d.version;loadProviders();}catch(e){$('health').textContent='Backend ยังไม่พร้อม';}})();
lucide.createIcons();

/* ===== AI Model Directory V2.2 — local + live HF + detail modal ===== */
let modelsPage = 1;
function modelsMode(){
  const el = document.querySelector('input[name="modelsMode"]:checked');
  return el ? el.value : 'local';
}
async function loadModelsMeta(){
  try{
    const d = await api('/api/models/meta');
    $('modelsMeta').textContent = `V2.3 · Local seed ${d.total.toLocaleString()} โมเดลจริง · ${d.providerCount} providers · Open Source ${(d.openSourceCount||0).toLocaleString()} · Live HF · Insights ${d.catalogInsights?'พร้อม':'—'}`;
    $('modelsStats').textContent = Object.entries(d.categoryCounts||{}).map(([k,v])=>`${k}: ${v.toLocaleString()}`).join(' · ');
    const chips = $('modelsCatChips');
    if (chips) {
      const cats = ['', 'Chat', 'Coding', 'Image', 'Video', 'Audio', 'Reasoning', 'Open Source'];
      chips.innerHTML = cats.map(c => {
        const label = c || 'ทั้งหมด';
        const count = c && d.categoryCounts && d.categoryCounts[c] ? ' ' + d.categoryCounts[c].toLocaleString() : (c === 'Open Source' && d.openSourceCount ? ' ' + d.openSourceCount.toLocaleString() : '');
        return `<button type="button" class="chip" data-cat="${c}">${label}${count}</button>`;
      }).join('');
      chips.querySelectorAll('.chip').forEach(btn => {
        btn.onclick = () => {
          chips.querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
          btn.classList.add('on');
          if ($('modelsCategory')) $('modelsCategory').value = btn.dataset.cat || '';
          searchModels(1);
        };
      });
      const first = chips.querySelector('.chip');
      if (first) first.classList.add('on');
    }
  }catch(e){$('modelsMeta').textContent='โหลด meta ไม่สำเร็จ: '+e.message;}
}
async function searchModels(page=1){
  modelsPage = page;
  const q = $('modelsQuery')?.value||'';
  const category = $('modelsCategory')?.value||'';
  const sort = $('modelsSort')?.value||'downloads';
  const openOnly = $('modelsOpenOnly')?.checked ? '1' : '';
  const mode = modelsMode();
  const params = new URLSearchParams({q, category, sort, openSource: openOnly, page: String(page), limit: '24'});
  const endpoint = mode === 'live' ? '/api/models/live?' : '/api/models?';
  $('modelsModeBadge').textContent = 'mode: ' + mode;
  $('modelsGrid').innerHTML = '<div class="muted col-span-full p-6">กำลังค้นหา'+(mode==='live'?' จาก Hugging Face สด...':'...')+'</div>';
  try{
    const d = await api(endpoint + params.toString());
    const totalLabel = d.total ? d.total.toLocaleString() : '?';
    $('modelsPageInfo').textContent = `หน้า ${d.page}/${d.pages||'?'} · แสดง ${d.items.length} จาก ~${totalLabel} · ${d.mode||mode}`;
    if(!d.items.length){
      $('modelsGrid').innerHTML = '<div class="muted col-span-full p-6">ไม่พบโมเดลที่ตรงเงื่อนไข</div>';
      return;
    }
    $('modelsGrid').innerHTML = d.items.map(m=>`
      <article class="panel p-3 flex flex-col gap-2 hover:border-sky-600 transition-colors cursor-pointer" data-mid="${esc(m.id)}" onclick="openModelDetail(this.dataset.mid)">
        <div class="flex justify-between gap-2 items-start">
          <div class="min-w-0">
            <h3 class="font-semibold text-sm truncate" title="${esc(m.name)}">${esc(m.name)}</h3>
            <p class="text-[11px] muted truncate">${esc(m.provider)} · ${esc(m.id)}</p>
          </div>
          <span class="text-[10px] px-2 py-0.5 rounded-full shrink-0 ${m.openSource?'bg-emerald-900/50 text-emerald-300':'bg-slate-800 text-slate-300'}">${m.openSource?'Open':'Closed'}</span>
        </div>
        <div class="flex flex-wrap gap-1">
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300">${esc(m.category||'')}</span>
          ${m.pipeline?`<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 muted">${esc(m.pipeline)}</span>`:''}
        </div>
        <div class="text-[11px] muted flex gap-3 mt-auto">
          <span>↓ ${(m.downloads||0).toLocaleString()}</span>
          <span>♥ ${(m.likes||0).toLocaleString()}</span>
        </div>
        <span class="text-xs text-sky-400">ดูรายละเอียด & โค้ด →</span>
      </article>`).join('');
  }catch(e){
    $('modelsGrid').innerHTML = `<div class="text-rose-300 col-span-full p-4">${esc(e.message)}</div>`;
  }
}
window.openModelDetail = async function(id){
  const modal = $('modelModal');
  const body = $('modelModalBody');
  if(!modal||!body) return;
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  body.innerHTML = '<p class="muted text-sm">กำลังโหลดรายละเอียด...</p>';
  try{
    const m = await api('/api/models/detail?id='+encodeURIComponent(id));
    const code = m.code || {};
    window.__modelInstall = code.install || '';
    window.__modelPython = code.python || '';
    body.innerHTML = `
      <div>
        <h3 class="font-bold text-lg">${esc(m.name||m.id)}</h3>
        <p class="text-xs muted break-all">${esc(m.id)} · ${esc(m.provider||'')}</p>
      </div>
      <div class="flex flex-wrap gap-2 text-xs">
        <span class="px-2 py-0.5 rounded bg-sky-900/40 text-sky-300">${esc(m.category||'')}</span>
        ${m.pipeline?`<span class="px-2 py-0.5 rounded bg-slate-800">${esc(m.pipeline)}</span>`:''}
        <span class="px-2 py-0.5 rounded ${m.openSource?'bg-emerald-900/40 text-emerald-300':'bg-slate-800'}">${m.openSource?'Open Source':'Closed / Proprietary'}</span>
        <span class="px-2 py-0.5 rounded bg-slate-800 muted">↓ ${(m.downloads||0).toLocaleString()} · ♥ ${(m.likes||0).toLocaleString()}</span>
      </div>
      ${m.tags&&m.tags.length?`<div class="flex flex-wrap gap-1">${m.tags.slice(0,10).map(t=>`<span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 muted">${esc(t)}</span>`).join('')}</div>`:''}
      <p class="text-xs"><a class="text-sky-400 hover:underline" href="${esc(m.hubUrl||m.url)}" target="_blank" rel="noopener">เปิดบน Hugging Face →</a></p>
      <div class="border-t border-slate-700 pt-3 space-y-2">
        <div class="flex justify-between items-center">
          <h4 class="font-semibold text-sm">ติดตั้ง (${esc(code.library||'transformers')})</h4>
          <button class="btn2 text-xs" onclick="copyText(window.__modelInstall)">คัดลอก</button>
        </div>
        <pre class="text-xs bg-[#0b1220] p-3 rounded-lg overflow-x-auto">${esc(code.install||'')}</pre>
        <div class="flex justify-between items-center">
          <h4 class="font-semibold text-sm">ตัวอย่าง Python</h4>
          <button class="btn2 text-xs" onclick="copyText(window.__modelPython)">คัดลอกโค้ด</button>
        </div>
        <pre class="text-xs bg-[#0b1220] p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">${esc(code.python||'')}</pre>
        <p class="text-[11px] muted">ตรวจสอบ model card และ license บน Hugging Face ก่อนใช้งาน production · snippet เป็นจุดเริ่มต้นทั่วไป อาจต้องปรับตาม architecture ของโมเดล</p>
      </div>`;
  }catch(e){
    body.innerHTML = `<p class="text-rose-300 text-sm">${esc(e.message)}</p>`;
  }
};
window.copyText = async function(text){
  try{ await navigator.clipboard.writeText(text||''); alert('คัดลอกแล้ว'); }
  catch{ const ta=document.createElement('textarea'); ta.value=text||''; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); alert('คัดลอกแล้ว'); }
};
$('modelsSearchBtn')&&($('modelsSearchBtn').onclick=()=>searchModels(1));
$('modelsResetBtn')&&($('modelsResetBtn').onclick=()=>{
  $('modelsQuery').value='';$('modelsCategory').value='';$('modelsSort').value='downloads';$('modelsOpenOnly').checked=false;
  const local=document.querySelector('input[name="modelsMode"][value="local"]'); if(local) local.checked=true;
  searchModels(1);
});
$('modelsPrev')&&($('modelsPrev').onclick=()=>{if(modelsPage>1)searchModels(modelsPage-1);});
$('modelsNext')&&($('modelsNext').onclick=()=>searchModels(modelsPage+1));
$('modelModalClose')&&($('modelModalClose').onclick=()=>{ $('modelModal').classList.add('hidden'); $('modelModal').classList.remove('flex'); });
$('modelModal')&&($('modelModal').onclick=(e)=>{ if(e.target===$('modelModal')){ $('modelModal').classList.add('hidden'); $('modelModal').classList.remove('flex'); }});
['modelsQuery'].forEach(id=>{const el=$(id);if(el)el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchModels(1);}});});
document.querySelectorAll('input[name="modelsMode"]').forEach(r=>r.addEventListener('change',()=>searchModels(1)));
document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    if(btn.dataset.tab==='models'){loadModelsMeta();searchModels(1);}
  });
});

/* ===== V2.4 Max extras ===== */
const FAV_KEY = 'aifinder_fav_models';
const COMPARE_KEY = 'aifinder_compare_ids';
function getFavs(){ try{ return JSON.parse(localStorage.getItem(FAV_KEY)||'[]'); }catch{ return []; } }
function setFavs(a){ localStorage.setItem(FAV_KEY, JSON.stringify(a.slice(0,100))); }
function getCompare(){ try{ return JSON.parse(localStorage.getItem(COMPARE_KEY)||'[]'); }catch{ return []; } }
function setCompare(a){ localStorage.setItem(COMPARE_KEY, JSON.stringify([...new Set(a)].slice(0,5))); }

window.toggleFav = function(id){
  let f = getFavs();
  if(f.includes(id)) f = f.filter(x=>x!==id); else f.push(id);
  setFavs(f);
  searchModels(modelsPage);
};
window.toggleCompare = function(id){
  let c = getCompare();
  if(c.includes(id)) c = c.filter(x=>x!==id); else { if(c.length>=5){ alert('เลือกได้สูงสุด 5 โมเดล'); return; } c.push(id); }
  setCompare(c);
  renderCompareBar();
};
function renderCompareBar(){
  const bar = $('modelsCompareBar'); if(!bar) return;
  const c = getCompare();
  if(!c.length){ bar.classList.add('hidden'); bar.innerHTML=''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = 'เปรียบเทียบ: ' + c.map(id=>`<code>${esc(id)}</code>`).join(' · ') + ' <button class="text-sky-400 ml-2" onclick="setCompare([]);renderCompareBar();">ล้าง</button>';
}

// Patch searchModels render to include fav/compare - rewrap by overriding after load
const _searchModelsOrig = typeof searchModels === 'function' ? searchModels : null;
if(_searchModelsOrig){
  window.searchModels = async function(page=1){
    await _searchModelsOrig(page);
    // enhance cards after render
    const favs = getFavs();
    const comps = getCompare();
    document.querySelectorAll('#modelsGrid article[data-mid]').forEach(art=>{
      const id = art.dataset.mid;
      if(art.querySelector('.v24-tools')) return;
      const tools = document.createElement('div');
      tools.className = 'v24-tools flex gap-2 mt-1';
      tools.innerHTML = `<button class="text-[10px] text-amber-300" onclick="event.stopPropagation();toggleFav('${id.replace(/'/g,"\\'")}')">${favs.includes(id)?'★ โปรด':'☆ โปรด'}</button>
        <button class="text-[10px] text-sky-300" onclick="event.stopPropagation();toggleCompare('${id.replace(/'/g,"\\'")}')">${comps.includes(id)?'✓ เทียบ':'＋ เทียบ'}</button>`;
      art.appendChild(tools);
    });
    renderCompareBar();
  };
}

$('modelsFavBtn')&&($('modelsFavBtn').onclick=async()=>{
  const favs = getFavs();
  if(!favs.length){ alert('ยังไม่มีรายการโปรด'); return; }
  $('modelsQuery').value = '';
  $('modelsGrid').innerHTML = '<div class="muted col-span-full p-4">โหลดรายการโปรด...</div>';
  const items = [];
  for(const id of favs.slice(0,24)){
    try{ items.push(await api('/api/models/detail?id='+encodeURIComponent(id))); }catch{}
  }
  if(!items.length){ $('modelsGrid').innerHTML = '<div class="muted col-span-full">โหลดโปรดไม่ได้</div>'; return; }
  $('modelsGrid').innerHTML = items.map(m=>`<article class="panel p-3 cursor-pointer" data-mid="${esc(m.id)}" onclick="openModelDetail(this.dataset.mid)"><b>${esc(m.name)}</b><p class="text-xs muted">${esc(m.id)}</p></article>`).join('');
});

$('modelsExportBtn')&&($('modelsExportBtn').onclick=async()=>{
  const q = $('modelsQuery')?.value||'';
  const category = $('modelsCategory')?.value||'';
  const mode = modelsMode();
  const endpoint = mode==='live'?'/api/models/live?':'/api/models?';
  const params = new URLSearchParams({q, category, page:'1', limit:'100', sort: $('modelsSort')?.value||'downloads'});
  try{
    const d = await api(endpoint+params.toString());
    const blob = new Blob([JSON.stringify({exportedAt:new Date().toISOString(), mode, ...d},null,2)],{type:'application/json'});
    const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='aifinder-models-export.json'; a.click();
  }catch(e){ alert(e.message); }
});

$('modelsCompareBtn')&&($('modelsCompareBtn').onclick=async()=>{
  const c = getCompare();
  if(c.length<2){ alert('เลือกอย่างน้อย 2 โมเดลด้วยปุ่ม ＋ เทียบ'); return; }
  try{
    const d = await api('/api/models/compare?ids='+encodeURIComponent(c.join(',')));
    const body = d.models.map(m=>m.missing?`❌ ${m.id} (ไม่มีใน local seed)`:`${m.id}\n  cat=${m.category} ↓${m.downloads} ♥${m.likes} open=${m.openSource}\n  ${m.url}`).join('\n\n');
    alert('เปรียบเทียบโมเดล\n\n'+body);
  }catch(e){ alert(e.message); }
});

async function loadDash(){
  try{
    const d = await api('/api/stats');
    $('dashCards').innerHTML = [
      ['Local models', d.modelsLocal],
      ['AI Products', d.products],
      ['All links', d.links],
      ['Open source', d.openSourceCount]
    ].map(([t,v])=>`<div class="panel p-4"><div class="text-2xl font-black text-sky-300">${Number(v).toLocaleString()}</div><div class="text-xs muted mt-1">${t}</div></div>`).join('');
    $('dashExtra').innerHTML = `<p>Live: ${esc(d.modelsLiveNote||'')}</p>
      <p class="mt-2">Features: ${(d.features||[]).map(x=>`<span class="chip on">${esc(x)}</span>`).join(' ')}</p>
      <p class="mt-2">Knowledge: ${(d.knowledgeFiles||[]).join(', ')}</p>`;
  }catch(e){ $('dashCards').textContent = e.message; }
}

async function loadProducts(){
  const q = $('productsQuery')?.value||'';
  try{
    const d = await api('/api/ai-products?q='+encodeURIComponent(q));
    $('productsGrid').innerHTML = (d.products||[]).map(p=>`
      <article class="panel p-3">
        <div class="font-semibold">${esc(p.name)}</div>
        <div class="text-[11px] muted">${esc(p.org)} · ${esc(p.category)} · ${esc(p.type)}</div>
        <p class="text-xs mt-2 muted">${esc(p.note||'')}</p>
        <a class="text-xs text-sky-400 mt-2 inline-block" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>
      </article>`).join('') || '<div class="muted">ไม่พบรายการ</div>';
  }catch(e){ $('productsGrid').textContent = e.message; }
}

async function loadLinks(){
  const q = $('linksQuery')?.value||'';
  try{
    const d = await api('/api/all-links?q='+encodeURIComponent(q));
    $('linksList').innerHTML = (d.links||[]).map(l=>`
      <div class="p-2 rounded bg-slate-900 flex flex-wrap justify-between gap-2">
        <div><b>${esc(l.name)}</b> <span class="muted text-xs">${esc(l.category)}</span></div>
        <a class="text-sky-400 text-xs break-all" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a>
      </div>`).join('') || '<div class="muted">ไม่พบลิงก์</div>';
  }catch(e){ $('linksList').textContent = e.message; }
}

$('productsSearchBtn')&&($('productsSearchBtn').onclick=()=>loadProducts());
$('linksSearchBtn')&&($('linksSearchBtn').onclick=()=>loadLinks());
$('productsQuery')&&$('productsQuery').addEventListener('keydown',e=>{ if(e.key==='Enter') loadProducts(); });
$('linksQuery')&&$('linksQuery').addEventListener('keydown',e=>{ if(e.key==='Enter') loadLinks(); });

// prompt templates
(async()=>{
  try{
    const d = await api('/api/prompt-templates');
    const sel = $('promptTemplates'); if(!sel) return;
    sel.innerHTML = '<option value="">— เลือกแม่แบบ —</option>' + (d.templates||[]).map(t=>`<option value="${esc(t.prompt)}">${esc(t.title)}</option>`).join('');
    sel.onchange = ()=>{ if(sel.value && $('message')) $('message').value = sel.value; };
  }catch{}
})();

document.querySelectorAll('.tab').forEach(btn=>{
  btn.addEventListener('click',()=>{
    if(btn.dataset.tab==='dash') loadDash();
    if(btn.dataset.tab==='products') loadProducts();
    if(btn.dataset.tab==='links') loadLinks();
  });
});

// Serve data files note: static already serves public only; links download may 404 - use API export instead
if($('links') && document.querySelector('a[href="/data/all-links.txt"]')){
  document.querySelector('a[href="/data/all-links.txt"]').onclick = async (e)=>{
    e.preventDefault();
    try{
      const d = await api('/api/all-links');
      const txt = (d.links||[]).map(l=>l.url).join('\n');
      const blob = new Blob([txt],{type:'text/plain'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='aifinder-all-links.txt'; a.click();
    }catch(err){ alert(err.message); }
  };
}
