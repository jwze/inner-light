'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function openAuth(filename, bootstrapToken = '') {
  const db = new DatabaseSync(filename); db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,role TEXT NOT NULL,planets TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS admin_sessions (hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL,time INTEGER NOT NULL);`);
  const get = (sql, ...p) => db.prepare(sql).get(...p); const run = (sql, ...p) => db.prepare(sql).run(...p);
  const clean = (row) => row && ({ id: row.id, name: row.name, role: row.role, planets: typeof row.planets === 'string' ? JSON.parse(row.planets) : row.planets, disabled: Boolean(row.disabled), bootstrap: Boolean(row.bootstrap) });
  const owner = (user) => { if (!user || user.role !== 'owner') fail(403, '仅所有者可操作。'); };
  function validate(value) {
    if (!['owner','moderator','viewer'].includes(value.role) || !Array.isArray(value.planets) || !value.planets.length || value.planets.length > 100 || value.planets.some((p) => typeof p !== 'string' || (p !== '*' && !/^[a-z0-9][a-z0-9-]{0,48}$/.test(p)))) fail(422, '角色或房间范围不合法。');
    if (value.role === 'owner' && !value.planets.includes('*')) fail(422, '所有者必须拥有全部房间权限。');
  }
  const cookie = (req) => /(?:^|;\s*)il-admin=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
  return {
    authenticate(req) {
      if (bootstrapToken && equal(String(req.headers['x-admin-token'] || ''), bootstrapToken)) return { id: 0, name: 'bootstrap', role: 'owner', planets: ['*'], bootstrap: true };
      const row = get('SELECT a.* FROM admin_sessions s JOIN admins a ON a.id=s.user_id WHERE s.hash=? AND s.expires_at>? AND a.disabled=0', hash(cookie(req)), Date.now());
      if (!row) fail(401, '请先登录管理员账户。'); return clean(row);
    },
    login(name, password, ip) {
      const now = Date.now(); run('DELETE FROM login_attempts WHERE time<?', now - 60000);
      if (get('SELECT COUNT(*) AS n FROM login_attempts WHERE ip=?', hash(ip)).n >= 5) fail(429, '登录尝试过多，请一分钟后重试。');
      run('INSERT INTO login_attempts(ip,time) VALUES(?,?)', hash(ip), now);
      const row = get('SELECT * FROM admins WHERE name=? AND disabled=0', typeof name === 'string' ? name : '');
      const derived = crypto.scryptSync(typeof password === 'string' ? password.slice(0, 1024) : '', row?.salt || 'dummy-salt', 64).toString('hex');
      if (!row || !equal(derived, row.password_hash)) fail(401, '用户名或密码错误。');
      run('DELETE FROM admin_sessions WHERE expires_at<?', now);
      const token = crypto.randomBytes(32).toString('hex'); run('INSERT INTO admin_sessions VALUES(?,?,?)', hash(token), row.id, now + 12 * 3600000);
      return { token, user: clean(row) };
    },
    logout(req) { run('DELETE FROM admin_sessions WHERE hash=?', hash(cookie(req))); },
    authorize(user, slug, permission = 'read') {
      if (!user || user.disabled) fail(403, '没有访问权限。');
      if (!user.planets.includes('*') && !user.planets.includes(slug)) fail(403, '无权访问此星球。');
      if (user.role === 'owner') return;
      if (permission === 'read' || (permission === 'review' && user.role === 'moderator')) return;
      fail(403, '当前角色无此操作权限。');
    },
    me: clean,
    list(user) { owner(user); return db.prepare('SELECT * FROM admins ORDER BY id').all().map(clean); },
    create(user, value) {
      owner(user); validate(value);
      if (typeof value.name !== 'string' || !/^[a-zA-Z0-9_-]{3,40}$/.test(value.name) || typeof value.password !== 'string' || value.password.length < 12 || value.password.length > 128) fail(422, '用户名需 3–40 位；密码需 12–128 位。');
      const salt = crypto.randomBytes(16).toString('hex'); const passwordHash = crypto.scryptSync(value.password, salt, 64).toString('hex');
      try { const result = run('INSERT INTO admins(name,password_hash,salt,role,planets) VALUES(?,?,?,?,?)', value.name, passwordHash, salt, value.role, JSON.stringify(value.planets)); return clean(get('SELECT * FROM admins WHERE id=?', Number(result.lastInsertRowid))); }
      catch (error) { if (error.code?.includes('SQLITE')) fail(409, '用户名已存在。'); throw error; }
    },
    update(user, id, value) {
      owner(user); const old = get('SELECT * FROM admins WHERE id=?', id); if (!old) fail(404, '账户不存在。');
      const next = { ...clean(old), ...value }; validate(next);
      if (typeof next.disabled !== 'boolean') fail(422, 'disabled 需为布尔值。');
      if (old.role === 'owner' && !old.disabled && (next.disabled || next.role !== 'owner') && get("SELECT COUNT(*) AS n FROM admins WHERE role='owner' AND disabled=0").n <= 1) fail(409, '不能禁用或降级最后一个所有者。');
      let salt = old.salt, passwordHash = old.password_hash;
      if (value.password !== undefined) { if (typeof value.password !== 'string' || value.password.length < 12 || value.password.length > 128) fail(422, '密码需 12–128 位。'); salt = crypto.randomBytes(16).toString('hex'); passwordHash = crypto.scryptSync(value.password, salt, 64).toString('hex'); }
      run('UPDATE admins SET role=?,planets=?,disabled=?,salt=?,password_hash=? WHERE id=?', next.role, JSON.stringify(next.planets), next.disabled ? 1 : 0, salt, passwordHash, id);
      run('DELETE FROM admin_sessions WHERE user_id=?', id); return clean(get('SELECT * FROM admins WHERE id=?', id));
    },
    close() { db.close(); }
  };
}
module.exports = { openAuth };
