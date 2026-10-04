// Crawler — a procedural spider that walks over whatever the stage is showing.
//
// Inspired by Slava Rybin's (@rybinfx) "Web crawlers /[•]\" (Oct 2026, tagged
// "#js x #css"): an eight-legged line creature that chases the cursor across a
// Wikipedia reference list, each foot gripping a real word or link, every
// touch boxing/highlighting the element it stands on. Rybin publishes no
// source; the technique below is the well-documented procedural-walker model
// (home-position stepping + analytic two-bone IK, see Ryan Juckett "Analytic
// Two-Bone IK in 2D" and the MIT engine adampog/literal-web-crawler) rebuilt
// for the qualia harness.
//
// The DOM trick doesn't translate — a quale is pixels, not words — so the
// overlay hands this module a low-res FEATURE GRID (luma + gradient of the
// composited scene) and feet anchor onto the brightest EDGE near where they
// want to land, then box the bright blob they're gripping. On the Code quale
// that lands feet on glyphs; on a particle quale, on the particles.
//
// This file is deliberately DOM-free and allocation-free in the hot path so
// `scripts/check-qualia-crawler.mjs` can exercise it under plain node:
//   • createFeatureGrid(cols, rows)  — ingest RGBA, seek edges, blob bbox
//   • solveTwoBone(...)              — analytic 2-bone IK with fixed bend
//   • createCrawlerSim()             — body steering + gait + anchoring
//   • drawCrawler(ctx, sim, style)   — Canvas2D renderer (the only ctx user)
//
// Coordinates everywhere are the overlay canvas's device pixels; `reach`
// (leg length) carries the DPR + size scale, nothing else does.

export const CRAWLER_FOLLOW = ['auto', 'pointer', 'pose', 'logo', 'wander'];
export const CRAWLER_PALETTES = ['theme', 'reel', 'mono'];
export const CRAWLER_COUNTS = ['1', '2', '3', '4', 'pose'];   // 'pose' = one per tracked person
export const CRAWLER_BODIES = ['frame', 'lens', 'void'];
// Step quantize — which transient detector the feet wait for: highs (hats /
// cymbals), mids (snare), beat (kick), or off (free-running gait).
export const CRAWLER_QUANTIZE = ['off', 'highs', 'mids', 'beat'];
export const CRAWLER_MAX = 4;

export const CRAWLER_DEFAULTS = {
  follow:     'auto',   // auto = pointer if it moved recently → pose → logo → wander
  count:      '1',      // '1'..'4' crawlers, or 'pose' = one per tracked person
  legs:       8,        // 4..8 — odd counts add a trailing unpaired leg
  size:       1.25,     // body scale (reach = 72 px × size × dpr)
  speed:      1.0,      // body top speed scaler
  stride:     0.42,     // step threshold, fraction of reach
  anchor:     0.85,     // 0..1 — how hard feet snap onto image features
  boxes:      0.8,      // highlight-box opacity around gripped features (0 = off)
  reblit:     0.7,      // re-print the gripped patch enlarged / tilted / skewed / inverted (0 = off)
  body:       'void',   // void = scene lensed into a black core · frame = outline · lens = inverted window onto the scene
  silk:       true,     // dragline from the spinneret to the last strong grip
  reactivity: 1.0,      // audio response (beat scuttle, bass crouch, highs jitter)
  quantize:   'highs',  // step on: highs (hats) | mids (snare) | beat (kick) | off — feet lift on the hit
  palette:    'theme',  // theme | reel (Rybin's blue/pink/amber) | mono
};

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function angleDelta(a, b) { return ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; }

// ── Two-bone IK ─────────────────────────────────────────────────────────────
// Hip (hx,hy) → knee → foot (fx,fy) with bone lengths L1/L2. `bend` = ±1 picks
// which side the knee pops out on (fixed per leg so knees never flip).
// Writes the knee into out[0], out[1]. Out-of-reach targets straighten the leg
// along the hip→foot ray (the foot itself is clamped by the sim, this is just
// the draw-time safety).
export function solveTwoBone(hx, hy, fx, fy, L1, L2, bend, out) {
  const dx = fx - hx, dy = fy - hy;
  const d = Math.hypot(dx, dy);
  const base = Math.atan2(dy, dx);
  if (d < 1e-6) { out[0] = hx + L1; out[1] = hy; return out; }
  if (d >= L1 + L2 - 1e-3) {
    out[0] = hx + Math.cos(base) * L1;
    out[1] = hy + Math.sin(base) * L1;
    return out;
  }
  const c = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const a = base + bend * Math.acos(c);
  out[0] = hx + Math.cos(a) * L1;
  out[1] = hy + Math.sin(a) * L1;
  return out;
}

