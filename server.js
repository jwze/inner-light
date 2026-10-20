const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const url = require('node:url');
const Core = require('./core.js');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_RECENT = 100;
const MAX_WORDS = Core.MAX_WORDS;
const MAX_SUBMISSIONS_PER_MINUTE = Number(process.env.MAX_SUBMISSIONS_PER_MINUTE || 20);
const MAX_SUBMISSIONS_PER_HOUR = Number(process.env.MAX_SUBMISSIONS_PER_HOUR || 200);
const BLOCKED_WORDS = new Set(String(process.env.MODERATION_WORDS || '').split(',').map((word) => Core.normalizeWord(word).toLocaleLowerCase()).filter(Boolean));
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'app.js', 'core.js', 'effects.js', 'admin.html']);
const stores = new Map();
const clients = new Set();
const rateBuckets = new Map();
const activeVisitors = new Map();
const writeQueues = new Map();
fs.mkdirSync(path.join(DATA_DIR, 'planets'), { recursive: true });

function validSlug(slug) { return /^[a-z0-9][a-z0-9-]{0,48}$/i.test(slug); }
function storePath(slug) { return slug === 'default' ? path.join(DATA_DIR, 'planet.json') : path.join(DATA_DIR, 'planets', `${slug}.json`); }

function defaultData(slug) {
  const seedWords = Core.randomSamples();
  return {
    version: 1,
    planet: {
      slug,
      name: slug === 'default' ? '同频宇宙' : slug.replace(/-/g, ' '),
      description: '每一个念头，都可能遇见同频的光。',
      theme: 'nebula',
      createdAt: new Date().toISOString()
    },
    words: seedWords,
    submissions: [],
    totalSubmissions: seedWords.reduce((sum, item) => sum + item.frequency, 0),
    visitors: 0,
    lastEventId: 0
  };
}

function loadData(slug) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(slug), 'utf8'));
    const fallback = defaultData(slug);
    const data = { ...fallback, ...parsed, planet: { ...fallback.planet, ...(parsed.planet || {}), slug } };
    data.words = Core.createEntries(data.words);
    data.submissions = Array.isArray(data.submissions) ? data.submissions.slice(-MAX_RECENT) : [];
    data.totalSubmissions = Number(data.totalSubmissions) || data.submissions.length;
    data.visitors = Number(data.visitors) || 0;
    data.lastEventId = Number(data.lastEventId) || 0;
    return data;
  } catch (_) {
    return defaultData(slug);
  }
}

function getStore(slug) {
  if (!stores.has(slug)) {
    const store = loadData(slug);
    stores.set(slug, store);
    if (!fs.existsSync(storePath(slug))) saveData(slug, store).catch((error) => console.error(error));
  }
  return stores.get(slug);
}

function saveData(slug, store) {
  const target = storePath(slug);
  const snapshot = JSON.stringify(store, null, 2);
  const previous = writeQueues.get(slug) || Promise.resolve();
  const next = previous.then(async () => {
    const temporary = `${target}.tmp`;
    await fs.promises.writeFile(temporary, snapshot);
    await fs.promises.rename(temporary, target);
  });
  writeQueues.set(slug, next.catch(() => {}));
  return next;
}

function json(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    ...headers
  });
  response.end(payload);
}

function text(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

function stats(store, slug) {
  const today = new Date().toISOString().slice(0, 10);
  const now = Date.now();
  for (const [key, timestamp] of activeVisitors) if (now - timestamp > 15 * 60 * 1000) activeVisitors.delete(key);
  return {
    wordCount: store.words.length,
    totalSubmissions: store.totalSubmissions,
    todaySubmissions: store.submissions.filter((item) => item.createdAt.slice(0, 10) === today).length,
    activeVisitors: Array.from(activeVisitors.keys()).filter((key) => key.startsWith(`${slug}:`)).length,
    uniqueVisitors: store.visitors
  };
}

function publicSummary(store, slug) {
  return {
    planet: store.planet,
    version: store.lastEventId,
    items: store.words,
    stats: stats(store, slug),
    recent: store.submissions.slice(-20).reverse().map(({ id, word, createdAt }) => ({ id, word, createdAt }))
  };
}

function publicEvent(slug, event) {
  const payload = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) if (client.slug === slug) client.response.write(payload);
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

function visitorContext(request, slug) {
  const cookie = cookies(request)['inner-light-visitor'];
  const id = cookie && /^[a-f0-9-]{16,80}$/i.test(cookie) ? cookie : crypto.randomUUID();
  const key = `${slug}:${crypto.createHash('sha256').update(id).digest('hex')}`;
  const isNew = !cookie;
  activeVisitors.set(key, Date.now());
  return { id, key, isNew, headers: isNew ? { 'Set-Cookie': `inner-light-visitor=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; SameSite=Lax` } : {} };
}

function clientKey(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = String(forwarded || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function allowedByRate(request) {
  const key = clientKey(request);
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((time) => now - time < 60 * 60 * 1000);
  if (bucket.filter((time) => now - time < 60 * 1000).length >= MAX_SUBMISSIONS_PER_MINUTE || bucket.length >= MAX_SUBMISSIONS_PER_HOUR) return false;
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => { body += chunk; if (body.length > 4096) tooLarge = true; });
    request.on('end', () => {
      if (tooLarge) return reject(new Error('请求内容过大。'));
      try { resolve(body ? JSON.parse(body) : {}); } catch (_) { reject(new Error('请求格式不正确。')); }
    });
    request.on('error', reject);
  });
}

