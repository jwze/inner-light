/* Small, deterministic geometry helpers for the comet / sphere interaction. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InnerLightEffects = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };

  function unit(point) {
    var length = Math.hypot(point.x, point.y, point.z) || 1;
    return { x: point.x / length, y: point.y / length, z: point.z / length };
  }

  function cometProgress(elapsed, duration) {
    var charge = 0.18;
    return Math.pow(clamp((elapsed - charge) / Math.max(0.01, duration - charge), 0, 1), 1.65);
  }

  function waveInfluence(point, normal, progress) {
    if (!(progress > 0 && progress < 1)) return 0;
    var p = unit(point);
    var dot = clamp(p.x * normal.x + p.y * normal.y + p.z * normal.z, -1, 1);
    var distance = Math.acos(dot);
    var wavefront = progress * 2.6;
    var crest = Math.exp(-Math.pow((distance - wavefront) / 0.2, 2));
    return crest * Math.sin(Math.PI * progress) * (1 - progress * 0.45);
  }

  function tangentBasis(normal) {
    var n = unit(normal);
    var reference = Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    var u = unit({ x: n.y * reference.z - n.z * reference.y, y: n.z * reference.x - n.x * reference.z, z: n.x * reference.y - n.y * reference.x });
    var v = { x: n.y * u.z - n.z * u.y, y: n.z * u.x - n.x * u.z, z: n.x * u.y - n.y * u.x };
    return { n: n, u: u, v: v };
  }

  function ringPoint(basis, angularRadius, angle) {
    var c = Math.cos(angularRadius), s = Math.sin(angularRadius);
    var a = Math.cos(angle) * s, b = Math.sin(angle) * s;
    return { x: basis.n.x * c + basis.u.x * a + basis.v.x * b, y: basis.n.y * c + basis.u.y * a + basis.v.y * b, z: basis.n.z * c + basis.u.z * a + basis.v.z * b };
  }

  return { unit: unit, cometProgress: cometProgress, waveInfluence: waveInfluence, tangentBasis: tangentBasis, ringPoint: ringPoint };
}));