// ── Feature grid ────────────────────────────────────────────────────────────
// A coarse luma + gradient field of the scene. The overlay fills it from a
// downscaled drawImage/getImageData of the composited stage every few frames;
// the sim queries it in grid cells and converts with `cell` (device px per
// cell) which the overlay sets on resize.
export function createFeatureGrid(cols = 160, rows = 90) {
  let luma = new Float32Array(cols * rows);
  let grad = new Float32Array(cols * rows);
  // BFS scratch for blob(): a visited stamp per cell + a ring queue.
  let stamp = new Int32Array(cols * rows);
  let queue = new Int32Array(cols * rows);
  let stampId = 0;
  let cell = 8;          // device px per grid cell (x and y share one scale)
  let hasData = false;

  function resize(c, r) {
    if (c === cols && r === rows) return;
    cols = Math.max(2, c | 0); rows = Math.max(2, r | 0);
    luma = new Float32Array(cols * rows);
    grad = new Float32Array(cols * rows);
    stamp = new Int32Array(cols * rows);
    queue = new Int32Array(cols * rows);
    stampId = 0;
    hasData = false;
  }

  /** RGBA bytes (cols*rows*4) → luma [0,1] + central-difference gradient. */
  function ingest(data) {
    const n = cols * rows;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      luma[i] = (data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114) * (1 / 255);
    }
    for (let y = 0; y < rows; y++) {
      const ym = y > 0 ? y - 1 : y, yp = y < rows - 1 ? y + 1 : y;
      for (let x = 0; x < cols; x++) {
        const xm = x > 0 ? x - 1 : x, xp = x < cols - 1 ? x + 1 : x;
        const gx = luma[y * cols + xp] - luma[y * cols + xm];
        const gy = luma[yp * cols + x] - luma[ym * cols + x];
        grad[y * cols + x] = Math.abs(gx) + Math.abs(gy);
      }
    }
    hasData = true;
  }

  /**
   * Find the most "grippable" cell near device-px (px,py) within radius px.
   * Score = edge strength + a little brightness − distance falloff, so feet
   * prefer a crisp edge close to where they wanted to land over a bright blob
   * far away. Writes {x, y, score, ix, iy} into out (device px). Returns
   * false when nothing beats the floor (flat dark background).
   */
  function seek(px, py, radius, out) {
    if (!hasData) return false;
    const cx = px / cell, cy = py / cell, cr = Math.max(1, radius / cell);
    const x0 = clamp(Math.floor(cx - cr), 0, cols - 1), x1 = clamp(Math.ceil(cx + cr), 0, cols - 1);
    const y0 = clamp(Math.floor(cy - cr), 0, rows - 1), y1 = clamp(Math.ceil(cy + cr), 0, rows - 1);
    let best = -1, bi = -1;
    const inv = 1 / cr;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * cols + x;
        const g = grad[i];
        if (g < 0.06) continue;                          // no edge here
        const dx = (x + 0.5) - cx, dy = (y + 0.5) - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) * inv;  // 0..~1
        if (dist > 1) continue;
        const s = g * 1.6 + luma[i] * 0.35 - dist * 0.45;
        if (s > best) { best = s; bi = i; }
      }
    }
    if (bi < 0 || best < 0.08) return false;
    out.ix = bi % cols; out.iy = (bi / cols) | 0;
    out.x = (out.ix + 0.5) * cell; out.y = (out.iy + 0.5) * cell;
    out.score = best;
    return true;
  }

  /**
   * Bounding box (device px) of the bright connected blob containing grid
   * cell (ix,iy) — the "element" the foot is gripping. Flood fill over cells
   * brighter than `thr`, capped at maxW×maxH cells so a bright field doesn't
   * turn into a screen-sized box. Writes {x,y,w,h} into out; false when the
   * seed cell is dark.
   */
  function blob(ix, iy, out, thr = 0.22, maxW = 22, maxH = 6) {
    const seed = iy * cols + ix;
    if (luma[seed] < thr) return false;
    stampId++;
    if (stampId === 0x7fffffff) { stamp.fill(0); stampId = 1; }
    let head = 0, tail = 0;
    queue[tail++] = seed; stamp[seed] = stampId;
    let minX = ix, maxX = ix, minY = iy, maxY = iy;
    const halfW = maxW >> 1, halfH = maxH >> 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % cols, y = (i / cols) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      // 4-neighbourhood, bounded to the cap window around the seed.
      if (x > 0 && x - 1 >= ix - halfW)       visit(i - 1);
      if (x < cols - 1 && x + 1 <= ix + halfW) visit(i + 1);
      if (y > 0 && y - 1 >= iy - halfH)       visit(i - cols);
      if (y < rows - 1 && y + 1 <= iy + halfH) visit(i + cols);
    }
    out.x = minX * cell; out.y = minY * cell;
    out.w = (maxX - minX + 1) * cell; out.h = (maxY - minY + 1) * cell;
    return true;

    function visit(j) {
      if (stamp[j] === stampId || luma[j] < thr) return;
      stamp[j] = stampId; queue[tail++] = j;
    }
  }

  return {
    get cols() { return cols; }, get rows() { return rows; },
    get cell() { return cell; }, set cell(v) { cell = Math.max(1, v); },
    get hasData() { return hasData; },
    luma: () => luma, grad: () => grad,
    resize, ingest, seek, blob,
    clear() { luma.fill(0); grad.fill(0); hasData = false; },
  };
}

// ── Leg layouts ─────────────────────────────────────────────────────────────
// Where each foot rests relative to the body (fractions of reach): f forward,
// l lateral. hip = where the leg joins the body (fraction of body length).
// Built per leg count: `pairs` mirrored legs spread from front (f 0.95) to
// rear (f −0.78), widest in the middle; an odd count adds one unpaired
// trailing leg at the rear, slightly to one side, knee bent the other way —
// the lopsided, injured-looking scuttle an odd number buys.
const MAX_LEGS = 8;
const MIN_LEGS = 4;
// Quantize: seconds without a tick before the gait free-runs again.
const QUANT_LAPSE = 1.5;
// Locked, a foot this far off its rest (× reach) steps on its group's tick —
// the hits decide the stride, not the stride slider (which rules the free gait).
const LOCK_OFF = 0.18;
// A lifting foot lands this many seconds of body travel ahead of its rest.
const STEP_LEAD = 0.22;
// Void-orb semi-axes, × reach (nominal; crouch/bob scale them live).
export const ORB_AX = 0.52;
export const ORB_AY = 0.42;
const ODD_LEG = { f: -1.1, l: 0.0, hip: -0.5 };   // straight back, hip on the cell's rear end
const _layoutCache = new Map();
export function buildLegLayout(n) {
  n = clamp(Math.round(n) || 8, MIN_LEGS, MAX_LEGS);
  if (_layoutCache.has(n)) return _layoutCache.get(n);
  const pairs = n >> 1;
  const L = [];
  // Odd counts keep the pairs forward of the trailing leg so nothing overlaps it.
  const rearF = n & 1 ? -0.55 : -0.78, rearHip = n & 1 ? -0.2 : -0.3;
  for (let i = 0; i < pairs; i++) {
    const t = pairs === 1 ? 0.5 : i / (pairs - 1);
    L.push({ f: 0.95 + (rearF - 0.95) * t, l: 0.62 + 0.38 * Math.sin(Math.PI * t), hip: 0.42 + (rearHip - 0.42) * t });
  }
  const out = { n, pairs, legs: L, odd: n & 1 ? ODD_LEG : null };
  _layoutCache.set(n, out);
  return out;
}

