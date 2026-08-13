// Metal horns 🤘 — hand-gesture classification + debounce, the pure half of
// the horns feature (node-testable; see scripts/check-qualia-horns.mjs).
//
// Input is MediaPipe HandLandmarker output: 21 normalized landmarks per hand
// (wrist 0, then thumb 1-4, index 5-8, middle 9-12, ring 13-16, pinky 17-20,
// each finger MCP→PIP→DIP→TIP). Classification is geometric — index + pinky
// extended, middle + ring curled — so it needs no extra model beyond the
// landmarker. The thumb is deliberately ignored: 🤘 and 🤟 both count.
// Generosity is a feature on stage; a false horn beats a missed one.
//
// All distances are 2D (z from a single camera is too noisy to gate on) and
// normalized by the wrist→middle-MCP span, so the check is scale-, mirror-
// and rotation-invariant — a raised fist reads the same at 2 m and at 6 m,
// on either hand, camera mirrored or not.
//
// The detector half is a small state machine: a horn must be HELD for
// holdMs before it fires (single-frame flickers never trigger), then the
// gesture must drop out for rearmMs before it can fire again (a held horn
// is one event, not one per detection), with a refractory floor between
// fires as a belt-and-braces rate limit. Timestamps come from the caller so
// the whole thing stays deterministic under test.

const WRIST = 0;
const INDEX_PIP = 6,  INDEX_TIP = 8;
const MIDDLE_MCP = 9, MIDDLE_PIP = 10, MIDDLE_TIP = 12;
const RING_PIP = 14,  RING_TIP = 16;
const PINKY_PIP = 18, PINKY_TIP = 20;

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * One hand's 21 landmarks → is it throwing horns?
 * Extension is measured as how far the fingertip reaches beyond its PIP
 * joint (relative to the wrist, normalized by hand size): an extended
 * finger's tip is well past the PIP; a curled finger folds its tip back
 * level with — or inside — the PIP. Pinkies are shorter, so their bar is
 * lower; the curl bar leaves slack for loosely-tucked middle/ring.
 */
export function isHornsHand(lm) {
  if (!Array.isArray(lm) || lm.length < 21) return false;
  const size = dist(lm[WRIST], lm[MIDDLE_MCP]);
  if (!(size > 1e-4)) return false;
  const reach = (tip, pip) => (dist(lm[tip], lm[WRIST]) - dist(lm[pip], lm[WRIST])) / size;
  return reach(INDEX_TIP, INDEX_PIP) > 0.28
      && reach(PINKY_TIP, PINKY_PIP) > 0.18
      && reach(MIDDLE_TIP, MIDDLE_PIP) < 0.08
      && reach(RING_TIP, RING_PIP) < 0.08;
}

/**
 * Debounced horns detector. Feed it every hand-detection result (an array
 * of per-hand landmark arrays — empty is fine) with its timestamp; it
 * returns { fired, active, count }. `fired` is true exactly once per
 * distinct raised-horns event.
 *
 * @param {{holdMs?:number, rearmMs?:number, refractoryMs?:number,
 *          missGraceMs?:number}} [opts]
 *   holdMs       gesture must persist this long before firing (default 250)
 *   rearmMs      gesture must be gone this long before it can fire again
 *                (default 600)
 *   refractoryMs hard floor between fires (default 2000)
 *   missGraceMs  a single missed detection inside this window doesn't reset
 *                the hold — hand tracking flickers (default 300)
 */
export function createHornsDetector(opts = {}) {
  const holdMs       = opts.holdMs       ?? 250;
  const rearmMs      = opts.rearmMs      ?? 600;
  const refractoryMs = opts.refractoryMs ?? 2000;
  const missGraceMs  = opts.missGraceMs  ?? 300;

  let since = null;       // first sighting of the current hold (null = none)
  let lastSeen = -1e9;    // last sighting (for miss grace + re-arm)
  let firedAt = -1e9;
  let armed = true;
  let count = 0;

  return {
    update(hands, t) {
      const seen = Array.isArray(hands) && hands.some(isHornsHand);
      if (seen) {
        if (since === null) since = t;
        lastSeen = t;
      } else {
        if (since !== null && t - lastSeen > missGraceMs) since = null;
        if (t - lastSeen >= rearmMs) armed = true;
      }
      let fired = false;
      if (armed && since !== null && lastSeen - since >= holdMs && t - firedAt >= refractoryMs) {
        fired = true;
        armed = false;
        firedAt = t;
        count++;
      }
      return { fired, active: since !== null, count };
    },
    /** Currently inside a held horns gesture? */
    active: () => since !== null,
    /** Total fires since creation. */
    count: () => count,
  };
}
