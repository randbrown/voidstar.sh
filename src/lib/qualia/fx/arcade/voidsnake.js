// VOIDSNAKE — the snake genre, voidstar-skinned. A ribbon of light threads a
// neon grid swallowing code-glyph pellets and growing longer with each. The
// crowd or performer nudges the heading; otherwise it DRIVES ITSELF with a
// survival AI that never traps itself (the same "never dies in attract" bar the
// other cabinets hold): it seeks the pellet only when a flood-fill confirms the
// move still leaves room for the whole body, otherwise it follows its own tail
// into open space. A suicidal player nudge (straight into a wall or its body) is
// simply ignored, so the ribbon glides forever — an ambient, meditative crawl.

const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];   // up, down, left, right
const FLAVOR = ['0', ';', '/', '%', '*'];          // code-look pellet glyphs

export default function create(eng) {
  const COLS = 23, ROWS = 15, N = COLS * ROWS;
  // Body as a ring buffer of cell indices (head at `head`, growing backwards).
  // occ[] marks occupied cells for O(1) collision. No per-step allocation.
  const body = new Int16Array(N);    // cell indices, body[headPtr] = head
  const occ = new Uint8Array(N);     // 1 = a body segment sits here
  let headPtr = 0, len = 0;
  let dx = 1, dy = 0;                 // current heading
  let food = 0, foodGlyph = 0;
  let stepAcc = 0, score = 0, best = 0, t = 0, eatPop = 0, deaths = 0;
  let grow = 0;                       // pending growth segments
  let pendDx = 0, pendDy = 0;         // player's quantized 4-way intent this step

  let lastAudio = null;
  const parts = eng.createParticles(80);

  // ── preallocated AI scratch ───────────────────────────────────────────────
  const foodDist = new Int16Array(N);   // BFS distance field from the pellet
  const visited = new Int32Array(N);    // flood-fill stamp (stamped, not cleared)
  const queue = new Int16Array(N);
  let stamp = 1;                        // monotonic flood stamp → cheap "clear"
  let aiDx = 1, aiDy = 0;

  const ci = (c, r) => r * COLS + c;
  const cx = (i) => i % COLS;
  const cy = (i) => (i / COLS) | 0;
  const inBounds = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS;

  // Tail cell (the segment that will vacate next step). The body ring runs from
  // headPtr backwards `len` slots (wrapping).
  function tailIndex() { return body[((headPtr - (len - 1)) % N + N) % N]; }

  function placeFood() {
    // Pick a random EMPTY cell. Board is never full when this is called (a soft
    // reset fires well before), so a bounded scan from a random start finds one.
    let start = (Math.random() * N) | 0;
    for (let k = 0; k < N; k++) {
      const i = (start + k) % N;
      if (!occ[i]) { food = i; foodGlyph = (Math.random() * FLAVOR.length) | 0; return; }
    }
    food = 0;
  }

  function spawnSnake() {
    occ.fill(0);
    len = 3; headPtr = len - 1;
    const r = ROWS >> 1, c = 4;
    // lay 3 segments left→right, head at the right
    for (let k = 0; k < len; k++) { const i = ci(c - (len - 1) + k, r); body[k] = i; occ[i] = 1; }
    dx = 1; dy = 0; aiDx = 1; aiDy = 0; grow = 0;
    placeFood();
  }

  function reset() {
    spawnSnake();
    score = 0; best = 0; stepAcc = 0; t = 0; eatPop = 0; deaths = 0;
    parts.clear();
  }

  // BFS over free cells from the pellet, filling foodDist (steps to reach each
  // cell). Body cells are walls EXCEPT `tail` (the cell that vacates this step;
  // -1 while the snake is growing and the tail stays put), so the field stays
  // solvable when the snake is chasing its own tail.
  function bfsFood(tail) {
    foodDist.fill(-1);
    let qh = 0, qt = 0;
    foodDist[food] = 0; queue[qt++] = food;
    while (qh < qt) {
      const cur = queue[qh++];
      const c = cx(cur), r = cy(cur), nd = foodDist[cur] + 1;
      for (let k = 0; k < 4; k++) {
        const nc = c + DIRS[k][0], nr = r + DIRS[k][1];
        if (!inBounds(nc, nr)) continue;
        const ni = ci(nc, nr);
        if (foodDist[ni] !== -1) continue;
        if (occ[ni] && ni !== tail) continue;
        foodDist[ni] = nd; queue[qt++] = ni;
      }
    }
  }

  // Count reachable free cells from `startI` (flood fill). The tail cell is
  // passable (it vacates). Used to reject moves that would box the snake in.
  function floodFree(startI, tail) {
    if (occ[startI] && startI !== tail) return 0;
    const s = ++stamp;
    let qh = 0, qt = 0, n = 0;
    visited[startI] = s; queue[qt++] = startI;
    while (qh < qt) {
      const cur = queue[qh++]; n++;
      const c = cx(cur), r = cy(cur);
      for (let k = 0; k < 4; k++) {
        const nc = c + DIRS[k][0], nr = r + DIRS[k][1];
        if (!inBounds(nc, nr)) continue;
        const ni = ci(nc, nr);
        if (visited[ni] === s) continue;
        if (occ[ni] && ni !== tail) continue;
        visited[ni] = s; queue[qt++] = ni;
      }
    }
    return n;
  }

  // Decide the autopilot heading. Seek the pellet when a candidate keeps enough
  // open space for the whole body (survival gate); otherwise follow the tail
  // into the most open region. Writes aiDx/aiDy. `tail` is the passable tail
  // cell (or -1 while growing).
  function autopilot(tail) {
    const head = body[headPtr], hc = cx(head), hr = cy(head);
    bfsFood(tail);
    let bestSafeD = 1e9, safeDx = 0, safeDy = 0, haveSafe = false;
    let bestFs = -1, fsDx = aiDx, fsDy = aiDy, haveAny = false;
    for (let k = 0; k < 4; k++) {
      const ox = DIRS[k][0], oy = DIRS[k][1];
      if (ox === -dx && oy === -dy) continue;          // no reversing
      const nc = hc + ox, nr = hr + oy;
      if (!inBounds(nc, nr)) continue;
      const ni = ci(nc, nr);
      if (occ[ni] && ni !== tail) continue;            // would hit body → skip
      const fs = floodFree(ni, tail);
      // Tail-reachability invariant: a move is only "safe" if the snake can still
      // reach its own tail from the new head — i.e. it can always follow its tail
      // out and never seals itself into a pocket. floodFree just stamped `visited`
      // with the latest `stamp`, so the tail is reachable iff it was visited.
      const tailOk = tail < 0 || visited[tail] === stamp;
      if (fs > bestFs) { bestFs = fs; fsDx = ox; fsDy = oy; haveAny = true; }
      const d = foodDist[ni];
      // safe = leaves room for the whole body AND keeps the tail reachable.
      if (fs >= len + 1 && tailOk) {
        const reachD = d >= 0 ? d : 1e6;               // reachable food preferred
        if (reachD < bestSafeD) { bestSafeD = reachD; safeDx = ox; safeDy = oy; haveSafe = true; }
      }
    }
    if (haveSafe) { aiDx = safeDx; aiDy = safeDy; }
    else if (haveAny) { aiDx = fsDx; aiDy = fsDy; }    // no safe-to-food move → most open
    // else: fully boxed — keep heading; the step will trigger a soft reset.
  }

  function softReset() {
    // A trap (should be vanishingly rare) → a gentle respawn, not a harsh game
    // over. Burst the old ribbon into particles for a soft visual beat.
    const head = body[headPtr];
    for (let k = 0; k < 10; k++) {
      const a = Math.random() * 6.28, sp = 20 + Math.random() * 50;
      parts.spawn((cx(head) + 0.5), (cy(head) + 0.5), Math.cos(a) * sp, Math.sin(a) * sp, 0.4, eng.C.green, 2);
    }
    deaths++;
    if (score > best) best = score;
    spawnSnake();
  }

  function step() {
    const realTail = tailIndex();
    // The tail vacates this step only when NOT growing; while growing it stays
    // put, so it's a wall for both the AI and collision (passTail = -1).
    const passTail = grow > 0 ? -1 : realTail;
    autopilot(passTail);
    // Resolve heading: a STRONG player lean overrides the AI, but only toward a
    // non-reversing, non-suicidal cell — leaning into a wall/body is ignored so
    // the ribbon never dies to a bad nudge.
    let ndx = aiDx, ndy = aiDy;
    const head = body[headPtr], hc = cx(head), hr = cy(head);
    if (pendDx || pendDy) {
      const nc = hc + pendDx, nr = hr + pendDy;
      const rev = pendDx === -dx && pendDy === -dy;
      if (!rev && inBounds(nc, nr)) {
        const ni = ci(nc, nr);
        if (!occ[ni] || ni === passTail) { ndx = pendDx; ndy = pendDy; }
      }
    }
    dx = ndx; dy = ndy;
    const nc = hc + dx, nr = hr + dy;
    if (!inBounds(nc, nr)) { softReset(); return; }
    const ni = ci(nc, nr);
    const willEat = ni === food;
    if (occ[ni] && ni !== passTail) { softReset(); return; }
    // Advance: keep the tail while growing (snake lengthens), else vacate it.
    if (grow > 0) { grow--; len = Math.min(N - 1, len + 1); }
    else { occ[realTail] = 0; }
    headPtr = (headPtr + 1) % N;
    body[headPtr] = ni; occ[ni] = 1;
    if (willEat) {
      score += 10; eatPop = 1; grow += 2;             // grow 2 cells per pellet
      eng.shake(1.2);
      for (let k = 0; k < 8; k++) {
        const a = Math.random() * 6.28, sp = 16 + Math.random() * 40;
        parts.spawn(cx(ni) + 0.5, cy(ni) + 0.5, Math.cos(a) * sp, Math.sin(a) * sp, 0.35, eng.C.gold, 1);
      }
      if (len >= N - 4) { if (score > best) best = score; spawnSnake(); }  // board ~full → soft win/reset
      else placeFood();
    }
  }

  function update(dt, intent, audio, params) {
    lastAudio = audio;
    t += dt;
    if (eatPop > 0) eatPop -= dt * 3;
    // Quantize the strong lean into a 4-way intent for the next step.
    pendDx = pendDy = 0;
    const lean = Math.max(Math.abs(intent.x), Math.abs(intent.y));
    const strong = lean > (0.2 + intent.autonomy * 0.6);
    if (strong) {
      if (Math.abs(intent.x) >= Math.abs(intent.y)) pendDx = Math.sign(intent.x) | 0;
      else pendDy = Math.sign(intent.y) | 0;
    }
    // Step cadence — ambient/gentle, nudged a little by the beat + intensity.
    const intensity = (params.enemyIntensity ?? 1);
    const cellsPerSec = 5.5 * (0.85 + intensity * 0.25) * (1 + audio.beat.pulse * 0.25);
    const interval = 1 / Math.max(1, cellsPerSec);
    stepAcc += dt;
    let guard = 0;
    while (stepAcc >= interval && guard++ < 4) { stepAcc -= interval; step(); }
    parts.update(dt, 0, 0.9);
    if (score > best) best = score;
  }

  function geom() {
    const vw = eng.vw, vh = eng.vh, top = 9;
    const tile = Math.max(3, Math.floor(Math.min((vh - top - 2) / ROWS, vw / COLS)));
    const ox = Math.floor((vw - COLS * tile) / 2);
    const oy = top + Math.floor((vh - top - ROWS * tile) / 2);
    return { tile, ox, oy };
  }

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    eng.clear('#04040e');
    const g = geom();
    const audio = lastAudio;
    const spectrum = audio && audio.spectrum;
    // Field backdrop + faint grid so the ribbon reads against the void.
    eng.rect(g.ox, g.oy, COLS * g.tile, ROWS * g.tile, '#070a1a', 1);
    for (let c = 0; c <= COLS; c++) eng.rect(g.ox + c * g.tile, g.oy, 1, ROWS * g.tile, '#101830', 0.5);
    for (let r = 0; r <= ROWS; r++) eng.rect(g.ox, g.oy + r * g.tile, COLS * g.tile, 1, '#101830', 0.5);
    eng.box(g.ox, g.oy, COLS * g.tile, ROWS * g.tile, eng.C.cyan, 0.45);
    // Subtle VFD spectrum glow along the bottom grid rows — like a green CRT.
    if (spectrum) {
      const fieldW = COLS * g.tile;
      for (let r = 0; r < 3; r++) {
        const ry = g.oy + (ROWS - 1 - r) * g.tile + g.tile * 0.5;
        eng.spectrumRow(spectrum, g.ox, ry, fieldW, eng.C.green, 0.08 + r * 0.03, 2);
      }
    }

    // Pellet — a pulsing code glyph with a soft disc glow.
    const fcx = g.ox + (cx(food) + 0.5) * g.tile, fcy = g.oy + (cy(food) + 0.5) * g.tile;
    const pulse = 0.6 + 0.4 * Math.sin(t * 6);
    eng.disc(fcx, fcy, 1 + pulse * 1.4, eng.C.gold, 0.22);
    eng.text(FLAVOR[foodGlyph], fcx, fcy - 2, eng.C.gold, 1, 'center', pulse);

    // Snake — head bright, body fading toward the tail; gold flash on eat.
    for (let k = 0; k < len; k++) {
      const i = body[((headPtr - k) % N + N) % N];
      const x = g.ox + cx(i) * g.tile, y = g.oy + cy(i) * g.tile;
      const f = k / Math.max(1, len);
      const isHead = k === 0;
      const col = isHead ? (eatPop > 0 ? eng.C.gold : eng.C.green)
                         : (k & 1 ? '#3ad17a' : '#2ea866');
      eng.rect(x + 1, y + 1, g.tile - 2, g.tile - 2, col, isHead ? 1 : (0.9 - f * 0.45));
      if (isHead) {
        // eyes looking along the heading
        const ex = Math.sign(dx), ey = Math.sign(dy);
        eng.rect(x + g.tile * 0.5 - 1 + ex * 1.5 - ey * 1.5, y + g.tile * 0.5 - 1 + ey * 1.5 - ex * 1.5, 1.5, 1.5, '#04140a', 1);
        eng.rect(x + g.tile * 0.5 - 1 + ex * 1.5 + ey * 1.5, y + g.tile * 0.5 - 1 + ey * 1.5 + ex * 1.5, 1.5, 1.5, '#04140a', 1);
      }
    }
    parts.draw(vctx);

    if (params.hud) {
      eng.beginHud();
      eng.hud(3, 3, 'SCORE', score | 0, eng.C.gold, 'left');
      eng.hud(vw - 3, 3, 'LEN', len, eng.C.ice, 'right');
      if (intent.source === 'cpu') eng.text('LEAN TO STEER', vw / 2, vh * 0.30, eng.C.white, 1, 'center', 0.4 + 0.4 * Math.sin(t * 2));
      eng.endHud();
    }
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    __test: () => ({ deaths, score, len }),
  };
}
