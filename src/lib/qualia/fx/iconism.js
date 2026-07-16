// Iconism — pedal-steel fretboard inlay tributes as video-synthesized
// sprites, ported from the original voidstar Python overlays
// (voidstar/motion/voidstar_particle_sparks.py, color modes emmons|shobud).
//
// Modes:
//   • atomism      — Emmons fret-marker atoms: a nucleus ringed by three
//                    Bohr orbits at 0°/60°/120°, one electron per orbit,
//                    in the classic Emmons inlay colors (yellow, red,
//                    slate blue, orange).
//   • atemporalism — Sho-Bud fretboard card suits (heart/club/diamond/
//                    spade), classic red + white-or-black, solid or
//                    outline, with a beat-shimmered edge.
//
// The icons spawn where motion happens: per-joint pose velocity (wrists/
// elbows/head, mapped with lmToCanvas so they land where you appear on
// screen) plus a coarse frame-difference grid on the live camera when a
// stream is flowing. They drift and spin slowly, collide elastically
// (mass ∝ r²), and pop a small particle burst at the contact point.
//
// Background: 'void' (near-page-black — reads as transparent over Hydra
// via the fx canvas's screen blend) or 'camera' (the live feed painted
// underneath, same non-owning pattern as fx/camera.js). Note: black
// suits only read against the camera background — over the void the
// screen blend makes near-black invisible, so darkSuit defaults white.
//
// Audio map: density is modulated declaratively (total → mul, beatPulse
//   → add) so the pills show in the param panel; inline, bass nudges the
//   drift speed, beat.pulse puffs icon scale, highs.pulse feeds the suit
//   edge shimmer, and each beat forces a spawn at a live motion point.
// Idle: with no audio and no camera, a low ambient spawn rate keeps a
//   handful of icons drifting so the quale never looks dead.
//
// Perf: sprites are pre-rendered once per (mode/style/ink) config and
// blitted with drawImage (glow baked in via one-time shadowBlur), so the
// hot path is ~40 blits + electron dots. The motion grid is ≤ 80×N cells
// sampled every other frame. Hot path allocates nothing.

import { scaleAudio } from '../field.js';
import { getVideoEl, getRotation, applyPreviewTransform, lmToCanvas } from '../video.js';
import {
  EMMONS_COLORS, SHOBUD_RED, SHOBUD_INK, SUITS, SPR, SHAPE_R,
  bakeAtomSprite, bakeSuitSprite,
} from '../icon-sprites.js';

const MAX_ICONS     = 40;
const MAX_PARTICLES = 240;
const MAX_SPAWNS    = 24;   // spawn-candidate slots refilled each frame

