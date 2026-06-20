// CROSSVOID — the lane-crosser (Frogger lineage), voidstar-skinned. A little
// void-sprite hops from the near shore up through a debris highway, a calm
// median, and a data-river of drifting log-packets to the portal at the top;
// reaching it scores a crossing and it respawns to try again. The crowd /
// performer nudges each hop; otherwise it DRIVES ITSELF.
//
// The brief is explicit: it must NEVER die in auto mode. So the autopilot is
// provably-cautious rather than merely reactive — it only commits to a cell
// when a forward time-sample proves nothing will occupy it for the whole
// exposure window (a car arriving, or a log it would slip off / be carried off
// the edge), and the lane layout brackets every river row with an always-safe
// escape row, so a safe move always exists. A suicidal PLAYER nudge can still
// end a crossing (they're driving) — but the AI itself never walks into death.

// Lane layout, top (goal) → bottom (start). Bracketed so every hazard row has an
// adjacent SAFE row to bail to: river rows sit between the median and the goal.
const LANES = [
  { type: 'goal' },                                       // 0 — the portal
  { type: 'river', dir:  1, speed: 0.9, len: 4, count: 2 },
  { type: 'river', dir: -1, speed: 1.15, len: 4, count: 2 },
  { type: 'safe' },                                       // 3 — median
  { type: 'road',  dir:  1, speed: 1.7,  len: 1.8, count: 2 },
  { type: 'road',  dir: -1, speed: 2.0,  len: 2.0, count: 2 },
  { type: 'road',  dir:  1, speed: 1.5,  len: 1.8, count: 2 },
  { type: 'safe' },                                       // 7 — near shore (start)
];
const ROWS = LANES.length;     // 8
const COLS = 13;

const HOP = 0.13;              // hop animation seconds
const REST = 0.24;             // pause between hop decisions (frogger cadence)
const ROAD_WIN = 0.85;         // road safety look-ahead (leads the hazard by > a hop)
const RIVER_WIN = 0.7;         // river ride-time before next decision
// "On a log" foot half-width. ONE tolerance shared by the ride, the water-death
// check, and the landing check — they must agree, or the avatar can land on a
// log's edge and the next frame's death check disagrees and drops it in.
const RIDE_HALF = 0.4;
// A mounted log must keep the avatar's PROJECTED position within this interior
// band over the ride window, so per-frame `danger` bails it to a safe row well
// before it's carried off. The death edges (below) sit a further 1 cell out, so
// the valid end cells (0 and COLS-1) are landable when the log carries inward.
const RIVER_LO = 0.5, RIVER_HI = COLS - 1.5;

