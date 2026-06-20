// VOIDRIS — falling blocks in the Tetris mold, voidstar-skinned. The crowd or
// performer slides and rotates the piece; soft/hard drops land it. Beats give
// gravity a shove and flash the well, so the stack keeps pace with the set.
// Tops out → the well flashes and resets. A sim, not a scored ladder, but it
// keeps score/level/lines for the HUD.

const W = 10, H = 18;

// Explicit 4-rotation tables (cells as [col,row] in a 4-box). Avoids fragile
// runtime rotation math — what you see is exactly what's authored.
const PIECES = {
  I: [[[0,1],[1,1],[2,1],[3,1]],[[2,0],[2,1],[2,2],[2,3]],[[0,2],[1,2],[2,2],[3,2]],[[1,0],[1,1],[1,2],[1,3]]],
  O: [[[1,0],[2,0],[1,1],[2,1]],[[1,0],[2,0],[1,1],[2,1]],[[1,0],[2,0],[1,1],[2,1]],[[1,0],[2,0],[1,1],[2,1]]],
  T: [[[1,0],[0,1],[1,1],[2,1]],[[1,0],[1,1],[2,1],[1,2]],[[0,1],[1,1],[2,1],[1,2]],[[1,0],[0,1],[1,1],[1,2]]],
  S: [[[1,0],[2,0],[0,1],[1,1]],[[1,0],[1,1],[2,1],[2,2]],[[1,1],[2,1],[0,2],[1,2]],[[0,0],[0,1],[1,1],[1,2]]],
  Z: [[[0,0],[1,0],[1,1],[2,1]],[[2,0],[1,1],[2,1],[1,2]],[[0,1],[1,1],[1,2],[2,2]],[[1,0],[0,1],[1,1],[0,2]]],
  J: [[[0,0],[0,1],[1,1],[2,1]],[[1,0],[2,0],[1,1],[1,2]],[[0,1],[1,1],[2,1],[2,2]],[[1,0],[1,1],[0,2],[1,2]]],
  L: [[[2,0],[0,1],[1,1],[2,1]],[[1,0],[1,1],[1,2],[2,2]],[[0,1],[1,1],[2,1],[0,2]],[[0,0],[1,0],[1,1],[1,2]]],
};
const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
// Wall-kick offsets to try on rotate (shared, never mutated — no per-call alloc).
const KICKS = [0, -1, 1, -2, 2];

