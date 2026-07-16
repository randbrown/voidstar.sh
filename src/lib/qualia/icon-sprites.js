// Shared sprite bakes for the voidstar inlay icons — the Emmons fret-marker
// atoms and Sho-Bud card suits ported from the original Python overlays
// (voidstar/motion/voidstar_particle_sparks.py). Consumed by the Iconism
// quale (fx/iconism.js) and the overlay's icon-shaped sparks (overlay.js).
//
// Everything here is one-time bake cost: shapes are drawn at SHAPE_R px
// radius into an SPR px square canvas (padding for the 1.2× atom orbits +
// glow, which is baked in via shadowBlur at bake time only), then scaled at
// blit time with drawImage. Nothing in this module runs per frame.

// Emmons fretboard atom inlay colors (from the Python emmons_palette_bgr).
export const EMMONS_COLORS = ['#f8d255', '#f5463c', '#5f8cb9', '#f8a537'];
// Sho-Bud classic red + the non-red suit ink options.
export const SHOBUD_RED = '#dc231e';
export const SHOBUD_INK = { white: '#f8f8f8', black: '#181818' };
export const SUITS = ['heart', 'club', 'diamond', 'spade'];

export const SPR = 192;
export const SHAPE_R = 60;

// Suit silhouettes as unit-radius Path2D unions of circles + triangles —
// same construction (and proportions) as the Python draw_shobud_suit.
// Every subpath must wind the same way (clockwise, matching arc()'s
// default) — nonzero winding cancels overlapping regions of opposite
// direction, which reads as notches cut out of the union.
function suitPath(suit) {
  const p = new Path2D();
  const tri = (a, b, c) => {
    p.moveTo(a[0], a[1]); p.lineTo(b[0], b[1]); p.lineTo(c[0], c[1]); p.closePath();
  };
  const dot = (x, y, r) => { p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2); };
  if (suit === 'diamond') {
    p.moveTo(0, -1.15); p.lineTo(0.88, 0); p.lineTo(0, 1.15); p.lineTo(-0.88, 0);
    p.closePath();
  } else if (suit === 'heart') {
    dot(-0.42, -0.22, 0.58); dot(0.42, -0.22, 0.58);
    tri([-0.92, 0.15], [0.92, 0.15], [0, 1.05]);
  } else if (suit === 'club') {
    dot(0, -0.58, 0.52); dot(-0.60, 0.05, 0.52); dot(0.60, 0.05, 0.52);
    tri([0, 0.55], [0.26, 1.18], [-0.26, 1.18]);
  } else { // spade
    dot(-0.42, 0.22, 0.58); dot(0.42, 0.22, 0.58);
    tri([-0.92, -0.15], [0, -1.05], [0.92, -0.15]);
    tri([0, 0.53], [0.24, 1.16], [-0.24, 1.16]);
  }
  return p;
}
const SUIT_PATHS = { heart: suitPath('heart'), club: suitPath('club'),
                     diamond: suitPath('diamond'), spade: suitPath('spade') };

// Scratch canvases for the mask → tint → glow pipeline. Created lazily so
// importing this module never touches the DOM; bakes are synchronous, so
// sharing one pair across all callers is safe.
let maskCanvas = null, tintCanvas = null, maskCtx = null, tintCtx = null;
function ensureScratch() {
  if (maskCanvas) return;
  maskCanvas = document.createElement('canvas');
  tintCanvas = document.createElement('canvas');
  maskCanvas.width = maskCanvas.height = SPR;
  tintCanvas.width = tintCanvas.height = SPR;
  maskCtx = maskCanvas.getContext('2d');
  tintCtx = tintCanvas.getContext('2d');
}

function makeLayer() {
  const c = document.createElement('canvas');
  c.width = c.height = SPR;
  return c;
}

function fillSuitMask(suit) {
  maskCtx.setTransform(1, 0, 0, 1, 0, 0);
  maskCtx.clearRect(0, 0, SPR, SPR);
  maskCtx.translate(SPR / 2, SPR / 2);
  maskCtx.scale(SHAPE_R, SHAPE_R);
  maskCtx.fillStyle = '#fff';
  maskCtx.fill(SUIT_PATHS[suit]);
}

/**
 * Bake one suit sprite: union silhouette, tinted, baked glow. Outline style
 * is a true contour ring — dilate the mask (16 offset stamps) then punch the
 * mask back out, leaving a uniform-width band that follows the union edge
 * exactly (the Canvas2D stand-in for the Python's cv2.drawContours).
 */
export function bakeSuitSprite(suit, color, outline) {
  ensureScratch();
  const spr = makeLayer();
  const c = spr.getContext('2d');
  fillSuitMask(suit);
  tintCtx.setTransform(1, 0, 0, 1, 0, 0);
  tintCtx.clearRect(0, 0, SPR, SPR);
  if (outline) {
    const w = SHAPE_R * 0.13;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      tintCtx.drawImage(maskCanvas, Math.cos(a) * w, Math.sin(a) * w);
    }
    tintCtx.globalCompositeOperation = 'destination-out';
    tintCtx.drawImage(maskCanvas, 0, 0);
  } else {
    tintCtx.drawImage(maskCanvas, 0, 0);
  }
  tintCtx.globalCompositeOperation = 'source-in';
  tintCtx.fillStyle = color;
  tintCtx.fillRect(0, 0, SPR, SPR);
  tintCtx.globalCompositeOperation = 'source-over';
  c.shadowColor = color;
  c.shadowBlur = 10;
  c.drawImage(tintCanvas, 0, 0);
  c.shadowBlur = 0;
  return spr;
}

/**
 * Bake one Emmons atom sprite: three orbit ellipses at 0/60/120° + nucleus,
 * glow baked. `withElectrons` also bakes one electron per orbit at the
 * Python's phase offsets (0 / 2.15 / 4.30) — for consumers that spin the
 * whole sprite instead of animating electrons live (Iconism draws its own
 * live electrons per frame and passes false).
 */
export function bakeAtomSprite(color, withElectrons = false) {
  ensureScratch();
  const spr = makeLayer();
  const c = spr.getContext('2d');
  const cx = SPR / 2, cy = SPR / 2;
  const a = SHAPE_R * 1.20, b = SHAPE_R * 0.48;
  c.strokeStyle = color;
  c.lineWidth = Math.max(1.5, SHAPE_R * 0.075);
  c.shadowColor = color;
  c.shadowBlur = 8;
  for (let k = 0; k < 3; k++) {
    c.beginPath();
    c.ellipse(cx, cy, a, b, (k * Math.PI) / 3, 0, Math.PI * 2);
    c.stroke();
  }
  c.fillStyle = color;
  c.beginPath();
  c.arc(cx, cy, SHAPE_R * 0.24, 0, Math.PI * 2);
  c.fill();
  if (withElectrons) {
    const er = SHAPE_R * 0.17;
    for (let k = 0; k < 3; k++) {
      const th = (k * Math.PI) / 3;
      const t = k * 2.15;
      const ex0 = a * Math.cos(t), ey0 = b * Math.sin(t);
      const ex = ex0 * Math.cos(th) - ey0 * Math.sin(th);
      const ey = ex0 * Math.sin(th) + ey0 * Math.cos(th);
      c.beginPath();
      c.arc(cx + ex, cy + ey, er, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.shadowBlur = 0;
  return spr;
}
