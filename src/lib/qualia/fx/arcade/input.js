// Arcade input — turns the three QualiaField surfaces into one normalized game
// "intent" struct the games consume. The whole point is that a game never reads
// pose/crowd/audio directly: it reads `intent.x`, `intent.jump`, `intent.fire`,
// `intent.intensity`, etc., and works identically whether it's being driven by
//
//   • the entangled CROWD   (field.crowd — the aggregate of every phone), or
//   • the PERFORMER's body  (field.pose.people[0]), or
//   • a CPU attract loop     (nobody present — keeps the screen alive).
//
// `controlMode` ('auto' | 'crowd' | 'performer') picks the surface; 'auto'
// prefers the crowd when anyone is entangled, falls back to the performer, then
// to CPU. Tier-B (per-phone virtual gamepad) will later add a 'players' surface
// here without games changing.
//
// Edge-triggered buttons (jump/fire/action) are true for exactly one frame on a
// rising gesture; left/right also auto-repeat (DAS-style) so menu/Tetris moves
// feel right. All smoothing/edge state lives in the closure — zero allocation
// per frame, the intent object is reused.

const DEAD = 0.22;          // analog dead-zone for digital left/right
const DAS_MS = 240;         // delay before auto-repeat kicks in
const REPEAT_MS = 90;       // auto-repeat interval while held
const THRUST_SPEED = 2.4;   // wrist speed (norm units/s) that counts as a "fire"
const THRUST_COOLDOWN = 0.34;

