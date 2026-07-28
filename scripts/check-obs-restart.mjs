// Smoke tests for the OBS capture-restart path in src/lib/qualia/obs.js:
//   node scripts/check-obs-restart.mjs
//
// This is protocol code with no pure core to poke at, so the test stands up a
// fake obs-websocket 5.x server (Hello → Identify → Identified, then
// requestType-dispatched RequestResponses) behind a fake global WebSocket and
// drives the real client against it.
//
// Covers: scene flattening through groups and nested scenes, the capture-kind
// filter, the restart-button candidate order, the settings-nudge fallback for
// kinds with no button, per-input failure isolation, and the settle wait.

import { createObsClient, loadObsConfig, OBS_DEFAULTS } from '../src/lib/qualia/obs.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── fake OBS ──────────────────────────────────────────────────────────────
// scenes/groups map a container name to its sceneItems; `buttons` says which
// property ids each input kind answers PressInputPropertiesButton for.
function makeObs({ buttons = {}, fail = {} } = {}) {
  const log = [];   // every requestType the client sent, in order
  const obs = {
    log,
    program: 'Main',
    scenes: {
      Main: [
        { sourceName: 'cap',   inputKind: 'screen_capture',     sourceType: 'OBS_SOURCE_TYPE_INPUT' },
        { sourceName: 'appau', inputKind: 'sck_audio_capture',  sourceType: 'OBS_SOURCE_TYPE_INPUT' },
        { sourceName: 'title', inputKind: 'text_ft2_source',    sourceType: 'OBS_SOURCE_TYPE_INPUT' },
        { sourceName: 'G',     inputKind: '',                   sourceType: 'OBS_SOURCE_TYPE_INPUT', isGroup: true },
        { sourceName: 'Sub',   inputKind: '',                   sourceType: 'OBS_SOURCE_TYPE_SCENE' },
      ],
      Sub: [
        { sourceName: 'mic', inputKind: 'coreaudio_input_capture', sourceType: 'OBS_SOURCE_TYPE_INPUT' },
        { sourceName: 'cap', inputKind: 'screen_capture',          sourceType: 'OBS_SOURCE_TYPE_INPUT' },
        { sourceName: 'Sub', inputKind: '',                        sourceType: 'OBS_SOURCE_TYPE_SCENE' },
      ],
    },
    groups: {
      G: [{ sourceName: 'cam', inputKind: 'av_capture_input', sourceType: 'OBS_SOURCE_TYPE_INPUT' }],
    },
    kindOf(name) {
      for (const items of [...Object.values(obs.scenes), ...Object.values(obs.groups)]) {
        const hit = items.find(i => i.sourceName === name);
        if (hit) return hit.inputKind;
      }
      return '';
    },
    handle(type, d) {
      log.push(type);
      if (fail[type]) throw new Error(fail[type]);
      switch (type) {
        case 'GetCurrentProgramScene':
          return { currentProgramSceneName: obs.program };
        case 'GetSceneItemList':
          if (obs.groups[d.sceneName]) throw new Error(`'${d.sceneName}' is a group`);
          if (!obs.scenes[d.sceneName]) throw new Error('no such scene');
          return { sceneItems: obs.scenes[d.sceneName] };
        case 'GetGroupSceneItemList':
          if (!obs.groups[d.sceneName]) throw new Error('no such group');
          return { sceneItems: obs.groups[d.sceneName] };
        case 'PressInputPropertiesButton': {
          log[log.length - 1] = `press:${d.inputName}:${d.propertyName}`;
          const ok = buttons[obs.kindOf(d.inputName)] || [];
          if (!ok.includes(d.propertyName)) throw new Error('property not found');
          return {};
        }
        case 'GetInputSettings':
          return { inputSettings: { device: `dev-${d.inputName}` } };
        case 'SetInputSettings':
          log[log.length - 1] = `set:${d.inputName}:${JSON.stringify(d.inputSettings)}:${d.overlay}`;
          return {};
        default:
          throw new Error(`unhandled ${type}`);
      }
    },
  };
  return obs;
}

function installFakeWebSocket(obs) {
  class FakeWS {
    static OPEN = 1;
    constructor() {
      this.readyState = FakeWS.OPEN;
      this.ls = {};
      queueMicrotask(() => this.recv({ op: 0, d: { rpcVersion: 1, obsWebSocketVersion: '5.5.0' } }));
    }
    addEventListener(t, fn) { (this.ls[t] ||= []).push(fn); }
    recv(msg) { for (const fn of this.ls.message || []) fn({ data: JSON.stringify(msg) }); }
    close() { this.readyState = 3; }
    send(raw) {
      const { op, d } = JSON.parse(raw);
      if (op === 1) { queueMicrotask(() => this.recv({ op: 2, d: {} })); return; }
      if (op !== 6) return;
      let responseData = null, err = null;
      try { responseData = obs.handle(d.requestType, d.requestData || {}); }
      catch (e) { err = e; }
      queueMicrotask(() => this.recv({
        op: 7,
        d: { requestId: d.requestId, requestType: d.requestType,
             requestStatus: { result: !err, code: err ? 600 : 100, comment: err?.message },
             responseData: responseData || {} },
      }));
    }
  }
  globalThis.WebSocket = FakeWS;
}

async function connected(obs) {
  installFakeWebSocket(obs);
  const client = createObsClient({});
  await client.connect({ url: 'ws://127.0.0.1:4455', password: '' });
  return client;
}

