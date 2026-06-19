// ACCRETION RUN — a neon pseudo-3D racer diving toward a black-hole horizon.
// Outrun / Pole Position by way of voidstar: the vanishing point is a black
// hole ringed in accretion gold; "traffic" is debris falling into the disk.
// The player drives a rear-view pixel sportscar (the red convertible, from
// behind) that banks into its steering.
//
// Control: steer with intent.x (the crowd leaning as one is the showstopper).
// Auto-accelerates; intent.up boosts, intent.duck brakes. audio.beat + the
// enemyIntensity knob spawn debris and push the speed. Per-row perspective is
// the classic Outrun technique (cheap at the cabinet's tiny virtual height).
//
// Autonomy: the car drives itself. An internal autopilot reads the debris
// field and steers to thread the nearest hazard, easing back to centre with a
// slow musical wander when the lane is clear; the player signal is blended in
// as a nudge (weight = 1-autonomy). At performer autonomy (~0.7) it weaves and
// rarely crashes with zero input; at crowd autonomy it tracks the room tightly.

const MAX_DEBRIS = 2;    // very sparse — at most 2 cars, which also guarantees a
                        // clear lane always exists (≤2 blocked intervals < road).

// painter's-order comparator (far→near) — module const so render() allocates
// no per-frame closure when sorting the debris field.
function byDepthFarFirst(a, b) { return b.d - a.d; }

// ── The car ──────────────────────────────────────────────────────────────────
// Rear-view Ferrari Testarossa, 48×19 (rendered at scale 1 for crisp detail).
// Low/wide stance with sculpted edges (K outline + D/M shade), a glossy red deck
// (H highlight + W spec streak), the signature full-width louvred tail band
// (G/S/N greys) with round amber taillight clusters (L ring, O glow, W hot
// centre), black valance + silver exhausts (S) + amber corners (B), and wide
// tyres (T) with rim hints (A). Authored by rendering to PNG and iterating.
// ' '/'.' transparent.
const CAR_ROWS = [
  '.................KKDDDDDDDDDDKK.................',
  '..............KMRRCCCCCCCCCCCCRRMK..............',
  '...........KMRRRHHHHHHHHHHHHHHHHRRRMK...........',
  '.........KMRRHHHHHHHHHWWWWHHHHHHHHHRRMK.........',
  '........KDMRRRRRRRRRRRRRRRRRRRRRRRRRRMDK........',
  '.......KDRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRDK.......',
  '......KDRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRDK......',
  '......KDLLLLLNGGGGGGGGGGGGGGGGGGGGNLLLLLDK......',
  '......KDLOWOLNSSSSSSSSSSSSSSSSSSSSNLOWOLDK......',
  '......KDLOWOLNGGGGGGGGGGGGGGGGGGGGNLOWOLDK......',
  '......KDLLLLLNSSSSSSSSSSSSSSSSSSSSNLLLLLDK......',
  '......KDDRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRDDK......',
  '......KDMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMDK......',
  '......KDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDK......',
  '.......BKKKKKKKKKKKKKSSSSSSKKKKKKKKKKKKKB.......',
  '......TTTTTTTTTTAAAA........AAAATTTTTTTTTT......',
  '......TTTTTTTTTTAA............AATTTTTTTTTT......',
  '.........TTTTTTTTT............TTTTTTTTT.........',
  '..........TTTTTTT..............TTTTTTT..........',
];
const CAR_W = CAR_ROWS[0].length;
const CAR_H = CAR_ROWS.length;
const CAR_PAL = {
  R: '#ff2e36', M: '#d11f29', D: '#8f1018', H: '#ff8a7e', P: '#ffd0c2', K: '#0b0a0e',
  G: '#1c151d', S: '#473a47', N: '#2a2430', L: '#ff5a2a', O: '#ffcf3a', W: '#fff0ea',
  C: '#16223e', T: '#070509', A: '#3a323f', B: '#ffb43a',
};
// Crash-flash recolour (whole car flashes hot red/white).
const CAR_PAL_HIT = {
  R: '#ff6070', M: '#ff6070', D: '#c03040', H: '#ffd0d0', P: '#ffffff', K: '#400810',
  G: '#ff6070', S: '#ffd0d0', N: '#ff6070', L: '#ffffff', O: '#ffffff', W: '#ffffff',
  C: '#ff90a0', T: '#300810', A: '#ff90a0', B: '#ffffff',
};

