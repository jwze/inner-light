/* Durable public submissions; also loaded by sw.js via importScripts. */
(() => {
  'use strict';
  const root = globalThis;
  const isPage = typeof window !== 'undefined' && typeof document !== 'undefined';
  const DB_NAME = 'inner-light-outbox-v1', SYNC_TAG = 'inner-light-outbox', OWNER = uuid();
  let database, running, retryTimer;
  const channel = isPage && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inner-light-outbox') : null;
  function uuid() {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    return Array.from(bytes, (b, i) => ([4, 6, 8, 10].includes(i) ? '-' : '') + b.toString(16).padStart(2, '0')).join('');
  }
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('此浏览器无法持久保存离线发送，请使用支持 IndexedDB 的浏览器。')); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries', { keyPath: 'requestId' });
        request.result.createObjectStore('locks', { keyPath: 'key' });
      };
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); database = null; }; resolve(db); };
      request.onerror = () => { database = null; reject(request.error); };
    });
    return database;
  }
  async function transaction(store, mode, operation) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('离线保存失败。'));
      operation(tx.objectStore(store), value => { result = value; });
    });
  }
  function list() {
    return transaction('entries', 'readonly', (store, done) => {
      const req = store.getAll(); req.onsuccess = () => done(req.result.sort((a, b) => a.createdAt - b.createdAt));
    });
  }
  function put(entry) { return transaction('entries', 'readwrite', store => store.put(entry)); }
  function remove(id) { return transaction('entries', 'readwrite', store => store.delete(id)); }
  // The same atomic lease protects windows and service workers, including browsers without Web Locks.
  function lease(action) {
    return transaction('locks', 'readwrite', (store, done) => {
      const req = store.get('flush');
      req.onsuccess = () => {
        const lock = req.result, now = Date.now();
        if (action === 'release') { if (lock?.owner === OWNER) store.delete('flush'); done(true); }
        else if (!lock || lock.owner === OWNER || lock.until < now) {
          store.put({ key: 'flush', owner: OWNER, until: now + 45000 }); done(true);
        } else done(false);
      };
    });
  }
  async function emit(type, detail = {}) {
    if (isPage) {
      window.dispatchEvent(new CustomEvent(type, { detail })); channel?.postMessage({ type, detail });
    } else if (root.clients) {
      const clients = await root.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(client => client.postMessage({ type, detail }));
    }
  }
  async function registerSync() {
    try {
      if (isPage && navigator.serviceWorker) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration?.sync) await registration.sync.register(SYNC_TAG);
      } else if (root.registration?.sync) await root.registration.sync.register(SYNC_TAG);
    } catch (_) { /* online event and foreground timer are the fallback */ }
  }
  async function changed() { await emit('innerlight:outbox'); }
  function validate(slug, word) {
    if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug)) throw new Error('星球地址不合法。');
    if (typeof word !== 'string' || !word.trim()) throw new Error('请先输入一个念头。');
  }
  async function enqueue(slug, word) {
    validate(slug, word);
    const entry = { requestId: uuid(), slug, word, createdAt: Date.now(), state: 'queued', attempts: 0, retryAt: 0, reason: '' };
    await put(entry); // Never send until the stable request ID is durably committed.
    await changed(); void registerSync(); void schedule().catch(() => {}); return entry;
  }
  function backoff(entry, response) {
    const header = response?.headers.get('Retry-After');
    const parsed = header ? (/^\d+(\.\d+)?$/.test(header) ? Date.now() + Number(header) * 1000 : Date.parse(header)) : 0;
    return Math.max(Date.now() + Math.min(3600000, 2000 * 2 ** Math.min(entry.attempts, 10)), Number.isFinite(parsed) ? parsed : 0);
  }
  async function send(entry) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    let response, payload = {};
    try {
      response = await fetch(`/api/planets/${encodeURIComponent(entry.slug)}/words`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word: entry.word, requestId: entry.requestId })
      });
      try { payload = await response.json(); } catch (_) { /* status is authoritative, including an empty 202 */ }
    } catch (_) { /* uncertain delivery: keep the exact same ID for retry */ }
    finally { clearTimeout(timer); }
    if (response && [200, 201, 202].includes(response.status)) {
      await remove(entry.requestId);
      await emit('innerlight:delivered', { slug: entry.slug, payload, requestId: entry.requestId });
      return { payload, delivered: true };
    }
    entry.attempts++;
    if (response && response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
      entry.state = 'blocked'; entry.reason = String(payload?.message || `服务器拒绝了此发送 (${response.status})`); entry.retryAt = 0;
    } else {
      entry.retryAt = backoff(entry, response);
      entry.reason = response?.status === 429 ? '发送太频繁，将自动稍后重试。' : '网络暂不可用，已安全保留，稍后重试。';
    }
    await put(entry); return { delivered: false, stop: entry.state !== 'blocked' };
  }
  async function schedule() {
    if (!isPage) return;
    clearTimeout(retryTimer);
    const entries = (await list()).filter(entry => entry.state === 'queued');
    if (entries.length) {
      const next = Math.min(...entries.map(entry => entry.retryAt || Date.now()));
      retryTimer = setTimeout(() => { void flush().catch(() => {}); }, Math.max(2000, Math.min(2147483647, next - Date.now())));
      void registerSync();
    }
  }
  async function drain() {
    const delivered = {};
    if (!await lease('acquire')) { await schedule(); return { delivered, busy: true }; }
    const heartbeat = setInterval(() => { void lease('renew').catch(() => {}); }, 10000);
    try {
      const entries = await list();
      for (const entry of entries) {
        if (entry.state !== 'queued' || entry.retryAt > Date.now()) continue;
        if (isPage && navigator.onLine === false) break;
        if (!await lease('renew')) break;
        const result = await send(entry);
        if (result.delivered) delivered[entry.requestId] = result.payload;
        if (result.stop) break;
      }
    } finally {
      clearInterval(heartbeat); await lease('release'); await changed(); await schedule();
    }
    return { delivered, pending: (await list()).filter(entry => entry.state === 'queued').length };
  }
  function flush() {
    if (!running) running = drain().finally(() => { running = null; });
    return running;
  }
  async function submit(slug, word) {
    const entry = await enqueue(slug, word);
    let result;
    try { result = await flush(); } catch (_) { /* already durable; do not encourage another submission */ }
    if (result && Object.prototype.hasOwnProperty.call(result.delivered, entry.requestId)) return result.delivered[entry.requestId];
    return { queued: true, requestId: entry.requestId, slug };
  }
  async function edit(id, word) {
    if (typeof word !== 'string' || !word.trim()) throw new Error('请先输入一个念头。');
    let replacement;
    await transaction('entries', 'readwrite', store => {
      const req = store.get(id);
      req.onsuccess = () => {
        const entry = req.result;
        if (!entry || entry.state !== 'blocked') return;
        replacement = { ...entry, word, requestId: uuid(), createdAt: Date.now(), attempts: 0, state: 'queued', retryAt: 0, reason: '' };
        store.delete(id); store.put(replacement);
      };
    });
    if (!replacement) throw new Error('只能编辑或重试被拒绝的发送。');
    await changed(); void registerSync(); void flush().catch(() => {}); return replacement;
  }
  async function drop(id) {
    // An in-flight request may already have committed: only dead letters can be removed.
    await transaction('entries', 'readwrite', store => {
      const req = store.get(id); req.onsuccess = () => { if (req.result?.state === 'blocked') store.delete(id); };
    });
    await changed();
  }
  root.InnerLightOffline = { enqueue, submit, flush, list, edit, drop, syncTag: SYNC_TAG };
  if (isPage) {
    channel && (channel.onmessage = event => {
      if (['innerlight:outbox', 'innerlight:delivered'].includes(event.data?.type)) {
        window.dispatchEvent(new CustomEvent(event.data.type, { detail: event.data.detail })); void schedule().catch(() => {});
      }
    });
    window.addEventListener('online', () => { void flush().catch(() => {}); });
    navigator.serviceWorker?.addEventListener('message', event => {
      const message = event.data;
      if (message?.type === 'innerlight:flush') void flush().catch(() => {});
      if (['innerlight:outbox', 'innerlight:delivered'].includes(message?.type)) window.dispatchEvent(new CustomEvent(message.type, { detail: message.detail }));
    });
    void flush().catch(() => {});
  }
})();
