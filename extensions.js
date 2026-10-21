/* Public sharing, insights, offline outbox and installation. No remote assets. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let configuration = {}, shareDialog, insightsDialog, outboxDialog, poster, insightVersion = 0;
  const SVG = 'http://www.w3.org/2000/svg';
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text);
    if (className) el.className = className;
    return el;
  }
  function button(text, action, className = 'ext-button') {
    const el = node('button', text, className); el.type = 'button'; el.addEventListener('click', action); return el;
  }
  function svg(tag, attributes = {}, text) {
    const el = document.createElementNS(SVG, tag);
    Object.entries(attributes).forEach(([key, value]) => el.setAttribute(key, String(value)));
    if (text !== undefined) el.textContent = String(text);
    return el;
  }
  const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  function state() {
    let provided = {};
    try { provided = configuration.getState?.() || {}; } catch (_) { /* DOM fallback */ }
    const slug = provided.slug || new URLSearchParams(location.search).get('planet') || 'default';
    let url = new URL(location.href); url.hash = '';
    if (provided.url) {
      try { const candidate = new URL(provided.url, location.href); if (candidate.origin === location.origin) url = candidate; } catch (_) { /* use this page */ }
    }
    return {
      slug, name: String(provided.name || '心光星球'), url: url.href,
      stats: provided.stats || {
        totalSubmissions: $('totalCount')?.textContent || 0,
        todaySubmissions: $('todayCount')?.textContent || 0,
        wordCount: $('wordCount')?.textContent || 0,
        activeVisitors: $('activeCount')?.textContent || 0
      }, sphereElement: provided.sphereElement || $('sphereStage')
    };
  }
  function status(text = '') { const el = node('p', text, 'ext-status'); el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); return el; }
  function dialog(id, title) {
    const el = node('dialog', undefined, 'ext-dialog ui-dialog'); el.id = id; el.setAttribute('aria-labelledby', `${id}Title`);
    const heading = node('div', undefined, 'ext-heading');
    const name = node('h2', title); name.id = `${id}Title`;
    const close = button('×', () => el.close(), 'ext-close'); close.setAttribute('aria-label', `关闭${title}`); close.autofocus = true;
    heading.append(name, close); el.append(heading);
    window.InnerLightUI?.decorateDialog(el);
    el.addEventListener('click', event => { if (event.target === el) { const rect = el.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) el.close(); } });
    document.body.append(el); return el;
  }
  function show(el) {
    if (!el.open) el.showModal();
  }
  function download(canvas, filename, message) {
    canvas.toBlob(blob => {
      if (!blob) { message.textContent = '图片生成失败，请重试。'; return; }
      const url = URL.createObjectURL(blob), link = node('a'); link.href = url; link.download = filename;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      message.textContent = '图片已生成；如果浏览器未下载，可长按预览图片保存。';
    }, 'image/png');
  }
  function qr(canvas, url) {
    return new Promise((resolve, reject) => {
      if (typeof window.QRCode?.toCanvas !== 'function') { reject(new Error('本地二维码组件暂不可用，请刷新页面后重试。')); return; }
      try {
        // npm qrcode's browser API supports this callback in both bundled variants.
        window.QRCode.toCanvas(canvas, url, { width: 320, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#111225', light: '#ffffff' } }, error => error ? reject(error) : resolve(canvas));
      } catch (error) { reject(error); }
    });
  }
  async function copyURL(url, message, fallback) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url); message.textContent = '星球链接已复制。';
    } catch (_) {
      fallback.hidden = false; fallback.value = url; fallback.focus(); fallback.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_) { /* select and copy manually */ }
      message.textContent = copied ? '星球链接已复制。' : '请复制下方已选中的星球链接。';
    }
  }
  function captureSphere(stage) {
    let providedWords = [];
    try { providedWords = configuration.getWords?.() || []; } catch (_) { /* DOM fallback */ }
    if (!stage) {
      const words = providedWords.map((item, i) => {
        const angle = i * Math.PI * (3 - Math.sqrt(5)), radius = 230 * Math.sqrt((i + .5) / providedWords.length);
        return { text: String(item.word), x: 300 + Math.cos(angle) * radius, y: 300 + Math.sin(angle) * radius, width: 160,
          size: 16 + Math.min(18, Math.log1p(number(item.frequency)) * 3), color: '#8ef7ed', opacity: 1, z: 0, scale: 1, visible: true };
      });
      return { width: 600, height: 600, words };
    }
    const rect = stage.getBoundingClientRect();
    const words = Array.from(stage.querySelectorAll('.word-tag')).map(el => {
      const label = el.querySelector('.word-label') || el;
      const bounds = label.getBoundingClientRect(), style = getComputedStyle(el), labelStyle = getComputedStyle(label);
      return {
        text: label.textContent || el.dataset.word || el.title || el.getAttribute('aria-label') || '', x: bounds.left - rect.left + bounds.width / 2, y: bounds.top - rect.top + bounds.height / 2,
        width: bounds.width, size: parseFloat(style.fontSize) || 16, color: labelStyle.color || style.color,
        opacity: number(style.opacity), z: Number(style.zIndex) || 0,
        scale: bounds.height / (label.offsetHeight || bounds.height || 1), visible: style.visibility !== 'hidden' && style.display !== 'none'
      };
    }).filter(word => word.visible && word.opacity > 0 && word.width > 0).sort((a, b) => a.z - b.z);
    return { width: rect.width || 600, height: rect.height || 600, words };
  }
  function fitText(ctx, text, x, y, maxWidth) {
    let content = String(text);
    if (ctx.measureText(content).width > maxWidth) {
      const characters = Array.from(content);
      while (characters.length && ctx.measureText(characters.join('') + '…').width > maxWidth) characters.pop();
      content = characters.join('') + '…';
    }
    ctx.fillText(content, x, y);
  }
  function drawPoster(canvas, current, snapshot, qrCanvas) {
    canvas.width = 1080; canvas.height = 1440;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('此浏览器无法生成海报。');
    ctx.fillStyle = '#111225'; ctx.fillRect(0, 0, 1080, 1440);
    const glow = ctx.createRadialGradient(540, 570, 30, 540, 570, 530);
    glow.addColorStop(0, '#29394b'); glow.addColorStop(.6, '#20233c'); glow.addColorStop(1, '#111225');
    ctx.fillStyle = glow; ctx.fillRect(0, 150, 1080, 950);
    for (let i = 0; i < 150; i++) {
      const x = ((i * 7919 + 73) % 1060) + 10, y = ((i * 3571 + 29) % 1000) + 180;
      ctx.globalAlpha = .12 + (i % 5) / 20; ctx.fillStyle = '#bce9ff'; ctx.beginPath(); ctx.arc(x, y, i % 3 ? 1 : 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.fillStyle = '#91eadd'; ctx.font = '24px sans-serif'; ctx.fillText('心光 · INNER LIGHT', 540, 85);
    ctx.fillStyle = '#eefcf8'; ctx.font = '48px sans-serif'; fitText(ctx, current.name, 540, 158, 920);
    const scale = Math.min(940 / snapshot.width, 800 / snapshot.height), left = (1080 - snapshot.width * scale) / 2, top = 230 + (800 - snapshot.height * scale) / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(40, 220, 1000, 830); ctx.clip(); ctx.textBaseline = 'middle';
    for (const word of snapshot.words) {
      ctx.globalAlpha = Math.min(1, word.opacity); ctx.fillStyle = word.color;
      ctx.font = `${Math.max(8, word.size * word.scale * scale)}px sans-serif`;
      fitText(ctx, word.text, left + word.x * scale, top + word.y * scale, Math.max(10, word.width * scale));
    }
    if (!snapshot.words.length) { ctx.fillStyle = '#b9cbcc'; ctx.font = '30px sans-serif'; ctx.fillText('等待第一束光', 540, 610); }
    ctx.restore();
    ctx.globalAlpha = 1; ctx.textAlign = 'center'; ctx.fillStyle = '#cce4df'; ctx.font = '25px sans-serif';
    const stats = current.stats;
    fitText(ctx, `${number(stats.wordCount ?? stats.uniqueWords ?? $('wordCount')?.textContent)} 个念头 · ${number(stats.totalSubmissions)} 次共鸣 · ${number(stats.todaySubmissions)} 今日`, 540, 1080, 960);
    ctx.drawImage(qrCanvas, 68, 1150, 214, 214);
    ctx.textAlign = 'left'; ctx.fillStyle = '#eefcf8'; ctx.font = '32px sans-serif'; ctx.fillText('扫码，遇见同频的念头', 320, 1215);
    ctx.fillStyle = '#a9c6c2'; ctx.font = '23px sans-serif'; ctx.fillText('把此刻的心光，送进这颗星球', 320, 1265);
    ctx.font = '18px sans-serif'; fitText(ctx, current.url, 320, 1310, 690);
    ctx.textAlign = 'center'; ctx.font = '18px sans-serif'; ctx.fillStyle = '#839caa'; ctx.fillText('此刻的星球快照 · 分享一束光', 540, 1400);
  }
  function openShare() {
    if (!shareDialog) {
      shareDialog = dialog('shareToolsDialog', '分享星球');
      shareDialog.classList.add('ext-share-dialog');
      const preview = node('div', undefined, 'ext-share-preview');
      const posterPanel = node('section', undefined, 'ext-share-poster'); posterPanel.setAttribute('aria-label', '星球海报');
      const posterFrame = node('div', undefined, 'ext-share-image');
      // The QR canvas is only used inside the poster, never added to the dialog.
      const posterQR = node('canvas');
      poster = node('canvas'); poster.setAttribute('role', 'img'); poster.setAttribute('aria-label', '星球海报');
      posterFrame.append(poster); posterPanel.append(posterFrame); preview.append(posterPanel);
      const message = status(), fallback = node('input'); fallback.type = 'url'; fallback.readOnly = true; fallback.hidden = true; fallback.className = 'ext-url'; fallback.setAttribute('aria-label', '星球链接');
      const downloadStatus = { set textContent(value) { message.textContent = value.startsWith('图片已生成') ? '图片已生成' : value; } };
      const actions = node('div', undefined, 'ext-actions ext-share-actions');
      const posterDownload = button('保存海报 ↓', () => download(poster, 'inner-light-poster.png', downloadStatus), 'ext-button ext-share-primary');
      const generate = async () => {
        const current = state(), snapshot = captureSphere(current.sphereElement);
        shareDialog.dataset.url = current.url;
        fallback.hidden = true;
        posterDownload.disabled = true; preview.setAttribute('aria-busy', 'true'); message.textContent = '生成中…';
        try {
          if (document.fonts?.ready) await document.fonts.ready;
          await qr(posterQR, current.url);
          drawPoster(poster, current, snapshot, posterQR);
          window.InnerLightUI?.enhanceImage(poster, { title: '星球海报' });
          message.textContent = ''; posterDownload.disabled = false;
        } catch (error) { message.textContent = error.message || '生成失败，请重试'; }
        finally { preview.removeAttribute('aria-busy'); }
      };
      actions.append(posterDownload, button('复制链接', () => copyURL(shareDialog.dataset.url || state().url, message, fallback)), button('分享 ↗', async () => {
        const url = shareDialog.dataset.url || state().url;
        if (!navigator.share) { await copyURL(url, message, fallback); return; }
        try { await navigator.share({ title: state().name, text: '来我的心光星球，遇见同频的念头。', url }); message.textContent = '分享已打开'; }
        catch (error) { if (error.name !== 'AbortError') await copyURL(url, message, fallback); }
      }, 'ext-button ext-share-native'));
      shareDialog.append(preview, actions, fallback, message); shareDialog.generate = generate;
    }
    show(shareDialog); void shareDialog.generate();
  }
  function table(captionText, headers, rows) {
    const wrapper = node('div', undefined, 'ext-table-wrap'), el = node('table', undefined, 'ext-table');
    el.append(node('caption', captionText));
    const head = node('thead'), header = node('tr');
    headers.forEach(text => { const th = node('th', text); th.scope = 'col'; header.append(th); }); head.append(header);
    const body = node('tbody');
    rows.forEach(row => { const tr = node('tr'); row.forEach((value, i) => { const cell = node(i ? 'td' : 'th', value); if (!i) cell.scope = 'row'; tr.append(cell); }); body.append(tr); });
    el.append(head, body); wrapper.append(el); return wrapper;
  }
  function fallbackTable(caption, headers, rows) {
    const details = node('details', undefined, 'ext-data'); details.append(node('summary', '查看数据'), table(caption, headers, rows)); return details;
  }
  function dailyChart(items) {
    const chart = svg('svg', { viewBox: '0 0 720 240', role: 'img', 'aria-label': '每日共鸣次数趋势图；完整数据见下方表格', 'data-preview-title': '共鸣趋势', class: 'ext-chart' });
    chart.append(svg('title', {}, '每日共鸣次数（UTC）'));
    const max = Math.max(1, ...items.map(item => number(item.count))), w = 640 / items.length;
    [0, .5, 1].forEach(fraction => {
      const y = 200 - fraction * 160;
      chart.append(svg('line', { x1: 54, x2: 702, y1: y, y2: y, class: 'ext-gridline' }), svg('text', { x: 46, y: y + 4, 'text-anchor': 'end', class: 'ext-axis' }, Math.round(max * fraction)));
    });
    items.forEach((item, i) => {
      const h = number(item.count) / max * 160;
      const bar = svg('rect', { x: 58 + i * w, y: 200 - h, width: Math.max(1, w - 2), height: h, rx: 2, class: 'ext-bar' });
      bar.append(svg('title', {}, `${item.date}: ${number(item.count)} 次`)); chart.append(bar);
    });
    if (items.length) chart.append(svg('text', { x: 58, y: 228, class: 'ext-axis' }, items[0].date), svg('text', { x: 698, y: 228, 'text-anchor': 'end', class: 'ext-axis' }, items[items.length - 1].date));
    return chart;
  }
  function relationNetwork(nodes, edges) {
    const chart = svg('svg', { viewBox: '0 0 720 540', role: 'img', 'aria-label': '词语关联网络；线条粗细代表关联强度，完整数据见下方表格', 'data-preview-title': '词语共现', class: 'ext-network' });
    chart.append(svg('title', {}, '词语关联网络'));
    const positions = new Map();
    nodes.forEach((item, i) => {
      const angle = -Math.PI / 2 + i * 2 * Math.PI / nodes.length;
      positions.set(String(item.word), { x: nodes.length === 1 ? 360 : 360 + Math.cos(angle) * 246, y: nodes.length === 1 ? 270 : 270 + Math.sin(angle) * 204 });
    });
    edges.forEach(edge => {
      const a = positions.get(String(edge.source)), b = positions.get(String(edge.target)); if (!a || !b) return;
      const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': Math.min(8, 1 + Math.log1p(number(edge.weight))), class: 'ext-edge' });
      line.append(svg('title', {}, `${edge.source} — ${edge.target}：${number(edge.weight)}`)); chart.append(line);
    });
    nodes.forEach(item => {
      const point = positions.get(String(item.word)), group = svg('g');
      group.append(svg('circle', { cx: point.x, cy: point.y, r: Math.min(17, 6 + Math.log1p(number(item.count))), class: 'ext-network-node' }), svg('text', { x: point.x, y: point.y + 30, 'text-anchor': 'middle', class: 'ext-network-label' }, Array.from(String(item.word)).slice(0, 12).join('')));
      group.append(svg('title', {}, `${item.word}：${number(item.count)} 次`)); chart.append(group);
    });
    return chart;
  }
  async function getJSON(url, signal) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
    let value = {}; try { value = await response.json(); } catch (_) { /* error below */ }
    if (!response.ok) throw new Error(value.message || `无法读取数据 (${response.status})`);
    return value;
  }
  function openInsights() {
    if (!insightsDialog) {
      insightsDialog = dialog('insightsDialog', '星球洞察');
      const controls = node('div', undefined, 'ext-actions'), label = node('label', '统计范围（UTC） '), select = node('select'); select.id = 'insightDays';
      [7, 30, 90].forEach(days => { const option = node('option', `最近 ${days} 天`); option.value = days; select.append(option); });
      label.append(select); controls.append(label, button('刷新洞察', () => loadInsights()));
      const message = status(), content = node('div'); content.id = 'insightContent';
      insightsDialog.append(controls, message, content); insightsDialog.message = message;
      select.addEventListener('change', () => loadInsights());
      insightsDialog.addEventListener('close', () => { insightVersion++; insightsDialog.controller?.abort(); });
    }
    show(insightsDialog); void loadInsights();
  }
  async function loadInsights() {
    const version = ++insightVersion, current = state(), days = $('insightDays').value;
    insightsDialog.controller?.abort(); const controller = new AbortController(); insightsDialog.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    const content = $('insightContent'); content.replaceChildren(); content.setAttribute('aria-busy', 'true'); insightsDialog.message.textContent = '正在读取星球洞察…';
    try {
      const base = `/api/planets/${encodeURIComponent(current.slug)}`;
      const [analytics, relations] = await Promise.allSettled([getJSON(`${base}/analytics?days=${days}`, controller.signal), getJSON(`${base}/relations`, controller.signal)]);
      if (version !== insightVersion) return;
      content.append(node('h3', `${current.name} · 最近 ${days} 天`));
      if (analytics.status === 'fulfilled') {
        const daily = Array.isArray(analytics.value.daily) ? analytics.value.daily : [], top = Array.isArray(analytics.value.top) ? analytics.value.top : [];
        content.append(node('h4', '每日趋势'));
        if (daily.length && daily.some(item => number(item.count))) content.append(dailyChart(daily));
        else content.append(node('p', '这段时间还没有共鸣记录。', 'ext-empty'));
        if (daily.length) content.append(fallbackTable('每日共鸣（UTC）', ['日期', '次数'], daily.map(item => [item.date, number(item.count)])));
        content.append(node('h4', '热门与增长'));
        if (top.length) content.append(table('本期与前一等长周期对比', ['词语', '本期', '上期', '变化'], top.map(item => {
          const delta = Number.isFinite(Number(item.delta)) ? Number(item.delta) : number(item.count) - number(item.previous);
          return [item.word, number(item.count), number(item.previous), `${delta > 0 ? '+' : ''}${delta}`];
        })));
        else content.append(node('p', '还没有热门词语。', 'ext-empty'));
      } else content.append(node('p', `趋势暂不可用：${analytics.reason.name === 'AbortError' ? '请求超时或已取消' : analytics.reason.message}`, 'ext-empty'));
      content.append(node('h4', '词语共现'));
      if (relations.status === 'fulfilled') {
        const nodes = Array.isArray(relations.value.nodes) ? relations.value.nodes : [], edges = Array.isArray(relations.value.edges) ? relations.value.edges : [];
        if (nodes.length) {
          content.append(relationNetwork(nodes.slice(0, 24), edges), fallbackTable('关联词语', ['词语', '次数'], nodes.map(item => [item.word, number(item.count)])));
          if (edges.length) content.append(fallbackTable('词语关联强度', ['词语一', '词语二', '强度'], edges.map(edge => [edge.source, edge.target, number(edge.weight)])));
          else content.append(node('p', '词语之间暂未形成关联。', 'ext-empty'));
        } else content.append(node('p', '还没有足够的数据生成关联网络。', 'ext-empty'));
      } else content.append(node('p', `关联暂不可用：${relations.reason.name === 'AbortError' ? '请求超时或已取消' : relations.reason.message}`, 'ext-empty'));
      insightsDialog.message.textContent = '洞察已更新。';
    } catch (error) { if (version === insightVersion) insightsDialog.message.textContent = error.message || '读取失败，请重试。'; }
    finally { clearTimeout(timeout); if (version === insightVersion) content.removeAttribute('aria-busy'); }
  }
  function openOutbox() {
    if (!outboxDialog) {
      outboxDialog = dialog('outboxDialog', '离线发送箱');
      const message = status(), list = node('div'); list.id = 'outboxEntries';
      outboxDialog.append(button('立即尝试发送', async event => {
        event.currentTarget.disabled = true; message.textContent = '正在尝试发送，限流条目仍会遵守等待时间…';
        try { await window.InnerLightOffline.flush(); message.textContent = '已尝试发送；未送达内容仍安全保留。'; }
        catch (error) { message.textContent = error.message; }
        finally { event.target.disabled = false; void refreshOutbox(); }
      }), message, list); outboxDialog.message = message;
    }
    show(outboxDialog); void refreshOutbox();
  }
  let outboxVersion = 0;
  async function refreshOutbox() {
    const version = ++outboxVersion;
    try {
      if (!window.InnerLightOffline) throw new Error('离线发送组件暂不可用。');
      const entries = await window.InnerLightOffline.list();
      if (version !== outboxVersion) return;
      const openButton = $('openOutbox');
      if (openButton) { (openButton.querySelector('span') || openButton).textContent = `发送箱${entries.length ? ` (${entries.length})` : ''}`; openButton.setAttribute('aria-label', `离线发送箱，${entries.length} 条待处理`); }
      if (!outboxDialog?.open) return;
      const list = $('outboxEntries');
      // Keep a focused edit field intact when another tab emits an update.
      if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      list.replaceChildren();
      if (!entries.length) { list.append(node('p', '暂无待发送内容', 'ext-empty')); return; }
      for (const entry of entries) {
        const item = node('section', undefined, 'ext-outbox-item');
        item.append(node('h3', entry.word), node('p', `星球：${entry.slug} · ${entry.state === 'blocked' ? '需要处理' : '等待发送'}`, 'ext-description'));
        if (entry.reason) item.append(node('p', entry.reason));
        if (entry.retryAt > Date.now()) item.append(node('p', `下次尝试不早于 ${new Date(entry.retryAt).toLocaleString()}`, 'ext-description'));
        if (entry.state === 'blocked') {
          const label = node('label', '编辑念头 '), input = node('input'); input.type = 'text'; input.value = entry.word; input.maxLength = 160; label.append(input);
          const actions = node('div', undefined, 'ext-actions');
          const act = async action => {
            try { await action(); outboxDialog.message.textContent = '发送箱已更新。'; await refreshOutbox(); }
            catch (error) { outboxDialog.message.textContent = error.message; }
          };
          actions.append(button('保存并重试', () => act(() => window.InnerLightOffline.edit(entry.requestId, input.value))), button('原文重试', () => act(() => window.InnerLightOffline.edit(entry.requestId, entry.word))), button('删除', () => act(() => window.InnerLightOffline.drop(entry.requestId))));
          item.append(label, actions);
        }
        list.append(item);
      }
    } catch (error) { if (outboxDialog) outboxDialog.message.textContent = error.message || '无法访问离线发送箱。'; }
  }
  function setupPWA() {
    if ('serviceWorker' in navigator && window.isSecureContext && !location.pathname.startsWith('/admin')) {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => window.InnerLightOffline?.flush()).catch(() => { /* public app still works without installation */ });
    }
    let prompt;
    function installButton() {
      let el = $('installApp');
      if (!el) {
        const host = document.querySelector('.header-actions') || document.querySelector('.site-footer');
        if (!host) return null;
        el = button('安装应用', async () => {
          if (!prompt) return;
          await prompt.prompt(); await prompt.userChoice; prompt = null; el.hidden = true;
        }, 'quiet-button'); el.id = 'installApp'; el.hidden = true; host.append(el);
      } else if (!el.dataset.extBound) {
        el.addEventListener('click', async () => { if (prompt) { await prompt.prompt(); await prompt.userChoice; prompt = null; el.hidden = true; } });
      }
      el.dataset.extBound = 'true'; return el;
    }
    const el = installButton(); if (el) el.hidden = true;
    window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event; const btn = installButton(); if (btn) btn.hidden = false; });
    window.addEventListener('appinstalled', () => { prompt = null; if ($('installApp')) $('installApp').hidden = true; });
  }
  window.InnerLightExtensions = { configure(options = {}) { configuration = { ...configuration, ...options }; }, openShare, openInsights, openOutbox, refreshOutbox };
  function start() {
    if (!document.querySelector('link[href$="extensions.css"]')) { const css = node('link'); css.rel = 'stylesheet'; css.href = '/extensions.css'; document.head.append(css); }
    document.addEventListener('click', event => {
      const control = event.target.closest?.('#openShareTools, #openInsights, #openOutbox');
      if (!control) return;
      ({ openShareTools: openShare, openInsights, openOutbox })[control.id]();
    });
    ['innerlight:outbox', 'innerlight:delivered'].forEach(type => window.addEventListener(type, () => { void refreshOutbox(); }));
    setupPWA(); void refreshOutbox();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
