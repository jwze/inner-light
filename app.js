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
  const STORAGE_KEY = `inner-light:cache:${PLANET_SLUG}`;
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
  let planetName = "同频宇宙";
  let entries = new Map();
  let nodes = [];
  let flights = [];
  let rings = [];
  const MAX_FLIGHTS = 8, MAX_IMPACTS = 5;
  let renderMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let pendingSubmission = null;
  let layoutInitialized = false;
  let arrivalEchoes = [];
  function screenToSphere(point) {
    // The inverse of an orthogonal rotation is its transpose.
    const m = renderMatrix;
    return { x: m[0] * point.x + m[3] * point.y + m[6] * point.z,
      y: m[1] * point.x + m[4] * point.y + m[7] * point.z,
      z: m[2] * point.x + m[5] * point.y + m[8] * point.z };
  }
  function showArrivalEcho(submission, point = screenToSphere(submission.screenPoint)) {
    if (submission.echoShown) return;
    submission.echoShown = true;
    if (arrivalEchoes.length >= MAX_FLIGHTS) arrivalEchoes.shift().element.remove();
    const element = document.createElement('div');
    element.className = 'flight-word arrival-echo';
    element.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'comet-label';
    label.textContent = submission.word;
    element.append(label);
    $('effectLayer').append(element);
    arrivalEchoes.push({ element, point: { ...point }, elapsed: 0, duration: 2 });
    wake();
  }
  function bindSubmittedNode(submission, node) {
    for (const flight of flights) if (flight.submission === submission) flight.node = node;
    if (submission.landed && submission.landedNode !== node) {
      node.pulse = 1;
      if (!reduced) createImpact(node.point);
      submission.landedNode = node;
    }
  }
  function confirmSubmission(submission) {
    const node = entries.get(submission.word);
    if (!node) return;
    submission.approved = true;
    node.pulse = 1;
    if (submission.isNew) bindSubmittedNode(submission, node);
    // Existing words keep their sphere coordinates; a private arrival label provides front feedback.
    if (!submission.isNew && submission.landed) showArrivalEcho(submission);
    wake();
  }
  function updateArrivalEchoes(dt) {
    arrivalEchoes = arrivalEchoes.filter(echo => {
      echo.elapsed += dt;
      const t = echo.elapsed / echo.duration;
      if (t >= 1) { echo.element.remove(); return false; }
      const at = projectEffect(echo.point, 1.025);
      echo.element.style.transform = `translate3d(${at.x}px,${at.y}px,0) translate(-50%,-50%)`;
      echo.element.style.opacity = String(Math.min(1, (1 - t) * 3) * C.clamp((at.z + .1) / .5, 0, 1));
      return true;
    });
  }
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
    const response = await fetch(`${API_BASE}${path}`, { ...options, signal: AbortSignal.timeout(10000), headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    let body = {};
    try { body = await response.json(); } catch (_) { /* empty response */ }
    if (!response.ok) throw new Error(body.message || "网络请求失败，请稍后再试。");
    return body;
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
    $("totalCount").textContent = publicStats.totalSubmissions ?? 0;
    $("activeCount").textContent = publicStats.activeVisitors ?? 0;
    const today = $("todayCount");
    if (today) today.textContent = publicStats.todaySubmissions || 0;
    $("emptyState").hidden = entries.size > 0;
  }

  function applyServerItem(item, animate = false) {
    let node = entries.get(item.word);
    if (!node) {
      if (entries.size >= C.MAX_WORDS) return;
      const ownWord = pendingSubmission?.word === item.word && pendingSubmission.isNew;
      const point = ownWord ? screenToSphere(pendingSubmission.screenPoint) : vacantSpherePoint();
      node = createNode(item, nodes.length, point);
      if (ownWord) bindSubmittedNode(pendingSubmission, node);
      if (animate) startFlight(node, true);
    } else {
      node.frequency = item.frequency;
      setLabelMetrics(node, nodes.indexOf(node));
      if (animate) startFlight(node, false);
    }
    updatePublicStats();
    wake();
  }

  function applyPlanetSnapshot(payload, animateWord = null, force = false) {
    if (!force && payload.version < serverVersion) return;
    serverVersion = payload.version ?? 0;
    persistedEntries = C.createEntries(payload.items || []);
    const names = new Set(persistedEntries.map((item) => item.word));
    const removed = nodes.filter((node) => !names.has(node.word));
    if (removed.length) {
      cancelEffects(true);
      for (const node of removed) { node.element.remove(); entries.delete(node.word); }
      nodes = nodes.filter((node) => names.has(node.word));
    }
    if (!layoutInitialized && !pendingSubmission) replaceEntries(persistedEntries);
    else for (const item of persistedEntries) applyServerItem(item, item.word === animateWord);
    layoutInitialized = true;
    updatePublicStats(payload.stats || {});
    updateRecent(payload.recent || []);
    if (payload.planet) {
      document.documentElement.dataset.theme = payload.planet.theme || "nebula";
      planetName = payload.planet.name;
      document.title = `${payload.planet.name} · 心光`;
    }
    if (dialog.open) libraryList();
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (_) { /* optional cache */ }
  }

  let hasSnapshot = false;
  let submitting = false;
  function updateSubmitAvailability() {
    $("sendBtn").disabled = submitting;
  }

  async function loadPlanet() {
    try {
      const payload = await apiRequest(`/planets/${encodeURIComponent(PLANET_SLUG)}/words`);
      applyPlanetSnapshot(payload, null, !hasSnapshot);
      hasSnapshot = true;
      openRealtime();
      return true;
    } catch (error) {
      if (!hasSnapshot) {
        let cached;
        try { cached = JSON.parse(storage?.getItem(STORAGE_KEY) || "null"); } catch (_) { /* ignore invalid cache */ }
        if (cached?.items && cached?.planet?.slug === PLANET_SLUG) applyPlanetSnapshot(cached, null, true);
        else { updatePublicStats({ totalSubmissions: 0, todaySubmissions: 0, activeVisitors: 0, uniqueVisitors: 0 }); updateRecent([]); }
      }
      announce(`${error.message} 当前可离线保存到发送箱，联网后自动提交。`, true);
      return false;
    }
  }

  function openRealtime() {
    if (!window.EventSource || eventSource) return;
    eventSource = new EventSource(`${API_BASE}/planets/${encodeURIComponent(PLANET_SLUG)}/events`);
    eventSource.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        const isNew = payload.version > serverVersion;
        if (payload.items) {
          applyPlanetSnapshot(payload, isNew && payload.type === "word_added" && !submitting ? payload.item.word : null);
          hasSnapshot = true;
        }
      } catch (_) { announce("实时数据异常，将通过定时刷新校准。", true); }
    });
  }

  async function submitToServer(submission) {
    const { word, isNew } = submission;
    submitting = true;
    updateSubmitAvailability();
    try {
      const payload = await window.InnerLightOffline.submit(PLANET_SLUG, word);
      if (payload.queued) {
        announce(`「${word}」已安全保存到发送箱；待发送或被拒绝的内容可在发送箱中查看。`);
      } else {
        applyPlanetSnapshot(payload);
        if (payload.status === 'approved') confirmSubmission(submission);
        announce(payload.status === "pending" ? `「${word}」已送达，等待审核。` : payload.status === "rejected" ? `「${word}」未通过审核：${payload.reason || "内容不适合公开"}` : `「${word}」${isNew ? "已加入公共星球" : `· 第 ${payload.item.frequency} 次共鸣`}`);
      }
    } catch (error) {
      if (!input.value) { input.value = word; updateInputCount(); }
      announce(`${error.message} 未能保存到发送箱，请勿关闭页面。`, true);
    } finally { pendingSubmission = null; submitting = false; updateSubmitAvailability(); }
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

  function createNode(item, index, point = C.spherePoint(index, Math.max(entries.size, 1), 1)) {
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
    const node = { ...item, element, label, point: { ...point }, target: { ...point }, layoutOrder: Math.random(), pulse: 0, pending: 0, opacity: 0, x: width / 2, y: height / 2, scale: 1 };
    entries.set(item.word, node);
    nodes.push(node);
    setLabelMetrics(node, index);
    return node;
  }

  function vacantSpherePoint() {
    // Fill gaps incrementally instead of redistributing every existing label on each snapshot.
    let best = null, bestGap = -1;
    for (let index = 0; index < 64; index++) {
      const z = Math.random() * 2 - 1, angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const point = { x: Math.cos(angle) * r, y: Math.sin(angle) * r, z };
      let gap = 4;
      for (const node of nodes) {
        const p = node.target;
        gap = Math.min(gap, (point.x - p.x) ** 2 + (point.y - p.y) ** 2 + (point.z - p.z) ** 2);
      }
      if (gap > bestGap) { best = point; bestGap = gap; }
    }
    return best;
  }

  function distributeInitialWords() {
    nodes.slice().sort((a, b) => a.layoutOrder - b.layoutOrder).forEach((node, index) => {
      node.target = C.spherePoint(index, nodes.length, 1);
      node.point = { ...node.target };
    });
    wake();
  }

  function cancelEffects(preserveLocal = false) {
    for (const flight of flights) {
      if (!preserveLocal || !flight.local) { flight.element.remove(); flight.path.remove(); }
    }
    flights = preserveLocal ? flights.filter((flight) => flight.local) : [];
    if (!preserveLocal) { rings.forEach(removeImpact); rings = []; }
    chargeGlow = flights.length ? chargeGlow : 0;
    $("wordForm").style.setProperty("--charge", String(chargeGlow));
    if (!preserveLocal) stage.style.setProperty("--impact", "0");
    nodes.forEach((node) => { node.pending = 0; node.element.classList.remove("arriving"); });
  }

  function replaceEntries(items) {
    cancelEffects(true);
    layer.replaceChildren();
    entries = new Map();
    nodes = [];
    const clean = C.createEntries(items);
    // Pre-size the collection so initialization uses its final distribution.
    clean.forEach((item) => entries.set(item.word, item));
    clean.forEach((item, index) => createNode(item, index));
    distributeInitialWords();
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

  function startFlight(node, isNew, local = false, submission = null) {
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
    flights.push({ node, local, submission, element, path, halo, core, lock, dust, elapsed: 0, duration: 1.22, isNew, bend: (Math.random() < .5 ? -1 : 1), seed: Math.random() * Math.PI * 2 });
  }

  function land(flight, withImpact = true) {
    const { node } = flight;
    flight.element.remove();
    flight.path.remove();
    if (flight.isNew) node.pending = Math.max(0, node.pending - 1);
    if (!flight.local && !node.pending) node.element.classList.remove("arriving");
    if (flight.submission) {
      flight.submission.landed = true;
      flight.submission.landedNode = withImpact && entries.get(node.word) === node ? node : null;
      if (withImpact && flight.submission.approved && !flight.submission.isNew) showArrivalEcho(flight.submission, node.point);
    }
    if (reduced || !withImpact || (!flight.local && entries.get(node.word) !== node)) return;
    const publicNode = entries.get(node.word);
    if (publicNode) publicNode.pulse = 1;
    createImpact(node.point);
  }

  function createImpact(point) {
    if (rings.length >= MAX_IMPACTS) removeImpact(rings.shift());
    const normal = FX.unit(point);
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
    if (submitting) { announce("正在发送，请稍候。"); return false; }
    const result = C.validateWord(raw);
    if (!result.ok) { announce(result.error, true); return false; }
    const word = result.word;
    let node = entries.get(word);
    const isNew = !node;
    if (isNew && entries.size >= C.MAX_WORDS) {
      announce(`星球已达到 ${C.MAX_WORDS} 个念头。可以点亮已有念头，新词需由管理员腾出位置。`, true);
      return false;
    }
    if (node && node.frequency >= C.MAX_FREQUENCY) {
      announce(`「${word}」已达到 ${C.MAX_FREQUENCY} 次共鸣。试着送入另一个念头吧。`, true);
      return false;
    }
    // A private visual target is not a public word. Fast pending/queued/rejected
    // responses may reconcile the collection immediately, but must not erase this flight.
    const angle = Math.random() * Math.PI * 2;
    const offset = .12 + Math.random() * .24;
    const screenPoint = { x: Math.cos(angle) * offset, y: Math.sin(angle) * offset,
      z: Math.sqrt(1 - offset * offset) };
    const point = screenToSphere(screenPoint);
    const submission = { word, isNew, screenPoint, landed: reduced, approved: false, echoShown: false };
    pendingSubmission = submission;
    startFlight({ word, point, screenPoint }, false, true, submission);
    announce(`「${word}」正在送入公共星球…`);
    submitToServer(submission);
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
      if (flight.local && flight.node.screenPoint) flight.node.point = screenToSphere(flight.node.screenPoint);
      const destination = flight.local ? projectEffect(flight.node.point) : flight.node;
      const ex = destination.x, ey = destination.y;
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
    }
    renderMatrix = matrix;
    for (const node of nodes) {
      const p = node.point;
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
    updateArrivalEchoes(dt);
    if (moving || settling || flights.length || rings.length || arrivalEchoes.length || chargeGlow > 0 || running) wake();
    else lastTime = null;
  }

  function wake() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
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
      row.append(word, count, reuse);
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

  $("libraryBtn").addEventListener("click", () => {
    $("librarySearch").value = "";
    $("libraryFeedback").textContent = "";
    libraryList();
    dialog.returnValue = "";
    dialog.showModal();
    inertiaX = 0; inertiaY = 0;
    wake();
  });
  $("closeLibrary").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { (dialog.returnValue === "reuse" ? input : $("libraryBtn")).focus({ preventScroll: true }); wake(); });
  $("librarySearch").addEventListener("input", libraryList);
  $("clearBtn").addEventListener("click", () => dialog.close());

  motionQuery.addEventListener("change", () => {
    reduced = motionQuery.matches;
    inertiaX = 0; inertiaY = 0;
    if (reduced) {
      cancelEffects();
      nodes.forEach((node) => { node.point = { ...node.target }; node.pulse = 0; });
    }
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
  window.addEventListener("online", loadPlanet);

  replaceEntries(previewEntries);
  resize();
  new ResizeObserver(resize).observe(stage);
  window.InnerLightExtensions.configure({ getState: () => ({ slug: PLANET_SLUG, name: planetName, stats: publicStats, url: location.href, sphereElement: stage }), getWords: () => persistedEntries });
  window.addEventListener("innerlight:delivered", ({ detail }) => {
    if (detail.slug !== PLANET_SLUG || !detail.payload?.items) return;
    applyPlanetSnapshot(detail.payload);
    if (detail.payload.status === "pending") announce(`「${detail.payload.item?.word || "念头"}」已送达，等待管理员审核。`);
    else if (detail.payload.status === "rejected") announce(`提交未通过审核：${detail.payload.reason || "内容不适合公开"}`, true);
  });
  loadPlanet();
  setInterval(() => { if (!document.hidden && !submitting) loadPlanet(); }, 15000);
  wake();
})();