export default function create(eng) {
  const COLORS = {
    I: eng.C.cyan, O: eng.C.gold, T: eng.C.magenta,
    S: eng.C.green, Z: eng.C.red, J: '#4c6bff', L: eng.C.amber,
  };
  const board = new Uint8Array(W * H);   // 0 empty, else index+1 into TYPES
  let cur = null, next = null;           // {t, rot, x, y}
  let fall = 0, score = 0, lines = 0, level = 1, t = 0, topout = 0, flash = 0, topouts = 0;
  let lastAudio = null;
  let clearAnim = 0; const clearRows = [];
  const parts = eng.createParticles(120);

  function cellsOf(p) { return PIECES[p.t][p.rot]; }
  // Hot path (gravity, AI probes, wall-kicks, ghost): index loop, no iterator/
  // destructuring alloc per call.
  function collide(p, nx, ny, nrot) {
    const cells = PIECES[p.t][nrot ?? p.rot];
    const ox = nx ?? p.x, oy = ny ?? p.y;
    for (let i = 0; i < 4; i++) {
      const x = ox + cells[i][0], y = oy + cells[i][1];
      if (x < 0 || x >= W || y >= H) return true;
      if (y >= 0 && board[y * W + x]) return true;
    }
    return false;
  }

  // ── autopilot: fixed scratch (no per-frame alloc) ─────────────────────────
  // The AI evaluates every (col,rot) for the current piece, simulates a drop,
  // and scores a cheap heuristic. It then nudges the piece one step per tick.
  const aiTarget = { x: 0, rot: 0, valid: false };  // chosen placement
  let aiTimer = 0;                                   // gates AI step cadence
  const colHeights = new Int16Array(W);              // reused per evaluation
  let aiPlanFor = null;                              // identity of planned piece

  // Height of the highest filled cell in column c (0 = empty, H = full).
  function colHeight(c) {
    for (let r = 0; r < H; r++) if (board[r * W + c]) return H - r;
    return 0;
  }
  // Snapshot the board's surface profile into colHeights (called once/plan).
  function snapshotHeights() { for (let c = 0; c < W; c++) colHeights[c] = colHeight(c); }

  // Score one candidate placement of piece type `t` at (px,rot). Drops it,
  // measures landing height, holes created, aggregate height, bumpiness, and
  // lines cleared. Lower is better. Returns Infinity if the placement is
  // illegal (off-board / overlapping). No allocation.
  function scorePlacement(t, px, rot) {
    const cells = PIECES[t][rot];
    // Reject horizontally out-of-bounds first.
    for (let i = 0; i < 4; i++) {
      const cx = px + cells[i][0];
      if (cx < 0 || cx >= W) return Infinity;
    }
    // Find the largest drop so no cell collides — scan landing y.
    let landY = -4;
    for (let ty = -4; ty <= H; ty++) {
      let hit = false;
      for (let i = 0; i < 4; i++) {
        const x = px + cells[i][0], y = ty + cells[i][1] + 1;
        if (y >= H) { hit = true; break; }
        if (y >= 0 && board[y * W + x]) { hit = true; break; }
      }
      if (hit) { landY = ty; break; }
      landY = ty;
    }
    // Validate the resting cells (must be fully on-board and not overlapping).
    // Reject any cell that would rest ABOVE the well (y < 0): that placement
    // can't physically fit (it's a top-out, not a target) and would otherwise
    // poison the heuristic with top > H / negative-row board reads below.
    for (let i = 0; i < 4; i++) {
      const x = px + cells[i][0], y = landY + cells[i][1];
      if (y < 0 || y >= H || x < 0 || x >= W) return Infinity;
      if (board[y * W + x]) return Infinity;
    }
    // Heuristic features computed against colHeights + the four new cells.
    let maxLand = 0, holes = 0, agg = 0, bump = 0, cleared = 0, maxTop = 0;
    for (let i = 0; i < 4; i++) {
      const land = H - (landY + cells[i][1]);   // this cell's height off floor
      if (land > maxLand) maxLand = land;
    }
    // Per-column surface top after overlaying the dropped cells; aggregate
    // height, holes (empty cells beneath a column's top) and bumpiness.
    let prevTop = -1;
    for (let c = 0; c < W; c++) {
      let top = colHeights[c];                  // snapshot top (cells from floor)
      for (let i = 0; i < 4; i++) {
        if (px + cells[i][0] !== c) continue;
        const ct = H - (landY + cells[i][1]);
        if (ct > top) top = ct;
      }
      agg += top;
      if (top > maxTop) maxTop = top;            // tallest column → strong topout guard
      // Count empty cells from the column's top row down to the floor. A cell
      // is filled if the board has it OR a dropped cell occupies it.
      const topRow = H - top;
      for (let r = topRow; r < H; r++) {
        if (!(board[r * W + c] || isNewCell(cells, px, landY, c, r))) holes++;
      }
      if (prevTop >= 0) bump += Math.abs(top - prevTop);
      prevTop = top;
    }
    // Lines cleared by this placement → reward (negative cost).
    for (let r = 0; r < H; r++) {
      let full = true;
      for (let c = 0; c < W; c++) {
        if (!(board[r * W + c] || isNewCell(cells, px, landY, c, r))) { full = false; break; }
      }
      if (full) cleared++;
    }
    // Weighted sum (classic Tetris-AI weights, tuned to favour flat + low).
    // Heavier hole + tallest-column penalties keep the stack low and clean so it
    // never tops out over a long set; clears strongly rewarded.
    return agg * 0.46 + holes * 11.0 + bump * 0.42 + maxLand * 0.15 + maxTop * 1.2 - cleared * 6.0;
  }
  // True if one of the dropped cells lands at column c, row r.
  function isNewCell(cells, px, landY, c, r) {
    for (let i = 0; i < 4; i++) {
      if (px + cells[i][0] === c && landY + cells[i][1] === r) return true;
    }
    return false;
  }

  // Where the piece (t,px,rot) comes to rest if dropped straight down. Returns
  // -999 if the placement is illegal (off-board / can't fit). Used by lookahead.
  function dropY(t, px, rot) {
    const cells = PIECES[t][rot];
    for (let i = 0; i < 4; i++) { const cx = px + cells[i][0]; if (cx < 0 || cx >= W) return -999; }
    let landY = -4;
    for (let ty = -4; ty <= H; ty++) {
      let hit = false;
      for (let i = 0; i < 4; i++) {
        const x = px + cells[i][0], y = ty + cells[i][1] + 1;
        if (y >= H) { hit = true; break; }
        if (y >= 0 && board[y * W + x]) { hit = true; break; }
      }
      if (hit) { landY = ty; break; }
      landY = ty;
    }
    for (let i = 0; i < 4; i++) { const y = landY + cells[i][1]; if (y < 0 || y >= H) return -999; }
    return landY;
  }
  // Temporarily place / un-place a piece's cells on the board (val 99 = filled,
  // 0 = clear). Cells were validated empty, so un-place restores the board.
  function applyCells(t, px, rot, landY, val) {
    const cells = PIECES[t][rot];
    for (let i = 0; i < 4; i++) {
      const x = px + cells[i][0], y = landY + cells[i][1];
      if (y >= 0 && y < H && x >= 0 && x < W) board[y * W + x] = val;
    }
  }

  // Plan the best (x,rot) for the current piece — 2-ply: for each candidate it
  // places the piece, then evaluates the BEST placement of the `next` piece on
  // the resulting board, and minimises the combined score. The lookahead is what
  // makes the AI effectively never top out. Run once per piece (not per frame).
  function planPiece() {
    aiTarget.valid = false;
    if (!cur) return;
    snapshotHeights();
    let best = Infinity;
    for (let rot = 0; rot < 4; rot++) {
      // O/some pieces repeat rotations — harmless to re-test, keeps it simple.
      for (let px = -2; px <= W; px++) {
        const s1 = scorePlacement(cur.t, px, rot);
        if (s1 === Infinity) continue;
        let s = s1;
        if (next) {
          const ly = dropY(cur.t, px, rot);
          if (ly !== -999) {
            applyCells(cur.t, px, rot, ly, 99);    // place current
            snapshotHeights();                      // re-profile with it placed
            let bn = Infinity;
            for (let r2 = 0; r2 < 4; r2++) for (let x2 = -2; x2 <= W; x2++) {
              const s2 = scorePlacement(next.t, x2, r2);
              if (s2 < bn) bn = s2;
            }
            applyCells(cur.t, px, rot, ly, 0);     // undo
            snapshotHeights();                      // restore profile
            s = s1 + (bn === Infinity ? 80 : bn);
          }
        }
        if (s < best) { best = s; aiTarget.x = px; aiTarget.rot = rot; aiTarget.valid = true; }
      }
    }
    aiPlanFor = cur;
  }
  function spawn() {
    cur = next || { t: TYPES[(Math.random() * 7) | 0], rot: 0, x: 3, y: 0 };
    cur.x = 3; cur.y = 0; cur.rot = 0;
    next = { t: TYPES[(Math.random() * 7) | 0], rot: 0, x: 3, y: 0 };
    if (collide(cur)) { topout = 1.2; topouts++; flash = 1; board.fill(0); }  // reset on top-out
  }
  function reset() {
    board.fill(0); score = 0; lines = 0; level = 1; fall = 0; t = 0; topout = 0; flash = 0; topouts = 0;
    cur = null; next = null; clearRows.length = 0; clearAnim = 0; parts.clear();
    aiTarget.valid = false; aiTimer = 0; aiPlanFor = null;
    spawn();
  }

  function lockPiece() {
    const ti = TYPES.indexOf(cur.t) + 1;
    for (const [cx, cy] of cellsOf(cur)) {
      const x = cur.x + cx, y = cur.y + cy;
      if (y >= 0) board[y * W + x] = ti;
    }
    // Find full rows.
    clearRows.length = 0;
    for (let r = 0; r < H; r++) {
      let full = true;
      for (let c = 0; c < W; c++) if (!board[r * W + c]) { full = false; break; }
      if (full) clearRows.push(r);
    }
    if (clearRows.length) {
      clearAnim = 0.28;
      score += [0, 100, 300, 500, 800][clearRows.length] * level;
      lines += clearRows.length; level = 1 + Math.floor(lines / 10);
      eng.shake(2 + clearRows.length * 2);
    } else { spawn(); }
  }

  function collapseRows() {
    for (const r of clearRows) {
      for (let y = r; y > 0; y--) for (let c = 0; c < W; c++) board[y * W + c] = board[(y - 1) * W + c];
      for (let c = 0; c < W; c++) board[c] = 0;
    }
    clearRows.length = 0;
    spawn();
  }

  function rotateCur() {
    const nr = (cur.rot + 1) % 4;
    for (let i = 0; i < KICKS.length; i++) {
      const k = KICKS[i];
      if (!collide(cur, cur.x + k, cur.y, nr)) { cur.x += k; cur.rot = nr; return true; }
    }
    return false;
  }

  function update(dt, intent, audio, params) {
    lastAudio = audio;
    t += dt;
    if (flash > 0) flash -= dt * 2;
    if (topout > 0) { topout -= dt; return; }

    // Line-clear pause + particle pop.
    if (clearAnim > 0) {
      clearAnim -= dt;
      if (clearAnim <= 0) collapseRows();
      parts.update(dt, 60, 1);
      return;
    }

    // (Re)plan whenever a new piece is in play so the AI has a fresh target.
    if (cur && aiPlanFor !== cur) planPiece();

    // ── player edges — gated by autonomy so CPU/noisy-pose DAS edges don't
    // fight the AI at high autonomy (the root cause of piece jitter). ──────
    let playerActed = false;
    if (intent.autonomy < 0.5) {
      if (intent.left && !collide(cur, cur.x - 1, cur.y)) { cur.x--; playerActed = true; }
      if (intent.right && !collide(cur, cur.x + 1, cur.y)) { cur.x++; playerActed = true; }
      if (intent.jump) { rotateCur(); playerActed = true; }
    }
    if (playerActed) aiPlanFor = null;
    // Ambient aesthetic: pieces are NEVER hard-dropped — they settle under
    // gravity alone (see the gravity block below). So `fire` no longer slams the
    // piece home; the AI/player only positions it and gravity does the rest.

    // ── autopilot: at most ONE step toward (aiTarget.x, aiTarget.rot) per
    // tick, gated by a timer that runs faster at high autonomy and stalls at
    // low autonomy so a crowd keeps control. Skips the frame the player acted.
    aiTimer -= dt;
    const auto = intent.autonomy;
    // EXPERT (autonomy ~1): fully position the piece THIS tick — rotate to the
    // target rotation, slide all the way to the target column — then hand it to
    // gravity. Optimal placement on every piece means the well never outruns the
    // AI and never tops out, and because positioning happens up high (long
    // before the gentle gravity lands it) the slow fall can't spoil the
    // placement. Lower autonomy keeps the gradual, human-paced stepping below.
    const expert = !playerActed && auto > 0.95 && aiTarget.valid;
    if (expert) {
      // Snap to the target column + rotation THIS tick (so gravity can never
      // catch it mid-position), then let it fall the rest of the way at the
      // gentle gravity rate set below — no hard drop.
      let guard = 0;
      while (cur.rot !== aiTarget.rot && guard++ < 4 && rotateCur()) { /* rotate to target */ }
      while (cur.x < aiTarget.x && !collide(cur, cur.x + 1, cur.y)) cur.x++;
      while (cur.x > aiTarget.x && !collide(cur, cur.x - 1, cur.y)) cur.x--;
    }
    if (!expert && !playerActed && auto > 0.04 && aiTimer <= 0 && aiTarget.valid) {
      const aligned = cur.x === aiTarget.x && cur.rot === aiTarget.rot;
      if (!aligned) {
        aiTimer = 0.10 + (1 - auto) * 1.1;
        if (cur.rot !== aiTarget.rot) {
          rotateCur();
        } else if (cur.x < aiTarget.x && !collide(cur, cur.x + 1, cur.y)) {
          cur.x++;
        } else if (cur.x > aiTarget.x && !collide(cur, cur.x - 1, cur.y)) {
          cur.x--;
        } else {
          if (!collide(cur, cur.x, cur.y + 1)) cur.y++;
        }
      }
    }

    // Gravity ONLY — once positioned, a piece falls all the way down at a
    // gentle, ambient rate (no hard/instant drop anywhere, including expert).
    // A soft beat shove + a slow level ramp with a high floor keep it
    // meditative; the global `speed` knob in arcade.js scales it further.
    const beat = 1 + audio.beat.pulse * 0.5 + audio.bands.bass * 0.25;
    let step = Math.max(0.22, 0.7 - (level - 1) * 0.03) / beat;
    if (intent.down) step *= 0.3;                        // soft drop still nudges it down
    else if (!playerActed && auto > 0.25) step *= 0.7;   // mild AI lean into gravity
    fall += dt;
    while (fall >= step) {
      fall -= step;
      if (!collide(cur, cur.x, cur.y + 1)) cur.y++;
      else { lockPiece(); break; }
    }
  }

  function geom() {
    const vw = eng.vw, vh = eng.vh, top = 9;
    const cell = Math.max(3, Math.floor(Math.min((vh - top - 2) / H, (vw * 0.62) / W)));
    const bw = cell * W, bh = cell * H;
    // Bias the well left to leave room for the next-piece + HUD column, but
    // never let it clip off the left edge on narrow aspects.
    const ox = Math.max(2, Math.floor((vw - bw) / 2 - cell * 1.6));
    const oy = top + Math.floor((vh - top - bh) / 2);
    return { cell, ox, oy, bw, bh };
  }

  function block(g, c, r, color, alpha = 1) {
    const x = g.ox + c * g.cell, y = g.oy + r * g.cell;
    eng.rect(x, y, g.cell, g.cell, color, alpha);
    eng.rect(x, y, g.cell, Math.max(1, g.cell * 0.22), eng.C.white, 0.25 * alpha);  // bevel
    eng.box(x, y, g.cell, g.cell, '#000', 0.35 * alpha);
  }

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    const audio = lastAudio;
    eng.clear('#04040e');
    const g = geom();
    // Well.
    eng.rect(g.ox, g.oy, g.bw, g.bh, '#070a18', 1);
    const bassV = audio ? audio.bands.bass : 0;
    const border = flash > 0 ? eng.C.white : eng.C.cyan;
    eng.box(g.ox - 1, g.oy - 1, g.bw + 2, g.bh + 2, border, 0.6 + 0.4 * (flash > 0 ? 1 : 0.5 + 0.5 * Math.sin(t * 3)));
    if (bassV > 0.2) eng.box(g.ox - 2, g.oy - 2, g.bw + 4, g.bh + 4, eng.C.magenta, bassV * 0.2);
    if (audio) {
      eng.spectrumBar(audio.spectrum, g.ox, g.oy + g.bh - 6, g.bw, 6, 10, eng.C.cyan, 0.18, 2);
      eng.waveformLine(audio.waveform, g.ox, g.oy - 4, g.bw, 4, eng.C.magenta, 0.18);
    }

    // Locked cells.
    for (let r = 0; r < H; r++) {
      const clearing = clearRows.indexOf(r) >= 0;
      for (let c = 0; c < W; c++) {
        const v = board[r * W + c];
        if (!v) continue;
        if (clearing) block(g, c, r, eng.C.white, 0.4 + 0.6 * Math.abs(Math.sin(t * 30)));
        else block(g, c, r, COLORS[TYPES[v - 1]], 1);
      }
    }

    // Ghost (landing preview) + current piece.
    if (cur && topout <= 0 && clearAnim <= 0) {
      let gy = cur.y; while (!collide(cur, cur.x, gy + 1)) gy++;
      for (const [cx, cy] of cellsOf(cur)) {
        if (cur.y + cy >= 0) block(g, cur.x + cx, gy + cy, COLORS[cur.t], 0.18);
      }
      for (const [cx, cy] of cellsOf(cur)) {
        if (cur.y + cy >= 0) block(g, cur.x + cx, cur.y + cy, COLORS[cur.t], 1);
      }
    }
    parts.draw(vctx);

    // Next-piece preview.
    const nx = g.ox + g.bw + g.cell, ny = g.oy + g.cell;
    eng.text('NEXT', nx, ny - 7, eng.C.dim, 1, 'left');
    if (next) for (const [cx, cy] of PIECES[next.t][0]) {
      const x = nx + cx * (g.cell * 0.8), y = ny + cy * (g.cell * 0.8);
      eng.rect(x, y, g.cell * 0.8, g.cell * 0.8, COLORS[next.t], 1);
      eng.box(x, y, g.cell * 0.8, g.cell * 0.8, '#000', 0.35);
    }

    if (params.hud) {
      eng.beginHud();
      const sy = g.oy + g.bh * 0.40;
      eng.textOutline('SCORE', nx, sy, eng.C.dim, 1, 'left');
      eng.textOutline('' + (score | 0), nx, sy + 8, eng.C.gold, 1, 'left');
      eng.hud(nx, sy + 20, 'LVL', level, eng.C.cyan, 'left');
      eng.hud(nx, sy + 30, 'LN', lines, eng.C.ice, 'left');
      if (topout > 0) eng.textOutline('TOP OUT', g.ox + g.bw / 2, g.oy + g.bh / 2, eng.C.red, 2, 'center');
      if (intent.source === 'cpu') eng.text('LEAN+RAISE', nx, sy + 44, eng.C.white, 1, 'left', 0.4 + 0.4 * Math.sin(t * 2));
      eng.endHud();
    }
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    __test: () => ({ deaths: topouts, lines }),
  };
}
