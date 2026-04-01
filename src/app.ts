import express from 'express';
import pinoHttp from 'pino-http';
import pino from 'pino';
import { loadConfig } from './config';

type ApiMethod = 'GET' | 'POST' | 'DELETE';

function parseCookie(req: express.Request, key: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === key) return decodeURIComponent(v.join('='));
  }
  return null;
}

function getBusinessNumberFromSession(req: express.Request): number | null {
  const value = parseCookie(req, 'businessNumber');
  if (!value || !/^\d{10}$/.test(value)) return null;
  return Number(value);
}

const loginPageHtml = `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Echo Login</title>
<style>body{font-family:system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f7fb}.card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.1);width:min(420px,90vw)}input,button{width:100%;padding:12px;margin-top:10px;font-size:15px}button{cursor:pointer;background:#111;color:#fff;border:0;border-radius:8px}small{color:#666}</style>
</head><body><form class="card" method="post" action="/login"><h2>Business Login</h2><small>Enter your 10-digit business number</small><input name="businessNumber" pattern="\\d{10}" maxlength="10" minlength="10" required placeholder="7145551234" /><button type="submit">Continue</button></form></body></html>`;

const appPageHtml = `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Echo Messages</title>
<style>
*{box-sizing:border-box} body{margin:0;font-family:system-ui;background:#f7f8fb;color:#111}
.wrap{display:grid;grid-template-columns:300px 1fr;height:100dvh}
.side{border-right:1px solid #ddd;background:#fff;display:flex;flex-direction:column;min-height:0}
.head{padding:12px;border-bottom:1px solid #eee;font-weight:700;display:flex;justify-content:space-between;gap:8px;align-items:center}
.list{overflow:auto;min-height:0}
.conv{padding:10px 12px;border-bottom:1px solid #f1f1f1;cursor:pointer}
.conv.active{background:#eef4ff}.conv .num{font-weight:600}.conv.unread .num,.conv.unread .last{font-weight:700}
.conv .last{font-size:13px;color:#444;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{display:flex;flex-direction:column;min-height:0}
.threadHead{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid #ddd;background:#fff}
.threadHead input{flex:1;padding:10px;border:1px solid #ccc;border-radius:8px}
.threadHead .title{font-weight:700;flex:1}
.threadHead button{border:0;background:#f1f2f5;border-radius:8px;padding:8px 10px;cursor:pointer}
#threadMenuDropdown{position:absolute;background:#fff;border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);z-index:100;min-width:150px;overflow:hidden}
#threadMenuDropdown button{display:block;width:100%;padding:10px 16px;text-align:left;background:none;border:0;border-radius:0;cursor:pointer;font-size:14px}
#threadMenuDropdown button:hover{background:#f5f7fb}
#threadMenuDropdown button.danger{color:#c00}
.msgs{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:0}
.msg{max-width:78%;padding:10px 12px;border-radius:12px;word-break:break-word}
.in{background:#fff;border:1px solid #e4e4e4;align-self:flex-start}
.out{background:#dff1ff;align-self:flex-end}
.meta{font-size:11px;color:#555;margin-top:4px;display:flex;justify-content:space-between;gap:8px}
.compose{display:flex;gap:8px;padding:10px;border-top:1px solid #ddd;background:#fff;padding-bottom:calc(10px + env(safe-area-inset-bottom))}
.compose input{flex:1;padding:12px;border:1px solid #ccc;border-radius:8px}
.compose button{padding:0 16px;border:0;background:#1b5cff;color:white;border-radius:8px;cursor:pointer}
.empty{padding:20px;color:#666}
@media (max-width: 820px){ .wrap{grid-template-columns:40% 60%} .msg{max-width:88%} }
</style></head>
<body><div class="wrap"><aside class="side"><div class="head"><span>Conversations</span><div><button onclick="startNew()">+ New</button> <button onclick="logout()">Logout</button></div></div><div id="conversations" class="list"></div></aside>
<main class="main"><div class="threadHead"><div id="threadTitle" class="title">Select a conversation</div><input id="customerInput" style="display:none" inputmode="numeric" maxlength="11" placeholder="10-digit customer number"/><div style="position:relative"><button id="threadMenu" style="display:none" onclick="toggleThreadMenu(event)">⋮</button><div id="threadMenuDropdown" style="display:none"><button onclick="threadMenuAction('unread')">Mark unread</button><button class="danger" onclick="threadMenuAction('delete')">Delete</button></div></div></div><div id="messages" class="msgs"><div class="empty">Select a conversation</div></div>
<form id="compose" class="compose" style="display:none"><input id="text" placeholder="Type a message..." maxlength="2048"/><button type="submit">Send</button></form></main></div>
<script>
let currentCustomer = null; let draftingNew=false;
function normalizeNum(v){ const d=String(v||'').replace(/\D/g,''); return (d.length===11&&d.startsWith('1'))?d.slice(1):d; }
function iconForEvent(e){ if(Number(e)===1)return '📩'; if(Number(e)===2)return '🕓'; if(Number(e)===4)return '✅'; if(Number(e)===8)return '❌'; return '💬'; }
function setThreadHeader(){
  const title=document.getElementById('threadTitle'); const input=document.getElementById('customerInput'); const menu=document.getElementById('threadMenu');
  if(draftingNew){ title.style.display='none'; input.style.display='block'; menu.style.display='none'; input.focus(); }
  else if(currentCustomer){ title.style.display='block'; title.textContent='Customer '+currentCustomer; input.style.display='none'; menu.style.display='inline-block'; }
  else { title.style.display='block'; title.textContent='Select a conversation'; input.style.display='none'; menu.style.display='none'; }
}
async function logout(){ await fetch('/logout',{method:'POST'}); location.href='/'; }
function startNew(){ draftingNew=true; currentCustomer=null; document.getElementById('messages').innerHTML='<div class="empty">Enter a customer number and draft message</div>'; document.getElementById('compose').style.display='flex'; setThreadHeader(); }
async function loadConversations(){
  const r=await fetch('/api/conversations'); if(!r.ok){location.href='/';return;} const data=await r.json();
  const root=document.getElementById('conversations'); root.innerHTML='';
  for(const c of data.items){
    const el=document.createElement('div'); const active=!draftingNew && String(c.iCustomerNumber)===String(currentCustomer);
    el.className='conv'+((Number(c.unreadCount||0)>0)?' unread':'')+(active?' active':'');
    el.innerHTML='<div class="num">'+c.iCustomerNumber+' <span style="font-size:12px">'+iconForEvent(c.lastEventType)+'</span></div><div class="last">'+(c.lastText||'')+'</div>';
    el.onclick=()=>openConversation(c.iCustomerNumber);
    root.appendChild(el);
  }
}
function toggleThreadMenu(e){
  e.stopPropagation();
  const dd=document.getElementById('threadMenuDropdown');
  dd.style.display=dd.style.display==='none'?'block':'none';
}
async function threadMenuAction(action){
  document.getElementById('threadMenuDropdown').style.display='none';
  if(!currentCustomer) return;
  if(action==='unread'){ await fetch('/api/conversations/'+currentCustomer+'/mark-unread',{method:'POST'}); await loadConversations(); }
  if(action==='delete' && confirm('Delete entire conversation?')){ await fetch('/api/conversations/'+currentCustomer,{method:'DELETE'}); currentCustomer=null; draftingNew=false; document.getElementById('messages').innerHTML='<div class="empty">Select a conversation</div>'; document.getElementById('compose').style.display='none'; setThreadHeader(); await loadConversations(); }
}
document.addEventListener('click',()=>{ const dd=document.getElementById('threadMenuDropdown'); if(dd) dd.style.display='none'; });
async function openConversation(customer, skipRead){
  draftingNew=false; currentCustomer=String(customer); setThreadHeader();
  const r=await fetch('/api/conversations/'+customer+'/messages'); const data=await r.json();
  const box=document.getElementById('messages'); box.innerHTML='';
  for(const m of data.items){
    const el=document.createElement('div'); el.className='msg '+(Number(m.bInbound)===1?'in':'out');
    el.innerHTML='<div>'+((m.text||'').replace(/</g,'&lt;'))+'</div><div class="meta"><span>'+iconForEvent(m.eMessageEventTypeID)+' '+m.dtCreated+'</span><button style="border:0;background:transparent;cursor:pointer" data-mid="'+m.iMessageId+'">⋯</button></div>';
    el.onclick=async(ev)=>{ if(ev.target&&ev.target.dataset&&ev.target.dataset.mid){ if(confirm('Delete this message?')){ await fetch('/api/messages/'+ev.target.dataset.mid,{method:'DELETE'}); await openConversation(customer,true); await loadConversations(); } } };
    box.appendChild(el);
  }
  box.scrollTop=box.scrollHeight; document.getElementById('compose').style.display='flex';
  if(!skipRead){ await fetch('/api/conversations/'+customer+'/read',{method:'POST'}); await loadConversations(); }
}

document.getElementById('compose').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const txt=document.getElementById('text');
  let to=currentCustomer;
  if(draftingNew){ to=normalizeNum(document.getElementById('customerInput').value); if(!/^\d{10}$/.test(to||'')){ alert('Use a 10-digit US number'); return; } currentCustomer=to; draftingNew=false; }
  if(!to) return;
  const r=await fetch('/api/conversations/'+to+'/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:txt.value})});
  const data=await r.json(); txt.value=''; await openConversation(to,true); await loadConversations(); if(data&&data.ok===false){ alert('Carrier failure: '+(typeof data.details==='string'?data.details:JSON.stringify(data.details))); }
});
setThreadHeader(); loadConversations();
</script></body></html>`;

