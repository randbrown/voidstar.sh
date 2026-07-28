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
  // Press each capture source's "Restart Capture" before StartRecord. On by
  // default because the failure it fixes is silent and total — see
  // restartCaptures() below.
  restartCapture:  true,
  restartSettleMs: 700,
  // NOTE: there is deliberately no "match the canvas at record time" setting.
  // See the SetVideoSettings warning on matchResolution() below — that request
  // crashes OBS, so it is a manual setup-time action only.
};

// Button-property ids that mean "restart this capture" on the sources we care
// about. obs-websocket has no request that ENUMERATES a source's properties, so
// pressing one means guessing its id and reading the failure — hence a list,
// tried in order, first success wins. `reactivate_capture` is the macOS SCK
// sources (macOS Screen Capture / macOS Application Audio Capture, the pair
// this whole feature exists for); the rest are the other spellings the same
// idea ships under.
//
// Deliberately NOT here: `activate` (dshow's button is a Deactivate/Activate
// TOGGLE — pressing it on a live device turns the device OFF) and
// `refreshnocache` (a browser-source reload, which would blow away REPL state
// rather than restart a capture).
const RESTART_BUTTON_PROPS = ['reactivate_capture', 'restart_capture', 'reactivate', 'restart'];

// Which inputs are worth restarting. Every OS's capture sources carry `capture`
// or `input` in their kind — screen_capture, sck_audio_capture, monitor_capture,
// window_capture, game_capture, wasapi_*_capture, coreaudio_*_capture,
// pulse_*_capture, dshow_input, av_capture_input, xshm_input, v4l2_input,
// pipewire-*-capture-source. Nothing else matches, which is the point: the
// settings-nudge fallback below re-runs a source's update handler, and that is
// a no-op on a text/image/color source but would restart a media source's
// playback and reload a browser source.
const CAPTURE_KIND_RE = /capture|input/i;

function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch {} }