export default function create(eng) {
  let dist = 0;          // traveled distance (drives stripe scroll)
  let speed = 0;         // current speed (rows/s-ish, virtual)
  let curve = 0, curveTarget = 0, curveKick = 0;
  let laneX = 0;         // smoothed steering position in road-space [-1.3..1.3]
  let bank = 0;          // smoothed visual bank/lean (-1..1) for the car art
  let crash = 0;         // crash cooldown timer
  let score = 0, best = 0;
  let spawnT = 0;
  // autopilot scratch — desired steer in -1..1 and a slow musical wander phase.
  let aiX = 0, wanderP = 0;
  // cached sky gradient — rebuilt only when the horizon row moves (vh changes
  // with the pixel-chunkiness knob), so render() allocates nothing per frame.
  let skyGrad = null, skyGradH = -1;
  const stars = [];
  const debris = [];     // traffic: { d:0..1 far→near, x:lane, hit, tint }
  const parts = eng.createParticles(120);

  for (let i = 0; i < 70; i++) {
    stars.push({ x: Math.random(), y: Math.random(), tw: Math.random() * 6.28 });
  }

  // Optional PNG car art — drop these in public/arcade/ to upgrade from the
  // procedural fallback. PLAYER = the red Ferrari (kept red — it's the focus);
  // NPCs = hue-rotated copies of car2 so traffic is a mix of colours.
  // removeBg = key out the PNG's solid (white) matte → transparent, so we don't
  // see a rectangle around the car. Interior whites (plate, lights) are kept.
  const PLAYER_IMG = eng.loadImage('/arcade/outrun_ferrari.png', true);
  const NPC_IMG = eng.loadImage('/arcade/car2.png', true);
  // Hue-rotations of the red car2 → green / blue / purple ONLY (no orange or
  // pink — too close to the player's red, which must stay the clear focus).
  const NPC_HUES = [120, 160, 210, 250, 285];       // green, teal, blue, indigo, purple
  const NPC_FALLBACK = ['#3ad17a', '#2ec4b6', '#3a7bff', '#6a5cff', '#a45cff'];
  let npcTints = null;
  function ensureNpcTints() {
    if (npcTints || !NPC_IMG.ready) return;
    npcTints = NPC_HUES.map(h => eng.tintImage(NPC_IMG.src, h));
  }

  let crashes = 0;       // collision counter (for the headless perfect-play test)

  function reset() {
    dist = 0; speed = 0.6; curve = curveTarget = curveKick = 0; laneX = 0; bank = 0; crash = 0;
    score = 0; spawnT = 0; aiX = 0; wanderP = 0; crashes = 0; debris.length = 0; parts.clear();
  }

  // Spawn a car in the lane FARTHEST from existing traffic (best of a few random
  // candidates), so the field spreads out and the dodger always has a clear path.
  function spawnCar() {
    let bx = (Math.random() * 2 - 1) * 0.85, bestSep = -1;
    for (let t = 0; t < 5; t++) {
      const cx = (Math.random() * 2 - 1) * 0.85;
      let sep = 2;
      for (let k = 0; k < debris.length; k++) {
        const d = Math.abs(cx - debris[k].x);
        if (d < sep) sep = d;
      }
      if (sep > bestSep) { bestSep = sep; bx = cx; }
    }
    debris.push({ d: 1, x: bx, hit: false, tint: (Math.random() * NPC_HUES.length) | 0 });
  }

  // Perspective helpers — p in [0..1], 0 at horizon, 1 at the near plane. The
  // 0.7 coefficient (was 0.5) lets the far road sweep harder to the side; curve
  // is clamped to ±0.85 in update() so the vanishing point stays on screen.
  const horizonF = 0.44;
  function centerAt(p, vw) { return vw * 0.5 + curve * (1 - p) * (1 - p) * vw * 0.7; }
  function halfAt(p, vw)   { return vw * 0.03 + p * p * vw * 0.46; }

  // ── Autopilot — a PERFECT, planned dodge ─────────────────────────────────────
  // Not merely reactive: a potential-field planner. It samples candidate lanes
  // across the road and scores each by its clearance from EVERY approaching car
  // (weighted by how soon the car arrives — imminent cars dominate). It commits
  // to the clearest lane with a margin (0.45) well beyond the collision radius
  // (0.30), and with ~2s of lead time before any car reaches the near band. For
  // the sparse traffic field this threads a guaranteed-clear path: in expert
  // mode (pure autopilot) it never collides. Returns the desired steer [-1,1].
  const NC = 23, MARGIN = 0.48;
  function autopilot(dt, audio, poseEnergy) {
    wanderP += dt * (0.35 + audio.bands.total * 0.25 + poseEnergy * 0.7);
    const wander = Math.sin(wanderP) * (0.40 + poseEnergy * 0.2) + Math.sin(wanderP * 0.37 + 1.3) * 0.18;

    // React across the FULL depth range (a car the instant it spawns at d=1) so
    // the planner gets maximum lead time — far cars barely pull (urgency→0), but
    // it pre-positions early, which is what makes it collision-free even fast.
    let anyNear = false;
    for (let k = 0; k < debris.length; k++) {
      const o = debris[k];
      if (!o.hit && o.d >= -0.05) { anyNear = true; break; }
    }

    let best = 0, bestScore = -1e9;
    for (let i = 0; i < NC; i++) {
      const cand = -0.92 + (1.84 * i) / (NC - 1);
      // mild centring preference + hysteresis (stay near the current choice) so
      // the planner commits to a lane instead of flip-flopping mid-transition.
      let score = -Math.abs(cand) * 0.10 - Math.abs(cand - aiX) * 0.12;
      for (let k = 0; k < debris.length; k++) {
        const o = debris[k];
        if (o.hit || o.d < -0.05) continue;
        const gap = Math.abs(cand - o.x);
        if (gap < MARGIN) {
          const urgency = 1 - Math.min(1, o.d);           // 1 imminent → 0 just-spawned
          score -= (MARGIN - gap) * (2 + urgency * 38);   // steep penalty near imminent cars
        }
      }
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    // Road clear → drift with the musical wander; cars present → commit to the
    // chosen safe lane.
    aiX = anyNear ? best : (best * 0.3 + wander);
    aiX = Math.max(-0.95, Math.min(0.95, aiX));
    return aiX;
  }

  function update(dt, intent, audio, params) {
    const intensity = (params.enemyIntensity ?? 1) * (0.7 + intent.intensity * 0.9);

    // Speed: cruise toward a target lifted by audio + boost; brake on duck /
    // off-road. Crash bleeds speed hard. Auto-accelerates regardless of input.
    let target = 0.7 + audio.bands.total * 0.5 + intent.intensity * 0.7;
    if (intent.up || intent.jumpHeld) target += 0.5;
    if (intent.duck) target *= 0.4;
    if (Math.abs(laneX) > 1.0) target *= 0.55;          // grinding the void
    if (crash > 0) { target = 0.15; crash -= dt; eng.shake(4); }
    speed += (target - speed) * Math.min(1, dt * 1.6);
    speed = Math.max(0.1, speed);
    dist += speed * dt * 6;
    score += speed * dt * 60;
    if (score > best) best = score;

    // Steering — blend autopilot with the player nudge. autopilot dodges the
    // nearest debris; the player signal is weighted by 1-autonomy so a hard
    // lean still visibly nudges at performer autonomy and dominates at crowd
    // autonomy. The result is the steering TARGET; laneX smooths toward it.
    autopilot(dt, audio, intent.poseEnergy || 0);
    const laneTarget = intent.x * intent.playerWeight + aiX * intent.autonomy;
    const sx = laneTarget * 1.1;     // slight overshoot for responsive steering
    laneX += (sx - laneX) * Math.min(1, dt * 5.5);

    // Visual bank — how hard we're turning right now (signed), eased for the art.
    const turn = Math.max(-1, Math.min(1, (sx - laneX) * 3 + laneTarget * 0.4));
    bank += (turn - bank) * Math.min(1, dt * 8);

    // Road curve — a continuous sweeping bend (incommensurate sines of distance,
    // so the road is almost always curving one way or the other) plus a sharper
    // transient kicked on beats. Clamped so the far road sweeps hard but the
    // vanishing point never leaves the screen.
    const sweep = Math.sin(dist * 0.10) * 0.50 + Math.sin(dist * 0.041 + 1.3) * 0.30;
    if (audio.beat.active && Math.random() < 0.4) curveKick = (Math.random() * 2 - 1) * 0.45;
    curveKick *= Math.pow(0.5, dt / 2);
    // clamp ±0.72 so (with the 0.7 centreAt coefficient) the vanishing point /
    // black hole swings to the screen edge on a hard bend but never clips past it.
    curveTarget = Math.max(-0.72, Math.min(0.72, sweep + curveKick));
    curve += (curveTarget - curve) * Math.min(1, dt * 1.1);

    // Very sparse traffic — a long interval between spawns, capped at
    // MAX_DEBRIS, so the road usually holds 0-1 cars. New cars spawn into the
    // lane FARTHEST from existing traffic so the field stays spread (which also
    // keeps a clear path always available for the dodger).
    spawnT -= dt;
    const rate = 3.4;     // constant + sparse — intensity must NOT flood the road
    if (spawnT <= 0) {
      spawnT = rate * (0.7 + Math.random() * 0.9);
      if (debris.length < MAX_DEBRIS) spawnCar();
    }
    // Rare beat-synced car, only when the road is empty — a touch of audio feel.
    if (audio.beat.active && debris.length < 1 && intensity > 1.0 && Math.random() < 0.10) spawnCar();

    // Advance debris toward the player; collide in the near band.
    for (let i = debris.length - 1; i >= 0; i--) {
      const o = debris[i];
      o.d -= speed * dt * 0.42;
      if (!o.hit && o.d < 0.10 && o.d > -0.05 && Math.abs(o.x - laneX) < 0.30 && crash <= 0) {
        o.hit = true; crash = 0.8; crashes++; eng.shake(8);
        score = Math.max(0, score - 400);
        const vw = eng.vw, vh = eng.vh;
        const px = centerAt(0.96, vw) + laneX * halfAt(0.96, vw) * 0.9;
        for (let k = 0; k < 16; k++) {
          const a = Math.random() * 6.28, sp = 30 + Math.random() * 90;
          parts.spawn(px, vh * 0.84, Math.cos(a) * sp, Math.sin(a) * sp - 30,
            0.4 + Math.random() * 0.4, k & 1 ? eng.C.gold : eng.C.amber, 2);
        }
      }
      if (o.d < -0.08) debris.splice(i, 1);
    }
    parts.update(dt, 120, 1);
  }

  // Draw the rear-view sportscar centred on (pcx, py-bottom), scaled so it spans
  // ~40-55% of the near road width. `bnk` (-1..1) banks it: mirror via flipX and
  // nudge the body a few px so it visibly turns into the steer.
  function drawCar(pcx, pyBottom, scale, bnk, hitFlash) {
    const vctx = eng.vctx;
    const pal = hitFlash ? CAR_PAL_HIT : CAR_PAL;
    const w = CAR_W * scale, h = CAR_H * scale;
    const flip = bnk < -0.12;                 // mirror art when banking left
    // body slides a few px into the turn; wheels stay a touch behind it.
    const slide = bnk * scale * 1.6;
    const x = Math.round(pcx - w / 2 + slide);
    const y = Math.round(pyBottom - h);

    // ground shadow so it sits on the road.
    eng.rect(pcx - w * 0.42, pyBottom - scale, w * 0.84, scale * 1.5, '#000', 0.35);

    eng.sprite(x, y, CAR_ROWS, pal, scale, flip, 1);

    // brake-light glow under the two taillights (symmetric, ~±0.34w from
    // centre — under the amber tail clusters), plus a hot exhaust flicker.
    const glowA = hitFlash ? 0.0 : 0.5 + 0.22 * Math.sin(dist * 6);
    if (glowA > 0) {
      const gy = pyBottom - scale * 3.5;
      const lw = w * 0.14;
      eng.rect(pcx - w * 0.31 - lw / 2, gy, lw, scale * 2, eng.C.amber, glowA);
      eng.rect(pcx + w * 0.31 - lw / 2, gy, lw, scale * 2, eng.C.amber, glowA);
      const ex = scale * (1 + (Math.floor(dist * 20) & 1));
      eng.rect(pcx - scale, pyBottom - scale, scale * 2, ex, eng.C.amber, 0.85);
    }
  }

  // A piece of NPC traffic at screen (cx, yBottom) with on-road width w. Uses
  // the tinted car2 PNG when present, else a clean procedural car.
  function drawNpc(cx, yBottom, w, o) {
    eng.rect(cx - w * 0.45, yBottom - 1, w * 0.9, Math.max(1, w * 0.08), '#000', 0.3);   // shadow
    if (NPC_IMG.ready) {
      ensureNpcTints();
      // Always the TINTED car — never the untinted red source, even after a
      // collision (o.hit), so traffic never turns red (the player owns red).
      const img = npcTints[o.tint % npcTints.length];
      const h = w * (NPC_IMG.h / NPC_IMG.w);
      eng.drawSprite(img, cx - w / 2, yBottom - h, w, h, false, 1);
      return;
    }
    // procedural fallback: a little coloured car (body + cabin + window + lights)
    const col = NPC_FALLBACK[o.tint % NPC_FALLBACK.length];
    const h = Math.max(3, w * 0.6);
    const x = cx - w / 2, y = yBottom - h;
    eng.rect(x, y + h * 0.34, w, h * 0.66, col, 1);
    eng.rect(x + w * 0.16, y, w * 0.68, h * 0.46, col, 1);
    eng.rect(x + w * 0.24, y + h * 0.07, w * 0.52, h * 0.3, '#0a1430', 1);
    eng.rect(x, yBottom - Math.max(1, h * 0.2), Math.max(1, w * 0.16), Math.max(1, h * 0.18), eng.C.red, 1);
    eng.rect(x + w * 0.84, yBottom - Math.max(1, h * 0.2), Math.max(1, w * 0.16), Math.max(1, h * 0.18), eng.C.red, 1);
  }

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    const horizon = Math.round(vh * horizonF);
    eng.clear('#04040c');

    // Sky gradient + stars. Gradient is cached and only rebuilt when the
    // horizon row moves (zero per-frame allocation).
    if (!skyGrad || skyGradH !== horizon) {
      skyGrad = vctx.createLinearGradient(0, 0, 0, Math.max(1, horizon));
      skyGrad.addColorStop(0, '#0a0620'); skyGrad.addColorStop(1, '#2a0b3a');
      skyGradH = horizon;
    }
    vctx.fillStyle = skyGrad; vctx.fillRect(0, 0, vw, horizon);
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const a = 0.3 + 0.5 * Math.sin(s.tw + dist * 0.05);
      eng.rect(s.x * vw, s.y * horizon, 1, 1, eng.C.white, Math.max(0.1, a));
    }

    // Black hole at the vanishing point.
    const hx = centerAt(0, vw), hr = vh * 0.12;
    eng.disc(hx, horizon, hr * 1.7, eng.C.gold, 0.10);
    eng.disc(hx, horizon, hr * 1.15, eng.C.amber, 0.5);
    eng.disc(hx, horizon, hr, '#000', 1);
    vctx.strokeStyle = eng.C.gold; vctx.lineWidth = 1.5;
    vctx.globalAlpha = 0.9; vctx.beginPath();
    vctx.ellipse(hx, horizon, hr * 1.18, hr * 0.5, 0, 0, Math.PI * 2); vctx.stroke();
    vctx.globalAlpha = 1;

    // Road — per-row fill from horizon to the bottom.
    for (let y = horizon; y < vh; y++) {
      const p = (y - horizon) / (vh - horizon);
      const pf = 1 / (p + 0.05);                       // perspective bunching
      const cx = centerAt(p, vw), half = halfAt(p, vw);
      const band = (Math.floor(pf * 0.9 + dist) & 1);
      // Space floor (alternating void blues).
      eng.rect(0, y, vw, 1, band ? '#070a1c' : '#0a0f28', 1);
      // Road surface.
      const road = band ? '#1a1438' : '#221a44';
      eng.rect(cx - half, y, half * 2, 1, road, 1);
      // Rumble edges + neon rim.
      const rim = band ? eng.C.cyan : eng.C.magenta;
      eng.rect(cx - half, y, Math.max(1, half * 0.06), 1, rim, 0.9);
      eng.rect(cx + half - Math.max(1, half * 0.06), y, Math.max(1, half * 0.06), 1, rim, 0.9);
      // Centre dashes.
      if (band && p > 0.15) eng.rect(cx - half * 0.03, y, Math.max(1, half * 0.06), 1, eng.C.white, 0.7);
    }

    // Traffic, far → near (painter's order) — actual cars now, not blocks.
    debris.sort(byDepthFarFirst);
    for (let i = 0; i < debris.length; i++) {
      const o = debris[i];
      if (o.d > 1 || o.d < -0.05) continue;
      const p = 1 - o.d;
      const cx = centerAt(p, vw) + o.x * halfAt(p, vw) * 0.9;
      const y = horizon + p * (vh - horizon);
      // Width ~46% of the road-half at this depth → a car right ahead of the
      // player comes out a touch SMALLER than the player's car (which is at the
      // camera), so the red Ferrari always reads as the biggest, nearest car.
      const w = Math.max(3, halfAt(p, vw) * 0.46);
      drawNpc(cx, y, w, o);
    }

    // Player car — the red Ferrari (PNG when present, else the procedural
    // Testarossa). Sat a bit higher up the screen (pyBottom 0.90, was 0.97) so
    // a venue projector that crops the bottom edge doesn't clip it. Slides
    // subtly into the steer.
    const pcx = centerAt(0.96, vw) + laneX * halfAt(0.96, vw) * 0.9;
    const pyBottom = vh * 0.90;
    const slide = bank * vw * 0.012;
    const flick = crash > 0 && (Math.floor(dist * 30) & 1);
    if (!flick) {
      if (PLAYER_IMG.ready) {
        // Size the player by the SAME perspective formula as the traffic, at
        // the player's own screen depth (pPlayer) — so a car that comes down to
        // the player's Y is ~the same size. Small hero boost (1.12) keeps the
        // red Ferrari just slightly the biggest. (This also shrinks it from the
        // old fixed vw*0.26, which read as too large.)
        const pPlayer = (pyBottom - horizon) / (vh - horizon);
        const w = halfAt(pPlayer, vw) * 0.46 * 1.2;
        const h = w * (PLAYER_IMG.h / PLAYER_IMG.w);
        const x = pcx - w / 2 + slide;
        eng.rect(pcx - w * 0.42, pyBottom - 1, w * 0.84, Math.max(1, h * 0.06), '#000', 0.35);
        eng.drawSprite(PLAYER_IMG.src, x, pyBottom - h, w, h, false, 1);
        if (crash > 0) eng.rect(x, pyBottom - h, w, h, eng.C.red, 0.35);   // crash flash
      } else {
        const carScale = (CAR_W / vw < 0.09) ? 2 : 1;
        drawCar(pcx + slide, pyBottom, carScale, bank, crash > 0);
      }
    }
    parts.draw(vctx);

    // Top HUD strip (game stats, Outrun style). The quale shell adds the bottom
    // diagnostics strip. Idle prompt sits high so it clears both + the car.
    if (params.hud) {
      eng.hud(3, 3, 'SCORE', score | 0, eng.C.gold, 'left');
      eng.hud(vw / 2, 3, 'KM/H', (speed * 78) | 0, eng.C.cyan, 'center');
      eng.hud(vw - 3, 3, 'STAGE', (Math.floor(dist / 200) + 1), eng.C.green, 'right');
      if (intent.source === 'cpu') eng.text('LEAN TO STEER', vw / 2, vh * 0.30, eng.C.white, 1, 'center', 0.4 + 0.4 * Math.sin(dist * 0.2));
    }
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    // test-only probe: steering (auto high-pass test) + crash counter (expert
    // perfect-play test). Zero cost in prod.
    __test: () => ({ laneX, speed, curve, deaths: crashes }),
  };
}
