/* Shared dialog styling and media previews. No sphere or poster generation hooks. */
(() => {
  'use strict';
  const API = window.InnerLightUI || {};
  const CANDIDATES = 'img, canvas[role="img"], svg[role="img"], [data-image-preview], .ui-preview-source';
  const EXCLUDED = '.ui-media-viewer, #sphereStage, #wordLayer, #flightSvg, .sphereWord, .sphere-word, .word-tag, .flight-svg, .flight-word, .particle-layer, .effect-layer, [aria-hidden="true"], [role="presentation"], [role="none"], [data-decorative], .decorative, .background-image, [data-image-preview="false"], [data-ui-preview="off"]';
  const enhanced = new WeakMap();
  let sequence = 0;
  let activeViewer = null;

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  }
  function action(text, label, className = '') {
    const el = element('button', className, text);
    el.type = 'button';
    if (label) { el.setAttribute('aria-label', label); el.title = label; }
    return el;
  }
  const ICON_PATHS = {
    close: 'M6 6l12 12M18 6 6 18',
    refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.2 3M17.9 17.9a8 8 0 0 1-13.2-3',
    minus: 'M5 12h14',
    plus: 'M5 12h14M12 5v14',
    overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    review: 'M9 4H5v17h14V4h-4M9 3h6v4H9zM8 13l3 3 5-6',
    words: 'M4 4h6v16H4zM14 4h6v16h-6zM4 8h6M14 8h6',
    planet: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM2 16c2 2 8 1 13-2s8-6 7-8',
    history: 'M3 12a9 9 0 1 1 2.6 6.4M3 4v8h8M12 7v5l3 2',
    download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    users: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM5 21v-3a7 7 0 0 1 14 0v3M18 4a3 3 0 0 1 0 6M21 21v-3a8 8 0 0 0-2-5',
    system: 'M3 4h18v12H3zM8 21h8M12 16v5M6 10h3l2-3 2 6 2-3h3'
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'ui-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.close);
    svg.append(path);
    return svg;
  }
  function iconAction(name, label, className = '') {
    const el = action('', label, className);
    el.append(icon(name));
    return el;
  }
  function uid() {
    let id;
    do { id = `il-ui-${++sequence}`; } while (document.getElementById(id));
    return id;
  }
  function focusable(el) {
    return el?.isConnected && !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
      !el.matches(':disabled') && (!el.closest('dialog') || el.closest('dialog').open) && el.getClientRects().length > 0;
  }
  function restoreFocus(source, previous) {
    let target = [source, previous].find(focusable);
    if (!target) {
      const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
      target = dialogs.at(-1)?.querySelector('button:not(:disabled), [tabindex="0"], input:not(:disabled)');
    }
    if (focusable(target)) {
      const temporaryTabIndex = !target.hasAttribute('tabindex') && target.tabIndex < 0;
      if (temporaryTabIndex) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
      if (temporaryTabIndex) target.removeAttribute('tabindex');
    }
  }
  function syncModalScroll() {
    document.documentElement.classList.toggle('ui-modal-open', Boolean(document.querySelector('dialog[open]')));
  }
  function decorateDialog(dialog, options = {}) {
    if (!dialog?.matches?.('dialog') || dialog.classList.contains('ui-media-viewer')) return dialog;
    dialog.classList.add('ui-dialog');
    const heading = dialog.querySelector('.ext-heading h2, .dialog-heading h2, h2, h1, [role="heading"]');
    if (heading) {
      heading.classList.add('ui-dialog-title');
      let icon = Array.from(heading.children).find(child => child.classList.contains('ui-title-icon'));
      if (!icon) {
        icon = element('span', 'ui-title-icon');
        icon.setAttribute('aria-hidden', 'true');
        heading.prepend(icon);
      }
      const mark = String(options.icon ?? icon.textContent ?? '✦') || '✦';
      if (icon.textContent !== mark) icon.textContent = mark;
      if (!dialog.hasAttribute('aria-label') && !dialog.hasAttribute('aria-labelledby')) {
        if (!heading.id) heading.id = uid();
        dialog.setAttribute('aria-labelledby', heading.id);
      }
    }
    return dialog;
  }

  function confirm({ title = '请确认', message = '', confirmText = '确认', cancelText = '取消', danger = false } = {}) {
    return new Promise(resolve => {
      const previous = document.activeElement;
      const dialog = element('dialog', 'ui-dialog ui-confirm');
      dialog.setAttribute('role', 'alertdialog');
      const header = element('div', 'ui-dialog-header');
      const heading = element('h2', '', title);
      const close = iconAction('close', '关闭确认弹窗', 'ui-close');
      header.append(heading, close);
      const content = element('p', 'ui-confirm-message', message);
      if (message) { content.id = uid(); dialog.setAttribute('aria-describedby', content.id); }
      else content.hidden = true;
      const footer = element('div', 'ui-dialog-actions');
      const cancel = action(cancelText, '', 'ui-secondary');
      const accept = action(confirmText, '', danger ? 'ui-danger' : 'ui-primary');
      cancel.autofocus = true;
      footer.append(cancel, accept); dialog.append(header, content, footer);
      decorateDialog(dialog, { icon: danger ? '!' : '✦' });
      const events = new AbortController();
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true; events.abort();
        if (dialog.open) dialog.close();
        dialog.remove(); restoreFocus(previous, null); resolve(value);
      };
      const on = (el, type, handler) => el.addEventListener(type, handler, { signal: events.signal });
      on(cancel, 'click', () => finish(false));
      on(close, 'click', () => finish(false));
      on(accept, 'click', () => finish(true));
      on(dialog, 'cancel', event => { event.preventDefault(); event.stopPropagation(); finish(false); });
      on(dialog, 'keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
      on(dialog, 'close', () => finish(false));
      let backdropStart = false;
      const outside = event => {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
      };
      on(dialog, 'pointerdown', event => { backdropStart = outside(event); });
      on(dialog, 'click', event => { if (backdropStart && outside(event)) finish(false); backdropStart = false; });
      document.body.append(dialog);
      try { dialog.showModal(); cancel.focus({ preventScroll: true }); }
      catch (_) { finish(false); }
    });
  }

  function mediaTitle(source, supplied) {
    const entry = enhanced.get(source);
    const label = source?.getAttribute?.('aria-label');
    return String(supplied || source?.getAttribute?.('data-preview-title') ||
      (entry?.generatedLabel === label ? entry.title : label) || source?.getAttribute?.('alt') ||
      source?.getAttribute?.('title') || '图片预览');
  }
  function excluded(source) {
    return !source?.matches || !!source.closest(EXCLUDED) ||
      (source.matches('img') && source.getAttribute('alt') === '' && !source.hasAttribute('data-image-preview'));
  }
  function unavailable(source) {
    return !source?.isConnected || excluded(source) || !!source.closest('[hidden], [inert], [aria-busy="true"], [aria-disabled="true"], :disabled');
  }
  function offscreen(source) {
    if (!source.matches('canvas')) return false;
    const style = getComputedStyle(source);
    return style.display === 'none' || style.visibility === 'hidden' ||
      (['absolute', 'fixed'].includes(style.position) && (parseFloat(style.left) < -1000 || parseFloat(style.top) < -1000));
  }
  function enhanceImage(source, options = {}) {
    if (excluded(source) || offscreen(source)) return source;
    const existing = enhanced.get(source);
    if (existing) { existing.options = options; return source; }
    const entry = { options, title: mediaTitle(source, options.title) };
    enhanced.set(source, entry);
    source.classList.add('ui-preview-source');
    if (!source.hasAttribute('tabindex') || source.tabIndex < 0) source.setAttribute('tabindex', '0');
    if (!source.hasAttribute('role') || source.getAttribute('role') === 'img') source.setAttribute('role', 'button');
    source.setAttribute('aria-haspopup', 'dialog');
    source.setAttribute('aria-keyshortcuts', 'Enter Space');
    if (!source.hasAttribute('aria-label')) {
      entry.generatedLabel = `全屏查看：${entry.title}`;
      source.setAttribute('aria-label', entry.generatedLabel);
    }
    const open = event => {
      if (unavailable(source) || event.defaultPrevented) return;
      const control = event.target.closest?.('button, a, input, select, textarea, [contenteditable="true"], .ui-preview-source');
      if (event.target !== source && control && control !== source) return;
      event.preventDefault(); event.stopPropagation();
      preview(source, entry.options);
    };
    source.addEventListener('click', open);
    source.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) open(event);
    });
    return source;
  }

  function copyCanvas(source, target) {
    if (!source.width || !source.height) throw new Error('图片尚未生成');
    target.width = source.width; target.height = source.height;
    const context = target.getContext('2d');
    if (!context) throw new Error('此浏览器无法预览图片');
    context.drawImage(source, 0, 0);
  }
  // Freeze computed styles before leaving the original modal's CSS ancestry.
  function cloneChart(source) {
    const clone = source.cloneNode(true);
    const originals = [source, ...source.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    const ids = new Map();
    originals.forEach((original, index) => {
      const copy = copies[index], style = getComputedStyle(original);
      for (let i = 0; i < style.length; i++) {
        const property = style[i];
        copy.style?.setProperty(property, style.getPropertyValue(property));
      }
      if (copy.id) { const next = uid(); ids.set(copy.id, next); copy.id = next; }
      if (original.matches('canvas')) copyCanvas(original, copy);
      if (original.matches('img') && original.currentSrc) {
        copy.removeAttribute('srcset'); copy.removeAttribute('sizes'); copy.src = original.currentSrc;
      }
    });
    const references = new Set(['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'for', 'headers']);
    copies.forEach(copy => {
      if (copy.matches('script, style, link, iframe, object, embed, animate, animateMotion, animateTransform, set')) { copy.remove(); return; }
      Array.from(copy.attributes).forEach(attribute => {
        const name = attribute.name;
        if (/^on/i.test(name) || ['autofocus', 'accesskey', 'name', 'form', 'data-image-preview'].includes(name)) {
          copy.removeAttribute(name); return;
        }
        let value = attribute.value;
        if (references.has(name)) value = value.split(/\s+/).map(id => ids.get(id) || '').filter(Boolean).join(' ');
        if ((name === 'href' || name === 'xlink:href') && value.startsWith('#') && ids.has(value.slice(1))) value = `#${ids.get(value.slice(1))}`;
        value = value.replace(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)/g, (match, quote, url) => {
          const hash = url.lastIndexOf('#');
          if (hash < 0 || !ids.has(url.slice(hash + 1))) return match;
          const prefix = url.slice(0, hash);
          if (prefix && prefix !== location.href.split('#')[0]) return match;
          return `url("#${ids.get(url.slice(hash + 1))}")`;
        });
        if (value !== attribute.value) copy.setAttribute(name, value);
      });
      copy.classList.remove('ui-preview-source');
      copy.removeAttribute('aria-keyshortcuts'); copy.removeAttribute('aria-haspopup');
      copy.removeAttribute('tabindex');
      if (copy.matches('a')) { copy.removeAttribute('href'); copy.removeAttribute('xlink:href'); }
      if (copy.matches('button, input, select, textarea, fieldset')) copy.disabled = true;
      if (copy.hasAttribute('contenteditable')) copy.setAttribute('contenteditable', 'false');
      if (copy.matches('a, button, input, select, textarea, summary, audio, video, [contenteditable]')) copy.setAttribute('tabindex', '-1');
      if (copy.matches('audio, video')) { copy.removeAttribute('autoplay'); copy.removeAttribute('controls'); }
      copy.style?.setProperty('animation', 'none', 'important');
      copy.style?.setProperty('transition', 'none', 'important');
      copy.style?.setProperty('pointer-events', 'none', 'important');
    });
    clone.setAttribute('inert', '');
    clone.setAttribute('aria-hidden', 'true');
    return clone;
  }

  function preview(source, { title } = {}) {
    const isURL = typeof source === 'string';
    if (!isURL && (unavailable(source) || offscreen(source))) return null;
    if (activeViewer) activeViewer.dispose(false);
    let origin = isURL ? null : source;
    let previous = document.activeElement;
    let media = null, disposed = false, ready = false;
    let width = 1, height = 1, zoom = 1, panX = 0, panY = 0, fitScale = 1;
    const pointers = new Map();
    const events = new AbortController();
    const { signal } = events;
    const dialog = element('dialog', 'ui-media-viewer');
    const heading = element('h2', 'ui-media-title', mediaTitle(origin, title));
    heading.id = uid(); dialog.setAttribute('aria-labelledby', heading.id);
    const header = element('header', 'ui-media-header');
    const close = iconAction('close', '关闭全屏预览', 'ui-media-close'); close.autofocus = true;
    header.append(heading, close);
    const stage = element('div', 'ui-media-stage');
    stage.setAttribute('role', 'img'); stage.setAttribute('aria-label', mediaTitle(origin, title));
    stage.setAttribute('aria-busy', 'true');
    const frame = element('div', 'ui-media-frame'); frame.setAttribute('aria-hidden', 'true');
    const status = element('p', 'ui-media-status', '加载中…'); status.setAttribute('role', 'status');
    stage.append(frame, status);
    const toolbar = element('div', 'ui-media-toolbar'); toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', '图片缩放');
    const minus = iconAction('minus', '缩小图片');
    const plus = iconAction('plus', '放大图片');
    const fit = action('适应屏幕', '图片适应屏幕');
    const scaleLabel = element('output', 'ui-media-scale', '100%'); scaleLabel.setAttribute('aria-label', '相对适应屏幕的缩放比例');
    toolbar.append(minus, scaleLabel, plus, fit); dialog.append(header, stage, toolbar);
    const listen = (el, type, handler, extra = {}) => el.addEventListener(type, handler, { ...extra, signal });
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const render = () => {
      const bounds = stage.getBoundingClientRect();
      fitScale = Math.max(.0001, Math.min(Math.max(1, bounds.width - 32) / width, Math.max(1, bounds.height - 32) / height));
      const limitX = Math.max(0, (width * fitScale * zoom - bounds.width + 32) / 2);
      const limitY = Math.max(0, (height * fitScale * zoom - bounds.height + 32) / 2);
      panX = clamp(panX, -limitX, limitX); panY = clamp(panY, -limitY, limitY);
      frame.style.width = `${width}px`; frame.style.height = `${height}px`;
      frame.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${fitScale * zoom})`;
      scaleLabel.textContent = `${Math.round(zoom * 100)}%`;
      minus.disabled = !ready || zoom <= 1; plus.disabled = !ready || zoom >= 8; fit.disabled = !ready;
      stage.classList.toggle('is-zoomed', ready && zoom > 1);
    };
    const zoomTo = (value, x = 0, y = 0, oldX = x, oldY = y) => {
      if (!ready) return;
      const next = clamp(value, 1, 8), ratio = next / zoom;
      panX = x - (oldX - panX) * ratio; panY = y - (oldY - panY) * ratio;
      zoom = next; render();
    };
    const dispose = (restore = true) => {
      if (disposed) return;
      disposed = true; events.abort(); resizeObserver?.disconnect(); pointers.clear();
      if (dialog.open) dialog.close();
      if (activeViewer?.dialog === dialog) activeViewer = null;
      frame.querySelectorAll('canvas').forEach(canvas => { canvas.width = 0; canvas.height = 0; });
      frame.replaceChildren(); media = null; dialog.remove();
      if (restore) restoreFocus(origin, previous);
      origin = null; previous = null;
    };
    const setReady = (newWidth, newHeight) => {
      if (disposed) return;
      if (!newWidth || !newHeight) { fail('图片尚未生成'); return; }
      width = newWidth; height = newHeight; ready = true;
      status.hidden = true; stage.setAttribute('aria-busy', 'false'); render();
    };
    const fail = message => {
      if (disposed) return;
      ready = false; status.hidden = false; status.textContent = message;
      stage.setAttribute('aria-busy', 'false'); render();
    };
    listen(close, 'click', () => dispose());
    listen(dialog, 'cancel', event => { event.preventDefault(); event.stopPropagation(); dispose(); });
    listen(dialog, 'close', () => dispose());
    listen(plus, 'click', () => zoomTo(zoom * 1.4));
    listen(minus, 'click', () => zoomTo(zoom / 1.4));
    listen(fit, 'click', () => { panX = panY = 0; zoomTo(1); });
    listen(dialog, 'keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key;
      if (['+', '=', '-', '0'].includes(key)) {
        event.preventDefault(); event.stopPropagation(); zoomTo(key === '0' ? 1 : zoom * (key === '-' ? 1 / 1.4 : 1.4));
      } else if (zoom > 1 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
        event.preventDefault(); event.stopPropagation();
        panX += key === 'ArrowLeft' ? 60 : key === 'ArrowRight' ? -60 : 0;
        panY += key === 'ArrowUp' ? 60 : key === 'ArrowDown' ? -60 : 0; render();
      }
    });
    listen(stage, 'dragstart', event => event.preventDefault());
    listen(stage, 'wheel', event => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      zoomTo(zoom * Math.exp(clamp(-delta * .002, -.4, .4)), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    }, { passive: false });
    listen(stage, 'pointerdown', event => {
      if (!ready || (event.pointerType === 'mouse' && event.button !== 0)) return;
      event.preventDefault(); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      stage.setPointerCapture?.(event.pointerId);
      stage.classList.add('is-dragging');
    });
    listen(stage, 'pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      event.preventDefault();
      const before = Array.from(pointers.values());
      const old = pointers.get(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = Array.from(pointers.values());
      if (after.length >= 2) {
        const distance = points => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const rect = stage.getBoundingClientRect();
        zoomTo(zoom * distance(after) / Math.max(1, distance(before)),
          (after[0].x + after[1].x) / 2 - rect.left - rect.width / 2,
          (after[0].y + after[1].y) / 2 - rect.top - rect.height / 2,
          (before[0].x + before[1].x) / 2 - rect.left - rect.width / 2,
          (before[0].y + before[1].y) / 2 - rect.top - rect.height / 2);
      } else if (zoom > 1) { panX += event.clientX - old.x; panY += event.clientY - old.y; render(); }
    });
    const release = event => { pointers.delete(event.pointerId); if (!pointers.size) stage.classList.remove('is-dragging'); };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => listen(stage, type, release));
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(render) : null;
    resizeObserver?.observe(stage); listen(window, 'resize', render);
    document.body.append(dialog); activeViewer = { dialog, dispose };
    render();
    try {
      dialog.showModal(); close.focus({ preventScroll: true });
      if (isURL || source.matches('img')) {
        media = element('img'); media.alt = ''; media.draggable = false;
        listen(media, 'load', () => setReady(media.naturalWidth, media.naturalHeight));
        listen(media, 'error', () => fail('图片加载失败'));
        const url = isURL ? source : source.currentSrc || source.getAttribute('src');
        if (!url) throw new Error('图片尚未加载');
        media.src = url; frame.append(media);
        if (media.complete && media.naturalWidth) setReady(media.naturalWidth, media.naturalHeight);
      } else if (source.matches('canvas')) {
        media = element('canvas'); copyCanvas(source, media); frame.append(media); setReady(media.width, media.height);
      } else {
        const bounds = source.getBoundingClientRect();
        const viewBox = source.matches('svg') ? source.viewBox?.baseVal : null;
        const chartWidth = bounds.width || viewBox?.width;
        const chartHeight = bounds.height || viewBox?.height;
        if (!chartWidth || !chartHeight) throw new Error('图表尚未显示');
        media = cloneChart(source);
        // Fixed dimensions preserve chart layout; the outer frame alone performs zooming.
        ['position', 'inset', 'top', 'right', 'bottom', 'left', 'margin', 'transform', 'max-width', 'max-height', 'min-width', 'min-height', 'width', 'height', 'box-sizing'].forEach(property => media.style.removeProperty(property));
        media.style.setProperty('width', `${chartWidth}px`, 'important');
        media.style.setProperty('height', `${chartHeight}px`, 'important');
        media.style.setProperty('box-sizing', 'border-box', 'important');
        media.style.setProperty('margin', '0', 'important');
        media.style.setProperty('position', 'relative', 'important');
        media.style.setProperty('transform', 'none', 'important');
        frame.append(media); setReady(chartWidth, chartHeight);
      }
    } catch (error) { if (!dialog.open) dispose(); else fail(error.message || '无法预览此图片'); }
    return disposed ? null : dialog;
  }

  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.closest(EXCLUDED)) return;
    const parentDialog = root.closest('dialog');
    if (parentDialog) decorateDialog(parentDialog);
    root.querySelectorAll('dialog:not(.ui-media-viewer)').forEach(dialog => decorateDialog(dialog));
    if (root.matches(CANDIDATES) && !enhanced.has(root)) enhanceImage(root);
    root.querySelectorAll(CANDIDATES).forEach(source => { if (!enhanced.has(source)) enhanceImage(source); });
  }
  function start() {
    document.querySelectorAll('[data-ui-icon]').forEach(marker => marker.replaceChildren(icon(marker.dataset.uiIcon)));
    scan(document.body);
    syncModalScroll();
    document.addEventListener('close', syncModalScroll, true);
    const observer = new MutationObserver(records => {
      const roots = new Set();
      records.forEach(record => {
        if (record.type === 'childList') { roots.add(record.target); record.addedNodes.forEach(node => { if (node.nodeType === 1) roots.add(node); }); }
        else roots.add(record.target);
      });
      roots.forEach(scan);
      syncModalScroll();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['role', 'data-image-preview', 'aria-hidden', 'hidden', 'open'] });
  }
  Object.assign(API, { icon, decorateDialog, confirm, preview, enhanceImage });
  window.InnerLightUI = API;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
