// THE CORRIDOR — the raycaster (Doom / Wolfenstein lineage), voidstar-skinned.
// A first-person glide through the machine: neon stained-glass walls, a glowing
// horizon, glitch-wraiths drifting the halls that a null-cannon picks off. It
// DRIVES ITSELF — the camera threads a freshly generated maze, choosing turns
// at every junction and never walking into a wall (corridor-locked movement, so
// there's nothing to die to — it's a calm, ambient crawl). The crowd / performer
// leans to look around and bias which way it turns. enemyIntensity scales how
// many wraiths haunt the halls.
//
// Classic DDA grid raycast into the cabinet framebuffer (one ray per virtual
// column, a few hundred), depth-buffered billboard wraiths, a precomputed wall
// shade ramp (zero per-frame string allocation). Authentically retro + cheap.

const MAPW = 21, MAPH = 21;
const DIR4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // E, S, W, N
const TAN_HALF_FOV = 0.66;                          // ~66° field of view

// Build a brightness ramp (dark→bright) of `n` hex strings from a base rgb, so
// per-column wall shading is a array lookup, never a string build.
function buildRamp(r, g, b, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const rr = Math.round(r * k), gg = Math.round(g * k), bb = Math.round(b * k);
    out[i] = '#' + ((1 << 24) + (rr << 16) + (gg << 8) + bb).toString(16).slice(1);
  }
  return out;
}