const GRID_W       = 80;   // motion-diff grid width (cells)
const MOTION_THRESH = 24;  // per-cell luma delta (0..255) that counts as motion

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'iconism',
  name: 'Iconism',
  contextType: 'canvas2d',

  params: [
    { id: 'mode',       label: 'mode',       type: 'select', options: ['atomism', 'atemporalism'], default: 'atomism' },
    { id: 'background', label: 'background', type: 'select', options: ['void', 'camera'], default: 'void' },
    { id: 'density',    label: 'density',    type: 'range', min: 0, max: 2, step: 0.05, default: 1.0,
      modulators: [
        { source: 'audio.total',     mode: 'mul', amount: 0.35 },
        { source: 'audio.beatPulse', mode: 'add', amount: 0.25 },
      ] },
    { id: 'size',       label: 'size',       type: 'range', min: 0.4, max: 2.5, step: 0.05, default: 1.0 },
    { id: 'speed',      label: 'drift',      type: 'range', min: 0, max: 3, step: 0.05, default: 1.0 },
    { id: 'spin',       label: 'spin',       type: 'range', min: 0, max: 3, step: 0.05, default: 1.0 },
    { id: 'style',      label: 'suit style', type: 'select', options: ['solid', 'outline'], default: 'solid' },
    { id: 'darkSuit',   label: 'suit ink',   type: 'select', options: ['white', 'black'], default: 'white' },
    { id: 'reactivity', label: 'reactivity', type: 'range', min: 0, max: 2, step: 0.05, default: 1.0 },
  ],

  autoPhase: {
    steps: [
      { mode: 'atomism' },
      { mode: 'atemporalism', style: 'solid' },
      { mode: 'atemporalism', style: 'outline' },
    ],
  },

  presets: {
    default: { mode: 'atomism', background: 'void', density: 1.0, size: 1.0,
               speed: 1.0, spin: 1.0, style: 'solid', darkSuit: 'white', reactivity: 1.0 },
    emmons:  { mode: 'atomism', density: 1.3, size: 1.15 },
    shobud:  { mode: 'atemporalism', style: 'solid', darkSuit: 'white' },
    neon:    { mode: 'atemporalism', style: 'outline', darkSuit: 'white', density: 1.3 },
    // Black suits are only legible over the camera frame (see header note).
    ink:     { mode: 'atemporalism', style: 'solid', darkSuit: 'black', background: 'camera' },
    onstage: { background: 'camera', density: 1.2 },
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;
    let minDim = Math.max(1, Math.min(W, H));

    // ── Sprite bake (shared bakes in ../icon-sprites.js) ────────────────────
    // One canvas per (shape, ink, style): 4 atom colors, 4 suits in the
    // current (style, darkSuit) config, 4 white suit outlines for shimmer.
    // Rebuilt only when style/darkSuit change — never per frame. Atoms bake
    // without electrons — this fx animates them live in render().

    const atomSprites = EMMONS_COLORS.map(c => bakeAtomSprite(c, false));
    // White outlines used as the beat-shimmer edge pass over solid suits.
    const shimmerSprites = SUITS.map(s => bakeSuitSprite(s, '#ffffff', true));
    let suitSprites = null;
    let suitBakeKey = '';
    function ensureSuitSprites(style, ink) {
      const key = `${style}|${ink}`;
      if (key === suitBakeKey) return;
      suitBakeKey = key;
      const outline = style === 'outline';
      suitSprites = SUITS.map(s => {
        const red = s === 'heart' || s === 'diamond';
        return bakeSuitSprite(s, red ? SHOBUD_RED : SHOBUD_INK[ink], outline);
      });
    }
    ensureSuitSprites('solid', 'white');

    // ── Pools (allocated once; the hot path reuses them forever) ───────────
    const icons = [];
    for (let i = 0; i < MAX_ICONS; i++) {
      icons.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, r: 30, angle: 0,
                   spin: 0, phase: 0, phaseSpeed: 2, ci: 0, si: 0,
                   life: 0, maxLife: 10, cool: 0 });
    }
    const parts = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      parts.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, r: 2, color: '#fff' });
    }
    let partHead = 0;

    // Spawn candidates, refilled each update (motion cells + fast joints).
    const spawnX = new Float32Array(MAX_SPAWNS);
    const spawnY = new Float32Array(MAX_SPAWNS);
    const spawnW = new Float32Array(MAX_SPAWNS);
    let spawnN = 0;
    let spawnAcc = 0;

    // ── Camera motion grid ──────────────────────────────────────────────────
    const gridCanvas = document.createElement('canvas');
    const gridCtx = gridCanvas.getContext('2d', { willReadFrequently: true });
    let gw = GRID_W, gh = 45;
    let lumaA = new Uint8Array(gw * gh);
    let lumaB = new Uint8Array(gw * gh);
    let lumaPrimed = false;
    let frameCount = 0;

    function sizeGrid() {
      gh = Math.max(8, Math.round((GRID_W * H) / Math.max(1, W)));
      gridCanvas.width = gw;
      gridCanvas.height = gh;
      lumaA = new Uint8Array(gw * gh);
      lumaB = new Uint8Array(gw * gh);
      lumaPrimed = false;
    }
    sizeGrid();

    // Draw the live frame cover-fitted into the grid with the same
    // mirror/rotation as the preview, so cell coords map straight onto the
    // canvas (matching where the motion appears on screen).
    function scanMotion(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const rot = getRotation();
      const rotated = rot === 90 || rot === 270;
      const ew = rotated ? vh : vw, eh = rotated ? vw : vh;
      const scale = Math.max(gw / ew, gh / eh);
      gridCtx.setTransform(1, 0, 0, 1, 0, 0);
      gridCtx.clearRect(0, 0, gw, gh);
      gridCtx.save();
      applyPreviewTransform(gridCtx, gw, gh);
      gridCtx.drawImage(video, (-vw * scale) / 2, (-vh * scale) / 2, vw * scale, vh * scale);
      gridCtx.restore();
      const data = gridCtx.getImageData(0, 0, gw, gh).data;
      const curr = lumaA, prev = lumaB;
      for (let i = 0, p = 0; i < curr.length; i++, p += 4) {
        curr[i] = (data[p] + (data[p + 1] << 1) + data[p + 2]) >> 2;
      }
      if (lumaPrimed) {
        // Reservoir-ish pick: cells over threshold randomly claim spawn
        // slots, weighted by how hard they moved.
        for (let i = 0; i < curr.length; i++) {
          const d = Math.abs(curr[i] - prev[i]);
          if (d < MOTION_THRESH) continue;
          if (spawnN < MAX_SPAWNS) {
            const cy = (i / gw) | 0, cx = i - cy * gw;
            spawnX[spawnN] = ((cx + 0.5) / gw) * W;
            spawnY[spawnN] = ((cy + 0.5) / gh) * H;
            spawnW[spawnN] = Math.min(3, d / MOTION_THRESH);
            spawnN++;
          } else if (Math.random() < 0.25) {
            const slot = (Math.random() * MAX_SPAWNS) | 0;
            const cy = (i / gw) | 0, cx = i - cy * gw;
            spawnX[slot] = ((cx + 0.5) / gw) * W;
            spawnY[slot] = ((cy + 0.5) / gh) * H;
            spawnW[slot] = Math.min(3, d / MOTION_THRESH);
          }
        }
      }
      lumaB = curr; lumaA = prev;   // swap
      lumaPrimed = true;
    }

    // ── Pose joint velocity → spawn candidates ──────────────────────────────
    // head + wrists + elbows for up to two people; a joint moving faster
    // than ~10% of the frame per second is "motion". Never snaps on a brief
    // tracking dropout — a joint just stops contributing candidates.
    const P_JOINTS = 5;
    const prevJoint = new Float32Array(2 * P_JOINTS * 2);
    const prevJointOk = new Uint8Array(2 * P_JOINTS);

    function poseCandidates(people, dt) {
      for (let pi = 0; pi < 2; pi++) {
        const person = people[pi];
        for (let ji = 0; ji < P_JOINTS; ji++) {
          const slot = pi * P_JOINTS + ji;
          if (!person) { prevJointOk[slot] = 0; continue; }
          const lm = ji === 0 ? person.head
                   : ji === 1 ? person.wrists.l : ji === 2 ? person.wrists.r
                   : ji === 3 ? person.elbows.l : person.elbows.r;
          if (!lm || lm.visibility < 0.4) { prevJointOk[slot] = 0; continue; }
          const [x, y] = lmToCanvas(lm.x, lm.y, W, H);
          if (prevJointOk[slot] && dt > 0) {
            const dx = x - prevJoint[slot * 2], dy = y - prevJoint[slot * 2 + 1];
            const speed = Math.hypot(dx, dy) / dt;
            const thresh = minDim * 0.10;
            if (speed > thresh && spawnN < MAX_SPAWNS) {
              spawnX[spawnN] = x;
              spawnY[spawnN] = y;
              spawnW[spawnN] = Math.min(4, speed / thresh);
              spawnN++;
            }
          }
          prevJoint[slot * 2] = x; prevJoint[slot * 2 + 1] = y;
          prevJointOk[slot] = 1;
        }
      }
    }

    // ── Spawning ────────────────────────────────────────────────────────────
    function spawnIcon(x, y, sizeParam) {
      let ic = null;
      for (let i = 0; i < MAX_ICONS; i++) {
        if (!icons[i].alive) { ic = icons[i]; break; }
      }
      if (!ic) return;
      const jitter = minDim * 0.04;
      ic.alive = true;
      ic.x = Math.max(0, Math.min(W, x + (Math.random() - 0.5) * jitter));
      ic.y = Math.max(0, Math.min(H, y + (Math.random() - 0.5) * jitter));
      ic.r = minDim * 0.05 * sizeParam * (0.75 + Math.random() * 0.6);
      const dir = Math.random() * Math.PI * 2;
      const sp = minDim * (0.03 + Math.random() * 0.05);
      ic.vx = Math.cos(dir) * sp;
      ic.vy = Math.sin(dir) * sp;
      ic.angle = Math.random() * Math.PI * 2;
      ic.spin = (0.2 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1);
      ic.phase = Math.random() * Math.PI * 2;
      ic.phaseSpeed = 1.8 + Math.random() * 1.2;
      ic.ci = (Math.random() * EMMONS_COLORS.length) | 0;
      ic.si = (Math.random() * SUITS.length) | 0;
      ic.life = 0;
      ic.maxLife = 8 + Math.random() * 6;
      ic.cool = 0;
    }

    function burst(x, y, colorA, colorB, n) {
      for (let i = 0; i < n; i++) {
        const p = parts[partHead];
        partHead = (partHead + 1) % MAX_PARTICLES;
        const dir = Math.random() * Math.PI * 2;
        const sp = minDim * (0.05 + Math.random() * 0.22);
        p.alive = true;
        p.x = x; p.y = y;
        p.vx = Math.cos(dir) * sp;
        p.vy = Math.sin(dir) * sp;
        p.maxLife = 0.35 + Math.random() * 0.45;
        p.life = p.maxLife;
        p.r = Math.max(1.5, minDim * (0.002 + Math.random() * 0.004));
        p.color = Math.random() < 0.5 ? colorA : colorB;
      }
    }

    function iconColor(ic, mode, ink) {
      if (mode === 'atomism') return EMMONS_COLORS[ic.ci];
      const suit = SUITS[ic.si];
      return suit === 'heart' || suit === 'diamond' ? SHOBUD_RED : SHOBUD_INK[ink];
    }

    // ── Scratch (update → render handoff; render never reads field) ────────
    const scratch = {
      mode: 'atomism', bgCamera: false, style: 'solid', ink: 'white',
      beatP: 0, highsP: 0, audioOn: false, videoReady: false,
    };

    let seeded = false;

    function update(field) {
      const { params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);
      const dt = field.dt;
      frameCount++;

      // First frame with a real canvas: seed a few drifters so the quale
      // boots alive instead of waiting out the spawn accumulator.
      if (!seeded && W > 2 && H > 2) {
        seeded = true;
        for (let i = 0; i < 5; i++) {
          spawnIcon(Math.random() * W, Math.random() * H, params.size);
        }
      }

      ensureSuitSprites(params.style, params.darkSuit);
      scratch.mode = params.mode;
      scratch.bgCamera = params.background === 'camera';
      scratch.style = params.style;
      scratch.ink = params.darkSuit;
      scratch.beatP = audio.beat.pulse;
      scratch.highsP = audio.highs.pulse;
      scratch.audioOn = !!audio.spectrum;

      const video = getVideoEl();
      scratch.videoReady = !!(video && video.videoWidth > 0 && video.videoHeight > 0);

      // Refill spawn candidates: camera motion (every other frame) + fast
      // pose joints + one low-weight ambient point so the pool idles alive.
      spawnN = 0;
      if (scratch.videoReady && (frameCount & 1) === 0) scanMotion(video);
      poseCandidates(field.pose.people, dt);
      if (spawnN < MAX_SPAWNS) {
        spawnX[spawnN] = Math.random() * W;
        spawnY[spawnN] = Math.random() * H;
        spawnW[spawnN] = 0.15;
        spawnN++;
      }

      // Spawn budget — density is already audio-modulated declaratively;
      // energy shapes the floor so quiet passages thin the field out, and a
      // beat hit forces a spawn at a live motion point (the Python's
      // audio-scaled spawn_prob, sharpened per the beat-pulse doctrine).
      const energy = scratch.audioOn ? audio.bands.total : 0.35;
      spawnAcc += params.density * (0.25 + 1.5 * energy) * dt;
      if (audio.beat.active) spawnAcc += 0.6 * params.density;
      if (spawnAcc > 3) spawnAcc = 3;
      while (spawnAcc >= 1) {
        spawnAcc -= 1;
        let tot = 0;
        for (let i = 0; i < spawnN; i++) tot += spawnW[i];
        let r = Math.random() * tot;
        let pick = spawnN - 1;
        for (let i = 0; i < spawnN; i++) { r -= spawnW[i]; if (r <= 0) { pick = i; break; } }
        spawnIcon(spawnX[pick], spawnY[pick], params.size);
      }

      // Advance icons: drift (bass leans on the throttle), slow spin,
      // electron/shimmer phase, edge bounce, life envelope.
      const driftMul = params.speed * (1 + 0.5 * audio.bands.bass);
      for (let i = 0; i < MAX_ICONS; i++) {
        const ic = icons[i];
        if (!ic.alive) continue;
        ic.life += dt;
        if (ic.life >= ic.maxLife) { ic.alive = false; continue; }
        ic.x += ic.vx * driftMul * dt;
        ic.y += ic.vy * driftMul * dt;
        ic.angle += ic.spin * params.spin * dt;
        ic.phase += ic.phaseSpeed * dt;
        if (ic.cool > 0) ic.cool -= dt;
        if (ic.x < ic.r && ic.vx < 0) ic.vx = -ic.vx;
        else if (ic.x > W - ic.r && ic.vx > 0) ic.vx = -ic.vx;
        if (ic.y < ic.r && ic.vy < 0) ic.vy = -ic.vy;
        else if (ic.y > H - ic.r && ic.vy > 0) ic.vy = -ic.vy;
      }

      // Pairwise elastic collisions (n ≤ 40 → the O(n²) sweep is cheap).
      // Impulse along the contact normal with mass ∝ r², restitution 0.92,
      // a touch of spin exchange, and a particle pop (cooldown-gated so an
      // overlapping pair doesn't machine-gun confetti).
      for (let i = 0; i < MAX_ICONS; i++) {
        const a = icons[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < MAX_ICONS; j++) {
          const b = icons[j];
          if (!b.alive) continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const minD = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d, ny = dy / d;
          const overlap = minD - d;
          a.x -= nx * overlap * 0.5; a.y -= ny * overlap * 0.5;
          b.x += nx * overlap * 0.5; b.y += ny * overlap * 0.5;
          const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
          const vn = rvx * nx + rvy * ny;
          if (vn < 0) {
            const ma = a.r * a.r, mb = b.r * b.r;
            const imp = (-(1 + 0.92) * vn) / (1 / ma + 1 / mb);
            a.vx -= (imp / ma) * nx; a.vy -= (imp / ma) * ny;
            b.vx += (imp / mb) * nx; b.vy += (imp / mb) * ny;
            const kick = (Math.abs(vn) / minDim) * 4;
            a.spin += (Math.random() - 0.5) * kick;
            b.spin += (Math.random() - 0.5) * kick;
            if (a.cool <= 0 && b.cool <= 0) {
              a.cool = b.cool = 0.25;
              const cx = a.x + nx * a.r, cy = a.y + ny * a.r;
              burst(cx, cy,
                    iconColor(a, scratch.mode, scratch.ink),
                    iconColor(b, scratch.mode, scratch.ink),
                    6 + ((Math.random() * 5) | 0));
            }
          }
        }
      }

      // Burst particles: drag + fade.
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = parts[i];
        if (!p.alive) continue;
        p.life -= dt;
        if (p.life <= 0) { p.alive = false; continue; }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.96;
        p.vy *= 0.96;
      }
    }

    // ── Render ──────────────────────────────────────────────────────────────
    function drawCameraBg(video) {
      const vw = video.videoWidth, vh = video.videoHeight;
      const rot = getRotation();
      const rotated = rot === 90 || rot === 270;
      const ew = rotated ? vh : vw, eh = rotated ? vw : vh;
      const scale = Math.max(W / ew, H / eh);
      ctx.save();
      applyPreviewTransform(ctx, W, H);
      ctx.drawImage(video, (-vw * scale) / 2, (-vh * scale) / 2, vw * scale, vh * scale);
      ctx.restore();
      // Light scrim so the icons stay legible over a bright room.
      ctx.fillStyle = 'rgba(5,5,13,0.18)';
      ctx.fillRect(0, 0, W, H);
    }

    function render() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);

      const video = getVideoEl();
      if (scratch.bgCamera) {
        if (scratch.videoReady && video) {
          drawCameraBg(video);
        } else {
          ctx.fillStyle = 'rgba(180,200,220,0.5)';
          ctx.font = '600 18px ui-sans-serif, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('camera off — set pose source to "camera"', W / 2, H / 2);
          ctx.textAlign = 'left';
        }
      }

      // Collision confetti under the icons, additive.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = parts[i];
        if (!p.alive) continue;
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      const atomism = scratch.mode === 'atomism';
      const beatPuff = 1 + 0.10 * scratch.beatP;
      for (let i = 0; i < MAX_ICONS; i++) {
        const ic = icons[i];
        if (!ic.alive) continue;
        // Fade in fast, fade out over the last stretch of life.
        const tIn = Math.min(1, ic.life / 0.35);
        const tOut = Math.min(1, (ic.maxLife - ic.life) / 1.2);
        const alpha = Math.min(tIn, tOut);
        const r = ic.r * beatPuff;
        const ds = (r / SHAPE_R) * SPR;

        ctx.save();
        ctx.translate(ic.x, ic.y);
        ctx.rotate(ic.angle);
        ctx.globalAlpha = alpha;
        if (atomism) {
          ctx.drawImage(atomSprites[ic.ci], -ds / 2, -ds / 2, ds, ds);
          // Live electrons — one per orbit, phases offset like the Python.
          const A = r * 1.20, B = r * 0.48;
          const er = Math.max(1.5, r * 0.17);
          ctx.fillStyle = EMMONS_COLORS[ic.ci];
          for (let k = 0; k < 3; k++) {
            const th = (k * Math.PI) / 3;
            const t = ic.phase + k * 2.15;
            const ex0 = A * Math.cos(t), ey0 = B * Math.sin(t);
            const ex = ex0 * Math.cos(th) - ey0 * Math.sin(th);
            const ey = ex0 * Math.sin(th) + ey0 * Math.cos(th);
            ctx.beginPath();
            ctx.arc(ex, ey, er, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          ctx.drawImage(suitSprites[ic.si], -ds / 2, -ds / 2, ds, ds);
          // Edge shimmer — the Python's contour glint, driven by highs.
          const shimmer = (0.18 + 0.5 * scratch.highsP)
                        * (0.5 + 0.5 * Math.sin(ic.phase * 2.3));
          if (shimmer > 0.02) {
            ctx.globalAlpha = alpha * shimmer;
            ctx.globalCompositeOperation = 'lighter';
            ctx.drawImage(shimmerSprites[ic.si], -ds / 2, -ds / 2, ds, ds);
            ctx.globalCompositeOperation = 'source-over';
          }
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    return {
      resize(w, h /*, dpr */) {
        W = w; H = h;
        minDim = Math.max(1, Math.min(W, H));
        sizeGrid();
        // Icons outside the new bounds drift back via the edge bounce.
      },
      update,
      render,
      dispose() {
        // Drop sprite/scratch backing stores promptly; pools are plain JS.
        for (const c of atomSprites) { c.width = c.height = 0; }
        for (const c of shimmerSprites) { c.width = c.height = 0; }
        if (suitSprites) for (const c of suitSprites) { c.width = c.height = 0; }
        gridCanvas.width = gridCanvas.height = 0;
      },
    };
  },
};
