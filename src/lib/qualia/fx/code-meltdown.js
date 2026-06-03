// Meltdown engine — the cell/cluster physics behind the Code quale's
// `meltdown` and `tetris` modes. After Andreas Gysin's "Meltdown" (a syntax
// highlighter that highlights its own source while it melts away): tokens are
// laid into a character grid, same-colour neighbours fuse into rigid blocks,
// and those blocks slough off and tumble down, scattering off the walls and
// off the pile they build. The `tetris` variant is a cellular cousin — same
// grid, but matched colour runs clear and everything above cascades down.
//
// Both share one design rule: cost is bounded by the *cell budget*, never by
// the screen. The grid resolution is capped (MAX_CELLS), collisions resolve a
// single cell at a time against integer occupancy grids (no O(n²) body pairs,
// no tunnelling), and the per-frame work is O(occupied cells) — the same order
// as the quale's existing spectrum/heatmap text passes. Nothing here allocates
// per frame in steady state.
//
// The engine reads everything through the args of step()/draw(); it owns no
// globals. Pose is read straight off `field` (mirroring code.js's own headX
// handling) and smoothed internally.

// Token kind → palette key. Connectivity (and Tetris matching) groups by kind,
// which is what makes "similar colours merge and move together".
const KIND_KEYS = ['text', 'kw', 'str', 'num', 'com', 'op', 'punct'];
const KIND_IDX  = { text: 0, kw: 1, str: 2, num: 3, com: 4, op: 5, punct: 6 };

// Deep electric blue, the colour of the original Meltdown's "screen". Tokens
// pop against it far better than any of the dark palette backgrounds do.
const MELT_BG = '#0a0a3e';

const MAX_CELLS = 3500;   // hard ceiling on cols*rows — the whole perf budget
const EMPTY     = -1;     // grid cell: nothing here
const CLEARING  = -2;     // grid cell: matched, flashing white, about to vanish

// Physics constants. Velocities are in CELLS/sec so motion is grid-quantised
// (faithful to the original's blocky melt) and collisions are exact.
const GRAV      = 42;     // gravity, cells/s²
const MAXV      = 46;     // terminal speed, cells/s (≤ ~0.8 cell at 60fps)
const SETTLE    = 4.0;    // below this speed a grounded block comes to rest
const WIND      = 26;     // head-lean → lateral gravity, cells/s²
const WRISTPUSH = 34;     // wrist-spread → outward blast, cells/s²
const FLASH     = 0.06;   // Tetris clear flash duration, seconds