export function loadObsConfig() {
  let saved = {};
  try { saved = JSON.parse(lsGet(`${NS}.config`, 'null')) || {}; } catch {}
  const cfg = { ...OBS_DEFAULTS, ...saved };
  cfg.url = String(cfg.url || OBS_DEFAULTS.url);
  cfg.password = String(cfg.password || '');
  cfg.scene = String(cfg.scene || '');
  cfg.restartCapture = cfg.restartCapture !== false;
  cfg.restartSettleMs = Math.max(0, Math.min(5000, Number(cfg.restartSettleMs) || 0));
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

/** This window's captured pixel size. `outerWidth/Height` (not inner) because
 *  an OS window capture grabs the whole window frame, title bar included. */
export function windowPixelSize() {
  const dpr = window.devicePixelRatio || 1;
  return {
    width:  Math.max(1, Math.round((window.outerWidth  || window.innerWidth)  * dpr)),
    height: Math.max(1, Math.round((window.outerHeight || window.innerHeight) * dpr)),
  };
}

// Aspect ratios reduce to nonsense on real panel sizes (1728:1117 is
// technically correct and useless), so snap to a recognisable ratio when we're
// within 2% of one and fall back to a decimal otherwise.
const NAMED_ASPECTS = [[16, 9], [16, 10], [4, 3], [3, 2], [21, 9], [1, 1], [9, 16], [9, 19.5]];
export function aspectLabel(w, h) {
  if (!w || !h) return '';
  const r = w / h;
  let best = null, bestErr = Infinity;
  for (const [x, y] of NAMED_ASPECTS) {
    const err = Math.abs(r - x / y) / (x / y);
    if (err < bestErr) { bestErr = err; best = [x, y]; }
  }
  return bestErr <= 0.02 ? `${best[0]}:${best[1]}` : `${r.toFixed(2)}:1`;
}

/**
 * What OBS's "Fit to screen" will do with a source of `src` pixels inside a
 * `canvas`: it scales to fit, preserving aspect, so any aspect mismatch comes
 * back as bars. Returns the bar thickness in canvas pixels per side —
 * `barsX` > 0 is pillarboxing, `barsY` > 0 is letterboxing.
 */
export function fitBars(src, canvas) {
  if (!src?.width || !src?.height || !canvas?.width || !canvas?.height) return null;
  const scale = Math.min(canvas.width / src.width, canvas.height / src.height);
  return {
    scale,
    barsX: Math.round((canvas.width  - src.width  * scale) / 2),
    barsY: Math.round((canvas.height - src.height * scale) / 2),
  };
}

/**
 * Everything needed to explain the wasted space in an OBS preview, computed
 * from the browser side alone (plus OBS's canvas when we're connected).
 *
 * The case this exists for: macOS Screen Capture in **Application** mode hands
 * OBS a DISPLAY-sized frame with only this app's windows drawn into it and
 * black everywhere else. Fit to screen then faithfully fits the black too, so
 * the preview looks broken while every transform is behaving correctly. The
 * fix is upstream of OBS — cover the display (fullscreen) or capture the window
 * instead — and none of that is visible from inside OBS, but all of it is
 * visible from in here.
 */
export function fitReport(canvas) {
  const display = displayPixelSize();
  const win = windowPixelSize();
  const displayRaw = { width: display.rawWidth, height: display.rawHeight };
  // Area coverage, not min(w,h) — a window can be full-width and half-height.
  const coverage = (win.width * win.height) / (displayRaw.width * displayRaw.height);
  const fills = win.width >= displayRaw.width * 0.995 && win.height >= displayRaw.height * 0.995;
  return {
    display: displayRaw,
    window: win,
    canvas: canvas || null,
    coverage: Math.max(0, Math.min(1, coverage)),
    fills,
    // How each capture Method would land in the canvas. "app" covers both
    // Application and Display capture — both produce a display-sized frame.
    appFit:    canvas ? fitBars(displayRaw, canvas) : null,
    windowFit: canvas ? fitBars(win, canvas) : null,
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

  /** Name of the scene OBS is actually programming right now. 5.x answers with
   *  `currentProgramSceneName`; 5.5+ also sends `sceneName`. */
  async function currentScene() {
    const r = await request('GetCurrentProgramScene');
    return r.sceneName || r.currentProgramSceneName || '';
  }

  /**
   * Flatten a scene to the inputs it actually renders, descending through
   * groups and nested scenes (a group is not a scene, so GetSceneItemList
   * refuses it and GetGroupSceneItemList is the one that answers). `seen`
   * dedupes a source used in several places and also breaks a scene cycle.
   */
  async function sceneInputs(sceneName, seen = new Set(), depth = 0) {
    if (!sceneName || depth > 3) return [];
    let items = null;
    for (const req of ['GetSceneItemList', 'GetGroupSceneItemList']) {
      try { items = (await request(req, { sceneName })).sceneItems || []; break; }
      catch { /* try the other shape */ }
    }
    if (!items) return [];
    const out = [];
    for (const it of items) {
      const name = it.sourceName;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (it.isGroup || it.sourceType === 'OBS_SOURCE_TYPE_SCENE') {
        out.push(...await sceneInputs(name, seen, depth + 1));
        continue;
      }
      out.push({ name, kind: it.inputKind || '' });
    }
    return out;
  }

  /** Restart one input's capture. Two tiers, cheapest and most faithful first. */
  async function restartInput(name) {
    for (const propertyName of RESTART_BUTTON_PROPS) {
      try {
        // Exactly what clicking the button in Properties does — obs-websocket
        // builds the source's obs_properties_t and fires the callback.
        await request('PressInputPropertiesButton', { inputName: name, propertyName },
                      { timeoutMs: 10000 });
        return { method: propertyName };
      } catch { /* wrong id for this source kind — try the next */ }
    }
    // No restart button on this kind: re-apply the settings it already has.
    // obs_source_update runs unconditionally, and a capture source's update
    // handler tears its stream down and builds it again — the same restart by
    // another road. `overlay: true` merges, so nothing is reset to a default.
    const s = await request('GetInputSettings', { inputName: name });
    await request('SetInputSettings',
                  { inputName: name, inputSettings: s.inputSettings || {}, overlay: true },
                  { timeoutMs: 10000 });
    return { method: 'settings' };
  }

  /**
   * Press "Restart Capture" on every capture source in a scene, then wait for
   * them to hand over frames again.
   *
   * WHY, and why this one is safe to run at showtime when matchResolution()
   * emphatically isn't: macOS ScreenCaptureKit sources routinely come back from
   * a display sleep, a Space switch, or a permission re-grant *alive but dead* —
   * the source is active, OBS shows no error, and the capture is black and/or
   * silent. The only cure is the source's own Restart Capture button, which had
   * to be pressed by hand on the video source AND the audio source before every
   * take. Unlike SetVideoSettings this touches ONE source at a time and never
   * calls obs_reset_video, so there's no pipeline teardown to race.
   *
   * Fail-soft by construction: every input is independent, a failure is
   * recorded and stepped over, and the caller starts the recording either way.
   * A take with a black first second beats no take.
   *
   * @returns {{scene, results: Array<{name, kind, method?, error?}>, restarted, failed}}
   */
  async function restartCaptures({ scene = '', settleMs = 0 } = {}) {
    const sceneName = scene || await currentScene();
    const inputs = (await sceneInputs(sceneName)).filter(i => CAPTURE_KIND_RE.test(i.kind));
    const results = [];
    // Sequential on purpose: re-arming two SCK streams at once is how you get
    // one of them back black, which is the bug we're here to fix.
    for (const input of inputs) {
      try { results.push({ ...input, ...(await restartInput(input.name)) }); }
      catch (e) { results.push({ ...input, error: e?.message || String(e) }); }
    }
    const restarted = results.filter(r => !r.error).length;
    // A restarted SCK stream needs a beat before it emits its first frame.
    // Starting the recording inside that gap is the black-first-second case.
    if (restarted && settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
    return { scene: sceneName, results, restarted, failed: results.length - restarted };
  }

  async function startRecord() { await request('StartRecord'); }
  async function stopRecord()  {
    const r = await request('StopRecord').catch((e) => { throw e; });
    if (r?.outputPath) outputPath = r.outputPath;
    return outputPath;
  }

  return {
    connect, disconnect, request,
    refreshScenes, syncRecordState, setScene, currentScene,
    getVideoSettings, outputsActive, matchResolution,
    sceneInputs, restartCaptures,
    startRecord, stopRecord,
    getState: state,
    isConnected: () => connected,
    isRecording: () => recording,
    getOutputPath: () => outputPath,
  };
}
