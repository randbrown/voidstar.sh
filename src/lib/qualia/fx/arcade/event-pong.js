// EVENT HORIZON PONG — the ur-game, voidstar-skinned. Two light-paddles volley
// a plasma mote across a court split by a glowing event horizon. The crowd /
// performer slides the NEAR paddle by leaning; the FAR paddle is the house AI.
// Both sides play well, so the default is a long meditative rally — an ambient
// back-and-forth — with the odd point ticking the score. In attract mode both
// paddles self-drive and the mote never stops.
//
// Orientation is top/bottom (mote travels vertically) so the primary lean axis
// (intent.x — a room swaying as one) maps straight to paddle slide. The near
// paddle blends player lean with its own tracking AI by intent.autonomy, so it
// covers itself when you're busy performing and follows tightly when you lean.

export default function create(eng) {
  let bx = 0, by = 0, vx = 0, vy = 0;     // mote position + velocity (virtual px/s)
  let topX = 0, botX = 0;                  // paddle CENTRES (x)
  let topAI = 0, botAI = 0;                // paddles' own AI target x (smoothed)
  let sTop = 0, sBot = 0, t = 0, serveT = 0, served = -1;
  let rally = 0, trailT = 0;
  const TRAIL = 14;
  const trail = new Float32Array(TRAIL * 2);   // ring of past mote positions
  let trailHead = 0;
  const parts = eng.createParticles(60);

  function pw() { return Math.max(14, eng.vw * 0.20); }   // paddle half... actually full width
  function margin() { return Math.max(6, eng.vh * 0.06); }

  // Serve the mote from centre toward `dir` (+1 down = toward the near/bottom
  // paddle, -1 up). A gentle random horizontal angle keeps rallies varied.
  function serve(dir) {
    bx = eng.vw * 0.5; by = eng.vh * 0.5;
    const ang = (Math.random() * 0.7 - 0.35);            // ±20° off vertical
    const sp = baseSpeed();
    vx = Math.sin(ang) * sp;
    vy = Math.cos(ang) * sp * dir;
    served = dir; serveT = 0.8;                           // brief pause before it flies
    for (let i = 0; i < TRAIL; i++) { trail[i * 2] = bx; trail[i * 2 + 1] = by; }
  }
  function baseSpeed() {
    // Ambient: a calm cross-court pace, nudged a little by intensity. (The
    // global `speed` knob scales the whole sim on top of this.)
    return eng.vh * (0.46 + 0.10 * (curIntensity)) ;
  }
  let curIntensity = 1;

  function reset() {
    topX = botX = topAI = botAI = eng.vw * 0.5;
    sTop = sBot = 0; t = 0; rally = 0; trailT = 0; trailHead = 0;
    parts.clear();
    serve(Math.random() < 0.5 ? 1 : -1);
  }

  // Move a paddle's AI target toward where the mote will cross its row. When the
  // mote is heading AWAY, the AI eases back toward centre (natural, and leaves
  // small openings so points still happen — ambient, not robotic-perfect).
  function paddleTarget(rowY, headingSign) {
    if (Math.sign(vy) === headingSign && vy !== 0) {
      // predict crossing x with one wall reflection (court is bx in [0,vw]).
      const dt = (rowY - by) / vy;
      let px = bx + vx * dt;
      const w = eng.vw;
      // fold into [0,w] (reflect off side walls)
      px = ((px % (2 * w)) + 2 * w) % (2 * w);
      if (px > w) px = 2 * w - px;
      return px;
    }
    return eng.vw * 0.5;       // mote receding → drift to centre
  }

  function update(dt, intent, audio, params) {
    t += dt;
    curIntensity = (params.enemyIntensity ?? 1) * (0.7 + intent.intensity * 0.6);
    const vw = eng.vw, vh = eng.vh;
    const halfP = pw() * 0.5;
    const topY = margin(), botY = vh - margin();

    // ── paddles ───────────────────────────────────────────────────────────
    const paddleSpeed = vw * 1.5;                        // fast enough to cover most shots
    // FAR (top) paddle: pure house AI.
    const tTgt = paddleTarget(topY, -1);
    topAI += (tTgt - topAI) * Math.min(1, dt * 6);
    topX += Math.max(-paddleSpeed * dt, Math.min(paddleSpeed * dt, topAI - topX));
    // NEAR (bottom) paddle: blend the player lean with its own tracking AI by
    // autonomy, so it self-covers while you perform and tracks tight when you lean.
    const bTgt = paddleTarget(botY, 1);
    botAI += (bTgt - botAI) * Math.min(1, dt * 6);
    const leanX = vw * 0.5 + intent.x * vw * 0.5;
    const nearTarget = leanX * intent.playerWeight + botAI * intent.autonomy;
    botX += Math.max(-paddleSpeed * dt, Math.min(paddleSpeed * dt, nearTarget - botX));
    topX = Math.max(halfP, Math.min(vw - halfP, topX));
    botX = Math.max(halfP, Math.min(vw - halfP, botX));

    // ── mote ──────────────────────────────────────────────────────────────
    if (serveT > 0) { serveT -= dt; }                    // hover at centre before launch
    else {
      // Hold the mote's speed at a calm target (a subtle beat shimmer), so an
      // angle kick can never make it run away.
      const spTarget = baseSpeed() * (1 + audio.beat.pulse * 0.12);
      const sp0 = Math.hypot(vx, vy);
      if (sp0 > 0.001) { const k = spTarget / sp0; vx *= k; vy *= k; }

      bx += vx * dt; by += vy * dt;
      // side walls
      if (bx < 2) { bx = 2; vx = Math.abs(vx); }
      if (bx > vw - 2) { bx = vw - 2; vx = -Math.abs(vx); }

      // paddle reflections — bounded angle from the hit offset so the vertical
      // component always stays strong (no infinite horizontal rally), and a
      // one-sided test (reach the plane) so a fast mote can't tunnel through.
      if (vy < 0 && by <= topY + 3 && Math.abs(bx - topX) <= halfP + 2) {
        by = topY + 3;
        const off = Math.max(-1, Math.min(1, (bx - topX) / halfP));
        vx = off * spTarget * 0.7;
        vy = Math.sqrt(Math.max(1, spTarget * spTarget - vx * vx));   // downward
        bounce(bx, by, eng.C.cyan);
      } else if (vy > 0 && by >= botY - 3 && Math.abs(bx - botX) <= halfP + 2) {
        by = botY - 3;
        const off = Math.max(-1, Math.min(1, (bx - botX) / halfP));
        vx = off * spTarget * 0.7;
        vy = -Math.sqrt(Math.max(1, spTarget * spTarget - vx * vx));  // upward
        bounce(bx, by, eng.C.magenta);
      }

      // scoring — mote past a paddle's edge.
      if (by < -4) { sBot++; rally = 0; eng.shake(2); serve(1); }
      else if (by > vh + 4) { sTop++; rally = 0; eng.shake(2); serve(-1); }
    }

    // trail ring
    trailT += dt;
    if (trailT >= 0.016) { trailT = 0; trail[trailHead * 2] = bx; trail[trailHead * 2 + 1] = by; trailHead = (trailHead + 1) % TRAIL; }
    parts.update(dt, 0, 0.9);
  }

  function bounce(x, y, col) {
    rally++; eng.shake(1);
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * 6.28, sp = 20 + Math.random() * 50;
      parts.spawn(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.3, col, 1.5);
    }
  }

  function render(params, intent) {
    const vw = eng.vw, vh = eng.vh, vctx = eng.vctx;
    eng.clear('#04040e');
    const halfP = pw() * 0.5, topY = margin(), botY = vh - margin();

    // Event horizon — a glowing band + black-hole disc across the court centre.
    const cy = vh * 0.5;
    for (let i = 0; i < 5; i++) eng.rect(0, cy - 2 + i, vw, 1, i === 2 ? eng.C.gold : eng.C.amber, i === 2 ? 0.18 : 0.07);
    // centre dashes
    for (let x = 4; x < vw; x += 10) eng.rect(x, cy, 5, 1, eng.C.dim, 0.6);
    const hr = vh * 0.07, hx = vw * 0.5;
    eng.disc(hx, cy, hr * 1.7, eng.C.gold, 0.06);
    eng.disc(hx, cy, hr, '#05050d', 1);
    vctx.strokeStyle = eng.C.gold; vctx.lineWidth = 1; vctx.globalAlpha = 0.5;
    vctx.beginPath(); vctx.ellipse(hx, cy, hr * 1.2, hr * 0.45, 0, 0, Math.PI * 2); vctx.stroke();
    vctx.globalAlpha = 1;

    // mote trail.
    for (let k = 0; k < TRAIL; k++) {
      const idx = ((trailHead - 1 - k) % TRAIL + TRAIL) % TRAIL;
      const a = (1 - k / TRAIL) * 0.5;
      eng.disc(trail[idx * 2], trail[idx * 2 + 1], 1 + (1 - k / TRAIL) * 1.6, eng.C.ice, a);
    }
    // mote.
    eng.disc(bx, by, 2.4, eng.C.white, 1);
    eng.disc(bx, by, 4, eng.C.ice, 0.4);
    parts.draw(vctx);

    // paddles — far (cyan) + near (magenta) light bars with a soft glow.
    drawPaddle(topX, topY, halfP, eng.C.cyan);
    drawPaddle(botX, botY, halfP, eng.C.magenta);

    if (params.hud) {
      eng.beginHud();
      eng.hud(3, 3, 'VOID', sTop, eng.C.cyan, 'left');
      const who = intent.source === 'crowd' ? 'CROWD' : intent.source === 'performer' ? 'YOU' : 'YOU';
      eng.hud(vw - 3, 3, who, sBot, eng.C.magenta, 'right');
      if (rally > 2) eng.textOutline('RALLY ' + rally, vw / 2, 3, eng.C.gold, 1, 'center');
      if (intent.source === 'cpu') eng.text('LEAN TO VOLLEY', vw / 2, vh * 0.36, eng.C.white, 1, 'center', 0.4 + 0.4 * Math.sin(t * 2));
      eng.endHud();
    }
  }

  function drawPaddle(cx, y, half, col) {
    eng.rect(cx - half, y - 1.5, half * 2, 3, col, 1);
    eng.rect(cx - half, y - 2.5, half * 2, 1, eng.C.white, 0.5);
    eng.rect(cx - half - 1, y - 2.5, half * 2 + 2, 5, col, 0.12);   // glow
  }

  return {
    reset, update, render, dispose() { parts.clear(); },
    __test: () => ({ deaths: 0, sTop, sBot, rally }),
  };
}
