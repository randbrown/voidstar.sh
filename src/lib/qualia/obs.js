// obs-websocket v5 client — drives OBS Studio as a recording backend.
//
// WHY this exists alongside the in-page recorder: qualia is meant to be shown
// in its entirety. The topbar, the panels, the strudel REPL, the QR interject
// popups, the theme — those are the show, not chrome around it. The in-page
// recorder's "qfx" mode composites the fx + overlay canvases only, so it
// structurally cannot capture any of that, and "tab" mode pins Chrome's
// "Sharing this tab" banner over the page for the whole take. OBS capturing
// the app's own OS window (or the whole display it's fullscreened on) is the
// only route that records the instrument as the audience sees it.
//
// So this module deliberately does NO capture of its own. It is a remote
// control: connect, optionally match OBS's canvas to this display, start/stop
// the recording, and mirror OBS's record state back into the rec button.
// Everything about WHAT gets captured lives in the user's OBS scene, which is
// a one-time setup and far more capable than anything we'd drive from here.
//
// Transport notes:
//   - obs-websocket 5.x listens on ws://127.0.0.1:4455 by default. An insecure
//     ws:// to a loopback host is NOT mixed-content-blocked from an https page
//     (loopback counts as potentially trustworthy), verified on Chromium 141.
//   - Chrome 141+ ships the Local Network Access permission prompt for
//     public-origin → loopback requests. WebSockets aren't covered by it yet
//     but are on the roadmap, so a connect failure has to surface as a real,
//     readable error rather than a silent no-op.
//   - There is no way to launch OBS from a page. If it isn't running with the
//     WebSocket server enabled, connecting fails and we say so.
//
// Protocol (obs-websocket 5.x): JSON messages tagged with an `op` code.
//   0 Hello · 1 Identify · 2 Identified · 5 Event · 6 Request · 7 RequestResponse
// Auth is challenge/response:
//   secret = base64(sha256(password + salt))
//   auth   = base64(sha256(secret + challenge))

const NS = 'voidstar.qualia.obs';

// EventSubscription bitmask — we only want the Outputs category, which is what
// carries RecordStateChanged. Subscribing to everything would firehose scene /
// input / sceneitem events we have no use for.
const SUB_OUTPUTS = 1 << 6;

const OP_HELLO = 0, OP_IDENTIFY = 1, OP_IDENTIFIED = 2;
const OP_EVENT = 5, OP_REQUEST = 6, OP_REQUEST_RESPONSE = 7;

// OBS clamps base/output dimensions to this. A 5K/6K panel exceeds it, so
// "match this display" has to degrade rather than send an invalid request.
const OBS_MAX_DIM = 4096;

export const OBS_DEFAULTS = {
  url:      'ws://127.0.0.1:4455',
  password: '',
  scene:    '',          // '' = leave OBS on whatever scene is live
  // NOTE: there is deliberately no "match the canvas at record time" setting.
  // See the SetVideoSettings warning on matchResolution() below — that request
  // crashes OBS, so it is a manual setup-time action only.
};

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }

export function loadObsConfig() {
  let saved = {};
  try { saved = JSON.parse(lsGet(`${NS}.config`, 'null')) || {}; } catch {}
  const cfg = { ...OBS_DEFAULTS, ...saved };
  cfg.url = String(cfg.url || OBS_DEFAULTS.url);
  cfg.password = String(cfg.password || '');
  cfg.scene = String(cfg.scene || '');
  // `matchResolution` / `fps` were persisted by the first version, which applied
  // them on every rec press. That crashed OBS (see matchResolution below), so
  // they're dropped on load rather than migrated — an old profile must not be
  // able to reintroduce the crash.
  delete cfg.matchResolution;
  delete cfg.fps;
  return cfg;
}
export function saveObsConfig(cfg) {
  try { lsSet(`${NS}.config`, JSON.stringify(cfg)); } catch {}
}

const enc = new TextEncoder();
async function sha256b64(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function makeAuth(password, salt, challenge) {
  const secret = await sha256b64(password + salt);
  return sha256b64(secret + challenge);
}

/** The display's true pixel size, clamped to what OBS accepts. `screen.width`
 *  is in CSS px; multiplying by devicePixelRatio gives the panel's real pixels
 *  (3456×2234 on a 16" MacBook, not 1728×1117). */
export function displayPixelSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((window.screen?.width  || window.innerWidth)  * dpr);
  const h = Math.round((window.screen?.height || window.innerHeight) * dpr);
  return {
    width:  Math.max(1, Math.min(OBS_MAX_DIM, w)),
    height: Math.max(1, Math.min(OBS_MAX_DIM, h)),
    clamped: w > OBS_MAX_DIM || h > OBS_MAX_DIM,
    rawWidth: w, rawHeight: h,
  };
}