// Single-char string cache for ASCII so fillText never allocates in the hot
// render loop (String.fromCharCode would churn the GC at thousands/frame).
const CHAR_CACHE = new Array(128);
for (let c = 32; c < 127; c++) CHAR_CACHE[c] = String.fromCharCode(c);
function glyph(code) {
  return code >= 32 && code < 127 ? CHAR_CACHE[code] : String.fromCharCode(code);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * @param {Object} args
 * @param {CanvasRenderingContext2D} args.ctx
 * @param {Array<{text:string,header:boolean}>} args.sourceLines
 * @param {(line:string)=>Array<{t:string,s:string}>} args.tokenizeLine
 * @param {string} args.fontFamily
 */
export function createMeltEngine({ ctx, sourceLines, tokenizeLine, fontFamily }) {
  // ── Grid geometry (set by configure) ──────────────────────────────────
  let W = 1, H = 1, fontPx = 14, charW = 9, lineH = 18;
  let cols = 1, rows = 1, originX = 0, originY = 0;
  // Requested inputs (before the cell-budget may shrink fontPx) — the change
  // detector compares against these, not the derived effective values.
  let reqW = -1, reqH = -1, reqFpx = -1;

  // Per-cell seed content. kindCell drives colour + Tetris matching; charCode
  // is the glyph. Reallocated only when the grid size changes.
  let kindCell  = new Int8Array(0);
  let charCode  = new Uint16Array(0);
  let clearTm   = new Float32Array(0);   // Tetris clear-flash timers

  // Settled-pile occupancy for meltdown (clusterIndex+1, 0 = empty air).
  let occ = new Int32Array(0);
  // Transient active-block occupancy, generation-tagged so it never needs
  // clearing: a cell counts as filled only when aGen[idx] === gen.
  let aocc = new Int32Array(0);
  let aGen = new Int32Array(0);
  let gen = 0;

  // Meltdown rigid blocks (colour-connected components). Stable array; settled
  // blocks stay in place with state 'settled'.
  /** @type {Array} */
  let blocks = [];
  let restCount = 0, activeCount = 0, settledCount = 0;
  let meltClock = 0;

  // Tetris bookkeeping.
  let fallAccum = 0, tetrisSpawnAccum = 0, tetrisClearAccum = 0;
  let tetrisBest = 0, tetrisStall = 0;   // saturation tracker for the reset loop

  let mode = 'meltdown';
  let seedCursor = 0;     // advances each reseed so loops show fresh source
  let seeded = false;

  // Smoothed pose scalars (mirrored to match code.js's headX convention).
  let pHeadX = 0, pWrist = 0, pShoulder = 0;

  // ── Geometry / allocation ─────────────────────────────────────────────
  function configure(w, h, fpx) {
    if (w === reqW && h === reqH && fpx === reqFpx && seeded) return;
    reqW = w; reqH = h; reqFpx = fpx;
    W = w; H = h; fontPx = Math.max(8, fpx | 0);

    ctx.font = `${fontPx}px ${fontFamily}`;
    charW = Math.max(5, ctx.measureText('M').width);
    lineH = Math.max(8, Math.round(fontPx * 1.2));

    let c = Math.max(8, Math.floor(W / charW));
    let r = Math.max(8, Math.floor(H / lineH));
    // Hold the cell budget: if a big viewport blows past it, grow the cells
    // (uniformly) until cols*rows fits. Keeps full-bleed, just chunkier blocks.
    if (c * r > MAX_CELLS) {
      const k = Math.sqrt((c * r) / MAX_CELLS);
      charW *= k; lineH = Math.round(lineH * k); fontPx = Math.max(8, Math.round(fontPx / k));
      c = Math.max(8, Math.floor(W / charW));
      r = Math.max(8, Math.floor(H / lineH));
    }
    cols = c; rows = r;
    originX = Math.floor((W - cols * charW) / 2);
    originY = Math.floor((H - rows * lineH) / 2);

    const n = cols * rows;
    if (kindCell.length !== n) {
      kindCell = new Int8Array(n);
      charCode = new Uint16Array(n);
      clearTm  = new Float32Array(n);
      occ  = new Int32Array(n);
      aocc = new Int32Array(n);
      aGen = new Int32Array(n);
    }
    reseed();
  }

  // Write one source line into grid `row`, only into cells that are currently
  // EMPTY (so it never clobbers a settled/falling cell). Returns cells placed.
  function layLine(rec, row) {
    const base = row * cols;
    let placed = 0;
    if (rec.header) {
      // Header bars read as one solid comment-coloured ribbon.
      const t = rec.text;
      for (let col = 0; col < cols && col < t.length; col++) {
        const ch = t.charCodeAt(col);
        if (ch > 32 && kindCell[base + col] === EMPTY) {
          kindCell[base + col] = KIND_IDX.com; charCode[base + col] = ch; placed++;
        }
      }
      return placed;
    }
    const toks = tokenizeLine(rec.text);
    let col = 0;
    for (let ti = 0; ti < toks.length && col < cols; ti++) {
      const k = KIND_IDX[toks[ti].t] ?? 0;
      const s = toks[ti].s;
      for (let si = 0; si < s.length && col < cols; si++) {
        const ch = s.charCodeAt(si);
        if (ch > 32 && kindCell[base + col] === EMPTY) {
          kindCell[base + col] = k; charCode[base + col] = ch; placed++;
        }
        col++;
      }
    }
    return placed;
  }

  // Fill the whole grid from source (meltdown's starting slab).
  function seedGrid() {
    kindCell.fill(EMPTY);
    charCode.fill(0);
    clearTm.fill(0);
    const total = sourceLines.length;
    for (let r = 0; r < rows; r++) {
      layLine(sourceLines[((seedCursor + r) % total + total) % total], r);
    }
  }

  // Drop the next source line into the top row — tetris feeds the stack from
  // here, so the pile grows upward as lines rain in and settle.
  function spawnLineTetris() {
    const total = sourceLines.length;
    const rec = sourceLines[((seedCursor % total) + total) % total];
    seedCursor++;
    layLine(rec, 0);
  }

  function buildBlocks() {
    blocks = [];
    occ.fill(0);
    const n = cols * rows;
    const visited = new Uint8Array(n);
    // Reused BFS frontier (indices). Sized to the grid; never grows per call.
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      const k = kindCell[start];
      if (k < 0 || visited[start]) continue;
      // Flood-fill 4-connected same-kind region.
      let sp = 0;
      stack[sp++] = start;
      visited[start] = 1;
      let minX = cols, minY = rows, maxX = 0, maxY = 0;
      const found = [];
      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % cols, y = (idx / cols) | 0;
        found.push(idx);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        // neighbours
        if (x > 0)        { const j = idx - 1;    if (!visited[j] && kindCell[j] === k) { visited[j] = 1; stack[sp++] = j; } }
        if (x < cols - 1) { const j = idx + 1;    if (!visited[j] && kindCell[j] === k) { visited[j] = 1; stack[sp++] = j; } }
        if (y > 0)        { const j = idx - cols; if (!visited[j] && kindCell[j] === k) { visited[j] = 1; stack[sp++] = j; } }
        if (y < rows - 1) { const j = idx + cols; if (!visited[j] && kindCell[j] === k) { visited[j] = 1; stack[sp++] = j; } }
      }
      const m = found.length;
      const cells = new Int16Array(m * 2);   // (dx,dy) relative to (minX,minY)
      const chars = new Uint16Array(m);
      for (let i = 0; i < m; i++) {
        const idx = found[i];
        cells[2 * i]     = (idx % cols) - minX;
        cells[2 * i + 1] = ((idx / cols) | 0) - minY;
        chars[i]         = charCode[idx];
      }
      blocks.push({
        id: blocks.length,
        kind: k,
        cells, chars, n: m,
        gx0: minX, gy0: minY,          // integer cell origin (top-left of bbox)
        fx: 0, fy: 0,                  // fractional-cell accumulators
        vxc: 0, vyc: 0,                // velocity, cells/sec
        state: mode === 'tetris' ? 'active' : 'rest',
      });
    }
    restCount = mode === 'tetris' ? 0 : blocks.length;
    activeCount = mode === 'tetris' ? blocks.length : 0;
    settledCount = 0;
  }

  function reseed() {
    if (mode === 'meltdown') {
      seedGrid();
      buildBlocks();
    } else {
      // Tetris starts from an EMPTY board and grows upward — lines are fed in
      // from the top by spawnLineTetris() and stack until the pile tops out.
      kindCell.fill(EMPTY);
      charCode.fill(0);
      clearTm.fill(0);
      fallAccum = 0;
      tetrisSpawnAccum = 0;
      tetrisClearAccum = 0;
      tetrisBest = 0;
      tetrisStall = 0;
    }
    meltClock = 0;
    seeded = true;
  }

  // ── Pose smoothing (read straight off the field, like code.js does) ────
  function updatePose(field, dt, poseGain) {
    const p = field.pose?.people?.[0];
    let tHeadX = 0, tWrist = 0, tShoulder = 0;
    if (p && (p.confidence ?? 0) > 0.3) {
      if (p.head && p.head.visibility > 0.3) tHeadX = (1 - p.head.x) * 2 - 1;
      const wL = p.wrists?.l, wR = p.wrists?.r;
      if (wL && wR && wL.visibility > 0.3 && wR.visibility > 0.3) {
        const dx = wR.x - wL.x, dy = wR.y - wL.y;
        tWrist = clamp((Math.hypot(dx, dy) - 0.40) / 0.30, -1, 1);
      }
      const sL = p.shoulders?.l, sR = p.shoulders?.r;
      if (sL && sR && sL.visibility > 0.4 && sR.visibility > 0.4) {
        const dx = sR.x - sL.x, dy = sR.y - sL.y;
        tShoulder = clamp((Math.hypot(dx, dy) - 0.25) / 0.20, -1, 1);
      }
    }
    const a = Math.min(1, dt * 4);
    pHeadX    += (tHeadX - pHeadX) * a;
    pWrist    += (tWrist - pWrist) * a;
    pShoulder += (tShoulder - pShoulder) * a;
    // Scale by the quale's pose master.
    return {
      headX: pHeadX * poseGain,
      wrist: pWrist * poseGain,
      shoulder: pShoulder * poseGain,
    };
  }

  // ── Collision probe ────────────────────────────────────────────────────
  // Would block `b` overlap anything solid if its origin shifted by (ox,oy)?
  // Solid = floor/wall, the settled pile (occ), or another active block
  // (aocc, generation-tagged, self excluded by id).
  function blocked(b, ox, oy) {
    const gx = b.gx0 + ox, gy = b.gy0 + oy;
    const cells = b.cells, n = b.n, self = b.id + 1;
    for (let i = 0; i < n; i++) {
      const cx = gx + cells[2 * i], cy = gy + cells[2 * i + 1];
      if (cy >= rows) return true;            // floor
      if (cx < 0 || cx >= cols) return true;  // walls
      if (cy < 0) continue;                   // above the top: open air
      const idx = cy * cols + cx;
      if (occ[idx] !== 0) return true;
      if (aGen[idx] === gen && aocc[idx] !== self) return true;
    }
    return false;
  }

  function settle(b) {
    b.state = 'settled';
    b.vxc = b.vyc = b.fx = b.fy = 0;
    activeCount--; settledCount++;
    const cells = b.cells, n = b.n, tag = b.id + 1;
    for (let i = 0; i < n; i++) {
      const cx = b.gx0 + cells[2 * i], cy = b.gy0 + cells[2 * i + 1];
      if (cy >= 0 && cy < rows && cx >= 0 && cx < cols) occ[cy * cols + cx] = tag;
    }
  }

  function unsettle(b, vyc, vxc) {
    const cells = b.cells, n = b.n;
    for (let i = 0; i < n; i++) {
      const cx = b.gx0 + cells[2 * i], cy = b.gy0 + cells[2 * i + 1];
      if (cy >= 0 && cy < rows && cx >= 0 && cx < cols) occ[cy * cols + cx] = 0;
    }
    b.state = 'active'; b.vyc = vyc; b.vxc = vxc; b.fx = b.fy = 0;
    settledCount--; activeCount++;
  }

  // ── Meltdown step ──────────────────────────────────────────────────────
  function stepMeltdown(field, params, audio, dt, pose) {
    const meltRate = Math.max(0, params.meltRate ?? 0.6);
    const bounce   = clamp(params.bounce ?? 0.55, 0, 0.96);
    const bass     = audio.bands.bass;
    const beatP    = audio.beat.pulse;
    const beatHit  = audio.beat.active;
    const grav     = GRAV * (0.7 + bass * 0.9);
    const windX    = pose.headX * WIND;
    const scatter  = 4 + bounce * 14;

    // Stamp active blocks into the generation-tagged grid for block↔block hits.
    gen++;
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (b.state !== 'active') continue;
      const cells = b.cells, n = b.n, tag = b.id + 1;
      for (let i = 0; i < n; i++) {
        const cx = b.gx0 + cells[2 * i], cy = b.gy0 + cells[2 * i + 1];
        if (cy >= 0 && cy < rows && cx >= 0 && cx < cols) {
          const idx = cy * cols + cx; aocc[idx] = tag; aGen[idx] = gen;
        }
      }
    }

    // Detach resting blocks (erosion). Lower rows let go first → the slab melts
    // from the bottom up, leaving structured code on top like the original.
    const detachBase = meltRate * 1.4;
    const leanBoost  = 1 + Math.max(0, pose.shoulder) * 0.8;   // lean in → melt faster
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (b.state !== 'rest') continue;
      const rowFrac = b.gy0 / rows;
      let p = detachBase * dt * (0.15 + rowFrac * 1.2) * leanBoost;
      if (beatHit) p += 0.05 * meltRate;
      p += Math.abs(pose.wrist) * meltRate * dt * 0.8;
      if (Math.random() < p) {
        b.state = 'active';
        b.vyc = 2 + Math.random() * 6 + beatP * 12;
        b.vxc = (Math.random() - 0.5) * 6 + windX * 0.04;
        restCount--; activeCount++;
      }
    }

    // Integrate + resolve, one cell at a time (no tunnelling).
    const wristAccel = pose.wrist > 0 ? pose.wrist * WRISTPUSH : 0;
    const cx2 = cols * 0.5;
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      if (b.state !== 'active') continue;

      b.vyc = clamp(b.vyc + grav * dt, -MAXV, MAXV);
      b.vxc = clamp(b.vxc + windX * dt, -MAXV, MAXV);
      if (wristAccel) {                            // hands wide → blast outward
        b.vxc += Math.sign((b.gx0 + 0.5) - cx2) * wristAccel * dt;
      }
      b.fy += b.vyc * dt;
      b.fx += b.vxc * dt;

      // Vertical
      while (b.fy >= 1) {
        if (!blocked(b, 0, 1)) { b.gy0++; b.fy -= 1; }
        else {
          b.fy = 0;
          if (Math.abs(b.vyc) < SETTLE && Math.abs(b.vxc) < SETTLE) { settle(b); break; }
          b.vyc = -b.vyc * bounce;                 // bounce off the pile/floor
          b.vxc += (Math.random() - 0.5) * scatter; // …shooting off at an angle
        }
      }
      if (b.state !== 'active') continue;
      while (b.fy <= -1) {
        if (!blocked(b, 0, -1)) { b.gy0--; b.fy += 1; }
        else { b.fy = 0; b.vyc = -b.vyc * bounce; }
      }
      // Horizontal
      while (b.fx >= 1) {
        if (!blocked(b, 1, 0)) { b.gx0++; b.fx -= 1; }
        else { b.fx = 0; b.vxc = -b.vxc * bounce; b.vyc += (Math.random() - 0.5) * scatter * 0.4; }
      }
      while (b.fx <= -1) {
        if (!blocked(b, -1, 0)) { b.gx0--; b.fx += 1; }
        else { b.fx = 0; b.vxc = -b.vxc * bounce; b.vyc += (Math.random() - 0.5) * scatter * 0.4; }
      }
    }

    // Beat shatter — a strong kick re-launches a few settled blocks upward so
    // the pile never just sits there dead.
    if (beatHit && beatP > 0.45 && settledCount > 0) {
      let launched = 0;
      for (let bi = blocks.length - 1; bi >= 0 && launched < 4; bi--) {
        const b = blocks[bi];
        if (b.state === 'settled' && Math.random() < 0.04) {
          unsettle(b, -(4 + Math.random() * 9), (Math.random() - 0.5) * 10);
          launched++;
        }
      }
    }

    // Loop: reseed once fully melted, or after a long ceiling so it never stalls.
    meltClock += dt;
    if ((restCount === 0 && activeCount === 0) || meltClock > 24) {
      seedCursor += rows;
      reseed();
    }
  }

  // ── Tetris step (cellular: settle, match-clear, cascade) ───────────────
  function stepTetris(field, params, audio, dt, pose) {
    const bass    = audio.bands.bass;
    const beatP   = audio.beat.pulse;
    const midsHit = audio.mids.active;
    // Falling speed in cells/sec, driven by the quale's `scroll speed` knob so
    // the same control sets the pace here as in the scrolling text modes. Audio
    // adds urgency; a beat slams pieces down. Tuned slow by default — a low
    // scroll speed reads as a gentle settling rain.
    const speed = Math.max(0, params.scrollSpeed ?? 0.3);
    const fallSpeed = (1.5 + speed * 12) * (1 + bass * 0.5 + beatP * 1.0);
    fallAccum += dt * fallSpeed;
    let passes = Math.min(6, Math.floor(fallAccum));
    fallAccum -= passes;
    while (passes-- > 0) fallPass();

    // Clear timers (flash → vanish), and tally live occupancy in the same pass.
    const n = cols * rows;
    let occCount = 0;
    for (let i = 0; i < n; i++) {
      const k = kindCell[i];
      if (k === CLEARING) {
        clearTm[i] -= dt;
        if (clearTm[i] <= 0) { kindCell[i] = EMPTY; charCode[i] = 0; }
      } else if (k >= 0) {
        occCount++;
      }
    }

    // Feed fresh lines in from the top so the stack grows upward. Spacing is a
    // few cells (tied to fall speed) so distinct lines rain down rather than a
    // solid wall. layLine only fills EMPTY cells, so a topped-out column simply
    // stops receiving — the rest keep filling until the pile reaches the top.
    // Spacing must exceed the time for a line to fall clear of the top few
    // rows, or the feed jams at the top and the pile builds downward. 2.4 cells
    // of headroom keeps lines raining bottom-up.
    tetrisSpawnAccum += dt;
    const spawnGap = Math.max(0.05, 2.4 / Math.max(1, fallSpeed));
    if (tetrisSpawnAccum >= spawnGap) {
      tetrisSpawnAccum = 0;
      // Stop feeding only when the very top row jams (pile pressed to the top).
      let topFilled = 0;
      for (let x = 0; x < cols; x++) if (kindCell[x] >= 0) topFilled++;
      if (topFilled < cols * 0.95) spawnLineTetris();
    }

    // Clears are rare punctuation, not a balancing mechanism — the feed has to
    // win so the pile climbs to the top. They stay off until the board is
    // well-grown (so the early rise is unobstructed), then fire on a beat but
    // no more often than every 2s (3.5s when silent). Matched colour runs pop
    // and the blocks above cascade down; the stack keeps rising between them.
    tetrisClearAccum += dt;
    const fillFrac = occCount / Math.max(1, n);
    if (fillFrac > 0.6 && tetrisClearAccum >= 2.0 &&
        (audio.beat.active || tetrisClearAccum >= 3.5)) {
      tetrisClearAccum = 0;
      const matchLen = Math.max(4, (params.matchLen ?? 5) - (midsHit ? 1 : 0));
      scanClears(matchLen);
    }

    // Reset on either of two conditions, whichever lands first:
    //
    //   1. Top-out — a wall of the settled pile has reached the top. Judged by
    //      the row beneath the feeder (row 1) being settled (supported by row 2)
    //      across enough columns. Requiring a span of columns, not a single
    //      spike, keeps one tall sliver from resetting a mostly-empty board.
    //   2. Saturation — the pile has stopped reaching new heights for a while
    //      (growth and clears have balanced out). This is the graceful exit
    //      when the board is wider than the source lines, so the mound fills as
    //      far as it can and then recycles instead of sitting forever.
    //
    // seedCursor has already advanced via the spawns, so the refill is fresh.
    meltClock += dt;
    let topped = 0;
    if (rows >= 3) {
      for (let x = 0; x < cols; x++) {
        if (kindCell[cols + x] >= 0 && kindCell[2 * cols + x] >= 0) topped++;
      }
    }
    if (occCount > tetrisBest + Math.max(2, cols * 0.02)) {
      tetrisBest = occCount; tetrisStall = 0;
    } else {
      tetrisStall += dt;
    }
    if (topped >= Math.max(3, cols * 0.5) || tetrisStall > 3.5) reseed();
  }

  // One gravity pass: every cell with empty air directly below drops one row.
  // Bottom-up per column so each cell moves at most one step per pass.
  function fallPass() {
    let moved = false;
    for (let x = 0; x < cols; x++) {
      for (let y = rows - 2; y >= 0; y--) {
        const idx = y * cols + x;
        const k = kindCell[idx];
        if (k < 0) continue;                 // empty or clearing
        const below = idx + cols;
        if (kindCell[below] === EMPTY) {
          kindCell[below] = k; charCode[below] = charCode[idx];
          kindCell[idx] = EMPTY; charCode[idx] = 0;
          moved = true;
        }
      }
    }
    return moved;
  }

  // Mark horizontal and vertical runs of ≥ matchLen same-kind resting cells as
  // clearing. Returns how many cells were marked.
  function scanClears(matchLen) {
    let count = 0;
    // Horizontal
    for (let y = 0; y < rows; y++) {
      let x = 0;
      while (x < cols) {
        const k = kindCell[y * cols + x];
        if (k < 0) { x++; continue; }
        let run = 1;
        while (x + run < cols && kindCell[y * cols + x + run] === k) run++;
        if (run >= matchLen) {
          for (let i = 0; i < run; i++) { const idx = y * cols + x + i; kindCell[idx] = CLEARING; clearTm[idx] = FLASH; }
          count += run;
        }
        x += run;
      }
    }
    // Vertical
    for (let x = 0; x < cols; x++) {
      let y = 0;
      while (y < rows) {
        const k = kindCell[y * cols + x];
        if (k < 0) { y++; continue; }
        let run = 1;
        while (y + run < rows && kindCell[(y + run) * cols + x] === k) run++;
        if (run >= matchLen) {
          for (let i = 0; i < run; i++) { const idx = (y + i) * cols + x; kindCell[idx] = CLEARING; clearTm[idx] = FLASH; }
          count += run;
        }
        y += run;
      }
    }
    return count;
  }

  // ── Public step ────────────────────────────────────────────────────────
  function step(w, h, fpx, field, params, audio, m) {
    if (m !== mode) { mode = m; seeded = false; }
    configure(w, h, fpx);
    const dt = Math.min(field.dt || 0, 0.05);
    if (dt <= 0) return;
    const pose = updatePose(field, dt, params.poseReactivity ?? 1);
    if (mode === 'tetris') stepTetris(field, params, audio, dt, pose);
    else                   stepMeltdown(field, params, audio, dt, pose);
  }

  // ── Render ─────────────────────────────────────────────────────────────
  function draw(palette, params, audio, m) {
    const beatP = audio.beat.pulse;
    // Background: the Meltdown blue, brightened a touch on the kick.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = MELT_BG;
    ctx.fillRect(0, 0, W, H);
    if (beatP > 0.01) {
      ctx.fillStyle = `rgba(80,90,255,${Math.min(0.18, beatP * 0.18)})`;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.font = `${fontPx}px ${fontFamily}`;
    ctx.textBaseline = 'top';
    const colors = [
      palette.text, palette.kw, palette.str, palette.num, palette.com, palette.op, palette.punct,
    ];
    const blockFill = !!params.blockFill;
    const glow = Math.max(0, params.glow ?? 0);

    if (m === 'tetris') drawTetris(colors, blockFill, glow);
    else                drawMeltdown(colors, blockFill, glow);

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function drawMeltdown(colors, blockFill, glow) {
    // Adaptive glow: only afford a shadow when the cell count is modest.
    const cheapGlow = glow > 0 && (cols * rows) < 1600;
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const col = colors[b.kind] || colors[0];
      const ox = originX + b.gx0 * charW;
      const oy = originY + b.gy0 * lineH;
      const cells = b.cells, chars = b.chars, n = b.n;

      if (blockFill) {
        ctx.globalAlpha = 0.20;
        ctx.fillStyle = col;
        for (let i = 0; i < n; i++) {
          ctx.fillRect(ox + cells[2 * i] * charW, oy + cells[2 * i + 1] * lineH, charW + 0.6, lineH + 0.6);
        }
      }
      ctx.globalAlpha = b.state === 'active' ? 1 : (b.state === 'settled' ? 0.85 : 0.95);
      ctx.fillStyle = col;
      if (cheapGlow) { ctx.shadowColor = col; ctx.shadowBlur = 2 + 5 * glow; } else ctx.shadowBlur = 0;
      for (let i = 0; i < n; i++) {
        const code = chars[i];
        if (code) ctx.fillText(glyph(code), ox + cells[2 * i] * charW, oy + cells[2 * i + 1] * lineH);
      }
    }
  }

  function drawTetris(colors, blockFill, glow) {
    ctx.shadowBlur = 0;
    const n = cols * rows;
    for (let idx = 0; idx < n; idx++) {
      const k = kindCell[idx];
      if (k === EMPTY) continue;
      const x = originX + (idx % cols) * charW;
      const y = originY + ((idx / cols) | 0) * lineH;
      if (k === CLEARING) {
        const a = Math.max(0, clearTm[idx] / FLASH);
        ctx.globalAlpha = a;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, charW + 0.6, lineH + 0.6);
        continue;
      }
      const col = colors[k] || colors[0];
      if (blockFill) {
        ctx.globalAlpha = 0.22; ctx.fillStyle = col;
        ctx.fillRect(x, y, charW + 0.6, lineH + 0.6);
      }
      ctx.globalAlpha = 1; ctx.fillStyle = col;
      const code = charCode[idx];
      if (code) ctx.fillText(glyph(code), x, y);
    }
  }

  function dispose() {
    blocks = [];
    kindCell = new Int8Array(0); charCode = new Uint16Array(0); clearTm = new Float32Array(0);
    occ = new Int32Array(0); aocc = new Int32Array(0); aGen = new Int32Array(0);
    seeded = false;
  }

  return { step, draw, dispose };
}
