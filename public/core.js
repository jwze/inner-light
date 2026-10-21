/* Inner Light's dependency-free core. Usable as a classic script or via require(). */
(function (root, factory) {
  'use strict';
  var core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  if (root) root.InnerLightCore = core;
}(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_WORDS = 160;
  var MAX_LENGTH = 20;
  var MAX_FREQUENCY = 9999;
  var TAU = Math.PI * 2;
  // Reject controls and invisible direction overrides, but keep emoji ZWJ/variation selectors.
  var CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]/;
  var segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

  function normalizeWord(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').normalize('NFC');
  }

  function graphemes(value) {
    var text = String(value == null ? '' : value);
    return segmenter
      ? Array.from(segmenter.segment(text), function (part) { return part.segment; })
      : Array.from(text);
  }

  function validateWord(value) {
    if (typeof value !== 'string') return { ok: false, error: '请输入一个词语。' };
    if (CONTROL_CHARACTERS.test(value)) return { ok: false, error: '词语不能包含控制字符。' };
    var word = normalizeWord(value);
    if (!word) return { ok: false, error: '请输入一个词语。' };
    if (graphemes(word).length > MAX_LENGTH) {
      return { ok: false, error: '词语不能超过 ' + MAX_LENGTH + ' 个字符。' };
    }
    return { ok: true, word: word };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function entryFrequency(value) {
    if (value === undefined) return 1;
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    var number = Number(value);
    return Number.isFinite(number) ? clamp(Math.round(number), 1, MAX_FREQUENCY) : null;
  }

  function createEntries(raw) {
    if (!Array.isArray(raw)) return [];
    var words = new Map();
    raw.forEach(function (entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      // Only data owned by the entry is relevant; prototype properties are never words.
      if (!Object.prototype.hasOwnProperty.call(entry, 'word')) return;
      var checked = validateWord(entry.word);
      var frequency = entryFrequency(Object.prototype.hasOwnProperty.call(entry, 'frequency') ? entry.frequency : undefined);
      if (!checked.ok || frequency === null) return;
      if (words.has(checked.word)) {
        words.set(checked.word, Math.min(MAX_FREQUENCY, words.get(checked.word) + frequency));
      } else if (words.size < MAX_WORDS) {
        words.set(checked.word, frequency);
      }
    });
    return Array.from(words, function (pair) { return { word: pair[0], frequency: pair[1] }; });
  }

  // Half-step Fibonacci sampling avoids a concentration at either pole.
  function spherePoint(index, total, radius) {
    total = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
    radius = radius === undefined ? 1 : Number.isFinite(radius) ? Math.max(0, radius) : 0;
    if (!total) return { x: 0, y: 0, z: 0 };
    index = Number.isFinite(index) ? clamp(Math.floor(index), 0, total - 1) : 0;
    var y = 1 - 2 * (index + 0.5) / total;
    var ring = Math.sqrt(Math.max(0, 1 - y * y));
    var angle = index * Math.PI * (3 - Math.sqrt(5));
    return { x: Math.cos(angle) * ring * radius, y: y * radius, z: Math.sin(angle) * ring * radius };
  }

  // Standard right-handed rotations: first about Y, then about X (radians).
  function rotatePoint(point, rotationX, rotationY) {
    var cy = Math.cos(rotationY);
    var sy = Math.sin(rotationY);
    var cx = Math.cos(rotationX);
    var sx = Math.sin(rotationX);
    var x = point.x * cy + point.z * sy;
    var z = -point.x * sy + point.z * cy;
    return { x: x, y: point.y * cx - z * sx, z: point.y * sx + z * cx };
  }

  // Positive Z is closer to the viewer. Keep points at/behind the camera finite.
  function projectPoint(point, centerX, centerY, focal) {
    focal = Number.isFinite(focal) && focal > 0 ? focal : 1;
    var scale = focal / Math.max(focal * 0.001, focal - point.z);
    return { x: point.x * scale + centerX, y: point.y * scale + centerY, scale: scale, depth: point.z };
  }

  // Label scale and brightness deliberately carry more depth than position alone.
  // Never cull the back hemisphere: its small dim words make the sphere readable.
  function sphereDepth(z) {
    var near = (clamp(Number.isFinite(z) ? z : 0, -1, 1) + 1) / 2;
    return { scale: 0.5 + near * 1.08, opacity: 0.16 + 0.84 * Math.pow(near, 1.6), glow: Math.pow(near, 3) };
  }

  function rotationStep(x, y, velocityX, velocityY, speed, dt) {
    speed = clamp(Number.isFinite(speed) ? speed : 1, 0.4, 2.5);
    dt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    return { x: normalizeAngle(x + velocityX * speed * dt), y: normalizeAngle(y + velocityY * speed * dt) };
  }

  function fontSize(frequency, compact) {
    var count = entryFrequency(frequency);
    var min = compact ? 11 : 12;
    var max = compact ? 21 : 27;
    return clamp(min + Math.log2(count === null ? 1 : count) * (compact ? 2 : 2.5), min, max);
  }

  // dt is in seconds, lambda is the exponential convergence rate per second.
  function damp(current, target, lambda, dt) {
    if (!(lambda > 0) || !(dt > 0)) return current;
    return current + (target - current) * -Math.expm1(-lambda * dt);
  }

  // Canonical interval is [-PI, PI).
  function normalizeAngle(angle) {
    if (!Number.isFinite(angle)) return 0;
    var result = ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return result === 0 ? 0 : result;
  }

  function readStored(storage, key) {
    try {
      var value = storage.getItem(key);
      if (value == null) return { entries: null, error: false };
      var envelope = JSON.parse(value);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
          envelope.version !== 1 || !Array.isArray(envelope.entries)) {
        return { entries: null, error: true };
      }
      return { entries: createEntries(envelope.entries), error: false };
    } catch (_) {
      return { entries: null, error: true };
    }
  }

  function writeStored(storage, key, entries) {
    if (!Array.isArray(entries)) return false;
    try {
      storage.setItem(key, JSON.stringify({ version: 1, entries: createEntries(entries) }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function shuffled(values, random) {
    random = random || Math.random;
    var result = values.slice();
    for (var i = result.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var value = result[i]; result[i] = result[j]; result[j] = value;
    }
    return result;
  }

  // A fresh direction, but a constant angular magnitude at the fixed speed.
  function randomRotation(random) {
    random = random || Math.random;
    var angle = random() * TAU;
    var magnitude = Math.hypot(0.22, 0.48);
    return { x: Math.cos(angle) * magnitude, y: Math.sin(angle) * magnitude };
  }

  function randomSamples(random) {
    var pool = samples().map(function (item) { return item.word; }).concat([
      '白日梦想家', '公路旅行', '周末露营', '城市漫游', '手帐', '胶片', '黑胶', '爵士',
      '摇滚', '古典乐', '电子乐', '演唱会', '书店', '博物馆', '展览', '剧场',
      '面包', '甜品', '做饭', '火锅', '植物', '园艺', '徒步', '骑行',
      '滑板', '游泳', '羽毛球', '瑜伽', '桌游', '拼图', '科幻', '悬疑',
      '诗歌', '历史', '哲学', '心理学', '天文', '科技', '手作', '陶艺',
      '旅行日记', '早起看海', '落日收藏家', '云朵', '晚风', '雨后', '冬日暖阳', '秋天',
      '夏夜', '春日', '轻松一点', '认真生活', '偶尔放空', '安静陪伴', '快乐至上', '随遇而安',
      '期待惊喜', '新鲜感', '一拍即合', '真心换真心', '自我探索', '一点点进步', '活在当下', '自在生长'
    ]);
    return shuffled(pool, random).slice(0, 96).map(function (word, index) {
      return { word: word, frequency: index < 6 ? 7 - index : 1 };
    });
  }

  function samples() {
    return [
      '希望', '温暖', '勇气', '平静', '相信', '微笑', '成长', '自由',
      '善意', '感恩', '拥抱', '热爱', '星光', '晨曦', '清风', '阳光',
      '花开', '自在', '从容', '笃定', '坚持', '新生', '美好', '喜悦',
      '安宁', '真诚', '陪伴', '倾听', '包容', '珍惜', '梦想', '远方',
      '向前', '勇敢', '明亮', '柔软', '生机', '遇见', '欢喜', '闪耀',
      '夜猫子', '音乐控', '听民谣', '慢热', '喜欢独处', '热爱生活', '旅行', '爱看电影',
      '摄影', '阅读', '猫奴', '狗狗派', '理想主义', '浪漫', '好奇心', '有点社恐',
      '二次元', '游戏玩家', '追剧', '美食', '咖啡', '奶茶', '喜欢下雨', '看日落',
      '分享欲', '记录生活', '温柔', '随性', '认真', '有趣的灵魂', '仰望星空', '海边',
      '山野', '散步', '跑步', '篮球', '吉他', '绘画', '写作', '听播客',
      '不被定义', '忠于自己', '保持热爱', '爱笑', '外冷内热', '细节控', '感性', '直觉',
      '想去远方', '深夜电台', '一起发呆', '人间观察', '治愈', '小确幸', '做个梦', '同频'
    ].map(function (word, index) {
      return { word: word, frequency: index < 6 ? 7 - index : 1 };
    });
  }

  return {
    MAX_WORDS: MAX_WORDS,
    MAX_LENGTH: MAX_LENGTH,
    MAX_FREQUENCY: MAX_FREQUENCY,
    normalizeWord: normalizeWord,
    graphemes: graphemes,
    validateWord: validateWord,
    createEntries: createEntries,
    spherePoint: spherePoint,
    rotatePoint: rotatePoint,
    projectPoint: projectPoint,
    sphereDepth: sphereDepth,
    rotationStep: rotationStep,
    fontSize: fontSize,
    clamp: clamp,
    damp: damp,
    normalizeAngle: normalizeAngle,
    readStored: readStored,
    writeStored: writeStored,
    shuffled: shuffled,
    randomRotation: randomRotation,
    randomSamples: randomSamples,
    samples: samples
  };
}));