/**
 * @param {object} opts
 * @param {(state) => void} opts.onState  called on every connection/record
 *   state change with { connected, connecting, recording, paused, error,
 *   outputPath, obsVersion, scenes }
 */
export function createObsClient({ onState } = {}) {
  let ws = null;
  let connected = false, connecting = false, identified = null;
  let recording = false, paused = false;
  let lastError = '';
  let outputPath = '';
  let obsVersion = '';
  let scenes = [];
  // Deliberate disconnects must not trigger the reconnect-on-close path.
  let closingOnPurpose = false;

  let reqSeq = 0;
  const pending = new Map();   // requestId -> { resolve, reject, timer }

  function state() {
    return { connected, connecting, recording, paused, error: lastError,
             outputPath, obsVersion, scenes: scenes.slice() };
  }
  function notify() { try { onState?.(state()); } catch {} }

  function failPending(reason) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    pending.clear();
  }

  function cleanup(err) {
    connected = false; connecting = false; identified = null;
    recording = false; paused = false;
    if (err) lastError = err;
    failPending(err || 'obs disconnected');
    ws = null;
    notify();
  }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('not connected to OBS');
    ws.send(JSON.stringify(obj));
  }

  /** Issue one request and await its RequestResponse. */
  function request(requestType, requestData, { timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      let requestId;
      try {
        requestId = `q${(reqSeq++).toString(36)}`;
        send({ op: OP_REQUEST, d: { requestType, requestId, requestData } });
      } catch (e) { reject(e); return; }
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`OBS request ${requestType} timed out`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
    });
  }

  function onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const { op, d } = msg || {};

    if (op === OP_HELLO) {
      obsVersion = d?.obsWebSocketVersion || '';
      const auth = d?.authentication;
      const finish = (authString) => {
        try {
          send({ op: OP_IDENTIFY, d: {
            rpcVersion: d?.rpcVersion ?? 1,
            ...(authString ? { authentication: authString } : {}),
            eventSubscriptions: SUB_OUTPUTS,
          } });
        } catch (e) { identified?.reject(e); }
      };
      if (auth?.challenge && auth?.salt) {
        const pw = identified?.password ?? '';
        if (!pw) {
          // Authenticating with an empty password would just fail on the OBS
          // side with an opaque 4009; say the actual thing that's wrong.
          identified?.reject(new Error('OBS requires a password — set one in the obs settings'));
          try { ws.close(); } catch {}
          return;
        }
        makeAuth(pw, auth.salt, auth.challenge).then(finish).catch(e => identified?.reject(e));
      } else {
        finish(null);
      }
      return;
    }

    if (op === OP_IDENTIFIED) {
      connected = true; connecting = false; lastError = '';
      identified?.resolve();
      notify();
      return;
    }

    if (op === OP_REQUEST_RESPONSE) {
      const p = pending.get(d?.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(d.requestId);
      if (d?.requestStatus?.result) p.resolve(d.responseData || {});
      else p.reject(new Error(d?.requestStatus?.comment || `OBS request failed (code ${d?.requestStatus?.code})`));
      return;
    }

    if (op === OP_EVENT && d?.eventType === 'RecordStateChanged') {
      recording = !!d.eventData?.outputActive;
      // OBS_WEBSOCKET_OUTPUT_PAUSED is reported through outputState, not a
      // separate flag.
      paused = d.eventData?.outputState === 'OBS_WEBSOCKET_OUTPUT_PAUSED';
      if (d.eventData?.outputPath) outputPath = d.eventData.outputPath;
      notify();
    }
  }

  /** Connect + identify. Resolves once OBS accepts us. */
  async function connect(cfg) {
    if (connected) return;
    if (connecting) return;
    const url = (cfg?.url || OBS_DEFAULTS.url).trim();
    connecting = true; lastError = ''; closingOnPurpose = false;
    notify();

    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) { cleanup(err.message || String(err)); reject(err); }
        else resolve();
      };
      identified = { resolve: () => done(null), reject: done, password: cfg?.password || '' };

      try { ws = new WebSocket(url); }
      catch (e) { done(new Error(`could not open ${url}: ${e.message || e}`)); return; }

      // A failed loopback connect looks identical to a blocked one from JS —
      // no status code, just `error`. Say what to check rather than guessing.
      ws.addEventListener('error', () => done(new Error(
        `could not reach OBS at ${url} — is OBS running with Tools → WebSocket Server Settings → Enable enabled?`)));
      ws.addEventListener('close', (e) => {
        if (!settled) {
          done(new Error(e.reason || `OBS closed the connection (code ${e.code})`));
          return;
        }
        // A close that follows a failed connect must not overwrite the real
        // reason ("OBS isn't running") with a generic "disconnected" — the
        // first message is the one that tells the user what to do.
        if (closingOnPurpose) cleanup('');
        else cleanup(connected ? 'OBS disconnected' : (lastError || 'OBS disconnected'));
      });
      ws.addEventListener('message', onMessage);
      setTimeout(() => done(new Error(`timed out connecting to OBS at ${url}`)), 6000);
    });
  }

  function disconnect() {
    closingOnPurpose = true;
    try { ws?.close(); } catch {}
    cleanup('');
  }

  async function refreshScenes() {
    try {
      const r = await request('GetSceneList');
      scenes = (r.scenes || []).map(s => s.sceneName).filter(Boolean);
      notify();
    } catch { /* scene list is a convenience; never block recording on it */ }
    return scenes;
  }

  /** Sync our record flag with OBS's actual state — events only tell us about
   *  CHANGES, so a fresh connection to an already-recording OBS would show
   *  "not recording" until the user stopped it. */
  async function syncRecordState() {
    try {
      const r = await request('GetRecordStatus');
      recording = !!r.outputActive;
      paused = !!r.outputPaused;
      notify();
    } catch {}
    return recording;
  }

  async function getVideoSettings() {
    return request('GetVideoSettings');
  }

  /** True if OBS has ANY output running (record / stream / virtual cam).
   *  `obs_reset_video` refuses to run — or takes the pipeline apart underneath
   *  a live output — while one is active, so this gates the canvas change. A
   *  request that isn't available is treated as "not active" rather than
   *  blocking the whole check. */
  async function outputsActive() {
    const probes = [
      ['GetRecordStatus',     'recording'],
      ['GetStreamStatus',     'streaming'],
      ['GetVirtualCamStatus', 'running the virtual camera'],
    ];
    const active = [];
    for (const [req, label] of probes) {
      try { if ((await request(req)).outputActive) active.push(label); }
      catch {}
    }
    return active;
  }

  /**
   * Set OBS's canvas + output size to this display's pixel size.
   *
   * ⚠️  DANGEROUS, and deliberately never called automatically. SetVideoSettings
   * makes OBS run `obs_reset_video()`, which tears down and rebuilds the entire
   * video pipeline — every source, the compositor, the encoders. Driven from the
   * WebSocket (a pooled request thread rather than the UI thread) this is a
   * known upstream crasher, notably on macOS: obsproject/obs-studio#10946. It
   * took OBS down mid-session here, with the main thread parked in
   * `obs_wait_for_destroy_queue` and the abort on the pooled thread.
   *
   * So: this is a manual, setup-time action behind an explicit button, it
   * refuses while any output is live, and it no-ops when the canvas already
   * matches (which is the common case, and sending it anyway was pure risk for
   * zero gain). The genuinely safe route is still OBS's own Settings → Video.
   *
   * @returns {{applied: boolean, reason?: string, current?: object, target: object}}
   */
  async function matchResolution() {
    const target = displayPixelSize();
    let current = null;
    try { current = await getVideoSettings(); } catch {}
    if (current
        && current.baseWidth === target.width && current.baseHeight === target.height
        && current.outputWidth === target.width && current.outputHeight === target.height) {
      return { applied: false, reason: 'already matches', current, target };
    }
    const active = await outputsActive();
    if (active.length) {
      return { applied: false, reason: `OBS is ${active.join(' + ')} — stop it first`, current, target };
    }
    await request('SetVideoSettings', {
      baseWidth: target.width, baseHeight: target.height,
      outputWidth: target.width, outputHeight: target.height,
    }, { timeoutMs: 15000 });   // a video reset is slow; don't call it a timeout
    return { applied: true, current, target };
  }

  async function setScene(sceneName) {
    if (!sceneName) return;
    await request('SetCurrentProgramScene', { sceneName });
  }

  async function startRecord() { await request('StartRecord'); }
  async function stopRecord()  {
    const r = await request('StopRecord').catch((e) => { throw e; });
    if (r?.outputPath) outputPath = r.outputPath;
    return outputPath;
  }

  return {
    connect, disconnect, request,
    refreshScenes, syncRecordState, setScene,
    getVideoSettings, outputsActive, matchResolution,
    startRecord, stopRecord,
    getState: state,
    isConnected: () => connected,
    isRecording: () => recording,
    getOutputPath: () => outputPath,
  };
}
