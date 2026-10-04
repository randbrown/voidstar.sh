// Smoke tests for the crawler layer's pure half (src/lib/qualia/crawler.js):
//   node scripts/check-qualia-crawler.mjs
//
// Only the DOM-free module is imported — IK, feature grid and gait sim. The
// overlay wiring (pointer, pixel sampling, rendering) is exercised in the
// browser. Everything here runs in synthetic device-pixel space.

import {
  solveTwoBone, createFeatureGrid, createCrawlerSim, drawCrawler, CRAWLER_STYLES, CRAWLER_DEFAULTS,
  CRAWLER_COUNTS, CRAWLER_BODIES, CRAWLER_FOLLOW,
} from '../src/lib/qualia/crawler.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Deterministic PRNG so the gait assertions don't flake.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Two-bone IK ─────────────────────────────────────────────────────────────
section('solveTwoBone — analytic two-bone IK');
{
  const out = [0, 0];
  const L1 = 56, L2 = 64;
  // Reachable target: both bone lengths are honoured.
  solveTwoBone(0, 0, 80, 20, L1, L2, 1, out);
  const d1 = Math.hypot(out[0], out[1]);
  const d2 = Math.hypot(80 - out[0], 20 - out[1]);
  check('knee sits at L1 from the hip', near(d1, L1, 1e-6), `${d1}`);
  check('knee sits at L2 from the foot', near(d2, L2, 1e-6), `${d2}`);
  // The bend flag mirrors the knee across the hip→foot ray.
  const a = [0, 0], b = [0, 0];
  solveTwoBone(0, 0, 80, 0, L1, L2, 1, a);
  solveTwoBone(0, 0, 80, 0, L1, L2, -1, b);
  check('bend=±1 mirrors the knee', near(a[0], b[0]) && near(a[1], -b[1]));
  check('bend=+1 pops the knee to +y side', a[1] > 0);
  // Out of reach: straight leg along the ray, no NaN.
  solveTwoBone(0, 0, 500, 0, L1, L2, 1, out);
  check('out-of-reach straightens along the ray', near(out[0], L1) && near(out[1], 0));
  solveTwoBone(10, 10, 10, 10, L1, L2, 1, out);
  check('coincident hip/foot is finite', Number.isFinite(out[0]) && Number.isFinite(out[1]));
}

// ── Feature grid ────────────────────────────────────────────────────────────
section('createFeatureGrid — edge seeking + blob boxes');
{
  const cols = 40, rows = 20;
  const grid = createFeatureGrid(cols, rows);
  grid.cell = 10;   // 400×200 device px
  // Black field with one bright 6×2-cell "word" at cells x 20..25, y 8..9.
  const data = new Uint8ClampedArray(cols * rows * 4);
  for (let y = 8; y <= 9; y++) for (let x = 20; x <= 25; x++) {
    const j = (y * cols + x) * 4; data[j] = data[j + 1] = data[j + 2] = 230; data[j + 3] = 255;
  }
  check('no data before ingest → seek false', grid.seek(100, 100, 50, {}) === false);
  grid.ingest(data);
  check('luma lands in [0,1]', near(grid.luma()[8 * cols + 22], 230 / 255, 1e-6));
  const out = { x: 0, y: 0, score: 0, ix: 0, iy: 0 };
  // Seek from just left of the word, radius covering it — should land on an edge cell of it.
  const hit = grid.seek(170, 85, 80, out);
  check('seek finds the word from nearby', hit === true);
  check('seek lands on the word\'s edge column', hit && (out.ix === 20 || out.ix === 19 || out.ix === 21), `ix=${out.ix} iy=${out.iy}`);
  check('seek returns device px', hit && near(out.x, (out.ix + 0.5) * 10) && near(out.y, (out.iy + 0.5) * 10));
  check('seek over flat black finds nothing', grid.seek(50, 150, 40, out) === false);
  // Blob bbox of the word.
  const box = { x: 0, y: 0, w: 0, h: 0 };
  check('blob from a bright cell → true', grid.blob(22, 8, box) === true);
  check('blob box spans the word (x)', near(box.x, 200) && near(box.w, 60), `x=${box.x} w=${box.w}`);
  check('blob box spans the word (y)', near(box.y, 80) && near(box.h, 20), `y=${box.y} h=${box.h}`);
  check('blob from a dark cell → false', grid.blob(2, 2, box) === false);
  // Blob cap: a full-width bright band must not produce a screen-wide box.
  const band = new Uint8ClampedArray(cols * rows * 4);
  for (let y = 5; y <= 6; y++) for (let x = 0; x < cols; x++) {
    const j = (y * cols + x) * 4; band[j] = band[j + 1] = band[j + 2] = 255; band[j + 3] = 255;
  }
  grid.ingest(band);
  grid.blob(20, 5, box);
  check('blob width is capped', box.w <= 29 * 10, `w=${box.w}`);
  // Resize re-allocates and clears.
  grid.resize(10, 5);
  check('resize updates dims + clears data', grid.cols === 10 && grid.rows === 5 && grid.hasData === false);
}

