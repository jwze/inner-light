(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const roles = { owner: '所有者', moderator: '审核员', viewer: '观察员' };
  const ask = (title, message, confirmText, danger = true) => window.InnerLightUI.confirm({ title, message, confirmText, danger });
  const statuses = { approved: ['已通过', 'success'], pending: ['待审核', 'warning'], rejected: ['已驳回', 'rejected'] };
  const actions = { hide: '屏蔽词语', restore: '恢复词语', clear: '屏蔽全部', settings: '更新设置', approved: '审核通过', rejected: '审核驳回', 'import:merge': '合并导入', 'import:replace': '替换恢复', 'word:upsert': '编辑词库', 'planet:create': '创建星球' };
  const pages = {
    overview: ['OVERVIEW', '数据概览', '看看这颗星球今天发生了什么。'],
    reviews: ['MODERATION', '内容审核', '让每一个公开的念头，都被认真对待。'],
    words: ['WORD LIBRARY', '词库管理', '整理星球的词语，维护内容与共鸣。'],
    planets: ['YOUR PLANETS', '星球设置', '为每一个小小宇宙，找到自己的样子。'],
    activity: ['ACTIVITY', '历史与日志', '每一次提交与管理操作，都有迹可循。'],
    backup: ['DATA & BACKUP', '备份恢复', '保存星球的数据，也为下一次出发做好准备。'],
    users: ['TEAM & ACCESS', '账户权限', '分工协作，为每位管理员配置合适的权限。'],
    system: ['SYSTEM', '运行状态', '了解服务状态与当前运行配置。']
  };
  let user, current, planets = [], activeSlug = 'default', page = 'overview', toastTimer, passwordTarget, loading = false;
  const selectedWords = new Set(), selectedReviews = new Set();
  const pagination = { words: 1, reviews: 1, history: 1, audit: 1 };
  const pageSize = 12;
  let visibleWords = [], visibleReviews = [];
  const owner = () => user?.role === 'owner';
  const canReview = () => ['owner', 'moderator'].includes(user?.role);
  const formatNumber = (value) => Number(value || 0).toLocaleString('zh-CN');
  const formatTime = (value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false }); };
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const cell = (row, text, className) => { const node = el('td', text, className); row.append(node); return node; };
  const badge = (status) => { const [label, cls] = statuses[status] || [status, 'neutral']; return el('span', label, `tag ${cls}`); };
  function message(text, error = false) {
    clearTimeout(toastTimer); $('message').textContent = text; $('message').className = `toast${error ? ' error' : ''}`; $('message').hidden = false;
    toastTimer = setTimeout(() => { $('message').hidden = true; }, error ? 10000 : 4500);
  }
  function signedOut() {
    user = null; current = null; planets = []; selectedWords.clear(); selectedReviews.clear();
    $('workspace').hidden = true; $('authScreen').hidden = false; $('token').value = '';
    for (const id of ['wordDialog', 'planetDialog', 'passwordDialog']) $(id).close();
    for (const id of ['words', 'reviews', 'recent', 'audit', 'users', 'planetCards', 'systemDetails']) $(id).replaceChildren();
    $('resetPassword').value = ''; $('newPassword').value = '';
  }
  async function request(path, options = {}, scoped = true) {
    const target = scoped ? `${path}${path.includes('?') ? '&' : '?'}planet=${encodeURIComponent(activeSlug)}` : path;
    const response = await fetch(target, { ...options, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', ...($('token').value ? { 'X-Admin-Token': $('token').value } : {}), ...options.headers } });
    if (!response.ok) {
      let body; try { body = await response.json(); } catch (_) { /* non-JSON server error */ }
      if (response.status === 401 && user) signedOut();
      throw Object.assign(new Error(body?.message || `请求失败（${response.status}）`), { status: response.status });
    }
    return response;
  }
  const data = async (...args) => (await request(...args)).json();
  const post = (path, value, scoped = true) => data(path, { method: 'POST', body: JSON.stringify(value) }, scoped);
  const action = (fn) => async (event) => {
    event?.preventDefault();
    const source = event?.currentTarget;
    const control = source?.tagName === 'FORM' ? source.querySelector('button[type=submit]') : source?.tagName === 'BUTTON' ? source : null;
    if (control?.dataset.busy) return;
    const disabled = control?.disabled;
    if (control) { control.dataset.busy = 'true'; control.disabled = true; }
    try { await fn(event); } catch (error) { message(error.name === 'TimeoutError' ? '请求超时，请刷新后确认操作结果。' : error.message, true); }
    finally {
      if (control) { delete control.dataset.busy; control.disabled = disabled; }
      syncSelection();
      if (control?.isConnected && !control.disabled && document.activeElement === document.body) control.focus({ preventScroll: true });
    }
  };
  const button = (text, fn, className = 'text-button', disabled = false) => { const node = el('button', text, className); node.type = 'button'; node.disabled = disabled; node.onclick = action(fn); return node; };
  function navigate(target, scroll = true) {
    if (!pages[target] || (!owner() && ['backup', 'users', 'system'].includes(target))) target = 'overview';
    page = target;
    all('[data-page]').forEach((node) => { node.classList.toggle('active', node.dataset.page === page); if (node.dataset.page === page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    all('[data-panel]').forEach((node) => { node.hidden = node.dataset.panel !== page; });
    const [eyebrow, title, description] = pages[page];
    $('pageEyebrow').textContent = eyebrow; $('pageTitle').textContent = title; $('breadcrumb').textContent = title; $('pageDescription').textContent = description;
    if (scroll) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function emptyTable(id, columns, text) { const row = el('tr'), td = cell(row, text, 'empty-cell'); td.colSpan = columns; $(id).replaceChildren(row); }
  function paged(items, key, id, render) {
    const total = Math.max(1, Math.ceil(items.length / pageSize)); pagination[key] = Math.max(1, Math.min(total, pagination[key]));
    const start = (pagination[key] - 1) * pageSize;
    const previous = button('上一页', () => { pagination[key]--; render(); }, '', pagination[key] === 1);
    const next = button('下一页', () => { pagination[key]++; render(); }, '', pagination[key] === total);
    $(id).replaceChildren(el('span', `共 ${formatNumber(items.length)} 条${items.length ? ` · 显示 ${start + 1}–${Math.min(start + pageSize, items.length)}` : ''}`, 'page-info'), previous, el('strong', `${pagination[key]} / ${total}`), next);
    return items.slice(start, start + pageSize);
  }
  function checkbox(value, selected, label, handler) {
    const input = el('input'); input.type = 'checkbox'; input.checked = selected.has(value); input.disabled = !canReview(); input.setAttribute('aria-label', label);
    input.onchange = () => { if (input.checked) selected.add(value); else selected.delete(value); handler(); };
    return input;
  }
  function syncSelection() {
    $('wordSelection').textContent = `已选 ${selectedWords.size} 项`; $('reviewSelection').textContent = `已选 ${selectedReviews.size} 项`;
    for (const [ids, selected] of [[['hideSelected', 'restoreSelected'], selectedWords], [['approveSelected', 'rejectSelected'], selectedReviews]]) for (const id of ids) $(id).disabled = !canReview() || !selected.size || Boolean($(id).dataset.busy);
    for (const [id, values, selected] of [['selectWords', visibleWords.map(w => w.word), selectedWords], ['selectReviews', visibleReviews.filter(r => r.status === 'pending').map(r => r.id), selectedReviews]]) {
      const count = values.filter(value => selected.has(value)).length;
      $(id).checked = values.length > 0 && count === values.length; $(id).indeterminate = count > 0 && count < values.length; $(id).disabled = !canReview() || !values.length;
    }
  }
  function renderOverview() {
    const pending = current.submissions.filter(r => r.status === 'pending').length;
    for (const [id, value] of Object.entries({ statTotal: current.stats.totalSubmissions, statToday: current.stats.todaySubmissions, statWords: current.stats.wordCount, statPending: pending, statVisitors: current.stats.uniqueVisitors, statActive: current.stats.activeVisitors, statHidden: current.words.filter(w => w.hidden).length })) $(id).textContent = formatNumber(value);
    $('wordCapacity').textContent = `容量 ${current.stats.wordCount} / 160 · 含示例词语`;
    $('reviewBadge').textContent = pending; $('overviewPlanetSlug').textContent = `/ ${current.planet.slug}`;
    $('overviewPlanetName').textContent = current.planet.name; $('overviewDescription').textContent = current.planet.description || '还没有星球介绍。';
    $('reviewModeTag').textContent = current.planet.reviewMode ? '提交预审已开启' : '直接公开'; $('reviewModeTag').className = `tag ${current.planet.reviewMode ? 'warning' : 'success'}`;
    const counts = new Map();
    current.submissions.filter(r => r.status === 'approved').forEach(r => { const date = r.createdAt.slice(0, 10); counts.set(date, (counts.get(date) || 0) + 1); });
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const daily = Array.from({ length: 7 }, (_, index) => { const date = new Date(today.getTime() - (6 - index) * 86400000).toISOString().slice(0, 10); return { date, count: counts.get(date) || 0 }; });
    const max = Math.max(1, ...daily.map(d => d.count));
    $('trend').replaceChildren(...daily.map(d => { const node = el('div', undefined, 'trend-column'), bar = el('div', undefined, 'bar'); bar.style.height = `${Math.max(1.5, d.count / max * 78)}%`; node.append(el('span', formatNumber(d.count), 'bar-value'), bar, el('span', d.date.slice(5).replace('-', '/'), 'bar-date')); node.title = `${d.date}：${d.count} 次共鸣`; return node; }));
    $('trend').setAttribute('aria-label', daily.map(d => `${d.date} ${d.count} 次`).join('；')); $('weeklyTotal').textContent = `本周合计 ${formatNumber(daily.reduce((sum, d) => sum + d.count, 0))} 次`;
    const top = current.words.filter(w => !w.hidden).sort((a, b) => b.frequency - a.frequency).slice(0, 6);
    $('topWords').replaceChildren(...top.map((w, index) => { const row = el('div', undefined, 'ranking-row'), track = el('div', undefined, 'rank-track'), fill = el('div', undefined, 'rank-fill'); fill.style.width = `${w.frequency / Math.max(1, top[0].frequency) * 100}%`; track.append(fill); row.append(el('span', String(index + 1).padStart(2, '0'), 'rank'), el('span', w.word, 'rank-name'), track, el('span', formatNumber(w.frequency), 'rank-count')); return row; }));
    if (!top.length) $('topWords').append(el('div', '还没有公开词语，去词库添加第一束光。', 'empty-state'));
    const recent = current.submissions.slice(-6).reverse();
    $('recentList').replaceChildren(...recent.map(r => { const row = el('div', undefined, 'recent-row'), content = el('div', undefined, 'recent-content'); content.append(el('span', r.word), el('time', formatTime(r.createdAt))); row.append(el('span', undefined, 'recent-dot'), content, badge(r.status)); return row; }));
    if (!recent.length) $('recentList').append(el('div', '暂无真实提交，期待第一个念头。', 'empty-state'));
  }
  function openWord(word) {
    $('wordDialogTitle').textContent = word ? '编辑词频' : '新增词语'; $('editWord').value = word?.word || ''; $('editWord').readOnly = Boolean(word); $('editFrequency').value = word?.frequency || 1; $('wordDialog').showModal();
  }
  function renderWords() {
    if (!current) return;
    const query = $('search').value.trim().toLowerCase(), filter = $('wordFilter').value;
    const items = current.words.filter(w => w.word.toLowerCase().includes(query) && (filter === 'all' || filter === 'public' && !w.hidden || filter === 'hidden' && w.hidden || filter === 'seed' && w.isSeed)).sort($('wordSort').value === 'name' ? (a, b) => a.word.localeCompare(b.word, 'zh-CN') : (a, b) => b.frequency - a.frequency || a.word.localeCompare(b.word, 'zh-CN'));
    $('wordCount').textContent = `${current.words.length} 个词语`;
    visibleWords = paged(items, 'words', 'wordPagination', renderWords);
    $('words').replaceChildren(...visibleWords.map(w => {
      const row = el('tr'); cell(row, undefined, 'checkbox-cell').append(checkbox(w.word, selectedWords, `选择词语 ${w.word}`, syncSelection)); cell(row, w.word, 'strong-cell'); cell(row, formatNumber(w.frequency)); cell(row).append(el('span', w.hidden ? '已屏蔽' : '公开', `tag ${w.hidden ? 'rejected' : 'success'}`)); cell(row, w.isSeed ? '示例词语' : '正式词语');
      const controls = cell(row, undefined, 'controls'); if (owner()) controls.append(button('编辑词频', () => openWord(w)));
      controls.append(button(w.hidden ? '恢复公开' : '屏蔽', async () => { await data(`/api/admin/words/${encodeURIComponent(w.word)}${w.hidden ? '/restore' : ''}`, { method: w.hidden ? 'POST' : 'DELETE' }); await load(); message(w.hidden ? '词语已恢复公开。' : '词语已屏蔽。'); }, `text-button${w.hidden ? '' : ' danger'}`, !canReview())); return row;
    }));
    if (!items.length) emptyTable('words', 6, '没有符合条件的词语。'); syncSelection();
  }
  function renderReviews() {
    if (!current) return;
    const query = $('reviewSearch').value.trim().toLowerCase(), status = $('reviewFilter').value;
    const items = current.submissions.filter(r => (r.status === 'pending' || r.status === 'rejected') && (status === 'all' || r.status === status) && `${r.word} ${r.reason}`.toLowerCase().includes(query)).reverse();
    $('reviewCount').textContent = `${items.length} 条`;
    visibleReviews = paged(items, 'reviews', 'reviewPagination', renderReviews);
    $('reviews').replaceChildren(...visibleReviews.map(r => {
      const row = el('tr'), check = cell(row, undefined, 'checkbox-cell'); if (r.status === 'pending') check.append(checkbox(r.id, selectedReviews, `选择待审记录 ${r.id}`, syncSelection)); cell(row, r.word, 'strong-cell'); cell(row).append(badge(r.status)); cell(row, r.reason || '等待人工审核', 'reason-cell'); cell(row, formatTime(r.createdAt), 'time-cell');
      const controls = cell(row, undefined, 'controls'); if (r.status === 'pending') for (const [decision, label] of [['approved', '通过'], ['rejected', '驳回']]) controls.append(button(label, async () => { await post(`/api/admin/reviews/${r.id}`, { decision }); await load(); message(`已${label}该提交。`); }, `text-button${decision === 'rejected' ? ' danger' : ''}`, !canReview())); else controls.append(el('span', '已处理', 'muted small')); return row;
    }));
    if (!items.length) emptyTable('reviews', 6, status === 'pending' ? '待审已清空，每个念头都有了回应。' : '没有符合条件的审核记录。'); syncSelection();
  }
  function renderHistory() {
    if (!current) return;
    const query = $('historySearch').value.trim().toLowerCase(), status = $('historyStatus').value, date = $('historyDate').value;
    const items = current.submissions.filter(r => (status === 'all' || r.status === status) && (!date || r.createdAt.startsWith(date)) && `${r.word} ${r.reason}`.toLowerCase().includes(query)).reverse();
    $('historyCount').textContent = `共 ${current.submissions.length} 条`;
    const visible = paged(items, 'history', 'historyPagination', renderHistory);
    $('recent').replaceChildren(...visible.map(r => { const row = el('tr'); cell(row, `#${r.id}`, 'small muted'); cell(row, r.word, 'strong-cell'); cell(row).append(badge(r.status)); cell(row, r.reason || '—', 'reason-cell'); cell(row, formatTime(r.createdAt), 'time-cell'); return row; }));
    if (!items.length) emptyTable('recent', 5, '没有符合条件的提交记录。');
  }
  function renderAudit() {
    if (!current) return;
    const query = $('auditSearch').value.trim().toLowerCase();
    const items = current.moderation.filter(r => `${r.action} ${actions[r.action] || ''} ${r.word || ''} ${r.actor}`.toLowerCase().includes(query));
    const visible = paged(items, 'audit', 'auditPagination', renderAudit);
    $('audit').replaceChildren(...visible.map(r => { const row = el('tr'); cell(row, actions[r.action] || r.action, 'strong-cell'); cell(row, r.word || '当前星球'); cell(row, r.actor); cell(row, formatTime(r.createdAt), 'time-cell'); return row; }));
    if (!items.length) emptyTable('audit', 4, '没有符合条件的操作日志。');
  }
  function renderPlanets() {
    $('planetCards').replaceChildren(...planets.map(p => {
      const node = button('', async () => { if (p.slug !== activeSlug) await load(p.slug); }, `planet-card${p.slug === activeSlug ? ' selected' : ''}`);
      node.setAttribute('aria-label', `${p.name}，${p.slug}${p.slug === activeSlug ? '，当前星球' : '，点击切换'}`); node.setAttribute('aria-pressed', String(p.slug === activeSlug));
      node.append(el('span', undefined, `planet-orb ${p.theme || 'nebula'}`), el('strong', p.name), el('span', `/ ${p.slug}`, 'planet-slug'), el('span', `${p.slug === activeSlug ? '● 当前星球' : '点击切换'}${p.stats ? ` · ${formatNumber(p.stats.wordCount)} 个公开词` : ''}`, 'planet-meta')); return node;
    }));
    $('name').value = current.planet.name; $('description').value = current.planet.description || ''; $('theme').value = current.planet.theme; $('reviewMode').checked = current.planet.reviewMode; $('settingsSlug').textContent = current.planet.slug; $('settingsFields').disabled = !owner(); $('settingsPermission').textContent = owner() ? '保存后立即生效。' : '当前角色仅可查看星球设置。';
  }
  async function renderUsers() {
    if (!owner()) { $('users').replaceChildren(); return; }
    const result = await data('/api/admin/users', {}, false); $('usersCount').textContent = `${result.items.length} 个账户`;
    $('users').replaceChildren(...result.items.map(u => {
      const row = el('tr'), name = cell(row, u.name, 'strong-cell account-name'); if (u.id === user.id) name.append(el('small', '当前账户'));
      const role = el('select', undefined, 'role-select'); role.setAttribute('aria-label', `${u.name} 的角色`); for (const [value, label] of Object.entries(roles)) { const option = el('option', label); option.value = value; role.append(option); } role.value = u.role;
      const scope = el('input', undefined, 'scope-input'); scope.value = u.planets.join(','); scope.setAttribute('aria-label', `${u.name} 的星球范围`);
      role.onchange = () => { if (role.value === 'owner') scope.value = '*'; };
      cell(row).append(role); cell(row).append(scope); cell(row).append(el('span', u.disabled ? '已禁用' : '正常', `tag ${u.disabled ? 'rejected' : 'success'}`));
      const update = async (value, text) => { await post(`/api/admin/users/${u.id}`, value, false); if (u.id === user.id && !user.bootstrap) { signedOut(); message('当前账户已更新，请重新登录。'); return; } await renderUsers(); message(text); };
      cell(row, undefined, 'controls').append(button('保存权限', () => update({ role: role.value, planets: scope.value.split(',').map(s => s.trim()).filter(Boolean) }, '权限已更新，旧会话已失效。')), button('重置密码', () => { passwordTarget = u; $('passwordUser').textContent = u.name; $('resetPassword').value = ''; $('passwordDialog').showModal(); }), button(u.disabled ? '启用' : '禁用', async () => { if (!u.disabled && !(await ask('禁用账户', `${u.name} 将退出登录，直到重新启用。`, '禁用账户'))) return; await update({ disabled: !u.disabled }, u.disabled ? '账户已启用。' : '账户已禁用。'); }, 'text-button danger'));
      return row;
    }));
    if (!result.items.length) emptyTable('users', 5, '还没有正式管理员，请先创建一个所有者账户。');
  }
  async function renderSystem() {
    if (!owner()) return;
    const info = await data('/api/admin/system', {}, false);
    const uptime = Math.floor(Number(info.uptimeSeconds ?? info.uptime ?? 0));
    const rows = [['数据存储', info.storage === 'sqlite' ? 'SQLite · WAL' : info.storage], ['运行时长', `${Math.floor(uptime / 3600)} 小时 ${Math.floor(uptime / 60) % 60} 分钟`], ['内容审核', info.moderation === 'configured' ? '第三方服务已配置' : '人工审核'], ['实时连接', `${info.sseClients ?? info.clients ?? 0} 个 SSE 连接`], ['每分钟提交上限', info.rateLimits?.minute ?? info.limits?.minute ?? '—'], ['每小时提交上限', info.rateLimits?.hour ?? info.limits?.hour ?? '—'], ['拦截关键词', `${info.blockedWordsCount ?? info.blockedWordCount ?? 0} 个`]];
    $('systemDetails').replaceChildren(...rows.map(([label, value]) => { const node = el('div'); node.append(el('dt', label), el('dd', String(value ?? '—'))); return node; }));
  }
  async function load(slug = activeSlug) {
    if (loading) return;
    loading = true; $('planet').disabled = true; $('refresh').disabled = true;
    try {
      const me = await data('/api/auth/me', {}, false); user = me.user;
      const result = await data('/api/admin/planets', {}, false); planets = result.items;
      if (!planets.length) throw Error('当前账户没有可访问的星球，请联系所有者分配已有星球。');
      const target = planets.find(p => p.slug === slug)?.slug || planets[0].slug;
      const previousSlug = activeSlug; activeSlug = target;
      try { current = await data('/api/admin/export'); } catch (error) { activeSlug = previousSlug; throw error; }
      if (previousSlug !== activeSlug) for (const key of Object.keys(pagination)) pagination[key] = 1;
      selectedWords.clear(); selectedReviews.clear();
      $('planet').replaceChildren(...planets.map(p => { const option = el('option', p.name); option.value = p.slug; return option; })); $('planet').value = activeSlug;
      $('userRole').textContent = `${user.bootstrap ? '引导账户' : user.name} · ${roles[user.role]}`; $('userRole').title = $('userRole').textContent; $('bootstrapNotice').hidden = !user.bootstrap;
      all('[data-owner]').forEach(node => { node.hidden = !owner(); }); all('[data-review]').forEach(node => { node.disabled = !canReview(); });
      $('view').href = `/?planet=${encodeURIComponent(activeSlug)}`; $('importConfirm').placeholder = activeSlug;
      renderOverview(); renderWords(); renderReviews(); renderHistory(); renderAudit(); renderPlanets();
      await Promise.all([renderUsers(), renderSystem()]);
      $('authScreen').hidden = true; $('workspace').hidden = false; navigate(page, false);
      $('lastUpdated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    } finally { loading = false; $('planet').disabled = false; $('refresh').disabled = false; }
  }
  async function batchWords(actionName) {
    if (!selectedWords.size) return;
    const count = selectedWords.size;
    if (actionName === 'hide' && !(await ask('屏蔽所选词语', `选中的 ${count} 个词语将从公开星球隐藏，可随时恢复。`, '屏蔽词语'))) return;
    await post('/api/admin/words/batch', { words: [...selectedWords], action: actionName }); await load(); message(`已${actionName === 'hide' ? '屏蔽' : '恢复'} ${count} 个词语。`);
  }
  async function batchReviews(decision) {
    if (!selectedReviews.size) return;
    const count = selectedReviews.size;
    if (!(await ask(decision === 'approved' ? '通过提交' : '驳回提交', `已选 ${count} 条提交，处理后不可重复审核。`, decision === 'approved' ? '通过所选' : '驳回所选', decision !== 'approved'))) return;
    await post('/api/admin/reviews/batch', { ids: [...selectedReviews], decision }); await load(); message(`已处理 ${count} 条提交。`);
  }
  function download(blob, name) { const anchor = el('a'), url = URL.createObjectURL(blob); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  all('[data-page]').forEach(node => { node.onclick = () => navigate(node.dataset.page); });
  all('[data-goto]').forEach(node => { node.onclick = () => navigate(node.dataset.goto); });
  all('[data-close]').forEach(node => { node.onclick = () => { $(node.dataset.close).close(); if (node.dataset.close === 'passwordDialog') $('resetPassword').value = ''; }; });
  all('dialog').forEach(node => { node.addEventListener('close', () => { if (node.id === 'passwordDialog') $('resetPassword').value = ''; }); });
  $('loginForm').onsubmit = action(async () => { $('token').value = ''; await post('/api/auth/login', { name: $('loginName').value, password: $('loginPassword').value }, false); $('loginPassword').value = ''; await load(); message('欢迎回来。'); });
  $('tokenForm').onsubmit = action(async () => { await load(); message('已使用引导令牌进入。'); });
  $('logout').onclick = action(async () => { await post('/api/auth/logout', {}, false); signedOut(); message('已退出登录。'); });
  $('planet').onchange = action(async () => { const slug = $('planet').value; $('planet').value = activeSlug; await load(slug); message('已切换星球。'); });
  $('refresh').onclick = action(async () => { await load(); message('数据已更新。'); });
  for (const [id, key, render] of [['search', 'words', renderWords], ['wordFilter', 'words', renderWords], ['wordSort', 'words', renderWords], ['reviewSearch', 'reviews', renderReviews], ['reviewFilter', 'reviews', renderReviews], ['historySearch', 'history', renderHistory], ['historyStatus', 'history', renderHistory], ['historyDate', 'history', renderHistory], ['auditSearch', 'audit', renderAudit]]) $(id).addEventListener(['search', 'reviewSearch', 'historySearch', 'auditSearch'].includes(id) ? 'input' : 'change', () => { pagination[key] = 1; if (key === 'words') selectedWords.clear(); if (key === 'reviews') selectedReviews.clear(); render(); });
  $('selectWords').onchange = () => { visibleWords.forEach(w => { if ($('selectWords').checked) selectedWords.add(w.word); else selectedWords.delete(w.word); }); renderWords(); };
  $('selectReviews').onchange = () => { visibleReviews.filter(r => r.status === 'pending').forEach(r => { if ($('selectReviews').checked) selectedReviews.add(r.id); else selectedReviews.delete(r.id); }); renderReviews(); };
  $('hideSelected').onclick = action(() => batchWords('hide')); $('restoreSelected').onclick = action(() => batchWords('restore'));
  $('approveSelected').onclick = action(() => batchReviews('approved')); $('rejectSelected').onclick = action(() => batchReviews('rejected'));
  $('clear').onclick = action(async () => { if (!(await ask('屏蔽全部词语', `「${current.planet.name}」的全部词语将被隐藏，词频与历史保留。`, '屏蔽全部'))) return; await post('/api/admin/clear', {}); await load(); message('全部词语已屏蔽。'); });
  $('addWord').onclick = () => openWord();
  $('editFrequency').max = 9999;
  $('wordForm').onsubmit = action(async () => { await post('/api/admin/words', { word: $('editWord').value, frequency: Number($('editFrequency').value) }); $('wordDialog').close(); await load(); message('词库已保存。'); });
  $('settingsForm').onsubmit = action(async () => { await post('/api/admin/planet', { name: $('name').value, description: $('description').value, theme: $('theme').value, reviewMode: $('reviewMode').checked }); await load(); message('星球设置已保存。'); });
  $('createPlanet').onclick = () => { $('planetForm').reset(); $('planetDialog').showModal(); };
  $('planetForm').onsubmit = action(async () => { const slug = $('planetSlug').value; await post('/api/admin/planets', { slug, name: $('planetName').value, description: $('planetDescription').value, theme: $('planetTheme').value, reviewMode: $('planetReview').checked, seed: $('planetSeed').checked }, false); $('planetDialog').close(); await load(slug); message('新星球已创建。'); });
  all('[data-activity]').forEach(node => { node.onclick = () => { const audit = node.dataset.activity === 'audit'; $('auditCard').hidden = !audit; $('submissionsCard').hidden = audit; all('[data-activity]').forEach(tab => tab.classList.toggle('active', tab === node)); }; });
  $('resetHistory').onclick = () => { $('historySearch').value = ''; $('historyStatus').value = 'all'; $('historyDate').value = ''; pagination.history = 1; renderHistory(); };
  $('export').onclick = action(async () => { const value = await data('/api/admin/export'); download(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }), `inner-light-${activeSlug}.json`); message('完整备份已下载。'); });
  $('exportCSV').onclick = action(async () => { const response = await request('/api/admin/export.csv'); download(await response.blob(), `inner-light-${activeSlug}.csv`); });
  $('importMode').onchange = () => { const replace = $('importMode').value === 'replace'; $('importConfirmLabel').hidden = !replace; $('importConfirm').required = replace; $('importExplanation').textContent = replace ? '替换将清除当前词库和提交历史，再恢复文件中的数据；管理员账户和管理审计链保留。请先下载备份。' : '合并时词频取较大值，历史记录去重，不重复累加。'; };
  $('importForm').onsubmit = action(async () => { const file = $('importFile').files[0]; if (!file) throw Error('请先选择文件。'); if (file.size > 5 * 1024 * 1024) throw Error('文件不能超过 5 MB。'); if (!/\.(json|csv)$/i.test(file.name)) throw Error('请选择 JSON 或 CSV 文件。'); if ($('importMode').value === 'replace' && $('importConfirm').value !== activeSlug) throw Error('请输入当前星球地址确认替换。'); if ($('importMode').value === 'replace' && !(await ask('替换星球数据', `「${current.planet.name}」的词库和提交历史将被备份内容替换。`, '替换数据'))) return; const text = await file.text(), format = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json'; let payload; try { payload = format === 'json' ? { data: JSON.parse(text) } : { content: text }; } catch (_) { throw Error('JSON 文件格式不正确。'); } await post('/api/admin/import', { format, mode: $('importMode').value, confirm: $('importConfirm').value, ...payload }); await load(); $('importFile').value = ''; $('importConfirm').value = ''; message('导入完成，星球数据已更新。'); });
  $('newRole').onchange = () => { if ($('newRole').value === 'owner') $('newPlanets').value = '*'; else if ($('newPlanets').value === '*') $('newPlanets').value = activeSlug; };
  $('createUserForm').onsubmit = action(async () => { await post('/api/admin/users', { name: $('newName').value, password: $('newPassword').value, role: $('newRole').value, planets: $('newPlanets').value.split(',').map(s => s.trim()).filter(Boolean) }, false); $('newPassword').value = ''; $('newName').value = ''; await renderUsers(); message('管理员账户已创建。'); });
  $('passwordForm').onsubmit = action(async () => { const target = passwordTarget; await post(`/api/admin/users/${target.id}`, { password: $('resetPassword').value }, false); $('passwordDialog').close(); if (target.id === user.id && !user.bootstrap) { signedOut(); message('密码已更新，请使用新密码登录。'); return; } await renderUsers(); message('密码已更新，该账户的旧会话已失效。'); });
  load().catch(error => { if (error.status !== 401) message(error.message, true); });
})();
