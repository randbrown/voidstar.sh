// AudioContext unlock — one place that owns "is the browser actually letting
// our audio contexts run yet?".
//
// Why this exists: the rig, the mic, the recordable mix, and the vocoder each
// own a separate AudioContext (see docs/architecture.md — multi-context is
// intentional), and every one of them is created from a code path that can run
// WITHOUT user activation. The big one is auto-boot: a returning performer's
// page restores the rig panel and re-opens the rig capture during page-init,
// long before the first click. Under Chrome's autoplay policy a context created
// there starts `suspended`, and — this is the part that bit us — `resume()`
// returns a promise that DOES NOT SETTLE until the page gets a user gesture.
//
// Two failure modes fell out of that, and both matched the "rig doesn't go live
// until I mute/unmute or open the tuner" report:
//   1. `await ctx.resume()` on the capture-open path never returns, so the
//      capture graph is never built at all — until some later gesture releases
//      the pending promise and the queued open finally runs.
//   2. The graph IS built (permission is already granted, getUserMedia
//      resolves) but the context stays suspended, so nothing renders while the
//      UI cheerfully reports the rig as live.
//
// So: never block a build path on resume(), and retry the resume on the first
// real user gesture instead of hoping one of the audio panels happens to ask.
//
// Everything here is idempotent and allocation-free on the hot path — the
// gesture listeners detach themselves once every registered context is running,
// and re-attach if one falls back to suspended (OS sleep, device switch).

/** @type {Set<AudioContext>} */
const contexts = new Set();
const stateListeners = new Set();

// Gestures that grant activation. `keydown` matters for the rig specifically:
// the performer's fastest path back into the app is a hotkey, not a click.
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchend'];
let listening = false;
let sawGesture = false;

function anySuspended() {
  for (const ctx of contexts) if (ctx.state === 'suspended') return true;
  return false;
}

function kick(ctx) {
  if (!ctx || ctx.state !== 'suspended') return;
  // Fire-and-forget: the promise may stay pending until activation arrives,
  // which is precisely the thing no caller may wait on.
  try { ctx.resume().catch(() => {}); } catch {}
}

function pump() {
  for (const ctx of contexts) kick(ctx);
  if (!anySuspended()) detach();
}

const onGesture = () => { sawGesture = true; pump(); };
const onVisible = () => { if (!document.hidden) pump(); };

function attach() {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  for (const t of GESTURE_EVENTS) {
    document.addEventListener(t, onGesture, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', onVisible);
}

function detach() {
  if (!listening) return;
  listening = false;
  for (const t of GESTURE_EVENTS) document.removeEventListener(t, onGesture, true);
  document.removeEventListener('visibilitychange', onVisible);
}

function notifyState() {
  for (const fn of stateListeners) { try { fn(); } catch {} }
}

/**
 * Put `ctx` under the unlock watch. Safe to call repeatedly with the same
 * context. Returns the context so it can wrap a constructor call:
 *   ctx = registerContext(new AudioContext());
 */
export function registerContext(ctx) {
  if (!ctx || contexts.has(ctx)) return ctx;
  contexts.add(ctx);
  try {
    ctx.addEventListener?.('statechange', () => {
      if (ctx.state === 'closed') { contexts.delete(ctx); notifyState(); return; }
      // A context can fall BACK to suspended (laptop sleep, output device
      // yanked mid-set) — re-arm the gesture watch when that happens.
      if (ctx.state === 'suspended') attach();
      notifyState();
    });
  } catch {}
  kick(ctx);
  if (ctx.state === 'suspended') attach();
  return ctx;
}

export function unregisterContext(ctx) {
  if (ctx) contexts.delete(ctx);
}

/**
 * Ask `ctx` to resume, but NEVER block the caller longer than `timeoutMs` on a
 * browser that defers the promise until user activation. Returns whether the
 * context is running by the time we give up — callers should treat `false` as
 * "build the graph anyway, it'll start when the user touches the page", not as
 * a failure.
 */
export async function resumeContext(ctx, { timeoutMs = 250 } = {}) {
  if (!ctx) return false;
  registerContext(ctx);
  if (ctx.state === 'running') return true;
  if (ctx.state === 'closed')  return false;
  let timer = null;
  try {
    await Promise.race([
      ctx.resume(),
      new Promise((res) => { timer = setTimeout(res, timeoutMs); }),
    ]);
  } catch {}
  finally { if (timer) clearTimeout(timer); }
  return ctx.state === 'running';
}

/** True once the page has seen a user gesture (i.e. resume() can succeed). */
export function hasUserGesture() { return sawGesture; }

/** Subscribe to "some registered context changed state" — UI uses this to stop
 *  claiming a source is live while its context is still suspended. */
export function onContextStateChange(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}
