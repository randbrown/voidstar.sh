// Detector — CV-overlay aesthetic. Bounding boxes with persistent IDs,
// decimal confidence scores, a tracked-point trail, and floating
// "keypoint" IDs around the body. The visual language of YOLO / SORT /
// ByteTrack demo reels, applied as a live HUD over the camera (or pure
// black, blackout-preset). We're NOT running a real detector — boxes
// are derived from the existing MediaPipe pose landmarks and a pool of
// drifting "phantom" pseudo-detections that sell the look even when no
// one is in frame.
//
// Modes:
//   pose    — boxes only on detected body parts (honest, but empty
//             when nobody's on camera).
//   hybrid  — pose boxes + a sprinkling of drifting phantoms (default).
//   phantom — phantoms only; no pose dependency. Works on any footage.
//
// Audio map (via scaleAudio + params.reactivity):
//   beat.pulse  → box stroke thickens briefly (~80 ms decay)
//   bands.bass  → trail width / glow boost
//   bands.highs → phantom churn (faster ID turnover on hi-hats)

import { scaleAudio } from '../field.js';
import { lmToCanvas, getVideoEl, getRotation, applyPreviewTransform } from '../video.js';

// Joints used as box anchors. The "torso" box is special-cased from
// shoulders + hips.
const BOX_JOINTS = [
  { key: 'head',       size: 1.6 },
  { key: 'wrists.l',   size: 0.9 },
  { key: 'wrists.r',   size: 0.9 },
  { key: 'elbows.l',   size: 0.8 },
  { key: 'elbows.r',   size: 0.8 },
  { key: 'ankles.l',   size: 1.0 },
  { key: 'ankles.r',   size: 1.0 },
];

// Joints used as floating "SLAM-keypoint" markers (only when keypointIDs on).
const KP_JOINTS = ['knees.l', 'knees.r', 'hips.l', 'hips.r', 'shoulders.l', 'shoulders.r'];

const PALETTES = {
  white: { main: [240, 240, 240], dim: [180, 180, 180] },
  pink:  { main: [244, 114, 182], dim: [236, 72, 153]  },
  cyan:  { main: [34, 211, 238],  dim: [14, 165, 233]  },
  amber: { main: [251, 191, 36],  dim: [217, 119, 6]   },
};

function getJoint(person, key) {
  const dot = key.indexOf('.');
  if (dot < 0) return person[key];
  return person[key.slice(0, dot)]?.[key.slice(dot + 1)];
}

function rgba([r, g, b], a) { return `rgba(${r},${g},${b},${a})`; }

