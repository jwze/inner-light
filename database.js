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
      const now = new Date().toISOString();
      run('INSERT OR IGNORE INTO planets(slug,name,description,created_at) VALUES(?,?,?,?)', slug,
        slug === 'default' ? '同频宇宙' : slug, '每一个念头，都可能遇见同频的光。', now);
      if (seed) for (const item of Core.randomSamples()) run('INSERT OR IGNORE INTO words(planet,word,frequency,is_seed,created_at) VALUES(?,?,?,1,?)', slug, item.word, item.frequency, now);
    });
  }
  function recent(slug, limit = 20) {
    return all(`SELECT s.id,s.word,s.created_at AS createdAt FROM submissions s JOIN words w ON w.planet=s.planet AND w.word=s.word
      WHERE s.planet=? AND w.hidden=0 ORDER BY s.id DESC LIMIT ?`, slug, limit);
  }
  function stats(slug) {
    const today = new Date().toISOString().slice(0, 10);
    return {
      wordCount: get('SELECT COUNT(*) AS n FROM words WHERE planet=? AND hidden=0', slug).n,
      totalSubmissions: get('SELECT COUNT(*) AS n FROM submissions WHERE planet=?', slug).n + get('SELECT legacy_total AS n FROM planets WHERE slug=?', slug).n,
      todaySubmissions: get('SELECT COUNT(*) AS n FROM submissions WHERE planet=? AND created_at>=? AND created_at<?', slug, `${today}T00:00:00.000Z`, new Date(Date.parse(`${today}T00:00:00.000Z`) + 86400000).toISOString()).n,
      activeVisitors: get('SELECT COUNT(*) AS n FROM visitors WHERE planet=? AND last_seen>=?', slug, new Date(Date.now() - 15 * 60000).toISOString()).n,
      uniqueVisitors: get('SELECT COUNT(*) AS n FROM visitors WHERE planet=?', slug).n
    };
  }
  function snapshot(slug) {
    const row = get('SELECT * FROM planets WHERE slug=?', slug);
    return { planet: { slug, name: row.name, description: row.description, theme: row.theme, createdAt: row.created_at },
      version: row.version, items: all('SELECT word,frequency FROM words WHERE planet=? AND hidden=0 ORDER BY created_at,word', slug),
      stats: stats(slug), recent: recent(slug) };
  }
  function submit(slug, word, visitor) {
    return transaction(() => {
      const current = get('SELECT * FROM words WHERE planet=? AND word=?', slug, word);
      if (current?.hidden) throw Object.assign(new Error('这个词语已被管理员屏蔽。'), { status: 422 });
      if (!current && stats(slug).wordCount >= Core.MAX_WORDS) throw Object.assign(new Error(`星球已达到 ${Core.MAX_WORDS} 个念头。`), { status: 409 });
      if (current?.frequency >= Core.MAX_FREQUENCY) throw Object.assign(new Error('这个词语的共鸣次数已达上限。'), { status: 409 });
      const now = new Date().toISOString();
      run(`INSERT INTO words(planet,word,created_at) VALUES(?,?,?) ON CONFLICT(planet,word)
        DO UPDATE SET frequency=words.frequency+1,is_seed=0`, slug, word, now);
      const result = run('INSERT INTO submissions(planet,word,visitor_hash,created_at) VALUES(?,?,?,?)', slug, word, visitor, now);
      run('UPDATE planets SET version=version+1 WHERE slug=?', slug);
      return { id: snapshot(slug).version, submissionId: Number(result.lastInsertRowid), type: 'word_added',
        item: get('SELECT word,frequency FROM words WHERE planet=? AND word=?', slug, word), createdAt: now, ...snapshot(slug) };
    });
  }
  function moderate(slug, word, action) {
    return transaction(() => {
      if (action === 'clear') run('UPDATE words SET hidden=1 WHERE planet=?', slug);
      else {
        const result = run('UPDATE words SET hidden=? WHERE planet=? AND word=?', action === 'hide' ? 1 : 0, slug, word);
        if (!result.changes) throw Object.assign(new Error('词语不存在。'), { status: 404 });
        if (action === 'restore' && stats(slug).wordCount > Core.MAX_WORDS) throw Object.assign(new Error('星球已满，无法恢复。'), { status: 409 });
      }
      run('INSERT INTO moderation_log(planet,action,word,created_at) VALUES(?,?,?,?)', slug, action, word || null, new Date().toISOString());
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
  let secret = get("SELECT value FROM settings WHERE key='identity-secret'")?.value;
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); run("INSERT INTO settings(key,value) VALUES('identity-secret',?)", secret); }
  return { filename, secret, ensure, snapshot, recent, stats, submit, moderate, rate,
    exists(slug) { return Boolean(get('SELECT slug FROM planets WHERE slug=?', slug)); },
    visit(slug, hash) {
      const now = new Date().toISOString();
      run('INSERT INTO visitors(planet,hash,first_seen,last_seen) VALUES(?,?,?,?) ON CONFLICT(planet,hash) DO UPDATE SET last_seen=excluded.last_seen', slug, hash, now, now);
    },
    export(slug) {
      const state = snapshot(slug);
      return { ...state, words: all('SELECT word,frequency,hidden,is_seed AS isSeed FROM words WHERE planet=? ORDER BY frequency DESC', slug),
        submissions: all('SELECT id,word,created_at AS createdAt FROM submissions WHERE planet=? ORDER BY id DESC', slug),
        moderation: all('SELECT action,word,created_at AS createdAt FROM moderation_log WHERE planet=? ORDER BY id DESC', slug) };
    },
    updatePlanet(slug, settings) {
      run('UPDATE planets SET name=?,theme=?,version=version+1 WHERE slug=?', settings.name, settings.theme, slug);
      return snapshot(slug);
    },
    close() { db.close(); }
  };
}
module.exports = { openDatabase };
