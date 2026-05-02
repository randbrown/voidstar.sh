// Camera rotation + mirror — applied to BOTH the video preview element (CSS
// transform) and to landmark coordinates (via lmToCanvas) so the rendered
// skeleton tracks the visual orientation of the preview.
//
// Important: lmToCanvas applies rotation FIRST, then mirror — matching CSS
// transform order ("scaleX(-1) rotate(N)" applies right-to-left, i.e.
// rotate then scale). A simpler "flip then rotate" path would also work
// for mirror=on (the X-flip masks a sign error in rotation), but it breaks
// for mirror=off because the masking flip isn't there.

let cameraRotation = 0;   // 0 | 90 | 180 | 270
let mirrorMode    = true; // selfie-style by default

let _videoEl = null;

export function bindVideoElement(videoEl) {
  _videoEl = videoEl;
  applyTransform();
}

export function getRotation() { return cameraRotation; }
export function setRotation(deg) {
  const d = ((deg % 360) + 360) % 360;
  cameraRotation = [0, 90, 180, 270].includes(d) ? d : 0;
  applyTransform();
}
export function cycleRotation() {
  setRotation(cameraRotation + 90);
  return cameraRotation;
}

export function getMirror() { return mirrorMode; }
export function setMirror(v) { mirrorMode = !!v; applyTransform(); }
export function toggleMirror() { setMirror(!mirrorMode); return mirrorMode; }

function applyTransform() {
  if (!_videoEl) return;
  // CSS applies right-to-left: rotate first, then scale. lmToCanvas mirrors
  // that order so landmarks end up where the rotated/mirrored preview shows.
  _videoEl.style.transform = `${mirrorMode ? 'scaleX(-1) ' : ''}rotate(${cameraRotation}deg)`;
}

/**
 * Map a [0,1]² landmark to canvas pixel coords with rotation + mirror
 * applied — in that order. Matches CSS `scaleX(-1) rotate(N)`.
 *
 * Standard CSS rotation matrix (Y-axis points down, +angle is clockwise on
 * screen):  R(dx, dy) = (dx·cosθ − dy·sinθ,  dx·sinθ + dy·cosθ)
 *   90 CW:   (-dy,  dx)
 *   180:     (-dx, -dy)
 *   270 CW:  ( dy, -dx)
 */
export function lmToCanvas(lmx, lmy, W, H) {
  let x = lmx * W, y = lmy * H;
  if (cameraRotation !== 0) {
    const cx = W / 2, cy = H / 2;
    const dx = x - cx, dy = y - cy;
    switch (cameraRotation) {
      case  90: x = cx - dy; y = cy + dx; break;
      case 180: x = cx - dx; y = cy - dy; break;
      case 270: x = cx + dy; y = cy - dx; break;
    }
  }
  if (mirrorMode) x = W - x;
  return [x, y];
}