// ── Sim ─────────────────────────────────────────────────────────────────────
export function createCrawlerSim() {
  const s = {
    x: 0, y: 0, vx: 0, vy: 0, a: -Math.PI / 2,
    speed: 0,
    reach: 72,
    legCount: 0,
    crouch: 0,        // 0..1 bass/beat body dip (scales body + shortens stance)
    tickAge: 1e9,     // seconds since the last quantize tick (1e9 = never)
    tickPeriod: 0.5,  // EMA of the interval between ticks (the hat pace)
    locked: false,    // true while quantized AND ticks are still arriving
    tickGroup: 0,     // gait group that took the last tick (they alternate)
    jitter: 0,        // highs → leg tremor amplitude (px)
    bob: 0,           // beat-triggered body bounce envelope
    roamX: 0, roamY: 0, roamWait: 0, hasRoam: false,
    silk: { x: 0, y: 0, alive: false, age: 0 },
    feet: [],
  };
  for (let i = 0; i < MAX_LEGS; i++) {
    s.feet.push({
      side: 1, i: 0, group: 0, bend: 1, hipF: 0,
      ang: 0,              // orb mode: this leg's angle around the body (evenly spaced)
      x: 0, y: 0, fromX: 0, fromY: 0, toX: 0, toY: 0,
      t: 1, dur: 0.15, swing: false,
      planted: 0,          // seconds since the foot landed (flash ring + box fade-in)
      anchored: false,     // landed on an image feature (vs bare floor)
      grip: false,         // latched onto the external grip rect (the logo mark)
      variant: 0,          // re-blit treatment picked at plant (0 zoom · 1 tilt · 2 skew · 3 negative)
      box: { x: 0, y: 0, w: 0, h: 0, on: false },
      kx: 0, ky: 0,        // knee cache (filled by solveLegs for the renderer)
      hx: 0, hy: 0,        // hip cache
    });
  }
  const seekOut = { x: 0, y: 0, score: 0, ix: 0, iy: 0 };
  const kneeOut = [0, 0];

  let layoutN = buildLegLayout(8);
  function legSpec(f) { return f.i < 0 ? layoutN.odd : layoutN.legs[f.i]; }

  function setLegs(n) {
    n = clamp(Math.round(n) || 8, MIN_LEGS, MAX_LEGS);
    if (n === s.legCount) return;
    s.legCount = n;
    layoutN = buildLegLayout(n);
    const L = layoutN.legs;
    let k = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < L.length; i++, k++) {
        const f = s.feet[k];
        f.side = side; f.i = i; f.bend = side;
        // Alternating tetrapod / tripod: neighbours on one side and the
        // mirror leg across belong to opposite groups.
        f.group = (i + (side > 0 ? 1 : 0)) % 2;
        f.hipF = L[i].hip;
        f.ang = side * (i + 0.5) * (Math.PI * 2 / n);
        f.swing = false; f.t = 1; f.box.on = false; f.anchored = false;
      }
    }
    if (layoutN.odd) {
      // The trailing odd leg: i = -1 marks it, right side, knee bent inward,
      // in whichever gait group the rear pair isn't.
      const f = s.feet[k];
      f.side = 1; f.i = -1; f.bend = -1;
      f.group = (L.length - 1 + 1) % 2 === 0 ? 1 : 0;
      f.hipF = layoutN.odd.hip;
      f.ang = Math.PI;
      f.swing = false; f.t = 1; f.box.on = false; f.anchored = false;
    }
    plantAll();
  }

  function idealFoot(f, out) {
    const r = s.reach, L = legSpec(f);
    const cx = Math.cos(s.a), sy = Math.sin(s.a);
    let fw, lat;
    if (hipMode === 'orb') {
      // Evenly spaced around the orb, a reach out from the centre.
      const rr = r * 1.0 * (1 - s.crouch * 0.1);
      fw = Math.cos(f.ang) * rr; lat = Math.sin(f.ang) * rr;
    } else {
      fw = L.f * r; lat = f.side * L.l * r * (1 - s.crouch * 0.15);
    }
    out[0] = s.x + cx * fw - sy * lat;
    out[1] = s.y + sy * fw + cx * lat;
    return out;
  }
  const idealOut = [0, 0];

  // Hip placement. 'cell': the slim rectangle along the heading (frame /
  // lens bodies) — hips on its long edges. 'orb': the void ellipse — hips on
  // its perimeter, each at the angle of its leg's rest direction, so the
  // outline is exactly where the legs meet the body.
  let hipMode = 'cell';
  function setHipMode(m) { hipMode = m === 'orb' ? 'orb' : 'cell'; }
  /** Void-orb semi-axes (body space) — crouch/bob-scaled like the renderer. */
  function orbAxes(out) {
    out[0] = s.reach * ORB_AX * (1 - s.crouch * 0.12) * (1 + s.bob * 0.15);
    out[1] = s.reach * ORB_AY * (1 + s.crouch * 0.35) * (1 + s.bob * 0.15);
    return out;
  }
  const axesOut = [0, 0];
  /** Hip in BODY space (x along the heading, y lateral). */
  function hipLocal(f, out) {
    if (hipMode === 'orb') {
      orbAxes(axesOut);
      out[0] = Math.cos(f.ang) * axesOut[0];
      out[1] = Math.sin(f.ang) * axesOut[1];
    } else {
      out[0] = f.hipF * s.reach * 0.55;
      out[1] = f.i < 0 ? 0 : f.side * s.reach * 0.14;   // odd leg: centre of the rear end
    }
    return out;
  }
  const hipLocalOut = [0, 0];
  function hipOf(f, out) {
    hipLocal(f, hipLocalOut);
    const cx = Math.cos(s.a), sy = Math.sin(s.a);
    out[0] = s.x + cx * hipLocalOut[0] - sy * hipLocalOut[1];
    out[1] = s.y + sy * hipLocalOut[0] + cx * hipLocalOut[1];
    return out;
  }

  function plantAll() {
    for (let k = 0; k < s.legCount; k++) {
      const f = s.feet[k];
      idealFoot(f, idealOut);
      f.x = f.toX = f.fromX = idealOut[0];
      f.y = f.toY = f.fromY = idealOut[1];
      f.swing = false; f.t = 1; f.planted = 1; f.box.on = false; f.anchored = false;
    }
  }

  function placeAt(x, y) {
    s.x = x; s.y = y; s.vx = s.vy = 0; s.hasRoam = false;
    s.silk.alive = false;
    plantAll();
  }

  /** Stage resized: keep the creature at the same relative spot. */
  function rescale(sx, sy) {
    s.x *= sx; s.y *= sy; s.roamX *= sx; s.roamY *= sy;
    s.silk.x *= sx; s.silk.y *= sy;
    for (let k = 0; k < MAX_LEGS; k++) {
      const f = s.feet[k];
      f.x *= sx; f.y *= sy; f.fromX *= sx; f.fromY *= sy; f.toX *= sx; f.toY *= sy;
      f.box.on = false;
    }
  }

  function pickRoam(W, H, rnd) {
    const m = s.reach * 1.2;
    let x = s.x, y = s.y;
    for (let k = 0; k < 10; k++) {
      x = m + rnd() * Math.max(10, W - 2 * m);
      y = m + rnd() * Math.max(10, H - 2 * m);
      const d = Math.hypot(x - s.x, y - s.y);
      if (d > s.reach * 2.5 && d < s.reach * 9) break;
    }
    s.roamX = x; s.roamY = y; s.hasRoam = true;
    s.roamWait = 0.4 + rnd() * 2.2;
  }

  /**
   * Start a step toward (px,py). With a grid, the landing is pulled toward the
   * best edge within reach×0.5×anchor; a strong grip also boxes the blob
   * under it and (sometimes) re-pins the dragline.
   */
  function lift(f, px, py, inp) {
    const grid = inp.grid;
    const strength = inp.anchor;
    const r = s.reach;
    f.anchored = false; f.box.on = false;
    // Desired landing, kept inside 0.8 reach of the hip so a velocity lead
    // can't ask for a spot the leg can't hold; the seek radius below then
    // stays within L1+L2 (1.2 reach) even when it pulls outward.
    hipOf(f, idealOut);
    const hx = idealOut[0], hy = idealOut[1];
    let dx = px - hx, dy = py - hy, d = Math.hypot(dx, dy);
    if (d > r * 0.8) { px = hx + dx / d * r * 0.8; py = hy + dy / d * r * 0.8; }
    let lx = px, ly = py;
    f.grip = false;
    const gr = inp.gripRect;
    // External grip rect (the logo mark): a foot landing within half a reach
    // of its perimeter latches onto the nearest perimeter point and boxes the
    // whole mark — the creature climbs the logo rather than walking past it.
    if (gr && gr.w > 0 && gr.h > 0) {
      const cx = clamp(px, gr.x, gr.x + gr.w), cy = clamp(py, gr.y, gr.y + gr.h);
      let nx = cx, ny = cy;
      if (cx === px && cy === py) {
        // Inside the rect: project to the nearest edge.
        const dl = px - gr.x, drt = gr.x + gr.w - px, dt = py - gr.y, db = gr.y + gr.h - py;
        const m = Math.min(dl, drt, dt, db);
        if (m === dl) nx = gr.x; else if (m === drt) nx = gr.x + gr.w; else if (m === dt) ny = gr.y; else ny = gr.y + gr.h;
      }
      if (Math.hypot(nx - px, ny - py) < r * 0.55) {
        lx = nx; ly = ny; f.anchored = true; f.grip = true;
        if (inp.boxes > 0.01) { f.box.x = gr.x; f.box.y = gr.y; f.box.w = gr.w; f.box.h = gr.h; f.box.on = true; }
      }
    }
    if (!f.grip && grid && strength > 0.01 && grid.seek(px, py, r * 0.38 * strength + 2, seekOut)) {
      lx = px + (seekOut.x - px) * strength;
      ly = py + (seekOut.y - py) * strength;
      f.anchored = true;
      if (inp.boxes > 0.01 && grid.blob(seekOut.ix, seekOut.iy, f.box)) f.box.on = true;
      if (inp.silk && seekOut.score > 0.35 && (!s.silk.alive || s.silk.age > 1.2) && inp.rnd() < 0.35) {
        s.silk.x = lx; s.silk.y = ly; s.silk.alive = true; s.silk.age = 0;
      }
    }
    // Never ask for more than the leg can reach from its hip.
    const maxR = r * 1.17;   // L1+L2 = 1.2 reach, keep a little slack
    dx = lx - hx; dy = ly - hy; d = Math.hypot(dx, dy);
    if (d > maxR) {
      lx = hx + dx / d * maxR; ly = hy + dy / d * maxR;
      // Pulled off the feature by the reach clamp — it's bare floor now.
      f.anchored = false; f.box.on = false; f.grip = false;
    }
    if (f.anchored) f.variant = (inp.rnd() * 4) | 0;
    f.fromX = f.x; f.fromY = f.y; f.toX = lx; f.toY = ly;
    f.t = 0; f.swing = true;
    // Faster walking (and beats) → quicker steps. Locked to a tick train,
    // the swing also has to land before the next tick lands.
    f.dur = Math.max(0.07, 0.17 - s.speed / (r * 36)) * (1 - inp.beatPulse * 0.35);
    if (s.locked) f.dur = Math.min(f.dur, Math.max(0.07, s.tickPeriod * 0.7));
  }

  /**
   * Advance by dt seconds.
   * inp = {
   *   W, H,                 stage size (device px)
   *   tx, ty, hasTarget,    where to go (pointer / pose); false → wander
   *   reach,                leg length in device px
   *   speed,                top-speed scaler
   *   stride,               step threshold as a fraction of reach
   *   anchor, boxes, silk,  feature snapping / box opacity / dragline on
   *   grid,                 feature grid or null
   *   gripRect,             {x,y,w,h} device px an external thing to latch onto (logo mark), or null
   *   beatPulse, beatActive, bass, highs,   audio (already reactivity-scaled)
   *   quantize, tick,       step on a transient train: feet wait for `tick` (true on
   *                         the frame the chosen detector fired) before lifting;
   *                         falls back to the free gait when ticks stop arriving
   *   rnd,                  () => [0,1)
   * }
   */
  function step(dt, inp) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    const W = inp.W, H = inp.H;
    s.reach = inp.reach;
    if (s.legCount === 0) setLegs(8);

    // Audio envelopes — smooth, never snap.
    const kA = 1 - Math.exp(-dt * 10);
    s.crouch += (clamp(inp.bass * 0.8 + inp.beatPulse * 0.5, 0, 1) - s.crouch) * kA;
    s.jitter += (inp.highs * s.reach * 0.06 - s.jitter) * kA;
    if (inp.beatActive) s.bob = 1;
    s.bob *= Math.exp(-dt * 9);
    // Quantize clock. A tick stamps the period (EMA of the gap) and resets
    // the age; with no ticks for QUANT_LAPSE s (a hat-less passage, audio
    // off) the gate opens and the gait free-runs until the hits come back.
    s.tickAge += dt;
    if (inp.quantize && inp.tick) {
      if (s.tickAge < QUANT_LAPSE) s.tickPeriod += (clamp(s.tickAge, 0.06, QUANT_LAPSE) - s.tickPeriod) * 0.4;
      s.tickAge = 0;
    }
    s.locked = !!inp.quantize && s.tickAge < QUANT_LAPSE;

    // 1. Target.
    let tx, ty;
    if (inp.hasTarget) {
      tx = inp.tx; ty = inp.ty; s.hasRoam = false;
    } else {
      if (!s.hasRoam || s.roamX < 0 || s.roamX > W || s.roamY < 0 || s.roamY > H) pickRoam(W, H, inp.rnd);
      if (Math.hypot(s.roamX - s.x, s.roamY - s.y) < s.reach * 0.4) {
        s.roamWait -= dt;
        if (s.roamWait < 0) pickRoam(W, H, inp.rnd);
      }
      tx = s.roamX; ty = s.roamY;
    }
    const m = s.reach * 0.6;
    tx = clamp(tx, m, Math.max(m, W - m)); ty = clamp(ty, m, Math.max(m, H - m));

    // 2. Steer: ease toward a capped speed, slow on arrival, beat surges.
    const dx = tx - s.x, dy = ty - s.y;
    const d = Math.hypot(dx, dy);
    let maxV = s.reach * (1.9 + 0.9 * inp.speed) * inp.speed * (1 + inp.beatPulse * 0.6);
    // Locked to a tick train the hits set the pace: the groups alternate
    // ticks, so a foot stands for two ticks (less its landing lead) and the
    // body is capped so it lags ≈0.4 reach in that time — well short of the
    // urgent break-through. Fast hats = a scuttle, a slow kick = a stalk.
    if (s.locked) maxV = Math.min(maxV, s.reach * 0.4 / Math.max(0.1, 2 * s.tickPeriod - STEP_LEAD));
    const want = d > s.reach * 0.12 ? Math.min(maxV, d * 2.4) : 0;
    const k = 1 - Math.exp(-dt * 4.5);
    s.vx += ((d ? dx / d : 0) * want - s.vx) * k;
    s.vy += ((d ? dy / d : 0) * want - s.vy) * k;
    s.x += s.vx * dt; s.y += s.vy * dt;
    s.speed = Math.hypot(s.vx, s.vy);
    if (s.speed > s.reach * 0.1) s.a += angleDelta(s.a, Math.atan2(s.vy, s.vx)) * (1 - Math.exp(-dt * 6));

    // 3. Legs.
    const r = s.reach;
    const stepDist = r * clamp(inp.stride, 0.15, 0.9);
    // Locked + tick: hand the tick to ONE gait group — the one that didn't
    // take the last tick, if any of its feet is off its rest (else the other,
    // else nobody) — so the groups alternate hits instead of the first group
    // in leg order monopolising every tick and starving the other into
    // urgent off-beat steps.
    let tickGroup = -1;
    if (s.locked && inp.tick) {
      const pref = s.tickGroup ^ 1;
      let wantPref = false, wantOther = false;
      for (let n = 0; n < s.legCount; n++) {
        const f = s.feet[n];
        if (f.swing) continue;
        idealFoot(f, idealOut);
        if (Math.hypot(f.x - idealOut[0], f.y - idealOut[1]) > r * LOCK_OFF) { if (f.group === pref) wantPref = true; else wantOther = true; }
      }
      tickGroup = wantPref ? pref : wantOther ? pref ^ 1 : -1;
      if (tickGroup >= 0) s.tickGroup = tickGroup;
    }
    let sw0 = 0, sw1 = 0;
    for (let n = 0; n < s.legCount; n++) { const f = s.feet[n]; if (f.swing) { if (f.group) sw1++; else sw0++; } }
    for (let n = 0; n < s.legCount; n++) {
      const f = s.feet[n];
      idealFoot(f, idealOut);
      const ix = idealOut[0], iy = idealOut[1];
      if (f.swing) {
        f.t = Math.min(1, f.t + dt / f.dur);
        const e = easeInOut(f.t);
        f.x = f.fromX + (f.toX - f.fromX) * e;
        f.y = f.fromY + (f.toY - f.fromY) * e;
        if (f.t >= 1) { f.swing = false; f.planted = 0; }
        continue;
      }
      f.planted += dt;
      const off = Math.hypot(f.x - ix, f.y - iy);
      // Hopelessly far (teleport, big resize): snap.
      if (off > r * 3) { f.x = ix; f.y = iy; f.box.on = false; f.anchored = false; continue; }
      // Standing still: shuffle a foot back under the body now and then; the
      // beat makes the whole creature fidget. (Free gait only — locked, a
      // foot off its rest simply steps on its group's tick, idle or not.)
      const idle = s.speed < r * 0.08;
      const settle = !s.locked && idle && off > r * 0.16 && inp.rnd() < dt * (2.0 + inp.beatPulse * 14);
      const wants = s.locked ? off > r * LOCK_OFF : (off > stepDist || settle);
      const go = !s.locked || f.group === tickGroup;   // may this leg lift this frame?
      // Urgent (overstretched) legs may break gait order — and the quantize
      // gate — but never more than half the legs leave the ground at once:
      // the body always has a stance to stand on, however hard it was yanked.
      const urgent = off > r * 0.75 && (sw0 + sw1) < (s.legCount >> 1);
      const otherGroupDown = (f.group ? sw0 : sw1) === 0;
      if (urgent || (go && wants && otherGroupDown)) {
        lift(f, ix + s.vx * STEP_LEAD, iy + s.vy * STEP_LEAD, inp);
        if (f.group) sw1++; else sw0++;
      }
    }

    // 4. Silk ages; drop it once it's well behind or too far.
    if (s.silk.alive) {
      s.silk.age += dt;
      if (Math.hypot(s.silk.x - s.x, s.silk.y - s.y) > r * 7 || s.silk.age > 14) s.silk.alive = false;
    }

    solveLegs();
  }

  /** Fill hip + knee caches for the renderer (IK with a fixed bend per leg). */
  function solveLegs() {
    const L1 = s.reach * 0.56, L2 = s.reach * 0.64;
    for (let n = 0; n < s.legCount; n++) {
      const f = s.feet[n];
      hipOf(f, idealOut);
      f.hx = idealOut[0]; f.hy = idealOut[1];
      solveTwoBone(f.hx, f.hy, f.x, f.y, L1, L2, f.bend, kneeOut);
      f.kx = kneeOut[0]; f.ky = kneeOut[1];
    }
  }

  return {
    state: s,
    setLegs, setHipMode, placeAt, rescale, step, solveLegs, plantAll,
    hipLocal: (f, out) => hipLocal(f, out),
    orbAxes: (out) => orbAxes(out),
    idealFoot: (f, out) => idealFoot(f, out),
    hipOf: (f, out) => hipOf(f, out),
  };
}