export default function create(eng) {
  const map = new Uint8Array(MAPW * MAPH);
  const RAMP_N = 18;
  // Two wall "materials" (cyan-steel / magenta-steel), each with a lit (x-side)
  // and shadowed (y-side) ramp → the stained-glass-machine read.
  const RAMPS = [
    [buildRamp(90, 200, 255, RAMP_N), buildRamp(55, 120, 165, RAMP_N)],   // material A: cyan
    [buildRamp(255, 90, 230, RAMP_N), buildRamp(160, 55, 150, RAMP_N)],   // material B: magenta
  ];
  const zbuf = new Float32Array(640);   // engine caps vw at 640

  // Camera: corridor-locked. (cellC,cellR) current floor cell, moving along
  // moveDir toward the next cell; prog 0..1. View angle eases toward the heading
  // (+ a look offset from the player). Position is derived — never inside a wall.
  let cellC = 1, cellR = 1, moveDir = 0, prog = 0;
  let px = 1.5, py = 1.5, viewAng = 0, lookOff = 0;
  let t = 0, score = 0, fireT = 0, muzzle = 0, bob = 0;
  let lastAudio = null;

  const ENEMY_CAP = 6;
  const enemies = [];
  for (let i = 0; i < ENEMY_CAP; i++) enemies.push({ alive: false, x: 0, y: 0, hue: 0, bob: 0, dissolve: 0, depth: 0, sx: 0, tx: 0, vis: false, _lastSx: 0 });
  const parts = eng.createParticles(80);
  // billboard draw order scratch (indices sorted far→near) — no per-frame alloc.
  const order = new Int16Array(ENEMY_CAP);

  // ── maze generation (recursive backtracker, then a little braiding) ────────
  const stackX = new Int16Array(MAPW * MAPH), stackY = new Int16Array(MAPW * MAPH);
  function genMaze() {
    map.fill(1);
    let sp = 0;
    map[1 * MAPW + 1] = 0; stackX[sp] = 1; stackY[sp] = 1; sp++;
    const order4 = [0, 1, 2, 3];
    while (sp > 0) {
      const x = stackX[sp - 1], y = stackY[sp - 1];
      // shuffle the 4 directions
      for (let i = 3; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const tmp = order4[i]; order4[i] = order4[j]; order4[j] = tmp; }
      let carved = false;
      for (let k = 0; k < 4; k++) {
        const d = order4[k], nx = x + DIR4[d][0] * 2, ny = y + DIR4[d][1] * 2;
        if (nx <= 0 || ny <= 0 || nx >= MAPW - 1 || ny >= MAPH - 1) continue;
        if (map[ny * MAPW + nx] === 0) continue;
        map[(y + DIR4[d][1]) * MAPW + (x + DIR4[d][0])] = 0;   // knock the wall between
        map[ny * MAPW + nx] = 0;
        stackX[sp] = nx; stackY[sp] = ny; sp++;
        carved = true; break;
      }
      if (!carved) sp--;
    }
    // braid: open a few extra walls for loops so it plays less like a tree.
    for (let b = 0; b < 18; b++) {
      const x = 1 + ((Math.random() * (MAPW - 2)) | 0), y = 1 + ((Math.random() * (MAPH - 2)) | 0);
      if (map[y * MAPW + x] === 1 && ((x & 1) !== (y & 1))) {   // an edge wall
        // only open if it joins two floor cells (keeps it navigable, not a pocket)
        const horiz = (x & 1) === 0;
        const a = horiz ? map[y * MAPW + x - 1] : map[(y - 1) * MAPW + x];
        const c = horiz ? map[y * MAPW + x + 1] : map[(y + 1) * MAPW + x];
        if (a === 0 && c === 0) map[y * MAPW + x] = 0;
      }
    }
  }

  function floorCellFar(fromC, fromR, minDist) {
    for (let tries = 0; tries < 40; tries++) {
      const x = 1 + ((Math.random() * (MAPW - 2)) | 0), y = 1 + ((Math.random() * (MAPH - 2)) | 0);
      if (map[y * MAPW + x] !== 0) continue;
      if (Math.abs(x - fromC) + Math.abs(y - fromR) < minDist) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
    return null;
  }

  function spawnEnemy(e) {
    const cell = floorCellFar(cellC, cellR, 4);
    if (!cell) { e.alive = false; return; }
    e.alive = true; e.x = cell.x; e.y = cell.y; e.hue = (Math.random() * 3) | 0;
    e.bob = Math.random() * 6.28; e.dissolve = 0;
  }

  function openDirFrom(c, r) {
    for (let d = 0; d < 4; d++) if (map[(r + DIR4[d][1]) * MAPW + (c + DIR4[d][0])] === 0) return d;
    return 0;
  }

  function reset() {
    genMaze();
    cellC = 1; cellR = 1; prog = 0; moveDir = openDirFrom(1, 1);
    px = cellC + 0.5; py = cellR + 0.5;
    viewAng = Math.atan2(DIR4[moveDir][1], DIR4[moveDir][0]); lookOff = 0;
    t = 0; score = 0; fireT = 0.5; muzzle = 0; bob = 0;
    for (let i = 0; i < ENEMY_CAP; i++) enemies[i].alive = false;
    parts.clear();
  }

  // Choose the heading for the next leg at a junction. Prefer straight; never
  // reverse unless it's a dead end; bias toward the player's lean when they're
  // in control (low autonomy).
  function chooseDir(intent) {
    const rev = (moveDir + 2) & 3;
    let openMask = 0, nOpen = 0;
    for (let d = 0; d < 4; d++) {
      if (map[(cellR + DIR4[d][1]) * MAPW + (cellC + DIR4[d][0])] === 0) { openMask |= (1 << d); nOpen++; }
    }
    const canStraight = (openMask & (1 << moveDir)) !== 0;
    // player turn bias: lean right → prefer the right-hand turn, etc.
    const lean = intent.x;
    if (intent.autonomy < 0.6 && Math.abs(lean) > 0.35) {
      const turn = lean > 0 ? (moveDir + 1) & 3 : (moveDir + 3) & 3;
      if (openMask & (1 << turn)) return turn;
    }
    if (canStraight && Math.random() < 0.62) return moveDir;
    // pick a random open non-reverse dir; fall back to reverse only if dead-end.
    const choices = [];
    for (let d = 0; d < 4; d++) if ((openMask & (1 << d)) && d !== rev) choices.push(d);
    if (choices.length === 0) return rev;          // dead end → turn around
    return choices[(Math.random() * choices.length) | 0];
  }

  function update(dt, intent, audio, params) {
    lastAudio = audio;
    t += dt;
    if (muzzle > 0) muzzle -= dt;

    // ── camera glide along the corridor ──────────────────────────────────────
    const speed = 1.15 * 0.75 * (0.85 + (params.enemyIntensity ?? 1) * 0.2) * (1 + audio.beat.pulse * 0.15);
    prog += speed * dt;
    while (prog >= 1) {
      prog -= 1;
      cellC += DIR4[moveDir][0]; cellR += DIR4[moveDir][1];
      moveDir = chooseDir(intent);
    }
    px = cellC + 0.5 + DIR4[moveDir][0] * prog;
    py = cellR + 0.5 + DIR4[moveDir][1] * prog;
    bob += speed * dt * 6;
    // view: ease toward the heading; the player's lean adds a look offset.
    // Arcing turn: start easing the view early (at prog 0.55) so the camera
    // sweeps into corners well before reaching the junction cell, giving a
    // smooth arc rather than a last-instant snap.
    const targetLook = intent.x * 0.5;
    lookOff += (targetLook - lookOff) * Math.min(1, dt * 4);
    const headAng = Math.atan2(DIR4[moveDir][1], DIR4[moveDir][0]);
    // Check if the next cell after the current leg is a turn — if so,
    // pre-blend the heading toward the upcoming direction for an arc.
    const nextC = cellC + DIR4[moveDir][0], nextR = cellR + DIR4[moveDir][1];
    let peekAng = headAng;
    if (prog > 0.3 && nextC >= 0 && nextR >= 0 && nextC < MAPW && nextR < MAPH && map[nextR * MAPW + nextC] === 0) {
      let peekDir = moveDir;
      for (let d = 0; d < 4; d++) {
        if (d === ((moveDir + 2) & 3)) continue;
        if (map[(nextR + DIR4[d][1]) * MAPW + (nextC + DIR4[d][0])] === 0) {
          if (d !== moveDir) { peekDir = d; break; }
        }
      }
      if (peekDir !== moveDir) {
        const peekA = Math.atan2(DIR4[peekDir][1], DIR4[peekDir][0]);
        const blend = Math.max(0, (prog - 0.3) / 0.7);
        const smoothBlend = blend * blend * (3 - 2 * blend);
        let dp = peekA - headAng;
        while (dp > Math.PI) dp -= Math.PI * 2;
        while (dp < -Math.PI) dp += Math.PI * 2;
        peekAng = headAng + dp * smoothBlend * 0.65;
      }
    }
    let da = peekAng + lookOff - viewAng;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    viewAng += da * Math.min(1, dt * 4);

    // ── enemies ──────────────────────────────────────────────────────────────
    const wantCount = Math.max(1, Math.min(ENEMY_CAP, Math.round(2 + (params.enemyIntensity ?? 1) * 2)));
    let live = 0;
    for (let i = 0; i < ENEMY_CAP; i++) if (enemies[i].alive && enemies[i].dissolve <= 0) live++;
    for (let i = 0; i < ENEMY_CAP && live < wantCount; i++) {
      if (!enemies[i].alive) { spawnEnemy(enemies[i]); live++; }
    }
    // dissolve timers + respawn.
    for (let i = 0; i < ENEMY_CAP; i++) {
      const e = enemies[i];
      if (!e.alive) continue;
      e.bob += dt * 2;
      if (e.dissolve > 0) { e.dissolve -= dt; if (e.dissolve <= 0) e.alive = false; }
    }

    // ── auto null-cannon: fire when a wraith sits near the crosshair, in view,
    // and not occluded by a wall. (No player damage — purely offensive flavour.)
    fireT -= dt;
    if (fireT <= 0) {
      const dx = Math.cos(viewAng), dy = Math.sin(viewAng);
      const planeX = -dy * TAN_HALF_FOV, planeY = dx * TAN_HALF_FOV;
      const invDet = 1 / (planeX * dy - dx * planeY);
      let target = -1, targetDepth = 1e9;
      for (let i = 0; i < ENEMY_CAP; i++) {
        const e = enemies[i];
        if (!e.alive || e.dissolve > 0) continue;
        const rx = e.x - px, ry = e.y - py;
        const tx = invDet * (dy * rx - dx * ry);
        const ty = invDet * (-planeY * rx + planeX * ry);   // depth
        if (ty <= 0.2) continue;
        if (Math.abs(tx / ty) > 0.16) continue;             // not near the crosshair
        // line of sight: the wall straight ahead must be farther than the wraith.
        if (wallDistAhead(px, py, dx, dy) < ty) continue;
        if (ty < targetDepth) { targetDepth = ty; target = i; }
      }
      if (target >= 0) {
        const e = enemies[target];
        e.dissolve = 0.45; score += 1; muzzle = 0.12; eng.shake(1.5); fireT = 0.5;
        for (let k = 0; k < 12; k++) {
          const a = Math.random() * 6.28, sp = 0.4 + Math.random() * 1.2;
          // store particle in screen space at fire-time projection (drawn over the scene)
          parts.spawn(e._lastSx || eng.vw / 2, eng.vh * 0.5, Math.cos(a) * 40, Math.sin(a) * 40, 0.3, k & 1 ? eng.C.cyan : eng.C.magenta, 2);
        }
      } else { fireT = 0.18; }    // nothing centred → re-check soon
    }
    parts.update(dt, 0, 0.92);
  }

  // Distance to the first wall along (dx,dy) from (sx,sy) — a single DDA used
  // for the cannon's line-of-sight test.
  function wallDistAhead(sx, sy, dx, dy) {
    let mapX = sx | 0, mapY = sy | 0;
    const dDX = Math.abs(1 / dx), dDY = Math.abs(1 / dy);
    let stepX, stepY, sdX, sdY;
    if (dx < 0) { stepX = -1; sdX = (sx - mapX) * dDX; } else { stepX = 1; sdX = (mapX + 1 - sx) * dDX; }
    if (dy < 0) { stepY = -1; sdY = (sy - mapY) * dDY; } else { stepY = 1; sdY = (mapY + 1 - sy) * dDY; }
    let side = 0, guard = 0;
    while (guard++ < 64) {
      if (sdX < sdY) { sdX += dDX; mapX += stepX; side = 0; } else { sdY += dDY; mapY += stepY; side = 1; }
      if (mapX < 0 || mapY < 0 || mapX >= MAPW || mapY >= MAPH) return 99;
      if (map[mapY * MAPW + mapX] > 0) break;
    }
    return side === 0 ? (mapX - sx + (1 - stepX) / 2) / dx : (mapY - sy + (1 - stepY) / 2) / dy;
  }

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    const horizon = (vh * 0.5) | 0;
    // Ceiling + floor (a faint horizon glow where they meet).
    eng.rect(0, 0, vw, horizon, '#0a0820', 1);
    eng.rect(0, horizon, vw, vh - horizon, '#0c1020', 1);
    eng.rect(0, horizon - 1, vw, 2, eng.C.gold, 0.10);

    const dx = Math.cos(viewAng), dy = Math.sin(viewAng);
    const planeX = -dy * TAN_HALF_FOV, planeY = dx * TAN_HALF_FOV;

    const audio = lastAudio;
    const spectrum = audio && audio.spectrum;
    const bassV = audio ? audio.bands.bass : 0;

    // ── wall cast: one ray per column ─────────────────────────────────────────
    for (let x = 0; x < vw; x++) {
      const cameraX = 2 * x / vw - 1;
      const rdx = dx + planeX * cameraX, rdy = dy + planeY * cameraX;
      let mapX = px | 0, mapY = py | 0;
      const dDX = Math.abs(1 / rdx), dDY = Math.abs(1 / rdy);
      let stepX, stepY, sdX, sdY;
      if (rdx < 0) { stepX = -1; sdX = (px - mapX) * dDX; } else { stepX = 1; sdX = (mapX + 1 - px) * dDX; }
      if (rdy < 0) { stepY = -1; sdY = (py - mapY) * dDY; } else { stepY = 1; sdY = (mapY + 1 - py) * dDY; }
      let side = 0, hit = 0, guard = 0;
      while (!hit && guard++ < 64) {
        if (sdX < sdY) { sdX += dDX; mapX += stepX; side = 0; } else { sdY += dDY; mapY += stepY; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= MAPW || mapY >= MAPH) { hit = 2; break; }
        if (map[mapY * MAPW + mapX] > 0) hit = 1;
      }
      let perp = side === 0 ? (mapX - px + (1 - stepX) / 2) / rdx : (mapY - py + (1 - stepY) / 2) / rdy;
      if (perp < 0.02) perp = 0.02;
      zbuf[x] = perp;
      if (hit === 2) continue;
      const lh = Math.min(vh * 4, vh / perp);
      const y0 = Math.max(0, ((vh - lh) / 2) | 0), y1 = Math.min(vh, ((vh + lh) / 2) | 0);
      const mat = ((mapX + mapY) & 1);
      const shade = Math.max(0.12, Math.min(1, 1 - (perp - 0.5) / 14));
      const lvl = Math.max(0, Math.min(RAMP_N - 1, (shade * (RAMP_N - 1)) | 0));
      eng.rect(x, y0, 1, y1 - y0, RAMPS[mat][side][lvl], 1);
      if (y1 - y0 > 6) eng.rect(x, y0, 1, 1, RAMPS[mat][0][RAMP_N - 1], 0.5);
      // Spectrum EQ on the wall surface: each column samples a spectrum bin
      // mapped by its screen-x position, drawn as a small bar rising from the
      // wall's vertical midpoint. Only on near walls (perp < 6) for perf.
      if (spectrum && perp < 6 && y1 - y0 > 8) {
        const si = Math.min(spectrum.length - 1, ((x * (spectrum.length >> 1) / vw) | 0) + 2);
        const v = spectrum[si] / 255;
        if (v > 0.1) {
          const barH = (y1 - y0) * v * 0.3;
          const midY = (y0 + y1) >> 1;
          const eqCol = mat === 0 ? eng.C.cyan : eng.C.magenta;
          eng.rect(x, midY - barH * 0.5, 1, barH, eqCol, v * 0.38 * shade);
        }
      }
    }

    // ── billboard wraiths (depth-sorted far→near, z-tested per column) ────────
    const invDet = 1 / (planeX * dy - dx * planeY);
    let nVis = 0;
    for (let i = 0; i < ENEMY_CAP; i++) {
      const e = enemies[i];
      e.vis = false;
      if (!e.alive) continue;
      const rx = e.x - px, ry = e.y - py;
      const tx = invDet * (dy * rx - dx * ry);
      const ty = invDet * (-planeY * rx + planeX * ry);
      if (ty <= 0.25) continue;
      e.depth = ty; e.tx = tx; e.sx = (vw / 2) * (1 + tx / ty); e.vis = true; e._lastSx = e.sx;
      order[nVis++] = i;
    }
    // insertion sort by depth desc (nVis ≤ 6)
    for (let a = 1; a < nVis; a++) {
      const v = order[a]; let b = a - 1;
      while (b >= 0 && enemies[order[b]].depth < enemies[v].depth) { order[b + 1] = order[b]; b--; }
      order[b + 1] = v;
    }
    for (let o = 0; o < nVis; o++) {
      const e = enemies[order[o]];
      const size = Math.min(vh * 1.5, (vh / e.depth));
      const w = size * 0.42;
      const cxp = e.sx, top = (vh * 0.5 - size * 0.5 + Math.sin(e.bob) * size * 0.04) | 0;
      const alpha = e.dissolve > 0 ? Math.max(0, e.dissolve / 0.45) : 1;
      const baseCol = [eng.C.magenta, eng.C.cyan, eng.C.green][e.hue];
      const x0 = Math.max(0, (cxp - w / 2) | 0), x1 = Math.min(vw, (cxp + w / 2) | 0);
      for (let sx = x0; sx < x1; sx++) {
        if (e.depth >= zbuf[sx]) continue;             // behind a wall → occluded
        const fx = (sx - cxp) / (w / 2);               // -1..1 across the body
        const taper = 1 - Math.abs(fx) * 0.5;
        const h = size * (0.78 * taper);
        eng.rect(sx, top + size * 0.5 - h * 0.5, 1, h, baseCol, 0.45 * alpha);
      }
      // glowing core "head".
      if (e.depth < zbuf[Math.max(0, Math.min(vw - 1, cxp | 0))]) {
        eng.disc(cxp, top + size * 0.30, Math.max(1.5, w * 0.18), eng.C.white, 0.7 * alpha);
        eng.disc(cxp, top + size * 0.30, Math.max(2.5, w * 0.3), baseCol, 0.35 * alpha);
      }
    }

    // muzzle / cannon / crosshair (drawn over the scene, screen-space).
    parts.draw(vctx);
    drawWeapon(vw, vh);

    if (params.hud) {
      eng.beginHud();
      eng.hud(3, 3, 'SCORE', score | 0, eng.C.gold, 'left');
      eng.hud(vw - 3, 3, 'DEPTH', (cellC + cellR), eng.C.cyan, 'right');
      if (intent.source === 'cpu') eng.text('LEAN TO LOOK', vw / 2, vh * 0.28, eng.C.white, 1, 'center', 0.4 + 0.4 * Math.sin(t * 2));
      eng.endHud();
    }
  }

  function drawWeapon(vw, vh) {
    const cx = vw * 0.5, bobY = Math.sin(bob) * 1.6, bobX = Math.cos(bob * 0.5) * 1.2;
    // crosshair
    const ch = vh * 0.5;
    eng.rect(cx - 4, ch, 8, 1, eng.C.white, 0.5);
    eng.rect(cx, ch - 4, 1, 8, eng.C.white, 0.5);
    // null-cannon at bottom centre (a chunky barrel + housing).
    const gy = vh - 1 + bobY;
    const recoil = muzzle > 0 ? 3 : 0;
    eng.rect(cx - 6 + bobX, gy - 14 + recoil, 12, 16, '#1a2030', 1);
    eng.rect(cx - 6 + bobX, gy - 14 + recoil, 12, 2, '#2c3850', 1);
    eng.rect(cx - 2.5 + bobX, gy - 22 + recoil, 5, 10, '#0e1422', 1);     // barrel
    eng.rect(cx - 2.5 + bobX, gy - 22 + recoil, 5, 1, eng.C.cyan, 0.6);
    if (muzzle > 0) {
      const a = muzzle / 0.12;
      eng.disc(cx + bobX, gy - 23 + recoil, 4 + a * 5, eng.C.gold, 0.8 * a);
      eng.disc(cx + bobX, gy - 23 + recoil, 2 + a * 3, eng.C.white, a);
    }
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    __test: () => ({ deaths: 0, score, c: cellC, r: cellR }),
  };
}
