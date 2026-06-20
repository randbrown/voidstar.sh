// VOID INVADERS — a fixed shooter in the Galaga/Galaxian mold. A swarm of
// wavefunction ships weaves overhead and peels off into diving runs; the crowd
// is the cannon. Beats launch dives and trigger volleys, so the firefight is
// audio-reactive by construction. enemyIntensity scales swarm size, speed, and
// dive rate.

const E_CAP = 72, PB_CAP = 28, EB_CAP = 28;

// Ambient pacing: the swarm motion (sway / descend / dive swoop) is the part
// that reads as "jarring" at full speed, so it runs ~5× slower for a languid
// drift. Enemy bullets slow less (they stay readable + always dodgeable). The
// cannon + player bullets keep their speed so the firefight still feels alive.
// (The global `speed` knob in arcade.js scales everything on top of this.)
const ATTACK = 0.2;     // swarm-motion scale — 5× slower
const EB_SPEED = 70;    // enemy-bullet fall px/s (was 120)

export default function create(eng) {
  const enemies = [];   // {alive, hx, hy, x, y, dive, dt, tx, hue}
  const pb = [];        // player bullets {on, x, y}
  const ebx = [];       // enemy bullets {on, x, y, vx}
  const parts = eng.createParticles(160);
  const stars = [];
  for (let i = 0; i < E_CAP; i++) enemies.push({ alive: false, hx: 0, hy: 0, x: 0, y: 0, dive: false, dt: 0, tx: 0, hue: 0 });
  for (let i = 0; i < PB_CAP; i++) pb.push({ on: false, x: 0, y: 0 });
  for (let i = 0; i < EB_CAP; i++) ebx.push({ on: false, x: 0, y: 0, vx: 0 });
  for (let i = 0; i < 60; i++) stars.push({ x: Math.random(), y: Math.random(), s: 8 + Math.random() * 30 });

  let px = 0, swayP = 0, descend = 0, fireCool = 0, diveT = 0;
  let score = 0, stun = 0, scroll = 0, wave = 1, cols = 8, rows = 4;
  // autopilot scratch — desired cannon lean in -1..1, a slow musical wander, and
  // a self-fire cadence so it keeps raining shots even through quiet passages.
  let aiX = 0, wanderP = 0, aiFireT = 0;
  let deaths = 0, deathsBullet = 0, deathsReached = 0;   // perfect-play counters

  function buildWave(intensity) {
    cols = Math.max(5, Math.min(11, Math.round(6 + intensity * 2)));
    rows = Math.max(2, Math.min(5, Math.round(3 + intensity)));
    const vw = eng.vw, vh = eng.vh;
    const gapX = vw * 0.78 / cols, gapY = vh * 0.09;
    const x0 = vw * 0.11 + gapX * 0.5, y0 = vh * 0.14;
    let i = 0;
    for (let r = 0; r < rows && i < E_CAP; r++) {
      for (let c = 0; c < cols && i < E_CAP; c++) {
        const e = enemies[i++];
        e.alive = true; e.dive = false; e.dt = 0;
        e.hx = x0 + c * gapX; e.hy = y0 + r * gapY;
        e.x = e.hx; e.y = e.hy; e.hue = r;
      }
    }
    for (; i < E_CAP; i++) enemies[i].alive = false;
    descend = 0; swayP = 0;
  }

  function reset() {
    px = eng.vw * 0.5; score = 0; stun = 0; wave = 1; fireCool = 0; diveT = 1; scroll = 0;
    aiX = 0; wanderP = 0; aiFireT = 0; deaths = 0; deathsBullet = 0; deathsReached = 0;
    for (const b of pb) b.on = false;
    for (const b of ebx) b.on = false;
    parts.clear();
    buildWave(1);
  }

  function aliveCount() { let n = 0; for (const e of enemies) if (e.alive) n++; return n; }

  function firePlayer() {
    for (const b of pb) if (!b.on) { b.on = true; b.x = px; b.y = eng.vh * 0.88; return; }
  }
  function fireEnemy(x, y) {
    // Don't fire point-blank: a bullet spawned low (e.g. by a diving enemy near
    // the cannon row) gives no time to react. Require it to start in the upper
    // 60% so every bullet has lead time → the dodge is always possible.
    if (y > eng.vh * 0.6) return;
    // Cap on-screen enemy bullets so the cannon can ALWAYS dodge them (≤2 sparse
    // bullets always leave a reachable gap for a fast cannon → perfect dodging).
    let active = 0;
    for (const b of ebx) if (b.on) active++;
    if (active >= 2) return;
    for (const b of ebx) if (!b.on) { b.on = true; b.x = x; b.y = y; b.vx = (Math.random() * 2 - 1) * 12; return; }
  }
  function boom(x, y, col) {
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * 6.28, sp = 25 + Math.random() * 70;
      parts.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.3 + Math.random() * 0.4, col, 2);
    }
  }

  function update(dt, intent, audio, params) {
    const vw = eng.vw, vh = eng.vh;
    const intensity = (params.enemyIntensity ?? 1) * (0.7 + intent.intensity * 0.8);
    scroll += dt * (10 + audio.bands.total * 30);

    // Autopilot — the cannon plays itself and the player only nudges. Priority:
    // (a) dodge the nearest enemy bullet that's below the swarm and bearing on
    // the cannon x; else (b) slide under the lowest/nearest enemy to kill it;
    // plus a slow wander so it never sits dead-still. aiFire fires on beats and
    // when something is roughly overhead.
    wanderP += dt * 0.5;
    const CANNON_Y = vh * 0.9;
    // Enemy target: line up under the LOWEST (most urgent) alive enemy.
    let lowestY = -1, enemyX = vw * 0.5 + Math.sin(wanderP) * vw * 0.18;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (e.y > lowestY) { lowestY = e.y; enemyX = e.x; }
    }
    // Safest cannon x: a 1-D potential field. For every enemy bullet, project
    // WHERE it will be when it reaches the cannon row; choose the candidate x
    // with the most clearance from all imminent projections, biased toward the
    // enemy we want to shoot. The cannon is fast enough to be there in time, so
    // it dodges every bullet AND keeps shooting — perfect play in expert mode.
    let aiTarget = enemyX, bestScore = -1e9;
    for (let i = 0; i <= 22; i++) {
      const cand = vw * 0.06 + vw * 0.88 * i / 22;
      let minD = vw * 0.3;                            // cap so "no bullets" → enemy bias wins
      let cross = 0;
      for (const b of ebx) {
        if (!b.on) continue;
        const tt = (CANNON_Y - b.y) / EB_SPEED;       // seconds until it reaches our row
        if (tt < -0.15 || tt > 2.4) continue;         // wider window (bullets fly slower now)
        const projX = b.x + b.vx * tt;
        const d = Math.abs(cand - projX);
        if (d < minD) minD = d;
        // CROSSING guard: reaching `cand` from the cannon's current x must not
        // route THROUGH an imminent bullet's column (that's how a "safe" target
        // still gets you clipped in transit). Dodge to the SAME side instead.
        if (tt < 1.1 && Math.abs(px - projX) > 1 && (px < projX) !== (cand < projX)) cross += 300;
      }
      const score = minD - Math.abs(cand - enemyX) * 0.12 - cross;
      if (score > bestScore) { bestScore = score; aiTarget = cand; }
    }
    // Steady fast self-fire so waves always clear in time (most shots land —
    // the cannon only leaves the enemy column when a bullet is imminent).
    let aiFire = false;
    aiFireT -= dt;
    if (aiFireT <= 0 && aliveCount() > 0) { aiFire = true; aiFireT = 0.34; }   // calmer cadence
    aiFire = aiFire || audio.beat.active;
    aiX = Math.max(-1, Math.min(1, (aiTarget - vw * 0.5) / (vw * 0.46)));

    // Player. Blend the player lean with the autopilot by autonomy: at perf
    // autonomy the AI dominates and a hard lean still nudges; at crowd autonomy
    // the player signal takes over.
    const blendX = intent.x * intent.playerWeight + aiX * intent.autonomy;
    const tx = vw * 0.5 + Math.max(-1, Math.min(1, blendX)) * vw * 0.46;
    px += (tx - px) * Math.min(1, dt * 13);   // fast cannon → reaches the safe gap in time
    px = Math.max(vw * 0.05, Math.min(vw * 0.95, px));
    if (stun > 0) stun -= dt;

    // Fire — player edge/held always acts; the AI fires on its own cadence gated
    // by autonomy, plus a beat volley so the music keeps it raining.
    fireCool -= dt;
    const wantFire = intent.fire || intent.fireHeld
      || (aiFire && intent.autonomy > 0.25)
      || (audio.beat.active && intent.intensity > 0.2);
    if (wantFire && fireCool <= 0) { firePlayer(); fireCool = 0.22; }   // gentle, ambient clear rate

    // Difficulty is CAPPED (Math.min) so a high enemyIntensity never makes the
    // wave un-clearable / un-dodgeable — expert play stays perfect.
    const diff = Math.min(1.4, Math.max(0.5, intensity));

    // Swarm formation motion — scaled by ATTACK so it drifts ~5× slower (the
    // languid ambient swarm). Descend slowly so the cannon always has time to
    // clear the wave before it reaches the bottom.
    swayP += dt * (0.7 + diff * 0.4) * ATTACK;
    const swayX = Math.sin(swayP) * vw * 0.05;
    descend += dt * (0.8 + diff * 0.25) * ATTACK;
    const bob = audio.bands.bass * vh * 0.02;

    // Launch dives on a timer + on beats (bounded) — much rarer now so a swoop
    // is an occasional event, not a constant barrage.
    diveT -= dt;
    const wantDive = (diveT <= 0) || (audio.beat.active && Math.random() < 0.08 * diff);
    if (wantDive) {
      diveT = 4.2 / diff;
      // pick a random alive, non-diving enemy
      const start = (Math.random() * E_CAP) | 0;
      for (let n = 0; n < E_CAP; n++) {
        const e = enemies[(start + n) % E_CAP];
        if (e.alive && !e.dive) { e.dive = true; e.dt = 0; e.tx = px; break; }
      }
    }

    let reached = false;
    for (const e of enemies) {
      if (!e.alive) continue;
      if (e.dive) {
        e.dt += dt * (0.8 + diff * 0.4) * ATTACK;   // slow, gliding swoop (was a fast swoop)
        const t = e.dt;
        // Arc from home down across screen toward the launch-time target.
        e.x = e.hx + (e.tx - e.hx) * Math.min(1, t) + Math.sin(t * 6) * vw * 0.06;
        e.y = e.hy + descend + t * t * vh * 0.55;
        if (Math.random() < dt * 0.8 * diff) fireEnemy(e.x, e.y);
        if (e.y > vh + 8) { e.dive = false; e.dt = 0; e.y = e.hy; e.x = e.hx; }   // loop back to formation
      } else {
        e.x = e.hx + swayX;
        e.y = e.hy + descend + Math.sin(swayP * 1.5 + e.hx * 0.05) * 2 + bob;
        if (e.y > vh * 0.82) reached = true;
        if (audio.beat.active && Math.random() < 0.01 * diff) fireEnemy(e.x, e.y);
      }
    }

    // Player bullets.
    for (const b of pb) {
      if (!b.on) continue;
      b.y -= dt * 260;
      if (b.y < -4) { b.on = false; continue; }
      for (const e of enemies) {
        if (!e.alive) continue;
        if (Math.abs(e.x - b.x) < 6 && Math.abs(e.y - b.y) < 6) {
          e.alive = false; b.on = false; score += e.dive ? 150 : 80;
          boom(e.x, e.y, e.dive ? eng.C.gold : eng.C.cyan); eng.shake(2);
          break;
        }
      }
    }
    // Enemy bullets — slower fall (EB_SPEED) so they read clearly and stay
    // dodgeable; the AI projection above uses the same constant.
    for (const b of ebx) {
      if (!b.on) continue;
      b.y += dt * EB_SPEED; b.x += b.vx * dt;
      if (b.y > vh + 4) { b.on = false; continue; }
      if (stun <= 0 && Math.abs(b.x - px) < 5 && Math.abs(b.y - vh * 0.9) < 5) {
        b.on = false; stun = 1.0; deaths++; deathsBullet++; score = Math.max(0, score - 200);
        boom(px, vh * 0.9, eng.C.red); eng.shake(6);
      }
    }

    parts.update(dt, 40, 1);

    // Wave logic.
    if (aliveCount() === 0) { wave++; buildWave(intensity); }
    // Ambient: a swarm that drifts past the cannon just quietly re-forms at the
    // top — no penalty, no stun, no shake. A "you lost the line" flash would be
    // exactly the jarring beat this quale is trying to avoid.
    if (reached) buildWave(intensity);
  }

  function drawEnemy(e) {
    const col = [eng.C.cyan, eng.C.ice, eng.C.magenta, eng.C.green, eng.C.gold][e.hue % 5];
    const x = Math.round(e.x), y = Math.round(e.y);
    // little bracket-ship: [ o ]
    eng.rect(x - 4, y - 2, 2, 5, col, 1);
    eng.rect(x + 2, y - 2, 2, 5, col, 1);
    eng.rect(x - 2, y - 3, 4, 2, col, 1);
    eng.rect(x - 1, y, 2, 2, eng.C.white, 1);
  }

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    eng.clear('#04030a');
    // Scrolling starfield.
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const y = (s.y * vh + scroll * (s.s / 30)) % vh;
      eng.rect(s.x * vw, y, 1, 1, eng.C.white, 0.25 + (s.s / 60));
    }
    for (const e of enemies) if (e.alive) drawEnemy(e);
    for (const b of pb) if (b.on) eng.rect(b.x - 0.5, b.y, 1, 4, eng.C.gold, 1);
    for (const b of ebx) if (b.on) eng.rect(b.x - 1, b.y, 2, 3, eng.C.red, 1);
    parts.draw(vctx);

    // Player cannon.
    const py = vh * 0.9;
    if (!(stun > 0 && (Math.floor(scroll * 0.5) & 1))) {
      const col = stun > 0 ? eng.C.red : eng.C.cyan;
      eng.rect(px - 5, py, 10, 3, col, 1);
      eng.rect(px - 2, py - 3, 4, 3, col, 1);
      eng.rect(px - 1, py - 5, 2, 2, eng.C.white, 1);
    }

    if (params.hud) {
      eng.beginHud();
      eng.hud(3, 3, 'SCORE', score | 0, eng.C.gold, 'left');
      eng.hud(vw / 2, 3, 'WAVE', wave, eng.C.magenta, 'center');
      eng.hud(vw - 3, 3, 'FOES', aliveCount(), eng.C.cyan, 'right');
      if (intent.source === 'cpu') eng.text('HANDS UP TO FIRE', vw / 2, vh * 0.30, eng.C.white, 1, 'center', 0.4 + 0.4 * Math.sin(scroll * 0.1));
      eng.endHud();
    }
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    __test: () => ({ deaths, wave, db: deathsBullet, dr: deathsReached }),
  };
}