// ── Renderer ────────────────────────────────────────────────────────────────
// style = { leg, joint, body, core, box, boxAlt, silk, flash, lineW }
export const CRAWLER_STYLES = {
  // Rybin's reel: ultramarine legs, hot-pink body, amber dragline + boxes.
  reel: {
    leg: 'rgba(96,110,255,0.95)', joint: 'rgba(170,180,255,1)',
    body: 'rgba(255,64,170,1)', core: 'rgba(255,170,60,1)',
    box: 'rgba(255,64,170,A)', boxAlt: 'rgba(96,120,255,A)',
    silk: 'rgba(255,170,60,0.75)', flash: 'rgba(255,255,255,A)',
  },
  mono: {
    leg: 'rgba(230,234,246,0.9)', joint: 'rgba(255,255,255,1)',
    body: 'rgba(255,255,255,1)', core: 'rgba(255,255,255,1)',
    box: 'rgba(255,255,255,A)', boxAlt: 'rgba(200,205,220,A)',
    silk: 'rgba(255,255,255,0.55)', flash: 'rgba(255,255,255,A)',
  },
};

/** Build a style from the active theme's accent knobs (theme.js readKnobs). */
export function themeCrawlerStyle(K) {
  const ac = K?.ac;
  if (!ac) return CRAWLER_STYLES.reel;
  return {
    leg: ac.accent.rgba(0.95), joint: ac.cyan.rgba(1),
    body: ac.pink.rgba(1), core: ac.amber.rgba(1),
    box: ac.pink.rgba('A'), boxAlt: ac.cyan.rgba('A'),
    silk: ac.amber.rgba(0.7), flash: ac.cyan.rgba('A'),
  };
}