const SCK = { screen_capture: ['reactivate_capture'], sck_audio_capture: ['reactivate_capture'],
              coreaudio_input_capture: ['reactivate_capture'] };

// ── (a) config ────────────────────────────────────────────────────────────
section('(a) config defaults');
{
  check('restart is on by default', OBS_DEFAULTS.restartCapture === true);
  check('settle defaults to a real wait', OBS_DEFAULTS.restartSettleMs > 0);
  const cfg = loadObsConfig();   // no localStorage under node → pure defaults
  check('loadObsConfig keeps restartCapture', cfg.restartCapture === true);
  check('loadObsConfig clamps settle', cfg.restartSettleMs === OBS_DEFAULTS.restartSettleMs);
}

// ── (b) scene flattening ──────────────────────────────────────────────────
section('(b) scene flattening');
{
  const obs = makeObs({ buttons: SCK });
  const client = await connected(obs);
  const inputs = await client.sceneInputs('Main');
  const names = inputs.map(i => i.name);
  check('lists the scene\'s own inputs', names.includes('cap') && names.includes('appau'));
  check('descends into a group', names.includes('cam'), names.join(','));
  check('descends into a nested scene', names.includes('mic'), names.join(','));
  check('group/scene containers are not inputs', !names.includes('G') && !names.includes('Sub'));
  check('a source used twice appears once', names.filter(n => n === 'cap').length === 1);
  check('a self-referencing scene terminates', names.length === 5, names.join(','));
}

// ── (c) which inputs get restarted ────────────────────────────────────────
section('(c) capture-kind filter');
{
  const obs = makeObs({ buttons: SCK });
  const client = await connected(obs);
  const r = await client.restartCaptures({ scene: 'Main' });
  const names = r.results.map(x => x.name);
  check('video capture restarted', names.includes('cap'));
  check('app-audio capture restarted', names.includes('appau'));
  check('camera restarted', names.includes('cam'));
  check('text source left alone', !names.includes('title'), names.join(','));
  check('all four capture sources', r.results.length === 4, names.join(','));
  check('none failed', r.failed === 0, JSON.stringify(r.results));
  check('restarted count matches', r.restarted === 4);
}

// ── (d) how each one is restarted ─────────────────────────────────────────
section('(d) restart method');
{
  const obs = makeObs({ buttons: SCK });
  const client = await connected(obs);
  const r = await client.restartCaptures({ scene: 'Main' });
  const by = Object.fromEntries(r.results.map(x => [x.name, x]));
  check('SCK video uses its button', by.cap?.method === 'reactivate_capture', by.cap?.method);
  check('SCK audio uses its button', by.appau?.method === 'reactivate_capture', by.appau?.method);
  check('buttonless kind falls back to settings', by.cam?.method === 'settings', by.cam?.method);
  const presses = obs.log.filter(l => l.startsWith('press:cap:'));
  check('first candidate tried first', presses[0] === 'press:cap:reactivate_capture', presses.join(' '));
  check('stops at the first success', presses.length === 1, presses.join(' '));
  const camPresses = obs.log.filter(l => l.startsWith('press:cam:'));
  check('exhausts candidates before falling back', camPresses.length === 4, camPresses.join(' '));
  check('nudge re-sends the current settings, merged',
        obs.log.includes('set:cam:{"device":"dev-cam"}:true'),
        obs.log.filter(l => l.startsWith('set:')).join(' '));
  check('never touches SetVideoSettings', !obs.log.includes('SetVideoSettings'));
}

// ── (e) failure isolation ─────────────────────────────────────────────────
section('(e) one bad source does not stop the rest');
{
  const obs = makeObs({ buttons: SCK, fail: { GetInputSettings: 'source gone' } });
  const client = await connected(obs);
  const r = await client.restartCaptures({ scene: 'Main' });
  check('the button sources still restarted', r.restarted === 3, String(r.restarted));
  check('the broken one is reported, not thrown', r.failed === 1 &&
        r.results.find(x => x.name === 'cam')?.error === 'source gone',
        JSON.stringify(r.results.find(x => x.name === 'cam')));
}

// ── (f) scene selection + settle ──────────────────────────────────────────
section('(f) scene selection and settle');
{
  const obs = makeObs({ buttons: SCK });
  obs.program = 'Sub';
  const client = await connected(obs);
  const r = await client.restartCaptures();
  check('falls back to the live program scene', r.scene === 'Sub', r.scene);
  check('only that scene\'s captures', r.results.length === 2, r.results.map(x => x.name).join(','));

  const t0 = Date.now();
  await client.restartCaptures({ scene: 'Sub', settleMs: 120 });
  check('waits out the settle', Date.now() - t0 >= 110, `${Date.now() - t0}ms`);
}
{
  // A scene with nothing to restart must not burn the settle wait — there is
  // no re-armed stream to wait for.
  const obs = makeObs({ buttons: SCK });
  obs.scenes.Empty = [{ sourceName: 'title', inputKind: 'text_ft2_source', sourceType: 'OBS_SOURCE_TYPE_INPUT' }];
  const client = await connected(obs);
  const t0 = Date.now();
  const r = await client.restartCaptures({ scene: 'Empty', settleMs: 400 });
  check('no captures → no wait', Date.now() - t0 < 200, `${Date.now() - t0}ms`);
  check('no captures → empty result', r.results.length === 0);
}

console.log(`\n${failed ? `FAILED ${failed} check(s)` : 'obs capture-restart checks passed'}`);
process.exit(failed ? 1 : 0);
