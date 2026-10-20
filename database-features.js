'use strict';
const crypto = require('node:crypto');
const Core = require('./core');
function features({ get, all, run, transaction, snapshot }) {
  const invalid = (message) => { throw Object.assign(new Error(message), { status: 422 }); };
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  function analytics(slug, days = 7) {
    const end = new Date(); end.setUTCHours(0, 0, 0, 0);
    const start = new Date(end.getTime() - (days - 1) * 86400000).toISOString();
    const previousStart = new Date(Date.parse(start) - days * 86400000).toISOString();
    const rows = all("SELECT substr(created_at,1,10) AS date,COUNT(*) AS count FROM submissions WHERE planet=? AND status='approved' AND created_at>=? GROUP BY date", slug, start);
    const counts = new Map(rows.map((row) => [row.date, row.count]));
    const daily = Array.from({ length: days }, (_, index) => { const date = new Date(Date.parse(start) + index * 86400000).toISOString().slice(0, 10); return { date, count: counts.get(date) || 0 }; });
    const top = all(`SELECT s.word,SUM(s.created_at>=?) AS count,SUM(s.created_at>=? AND s.created_at<?) AS previous FROM submissions s
      JOIN words w ON w.planet=s.planet AND w.word=s.word WHERE s.planet=? AND s.status='approved' AND w.hidden=0 AND s.created_at>=?
      GROUP BY s.word ORDER BY count DESC,s.word LIMIT 20`, start, previousStart, start, slug, previousStart).map((row) => ({ ...row, delta: row.count - row.previous }));
    return { days, timezone: 'UTC', daily, top };
  }
  function relations(slug) {
    const records = all(`SELECT s.word,s.visitor_hash,s.created_at FROM submissions s JOIN words w ON w.planet=s.planet AND w.word=s.word
      WHERE s.planet=? AND s.status='approved' AND w.hidden=0 AND s.visitor_hash IS NOT NULL ORDER BY s.id DESC LIMIT 3000`, slug);
    const counts = new Map(); const weights = new Map(); const byVisitor = new Map();
    for (const row of records) {
      counts.set(row.word, (counts.get(row.word) || 0) + 1);
      const previous = byVisitor.get(row.visitor_hash) || [];
      for (const old of previous) if (old.word !== row.word && Math.abs(Date.parse(row.created_at) - Date.parse(old.created_at)) <= 1800000) {
        const pair = [row.word, old.word].sort(); const key = JSON.stringify(pair);
        weights.set(key, (weights.get(key) || 0) + 1);
      }
      byVisitor.set(row.visitor_hash, [...previous.filter((old) => Math.abs(Date.parse(row.created_at) - Date.parse(old.created_at)) <= 1800000), row]);
    }
    const nodes = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([word, count]) => ({ word, count }));
    const visible = new Set(nodes.map((node) => node.word));
    const edges = [...weights].map(([key, weight]) => { const [source, target] = JSON.parse(key); return { source, target, weight }; }).filter((edge) => visible.has(edge.source) && visible.has(edge.target)).sort((a, b) => b.weight - a.weight).slice(0, 60);
    return { nodes, edges, definition: '同一匿名访客 30 分钟内共同提交，基于最近 3000 条已通过记录；不代表语义相似。' };
  }
  function importData(slug, payload, { mode = 'merge', actor = 'system' } = {}) {
    if (!['merge', 'replace'].includes(mode) || !payload || !Array.isArray(payload.words) || payload.words.length > 1000) invalid('导入格式不合法。');
    const names = new Set();
    const words = payload.words.map((row) => {
      const checked = Core.validateWord(row?.word);
      if (!checked.ok || names.has(checked.word) || !Number.isInteger(Number(row.frequency)) || Number(row.frequency) < 1 || Number(row.frequency) > Core.MAX_FREQUENCY) invalid('词语或频率不合法，或存在重复词。');
      names.add(checked.word);
      if (![undefined, false, true, 0, 1, '0', '1'].includes(row.hidden)) invalid('hidden 需为 0 或 1。');
      return { word: checked.word, frequency: Number(row.frequency), hidden: [true, 1, '1'].includes(row.hidden) ? 1 : 0, isSeed: row.isSeed ? 1 : 0 };
    });
    const source = payload.submissions || [];
    if (!Array.isArray(source) || source.length > 10000) invalid('单次最多导入 10000 条提交记录。');
    const records = source.map((row) => {
      const checked = Core.validateWord(row?.word);
      if (!checked.ok || ((row.status || 'approved') === 'approved' && !names.has(checked.word)) || !['approved','pending','rejected'].includes(row.status || 'approved') || !Number.isFinite(Date.parse(row.createdAt))) invalid('提交记录含无效词语、状态或日期。');
      const status = row.status || 'approved'; const createdAt = new Date(row.createdAt).toISOString();
      const key = row.sourceKey || digest(JSON.stringify([checked.word, createdAt, row.id, status]));
      if (typeof key !== 'string' || key.length > 200) invalid('sourceKey 不合法。');
      if (row.visitorTag != null && (typeof row.visitorTag !== 'string' || !/^[a-f0-9]{64}$/.test(row.visitorTag))) invalid('匿名标识不合法。');
      if (row.requestId != null && (typeof row.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(row.requestId))) invalid('请求编号不合法。');
      return { word: checked.word, status, createdAt, reason: String(row.reason || '').slice(0, 1000), key, visitorTag: row.visitorTag || null, requestId: row.requestId || null };
    });
    const p = payload.planet;
    if (p && (typeof p.name !== 'string' || Core.graphemes(p.name).length > 50 || !p.name.trim() || !['nebula','ocean','forest'].includes(p.theme))) invalid('星球元数据不合法。');
    const legacy = Number(payload.legacyTotal || 0);
    if (!Number.isSafeInteger(legacy) || legacy < 0) invalid('历史基数不合法。');
    const audits = payload.moderation || [];
    if (!Array.isArray(audits) || audits.length > 10000 || audits.some((row) => !row || typeof row.action !== 'string' || row.action.length > 100 || typeof row.actor !== 'string' || row.actor.length > 100 || (row.word != null && !Core.validateWord(row.word).ok) || !Number.isFinite(Date.parse(row.createdAt)))) invalid('管理记录不合法。');
    return transaction(() => {
      if (mode === 'replace') {
        run('DELETE FROM submissions WHERE planet=?', slug);
        run('DELETE FROM words WHERE planet=?', slug);
        run('UPDATE planets SET legacy_total=? WHERE slug=?', legacy, slug);
      }
      for (const row of words) run(`INSERT INTO words(planet,word,frequency,hidden,is_seed,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(planet,word)
        DO UPDATE SET frequency=MAX(words.frequency,excluded.frequency),hidden=excluded.hidden,is_seed=excluded.is_seed`, slug, row.word, row.frequency, row.hidden, row.isSeed, new Date().toISOString());
      if (get('SELECT COUNT(*) AS n FROM words WHERE planet=? AND hidden=0', slug).n > Core.MAX_WORDS) invalid('导入后公开词语超过 160 个，已全部回滚。');
      for (const row of records) run('INSERT OR IGNORE INTO submissions(planet,word,status,reason,created_at,import_key,visitor_hash,request_id) VALUES(?,?,?,?,?,?,?,?)', slug, row.word, row.status, row.reason, row.createdAt, row.key, row.visitorTag, row.requestId);
      if (p) run('UPDATE planets SET name=?,theme=?,review_mode=? WHERE slug=?', p.name.trim(), p.theme, p.reviewMode ? 1 : 0, slug);
      if (mode === 'merge') run('UPDATE planets SET legacy_total=MAX(legacy_total,?) WHERE slug=?', legacy, slug);
      for (const row of audits) {
        const stamp = new Date(row.createdAt).toISOString();
        if (!get('SELECT id FROM moderation_log WHERE planet=? AND action=? AND word IS ? AND actor=? AND created_at=?', slug, row.action, row.word || null, row.actor, stamp)) run('INSERT INTO moderation_log(planet,action,word,actor,created_at) VALUES(?,?,?,?,?)', slug, row.action, row.word || null, row.actor, stamp);
      }
      run('UPDATE planets SET version=version+1 WHERE slug=?', slug);
      run('INSERT INTO moderation_log(planet,action,created_at,actor) VALUES(?,?,?,?)', slug, `import:${mode}`, new Date().toISOString(), actor);
      return snapshot(slug);
    });
  }
  return { analytics, relations, importData };
}
module.exports = { features };
