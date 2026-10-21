'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Core = require('./core');
const { openDatabase } = require('./database');
const { openAuth } = require('./auth');
const { moderateText } = require('./moderation');
const { encodeCSV, decodeCSV } = require('./csv');
if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3000), HOST = process.env.HOST || '0.0.0.0';
const MINUTE_LIMIT = Number(process.env.MAX_SUBMISSIONS_PER_MINUTE || 20), HOUR_LIMIT = Number(process.env.MAX_SUBMISSIONS_PER_HOUR || 200);
const BLOCKED = new Set((process.env.MODERATION_WORDS || '').split(',').map((word) => Core.normalizeWord(word).toLowerCase()).filter(Boolean));
const PUBLIC_FILES = new Set(['index.html','style.css','app.js','core.js','effects.js','admin.html','admin.css','admin.js','ui.js','ui.css','offline.js','extensions.js','extensions.css','sw.js','manifest.webmanifest','icon.svg','vendor/version.js','vendor/qrcode.js','vendor/icon-192.png','vendor/icon-512.png']);
const database = openDatabase(path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')));
const auth = openAuth(database.filename, process.env.ADMIN_TOKEN || '');
database.ensure('default');
const clients = new Set();
const validSlug = (slug) => typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,48}$/.test(slug);
const hash = (value) => crypto.createHmac('sha256', database.secret).update(value).digest('hex');
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function json(res, status, data) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' }); res.end(JSON.stringify(data)); }
function visitor(req, res, slug) {
  let raw = /(?:^|;\s*)inner-light-visitor=([^;]*)/.exec(req.headers.cookie || '')?.[1];
  if (!raw || !/^[a-f0-9-]{36}$/.test(raw)) { raw = crypto.randomUUID(); res.setHeader('Set-Cookie', `inner-light-visitor=${raw}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${req.socket.encrypted ? '; Secure' : ''}`); }
  const key = hash(raw); database.visit(slug,key); return key;
}
async function body(req, limit = 4096) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > limit) fail(413,'请求内容过大。'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'请求必须是 JSON 对象。'); return value; }
  catch (error) { fail(error.status || 400, error.status ? error.message : '请求格式不正确。'); }
}
function broadcast(slug, event) {
  for (const client of clients) if (client.slug === slug && !client.res.destroyed) client.res.write(`id: ${event.version}\ndata: ${JSON.stringify(event)}\n\n`);
}
function planetSettings(value, defaults = {}) {
  const next = { name: defaults.name, description: defaults.description ?? '', theme: defaults.theme ?? 'nebula', reviewMode: defaults.reviewMode ?? false, ...value };
  if (typeof next.name !== 'string' || !next.name.trim() || Core.graphemes(next.name.trim()).length > 50 ||
      typeof next.description !== 'string' || Core.graphemes(next.description).length > 200 ||
      !['nebula','ocean','forest'].includes(next.theme) || typeof next.reviewMode !== 'boolean') fail(422,'名称、描述、主题或审核模式不合法。');
  return { name: next.name.trim(), description: next.description, theme: next.theme, reviewMode: next.reviewMode };
}
function secureCookie(token, age) { return `il-admin=${token}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Strict${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`; }
function sameOrigin(req) {
  if (!req.headers.origin) return;
  let origin; try { origin = new URL(req.headers.origin); } catch (_) { fail(403,'不允许跨站提交。'); }
  if (origin.host !== req.headers.host) fail(403,'不允许跨站提交。');
}
async function api(req,res,pathname,query) {
  if (pathname === '/api/health') return json(res,200,{ok:true,storage:'sqlite',moderation:process.env.MODERATION_URL ? 'configured' : 'manual-only'});
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const value = await body(req); const result = auth.login(value.name,value.password,req.socket.remoteAddress || 'unknown');
    res.setHeader('Set-Cookie', secureCookie(result.token,43200)); return json(res,200,{user:result.user});
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') { auth.logout(req); res.setHeader('Set-Cookie',secureCookie('',0)); return json(res,200,{ok:true}); }
  if (pathname === '/api/auth/me') return json(res,200,{user:auth.me(auth.authenticate(req))});
  if (pathname.startsWith('/api/admin/')) {
    const user = auth.authenticate(req);
    if (pathname === '/api/admin/users') {
      if (req.method === 'GET') return json(res,200,{items:auth.list(user)});
      if (req.method === 'POST') return json(res,201,{user:auth.create(user,await body(req))});
    }
    const userMatch = /^\/api\/admin\/users\/(\d+)$/.exec(pathname);
    if (userMatch && req.method === 'POST') return json(res,200,{user:auth.update(user,Number(userMatch[1]),await body(req))});
    if (pathname === '/api/admin/system' && req.method === 'GET') {
      auth.authorize(user,'default','settings');
      return json(res,200,{uptime:process.uptime(),storage:'sqlite',moderation:process.env.MODERATION_URL ? 'configured' : 'manual-only',rateLimits:{minute:MINUTE_LIMIT,hour:HOUR_LIMIT},blockedWordsCount:BLOCKED.size,sseClients:clients.size});
    }
    if (pathname === '/api/admin/planets') {
      if (req.method === 'GET') return json(res,200,{items:database.listPlanets().filter((p)=>user.planets.includes('*')||user.planets.includes(p.slug))});
      if (req.method === 'POST') {
        const value = await body(req);
        if (!validSlug(value.slug)) fail(422,'星球地址不合法。');
        auth.authorize(user,value.slug,'settings');
        const settings = planetSettings(value);
        if (value.seed !== undefined && typeof value.seed !== 'boolean') fail(422,'seed 需为布尔值。');
        return json(res,201,{ok:true,...database.createPlanet(value.slug,{...settings,seed:value.seed ?? true,actor:user.name})});
      }
    }
    const slug = query.get('planet') || 'default'; if (!validSlug(slug)) fail(400,'星球地址不合法。');
    const isReview = /^\/api\/admin\/reviews\/(?:batch|\d+)$/.test(pathname);
    const isWordModeration = pathname.startsWith('/api/admin/words/');
    auth.authorize(user,slug,req.method === 'GET' ? 'read' : isReview || isWordModeration ? 'review' : 'settings');
    if (!database.exists(slug)) fail(404,'星球不存在，请显式创建。');
    const stateResult = (state) => { broadcast(slug,{type:'snapshot',...state}); return json(res,200,{ok:true,...state}); };
    if (req.method === 'GET' && ['/api/admin/export','/api/admin/words'].includes(pathname)) return json(res,200,database.export(slug));
    if (req.method === 'GET' && pathname === '/api/admin/export.csv') { res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="inner-light-${slug}.csv"`,'Cache-Control':'no-store'}); return res.end(encodeCSV(database.export(slug).words)); }
    if (req.method === 'GET' && pathname === '/api/admin/reviews') return json(res,200,{items:database.queue(slug)});
    if (req.method === 'POST' && pathname === '/api/admin/words') {
      auth.authorize(user,slug,'settings');
      const value = await body(req);
      return stateResult(database.upsertWord(slug,value.word,value.frequency,user.name));
    }
    if (req.method === 'POST' && pathname === '/api/admin/words/batch') {
      const value = await body(req,32768);
      return stateResult(database.moderateBatch(slug,value.words,value.action,user.name));
    }
    if (req.method === 'POST' && pathname === '/api/admin/reviews/batch') {
      auth.authorize(user,slug,'review');
      const value = await body(req);
      const result = database.reviewBatch(slug,value.ids,value.decision,user.name);
      return stateResult(result);
    }
    const review = /^\/api\/admin\/reviews\/(\d+)$/.exec(pathname);
    if (review && req.method === 'POST') { const v = await body(req); return stateResult(database.review(slug,Number(review[1]),v.decision,user.name)); }
    if (req.method === 'POST' && pathname === '/api/admin/import') {
      auth.authorize(user,slug,'import'); const v = await body(req,5*1024*1024);
      if (v.mode === 'replace' && v.confirm !== slug) fail(422,'替换恢复必须输入星球 slug 确认。');
      return stateResult(database.importData(slug,v.format === 'csv' ? decodeCSV(v.content) : v.data,{mode:v.mode,actor:user.name}));
    }
    const wordMatch = /^\/api\/admin\/words\/(.+?)(\/restore)?$/.exec(pathname);
    if (wordMatch && ((req.method === 'DELETE' && !wordMatch[2]) || (req.method === 'POST' && wordMatch[2]))) {
      let word; try { word = decodeURIComponent(wordMatch[1]); } catch (_) { fail(400,'无效词语编码。'); }
      return stateResult(database.moderate(slug,word,wordMatch[2] ? 'restore' : 'hide',user.name));
    }
    if (pathname === '/api/admin/clear' && req.method === 'POST') return stateResult(database.moderate(slug,null,'clear',user.name));
    if (pathname === '/api/admin/planet' && req.method === 'POST') {
      const value = await body(req);
      const settings = planetSettings(value,database.snapshot(slug).planet);
      return stateResult(database.updatePlanet(slug,{...settings,actor:user.name}));
    }
    fail(404,'管理接口不存在。');
  }
  const match = /^\/api\/planets\/([^/]+)\/(words|recent|stats|events|analytics|relations)$/.exec(pathname);
  if (!match || !validSlug(match[1])) fail(404,'接口不存在。');
  const [,slug,resource] = match; if (!database.exists(slug)) fail(404,'星球不存在，请由管理员创建。');
  const identity = visitor(req,res,slug);
  if (req.method === 'GET') {
    if (resource === 'words') return json(res,200,database.snapshot(slug));
    if (resource === 'recent') { const n=Number(query.get('limit')||20); if(!Number.isInteger(n)||n<1||n>50)fail(422,'limit 需为 1–50 的整数。');return json(res,200,{items:database.recent(slug,n)}); }
    if (resource === 'stats') return json(res,200,database.stats(slug));
    if (resource === 'analytics') { const days=Number(query.get('days')||7);if(![7,30,90].includes(days))fail(422,'days 必须是 7、30 或 90。');return json(res,200,database.analytics(slug,days)); }
    if (resource === 'relations') return json(res,200,database.relations(slug));
    if (resource === 'events') {
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});
      const state=database.snapshot(slug);res.write(`retry: 3000\nid: ${state.version}\ndata: ${JSON.stringify({type:'snapshot',...state})}\n\n`);
      const client={res,slug};clients.add(client);const heartbeat=setInterval(()=>{database.visit(slug,identity);res.write(': heartbeat\n\n');},20000);
      res.on('close',()=>{clearInterval(heartbeat);clients.delete(client)});return;
    }
  }
  if (req.method === 'POST' && resource === 'words') {
    const value=await body(req);const checked=Core.validateWord(value.word);if(!checked.ok)fail(422,checked.error);
    const requestId=value.requestId || crypto.randomUUID();if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))fail(422,'requestId 不合法。');
    const existing=database.requestResult(slug,identity,requestId);if(existing)return json(res,existing.status==='approved'?201:202,{ok:true,...existing});
    const ip=process.env.TRUST_PROXY==='1'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim():req.socket.remoteAddress;
    if(!database.rate([`ip:${hash(ip||'unknown')}`,`visitor:${identity}`],MINUTE_LIMIT,HOUR_LIMIT))fail(429,'发送太频繁了，请稍后再试。');
    if(BLOCKED.has(checked.word.toLowerCase()))fail(422,'这个词语暂时不能加入公共星球。');
    const decision=await moderateText(checked.word,{reviewMode:database.snapshot(slug).planet.reviewMode});
    const event=database.submit(slug,checked.word,identity,{requestId,...decision});
    if(event.status==='approved'&&!event.deduplicated)broadcast(slug,event);
    return json(res,event.status==='approved'?201:202,{ok:true,...event});
  }
  fail(405,'不支持的操作。');
}
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  try{
    if(['POST','DELETE'].includes(req.method))sameOrigin(req);
    const parsed=new URL(req.url,'http://localhost');if(parsed.pathname.startsWith('/api/'))return await api(req,res,parsed.pathname,parsed.searchParams);
    if(!['GET','HEAD'].includes(req.method))fail(405,'不支持的操作。');
    const file=parsed.pathname==='/'?'index.html':parsed.pathname==='/admin'?'admin.html':parsed.pathname.slice(1);if(!PUBLIC_FILES.has(file))fail(404,'Not found');
    const content=fs.readFileSync(path.join(__dirname,file));res.writeHead(200,{'Content-Type':`${types[path.extname(file)]||'application/octet-stream'}; charset=utf-8`,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:content);
  }catch(error){if(res.headersSent)return res.destroy();if(!error.status)console.error(error);json(res,error.status||500,{message:error.status?error.message:'服务器暂时不可用。'});}
});
server.requestTimeout=15000;
server.listen(PORT,HOST,()=>console.log(`Inner Light: http://localhost:${PORT} | SQLite: ${database.filename}`));
function shutdown(){for(const c of clients)c.res.end();server.close(()=>{auth.close();database.close();process.exit(0)});setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