function withAlpha(tpl, a) { return tpl.replace('A', a.toFixed(3)); }

/**
 * Draw one crawler.
 *   boxes   highlight-box opacity (0 skips the pass)
 *   glow    soft additive halo gain on the void body (frame / lens draw no halo)
 *   t       monotonic time for the idle tremor
 *   dpr     device pixel ratio (hairline widths)
 *   scene   { src, sx, sy } — a canvas showing what the creature walks on,
 *           with device-px → src-px scale factors; null disables re-blits
 *           and the lens body
 *   rawScene the untreated fx canvas for the lens body (defaults to scene)
 *   reblit  0..1 — re-print each gripped patch (enlarged / tilted / skewed /
 *           inverted per foot) at this opacity
 *   body    'frame' | 'lens' | 'void' — void lenses rawScene INSIDE the body
 *           down into a black singularity
 */
export function drawCrawler(ctx, sim, style, {
  boxes = 0.8, glow = 1, t = 0, dpr = 1, scene = null, rawScene = null, reblit = 0, body = 'frame',
} = {}) {
  const lensSrc = rawScene || scene;
  const s = sim.state;
  if (s.legCount === 0) return;
  const r = s.reach;
  const lw = Math.max(1, r * 0.022);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // Re-blits — the gripped patch re-printed as a glowing ghost: zoomed,
  // tilted, skewed or inverted (variant picked at plant). The reel's
  // enlarged/skewed/recoloured words, in pixel space. Drawn first so the
  // legs + boxes land on top.
  if (reblit > 0.01 && scene && scene.src) {
    const src = scene.src, sx = scene.sx, sy = scene.sy;
    const maxSide = r * 2.6;
    ctx.globalCompositeOperation = 'lighter';
    for (let n = 0; n < s.legCount; n++) {
      const f = s.feet[n];
      if (f.swing || !f.box.on || !f.anchored || f.grip) continue;
      const b = f.box;
      if (b.w > maxSide || b.h > maxSide || b.w < 2 || b.h < 2) continue;
      const fadeIn = clamp(f.planted * 5, 0, 1);
      const a = reblit * fadeIn * (0.35 + 0.65 * Math.exp(-f.planted * 0.9));
      if (a < 0.01) continue;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const wob = Math.sin(t * 3 + n) * 0.03;
      ctx.save();
      ctx.translate(cx, cy);
      switch (f.variant) {
        case 0: ctx.scale(1.45 + wob, 1.45 + wob); break;                        // zoom
        case 1: ctx.rotate((n & 1 ? 1 : -1) * (0.16 + wob)); ctx.scale(1.2, 1.2); break;   // tilt
        case 2: ctx.transform(1.15, 0, (n & 1 ? 0.45 : -0.45), 1.15, 0, 0); break;         // skew
        default: ctx.scale(1.25, 1.25); ctx.filter = 'invert(1) hue-rotate(180deg)'; break; // negative
      }
      ctx.globalAlpha = a;
      try {
        ctx.drawImage(src, b.x * sx, b.y * sy, b.w * sx, b.h * sy, -b.w / 2, -b.h / 2, b.w, b.h);
      } catch { /* tainted / zero-size source — skip the ghost */ }
      ctx.filter = 'none';
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // Anchor boxes — the "element" each foot grips. Fade in on plant, drift to
  // a thin outline once settled; alternate colour per leg index so a cluster
  // of boxes reads as several highlights, like the reel.
  if (boxes > 0.01) {
    ctx.lineWidth = Math.max(1, dpr);
    for (let n = 0; n < s.legCount; n++) {
      const f = s.feet[n];
      if (f.swing || !f.box.on) continue;
      const fadeIn = clamp(f.planted * 6, 0, 1);
      const a = boxes * fadeIn * (0.55 + 0.45 * Math.exp(-f.planted * 1.5));
      const tpl = (n & 1) ? style.boxAlt : style.box;
      ctx.strokeStyle = withAlpha(tpl, a);
      ctx.strokeRect(f.box.x + 0.5, f.box.y + 0.5, f.box.w, f.box.h);
      if (f.planted < 0.35) {
        ctx.fillStyle = withAlpha(tpl, a * 0.22 * (1 - f.planted / 0.35));
        ctx.fillRect(f.box.x, f.box.y, f.box.w, f.box.h);
      }
    }
  }

  // Dragline — spinneret (rear of body) to the last strong grip.
  if (s.silk.alive) {
    const bx = s.x - Math.cos(s.a) * r * 0.3, by = s.y - Math.sin(s.a) * r * 0.3;
    ctx.strokeStyle = style.silk;
    ctx.lineWidth = Math.max(0.75, lw * 0.6);
    ctx.globalAlpha = clamp(1 - s.silk.age / 14, 0, 1) * 0.9;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(s.silk.x, s.silk.y); ctx.stroke();
    ctx.globalAlpha = 1;
    // tiny anchor tick at the far end
    ctx.strokeRect(s.silk.x - r * 0.04, s.silk.y - r * 0.04, r * 0.08, r * 0.08);
  }

  // Legs — hip → knee → foot. Swinging legs draw a touch brighter + lifted
  // (pulled toward the hip) so the step reads top-down.
  const jitter = s.jitter;
  for (let n = 0; n < s.legCount; n++) {
    const f = s.feet[n];
    let fx = f.x, fy = f.y, kx = f.kx, ky = f.ky;
    if (f.swing) {
      const liftAmt = Math.sin(f.t * Math.PI) * 0.18;
      fx += (f.hx - fx) * liftAmt; fy += (f.hy - fy) * liftAmt;
      kx += (f.hx - kx) * liftAmt * 0.5; ky += (f.hy - ky) * liftAmt * 0.5;
    }
    if (jitter > 0.01) {
      const ph = t * 37 + n * 1.7;
      kx += Math.sin(ph) * jitter; ky += Math.cos(ph * 1.3) * jitter;
    }
    ctx.strokeStyle = style.leg;
    ctx.lineWidth = f.swing ? lw * 1.25 : lw;
    ctx.globalAlpha = f.swing ? 1 : 0.85;
    ctx.beginPath(); ctx.moveTo(f.hx, f.hy); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.globalAlpha = 1;
    // joints
    ctx.fillStyle = style.joint;
    const jr = Math.max(1.2, r * 0.03);
    ctx.beginPath(); ctx.arc(kx, ky, jr, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(fx, fy, f.anchored ? jr * 1.15 : jr * 0.8, 0, Math.PI * 2); ctx.fill();
    // plant flash
    if (!f.swing && f.planted < 0.3) {
      const p = f.planted / 0.3;
      ctx.strokeStyle = withAlpha(style.flash, (1 - p) * 0.8);
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath(); ctx.arc(fx, fy, jr * (1 + p * 5), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Body — a slim rectangle along the heading (the reel's pink cell), with a
  // warm core dot at the FRONT (the head end — it reads as which way the
  // creature is facing). Crouch widens + shortens it a touch, bob scales it.
  const bodyLen = r * 0.55 * (1 - s.crouch * 0.12) * (1 + s.bob * 0.12);
  const bodyW = r * 0.16 * (1 + s.crouch * 0.35) * (1 + s.bob * 0.12);
  ctx.translate(s.x, s.y); ctx.rotate(s.a);
  // Lens body — the body cell itself is a see-through negative of the scene
  // under it (invert flips lightness, hue-rotate 180 brings the hues back,
  // like the negative post), so the creature carries a little null-portal
  // around. Clipped to the exact cell the hips sit on — no outline, no wider
  // pane — so the leg joints stay visible.
  if (body === 'lens' && lensSrc && lensSrc.src) {
    ctx.save();
    ctx.beginPath(); ctx.rect(-bodyLen / 2, -bodyW / 2, bodyLen, bodyW); ctx.clip();
    // Un-rotate to draw the scene in place, then the clip keeps the cell.
    ctx.rotate(-s.a); ctx.translate(-s.x, -s.y);
    // Source window = cell's axis-aligned bounds (a little margin for the rotation).
    const half = Math.hypot(bodyLen, bodyW) / 2 + 2;
    const x0 = Math.max(0, s.x - half), y0 = Math.max(0, s.y - half);
    const x1 = s.x + half, y1 = s.y + half;
    ctx.filter = 'invert(1) hue-rotate(180deg)';
    try {
      ctx.drawImage(lensSrc.src, x0 * lensSrc.sx, y0 * lensSrc.sy, (x1 - x0) * lensSrc.sx, (y1 - y0) * lensSrc.sy, x0, y0, x1 - x0, y1 - y0);
    } catch { /* tainted source */ }
    ctx.filter = 'none';
    ctx.restore();
  }
  if (body === 'void') {
    drawVoidBody(ctx, sim, style, lensSrc, t, dpr, glow);
    ctx.restore();
    return;
  }
  // Frame (and lens without a scene to show) — outline the cell. No halo
  // ellipse around frame / lens: the cell alone is the body.
  if (body !== 'lens' || !(lensSrc && lensSrc.src)) {
    ctx.strokeStyle = style.body;
    ctx.lineWidth = Math.max(1, lw * 1.1);
    ctx.strokeRect(-bodyLen / 2, -bodyW / 2, bodyLen, bodyW);
  }
  ctx.fillStyle = style.core;
  ctx.beginPath(); ctx.arc(bodyLen * 0.35, 0, Math.max(1.5, r * 0.035) * (1 + s.bob * 0.6), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ── Void body ───────────────────────────────────────────────────────────────
// The body is an ORB — an ellipse along the heading whose perimeter the hips
// sit on (the sim's 'orb' hip mode) — turned into a gravitational lens:
// inside the outline the raw scene is re-drawn in VOID_RINGS concentric
// elliptical slices, continuous with the stage at the outline (scale 1, no
// twist) and pulled + twisted harder toward a small true-black singularity
// at the centre. Everything is clipped to the orb; the
// outline is stroked on top with a dot at each hip so you can see where the
// legs meet the body. Nothing outside the orb is touched.
// Radii are ellipse scales in BODY space (ctx is already translated +
// rotated to the body); the scene is blitted un-rotated through the clip.
// Cost: VOID_RINGS small drawImage calls of an orb-sized source window.
const VOID = '#010104';
const VOID_RINGS = 7;
const VOID_CORE = 0.18;     // singularity radius, × orb — small; the fade does the work
function drawVoidBody(ctx, sim, style, scene, t, dpr, glow) {
  const s = sim.state, r = s.reach;
  const axes = sim.orbAxes([0, 0]);
  const ax = axes[0], ay = axes[1];
  const half = Math.max(ax, ay) * 2.4 + 2;   // source window (device px), covers the 2.4× pull
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0, 0, ax, ay, 0, 0, Math.PI * 2); ctx.clip();
  if (scene && scene.src) {
    const x0 = Math.max(0, s.x - half), y0 = Math.max(0, s.y - half);
    const x1 = s.x + half, y1 = s.y + half;
    const dir = s.a < 0 ? 1 : -1;
    for (let k = 0; k < VOID_RINGS; k++) {
      // Ring k spans [ri, ro] (× orb) from the outline inward to the core.
      const u0 = k / VOID_RINGS, u1 = (k + 1) / VOID_RINGS;
      const ro = 1 - (1 - VOID_CORE) * u0;
      const ri = 1 - (1 - VOID_CORE) * u1;
      const bend = u1 ** 1.5;                        // 0 at the outline → 1 at the core
      const scale = 1 + 1.4 * bend;                  // pull the scene inward
      const twist = dir * 0.9 * bend * (1 + 0.25 * Math.sin(t * 0.6));
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, ax * ro, ay * ro, 0, 0, Math.PI * 2);
      ctx.ellipse(0, 0, ax * ri, ay * ri, 0, 0, Math.PI * 2);
      ctx.clip('evenodd');
      // Body-space warp, then back to the stage frame for the blit.
      ctx.rotate(twist);
      ctx.scale(scale, scale);
      ctx.rotate(-s.a);
      ctx.translate(-s.x, -s.y);
      try {
        ctx.drawImage(scene.src, x0 * scene.sx, y0 * scene.sy, (x1 - x0) * scene.sx, (y1 - y0) * scene.sy, x0, y0, x1 - x0, y1 - y0);
      } catch { /* tainted source */ }
      ctx.restore();
    }
    // Fade the rings to black toward the centre: fully void by the core
    // radius (so the singularity has no hard edge), easing out to clear at
    // the outline so the rim stays continuous with the stage.
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(1,1,4,1)');
    g.addColorStop(VOID_CORE * 1.1, 'rgba(1,1,4,1)');
    g.addColorStop(0.45, 'rgba(1,1,4,0.72)');
    g.addColorStop(0.75, 'rgba(1,1,4,0.3)');
    g.addColorStop(1, 'rgba(1,1,4,0)');
    ctx.save();
    ctx.scale(ax, ay);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // The singularity.
  ctx.fillStyle = VOID;
  ctx.beginPath(); ctx.ellipse(0, 0, ax * VOID_CORE, ay * VOID_CORE, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();   // orb clip
  // The outline — the orb the legs hang off — with a dot at each hip.
  const lw = Math.max(1, r * 0.022);
  ctx.strokeStyle = style.body;
  ctx.lineWidth = Math.max(1, lw * 1.1);
  ctx.beginPath(); ctx.ellipse(0, 0, ax, ay, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = style.body;
  const hr = Math.max(1.2, r * 0.028);
  const hp = [0, 0];
  for (let n = 0; n < s.legCount; n++) {
    sim.hipLocal(s.feet[n], hp);
    ctx.beginPath(); ctx.arc(hp[0], hp[1], hr, 0, Math.PI * 2); ctx.fill();
  }
}