export function createInput() {
  // Reused output — never reallocated.
  const intent = {
    x: 0, y: 0,
    left: false, right: false, up: false, down: false,
    jump: false, jumpHeld: false,
    fire: false, fireHeld: false,
    action: false, actionHeld: false,
    duck: false,
    intensity: 0,
    source: 'cpu',
    active: false,
    presence: 0,           // 0..1 how strongly someone is driving (for prompts)
    // Autonomy: how much the GAME should drive itself vs follow the player
    // signal. 0 = the player is fully in control; 1 = the sim plays itself and
    // the player only nudges. Games blend `lerp(playerSignal, aiSignal,
    // autonomy)` for analog control and gate discrete/AI buttons by it.
    //   • nobody present (cpu)  → 1.0   (pure attract autopilot)
    //   • performer (you)       → `autopilot` param (default 0.7 — mostly self-
    //                             driving, your pose nudges; you're making music)
    //   • crowd entangled       → autopilot × 0.2  (tight coupling — they play)
    autonomy: 1,
    playerWeight: 0,       // = 1 - autonomy, convenience for games
    // Performer MOVEMENT magnitude (0..1) — a "seed" channel for games to add
    // small flourishes/randomness from how much you're moving, WITHOUT letting
    // your held posture steer anything. In crowd source this carries crowd energy.
    poseEnergy: 0,
  };

  // Smoothed analog + edge memory.
  let ax = 0, ay = 0;
  let prevUp = false, prevFire = false, prevAction = false;
  let repeatDir = 0, repeatTimer = 0, repeatArmed = false;
  let thrustCool = 0;
  let lwx = 0, lwy = 0, rwx = 0, rwy = 0, wristPrimed = false;
  let wristSpeed = 0;     // last-frame max wrist speed (for poseEnergy)
  // Auto-mode high-pass: a slow EMA baseline of the performer's lean. In `auto`
  // mode the player signal is (lean − baseline), so a HELD posture (leaning to
  // play steel) fades into the baseline and contributes ZERO steering — only
  // deliberate MOVEMENT registers. Explicit `performer` mode uses absolute lean.
  let leanBaseX = 0, leanBaseY = 0, leanPrimed = false;
  let poseEnergy = 0;    // 0..1 performer movement magnitude (a randomness seed)

  // CPU attract state.
  let cpuT = 0, cpuFireT = 0;

  function decideSource(field, mode) {
    if (mode === 'expert') return 'expert';       // pure autopilot — no pose, no crowd
    const c = field.crowd;
    const crowdPresent = c && (c.count > 0.001 || c.confidence > 0.05);
    const p0 = field.pose && field.pose.people && field.pose.people[0];
    const perfPresent = p0 && p0.confidence > 0.3;
    if (mode === 'crowd')     return crowdPresent ? 'crowd' : 'cpu';
    if (mode === 'performer') return perfPresent ? 'performer' : 'cpu';
    // auto
    if (crowdPresent) return 'crowd';
    if (perfPresent)  return 'performer';
    return 'cpu';
  }

  // ── Per-source raw reads ──────────────────────────────────────────────────
  // Each fills targetX/Y (-1..1), and the boolean gesture rails.
  let tx = 0, ty = 0, upRaw = false, fireRaw = false, duckRaw = false, pres = 0;

  function readCrowd(c, audio) {
    // sway = low-passed mean head x → smooth steering for a room leaning as one.
    tx = clamp(c.sway * 1.4, -1, 1);
    ty = clamp(c.y * 1.4, -1, 1);
    // Hands up across the crowd → jump/fire; deeper raise → fire.
    upRaw   = c.rise > 0.40;
    fireRaw = c.rise > 0.62 || (c.energy > 0.55 && audio.beat.active);
    duckRaw = c.y > 0.34;
    pres = Math.max(c.count, c.confidence, c.energy * 0.8);
  }

  function readPerformer(p0, dt) {
    // Mirror to match the on-screen preview convention used app-wide
    // (code.js: (1 - head.x)*2 - 1). Lean right → +1.
    const head = p0.head;
    tx = clamp((1 - head.x) * 2 - 1, -1, 1);
    ty = clamp((head.y - 0.45) * 2.2, -1, 1);
    duckRaw = head.y > 0.62;

    const sL = p0.shoulders && p0.shoulders.l, sR = p0.shoulders && p0.shoulders.r;
    const wL = p0.wrists && p0.wrists.l,       wR = p0.wrists && p0.wrists.r;
    // Hands up: either wrist clearly above the shoulder line.
    let handsUp = false;
    if (sL && sR && wL && wR) {
      const shY = (sL.y + sR.y) * 0.5;
      const upL = wL.visibility > 0.3 && wL.y < shY - 0.04;
      const upR = wR.visibility > 0.3 && wR.y < shY - 0.04;
      handsUp = upL || upR;
    }
    upRaw = handsUp;

    // Wrist thrust → fire. Track wrist speed in normalized units/sec (also
    // feeds poseEnergy, the movement seed).
    fireRaw = false;
    wristSpeed = 0;
    if (thrustCool > 0) thrustCool -= dt;
    if (wL && wR && dt > 0) {
      if (wristPrimed) {
        const sl = Math.hypot(wL.x - lwx, wL.y - lwy) / dt;
        const sr = Math.hypot(wR.x - rwx, wR.y - rwy) / dt;
        wristSpeed = Math.max(sl, sr);
        if (thrustCool <= 0 && wristSpeed > THRUST_SPEED) {
          fireRaw = true; thrustCool = THRUST_COOLDOWN;
        }
      }
      lwx = wL.x; lwy = wL.y; rwx = wR.x; rwy = wR.y; wristPrimed = true;
    } else { wristPrimed = false; }

    pres = p0.confidence;
  }

  function readCpu(dt, audio, time) {
    // Gentle autonomous play so an unattended cabinet still moves. Slow wander
    // plus beat-aware button taps.
    cpuT += dt;
    tx = Math.sin(cpuT * 0.6) * 0.7 + Math.sin(cpuT * 1.7 + 1) * 0.25;
    ty = Math.sin(cpuT * 0.45 + 2) * 0.5;
    duckRaw = Math.sin(cpuT * 0.9) > 0.85;
    upRaw = false; fireRaw = false;
    cpuFireT -= dt;
    if (audio.beat.active && cpuFireT <= 0) { upRaw = true; fireRaw = true; cpuFireT = 0.25; }
    else if (cpuFireT <= -0.6) { upRaw = Math.random() < 0.5; fireRaw = true; cpuFireT = 0.4; }
    pres = 0;
  }

  return {
    /** @param {import('../../types.js').QualiaField} field */
    read(field, params) {
      const dt = Math.min(0.05, field.dt || 0.016);
      const audio = field.audio;
      const mode = (params && params.controlMode) || 'auto';
      const src = decideSource(field, mode);

      if (src === 'crowd')          readCrowd(field.crowd, audio);
      else if (src === 'performer') readPerformer(field.pose.people[0], dt);
      else if (src === 'expert')    { tx = 0; ty = 0; upRaw = false; fireRaw = false; duckRaw = false; pres = 0; }
      else                          readCpu(dt, audio, field.time);

      const ap = (params && typeof params.autopilot === 'number') ? params.autopilot : 0.7;

      // Resolve the effective player signal (sigX/sigY) + autonomy per source.
      //  • crowd    → absolute lean, tight coupling (they're actively playing).
      //  • performer + explicit 'performer' mode → absolute lean, autopilot=ap.
      //  • performer + 'auto' mode → HIGH-PASS: signal = lean − slow baseline, so
      //    a held posture (you leaning to play steel) contributes ~0 and only a
      //    deliberate movement nudges; autonomy is pushed well above ap so the
      //    sim is firmly self-driving. poseEnergy carries the movement as a seed.
      //  • cpu      → no signal, full autopilot.
      let sigX = tx, sigY = ty, autonomy;
      if (src === 'crowd') {
        autonomy = ap * 0.2;
        poseEnergy = clamp((field.crowd && field.crowd.energy) || 0, 0, 1);
        leanPrimed = false;
      } else if (src === 'performer') {
        const bk = Math.min(1, dt / 1.4);                 // ~1.4s baseline tracking
        if (!leanPrimed) { leanBaseX = tx; leanBaseY = ty; leanPrimed = true; }
        const transX = tx - leanBaseX, transY = ty - leanBaseY;
        leanBaseX += transX * bk; leanBaseY += transY * bk;
        poseEnergy = clamp(Math.abs(transX) * 2 + Math.abs(transY) * 1.2 + wristSpeed * 0.12, 0, 1);
        if (mode === 'auto') {
          sigX = clamp(transX * 1.8, -1, 1);
          sigY = clamp(transY * 1.8, -1, 1);
          autonomy = ap + (1 - ap) * 0.6;                 // 0.7 → 0.88; firmly self-driving
        } else {
          sigX = tx; sigY = ty; autonomy = ap;            // explicit performer: full nudge
        }
      } else {
        autonomy = 1.0; poseEnergy = 0; leanPrimed = false;
      }

      // Smooth analog (crowd/perf jitter; CPU is already smooth). k≈8*dt.
      const k = Math.min(1, dt * 8);
      ax += (sigX - ax) * k;
      ay += (sigY - ay) * k;

      intent.x = ax; intent.y = ay;
      intent.source = src;
      // "active" = a human is meaningfully driving. Expert (pure autopilot) and
      // cpu (attract) are NOT active. Games gate the "lean to play" prompt on
      // source==='cpu' so it only shows in true attract mode.
      intent.active = src === 'crowd' || src === 'performer';
      intent.presence = clamp(pres, 0, 1);
      intent.poseEnergy = poseEnergy;
      intent.autonomy = autonomy;
      intent.playerWeight = 1 - autonomy;

      // Digital left/right with DAS auto-repeat.
      const dir = ax < -DEAD ? -1 : ax > DEAD ? 1 : 0;
      intent.left = intent.right = false;
      if (dir === 0) { repeatDir = 0; repeatArmed = false; repeatTimer = 0; }
      else {
        if (dir !== repeatDir) {                 // fresh press → immediate step
          repeatDir = dir; repeatArmed = false; repeatTimer = DAS_MS / 1000;
          if (dir < 0) intent.left = true; else intent.right = true;
        } else {
          repeatTimer -= dt;
          if (repeatTimer <= 0) {
            if (dir < 0) intent.left = true; else intent.right = true;
            repeatTimer = (repeatArmed ? REPEAT_MS : DAS_MS) / 1000;
            repeatArmed = true;
          }
        }
      }

      intent.up   = upRaw;
      intent.down = duckRaw || ay > DEAD;
      intent.duck = duckRaw;

      // Edge triggers.
      intent.jump   = upRaw   && !prevUp;
      intent.fire   = fireRaw && !prevFire;
      intent.action = upRaw   && !prevAction;   // alias; games pick jump or action
      intent.jumpHeld = upRaw; intent.fireHeld = fireRaw; intent.actionHeld = upRaw;
      prevUp = upRaw; prevFire = fireRaw; prevAction = upRaw;

      // World intensity: audio energy + crowd rowdiness, 0..1. Games multiply
      // this by their own params.enemyIntensity knob.
      const c = field.crowd;
      intent.intensity = clamp(
        0.12 + audio.bands.bass * 0.5 + audio.beat.pulse * 0.4 +
        audio.bands.total * 0.25 + (c ? c.energy * 0.6 : 0), 0, 1);

      return intent;
    },
    reset() {
      ax = ay = 0; prevUp = prevFire = prevAction = false;
      repeatDir = 0; repeatTimer = 0; repeatArmed = false;
      thrustCool = 0; wristPrimed = false; cpuT = 0; cpuFireT = 0;
    },
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