/** @type {import('../types.js').QFXModule} */
export default {
  id: 'detector',
  name: 'Detector',
  contextType: 'canvas2d',

  params: [
    { id: 'mode',        label: 'mode',           type: 'select', options: ['pose', 'hybrid', 'phantom'], default: 'hybrid' },
    { id: 'palette',     label: 'palette',        type: 'select', options: ['white', 'pink', 'cyan', 'amber'], default: 'white' },
    { id: 'boxes',       label: 'phantom boxes',  type: 'range',  min: 0, max: 24, step: 1,    default: 8 },
    { id: 'trail',       label: 'trail',          type: 'range',  min: 0, max: 1,  step: 0.02, default: 0.55 },
    { id: 'connect',     label: 'connect boxes',  type: 'toggle', default: false },
    { id: 'bgFade',      label: 'bg fade',        type: 'range',  min: 0, max: 1,  step: 0.02, default: 0.0 },
    { id: 'showConf',    label: 'confidence',     type: 'toggle', default: true },
    { id: 'keypointIDs', label: 'keypoint IDs',   type: 'toggle', default: true },
    { id: 'reactivity',  label: 'reactivity',     type: 'range',  min: 0, max: 2,  step: 0.05, default: 1.0 },
  ],

  presets: {
    default:   { mode: 'hybrid',  boxes: 8,  trail: 0.55, connect: false, bgFade: 0.00, palette: 'white', showConf: true,  keypointIDs: true  },
    blackout:  { mode: 'pose',    boxes: 4,  trail: 0.70, connect: false, bgFade: 1.00, palette: 'white', showConf: false, keypointIDs: false },
    yolo_pink: { mode: 'hybrid',  boxes: 14, trail: 0.35, connect: true,  bgFade: 0.00, palette: 'pink',  showConf: true,  keypointIDs: false },
    slam:      { mode: 'hybrid',  boxes: 18, trail: 0.20, connect: false, bgFade: 0.00, palette: 'cyan',  showConf: false, keypointIDs: true  },
  },

  autoPhase: {
    steps: [
      { palette: 'white' },
      { palette: 'pink'  },
      { palette: 'cyan'  },
      { palette: 'amber' },
    ],
  },

  async create(canvas, { ctx }) {
    let W = canvas.width, H = canvas.height;

    // Tracker — logicalKey → { id, lastSeen }. logicalKey is a stable
    // identity string per (person, joint) so IDs persist across frames
    // even as MediaPipe re-emits coordinates.
    const tracks = new Map();
    let nextId = 1;

    // Per-track ring-buffer trails. Keyed by the same logicalKey.
    const trails = new Map();
    const MAX_TRAIL = 240;

    // Phantom pool — drifting pseudo-detections.
    let phantoms = [];

    // Per-fx clock for dt and decay maths.
    let lastT = performance.now();

    // Scratch — params snapshot + audio reads, populated in update(),
    // drained in render(). Matches the pattern used by camera.js / telemetry.js.
    const scratch = {
      mode: 'hybrid',
      palette: 'white',
      boxes: 8,
      trail: 0.55,
      connect: false,
      bgFade: 0.0,
      showConf: true,
      keypointIDs: true,
      bass: 0, mids: 0, highs: 0, beatP: 0, audioOn: false,
      people: [],
    };

    function ensurePhantoms(n) {
      while (phantoms.length < n) phantoms.push(spawnPhantom());
      if (phantoms.length > n) phantoms.length = n;
    }

    function spawnPhantom() {
      return {
        id: nextId++,
        kpId: 100 + Math.floor(Math.random() * 1899),
        x: 0.1 + Math.random() * 0.8,
        y: 0.1 + Math.random() * 0.8,
        vx: (Math.random() - 0.5) * 0.00006,
        vy: (Math.random() - 0.5) * 0.00006,
        w: 0.04 + Math.random() * 0.10,
        h: 0.04 + Math.random() * 0.10,
        conf: 0.1 + Math.random() * 0.5,
        life: 1.0,
      };
    }

    function updatePhantoms(dt, highs) {
      for (let i = 0; i < phantoms.length; i++) {
        const p = phantoms[i];
        // gentle Brownian drift
        p.vx += (Math.random() - 0.5) * 0.00002;
        p.vy += (Math.random() - 0.5) * 0.00002;
        const vmax = 0.0008;
        if (p.vx >  vmax) p.vx =  vmax; else if (p.vx < -vmax) p.vx = -vmax;
        if (p.vy >  vmax) p.vy =  vmax; else if (p.vy < -vmax) p.vy = -vmax;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < 0.05) { p.x = 0.05; p.vx *= -1; }
        if (p.x > 0.95) { p.x = 0.95; p.vx *= -1; }
        if (p.y < 0.05) { p.y = 0.05; p.vy *= -1; }
        if (p.y > 0.95) { p.y = 0.95; p.vy *= -1; }
        // confidence wobble (gives the "score is updating" feel)
        p.conf = 0.15 + 0.45 * (0.5 + 0.5 * Math.sin(p.x * 7.3 + p.y * 11.7 + lastT * 0.0015 + p.id));
        // life decays; high-frequency audio churns them faster
        p.life -= (0.0005 + 0.004 * highs) * dt;
        if (p.life <= 0) phantoms[i] = spawnPhantom();
      }
    }

    function getTrackId(key, cx, cy, t) {
      const prev = tracks.get(key);
      if (prev) {
        prev.lastSeen = t;
        prev.cx = cx; prev.cy = cy;
        return prev.id;
      }
      const id = nextId++;
      tracks.set(key, { id, cx, cy, lastSeen: t });
      return id;
    }

    function gcTracks(t) {
      // Drop tracks that haven't been seen in 1.5 s.
      for (const [k, v] of tracks) {
        if (t - v.lastSeen > 1500) tracks.delete(k);
      }
      for (const [k, v] of trails) {
        const tr = tracks.get(k);
        if (!tr) trails.delete(k);
        else if (v.length > MAX_TRAIL) v.splice(0, v.length - MAX_TRAIL);
      }
    }

    function pushTrail(key, x, y) {
      let buf = trails.get(key);
      if (!buf) { buf = []; trails.set(key, buf); }
      buf.push(x, y);
      if (buf.length > MAX_TRAIL * 2) buf.splice(0, buf.length - MAX_TRAIL * 2);
    }

    function update(field) {
      const t = performance.now();
      const dt = Math.min(64, t - lastT);
      lastT = t;

      const { params } = field;
      const audio = scaleAudio(field.audio, params.reactivity);

      scratch.mode        = params.mode;
      scratch.palette     = params.palette;
      scratch.boxes       = params.boxes | 0;
      scratch.trail       = params.trail;
      scratch.connect     = !!params.connect;
      scratch.bgFade      = params.bgFade;
      scratch.showConf    = !!params.showConf;
      scratch.keypointIDs = !!params.keypointIDs;
      scratch.bass        = audio.bands.bass;
      scratch.mids        = audio.bands.mids;
      scratch.highs       = audio.bands.highs;
      scratch.beatP       = audio.beat.pulse;
      scratch.audioOn     = !!audio.spectrum;
      scratch.people      = (params.mode === 'phantom') ? [] : (field.pose?.people || []);

      // Maintain phantom pool size (drop to 0 in 'pose' mode).
      const wantPhantoms = (params.mode === 'pose') ? 0 : scratch.boxes;
      ensurePhantoms(wantPhantoms);
      updatePhantoms(dt, scratch.highs);
      gcTracks(t);
    }

    function pal() { return PALETTES[scratch.palette] || PALETTES.white; }

    function drawBox(x, y, w, h, label, conf, strokeAlpha, lineW) {
      const p = pal();
      ctx.lineWidth = lineW;
      ctx.strokeStyle = rgba(p.main, strokeAlpha);
      // Box itself.
      ctx.strokeRect(x, y, w, h);
      // Tiny corner ticks — gives the boxes the "tracker reticule" feel.
      const tk = Math.min(8, Math.min(w, h) * 0.25);
      ctx.beginPath();
      ctx.moveTo(x, y + tk); ctx.lineTo(x, y); ctx.lineTo(x + tk, y);
      ctx.moveTo(x + w - tk, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + tk);
      ctx.moveTo(x + w, y + h - tk); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - tk, y + h);
      ctx.moveTo(x + tk, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - tk);
      ctx.lineWidth = lineW + 0.6;
      ctx.stroke();

      if (label != null) {
        ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = rgba(p.main, Math.min(1, strokeAlpha + 0.1));
        ctx.fillText(label, x, y - 3);
      }
      if (conf != null && scratch.showConf) {
        ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textBaseline = 'top';
        ctx.fillStyle = rgba(p.dim, Math.min(1, strokeAlpha + 0.05));
        ctx.fillText(conf.toFixed(4), x, y + h + 2);
      }
    }

    function drawTrail(buf, alpha) {
      if (!buf || buf.length < 4) return;
      const p = pal();
      const cap = Math.max(2, Math.floor(scratch.trail * MAX_TRAIL));
      const points = Math.min(buf.length / 2, cap) | 0;
      const start = (buf.length / 2 - points) * 2;
      const widthBoost = 0.6 + scratch.bass * 1.6;
      ctx.lineWidth = 1.1 * widthBoost;
      ctx.strokeStyle = rgba(p.main, 0.55 * alpha);
      ctx.beginPath();
      ctx.moveTo(buf[start], buf[start + 1]);
      for (let i = start + 2; i < buf.length; i += 2) {
        ctx.lineTo(buf[i], buf[i + 1]);
      }
      ctx.stroke();
    }

    function drawKpId(x, y, id, alpha) {
      const p = pal();
      ctx.fillStyle = rgba(p.dim, 0.85 * alpha);
      ctx.fillRect(x - 1, y - 1, 2, 2);
      ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = rgba(p.main, 0.85 * alpha);
      ctx.fillText(String(id), x + 4, y);
    }

    function renderCameraBackground() {
      // Camera passthrough, dimmed by bgFade. At bgFade=1 we draw pure
      // black (matches the itsdemotapes look). Same maths as camera.js
      // but stripped of tints/vignette/etc.
      ctx.fillStyle = '#05050d';
      ctx.fillRect(0, 0, W, H);
      if (scratch.bgFade >= 0.999) return;

      const video = getVideoEl();
      const ready = video && video.videoWidth > 0 && video.videoHeight > 0;
      if (!ready) return;

      const vw = video.videoWidth, vh = video.videoHeight;
      const rot = getRotation();
      const rotated = rot === 90 || rot === 270;
      const ew = rotated ? vh : vw;
      const eh = rotated ? vw : vh;
      const scale = Math.max(W / ew, H / eh); // cover

      ctx.save();
      applyPreviewTransform(ctx, W, H);
      ctx.drawImage(video, -vw * scale / 2, -vh * scale / 2, vw * scale, vh * scale);
      ctx.restore();

      if (scratch.bgFade > 0.001) {
        ctx.fillStyle = `rgba(5,5,13,${scratch.bgFade})`;
        ctx.fillRect(0, 0, W, H);
      }
    }

    function render() {
      const t = performance.now();
      renderCameraBackground();

      const beatBoost = Math.max(0, scratch.beatP);
      const baseLW = 1.2 + beatBoost * 1.4;

      // Collected box centroids for the optional connect-edges pass.
      const centroids = [];

      // 1. Pose-anchored boxes.
      if (scratch.mode !== 'phantom') {
        for (let pi = 0; pi < scratch.people.length; pi++) {
          const person = scratch.people[pi];
          if (!person) continue;

          // Scale unit ≈ shoulder span.
          const sL = person.shoulders?.l, sR = person.shoulders?.r;
          let span = 0.12;
          if (sL && sR) {
            const [aX, aY] = lmToCanvas(sL.x, sL.y, W, H);
            const [bX, bY] = lmToCanvas(sR.x, sR.y, W, H);
            const d = Math.hypot(aX - bX, aY - bY);
            if (d > 1) span = d / Math.min(W, H);
          }
          const unit = span * Math.min(W, H);

          // Torso box (shoulders + hips bbox).
          const corners = [person.shoulders?.l, person.shoulders?.r, person.hips?.l, person.hips?.r]
            .filter(c => c && c.visibility > 0.2);
          if (corners.length >= 3) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, visSum = 0;
            for (const c of corners) {
              const [x, y] = lmToCanvas(c.x, c.y, W, H);
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
              visSum += c.visibility;
            }
            const padX = unit * 0.25, padY = unit * 0.15;
            const bx = minX - padX, by = minY - padY;
            const bw = (maxX - minX) + padX * 2, bh = (maxY - minY) + padY * 2;
            const conf = visSum / corners.length;
            const key = `p${pi}:torso`;
            const id = getTrackId(key, bx + bw / 2, by + bh / 2, t);
            drawBox(bx, by, bw, bh, `ID ${id}`, conf, 0.85, baseLW);
            centroids.push([bx + bw / 2, by + bh / 2]);
          }

          // Anchored joint boxes.
          for (const j of BOX_JOINTS) {
            const lm = getJoint(person, j.key);
            if (!lm || lm.visibility < 0.25) continue;
            const [x, y] = lmToCanvas(lm.x, lm.y, W, H);
            const size = unit * j.size;
            const bx = x - size / 2, by = y - size / 2;
            const key = `p${pi}:${j.key}`;
            const id = getTrackId(key, x, y, t);
            const alpha = 0.55 + Math.min(0.45, lm.visibility * 0.55);
            drawBox(bx, by, size, size, `ID ${id}`, lm.visibility, alpha, baseLW);
            centroids.push([x, y]);

            // Trail the head joint (and only the head — keeps it readable).
            if (j.key === 'head') {
              pushTrail(key, x, y);
              drawTrail(trails.get(key), 1);
            }
          }

          // SLAM-style keypoint IDs on the remaining named joints.
          if (scratch.keypointIDs) {
            for (const kpKey of KP_JOINTS) {
              const lm = getJoint(person, kpKey);
              if (!lm || lm.visibility < 0.4) continue;
              const [x, y] = lmToCanvas(lm.x, lm.y, W, H);
              const key = `p${pi}:kp:${kpKey}`;
              const id = getTrackId(key, x, y, t);
              // Hash the track ID into a stable 3-4 digit display ID so
              // it looks SLAM-y (huge integers) without growing without bound.
              drawKpId(x, y, 300 + (id * 137) % 1700, 0.85);
            }
          }
        }
      }

      // 2. Phantom drifters.
      for (const ph of phantoms) {
        const cx = ph.x * W, cy = ph.y * H;
        const bw = ph.w * W, bh = ph.h * H;
        const bx = cx - bw / 2, by = cy - bh / 2;
        const fade = Math.min(1, ph.life) * (0.45 + ph.conf * 0.55);
        drawBox(bx, by, bw, bh, `ID ${ph.id}`, ph.conf, fade, baseLW * 0.85);
        centroids.push([cx, cy]);
        if (scratch.keypointIDs) {
          drawKpId(bx + bw + 4, by + bh / 2, ph.kpId, fade);
        }
      }

      // 3. Trail the first phantom in phantom-only mode so there's still
      // a moving polyline to anchor the eye.
      if (scratch.mode === 'phantom' && phantoms[0]) {
        const ph = phantoms[0];
        const key = `ph:${ph.id}`;
        pushTrail(key, ph.x * W, ph.y * H);
        drawTrail(trails.get(key), 1);
      }

      // 4. Optional connect edges between the N closest box pairs.
      if (scratch.connect && centroids.length >= 2) {
        const p = pal();
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = rgba(p.dim, 0.35);
        const maxEdges = Math.min(centroids.length, 14);
        // Cheap O(n²) — n is capped at ~24, fine for 60 fps.
        const edges = [];
        for (let i = 0; i < centroids.length; i++) {
          for (let j = i + 1; j < centroids.length; j++) {
            const dx = centroids[i][0] - centroids[j][0];
            const dy = centroids[i][1] - centroids[j][1];
            edges.push([dx * dx + dy * dy, i, j]);
          }
        }
        edges.sort((a, b) => a[0] - b[0]);
        ctx.beginPath();
        for (let i = 0; i < Math.min(maxEdges, edges.length); i++) {
          const [, a, b] = edges[i];
          ctx.moveTo(centroids[a][0], centroids[a][1]);
          ctx.lineTo(centroids[b][0], centroids[b][1]);
        }
        ctx.stroke();
      }
    }

    return {
      resize(w, h /*, dpr */) { W = w; H = h; },
      update,
      render,
      dispose() {
        tracks.clear();
        trails.clear();
        phantoms = [];
      },
    };
  },
};