async function proxyEchoService(config: ReturnType<typeof loadConfig>, req: express.Request, path: string, method: ApiMethod, body?: unknown) {
  const business = getBusinessNumberFromSession(req);
  if (!business) return { status: 401, data: { error: 'Not logged in' } };

  const url = new URL(path, config.ECHO_SERVICE_BASE_URL);
  if (method === 'GET' || method === 'DELETE') url.searchParams.set('businessNumber', String(business));

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify({ businessNumber: business, ...(body && typeof body === 'object' ? body : {}) })
  });

  const data = await response.json().catch(() => ({ error: 'Invalid response from EchoService' }));
  return { status: response.status, data };
}

export function buildApp() {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(pinoHttp({ logger }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'EchoWeb' });
  });

  app.get('/', (req, res) => {
    const business = getBusinessNumberFromSession(req);
    if (!business) return res.type('html').send(loginPageHtml);
    return res.type('html').send(appPageHtml);
  });

  app.post('/login', (req, res) => {
    const businessNumber = String(req.body?.businessNumber ?? '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(businessNumber)) {
      return res.status(400).send('Business number must be 10 digits');
    }
    res.setHeader('Set-Cookie', `businessNumber=${businessNumber}; Path=/; HttpOnly; SameSite=Lax`);
    return res.redirect('/');
  });

  app.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'businessNumber=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    return res.redirect('/');
  });

  app.get('/api/conversations', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, '/api/conversations', 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/conversations/:customer/messages', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/messages`, 'GET');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/read', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/read`, 'POST');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/mark-unread', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/mark-unread`, 'POST');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/messages/:messageId', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/messages/${encodeURIComponent(req.params.messageId)}`, 'DELETE');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/conversations/:customer', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}`, 'DELETE');
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/conversations/:customer/send', async (req, res, next) => {
    try {
      const result = await proxyEchoService(config, req, `/api/conversations/${encodeURIComponent(req.params.customer)}/send`, 'POST', { text: req.body?.text ?? '' });
      return res.status(result.status).json(result.data);
    } catch (error) {
      next(error);
    }
  });

  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