function admin(request) { return Boolean(ADMIN_TOKEN) && request.headers['x-admin-token'] === ADMIN_TOKEN; }
function routeInfo(request) { const parsed = url.parse(request.url, true); return { pathname: parsed.pathname, query: parsed.query }; }

async function handleApi(request, response, pathname, query) {
  const match = pathname.match(/^\/api\/planets\/([^/]+)(?:\/(.*))?$/);
  const slug = match?.[1];
  if (!slug || !validSlug(slug)) return json(response, 400, { message: '星球地址不合法。' });
  const store = getStore(slug);
  const suffix = match[2] || '';
  const visitor = visitorContext(request, slug);
  if (visitor.isNew) { store.visitors++; await saveData(slug, store); }

  if (request.method === 'GET' && suffix === 'words') {
    const since = Number(query.since || 0);
    if (since && since === store.lastEventId) return json(response, 200, { version: store.lastEventId, unchanged: true }, visitor.headers);
    return json(response, 200, publicSummary(store, slug), visitor.headers);
  }
  if (request.method === 'GET' && suffix === 'recent') {
    const limit = Math.min(50, Math.max(1, Number(query.limit || 20)));
    return json(response, 200, { items: store.submissions.slice(-limit).reverse() }, visitor.headers);
  }
  if (request.method === 'GET' && suffix === 'stats') return json(response, 200, stats(store, slug), visitor.headers);
  if (request.method === 'GET' && suffix === 'events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', ...visitor.headers });
    response.write(`retry: 5000\nid: ${store.lastEventId}\ndata: ${JSON.stringify({ type: 'ready', version: store.lastEventId })}\n\n`);
    clients.add({ response, slug });
    request.on('close', () => { for (const client of clients) if (client.response === response) clients.delete(client); });
    return;
  }
  if (request.method === 'POST' && suffix === 'words') {
    if (!allowedByRate(request)) return json(response, 429, { message: '发送太频繁了，请稍后再试。' }, visitor.headers);
    let body;
    try { body = await readBody(request); } catch (error) { return json(response, 400, { message: error.message }, visitor.headers); }
    const checked = Core.validateWord(body.word);
    if (!checked.ok) return json(response, 422, { message: checked.error }, visitor.headers);
    const word = checked.word;
    if (BLOCKED_WORDS.has(word.toLocaleLowerCase())) return json(response, 422, { message: '这个词语暂时不能加入公共星球。' }, visitor.headers);
    let item = store.words.find((entry) => entry.word === word);
    if (!item && store.words.length >= MAX_WORDS) return json(response, 409, { message: `星球已达到 ${MAX_WORDS} 个念头。` }, visitor.headers);
    if (!item) { item = { word, frequency: 1 }; store.words.push(item); } else item.frequency = Math.min(Core.MAX_FREQUENCY, item.frequency + 1);
    store.totalSubmissions++;
    // Visitor count is registered when the anonymous cookie is first issued.
    const event = { id: ++store.lastEventId, type: 'word_added', item: { ...item }, createdAt: new Date().toISOString() };
    store.submissions.push({ id: event.id, word, visitor: visitor.key, createdAt: event.createdAt });
    store.submissions = store.submissions.slice(-MAX_RECENT);
    await saveData(slug, store);
    publicEvent(slug, event);
    return json(response, 201, { ok: true, item, eventId: event.id, version: store.lastEventId, stats: stats(store, slug) }, visitor.headers);
  }
  return json(response, 405, { message: '不支持的操作。' }, visitor.headers);
}

async function handleAdmin(request, response, pathname, query) {
  if (!admin(request)) return json(response, 401, { message: '需要管理员权限。' });
  const slug = query.planet && validSlug(query.planet) ? query.planet : 'default';
  const store = getStore(slug);
  if (request.method === 'GET' && (pathname === '/api/admin/export' || pathname === '/api/admin/words')) return json(response, 200, pathname.endsWith('/words') ? { planet: store.planet, words: store.words, stats: stats(store, slug), recent: store.submissions.slice(-MAX_RECENT).reverse() } : store);
  const match = pathname.match(/^\/api\/admin\/words\/(.+)$/);
  if (request.method === 'DELETE' && match) {
    const word = decodeURIComponent(match[1]);
    const before = store.words.length;
    store.words = store.words.filter((item) => item.word !== word);
    if (store.words.length === before) return json(response, 404, { message: '词语不存在。' });
    const event = { id: ++store.lastEventId, type: 'word_removed', word };
    await saveData(slug, store);
    publicEvent(slug, event);
    return json(response, 200, { ok: true });
  }
  return json(response, 404, { message: '管理接口不存在。' });
}

function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname === '/admin' ? 'admin.html' : pathname.slice(1);
  if (!PUBLIC_FILES.has(requested)) return text(response, 404, 'Not found');
  try {
    const contentType = requested.endsWith('.html') ? 'text/html; charset=utf-8' : requested.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
    text(response, 200, fs.readFileSync(path.join(__dirname, requested)), contentType);
  } catch (_) { text(response, 404, 'Not found'); }
}

const server = http.createServer(async (request, response) => {
  const { pathname, query } = routeInfo(request);
  if (request.method === 'OPTIONS') return json(response, 204, {});
  try {
    if (pathname.startsWith('/api/admin/')) return await handleAdmin(request, response, pathname, query);
    if (pathname.startsWith('/api/')) return await handleApi(request, response, pathname, query);
    return serveStatic(response, pathname);
  } catch (error) {
    console.error(error);
    return json(response, 500, { message: '服务器暂时不可用。' });
  }
});

server.listen(PORT, HOST, () => console.log(`Inner Light running at http://localhost:${PORT}`));