// ── Sim: steering + gait ────────────────────────────────────────────────────
section('createCrawlerSim — steering, gait, anchoring');
function makeInput(over = {}) {
  return {
    W: 1600, H: 900, tx: 800, ty: 450, hasTarget: true,
    reach: 72, speed: 1, stride: CRAWLER_DEFAULTS.stride,
    anchor: 0, boxes: 0, silk: false, grid: null,
    beatPulse: 0, beatActive: false, bass: 0, highs: 0, rnd: mulberry32(7),
    ...over,
  };
}
function run(sim, inp, seconds, dt = 1 / 60, onFrame = null) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) { sim.step(dt, inp); if (onFrame) onFrame(i); }
}
{
  const sim = createCrawlerSim();
  sim.setLegs(8);
  sim.placeAt(200, 200);
  const st = sim.state;
  check('8 legs laid out, 4 per side', st.legCount === 8 && st.feet.slice(0, 8).filter(f => f.side < 0).length === 4);
  check('gait groups split 4/4', st.feet.slice(0, 8).filter(f => f.group === 0).length === 4);
  check('adjacent legs on one side alternate groups',
    st.feet[0].group !== st.feet[1].group && st.feet[1].group !== st.feet[2].group);
  check('mirror legs alternate groups', st.feet[0].group !== st.feet[4].group);

  // Walk to a far target: it must arrive, legs must step, never all at once.
  const inp = makeInput({ tx: 1200, ty: 600 });
  let steps = 0, maxSwing = 0, bothGroupsSwung = false, nan = false;
  let prevSwing = new Array(8).fill(false);
  run(sim, inp, 6, 1 / 60, () => {
    let sw = 0, g0 = 0, g1 = 0;
    for (let k = 0; k < 8; k++) {
      const f = st.feet[k];
      if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.kx)) nan = true;
      if (f.swing) { sw++; if (f.group) g1++; else g0++; }
      if (f.swing && !prevSwing[k]) steps++;
      prevSwing[k] = f.swing;
    }
    if (g0 > 0 && g1 > 0) bothGroupsSwung = true;
    if (sw > maxSwing) maxSwing = sw;
  });
  check('no NaN in body/feet/knees', !nan);
  check('body arrives near the target', Math.hypot(st.x - 1200, st.y - 600) < 72 * 0.5, `${st.x.toFixed(1)},${st.y.toFixed(1)}`);
  check('legs stepped while walking', steps > 20, `${steps}`);
  check('never all eight legs in the air', maxSwing <= 6, `${maxSwing}`);
  // Planted feet stay within reach of their hips (IK stays solvable).
  const hip = [0, 0];
  let overReach = 0;
  for (let k = 0; k < 8; k++) {
    const f = st.feet[k];
    sim.hipOf(f, hip);
    if (Math.hypot(f.x - hip[0], f.y - hip[1]) > 72 * 1.2 + 1e-6) overReach++;
  }
  check('feet end within L1+L2 of their hips', overReach === 0, `${overReach} over`);
  // Heading follows the direction of travel (toward +x,+y → angle ≈ atan2(400,1000)).
  check('heading turned toward travel', Math.abs(((st.a - Math.atan2(400, 1000)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) < 0.6, `${st.a}`);

  // Standing still: body settles, speed → ~0, idle shuffles don't blow up.
  run(sim, inp, 3);
  check('settles when it arrives', st.speed < 72 * 0.05, `${st.speed}`);

  // Target clamped to the stage: an off-stage target can't drag the body out.
  const far = makeInput({ tx: -500, ty: -500 });
  run(sim, far, 6);
  check('body stays inside the stage margin', st.x >= 0 && st.y >= 0, `${st.x},${st.y}`);

  // Wander mode (no target) keeps moving and picks roam points inside bounds.
  const wander = makeInput({ hasTarget: false });
  let moved = 0, lastX = st.x, lastY = st.y;
  run(sim, wander, 8, 1 / 60, () => { moved += Math.hypot(st.x - lastX, st.y - lastY); lastX = st.x; lastY = st.y; });
  check('wanders without a target', moved > 200, `${moved.toFixed(0)}px`);
  check('roam point stays in bounds', st.roamX >= 0 && st.roamX <= 1600 && st.roamY >= 0 && st.roamY <= 900);

  // 6 legs: relayout plants everything, groups still alternate.
  sim.setLegs(6);
  check('6-leg layout', st.legCount === 6 && st.feet.slice(0, 6).every(f => !f.swing));
  check('6-leg tripod groups 3/3', st.feet.slice(0, 6).filter(f => f.group === 0).length === 3);
  sim.setLegs(9);
  check('leg count clamps high → 8', st.legCount === 8);
  sim.setLegs(2);
  check('leg count clamps low → 4', st.legCount === 4);
  sim.setLegs('7');
  check('string leg count parses', st.legCount === 7);
}

// Odd leg counts: pairs + one trailing unpaired leg; the walk still holds.
section('odd leg counts (5 / 7)');
for (const n of [5, 7]) {
  const sim = createCrawlerSim();
  sim.setLegs(n); sim.placeAt(200, 450);
  const st = sim.state;
  const legs = st.feet.slice(0, n);
  const odd = legs.filter(f => f.i < 0);
  check(`${n} legs: exactly one unpaired leg`, odd.length === 1 && legs.filter(f => f.side < 0).length === (n >> 1));
  check(`${n} legs: odd leg trails behind the body`, (() => { const o = [0, 0]; sim.idealFoot(odd[0], o); return o[1] > st.y + 20; })());   // fresh sims face up (−π/2), so behind is +y
  const g0 = legs.filter(f => f.group === 0).length;
  check(`${n} legs: gait groups split ${Math.floor(n / 2)}/${Math.ceil(n / 2)}`, Math.abs(g0 - (n - g0)) === 1, `${g0}/${n - g0}`);
  let nan = false, maxSwing = 0;
  run(sim, makeInput({ tx: 1300, ty: 500 }), 6, 1 / 60, () => {
    let sw = 0;
    for (let k = 0; k < n; k++) { const f = st.feet[k]; if (!Number.isFinite(f.x) || !Number.isFinite(f.kx)) nan = true; if (f.swing) sw++; }
    if (sw > maxSwing) maxSwing = sw;
  });
  check(`${n} legs: walks without NaN`, !nan && Math.hypot(st.x - 1300, st.y - 500) < 72 * 0.5);
  check(`${n} legs: a stance always remains`, maxSwing < n, `${maxSwing}`);
}

// Anchoring: with a grid carrying one bright feature, feet landing nearby
// snap onto it and box it.
section('anchoring onto image features');
{
  const cols = 160, rows = 90;
  const grid = createFeatureGrid(cols, rows);
  grid.cell = 10;   // 1600×900
  const data = new Uint8ClampedArray(cols * rows * 4);
  // A grid of bright "glyph" cells every 6 cells so most landings have an edge within reach.
  for (let y = 0; y < rows; y += 6) for (let x = 0; x < cols; x += 6) {
    for (let yy = y; yy < y + 2 && yy < rows; yy++) for (let xx = x; xx < x + 3 && xx < cols; xx++) {
      const j = (yy * cols + xx) * 4; data[j] = data[j + 1] = data[j + 2] = 240; data[j + 3] = 255;
    }
  }
  grid.ingest(data);
  const sim = createCrawlerSim();
  sim.setLegs(8);
  sim.placeAt(200, 450);
  const st = sim.state;
  const inp = makeInput({ tx: 1300, ty: 450, anchor: 1, boxes: 1, silk: true, grid });
  let anchoredLandings = 0, landings = 0, boxed = 0;
  const prev = new Array(8).fill(false);
  run(sim, inp, 6, 1 / 60, () => {
    for (let k = 0; k < 8; k++) {
      const f = st.feet[k];
      if (prev[k] && !f.swing) { landings++; if (f.anchored) anchoredLandings++; if (f.box.on) boxed++; }
      prev[k] = f.swing;
    }
  });
  check('landings happened', landings > 10, `${landings}`);
  check('most landings anchored to a feature', anchoredLandings >= landings * 0.6, `${anchoredLandings}/${landings}`);
  check('anchored landings carry a box', boxed >= anchoredLandings * 0.8, `${boxed}/${anchoredLandings}`);
  // Anchored feet sit on bright cells (centre of a glyph cell).
  let onGlyph = 0, anchoredNow = 0;
  for (let k = 0; k < 8; k++) {
    const f = st.feet[k];
    if (!f.anchored || f.swing) continue;
    anchoredNow++;
    const ix = Math.floor(f.x / 10), iy = Math.floor(f.y / 10);
    // Edge cells of a glyph are within one cell of a bright cell.
    let bright = false;
    for (let dy = -1; dy <= 1 && !bright; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = ix + dx, yy = iy + dy;
      if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue;
      if (grid.luma()[yy * cols + xx] > 0.5) { bright = true; break; }
    }
    if (bright) onGlyph++;
  }
  check('anchored feet rest on glyph edges', anchoredNow === 0 || onGlyph === anchoredNow, `${onGlyph}/${anchoredNow}`);
  check('dragline pinned at some point', st.silk.alive || st.silk.age > 0);
  // anchor=0 → never anchored.
  const plain = createCrawlerSim();
  plain.setLegs(8); plain.placeAt(200, 450);
  run(plain, makeInput({ tx: 1300, ty: 450, anchor: 0, boxes: 1, grid }), 4);
  check('anchor=0 ignores the grid', plain.state.feet.slice(0, 8).every(f => !f.anchored && !f.box.on));
}

// Audio: beat pulse quickens steps; bass raises crouch smoothly (no snap).
section('audio response');
{
  const sim = createCrawlerSim();
  sim.setLegs(8); sim.placeAt(200, 450);
  const st = sim.state;
  run(sim, makeInput({ tx: 1300, ty: 450, bass: 1 }), 0.05);
  check('crouch eases in (not instant)', st.crouch > 0 && st.crouch < 0.9, `${st.crouch}`);
  run(sim, makeInput({ tx: 1300, ty: 450, bass: 1 }), 2);
  check('crouch converges toward bass', st.crouch > 0.7, `${st.crouch}`);
  sim.step(1 / 60, makeInput({ tx: 1300, ty: 450, beatActive: true, beatPulse: 1 }));
  check('beat kicks the bob envelope', st.bob > 0.5, `${st.bob}`);
  run(sim, makeInput({ tx: 1300, ty: 450 }), 1);
  check('bob decays', st.bob < 0.05, `${st.bob}`);
  // Zero / negative dt is a no-op.
  const x = st.x;
  sim.step(0, makeInput()); sim.step(-1, makeInput()); sim.step(NaN, makeInput());
  check('non-positive dt is ignored', st.x === x);
}

// Logo latch: a grip rect pulls landings onto its perimeter.
section('grip rect (logo latch)');
{
  const sim = createCrawlerSim();
  sim.setLegs(8); sim.placeAt(200, 450);
  const st = sim.state;
  const gripRect = { x: 700, y: 350, w: 200, h: 200 };
  // Walk to the rect centre: feet near it must latch onto an edge, never land inside.
  const inp = makeInput({ tx: 800, ty: 450, anchor: 0, boxes: 1, gripRect });
  let gripped = 0, inside = 0, variants = new Set();
  run(sim, inp, 6, 1 / 60, () => {
    for (let k = 0; k < 8; k++) {
      const f = st.feet[k];
      if (f.swing) continue;
      if (f.grip) {
        gripped++;
        variants.add(f.variant);
        const onEdge = near(f.x, 700, 1e-6) || near(f.x, 900, 1e-6) || near(f.y, 350, 1e-6) || near(f.y, 550, 1e-6);
        if (!onEdge) inside++;
        if (!f.box.on || f.box.w !== 200) inside++;
      }
    }
  });
  check('feet latched onto the rect', gripped > 50, `${gripped}`);
  check('latched feet sit on the perimeter and box the mark', inside === 0, `${inside} off`);
  check('variants assigned on anchored landings', variants.size >= 1 && [...variants].every(v => v >= 0 && v < 4));
  // Far from the rect nothing latches.
  const far = createCrawlerSim();
  far.setLegs(8); far.placeAt(200, 450);
  run(far, makeInput({ tx: 250, ty: 450, anchor: 0, boxes: 1, gripRect }), 3);
  check('no latch out of reach', far.state.feet.slice(0, 8).every(f => !f.grip));
}

section('orb hips (void body)');
{
  const sim = createCrawlerSim(); sim.setLegs(8); sim.placeAt(500, 500);
  const st = sim.state;
  sim.setHipMode('orb');
  const ax = sim.orbAxes([0, 0]);
  let off = 0;
  const hp = [0, 0];
  for (let k = 0; k < 8; k++) {
    sim.hipLocal(st.feet[k], hp);
    const e = (hp[0] / ax[0]) ** 2 + (hp[1] / ax[1]) ** 2;   // 1 on the ellipse
    if (Math.abs(e - 1) > 1e-6) off++;
  }
  check('orb hips sit on the ellipse perimeter', off === 0, `${off} off`);
  // Even spacing: sorted hip angles are 2π/n apart (also for odd counts).
  for (const n of [8, 7, 5]) {
    const sm = createCrawlerSim(); sm.setLegs(n); sm.setHipMode('orb');
    const angs = sm.state.feet.slice(0, n).map(f => ((f.ang % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
    let maxGapErr = 0;
    for (let k = 0; k < n; k++) { const gap = (angs[(k + 1) % n] - angs[k] + Math.PI * 2) % (Math.PI * 2); maxGapErr = Math.max(maxGapErr, Math.abs(gap - Math.PI * 2 / n)); }
    check(`${n} legs evenly spaced around the orb`, maxGapErr < 1e-9, `${maxGapErr}`);
    if (n & 1) check(`${n} legs: odd leg points straight back`, sm.state.feet.slice(0, n).some(f => f.i < 0 && near(f.ang, Math.PI)));
  }
  check('front legs hip forward, rear legs hip back', (() => { sim.hipLocal(st.feet[0], hp); const fx = hp[0]; sim.hipLocal(st.feet[3], hp); return fx > 0 && hp[0] < 0; })());
  run(sim, makeInput({ tx: 1200, ty: 500 }), 5);
  const hip = [0, 0];
  let over = 0;
  for (let k = 0; k < 8; k++) { const f = st.feet[k]; sim.hipOf(f, hip); if (Math.hypot(f.x - hip[0], f.y - hip[1]) > 72 * 1.2 + 1e-6) over++; }
  check('orb walk keeps feet within reach of their hips', over === 0 && Math.hypot(st.x - 1200, st.y - 500) < 36, `${over} over`);
  sim.setHipMode('cell');
  sim.hipLocal(st.feet[0], hp);
  check('cell hips back on the slim rect', near(Math.abs(hp[1]), 72 * 0.14));
}

section('enums + renderer smoke');
{
  check('counts enum', CRAWLER_COUNTS.join() === '1,2,3,4,pose');
  check('bodies enum', CRAWLER_BODIES.join() === 'frame,lens,void');
  check('follow enum has logo', CRAWLER_FOLLOW.includes('logo'));
  // Renderer smoke: every body mode runs against a recording fake ctx with a
  // fake scene, balances save/restore, and the void body clips + fills.
  const sim = createCrawlerSim(); sim.setLegs(7); sim.placeAt(300, 300);
  run(sim, makeInput({ tx: 600, ty: 300, anchor: 1, boxes: 1, grid: (() => { const g = createFeatureGrid(40, 20); g.cell = 10; const d = new Uint8ClampedArray(40 * 20 * 4); for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = ((i >> 2) % 7 === 0) ? 255 : 0; d[i + 3] = 255; } g.ingest(d); return g; })() }), 2);
  for (const body of ['frame', 'lens', 'void']) {
    const calls = [];
    const fakeCtx = new Proxy({}, {
      get: (_, k) => (k === 'canvas' ? {} : (...a) => { calls.push(String(k)); return /^create.*Gradient$/.test(String(k)) ? { addColorStop() {} } : undefined; }),
      set: () => true,
    });
    let threw = null;
    try { drawCrawler(fakeCtx, sim, CRAWLER_STYLES.reel, { body, scene: { src: {}, sx: 1, sy: 1 }, rawScene: { src: {}, sx: 1, sy: 1 }, reblit: 0.8, boxes: 0.8 }); } catch (e) { threw = e; }
    const saves = calls.filter(c => c === 'save').length, restores = calls.filter(c => c === 'restore').length;
    check(`${body} body renders without throwing`, !threw, String(threw));
    check(`${body} body balances save/restore`, saves === restores, `${saves}/${restores}`);
    if (body === 'void') check('void body clips rings + fills the horizon', calls.includes('clip') && calls.includes('ellipse') && calls.includes('fill') && calls.includes('drawImage'));
    if (body === 'lens') check('lens body draws the scene through a clip', calls.includes('clip') && calls.includes('drawImage'));
  }
}

// Rescale keeps relative placement.
section('rescale');
{
  const sim = createCrawlerSim();
  sim.setLegs(8); sim.placeAt(400, 300);
  sim.rescale(2, 0.5);
  check('body rescaled', sim.state.x === 800 && sim.state.y === 150);
  check('feet rescaled', near(sim.state.feet[0].x, 2 * (sim.state.feet[0].fromX / 2)));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall crawler checks passed');
process.exit(failed ? 1 : 0);
