'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Core = require('./core.js');

function openDatabase(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'inner-light.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS planets (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'nebula',
      created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, legacy_total INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS words (
      planet TEXT NOT NULL REFERENCES planets(slug), word TEXT NOT NULL, frequency INTEGER NOT NULL DEFAULT 1,
      hidden INTEGER NOT NULL DEFAULT 0, is_seed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      PRIMARY KEY (planet, word));
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, planet TEXT NOT NULL REFERENCES planets(slug), word TEXT NOT NULL,
      visitor_hash TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS submissions_time ON submissions(planet, created_at);
    CREATE TABLE IF NOT EXISTS visitors (
      planet TEXT NOT NULL REFERENCES planets(slug), hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      PRIMARY KEY (planet, hash));
    CREATE TABLE IF NOT EXISTS rate_events (key TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_window ON rate_events(key, created_at);
    CREATE TABLE IF NOT EXISTS moderation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, planet TEXT NOT NULL, action TEXT NOT NULL, word TEXT, created_at TEXT NOT NULL);
  `);
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  for (const [table, name, definition] of [
    ['submissions', 'status', "TEXT NOT NULL DEFAULT 'approved'"],
    ['submissions', 'reason', "TEXT NOT NULL DEFAULT ''"],
    ['submissions', 'request_id', 'TEXT'],
    ['submissions', 'import_key', 'TEXT'],
    ['planets', 'review_mode', 'INTEGER NOT NULL DEFAULT 0'],
    ['moderation_log', 'actor', "TEXT NOT NULL DEFAULT 'system'"]
  ]) if (!columns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS submission_requests ON submissions(planet,visitor_hash,request_id) WHERE request_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS submission_imports ON submissions(planet,import_key) WHERE import_key IS NOT NULL;`);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function ensure(slug, seed = true) {
    if (get('SELECT slug FROM planets WHERE slug=?', slug)) return;
    if (get('SELECT COUNT(*) AS n FROM planets').n >= 100) throw Object.assign(new Error('星球数量已达上限，请联系管理员。'), { status: 429 });
    transaction(() => {
      if (get('SELECT slug FROM planets WHERE slug=?', slug)) return;
      const now = new Date().toISOString();
      run('INSERT OR IGNORE INTO planets(slug,name,description,created_at,review_mode) VALUES(?,?,?,?,0)', slug,
        slug === 'default' ? '同频宇宙' : slug, '每一个念头，都可能遇见同频的光。', now);
      if (seed) for (const item of Core.randomSamples()) run('INSERT OR IGNORE INTO words(planet,word,frequency,is_seed,created_at) VALUES(?,?,?,1,?)', slug, item.word, item.frequency, now);
    });
  }
  function recent(slug, limit = 20) {
    return all(`SELECT s.id,s.word,s.created_at AS createdAt FROM submissions s JOIN words w ON w.planet=s.planet AND w.word=s.word
      WHERE s.planet=? AND s.status='approved' AND w.hidden=0 ORDER BY s.id DESC LIMIT ?`, slug, limit);
  }
  function stats(slug) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      wordCount: get('SELECT COUNT(*) AS n FROM words WHERE planet=? AND hidden=0', slug).n,
      totalSubmissions: get('SELECT COUNT(*) AS n FROM submissions WHERE planet=? AND status=\'approved\'', slug).n + get('SELECT legacy_total AS n FROM planets WHERE slug=?', slug).n,
      todaySubmissions: get('SELECT COUNT(*) AS n FROM submissions WHERE planet=? AND status=\'approved\' AND created_at>=? AND created_at<?', slug, `${today}T00:00:00.000Z`, new Date(Date.parse(`${today}T00:00:00.000Z`) + 86400000).toISOString()).n,
      activeVisitors: get('SELECT COUNT(*) AS n FROM visitors WHERE planet=? AND last_seen>=?', slug, new Date(Date.now() - 15 * 60000).toISOString()).n,
      uniqueVisitors: get('SELECT COUNT(*) AS n FROM visitors WHERE planet=?', slug).n
    };
  }
  function snapshot(slug) {
    const row = get('SELECT * FROM planets WHERE slug=?', slug);
    return { planet: { slug, name: row.name, description: row.description, theme: row.theme, createdAt: row.created_at, reviewMode: Boolean(row.review_mode) },
      version: row.version, items: all('SELECT word,frequency FROM words WHERE planet=? AND hidden=0 ORDER BY created_at,word', slug),
      stats: stats(slug), recent: recent(slug) };
  }
  function addWord(slug, word) {
    const current = get('SELECT * FROM words WHERE planet=? AND word=?', slug, word);
    if (current?.hidden) throw Object.assign(new Error('这个词语已被管理员屏蔽。'), { status: 422 });
    if (!current && stats(slug).wordCount >= Core.MAX_WORDS) throw Object.assign(new Error('星球已满，无法加入新词语。'), { status: 409 });
    if (current?.frequency >= Core.MAX_FREQUENCY) throw Object.assign(new Error('共鸣次数已达上限。'), { status: 409 });
    run(`INSERT INTO words(planet,word,created_at) VALUES(?,?,?) ON CONFLICT(planet,word)
      DO UPDATE SET frequency=words.frequency+1,is_seed=0`, slug, word, new Date().toISOString());
  }
  function requestResult(slug, visitor, requestId) {
    if (!requestId) return null;
    const row = get('SELECT id,word,status,reason,created_at FROM submissions WHERE planet=? AND visitor_hash=? AND request_id=?', slug, visitor, requestId);
    return row ? { ...snapshot(slug), status: row.status, reason: row.reason, submissionId: row.id, item: get('SELECT word,frequency FROM words WHERE planet=? AND word=?', slug, row.word) || { word: row.word, frequency: 0 }, deduplicated: true } : null;
  }
  function submit(slug, word, visitor, options = {}) {
    return transaction(() => {
      const existing = requestResult(slug, visitor, options.requestId);
      if (existing) return existing;
      const status = options.status || 'approved';
      if (!['approved','pending','rejected'].includes(status)) throw new Error('Invalid submission status');
      if (status === 'approved') addWord(slug, word);
      else if (get('SELECT hidden FROM words WHERE planet=? AND word=?', slug, word)?.hidden) throw Object.assign(new Error('这个词语已被屏蔽。'), { status: 422 });
      const now = new Date().toISOString();
      const result = run('INSERT INTO submissions(planet,word,visitor_hash,created_at,status,reason,request_id,import_key) VALUES(?,?,?,?,?,?,?,?)', slug, word, visitor, now, status, options.reason || '', options.requestId || null, `native:${crypto.randomUUID()}`);
      if (status === 'approved') run('UPDATE planets SET version=version+1 WHERE slug=?', slug);
      return { ...snapshot(slug), id: snapshot(slug).version, submissionId: Number(result.lastInsertRowid), type: status === 'approved' ? 'word_added' : 'submission_pending', status, reason: options.reason || '',
        item: get('SELECT word,frequency FROM words WHERE planet=? AND word=?', slug, word) || { word, frequency: 0 }, createdAt: now };
    });
  }
  function review(slug, id, decision, actor) {
    return transaction(() => {
      const row = get('SELECT * FROM submissions WHERE planet=? AND id=?', slug, id);
      if (!row) throw Object.assign(new Error('审核记录不存在。'), { status: 404 });
      if (row.status !== 'pending') throw Object.assign(new Error('该记录已处理，请刷新列表。'), { status: 409 });
      if (!['approved','rejected'].includes(decision)) throw Object.assign(new Error('审核决定不合法。'), { status: 422 });
      if (decision === 'approved') addWord(slug, row.word);
      run('UPDATE submissions SET status=?,reason=? WHERE id=?', decision, `人工审核：${actor}`, id);
      run('INSERT INTO moderation_log(planet,action,word,created_at,actor) VALUES(?,?,?,?,?)', slug, decision, row.word, new Date().toISOString(), actor);
      run('UPDATE planets SET version=version+1 WHERE slug=?', slug);
      return snapshot(slug);
    });
  }
  function moderate(slug, word, action, actor = 'system') {
    return transaction(() => {
      if (action === 'clear') run('UPDATE words SET hidden=1 WHERE planet=?', slug);
      else {
        const result = run('UPDATE words SET hidden=? WHERE planet=? AND word=?', action === 'hide' ? 1 : 0, slug, word);
        if (!result.changes) throw Object.assign(new Error('词语不存在。'), { status: 404 });
        if (action === 'restore' && stats(slug).wordCount > Core.MAX_WORDS) throw Object.assign(new Error('星球已满，无法恢复。'), { status: 409 });
      }
      run('INSERT INTO moderation_log(planet,action,word,created_at,actor) VALUES(?,?,?,?,?)', slug, action, word || null, new Date().toISOString(), actor);
      run('UPDATE planets SET version=version+1 WHERE slug=?', slug);
      return snapshot(slug);
    });
  }
  function rate(keys, minute, hour) {
    return transaction(() => {
      const now = Date.now();
      run('DELETE FROM rate_events WHERE created_at<?', now - 3600000);
      for (const key of keys) {
        const counts = get('SELECT COUNT(*) AS hour,COALESCE(SUM(created_at>=?),0) AS minute FROM rate_events WHERE key=?', now - 60000, key);
        if (counts.minute >= minute || counts.hour >= hour) return false;
      }
      for (const key of keys) run('INSERT INTO rate_events(key,created_at) VALUES(?,?)', key, now);
      return true;
    });
  }
  // One-time import of the previous JSON format; original files are never deleted.
  function migrateLegacy() {
    if (get("SELECT value FROM settings WHERE key='legacy-imported'")) return;
    const files = [path.join(directory, 'planet.json')];
    const roomDir = path.join(directory, 'planets');
    if (fs.existsSync(roomDir)) files.push(...fs.readdirSync(roomDir).filter((name) => name.endsWith('.json')).map((name) => path.join(roomDir, name)));
    for (const file of files.filter((name) => fs.existsSync(name))) {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      const slug = old.planet?.slug || 'default';
      if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug)) throw new Error(`Invalid legacy slug: ${slug}`);
      const marker = `legacy-imported:${slug}`;
      if (get('SELECT value FROM settings WHERE key=?', marker)) continue;
      ensure(slug, false);
      transaction(() => {
        const now = new Date().toISOString();
        for (const item of Core.createEntries(old.words)) run('INSERT OR REPLACE INTO words(planet,word,frequency,created_at) VALUES(?,?,?,?)', slug, item.word, item.frequency, now);
        const records = Array.isArray(old.submissions) ? old.submissions : [];
        for (const item of records) {
          const valid = Core.validateWord(item.word);
          if (valid.ok) run('INSERT INTO submissions(planet,word,created_at) VALUES(?,?,?)', slug, valid.word, item.createdAt || now);
        }
        run('UPDATE planets SET name=?,description=?,theme=?,version=?,legacy_total=? WHERE slug=?', old.planet?.name || slug,
          old.planet?.description || '', ['nebula', 'ocean', 'forest'].includes(old.planet?.theme) ? old.planet.theme : 'nebula',
          Number(old.lastEventId) || 0, Math.max(0, (Number(old.totalSubmissions) || records.length) - records.length), slug);
        run('INSERT INTO settings(key,value) VALUES(?,?)', marker, new Date().toISOString());
      });
    }
    run("INSERT INTO settings(key,value) VALUES('legacy-imported',?)", new Date().toISOString());
  }
  migrateLegacy();
  run("UPDATE submissions SET import_key=planet||':native:'||id||':'||created_at WHERE import_key IS NULL");
  let secret = get("SELECT value FROM settings WHERE key='identity-secret'")?.value;
  const extra = require('./database-features').features({ get, all, run, transaction, snapshot });
  if (!secret) { run("INSERT OR IGNORE INTO settings(key,value) VALUES('identity-secret',?)", crypto.randomBytes(32).toString('hex')); secret = get("SELECT value FROM settings WHERE key='identity-secret'").value; }
  return { filename, secret, ensure, snapshot, recent, stats, submit, moderate, rate, review, requestResult, ...extra,
    exists(slug) { return Boolean(get('SELECT slug FROM planets WHERE slug=?', slug)); },
    listPlanets() { return all('SELECT slug,name FROM planets ORDER BY slug'); },
    queue(slug) { return all("SELECT id,word,status,reason,created_at AS createdAt FROM submissions WHERE planet=? AND status IN ('pending','rejected') ORDER BY id DESC LIMIT 500", slug); },
    visit(slug, hash) {
      const now = new Date().toISOString();
      run('INSERT INTO visitors(planet,hash,first_seen,last_seen) VALUES(?,?,?,?) ON CONFLICT(planet,hash) DO UPDATE SET last_seen=excluded.last_seen', slug, hash, now, now);
    },
    export(slug) {
      const state = snapshot(slug);
      const legacyTotal = get('SELECT legacy_total AS n FROM planets WHERE slug=?', slug).n;
      const records = all('SELECT id,word,status,reason,created_at AS createdAt,import_key AS sourceKey,visitor_hash AS visitorTag,request_id AS requestId FROM submissions WHERE planet=? ORDER BY id', slug).map((row) => ({ ...row, sourceKey: row.sourceKey || `${slug}:${row.id}:${row.createdAt}` }));
      const words = all('SELECT word,frequency,hidden,is_seed AS isSeed FROM words WHERE planet=? ORDER BY frequency DESC', slug);
      return { schemaVersion: 2, ...state, legacyTotal, words, submissions: records,
        moderation: all('SELECT action,word,actor,created_at AS createdAt FROM moderation_log WHERE planet=? ORDER BY id DESC', slug) };
    },
    updatePlanet(slug, settings) {
      return transaction(() => {
        run('UPDATE planets SET name=?,theme=?,review_mode=?,version=version+1 WHERE slug=?', settings.name, settings.theme, settings.reviewMode ? 1 : 0, slug);
        run('INSERT INTO moderation_log(planet,action,created_at,actor) VALUES(?,?,?,?)', slug, 'settings', new Date().toISOString(), settings.actor || 'system');
        return snapshot(slug);
      });
    },
    close() { db.close(); }
  };
}
module.exports = { openDatabase };
