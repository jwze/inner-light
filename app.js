/* Inner Light — DOM 3D, no GPU or network dependency. */
(() => {
  "use strict";
  const C = window.InnerLightCore;
  const FX = window.InnerLightEffects;
  const $ = (id) => document.getElementById(id);
  const stage = $("sphereStage");
  const layer = $("wordLayer");
  const input = $("wordInput");
  const dialog = $("libraryDialog");
  const API_BASE = "/api";
  const PLANET_SLUG = new URLSearchParams(location.search).get("planet") || "default";
  const STORAGE_KEY = "inner-light:preferences:v1";
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const palette = ["#8ef7ed", "#bce9ff", "#dfc6ff", "#fff1b7", "#a6ffe5", "#f2cadf"];
  const measure = document.createElement("canvas").getContext("2d");
  let storage;
  try { storage = window.localStorage; } catch { storage = null; }
  const previewEntries = C.randomSamples();
  let persistedEntries = previewEntries;
  let serverVersion = 0;
  let publicStats = { totalSubmissions: 0, todaySubmissions: 0, activeVisitors: 0 };
  let eventSource = null;
  let connectionState = "connecting";
  let entries = new Map();
  let nodes = [];
  let flights = [];
  let rings = [];
  const MAX_FLIGHTS = 8, MAX_IMPACTS = 5;
  let renderMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let chargeGlow = 0;
  let width = 1, height = 1, radius = 100, focal = 700;
  let rotationX = Math.random() * Math.PI * 2, rotationY = Math.random() * Math.PI * 2;
  // Manual gestures rotate in screen space, independent of random Euler orientation.
  let viewRotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const ROTATION_SPEED = .4;
  const direction = C.randomRotation();
  // Randomize the axis/sign once per visit, preserving one constant angular speed.
  const velocityX = direction.x, velocityY = direction.y;
  let spinBlend = 1;
  let reduced = motionQuery.matches;
  let pointer = null;
  let suppressClickUntil = 0;
  let inertiaX = 0, inertiaY = 0;
  let composing = false;
  let compositionEndedAt = -Infinity;
  let lastTime = null;
  let raf = 0;
  let pendingAction = null;
  let selectedWord = null;
  const particles = [];
  for (let index = 0; index < 160; index++) {
    const element = document.createElement("i");
    element.className = "sphere-particle";
    const point = C.spherePoint(index, 160, 1);
    $("particleLayer").append(element);
    particles.push({ element, point });
  }

  function announce(message, error = false) {
    $("feedback").textContent = message;
    if (dialog.open) $("libraryFeedback").textContent = message;
    $("feedback").classList.toggle("error", error);
    input.setAttribute("aria-invalid", String(error));
  }

  async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    let body = {};
    try { body = await response.json(); } catch (_) { /* empty response */ }
    if (!response.ok) throw new Error(body.message || "网络请求失败，请稍后再试。");
    return body;
  }

  function setConnection(state, message) {
    connectionState = state;
    const label = $("saveStatus");
    label.textContent = message || (state === "online" ? "公共星球 · 实时同步" : state === "offline" ? "离线预览 · 未连接" : "连接公共星球中…");
    label.classList.toggle("offline", state === "offline");
  }

  function updateRecent(items = []) {
    const list = $("recentList");
    if (!list) return;
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "recent-empty";
      empty.textContent = "等待新的光";
      list.append(empty);
      return;
    }
    items.slice(0, 5).forEach((item) => {
      const tag = document.createElement("span");
      tag.className = "recent-word";
      tag.textContent = item.word;
      list.append(tag);
    });
  }

  function updatePublicStats(next = {}) {
    publicStats = { ...publicStats, ...next };
    $("wordCount").textContent = entries.size;
    $("totalCount").textContent = publicStats.totalSubmissions || Array.from(entries.values()).reduce((sum, item) => sum + item.frequency, 0);
    const today = $("todayCount");
    if (today) today.textContent = publicStats.todaySubmissions || 0;
    $("emptyState").hidden = entries.size > 0;
  }

  function applyServerItem(item, animate = false) {
    let node = entries.get(item.word);
    if (!node) {
      if (entries.size >= C.MAX_WORDS) return;
      node = createNode(item, nodes.length);
      redistribute();
      if (animate) startFlight(node, true);
    } else {
      node.frequency = item.frequency;
      setLabelMetrics(node, nodes.indexOf(node));
      if (animate) startFlight(node, false);
    }
    updatePublicStats();
    wake();
  }

  function applyPlanetSnapshot(payload) {
    if (payload.unchanged) return;
    serverVersion = payload.version || serverVersion;
    persistedEntries = C.createEntries(payload.items || []);
    replaceEntries(persistedEntries);
    updatePublicStats(payload.stats || {});
    updateRecent(payload.recent || []);
  }

  async function loadPlanet() {
    try {
      const payload = await apiRequest(`/planets/${encodeURIComponent(PLANET_SLUG)}/words`);
      applyPlanetSnapshot(payload);
      setConnection("online");
      openRealtime();
    } catch (error) {
      setConnection("offline", "离线预览 · 提交不可用");
      announce(`${error.message} 当前显示示例星球。`, true);
      replaceEntries(previewEntries);
    }
  }

  function openRealtime() {
    if (!window.EventSource || eventSource) return;
    eventSource = new EventSource(`${API_BASE}/planets/${encodeURIComponent(PLANET_SLUG)}/events`);
    eventSource.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "word_added" && payload.item && (!payload.id || payload.id > serverVersion)) {
          serverVersion = Math.max(serverVersion, payload.id || 0);
          applyServerItem(payload.item, payload.id !== undefined);
          publicStats.totalSubmissions++;
          publicStats.todaySubmissions++;
          updatePublicStats();
          updateRecent([{ word: payload.item.word, createdAt: payload.createdAt }]);
        } else if (payload.type === "word_removed") {
          loadPlanet();
        }
      } catch (_) { /* ignore malformed realtime events */ }
    });
    eventSource.onerror = () => setConnection("offline", "实时连接中断 · 正在重连");
  }

  async function submitToServer(word, isNew, previousFrequency) {
    try {
      const payload = await apiRequest(`/planets/${encodeURIComponent(PLANET_SLUG)}/words`, { method: "POST", body: JSON.stringify({ word }) });
      serverVersion = payload.version || serverVersion;
      applyServerItem(payload.item);
      updatePublicStats(payload.stats || {});
      setConnection("online");
      announce(`「${word}」${isNew ? "已加入公共星球" : `· 第 ${payload.item.frequency} 次共鸣`}`);
    } catch (error) {
      const node = entries.get(word);
      if (node && isNew) {
        node.element.remove();
        entries.delete(word);
        nodes = nodes.filter((item) => item !== node);
        redistribute();
      } else if (node) {
        node.frequency = previousFrequency;
        setLabelMetrics(node, nodes.indexOf(node));
      }
      updatePublicStats();
      announce(error.message, true);
      if (error.message.includes("网络") || error.message.includes("服务器")) setConnection("offline", "离线预览 · 提交失败");
    }
  }

  function reconcile(items) {
    const current = Array.from(entries.values(), ({ word, frequency }) => ({ word, frequency }));
    if (JSON.stringify(current) !== JSON.stringify(items)) {
      replaceEntries(items);
      if (dialog.open) libraryList();
    }
  }

  function persist(operation) {
    if (operation?.type === "replace") {
      const clean = C.createEntries(operation.items);
      replaceEntries(clean);
      try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(clean)); } catch (_) { /* optional preference only */ }
      return true;
    }
    return true;
  }


  function stats() {
    updatePublicStats();
  }

  function setLabelMetrics(node, index) {
    const size = C.fontSize(node.frequency, width < 550) + (width < 550 ? 1 : 3);
    const maxWidth = Math.max(58, Math.min(width * .32, 180));
    node.element.style.fontSize = `${size}px`;
    node.element.style.color = palette[index % palette.length];
    node.label.style.maxWidth = `${maxWidth}px`;
    node.element.setAttribute("aria-label", `${node.word}，${node.frequency} 次共鸣。点击再送一次`);
    node.element.title = `${node.word} · ${node.frequency} 次共鸣`;
    if (measure) measure.font = `400 ${size}px ${getComputedStyle(stage).fontFamily}`;
    node.w = Math.min(maxWidth, measure ? measure.measureText(node.word).width + C.graphemes(node.word).length * size * .06 : maxWidth) + 12;
    node.h = size * 1.3 + 8;
  }

  function createNode(item, index) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "word-tag";
    element.dataset.word = item.word;
    // The sphere is one keyboard stop; all entries remain accessible in the library.
    element.tabIndex = -1;
    const label = document.createElement("span");
    label.className = "word-label";
    label.textContent = item.word;
    element.append(label);
    layer.append(element);
    const node = { ...item, element, label, point: C.spherePoint(index, Math.max(entries.size, 1), 1), target: null, layoutOrder: Math.random(), pulse: 0, pending: 0, opacity: 0, x: width / 2, y: height / 2, scale: 1 };
    entries.set(item.word, node);
    nodes.push(node);
    setLabelMetrics(node, index);
    return node;
  }

  function redistribute(immediate = false) {
    nodes.slice().sort((a, b) => a.layoutOrder - b.layoutOrder).forEach((node, index) => {
      node.target = C.spherePoint(index, nodes.length, 1);
      if (immediate || reduced) node.point = { ...node.target };
    });
    wake();
  }

  function cancelEffects() {
    flights.forEach((flight) => { flight.element.remove(); flight.path.remove(); });
    rings.forEach(removeImpact);
    chargeGlow = 0;
    $("wordForm").style.setProperty("--charge", "0");
    stage.style.setProperty("--impact", "0");
    flights = [];
    rings = [];
    nodes.forEach((node) => { node.pending = 0; node.element.classList.remove("arriving"); });
  }

  function replaceEntries(items) {
    cancelEffects();
    layer.replaceChildren();
    entries = new Map();
    nodes = [];
    const clean = C.createEntries(items);
    // Pre-size the collection so initialization uses its final distribution.
    clean.forEach((item) => entries.set(item.word, item));
    clean.forEach(createNode);
    redistribute(true);
    stats();
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    // Account for the projected sphere envelope AND the label extents.
    radius = Math.max(38, Math.min((width / 2 - 30) / 1.06, (height / 2 - 40) / 1.06));
    focal = radius * 3.2;
    nodes.forEach(setLabelMetrics);
    stage.style.setProperty("--sphere-diameter", `${radius * 2.1}px`);
    $("flightSvg").setAttribute("viewBox", `0 0 ${width} ${height}`);
    wake();
  }

  function updateInputCount() {
    const count = C.graphemes(C.normalizeWord(input.value)).length;
    $("charCount").textContent = `${count} / ${C.MAX_LENGTH}`;
    $("charCount").classList.toggle("invalid", count > C.MAX_LENGTH);
    if (input.getAttribute("aria-invalid") === "true") announce("");
  }

  function svgElement(name, className, parent) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    element.setAttribute("class", className);
    parent.append(element);
    return element;
  }

  function removeImpact(impact) {
    impact.element.remove();
    impact.surface.remove();
  }

  function startFlight(node, isNew) {
    if (reduced) return;
    if (flights.length >= MAX_FLIGHTS) land(flights.shift(), false);
    const element = document.createElement("div");
    element.className = "flight-word";
    const label = document.createElement("span");
    label.className = "comet-label";
    label.textContent = node.word;
    element.append(label);
    $("effectLayer").append(element);
    // One SVG group owns both the wide halo and narrow plasma core, plus dust.
    const path = svgElement("g", "flight-trail", $("flightSvg"));
    const halo = svgElement("path", "comet-trail-halo", path);
    const core = svgElement("path", "comet-trail-core", path);
    const lock = svgElement("circle", "comet-lock", path);
    const dust = Array.from({ length: 12 }, (_, index) => {
      const spark = svgElement("circle", "comet-dust", path);
      spark.setAttribute("r", String(index % 3 === 0 ? 2 : 1));
      return spark;
    });
    if (isNew) { node.pending++; node.element.classList.add("arriving"); }
    chargeGlow = 1;
    flights.push({ node, element, path, halo, core, lock, dust, elapsed: 0, duration: 1.22, isNew, bend: (Math.random() < .5 ? -1 : 1), seed: Math.random() * Math.PI * 2 });
  }

  function land(flight, withImpact = true) {
    const { node } = flight;
    flight.element.remove();
    flight.path.remove();
    if (flight.isNew) node.pending = Math.max(0, node.pending - 1);
    if (!node.pending) node.element.classList.remove("arriving");
    if (entries.get(node.word) !== node || reduced || !withImpact) return;
    node.pulse = 1;
    if (rings.length >= MAX_IMPACTS) removeImpact(rings.shift());
    const normal = FX.unit(node.point);
    const element = document.createElement("div");
    element.className = "arrival-ring";
    const flash = document.createElement("i");
    flash.className = "impact-flare";
    element.append(flash);
    const sparks = Array.from({ length: 16 }, (_, index) => {
      const spark = document.createElement("i");
      spark.className = "impact-spark";
      element.append(spark);
      return { element: spark, angle: index * Math.PI * 2 / 16 + Math.random() * .15, distance: 28 + Math.random() * 58 };
    });
    $("effectLayer").append(element);
    const surface = svgElement("g", "surface-wave", $("flightSvg"));
    const paths = Array.from({ length: 2 }, () => ({ front: svgElement("path", "wave-front", surface), back: svgElement("path", "wave-back", surface) }));
    rings.push({ element, surface, paths, sparks, normal, basis: FX.tangentBasis(normal), elapsed: 0, duration: 1.45 });
  }

  function sendWord(raw) {
    const result = C.validateWord(raw);
    if (!result.ok) { announce(result.error, true); return false; }
    const word = result.word;
    let node = entries.get(word);
    const isNew = !node;
    if (isNew && entries.size >= C.MAX_WORDS) {
      announce(`星球已收藏 ${C.MAX_WORDS} 个念头。可以重复点亮，或在收藏中腾出位置。`, true);
      return false;
    }
    if (node && node.frequency >= C.MAX_FREQUENCY) {
      announce(`「${word}」已达到 ${C.MAX_FREQUENCY} 次共鸣。试着送入另一个念头吧。`, true);
      return false;
    }
    const previousFrequency = node ? node.frequency : 0;
    if (isNew) {
      node = createNode({ word, frequency: 1 }, nodes.length);
      redistribute();
      const facing = nodes.reduce((best, item) => {
        const point = item.target;
        const depth = renderMatrix[6] * point.x + renderMatrix[7] * point.y + renderMatrix[8] * point.z;
        return depth > best.depth ? { node: item, depth } : best;
      }, { node, depth: -Infinity }).node;
      const previousTarget = node.target;
      node.target = facing.target;
      facing.target = previousTarget;
      const previousOrder = node.layoutOrder;
      node.layoutOrder = facing.layoutOrder;
      facing.layoutOrder = previousOrder;
      node.point = { ...node.target };
    } else {
      node.frequency++;
      setLabelMetrics(node, nodes.indexOf(node));
    }
    startFlight(node, isNew);
    stats();
    announce(`「${word}」正在送入公共星球…`);
    submitToServer(word, isNew, previousFrequency);
    wake();
    return true;
  }

  function projectEffect(point, lift = 1) {
    const m = renderMatrix;
    const x = (m[0] * point.x + m[1] * point.y + m[2] * point.z) * lift;
    const y = (m[3] * point.x + m[4] * point.y + m[5] * point.z) * lift;
    const z = (m[6] * point.x + m[7] * point.y + m[8] * point.z) * lift;
    const scale = focal / Math.max(focal * .2, focal - z * radius);
    return { x: width / 2 + x * radius * scale, y: height / 2 + y * radius * scale, z };
  }

  function updateFlights(dt) {
    if (!flights.length) return;
    // Re-read on each animation frame so scrolling/resizing never detaches the muzzle.
    const source = input.getBoundingClientRect(), bounds = stage.getBoundingClientRect();
    const sx = source.left + Math.min(source.width * .5, 120) - bounds.left;
    const sy = source.top + source.height / 2 - bounds.top;
    flights = flights.filter((flight) => {
      flight.elapsed += dt;
      const t = C.clamp(flight.elapsed / flight.duration, 0, 1);
      const p = FX.cometProgress(flight.elapsed, flight.duration);
      const ex = flight.node.x, ey = flight.node.y;
      flight.lock.setAttribute("cx", String(ex));
      flight.lock.setAttribute("cy", String(ey));
      flight.lock.setAttribute("r", String(10 + (1 - p) * 24));
      flight.lock.style.opacity = String(Math.sin(t * Math.PI) * .65);
      const cx = C.clamp((sx + ex) / 2 + flight.bend * Math.min(145, width * .25), 24, width - 24);
      const cy = Math.min(sy, ey) - Math.min(90, height * .16);
      const at = (q) => ({ x: (1 - q) ** 2 * sx + 2 * (1 - q) * q * cx + q * q * ex, y: (1 - q) ** 2 * sy + 2 * (1 - q) * q * cy + q * q * ey });
      const head = at(p);
      const charge = C.clamp(flight.elapsed / .18, 0, 1);
      const scale = p === 0 ? .55 + charge * .6 : 1.15 - p * .55;
      flight.element.style.transform = `translate3d(${head.x}px,${head.y}px,0) translate(-50%,-50%) scale(${scale})`;
      flight.element.style.opacity = String(t > .92 ? (1 - t) / .08 : .5 + charge * .5);
      flight.element.style.setProperty("--comet-energy", String(Math.sin(Math.PI * t)));
      let path = "";
      for (let i = 0; i <= 18; i++) {
        const point = at(Math.max(0, p - .3) + Math.min(p, .3) * i / 18);
        path += `${i ? " L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      }
      flight.halo.setAttribute("d", path);
      flight.core.setAttribute("d", path);
      flight.path.style.opacity = String(Math.min(1, p * 12) * (1 - t * .3));
      flight.dust.forEach((spark, index) => {
        const q = Math.max(0, p - (index + 1) * .018);
        const point = at(q);
        const spread = (index + 1) * .8;
        spark.setAttribute("cx", String(C.clamp(point.x + Math.sin(flight.seed + t * 18 + index) * spread, 3, width - 3)));
        spark.setAttribute("cy", String(point.y + Math.cos(flight.seed + t * 16 + index) * spread));
        spark.style.opacity = String(Math.max(0, 1 - index / 12) * Math.min(1, p * 10));
      });
      if (t >= 1) { land(flight); return false; }
      return true;
    });
  }

  function surfaceEnergy(point) {
    let energy = 0;
    for (const impact of rings) energy += FX.waveInfluence(point, impact.normal, impact.elapsed / impact.duration);
    return Math.min(1.3, energy);
  }

  function updateImpacts(dt) {
    let glow = 0;
    rings = rings.filter((impact) => {
      impact.elapsed += dt;
      const t = C.clamp(impact.elapsed / impact.duration, 0, 1);
      if (t >= 1) { removeImpact(impact); return false; }
      glow += Math.sin(t * Math.PI) * .65;
      const origin = projectEffect(impact.normal, 1.015);
      impact.element.style.transform = `translate3d(${origin.x}px,${origin.y}px,0)`;
      impact.element.style.opacity = String((1 - t) ** 1.8 * (origin.z < 0 ? .4 : 1));
      impact.element.style.setProperty("--burst-scale", String(.4 + t * 3.2));
      impact.sparks.forEach((spark) => {
        const distance = spark.distance * Math.sin(Math.min(1, t * 1.4) * Math.PI / 2);
        const x = C.clamp(origin.x + Math.cos(spark.angle) * distance, 3, width - 3) - origin.x;
        const y = C.clamp(origin.y + Math.sin(spark.angle) * distance, 3, height - 3) - origin.y;
        spark.element.style.transform = `translate(${x}px,${y}px) rotate(${spark.angle}rad) scaleX(${1 + (1 - t) * 2})`;
      });
      impact.paths.forEach((paths, index) => {
        const progress = Math.max(0, t - index * .11);
        let front = "", back = "", previousFront = null;
        for (let i = 0; i <= 64; i++) {
          const point = projectEffect(FX.ringPoint(impact.basis, progress * 2.6, i / 64 * Math.PI * 2), 1.012);
          const near = point.z > 0;
          const command = i && previousFront === near ? " L" : " M";
          if (near) front += `${command}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
          else back += `${command}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
          previousFront = near;
        }
        paths.front.setAttribute("d", front);
        paths.back.setAttribute("d", back);
        const opacity = Math.sin(Math.PI * progress) * (1 - t) * (index ? .55 : 1);
        paths.front.style.opacity = String(opacity);
        paths.back.style.opacity = String(opacity * .22);
      });
      return true;
    });
    chargeGlow = Math.max(0, chargeGlow - dt * 3.5);
    $("wordForm").style.setProperty("--charge", String(chargeGlow));
    stage.style.setProperty("--impact", String(Math.min(1, glow)));
  }

  function rotateView(angleX, angleY) {
    const cx = Math.cos(angleX), sx = Math.sin(angleX);
    const cy = Math.cos(angleY), sy = Math.sin(angleY);
    const next = new Array(9);
    // Pre-multiply: drag axes belong to the screen, never the sphere's local axes.
    for (let column = 0; column < 3; column++) {
      const x = viewRotation[column], y = viewRotation[3 + column], z = viewRotation[6 + column];
      const rotatedX = x * cy + z * sy;
      const rotatedZ = -x * sy + z * cy;
      next[column] = rotatedX;
      next[3 + column] = y * cx - rotatedZ * sx;
      next[6 + column] = y * sx + rotatedZ * cx;
    }
    viewRotation = next;
  }

  function render(dt) {
    const sinY = Math.sin(rotationY), cosY = Math.cos(rotationY);
    const sinX = Math.sin(rotationX), cosX = Math.cos(rotationX);
    // Compose the random/automatic orientation with the user's screen-space rotation.
    const base = [cosY, 0, sinY, sinX * sinY, cosX, -sinX * cosY, -cosX * sinY, sinX, cosX * cosY];
    const matrix = new Array(9);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        matrix[row * 3 + column] = viewRotation[row * 3] * base[column] + viewRotation[row * 3 + 1] * base[3 + column] + viewRotation[row * 3 + 2] * base[6 + column];
      }
    }
    renderMatrix = matrix;
    let settling = false;
    for (const node of nodes) {
      const p = node.point, target = node.target;
      const distance = Math.abs(p.x - target.x) + Math.abs(p.y - target.y) + Math.abs(p.z - target.z);
      if (distance > .0001) {
        settling = true;
        p.x = C.damp(p.x, target.x, 7, dt);
        p.y = C.damp(p.y, target.y, 7, dt);
        p.z = C.damp(p.z, target.z, 7, dt);
      }
      // Rotate using shared per-frame trigonometry, no per-label Vector allocation.
      const x1 = matrix[0] * p.x + matrix[1] * p.y + matrix[2] * p.z;
      const y = matrix[3] * p.x + matrix[4] * p.y + matrix[5] * p.z;
      const z = matrix[6] * p.x + matrix[7] * p.y + matrix[8] * p.z;
      const energy = surfaceEnergy(p);
      node.energy = energy;
      const lift = 1 + energy * .09;
      const perspective = focal / (focal - z * radius);
      node.scale = C.sphereDepth(z).scale;
      // Keep even the longest label inside the stage, including its pulse.
      const halfW = node.w * node.scale * .56;
      const halfH = node.h * node.scale * .56;
      node.x = C.clamp(width / 2 + x1 * radius * perspective * lift, halfW + 4, width - halfW - 4);
      node.y = C.clamp(height / 2 + y * radius * perspective * lift, halfH + 4, height - halfH - 4);
      node.depth = z;
      node.pulse = Math.max(0, node.pulse - dt * 1.3);
      if (node.pulse > 0) settling = true;
    }
    // Preserve both hemispheres. Overlap is depth-correct, not a reason to hide tags.
    for (const node of nodes) {
      const depth = C.sphereDepth(node.depth);
      const opacity = Math.max(depth.opacity, node.pulse * .9, node.energy * .85);
      node.opacity = reduced ? opacity : C.damp(node.opacity, opacity, 16, dt);
      if (Math.abs(node.opacity - opacity) > .005) settling = true;
      else node.opacity = opacity;
      node.element.style.opacity = String(node.opacity);
      node.element.style.pointerEvents = node.depth > -.3 && !node.pending ? "auto" : "none";
      node.element.style.transform = `translate3d(${node.x.toFixed(2)}px,${node.y.toFixed(2)}px,0) translate(-50%,-50%) scale(${(node.scale * (1 + Math.sin(node.pulse * Math.PI) * .1)).toFixed(4)})`;
      node.element.style.zIndex = String(Math.round((node.depth + 1) * 100));
      const light = Math.max(node.pulse, node.energy);
      node.label.style.textShadow = light > .01 ? `0 0 ${8 + light * 18}px #8ef7ed` : `0 0 ${(depth.glow * 8).toFixed(1)}px #8ef7ed55`;
      node.label.style.color = light > .1 ? `rgb(${Math.round(160 + light * 65)} 255 242)` : "";
    }
    // These small points share exactly the same 3D transform as the labels.
    for (const { element, point: p } of particles) {
      const x1 = matrix[0] * p.x + matrix[1] * p.y + matrix[2] * p.z;
      const y = matrix[3] * p.x + matrix[4] * p.y + matrix[5] * p.z;
      const z = matrix[6] * p.x + matrix[7] * p.y + matrix[8] * p.z;
      const energy = surfaceEnergy(p);
      const lift = 1 + energy * .075;
      const projection = focal / (focal - z * radius);
      const depth = C.sphereDepth(z);
      element.style.transform = `translate3d(${(width / 2 + x1 * radius * projection * lift).toFixed(2)}px,${(height / 2 + y * radius * projection * lift).toFixed(2)}px,0) scale(${depth.scale.toFixed(3)})`;
      element.style.opacity = String(nodes.length ? Math.min(1, depth.opacity * .7 + energy * .8) : 0);
    }
    return settling;
  }

  function frame(time) {
    raf = 0;
    if (document.hidden) { lastTime = null; return; }
    const dt = lastTime === null ? 1 / 60 : C.clamp((time - lastTime) / 1000, 0, .05);
    lastTime = time;
    const running = !reduced && !dialog.open && !pointer && nodes.length > 0;
    const targetBlend = running ? 1 : 0;
    spinBlend = reduced ? 0 : C.damp(spinBlend, targetBlend, 6, dt);
    if (Math.abs(spinBlend - targetBlend) < .0005) spinBlend = targetBlend;
    if (!pointer && !dialog.open) {
      const rotation = C.rotationStep(rotationX, rotationY, velocityX * spinBlend, velocityY * spinBlend, ROTATION_SPEED, dt);
      rotationX = C.normalizeAngle(rotation.x);
      rotationY = C.normalizeAngle(rotation.y);
      if (inertiaX || inertiaY) rotateView(inertiaX * dt, inertiaY * dt);
    }
    inertiaX = C.damp(inertiaX, 0, 6, dt);
    inertiaY = C.damp(inertiaY, 0, 6, dt);
    if (Math.abs(inertiaX) < .001) inertiaX = 0;
    if (Math.abs(inertiaY) < .001) inertiaY = 0;
    const moving = spinBlend > 0 || inertiaX !== 0 || inertiaY !== 0;
    const settling = render(dt);
    updateFlights(dt);
    updateImpacts(dt);
    if (moving || settling || flights.length || rings.length || chargeGlow > 0 || running) wake();
    else lastTime = null;
  }

  function wake() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }

  function updateMotionHint() {
    $("interactionHint").textContent = reduced ? "已减少动态效果 · 拖动或方向键探索" : "滑动星球 · 遇见同频的念头";
  }

  function libraryList() {
    const search = C.normalizeWord($("librarySearch").value).toLocaleLowerCase();
    const filtered = nodes.filter((node) => node.word.toLocaleLowerCase().includes(search)).sort((a, b) => b.frequency - a.frequency);
    const fragment = document.createDocumentFragment();
    for (const node of filtered) {
      const row = document.createElement("div");
      row.className = "library-row";
      const word = document.createElement("span");
      word.className = "library-word";
      word.textContent = node.word;
      const count = document.createElement("span");
      count.className = "library-frequency";
      count.textContent = `${node.frequency} 次`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "delete-word";
      remove.textContent = "仅管理员可移除";
      remove.disabled = true;
      remove.title = "公共词语由管理员审核和移除";
      remove.setAttribute("aria-label", `${node.word} 仅管理员可移除`);
      remove.addEventListener("click", () => {
        selectedWord = node.word;
        askConfirm("delete", `将「${node.word}」移出星球？它的共鸣次数也会被移除。`);
      });
      const reuse = document.createElement("button");
      reuse.type = "button";
      reuse.className = "reuse-word";
      reuse.textContent = "填入";
      reuse.setAttribute("aria-label", `填入 ${node.word}，准备再次发送`);
      reuse.addEventListener("click", () => {
        dialog.close("reuse");
        input.value = node.word;
        updateInputCount();
      });
      row.append(word, count, reuse, remove);
      fragment.append(row);
    }
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "library-empty";
      empty.textContent = entries.size ? "没有找到这个念头。" : "星球还是空的，送入第一个念头吧。";
      fragment.append(empty);
    }
    $("libraryList").replaceChildren(fragment);
    $("librarySummary").textContent = `共 ${entries.size} / ${C.MAX_WORDS} 个念头${search ? ` · 找到 ${filtered.length} 个` : ""}`;
    $("clearBtn").disabled = entries.size === 0;
  }

  function askConfirm(action, text) {
    pendingAction = action;
    $("confirmText").textContent = text;
    $("confirmPanel").hidden = false;
    $("confirmAction").focus();
    $("confirmPanel").scrollIntoView({ block: "nearest" });
  }

  function closeConfirm() {
    pendingAction = null;
    selectedWord = null;
    $("confirmPanel").hidden = true;
  }

  $("wordForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (composing || performance.now() - compositionEndedAt < 60) return;
    if (sendWord(input.value)) { input.value = ""; updateInputCount(); input.focus({ preventScroll: true }); }
  });
  input.addEventListener("input", updateInputCount);
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; compositionEndedAt = performance.now(); updateInputCount(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.isComposing || composing || event.keyCode === 229)) event.preventDefault();
  });
  $("enrichBtn").addEventListener("click", () => {
    loadPlanet().then(() => announce("公共星球已刷新。"));
  });
  layer.addEventListener("click", (event) => {
    if (performance.now() < suppressClickUntil) return;
    const button = event.target.closest(".word-tag");
    if (button) sendWord(button.dataset.word);
  });

  stage.addEventListener("pointermove", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    if (!pointer.dragged && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 5) {
      pointer.dragged = true;
      // A cancelled/released pointer can race the final move (or be synthetic).
      try { stage.setPointerCapture(event.pointerId); } catch { /* global pointerup still releases drag */ }
      stage.classList.add("dragging");
    }
    if (pointer.dragged) {
      const step = .006;
      rotateView(-dy * step, dx * step);
      const dt = Math.max(.008, (event.timeStamp - pointer.time) / 1000);
      inertiaY = reduced ? 0 : C.clamp(dx * step / dt, -1.5, 1.5);
      inertiaX = reduced ? 0 : C.clamp(-dy * step / dt, -1.5, 1.5);
      wake();
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.time = event.timeStamp;
  });
  stage.addEventListener("pointerdown", (event) => {
    if (pointer || event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: event.timeStamp, dragged: false };
    inertiaX = 0; inertiaY = 0;
    wake();
  });
  function releasePointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (pointer.dragged) suppressClickUntil = performance.now() + 300;
    const id = pointer.id;
    pointer = null;
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    stage.classList.remove("dragging");
    wake();
  }
  window.addEventListener("pointerup", releasePointer);
  window.addEventListener("pointercancel", (event) => { inertiaX = 0; inertiaY = 0; releasePointer(event); });
  stage.addEventListener("lostpointercapture", releasePointer);
  stage.addEventListener("keydown", (event) => {
    if (event.target !== stage) return;
    const steps = { ArrowLeft: [0, -.18], ArrowRight: [0, .18], ArrowUp: [.18, 0], ArrowDown: [-.18, 0] };
    if (steps[event.key]) {
      event.preventDefault();
      rotateView(steps[event.key][0], steps[event.key][1]);
      wake();
    }
  });

  $("libraryBtn").addEventListener("click", () => {
    closeConfirm();
    $("librarySearch").value = "";
    $("libraryFeedback").textContent = "";
    libraryList();
    dialog.returnValue = "";
    dialog.showModal();
    inertiaX = 0; inertiaY = 0;
    wake();
  });
  $("closeLibrary").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { closeConfirm(); (dialog.returnValue === "reuse" ? input : $("libraryBtn")).focus({ preventScroll: true }); wake(); });
  dialog.addEventListener("cancel", (event) => {
    if (pendingAction) { event.preventDefault(); closeConfirm(); $("librarySearch").focus(); }
  });
  $("librarySearch").addEventListener("input", libraryList);
  $("clearBtn").addEventListener("click", () => askConfirm("clear", "隐藏当前公共词球内容并重新加载？公共数据不会被删除。"));
  $("resetBtn").addEventListener("click", () => loadPlanet().then(() => announce("已重新加载公共星球。")));
  $("cancelAction").addEventListener("click", () => { closeConfirm(); $("librarySearch").focus(); });
  $("confirmAction").addEventListener("click", () => {
    if (!pendingAction) return;
    closeConfirm();
    loadPlanet().then(() => announce("已重新加载公共星球。"));
    libraryList();
    $("librarySearch").focus();
  });

  motionQuery.addEventListener("change", () => {
    reduced = motionQuery.matches;
    inertiaX = 0; inertiaY = 0;
    if (reduced) {
      cancelEffects();
      nodes.forEach((node) => { node.point = { ...node.target }; node.pulse = 0; });
    }
    updateMotionHint();
    wake();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; lastTime = null; }
    else { wake(); }
  });
  window.addEventListener("blur", () => {
    if (pointer) releasePointer({ pointerId: pointer.id });
    inertiaX = 0; inertiaY = 0;
  });
  window.addEventListener("online", () => { setConnection("online"); loadPlanet(); });
  window.addEventListener("offline", () => setConnection("offline", "网络已断开 · 请稍后重试"));
  $("shareBtn")?.addEventListener("click", async () => {
    const shareData = { title: "心光 · INNER LIGHT", text: "来看看这颗公共同频星球", url: location.href };
    try {
      if (navigator.share) await navigator.share(shareData);
      else { await navigator.clipboard.writeText(location.href); const toast = $("shareToast"); toast.hidden = false; setTimeout(() => { toast.hidden = true; }, 2200); }
    } catch (_) { /* sharing can be cancelled */ }
  });

  replaceEntries(previewEntries);
  resize();
  new ResizeObserver(resize).observe(stage);
  updateMotionHint();
  setConnection("connecting");
  loadPlanet();
  wake();
})();
