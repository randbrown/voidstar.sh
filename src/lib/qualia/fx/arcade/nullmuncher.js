// NULLMUNCHER — a maze muncher in the Pac-Man / Dig Dug lineage. A void-mouth
// chomps null-pointers through a neon lattice while glitch-ghosts give chase.
// Eat a power `*` and the ghosts turn frightened and edible. The crowd (or
// performer) steers by leaning; direction reads instantly across a room.
//
// The maze is GENERATED fresh every board (randomized-DFS spanning tree + a
// little braiding for pac-like loops) so it's always fully connected — every
// pellet reachable, no hand-authored layout to debug. Pellets render as tiny
// CODE glyphs (null `0`, power `*`, scattered `;` `/` `%`) so the maze reads as
// eating code, not dots.
//
// The muncher DRIVES ITSELF: a cheap BFS to the nearest remaining pellet picks
// the route, it dodges nearby ghosts and chases them while they're frightened.
// The player signal is a NUDGE blended by intent.autonomy — a hard lean
// overrides the AI's next turn, a crowd in tight control steers it directly.

const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

export default function create(eng) {
  const COLS = 19, ROWS = 13;
  const N = COLS * ROWS;
  // pellets[i]: 0 none · 1 pellet · 2 power
  const pellets = new Uint8Array(N);
  // walls[i]: 1 wall · 0 path. Generated each board; isWall() reads this.
  const walls = new Uint8Array(N);
  let remaining = 0;
  const ghosts = [];
  let muncher = null;
  let chomp = 0, score = 0, fright = 0, caught = 0, t = 0, caughtCount = 0;
  // Chase/scatter cycle (authentic Pac-Man): ghosts periodically retreat to their
  // home corners, giving the muncher guaranteed relief. This is what makes the
  // 4-ghost field survivable (a faster evader can always exploit the scatter).
  let scatterMode = false, modeT = 7;
  // brief respawn grace after a catch: ghosts can't catch the muncher while it
  // disperses from the pack, so a bad spawn can't death-loop it to zero.
  let invuln = 0;
  // stall watchdog: seconds since the last pellet was eaten. If a board becomes
  // unfinishable (the last pellets get permanently camped by the ghost pack), we
  // refresh it so the attract screen never sits dead bleeding score to catches.
  let sinceEat = 0;
  let lastAudio = null;
  const parts = eng.createParticles(80);

  // entity start + ghost homes — all (odd,odd) so always on an open cell in a
  // generated maze. Homes are SPREAD across the upper maze (not clustered) and
  // kept far from the muncher's bottom-row start, so a post-catch respawn doesn't
  // drop the muncher straight into the pack.
  const M_START_C = 9, M_START_R = ROWS - 2;             // (9,11)
  const HOMES = [[3, 3], [15, 3], [7, 5], [11, 5]];

  // ── preallocated BFS scratch (no per-frame allocation) ─────────────────────
  // bfsDist: distance field from the muncher (reachability). pelletDist: a
  // SECOND field BFS'd FROM the chosen target, so the muncher can descend its
  // true geodesic gradient (a manhattan guess walks into dead branches and
  // oscillates — this never does, on a fully-connected maze).
  const bfsDist = new Int16Array(N);
  const pelletDist = new Int16Array(N);
  // ghostDist: multi-source BFS distance to the NEAREST non-frightened ghost
  // (so the autopilot dodges pincers, not just the single closest ghost).
  const ghostDist = new Int16Array(N);
  const bfsQueue = new Int16Array(N);
  // scratch for the muncher autopilot decision (reused each call)
  const candDx = new Int8Array(4), candDy = new Int8Array(4);

  // ── anti-oscillation (escape a local minimum) ──────────────────────────────
  // When the only food is past a ghost, threat-dodging can trap the muncher in a
  // tiny back-and-forth (looks dead). We log the last few cells it ENTERED; if it
  // keeps revisiting a tiny set, we arm `commit`: a short window where the threat
  // penalty is dropped so it punches through the gap toward food. Bounded ring,
  // no allocation.
  const RECENT = 8;
  const recentCell = new Int16Array(RECENT).fill(-1);
  let recentHead = 0;
  let commit = 0;            // seconds of "push through" left
  function noteCell(ci) {
    recentCell[recentHead] = ci;
    recentHead = (recentHead + 1) % RECENT;
  }
  function isStuck() {
    // distinct cells among the last RECENT entries; ≤3 distinct ⇒ oscillating.
    let distinct = 0;
    for (let i = 0; i < RECENT; i++) {
      const v = recentCell[i];
      if (v < 0) return false;            // not enough history yet
      let seen = false;
      for (let j = 0; j < i; j++) if (recentCell[j] === v) { seen = true; break; }
      if (!seen) distinct++;
    }
    return distinct <= 3;
  }

  function isWall(c, r) {
    if (c <= 0 || r <= 0 || c >= COLS - 1 || r >= ROWS - 1) return true;  // border
    if (r % 2 === 0 && c % 2 === 0) return true;                          // interior pillars
    return walls[r * COLS + c] === 1;
  }
  const open = (c, r) => !isWall(c, r);
  // Count open neighbours of a cell — its "escape routes". Junctions (3-4) are
  // far safer to flee through than corridors (2) or dead-ends (1).
  const openCount = (c, r) => {
    let n = 0;
    if (open(c, r - 1)) n++; if (open(c, r + 1)) n++;
    if (open(c - 1, r)) n++; if (open(c + 1, r)) n++;
    return n;
  };

  // ── maze generation ────────────────────────────────────────────────────────
  // Randomized-DFS over the coarse maze-cells at (odd,odd) fine coords. There
  // are 9×6 such cells in a 19×13 grid. Every interior wall-EDGE cell (exactly
  // one of c,r even) starts WALL; DFS carves the between-cell edges to PATH,
  // giving a spanning tree (full connectivity). Then BRAID a few dead ends into
  // loops so it plays pac-like instead of a pure tree.
  const MCOLS = (COLS - 1) >> 1;   // 9 maze-cells across
  const MROWS = (ROWS - 1) >> 1;   // 6 maze-cells down
  const visited = new Uint8Array(MCOLS * MROWS);
  const stackC = new Int16Array(MCOLS * MROWS);
  const stackR = new Int16Array(MCOLS * MROWS);
  const MDIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const ord = new Int8Array(4);

  function genMaze() {
    // Initialize: every interior EDGE fine-cell (exactly one of c,r even) = WALL.
    // (Borders + even/even pillars are invariants enforced by isWall, but we set
    // the array consistently so reads are stable everywhere.)
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const edge = ((c & 1) === 0) !== ((r & 1) === 0);  // exactly one even
      walls[r * COLS + c] = edge ? 1 : 0;
    }
    visited.fill(0);

    // DFS from a random maze-cell, carving the wall between adjacent cells.
    let mc = (Math.random() * MCOLS) | 0;
    let mr = (Math.random() * MROWS) | 0;
    let sp = 0;
    visited[mr * MCOLS + mc] = 1;
    stackC[sp] = mc; stackR[sp] = mr; sp++;
    while (sp > 0) {
      mc = stackC[sp - 1]; mr = stackR[sp - 1];
      // shuffle the four neighbour directions
      ord[0] = 0; ord[1] = 1; ord[2] = 2; ord[3] = 3;
      for (let i = 3; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = ord[i]; ord[i] = ord[j]; ord[j] = tmp;
      }
      let advanced = false;
      for (let k = 0; k < 4; k++) {
        const d = MDIRS[ord[k]];
        const nmc = mc + d[0], nmr = mr + d[1];
        if (nmc < 0 || nmr < 0 || nmc >= MCOLS || nmr >= MROWS) continue;
        if (visited[nmr * MCOLS + nmc]) continue;
        // carve the edge fine-cell between the two maze-cells → PATH
        const fc = 1 + mc * 2, fr = 1 + mr * 2;
        walls[(fr + d[1]) * COLS + (fc + d[0])] = 0;
        visited[nmr * MCOLS + nmc] = 1;
        stackC[sp] = nmc; stackR[sp] = nmr; sp++;
        advanced = true;
        break;
      }
      if (!advanced) sp--;   // backtrack
    }

    // BRAID — for several random maze-cells, open one extra closed edge to add
    // loops (kills some dead ends; makes it feel pac-like). Bounded pass.
    const braids = 10;
    for (let b = 0; b < braids; b++) {
      const bmc = (Math.random() * MCOLS) | 0;
      const bmr = (Math.random() * MROWS) | 0;
      const fc = 1 + bmc * 2, fr = 1 + bmr * 2;
      // pick a random direction whose edge is currently closed + in-bounds
      const start = (Math.random() * 4) | 0;
      for (let k = 0; k < 4; k++) {
        const d = MDIRS[(start + k) & 3];
        const nmc = bmc + d[0], nmr = bmr + d[1];
        if (nmc < 0 || nmr < 0 || nmc >= MCOLS || nmr >= MROWS) continue;
        const ei = (fr + d[1]) * COLS + (fc + d[0]);
        if (walls[ei] === 1) { walls[ei] = 0; break; }
      }
    }
  }

  function fillPellets() {
    remaining = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (isWall(c, r)) { pellets[i] = 0; continue; }
      pellets[i] = 1; remaining++;
    }
    // Power pellets in the four corners (odd indices → always path).
    for (const [c, r] of [[1, 1], [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2]]) {
      pellets[r * COLS + c] = 2;
    }
  }

  // Regenerate the maze AND refill pellets — the board-refill path on a clear.
  function newBoard() {
    genMaze();
    fillPellets();
  }

  function mkEntity(c, r, dx, dy) { return { c, r, dx, dy, prog: 0, hue: 0 }; }
  // First open neighbour (prefer horizontal) — guarantees an entity never
  // starts a step heading straight into a pillar.
  function openDir(c, r) {
    for (const [ox, oy] of DIRS) if (open(c + ox, r + oy)) return [ox, oy];
    return [0, 0];
  }

  function placeEntities() {
    muncher = mkEntity(M_START_C, M_START_R, -1, 0);
    const [mdx, mdy] = openDir(muncher.c, muncher.r);
    muncher.dx = mdx; muncher.dy = mdy;
    pellets[muncher.r * COLS + muncher.c] = 0; remaining--;
    ghosts.length = 0;
    for (let i = 0; i < 4; i++) {
      const [dx, dy] = openDir(HOMES[i][0], HOMES[i][1]);
      const g = mkEntity(HOMES[i][0], HOMES[i][1], dx, dy);
      g.hue = i; g.home = HOMES[i]; ghosts.push(g);
    }
  }

  function reset() {
    newBoard();
    placeEntities();
    score = 0; fright = 0; caught = 0; invuln = 0; chomp = 0; t = 0; sinceEat = 0; caughtCount = 0;
    recentCell.fill(-1); recentHead = 0; commit = 0;
    parts.clear();
  }

  function reverse(e) { e.c += e.dx; e.r += e.dy; e.dx = -e.dx; e.dy = -e.dy; e.prog = 1 - e.prog; }

  // Eat the pellet at (c,r). Returns true if the board just CLEARED (a new maze +
  // entities were spawned) — callers holding a stale `muncher` reference must
  // stop mutating it and return immediately.
  function popPellet(c, r) {
    const i = r * COLS + c;
    if (pellets[i]) { pellets[i] = 0; remaining--; sinceEat = 0; }   // progress → reset watchdog
    if (remaining <= 0) {
      // board clear → NEW maze + fresh pellets + re-home everyone.
      newBoard();
      placeEntities();
      return true;
    }
    return false;
  }

  // ── muncher autopilot ──────────────────────────────────────────────────────
  // BFS over open cells from (sc,sr), filling `dist[]` with steps to each cell
  // (-1 unreachable). Cheap: <=247 cells, preallocated queue. `dist` is one of
  // the preallocated fields (bfsDist or pelletDist) so there's no allocation.
  function bfsFrom(sc, sr, dist) {
    dist.fill(-1);
    let qh = 0, qt = 0;
    const s = sr * COLS + sc;
    dist[s] = 0; bfsQueue[qt++] = s;
    while (qh < qt) {
      const cur = bfsQueue[qh++];
      const cc = cur % COLS, cr = (cur / COLS) | 0;
      const nd = dist[cur] + 1;
      for (let k = 0; k < 4; k++) {
        const nc = cc + DIRS[k][0], nr = cr + DIRS[k][1];
        if (!open(nc, nr)) continue;
        const ni = nr * COLS + nc;
        if (dist[ni] !== -1) continue;
        dist[ni] = nd; bfsQueue[qt++] = ni;
      }
    }
  }

  // Multi-source BFS: distance from every cell to the NEAREST non-frightened
  // ghost. Seeds the queue with all such ghosts at once → one pass, same cost as
  // a single-source BFS. Returns the number of threats seeded (0 = all safe).
  function bfsGhosts() {
    ghostDist.fill(-1);
    let qh = 0, qt = 0, seeded = 0;
    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      const gi = g.r * COLS + g.c;
      if (gi < 0 || gi >= N) continue;
      if (ghostDist[gi] === -1) { ghostDist[gi] = 0; bfsQueue[qt++] = gi; seeded++; }
      // ALSO seed the cell the ghost is moving INTO, so the danger field
      // anticipates where ghosts will be next — this is what defuses the corner
      // ambush + can't-reverse head-on that a current-position-only field misses.
      const nc = g.c + g.dx, nr = g.r + g.dy;
      if (open(nc, nr)) { const ni = nr * COLS + nc; if (ghostDist[ni] === -1) { ghostDist[ni] = 0; bfsQueue[qt++] = ni; } }
    }
    while (qh < qt) {
      const cur = bfsQueue[qh++];
      const cc = cur % COLS, cr = (cur / COLS) | 0;
      const nd = ghostDist[cur] + 1;
      for (let k = 0; k < 4; k++) {
        const nc = cc + DIRS[k][0], nr = cr + DIRS[k][1];
        if (!open(nc, nr)) continue;
        const ni = nr * COLS + nc;
        if (ghostDist[ni] !== -1) continue;
        ghostDist[ni] = nd; bfsQueue[qt++] = ni;
      }
    }
    return seeded;
  }

  // Pick the autopilot's desired direction at a decision cell. Returns nothing;
  // writes into aiDx/aiDy. Greedy on a BFS distance field toward the nearest
  // remaining pellet; dodges a close non-frightened ghost; chases when fright.
  let aiDx = 0, aiDy = 0;
  function autopilot() {
    const m = muncher;
    // HEAD-ON REVERSAL (mid-corridor). The single biggest cause of catches is a
    // ghost entering the muncher's corridor head-on AFTER it committed to a
    // direction at the last cell — they meet in the middle before the muncher
    // re-decides. Greedy cell-by-cell logic can't see this, so handle it first:
    // if a ghost is directly ahead in our heading within ~3 cells and the way
    // back is open, REVERSE now (stepMuncher applies a mid-cell reverse). Not
    // while frightened — then we WANT to close on edible ghosts.
    if ((m.dx || m.dy) && fright <= 0.9 && open(m.c - m.dx, m.r - m.dy)) {
      for (let i = 0; i < ghosts.length; i++) {
        const g = ghosts[i];
        const inLine = (m.dy === 0 && g.r === m.r && Math.sign(g.c - m.c) === m.dx)
                    || (m.dx === 0 && g.c === m.c && Math.sign(g.r - m.r) === m.dy);
        if (!inLine) continue;
        const dcells = Math.abs(g.c - m.c) + Math.abs(g.r - m.r);
        if (dcells <= 3) { aiDx = -m.dx; aiDy = -m.dy; return; }   // flee the head-on
      }
    }
    // Gather all OPEN candidate directions (reverse allowed — it's discouraged by
    // a hysteresis penalty below, not excluded, so the muncher can still U-turn to
    // flee or escape a trap when that's genuinely best).
    let nCand = 0;
    for (let k = 0; k < 4; k++) {
      const ox = DIRS[k][0], oy = DIRS[k][1];
      if (!open(m.c + ox, m.r + oy)) continue;
      candDx[nCand] = ox; candDy[nCand] = oy; nCand++;
    }
    if (nCand === 0) { aiDx = 0; aiDy = 0; return; }

    // ── CHASE mode: while ghosts are safely edible, hunt the nearest one. Stop
    // BEFORE fright expires (>0.9s left) so the muncher is never caught sitting
    // on a ghost the instant it un-frightens — below that it reverts to EAT and
    // the threat field steers it clear. ───────────────────────────────────────
    if (fright > 0.9) {
      let preyC = -1, preyR = -1, preyD = 1e9;
      for (let i = 0; i < ghosts.length; i++) {
        const g = ghosts[i];
        const d = (g.c - m.c) * (g.c - m.c) + (g.r - m.r) * (g.r - m.r);
        if (d < preyD) { preyD = d; preyC = g.c; preyR = g.r; }
      }
      if (preyC >= 0) {
        bfsFrom(preyC, preyR, pelletDist);    // geodesic field down to the prey
        let best = -1, bestD = 1e9;
        for (let k = 0; k < nCand; k++) {
          const dd = pelletDist[(m.r + candDy[k]) * COLS + (m.c + candDx[k])];
          if (dd < 0) continue;
          const sc = dd + Math.random() * 0.4;
          if (sc < bestD) { bestD = sc; best = k; }
        }
        if (best >= 0) { aiDx = candDx[best]; aiDy = candDy[best]; return; }
      }
    }

    // ── threat field (multi-source) — distance to the NEAREST dangerous ghost,
    // so the muncher dodges PINCERS, not just one ghost. Geodesic, not line-of-
    // sight (a ghost across a wall is no threat). Ghosts count as dangerous when
    // fright is off OR about to expire (≤0.9s) — so the muncher peels away from a
    // ghost before it un-frightens rather than getting caught on top of it. ────
    const nThreats = fright <= 0.9 ? bfsGhosts() : 0;
    const hereGhost = nThreats > 0 ? ghostDist[m.r * COLS + m.c] : 999;
    // "danger" when a ghost is within a few corridors — then survival dominates.
    const danger = nThreats > 0 && hereGhost >= 0 && hereGhost <= 5;

    // ── FLEE: only when a ghost is RIGHT on top of the muncher (≤2 corridors) —
    // drop the food plan and maximize distance to the nearest ghost. Pure survival
    // beats any compromise here; the muncher is faster so running to the most open
    // escape keeps it alive. (Farther out, EAT mode's graded veto handles spacing
    // while still pursuing food, so the muncher doesn't cower.) A pellet on the
    // safest escape cell is a happy tiebreak. ─────────────────────────────────────
    // SURVIVAL FIRST — COHERENT FLEE: as soon as a ghost is within 4 corridors,
    // drop the food plan and run toward the globally SAFEST reachable cell (the
    // one farthest from every ghost), descending a BFS gradient toward it. This
    // beats a myopic single-step max-distance flee, which wanders into a pocket
    // the ghosts then collapse — the gradient commits to a coherent escape and,
    // with the muncher's big speed edge, keeps it uncatchable.
    if (commit <= 0 && nThreats > 0 && hereGhost >= 0 && hereGhost <= 4) {
      bfsFrom(m.c, m.r, bfsDist);                        // reachable cells from the muncher
      let safeC = m.c, safeR = m.r, safeBest = -1e9;
      for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) {
        const i = r * COLS + c;
        if (bfsDist[i] < 0) continue;                    // unreachable
        const gd = ghostDist[i]; if (gd < 0) continue;
        const sc = gd * 10 + openCount(c, r) * 2 - bfsDist[i] * 0.08;  // safe, open, not absurdly far
        if (sc > safeBest) { safeBest = sc; safeC = c; safeR = r; }
      }
      bfsFrom(safeC, safeR, pelletDist);                 // gradient down to the safe cell
      let best = -1, bestScore = -1e9;
      for (let k = 0; k < nCand; k++) {
        const nc = m.c + candDx[k], nr = m.r + candDy[k];
        const ni = nr * COLS + nc;
        const gd = ghostDist[ni];
        if (gd === 0) continue;                          // never onto a ghost
        let s = -pelletDist[ni] * 10;                    // descend toward the safe region
        s += (gd < 0 ? 60 : gd) * 6 + openCount(nc, nr) * 2;
        if (gd === 1) s -= 120;                          // avoid stepping adjacent to a ghost
        if (candDx[k] === -m.dx && candDy[k] === -m.dy) s -= 3;
        s += Math.random() * 0.4;
        if (s > bestScore) { bestScore = s; best = k; }
      }
      if (best < 0) {                                    // fully boxed → take max ghost-distance
        let mg = -2;
        for (let k = 0; k < nCand; k++) {
          const gd = ghostDist[(m.r + candDy[k]) * COLS + (m.c + candDx[k])];
          const v = gd < 0 ? 60 : gd;
          if (v > mg) { mg = v; best = k; }
        }
      }
      if (best >= 0) { aiDx = candDx[best]; aiDy = candDy[best]; return; }
    }

    // ── pick a pellet target. When in danger, prefer the nearest reachable POWER
    // pellet (eat it → turn the ghosts edible) so the muncher plays the table,
    // not just runs. Otherwise nearest food (power weighted a touch). ──────────
    bfsFrom(m.c, m.r, bfsDist);   // muncher reachability + distances to pellets
    let pc = -1, pr = -1, pbest = 1e9;
    let powC = -1, powR = -1, powBest = 1e9;
    for (let r = 1; r < ROWS - 1; r++) for (let c = 1; c < COLS - 1; c++) {
      const pi = r * COLS + c;
      const v = pellets[pi];
      if (!v) continue;
      const dd = bfsDist[pi];
      if (dd < 0) continue;                            // unreachable (shouldn't happen)
      const w = dd - (v === 2 ? 3 : 0);
      if (w < pbest) { pbest = w; pc = c; pr = r; }
      if (v === 2 && dd < powBest) { powBest = dd; powC = c; powR = r; }
    }
    // In danger — OR oscillating with food blocked by the pack (commit armed) —
    // make a reachable POWER pellet the target: eating it flips the ghosts edible
    // and clears the jam. Otherwise the nearest food.
    if ((danger || commit > 0) && powC >= 0) { pc = powC; pr = powR; }
    // No reachable target (board just cleared mid-frame): don't freeze.
    if (pc < 0) { aiDx = candDx[0]; aiDy = candDy[0]; return; }

    bfsFrom(pc, pr, pelletDist);   // geodesic gradient down to the target

    // ── score candidates. SURVIVAL ≫ EATING ≫ flavor. ─────────────────────────
    let best = -1, bestScore = -1e9;
    for (let k = 0; k < nCand; k++) {
      const nc = m.c + candDx[k], nr = m.r + candDy[k];
      const ni = nr * COLS + nc;
      let s = 0;
      // EAT: descend the geodesic gradient toward the target.
      const grad = pelletDist[ni];
      if (grad < 0) s -= 1000;                          // unreachable pocket → avoid
      else s -= grad * 10;
      // THREAT: penalize moving toward / beside a ghost. Uses the multi-source
      // field so a cell squeezed between two ghosts scores worst. Steep enough to
      // override the eat gradient and pick the safe turn. (When genuinely cornered
      // the dedicated FLEE branch above takes over and ignores food entirely.)
      if (nThreats > 0) {
        const gd = ghostDist[ni];
        // Never step onto / right beside a ghost. Beyond that, a graded penalty
        // prefers the safe route without vetoing the ONLY path to food. While
        // `commit` is armed (oscillation escape) drop the spacing penalty and keep
        // only the hard ≤1 veto, so the muncher punches through a gap toward food
        // instead of cowering in a dead stub.
        if (gd === 0) s -= 100000;                      // ghost is ON that cell → never
        else if (commit > 0) {                          // oscillation escape: push through
          if (gd === 1) s -= 30;                        // tolerate a tight squeeze toward food
        } else if (gd === 1) s -= 200;                  // adjacent → almost never
        else if (gd === 2) s -= 60;
        else if (gd === 3) s -= 12;
        // Continuous repulsion: even while eating, always prefer routes that keep
        // distance from the nearest ghost (proactive spacing, not just reactive),
        // so a pincer never gets the chance to close.
        if (gd > 0) s += Math.min(gd, 7) * 6 + openCount(nc, nr) * 2;
      }
      // HYSTERESIS: hold heading, avoid pointless U-turns. Small vs. the gradient,
      // so it only breaks ties — kills 2-cell ping-ponging, never steers past food.
      if (candDx[k] === m.dx && candDy[k] === m.dy) s += 3;
      if (candDx[k] === -m.dx && candDy[k] === -m.dy) s -= 3;
      s += Math.random() * 1.2;   // gentle musical randomness so it feels alive
      if (s > bestScore) { bestScore = s; best = k; }
    }
    if (best >= 0) { aiDx = candDx[best]; aiDy = candDy[best]; }
    else { aiDx = candDx[0]; aiDy = candDy[0]; }
  }

  function stepMuncher(dt, speed, ddx, ddy) {
    const m = muncher;
    if (m.dx === 0 && m.dy === 0) {
      // resume from a standstill: take the desired dir if open, else ANY open
      // neighbour (autopilot always supplies one) so we never freeze in place.
      if ((ddx || ddy) && open(m.c + ddx, m.r + ddy)) { m.dx = ddx; m.dy = ddy; }
      else if (aiDx || aiDy) { m.dx = aiDx; m.dy = aiDy; }
    } else if (ddx === -m.dx && ddy === -m.dy) {
      reverse(m);
    }
    m.prog += speed * dt;
    while (m.prog >= 1) {
      m.prog -= 1; m.c += m.dx; m.r += m.dy;
      const i = m.r * COLS + m.c;
      noteCell(i);                         // track recent cells for stuck-detection
      if (pellets[i] === 2) { fright = 6; score += 50; if (popPellet(m.c, m.r)) return; }
      else if (pellets[i] === 1) { score += 10; if (popPellet(m.c, m.r)) return; }
      // decide next dir: desired turn if open, else keep heading, else turn into
      // any open neighbour (never wedge against a wall with zero velocity).
      if ((ddx || ddy) && open(m.c + ddx, m.r + ddy)) { m.dx = ddx; m.dy = ddy; }
      else if (!open(m.c + m.dx, m.r + m.dy)) {
        if (aiDx || aiDy) { m.dx = aiDx; m.dy = aiDy; }
        else { m.dx = 0; m.dy = 0; m.prog = 0; break; }
        if (!open(m.c + m.dx, m.r + m.dy)) { m.dx = 0; m.dy = 0; m.prog = 0; break; }
      }
    }
  }

  function stepGhost(g, dt, speed) {
    const frightened = fright > 0;
    // Per-ghost personalities (authentic Pac-Man) so the four don't converge on
    // one cell and perfectly pincer — that diversity + scatter + the muncher's
    // speed edge is what makes the field survivable. Flee when frightened;
    // retreat home when scattering.
    let tgtC, tgtR;
    if (frightened) { tgtC = muncher.c; tgtR = muncher.r; }
    else if (scatterMode) { tgtC = g.home[0]; tgtR = g.home[1]; }
    else {
      const h = g.hue & 3;
      if (h === 0) { tgtC = muncher.c; tgtR = muncher.r; }                              // direct chaser
      else if (h === 1) { tgtC = muncher.c + muncher.dx * 4; tgtR = muncher.r + muncher.dy * 4; }  // ambush ahead
      else if (h === 2) { tgtC = muncher.c - muncher.dx * 3; tgtR = muncher.r - muncher.dy * 3; }  // trail behind
      else {                                                                            // shy: backs off when close
        const d2 = (g.c - muncher.c) ** 2 + (g.r - muncher.r) ** 2;
        if (d2 > 36) { tgtC = muncher.c; tgtR = muncher.r; } else { tgtC = g.home[0]; tgtR = g.home[1]; }
      }
    }
    g.prog += speed * dt;
    while (g.prog >= 1) {
      g.prog -= 1; g.c += g.dx; g.r += g.dy;
      // choose dir at the new cell (no per-frame allocation: scalar best dir).
      let bestDx = 0, bestDy = 0, found = false;
      let bestScore = frightened ? -1 : 1e9;
      for (let k = 0; k < 4; k++) {
        const ox = DIRS[k][0], oy = DIRS[k][1];
        if (ox === -g.dx && oy === -g.dy) continue;     // no reverse
        if (!open(g.c + ox, g.r + oy)) continue;
        const tc = g.c + ox, tr = g.r + oy;
        const dd = (tc - tgtC) ** 2 + (tr - tgtR) ** 2 + Math.random() * 1.6;
        // frightened → maximise distance to muncher; chase/scatter → minimise to target.
        if (frightened ? dd > bestScore : dd < bestScore) { bestScore = dd; bestDx = ox; bestDy = oy; found = true; }
      }
      if (found) { g.dx = bestDx; g.dy = bestDy; }
      else { g.dx = -g.dx; g.dy = -g.dy; }              // dead end
    }
  }

  function update(dt, intent, audio, params) {
    lastAudio = audio;
    t += dt;
    chomp += dt * (6 + audio.bands.total * 6);
    if (fright > 0) fright -= dt;
    // Chase ~8s, scatter ~4.5s. During scatter the ghosts head home → the
    // muncher gets a guaranteed safe window to feed.
    modeT -= dt;
    if (modeT <= 0) { scatterMode = !scatterMode; modeT = scatterMode ? 6 : 5; }
    if (caught > 0) { caught -= dt; return; }   // frozen during the catch flash
    if (invuln > 0) invuln -= dt;               // grace counts once play resumes

    // stall watchdog — if the last pellets get permanently camped and nothing's
    // been eaten for a long while, refresh the board so the screen stays alive
    // instead of bleeding score to catches. Competent play eats constantly and
    // never trips this; it only fires on a genuinely unfinishable endgame.
    sinceEat += dt;
    if (sinceEat > 14) {
      newBoard(); placeEntities();
      sinceEat = 0; invuln = 1.0;
      recentCell.fill(-1); recentHead = 0; commit = 0;
    }

    const beat = 1 + audio.beat.pulse * 0.4;
    // 0.8× base pace — ~20% slower than the original for a more ambient chomp
    // (the global `speed` knob in arcade.js scales this further). Ghost speed is
    // derived from mSpeed below, so the muncher keeps its survivable speed edge.
    const mSpeed = 5.2 * 0.8 * beat;
    // Ghosts are ALWAYS capped below the muncher's speed (≤0.82×) — a faster
    // evader can always avoid capture, so this is what makes perfect (expert)
    // play possible. enemyIntensity can speed them up to the cap but never past it.
    const gSpeed = Math.min(mSpeed * 0.75,
      (fright > 0 ? 3.0 : 4.4) * beat * (0.9 + (params.enemyIntensity ?? 1) * 0.2));

    // ── anti-oscillation: if the muncher is trapped ping-ponging (food blocked
    // by a ghost), arm a brief "commit" window so the autopilot pushes through
    // toward the food/power pellet instead of looking dead.
    if (commit > 0) commit -= dt;
    else if (isStuck()) commit = 0.9;

    // ── autopilot direction (always computed; cheap BFS) ─────────────────────
    autopilot();

    // ── blend the player NUDGE with the AI via the autonomy model ────────────
    // Quantize the player lean to a 4-way step; only override the AI when the
    // lean is STRONG (threshold rises with autonomy → at performer-autonomy a
    // hard lean still nudges, at crowd-autonomy any lean steers).
    let pdx = 0, pdy = 0;
    if (Math.abs(intent.x) > Math.abs(intent.y)) pdx = Math.sign(intent.x) | 0;
    else if (Math.abs(intent.y) > 0) pdy = Math.sign(intent.y) | 0;
    const lean = Math.max(Math.abs(intent.x), Math.abs(intent.y));
    const strong = lean > (0.2 + intent.autonomy * 0.6);

    // Player override only when the lean is STRONG *and* points at an OPEN turn
    // from the current cell — leaning into a wall must not stall the muncher, so
    // it falls back to the always-valid autopilot heading. This keeps crowd-mode
    // control tight (any open direction is honoured) without ever deadlocking.
    let ddx = aiDx, ddy = aiDy;                              // autopilot drives
    if (strong && (pdx || pdy) && open(muncher.c + pdx, muncher.r + pdy)) {
      ddx = pdx; ddy = pdy;                                  // player override
    }

    stepMuncher(dt, mSpeed, ddx, ddy);

    for (const g of ghosts) {
      stepGhost(g, dt, gSpeed);
      const dc = (g.c + g.dx * g.prog) - (muncher.c + muncher.dx * muncher.prog);
      const dr = (g.r + g.dy * g.prog) - (muncher.r + muncher.dy * muncher.prog);
      if (dc * dc + dr * dr < 0.36) {
        if (fright > 0) {
          score += 200; eng.shake(3);
          g.c = g.home[0]; g.r = g.home[1]; g.prog = 0;
          [g.dx, g.dy] = openDir(g.c, g.r);
        } else if (invuln <= 0) {
          caught = 1.2; caughtCount++; eng.shake(8); score = Math.max(0, score - 100);
          // soft reset positions + brief respawn grace so the muncher can clear
          // the pack before it's catchable again (breaks the death-loop).
          invuln = 2.0;
          recentCell.fill(-1); recentHead = 0; commit = 0;   // positions reset → stale history
          muncher.c = M_START_C; muncher.r = M_START_R; muncher.prog = 0;
          [muncher.dx, muncher.dy] = openDir(muncher.c, muncher.r);
          for (const gg of ghosts) {
            gg.c = gg.home[0]; gg.r = gg.home[1]; gg.prog = 0;
            [gg.dx, gg.dy] = openDir(gg.c, gg.r);
          }
          break;
        }
      }
    }
    parts.update(dt, 0, 0.92);
  }

  // ── layout + draw ──────────────────────────────────────────────────────────
  function geom() {
    const vw = eng.vw, vh = eng.vh, top = 9;
    const tile = Math.floor(Math.min((vh - top - 2) / ROWS, vw / COLS));
    const ox = Math.floor((vw - COLS * tile) / 2);
    const oy = top + Math.floor((vh - top - ROWS * tile) / 2);
    return { tile, ox, oy };
  }
  const px = (c, prog, dx, g) => g.ox + (c + dx * prog + 0.5) * g.tile;

  // flavor glyph set for scattered code-look (deterministic by cell).
  const FLAVOR = ['0', ';', '/', '%'];
  // per-ghost base colours (hoisted — was a per-frame array literal in render).
  const GHOST_COL = [eng.C.red, eng.C.magenta, eng.C.cyan, eng.C.amber];

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    const audio = lastAudio;
    eng.clear('#03030a');
    const g = geom();
    // Maze walls — subtly tinted by audio spectrum bins.
    const spectrum = audio && audio.spectrum;
    const bassV = audio ? audio.bands.bass : 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      if (!isWall(c, r)) continue;
      const x = g.ox + c * g.tile, y = g.oy + r * g.tile;
      eng.rect(x + 1, y + 1, g.tile - 2, g.tile - 2, '#12235a', 1);
      eng.box(x + 1, y + 1, g.tile - 2, g.tile - 2, eng.C.cyan, 0.5);
      if (spectrum) {
        const bin = ((c * 7 + r * 3) % (spectrum.length >> 1)) + 2;
        const v = spectrum[bin] / 255;
        if (v > 0.15) eng.rect(x + 1, y + 1, g.tile - 2, g.tile - 2, eng.C.magenta, v * 0.12);
      }
    }
    // Pellets as tiny CODE glyphs — the maze reads as eating null-pointers.
    // Glyphs are 3×5 at scale 1; center in the tile with align "center". The y
    // offset (-2) lifts the glyph so its 5px height sits centered on the cell.
    const glow = 0.55 + 0.45 * Math.sin(t * 4);
    const pulse = 0.6 + 0.4 * Math.sin(t * 6);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const v = pellets[r * COLS + c];
      if (!v) continue;
      const cx = g.ox + (c + 0.5) * g.tile, cy = g.oy + (r + 0.5) * g.tile;
      if (v === 2) {
        // power: a brighter PULSING glyph in gold (extra disc glow underneath).
        eng.disc(cx, cy, 1 + glow * 1.2, eng.C.gold, 0.25);
        eng.text('*', cx, cy - 2, eng.C.gold, 1, 'center', pulse);
      } else {
        // normal: a scattered code glyph keyed deterministically by (c*7+r), so
        // the board looks like strewn code but every glyph is clearly food.
        const fg = FLAVOR[(c * 7 + r) & 3];
        eng.text(fg, cx, cy - 2, eng.C.ice, 1, 'center', 0.8);
      }
    }
    // Muncher — a readable gold chomping mouth.
    const m = muncher;
    const mx = px(m.c, m.prog, m.dx, g), my = g.oy + (m.r + m.dy * m.prog + 0.5) * g.tile;
    const rad = g.tile * 0.46;
    const mouth = (0.12 + 0.32 * Math.abs(Math.sin(chomp))) * Math.PI;
    let ang = Math.atan2(m.dy, m.dx); if (m.dx === 0 && m.dy === 0) ang = 0;
    vctx.fillStyle = caught > 0 && (Math.floor(t * 12) & 1) ? eng.C.red : eng.C.gold;
    // blink translucent during respawn grace so the invulnerability reads.
    vctx.globalAlpha = invuln > 0 && (Math.floor(t * 14) & 1) ? 0.4 : 1;
    vctx.beginPath();
    vctx.moveTo(mx, my);
    vctx.arc(mx, my, rad, ang + mouth, ang - mouth + Math.PI * 2);
    vctx.closePath(); vctx.fill();
    vctx.globalAlpha = 1;
    // Ghosts — base colours shift subtly with audio intensity.
    for (const gh of ghosts) {
      const gx = px(gh.c, gh.prog, gh.dx, g), gy = g.oy + (gh.r + gh.dy * gh.prog + 0.5) * g.tile;
      let col;
      if (fright > 0) {
        col = fright < 1.6 && (Math.floor(t * 8) & 1) ? eng.C.white : '#2a4cff';
      } else {
        col = GHOST_COL[gh.hue];
      }
      const s = g.tile * 0.42;
      eng.rect(gx - s, gy - s, s * 2, s * 2 - 1, col, 1);
      eng.disc(gx, gy - s * 0.4, s * 0.95, col, 1);
      // skirt
      for (let k = 0; k < 3; k++) eng.rect(gx - s + k * (s * 0.7), gy + s - 2, s * 0.5, 2, col, 1);
      // eyes
      const ex = Math.sign(gh.dx) * 1.2, ey = Math.sign(gh.dy) * 1.2;
      eng.rect(gx - s * 0.5, gy - s * 0.3, 2, 2, eng.C.white, 1);
      eng.rect(gx + s * 0.2, gy - s * 0.3, 2, 2, eng.C.white, 1);
      eng.rect(gx - s * 0.5 + ex * 0.5, gy - s * 0.3 + ey * 0.5, 1, 1, '#001', 1);
      eng.rect(gx + s * 0.2 + ex * 0.5, gy - s * 0.3 + ey * 0.5, 1, 1, '#001', 1);
      if (bassV > 0.2 && fright <= 0) eng.disc(gx, gy, s * 1.6, col, bassV * 0.12);
    }
    // Spectrum bar along the bottom edge of the maze — a subtle VFD-style EQ.
    if (spectrum) {
      const mazeW = COLS * g.tile;
      eng.spectrumBar(spectrum, g.ox, g.oy + ROWS * g.tile + 1, mazeW, 4, 16, eng.C.cyan, 0.15, 2);
    }
    parts.draw(vctx);

    if (params.hud) {
      eng.beginHud();
      eng.hud(3, 3, 'SCORE', score | 0, eng.C.gold, 'left');
      eng.hud(vw - 3, 3, 'NULLS', remaining, eng.C.ice, 'right');
      if (fright > 0) eng.textOutline('HUNT', vw / 2, 3, eng.C.green, 1, 'center');
      if (intent.source === 'cpu') eng.text('LEAN TO MUNCH', vw / 2, vh * 0.32, eng.C.white, 1, 'center', 0.4 + 0.4 * Math.sin(t * 2));
      eng.endHud();
    }
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    __test: () => ({ deaths: caughtCount, score }),
  };
}
