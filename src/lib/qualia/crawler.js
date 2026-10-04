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
  body:       'frame',  // frame = outline · lens = inverted window onto the scene · void = scene lensed into a black core
  silk:       true,     // dragline from the spinneret to the last strong grip
  reactivity: 1.0,      // audio response (beat scuttle, bass crouch, highs jitter)
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
const ODD_LEG = { f: -1.05, l: 0.22, hip: -0.42 };
const _layoutCache = new Map();
export function buildLegLayout(n) {
  n = clamp(Math.round(n) || 8, MIN_LEGS, MAX_LEGS);
  if (_layoutCache.has(n)) return _layoutCache.get(n);
  const pairs = n >> 1;
  const L = [];
  for (let i = 0; i < pairs; i++) {
    const t = pairs === 1 ? 0.5 : i / (pairs - 1);
    L.push({ f: 0.95 - 1.73 * t, l: 0.62 + 0.38 * Math.sin(Math.PI * t), hip: 0.42 - 0.72 * t });
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
    jitter: 0,        // highs → leg tremor amplitude (px)
    bob: 0,           // beat-triggered body bounce envelope
    roamX: 0, roamY: 0, roamWait: 0, hasRoam: false,
    silk: { x: 0, y: 0, alive: false, age: 0 },
    feet: [],
  };
  for (let i = 0; i < MAX_LEGS; i++) {
    s.feet.push({
      side: 1, i: 0, group: 0, bend: 1, hipF: 0,
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
      f.swing = false; f.t = 1; f.box.on = false; f.anchored = false;
    }
    plantAll();
  }

  function idealFoot(f, out) {
    const r = s.reach, L = legSpec(f);
    const cx = Math.cos(s.a), sy = Math.sin(s.a);
    const fw = L.f * r, lat = f.side * L.l * r * (1 - s.crouch * 0.15);
    out[0] = s.x + cx * fw - sy * lat;
    out[1] = s.y + sy * fw + cx * lat;
    return out;
  }
  const idealOut = [0, 0];

  function hipOf(f, out) {
    const bodyLen = s.reach * 0.55, bodyW = s.reach * 0.14;
    const cx = Math.cos(s.a), sy = Math.sin(s.a);
    const fw = f.hipF * bodyLen, lat = f.side * bodyW;
    out[0] = s.x + cx * fw - sy * lat;
    out[1] = s.y + sy * fw + cx * lat;
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
    // Faster walking (and beats) → quicker steps.
    f.dur = Math.max(0.07, 0.17 - s.speed / (r * 36)) * (1 - inp.beatPulse * 0.35);
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
    const maxV = s.reach * (1.9 + 0.9 * inp.speed) * inp.speed * (1 + inp.beatPulse * 0.6);
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
      // beat makes the whole creature fidget.
      const idle = s.speed < r * 0.08;
      const settle = idle && off > r * 0.16 && inp.rnd() < dt * (2.0 + inp.beatPulse * 14);
      // Urgent (overstretched) legs may break gait order, but never more
      // than half the legs leave the ground at once — the body always has a
      // stance to stand on, however hard it was yanked.
      const urgent = off > r * 0.75 && (sw0 + sw1) < (s.legCount >> 1);
      const otherGroupDown = (f.group ? sw0 : sw1) === 0;
      if (urgent || ((off > stepDist || settle) && otherGroupDown)) {
        lift(f, ix + s.vx * 0.22, iy + s.vy * 0.22, inp);
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
    setLegs, placeAt, rescale, step, solveLegs, plantAll,
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
 *   glow    soft additive halo gain on the body
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
  // warm core dot. Crouch widens + shortens it a touch, bob scales it.
  const bodyLen = r * 0.55 * (1 - s.crouch * 0.12) * (1 + s.bob * 0.12);
  const bodyW = r * 0.16 * (1 + s.crouch * 0.35) * (1 + s.bob * 0.12);
  ctx.translate(s.x, s.y); ctx.rotate(s.a);
  // Lens body — the pane is a see-through negative of the scene under it
  // (invert flips lightness, hue-rotate 180 brings the hues back, like the
  // negative post), so the creature carries a little null-portal around.
  // Bigger than the frame so there's something to see through.
  if (body === 'lens' && lensSrc && lensSrc.src) {
    const pl = bodyLen * 1.5, pw = bodyW * 3.2;
    ctx.save();
    ctx.beginPath(); ctx.rect(-pl / 2, -pw / 2, pl, pw); ctx.clip();
    // Un-rotate to draw the scene in place, then the clip keeps the pane.
    ctx.rotate(-s.a); ctx.translate(-s.x, -s.y);
    // Source window = pane's axis-aligned bounds (a little margin for the rotation).
    const half = Math.hypot(pl, pw) / 2 + 2;
    const x0 = Math.max(0, s.x - half), y0 = Math.max(0, s.y - half);
    const x1 = s.x + half, y1 = s.y + half;
    ctx.filter = 'invert(1) hue-rotate(180deg)';
    try {
      ctx.drawImage(lensSrc.src, x0 * lensSrc.sx, y0 * lensSrc.sy, (x1 - x0) * lensSrc.sx, (y1 - y0) * lensSrc.sy, x0, y0, x1 - x0, y1 - y0);
    } catch { /* tainted source */ }
    ctx.filter = 'none';
    ctx.restore();
    ctx.strokeStyle = style.body;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.globalAlpha = 0.7;
    ctx.strokeRect(-pl / 2, -pw / 2, pl, pw);
    ctx.globalAlpha = 1;
  }
  if (body === 'void') {
    drawVoidBody(ctx, s, style, lensSrc, bodyLen, bodyW, t, dpr, glow);
    ctx.restore();
    return;
  }
  if (glow > 0.01) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.18 * glow + s.bob * 0.25;
    ctx.fillStyle = style.body;
    ctx.beginPath(); ctx.ellipse(0, 0, bodyLen * 0.9, bodyW * 2.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.strokeStyle = style.body;
  ctx.lineWidth = Math.max(1, lw * 1.1);
  ctx.strokeRect(-bodyLen / 2, -bodyW / 2, bodyLen, bodyW);
  ctx.fillStyle = style.core;
  ctx.beginPath(); ctx.arc(-bodyLen * 0.1, 0, Math.max(1.5, r * 0.035) * (1 + s.bob * 0.6), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ── Void body ───────────────────────────────────────────────────────────────
// An ellipse along the heading that LENSES the scene inside it: the raw scene
// is re-drawn in VOID_RINGS concentric annular slices from the rim (scale 1,
// no twist — continuous with the stage outside) inward, each pulled toward
// the centre and twisted harder than the last (light bending in, frame
// dragging), down to a small true-black singularity at the core with a thin
// photon ring on its edge. Nothing outside the ellipse is touched.
// Radii are ellipse scales in BODY space (ctx is already translated +
// rotated to the body); the scene is blitted un-rotated through the clip.
// Cost: VOID_RINGS small drawImage calls of a (2·body)² source window.
const VOID = '#010104';
const VOID_RINGS = 7;
const VOID_CORE = 0.34;     // singularity radius, × body ellipse
function drawVoidBody(ctx, s, style, scene, bodyLen, bodyW, t, dpr, glow) {
  const ax = bodyLen * 0.95 * (1 + s.bob * 0.15), ay = bodyW * 2.6 * (1 + s.bob * 0.15);
  const half = Math.max(ax, ay) * 1.15 + 2;         // source window half-size (device px)
  if (scene && scene.src) {
    const x0 = Math.max(0, s.x - half), y0 = Math.max(0, s.y - half);
    const x1 = s.x + half, y1 = s.y + half;
    const dir = s.a < 0 ? 1 : -1;
    for (let k = 0; k < VOID_RINGS; k++) {
      // Ring k spans [ri, ro] (× ellipse) from the rim inward to the core.
      const u0 = k / VOID_RINGS, u1 = (k + 1) / VOID_RINGS;
      const ro = 1 - (1 - VOID_CORE) * u0;
      const ri = 1 - (1 - VOID_CORE) * u1;
      const bend = u1 ** 1.5;                        // 0 at the rim → 1 at the core
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
    // Darken toward the core so the rings read as falling in, not tiling.
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(1,1,4,0.85)');
    g.addColorStop(VOID_CORE * 1.4, 'rgba(1,1,4,0.45)');
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
  // Photon ring on the core — hot, in the core colour, flaring on beats —
  // and a hairline at the rim so the lens has an edge.
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = style.core;
  ctx.lineWidth = Math.max(1, dpr) * (1 + s.bob);
  ctx.globalAlpha = 0.45 * glow + s.bob * 0.5;
  ctx.beginPath(); ctx.ellipse(0, 0, ax * VOID_CORE * 1.08, ay * VOID_CORE * 1.1, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = style.joint;
  ctx.lineWidth = Math.max(0.75, dpr * 0.75);
  ctx.globalAlpha = 0.22 * glow;
  ctx.beginPath(); ctx.ellipse(0, 0, ax, ay, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