export default function create(eng) {
  // Avatar — continuous column `ax` (rides logs), integer row `ar`. Hops lerp
  // from the current spot to a target grid cell.
  let ax = (COLS - 1) / 2, ar = ROWS - 1;
  let hopping = false, hopT = 0, hopFromX = ax, hopFromR = ar, hopToX = ax, hopToR = ar;
  let decisionCD = 0.4;
  let score = 0, t = 0, deaths = 0, deathFlash = 0, goalFlash = 0;
  let dCar = 0, dWater = 0, dEdge = 0;   // death-cause tally (headless verification probe)
  let lastSide = 0;            // hysteresis for sidestep alignment
  const parts = eng.createParticles(60);

  const CAR_COL = [eng.C.red, eng.C.amber, eng.C.magenta, eng.C.cyan];

  // Build vehicle sets once (per reset). Each lane gets `count` evenly-spaced
  // vehicles on a cylinder of circumference `period`, so gaps are guaranteed.
  function buildLanes() {
    for (let r = 0; r < ROWS; r++) {
      const L = LANES[r];
      if (L.type !== 'road' && L.type !== 'river') { L.vehicles = null; continue; }
      const gap = L.type === 'road' ? 6 : 3;
      L.period = COLS + gap;
      const phase = Math.random() * L.period;
      L.vehicles = [];
      for (let i = 0; i < L.count; i++) {
        L.vehicles.push({ x: (i * L.period / L.count + phase) % L.period, hue: i % CAR_COL.length });
      }
    }
  }

  function respawnStart() {
    ax = Math.round((COLS - 1) / 2); ar = ROWS - 1;
    hopping = false; hopT = 0; hopFromX = hopToX = ax; hopFromR = hopToR = ar;
    decisionCD = 0.4;
  }

  function reset() {
    buildLanes();
    respawnStart();
    score = 0; t = 0; deaths = 0; deathFlash = 0; goalFlash = 0; lastSide = 0;
    parts.clear();
  }

  // Vehicle world-x at `atTime` seconds from now (wrapped to the cylinder).
  function vWorldAt(v, L, atTime) {
    const p = L.period;
    return (((v.x + L.speed * L.dir * atTime) % p) + p) % p;
  }
  const overlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;
  // Does any vehicle in lane L cover [x-halfW, x+halfW] at `atTime`? Checks the
  // wrap copies (±period) so a vehicle straddling the seam still counts.
  function laneCovers(L, x, halfW, atTime) {
    if (!L.vehicles) return false;
    const p = L.period, len = L.len, lo = x - halfW, hi = x + halfW;
    for (let i = 0; i < L.vehicles.length; i++) {
      const wx = vWorldAt(L.vehicles[i], L, atTime);
      if (overlap(wx, wx + len, lo, hi)) return true;
      if (overlap(wx - p, wx - p + len, lo, hi)) return true;
      if (overlap(wx + p, wx + p + len, lo, hi)) return true;
    }
    return false;
  }
  // Is cell-centre `x` at least `margin` INSIDE some log (containment, not mere
  // overlap)? Landings use this so the avatar always lands well clear of a log's
  // ends — a tiny prediction error (beat / frame quantization) then can't drop it
  // off the trailing edge the very next frame, which is how every water death
  // happened. The ride/death checks stay lenient (laneCovers) so it never falls
  // off a log it's genuinely riding.
  function logContains(L, x, margin, atTime) {
    if (!L.vehicles) return false;
    const p = L.period, len = L.len;
    for (let i = 0; i < L.vehicles.length; i++) {
      const wx = vWorldAt(L.vehicles[i], L, atTime);
      if ((x >= wx + margin && x <= wx + len - margin) ||
          (x >= wx - p + margin && x <= wx - p + len - margin) ||
          (x >= wx + p + margin && x <= wx + p + len - margin)) return true;
    }
    return false;
  }

  // Safe to HOP to grid cell (row,x)? Samples the exposure window so nothing
  // occupies the cell while the avatar is landing + resting there.
  function moveSafe(row, x) {
    if (row < 0 || row >= ROWS || x < 0 || x > COLS - 1) return false;
    const L = LANES[row];
    if (L.type === 'safe' || L.type === 'goal') return true;
    if (L.type === 'road') {
      for (let tt = HOP; tt <= HOP + ROAD_WIN; tt += 0.06) if (laneCovers(L, x, 0.5, tt)) return false;
      return true;
    }
    // river: the cell must land CENTRALLY inside a log (margin > any prediction
    // error), and riding it must keep the avatar clear of the death edges over
    // the window. Checked at both the landing instant and a touch later so a fast
    // log can't have its trailing edge slide past the avatar right after landing.
    if (!logContains(L, x, 0.75, HOP) || !logContains(L, x, 0.5, HOP + 0.12)) return false;
    const endX = x + L.speed * L.dir * (HOP + RIVER_WIN);
    return endX >= RIVER_LO && endX <= RIVER_HI;
  }
  // Safe to STAY at the current spot for the look-ahead window?
  function staySafe(row, x) {
    const L = LANES[row];
    if (L.type === 'safe' || L.type === 'goal') return true;
    if (L.type === 'road') {
      for (let tt = 0; tt <= ROAD_WIN; tt += 0.06) if (laneCovers(L, x, 0.5, tt)) return false;
      return true;
    }
    // river: must be on a log now and not be carried off within the window.
    if (!laneCovers(L, x, RIDE_HALF, 0)) return false;
    const endX = x + L.speed * L.dir * RIVER_WIN;
    return endX >= RIVER_LO && endX <= RIVER_HI;
  }

  // Autopilot move — forward-biased but survival-first. Returns {dr,dx}.
  function autopilotMove() {
    const cx = Math.round(ax);
    if (moveSafe(ar - 1, cx)) { lastSide = 0; return { dr: -1, dx: 0 }; }   // progress when safe
    const fwdRow = ar - 1;
    const fwdHaz = fwdRow >= 0 && LANES[fwdRow].type !== 'safe' && LANES[fwdRow].type !== 'goal';
    if (staySafe(ar, ax)) {
      // Waiting is safe. If forward is blocked by a hazard, drift sideways to a
      // spot where forward WILL be safe (align with a gap/log), with hysteresis
      // so it doesn't jitter. Otherwise just wait for the opening.
      if (fwdHaz) {
        const tryL = cx - 1 >= 0 && moveSafe(ar, cx - 1) && moveSafe(fwdRow, cx - 1);
        const tryR = cx + 1 <= COLS - 1 && moveSafe(ar, cx + 1) && moveSafe(fwdRow, cx + 1);
        if (tryL && (!tryR || lastSide <= 0)) { lastSide = -1; return { dr: 0, dx: -1 }; }
        if (tryR) { lastSide = 1; return { dr: 0, dx: 1 }; }
      }
      return { dr: 0, dx: 0 };
    }
    // Current cell is going unsafe — MUST move. Prefer a safe sidestep, then a
    // retreat to the bracketing safe row (always available next to river rows).
    if (cx - 1 >= 0 && moveSafe(ar, cx - 1)) { lastSide = -1; return { dr: 0, dx: -1 }; }
    if (cx + 1 <= COLS - 1 && moveSafe(ar, cx + 1)) { lastSide = 1; return { dr: 0, dx: 1 }; }
    if (moveSafe(ar + 1, cx)) return { dr: 1, dx: 0 };            // bail backward to safety
    if (moveSafe(ar - 1, cx)) return { dr: -1, dx: 0 };          // forward escape (goal side)
    return { dr: 0, dx: 0 };                                      // nothing — hold (shouldn't happen)
  }

  function startHop(dx, dr) {
    if (dx === 0 && dr === 0) { decisionCD = REST; return; }      // chose to wait
    const cx = Math.round(ax);
    let tx = cx + dx, trow = ar + dr;
    tx = Math.max(0, Math.min(COLS - 1, tx));
    trow = Math.max(0, Math.min(ROWS - 1, trow));
    hopFromX = ax; hopFromR = ar; hopToX = tx; hopToR = trow;
    hopping = true; hopT = 0;
  }

  // Player hop from a strong directional intent (non-auto). Edge-style: one hop
  // per decision tick. Returns true if it issued a hop.
  function playerMove(intent) {
    const strong = Math.max(Math.abs(intent.x), Math.abs(intent.y)) > 0.4 || intent.jump || intent.down;
    if (!strong) return false;
    if (intent.jump) { startHop(0, -1); return true; }            // hands up → forward
    if (intent.down) { startHop(0, 1); return true; }
    if (Math.abs(intent.x) >= Math.abs(intent.y)) {
      if (intent.x < -0.4) { startHop(-1, 0); return true; }
      if (intent.x > 0.4) { startHop(1, 0); return true; }
    } else if (intent.y < -0.4) { startHop(0, -1); return true; }
    return false;
  }

  function land() {
    ax = hopToX; ar = hopToR; hopping = false; decisionCD = REST;
    if (ar === 0) {                                              // reached the portal
      score += 1; goalFlash = 0.5; eng.shake(2);
      const gx = ax, gy = 0;
      for (let k = 0; k < 14; k++) {
        const a = Math.random() * 6.28, sp = 25 + Math.random() * 60;
        parts.spawn(gx, gy, Math.cos(a) * sp, Math.sin(a) * sp, 0.4, k & 1 ? eng.C.gold : eng.C.cyan, 2);
      }
      respawnStart();
    }
  }

  function die() {
    deaths++; deathFlash = 0.6; eng.shake(5);
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * 6.28, sp = 20 + Math.random() * 50;
      parts.spawn(ax, ar, Math.cos(a) * sp, Math.sin(a) * sp, 0.4, eng.C.red, 2);
    }
    respawnStart();
  }

  function update(dt, intent, audio, params) {
    t += dt;
    if (deathFlash > 0) deathFlash -= dt;
    if (goalFlash > 0) goalFlash -= dt;

    // Advance vehicles (a gentle beat shimmer on their pace).
    const beat = 1 + audio.beat.pulse * 0.15;
    for (let r = 0; r < ROWS; r++) {
      const L = LANES[r];
      if (!L.vehicles) continue;
      for (let i = 0; i < L.vehicles.length; i++) {
        const v = L.vehicles[i];
        v.x = (((v.x + L.speed * L.dir * beat * dt) % L.period) + L.period) % L.period;
      }
    }

    if (hopping) {
      hopT += dt / HOP;
      if (hopT >= 1) land();
      parts.update(dt, 0, 0.9);
      return;
    }

    // Resting: ride the log if on a river row.
    const L = LANES[ar];
    if (L.type === 'river') {
      if (laneCovers(L, ax, RIDE_HALF, 0)) ax += L.speed * L.dir * beat * dt;   // carried by the log
    }

    // Death checks (only while resting — the hop arc is brief and its landing
    // was proven safe). In auto the autopilot acts well before any of these trip;
    // the cause tallies are exposed via __test for headless verification.
    if (L.type === 'road') { if (laneCovers(L, ax, 0.45, 0)) { dCar++; die(); return; } }
    else if (L.type === 'river') {
      if (!laneCovers(L, ax, RIDE_HALF, 0)) { dWater++; die(); return; }   // off the log → water
      else if (ax < -0.5 || ax > COLS - 0.5) { dEdge++; die(); return; }  // carried off the playfield
    }

    // Decision — on the normal hop cadence, OR the instant the current spot is
    // about to go unsafe (a car closing in, or a log carrying us toward the edge
    // / off the end). This per-frame danger check is what makes the autopilot
    // genuinely never-die in auto: staySafe leads every hazard by more than a
    // hop, and the layout brackets every river row with an always-safe escape,
    // so it bails to safety long before anything can reach it.
    decisionCD -= dt;
    const danger = !staySafe(ar, ax);
    if (decisionCD <= 0 || danger) {
      let handled = false;
      // Player override only when they're meaningfully in control (low autonomy);
      // in auto/expert the AI keeps full control so it never dies.
      if (intent.autonomy < 0.5) handled = playerMove(intent);
      if (!handled) { const m = autopilotMove(); startHop(m.dx, m.dr); }
    }
    parts.update(dt, 0, 0.9);
  }

  // ── layout + draw ──────────────────────────────────────────────────────────
  function geom() {
    const vw = eng.vw, vh = eng.vh, top = 9;
    const tile = Math.max(4, Math.floor(Math.min((vh - top - 2) / ROWS, vw / COLS)));
    const ox = Math.floor((vw - COLS * tile) / 2);
    const oy = top + Math.floor((vh - top - ROWS * tile) / 2);
    return { tile, ox, oy };
  }

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    eng.clear('#04040e');
    const g = geom();
    const W = COLS * g.tile;

    // Lane bands.
    for (let r = 0; r < ROWS; r++) {
      const L = LANES[r], y = g.oy + r * g.tile;
      let col = '#0a1226';
      if (L.type === 'safe') col = '#10261a';
      else if (L.type === 'road') col = (r & 1) ? '#15131f' : '#191622';
      else if (L.type === 'river') col = (r & 1) ? '#08152e' : '#0a1838';
      else if (L.type === 'goal') col = '#1a1230';
      eng.rect(g.ox, y, W, g.tile, col, 1);
      if (L.type === 'safe') {                                  // grass speckle
        for (let c = 0; c < COLS; c += 2) eng.rect(g.ox + c * g.tile + 1, y + g.tile - 2, 1, 1, eng.C.green, 0.5);
      }
    }
    // Goal portal glow on the top row.
    const gy0 = g.oy;
    eng.rect(g.ox, gy0, W, g.tile, eng.C.magenta, 0.06 + (goalFlash > 0 ? 0.25 : 0.04 + 0.04 * Math.sin(t * 3)));
    for (let c = 0; c < COLS; c += 3) {
      const cxp = g.ox + (c + 0.5) * g.tile;
      eng.disc(cxp, gy0 + g.tile * 0.5, 1.5, eng.C.magenta, 0.5 + 0.3 * Math.sin(t * 4 + c));
    }
    eng.box(g.ox, g.oy, W, ROWS * g.tile, eng.C.dim, 0.4);

    // Vehicles.
    for (let r = 0; r < ROWS; r++) {
      const L = LANES[r];
      if (!L.vehicles) continue;
      const y = g.oy + r * g.tile;
      for (let i = 0; i < L.vehicles.length; i++) {
        const wx = vWorldAt(L.vehicles[i], L, 0);
        // draw the vehicle at wx and its wrap copy (one will be off-screen).
        for (const base of [wx, wx - L.period]) {
          const x = g.ox + base * g.tile, w = L.len * g.tile;
          if (x + w < g.ox || x > g.ox + W) continue;
          if (L.type === 'road') {
            const col = CAR_COL[L.vehicles[i].hue];
            eng.rect(x + 1, y + 2, w - 2, g.tile - 4, col, 1);
            eng.rect(x + w * 0.18, y + 2, w * 0.64, g.tile * 0.3, '#0a1430', 1);   // window
            // headlights point in travel dir
            const hx = L.dir > 0 ? x + w - 2 : x;
            eng.rect(hx, y + 2, 2, g.tile - 4, eng.C.white, 0.8);
          } else {
            // log-packet: a teal/brown bar with code-glyph rivets
            eng.rect(x, y + 2, w, g.tile - 4, '#3a2c1e', 1);
            eng.rect(x, y + 2, w, 1, '#5c4630', 1);
            eng.rect(x, y + g.tile - 3, w, 1, '#241a10', 1);
            for (let s = 0; s < L.len; s++) eng.rect(x + s * g.tile + g.tile * 0.5, y + g.tile * 0.5 - 1, 1, 1, eng.C.ice, 0.5);
          }
        }
      }
    }

    // Avatar.
    let avx, avr;
    if (hopping) {
      avx = hopFromX + (hopToX - hopFromX) * hopT;
      avr = hopFromR + (hopToR - hopFromR) * hopT;
    } else { avx = ax; avr = ar; }
    const px = g.ox + (avx + 0.5) * g.tile, py = g.oy + (avr + 0.5) * g.tile;
    const hop = hopping ? Math.sin(hopT * Math.PI) : 0;          // little arc squash
    const rad = g.tile * (0.34 + hop * 0.06);
    const body = deathFlash > 0 && (Math.floor(t * 12) & 1) ? eng.C.red : eng.C.green;
    eng.disc(px, py - hop * g.tile * 0.25, rad, body, 1);
    eng.disc(px, py - hop * g.tile * 0.25, rad * 0.62, '#1a3a26', 0.5);
    // eyes (look upward — toward the goal)
    eng.rect(px - rad * 0.45, py - hop * g.tile * 0.25 - rad * 0.5, 1.5, 1.5, eng.C.white, 1);
    eng.rect(px + rad * 0.25, py - hop * g.tile * 0.25 - rad * 0.5, 1.5, 1.5, eng.C.white, 1);
    parts.draw(vctx);

    if (params.hud) {
      eng.beginHud();
      eng.hud(3, 3, 'CROSS', score | 0, eng.C.gold, 'left');
      eng.hud(vw - 3, 3, 'ROW', (ROWS - 1 - ar), eng.C.ice, 'right');
      if (intent.source === 'cpu') eng.text('LEAN TO HOP', vw / 2, vh * 0.30, eng.C.white, 1, 'center', 0.4 + 0.4 * Math.sin(t * 2));
      eng.endHud();
    }
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    __test: () => ({ deaths, score, row: ROWS - 1 - ar, dCar, dWater, dEdge }),
  };
}
