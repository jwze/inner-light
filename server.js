'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Core = require('./core.js');
const { openDatabase } = require('./database.js');
if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MINUTE_LIMIT = Number(process.env.MAX_SUBMISSIONS_PER_MINUTE || 20);
const HOUR_LIMIT = Number(process.env.MAX_SUBMISSIONS_PER_HOUR || 200);
const BLOCKED = new Set((process.env.MODERATION_WORDS || '').split(',').map((w) => Core.normalizeWord(w).toLowerCase()).filter(Boolean));
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'app.js', 'core.js', 'effects.js', 'admin.html']);
const database = openDatabase(path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')));
database.ensure('default');
const clients = new Set();
const validSlug = (slug) => typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,48}$/.test(slug);
const hash = (value) => crypto.createHmac('sha256', database.secret).update(value).digest('hex');
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function visitor(req, res, slug) {
  let raw = /(?:^|;\s*)inner-light-visitor=([^;]*)/.exec(req.headers.cookie || '')?.[1];
  if (!raw || !/^[a-f0-9-]{36}$/.test(raw)) {
    raw = crypto.randomUUID();
    res.setHeader('Set-Cookie', `inner-light-visitor=${raw}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax${req.socket.encrypted ? '; Secure' : ''}`);
  }
  const key = hash(raw);
  database.visit(slug, key);
  return key;
}
async function body(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) fail(413, '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '请求必须是 JSON 对象。');
    return value;
  } catch (error) { fail(error.status || 400, error.status ? error.message : '请求格式不正确。'); }
}
function broadcast(slug, event) {
  for (const client of clients) if (client.slug === slug && !client.res.destroyed) client.res.write(`id: ${event.version}\ndata: ${JSON.stringify(event)}\n\n`);
}
function authorize(req) {
  const token = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const expected = Buffer.from(ADMIN_TOKEN);
  if (!expected.length || token.length !== expected.length || !crypto.timingSafeEqual(token, expected)) fail(401, '需要管理员权限。');
}
function sameOrigin(req) {
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch (_) { fail(403, '不允许跨站提交。'); }
    if (origin.host !== req.headers.host) fail(403, '不允许跨站提交。');
  }
}
async function api(req, res, pathname, query) {
  if (pathname === '/api/health') return json(res, 200, { ok: true, storage: 'sqlite' });
  if (pathname.startsWith('/api/admin/')) {
    authorize(req);
    const slug = query.get('planet') || 'default';
    if (!validSlug(slug)) fail(400, '星球地址不合法。');
    database.ensure(slug);
    if (req.method === 'GET' && ['/api/admin/export', '/api/admin/words'].includes(pathname)) return json(res, 200, database.export(slug));
    const match = /^\/api\/admin\/words\/(.+?)(\/restore)?$/.exec(pathname);
    if (match && ((req.method === 'DELETE' && !match[2]) || (req.method === 'POST' && match[2]))) {
      const state = database.moderate(slug, decodeURIComponent(match[1]), match[2] ? 'restore' : 'hide');
      broadcast(slug, { type: 'snapshot', ...state });
      return json(res, 200, { ok: true, ...state });
    }
    if (pathname === '/api/admin/clear' && req.method === 'POST') {
      const state = database.moderate(slug, null, 'clear');
      broadcast(slug, { type: 'snapshot', ...state });
      return json(res, 200, { ok: true, ...state });
    }
    if (pathname === '/api/admin/planet' && req.method === 'POST') {
      const value = await body(req);
      if (typeof value.name !== 'string' || !value.name.trim() || Core.graphemes(value.name.trim()).length > 50 || !['nebula', 'ocean', 'forest'].includes(value.theme)) fail(422, '名称需为 1–50 字，主题需为 nebula/ocean/forest。');
      const state = database.updatePlanet(slug, { name: value.name.trim(), theme: value.theme });
      broadcast(slug, { type: 'snapshot', ...state });
      return json(res, 200, { ok: true, ...state });
    }
    fail(404, '管理接口不存在。');
  }
  const match = /^\/api\/planets\/([^/]+)\/(words|recent|stats|events)$/.exec(pathname);
  if (!match || !validSlug(match[1])) fail(404, '接口不存在或星球地址不合法。');
  const [, slug, resource] = match;
  if (!database.exists(slug)) fail(404, '星球不存在，请先由管理员在后台创建。');
  const identity = visitor(req, res, slug);
  if (req.method === 'GET') {
    if (resource === 'words') return json(res, 200, database.snapshot(slug));
    if (resource === 'recent') {
      const n = Number(query.get('limit') || 20);
      if (!Number.isInteger(n) || n < 1 || n > 50) fail(422, 'limit 需为 1–50 的整数。');
      return json(res, 200, { items: database.recent(slug, n) });
    }
    if (resource === 'stats') return json(res, 200, database.stats(slug));
    if (resource === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const state = database.snapshot(slug);
      res.write(`retry: 3000\nid: ${state.version}\ndata: ${JSON.stringify({ type: 'snapshot', ...state })}\n\n`);
      const client = { res, slug, identity };
      clients.add(client);
      const heartbeat = setInterval(() => {
        database.visit(slug, identity);
        res.write(': heartbeat\n\n');
      }, 20000);
      res.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
      return;
    }
  }
  if (req.method === 'POST' && resource === 'words') {
    const ip = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
    if (!database.rate([`ip:${hash(ip || 'unknown')}`, `visitor:${identity}`], MINUTE_LIMIT, HOUR_LIMIT)) fail(429, '发送太频繁了，请稍后再试。');
    const value = await body(req);
    const checked = Core.validateWord(value.word);
    if (!checked.ok) fail(422, checked.error);
    if (BLOCKED.has(checked.word.toLowerCase())) fail(422, '这个词语暂时不能加入公共星球。');
    const event = database.submit(slug, checked.word, identity);
    broadcast(slug, event);
    return json(res, 201, { ok: true, ...event });
  }
  fail(405, '不支持的操作。');
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (['POST', 'DELETE'].includes(req.method)) sameOrigin(req);
    const parsed = new URL(req.url, 'http://localhost');
    if (parsed.pathname.startsWith('/api/')) return await api(req, res, parsed.pathname, parsed.searchParams);
    if (!['GET', 'HEAD'].includes(req.method)) fail(405, '不支持的操作。');
    const file = parsed.pathname === '/' ? 'index.html' : parsed.pathname === '/admin' ? 'admin.html' : parsed.pathname.slice(1);
    if (!PUBLIC_FILES.has(file)) fail(404, 'Not found');
    const content = fs.readFileSync(path.join(__dirname, file));
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (!error.status) console.error(error);
    json(res, error.status || 500, { message: error.status ? error.message : '服务器暂时不可用。' });
  }
});
server.requestTimeout = 15000;
server.listen(PORT, HOST, () => console.log(`Inner Light: http://localhost:${PORT} | SQLite: ${database.filename}`));
function shutdown() {
  for (const client of clients) client.res.end();
  server.close(() => { database.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
