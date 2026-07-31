// Smoke tests for the OBS address diagnosis in src/lib/qualia/obs.js:
//   node scripts/check-obs-url.mjs
//
// The bug these lock down: OBS running correctly, WebSocket server on, auth
// off — and `ws://192.168.x.x:4444` from https://voidstar.sh never connects,
// because the page's `upgrade-insecure-requests` CSP rewrites the scheme to
// wss:// (which OBS can't answer) and mixed content would block the plaintext
// address anyway. Both rules are browser-side and neither is fixable from the
// app, so the address has to be judged BEFORE a socket is opened.
//
// Observed on Chromium 141 with the site's CSP header:
//   new WebSocket('ws://<lan-ip>:4444').url === 'wss://<lan-ip>:4444/'
// and without it, the ws:// survives (and is then mixed-content blocked).
//
// Covers: the loopback host test, every problem code, blocking vs advisory,
// port preservation in the offered fix, and the secure-context dependence
// (a phone hitting the http:// dev server is NOT in a secure context, so a
// LAN address is legal there and must not be flagged).

import { isLoopbackHost, obsUrlProblem, loopbackObsUrl, OBS_DEFAULTS } from '../src/lib/qualia/obs.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

// ── (a) loopback host test ────────────────────────────────────────────────
section('(a) loopback hosts');
for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', 'obs.localhost', '[::1]']) {
  check(`${h} is loopback`, isLoopbackHost(h) === true);
}
for (const h of ['192.168.68.58', '10.0.0.5', '172.16.0.9', 'obs.local', 'example.com',
                 '127.0.0.1.example.com', '', null]) {
  check(`${h} is not loopback`, isLoopbackHost(h) === false);
}

// ── (b) the reported failure ──────────────────────────────────────────────
section('(b) ws:// to a LAN host from an https page');
{
  const p = obsUrlProblem('ws://192.168.68.58:4444', { secure: true });
  check('flagged', !!p, 'no problem reported');
  check('code', p?.code === 'insecure-host', p?.code);
  check('blocking', p?.blocking === true);
  check('names the host', /192\.168\.68\.58/.test(p?.message || ''), p?.message);
  check('explains the upgrade + mixed content',
        /wss:\/\//.test(p?.detail || '') && /mixed content/i.test(p?.detail || ''), p?.detail);
  check('fix keeps the port', p?.fix?.url === 'ws://127.0.0.1:4444', p?.fix?.url);
  check('fix is labelled', p?.fix?.label === 'use 127.0.0.1', p?.fix?.label);
}
{
  // No port typed → fall back to OBS's default rather than inventing one.
  const p = obsUrlProblem('ws://192.168.68.58', { secure: true });
  check('portless fix uses the OBS default', p?.fix?.url === OBS_DEFAULTS.url, p?.fix?.url);
}

// ── (c) addresses that are fine ───────────────────────────────────────────
section('(c) addresses that must NOT be flagged');
for (const url of ['ws://127.0.0.1:4455', 'ws://127.0.0.1:4444', 'ws://localhost:4455',
                   'ws://[::1]:4455', OBS_DEFAULTS.url]) {
  check(`${url} passes`, obsUrlProblem(url, { secure: true }) === null,
        JSON.stringify(obsUrlProblem(url, { secure: true })));
}
{
  // The phone-on-the-dev-server case: an http:// origin is not a secure
  // context, so neither rule applies and a LAN address is genuinely usable.
  const p = obsUrlProblem('ws://192.168.68.58:4444', { secure: false });
  check('LAN address is legal from a non-secure context', p === null, JSON.stringify(p));
}

// ── (d) the other ways to type it wrong ───────────────────────────────────
section('(d) malformed addresses');
{
  const p = obsUrlProblem('', { secure: true });
  check('empty → empty', p?.code === 'empty', p?.code);
  check('empty offers the default', p?.fix?.url === OBS_DEFAULTS.url, p?.fix?.url);
}
{
  // `new WebSocket('localhost:4455')` throws SyntaxError, so a scheme-less
  // address is broken even when the host itself is fine.
  const p = obsUrlProblem('localhost:4455', { secure: true });
  check('scheme-less → no-scheme', p?.code === 'no-scheme', p?.code);
  check('scheme-less is blocking', p?.blocking === true);
  check('scheme-less fix adds ws:// and keeps the host',
        p?.fix?.url === 'ws://localhost:4455', p?.fix?.url);
}
{
  // Scheme-less AND on the LAN: both faults, one fix.
  const p = obsUrlProblem('192.168.68.58:4444', { secure: true });
  check('scheme-less LAN → loopback fix', p?.fix?.url === 'ws://127.0.0.1:4444', p?.fix?.url);
}
{
  const p = obsUrlProblem('http://127.0.0.1:4455', { secure: true });
  check('http:// → bad-scheme', p?.code === 'bad-scheme', p?.code);
  check('http:// fix keeps host + port', p?.fix?.url === 'ws://127.0.0.1:4455', p?.fix?.url);
}
{
  const p = obsUrlProblem('ws://', { secure: true });
  check('hostless → bad-url', p?.code === 'bad-url', p?.code);
}

// ── (e) wss:// is a warning, not a refusal ────────────────────────────────
section('(e) wss:// is advisory');
{
  // OBS serves no TLS, so wss:// is almost always a mistake — but someone with
  // a reverse proxy is right, and the app must not veto their setup.
  const p = obsUrlProblem('wss://127.0.0.1:4455', { secure: true });
  check('flagged', p?.code === 'tls', p?.code);
  check('NOT blocking', p?.blocking === false, String(p?.blocking));
  check('offers the plaintext form', p?.fix?.url === 'ws://127.0.0.1:4455', p?.fix?.url);
}

// ── (f) loopbackObsUrl ────────────────────────────────────────────────────
section('(f) loopbackObsUrl');
check('keeps a port', loopbackObsUrl('ws://192.168.68.58:4444') === 'ws://127.0.0.1:4444');
check('keeps a port without a scheme', loopbackObsUrl('192.168.68.58:4444') === 'ws://127.0.0.1:4444');
check('defaults a missing port', loopbackObsUrl('ws://192.168.68.58') === OBS_DEFAULTS.url,
      loopbackObsUrl('ws://192.168.68.58'));
check('survives garbage', loopbackObsUrl('???') === OBS_DEFAULTS.url, loopbackObsUrl('???'));

// ── (g) connect() refuses a blocking address ──────────────────────────────
section('(g) connect() refuses before opening a socket');
{
  const { createObsClient } = await import('../src/lib/qualia/obs.js');
  let opened = 0;
  globalThis.WebSocket = class { constructor() { opened++; } close() {} addEventListener() {} };
  globalThis.window = { isSecureContext: true };
  const states = [];
  const client = createObsClient({ onState: (s) => states.push(s) });
  let err = null;
  try { await client.connect({ url: 'ws://192.168.68.58:4444' }); }
  catch (e) { err = e; }
  check('rejects', !!err, 'resolved');
  check('no socket was opened', opened === 0, `${opened} opened`);
  check('carries the problem for the caller', err?.obsProblem?.code === 'insecure-host',
        err?.obsProblem?.code);
  check('offers the fix', err?.obsProblem?.fix?.url === 'ws://127.0.0.1:4444');
  check('error reaches the UI state', states.at(-1)?.error === err?.message, states.at(-1)?.error);
  check('not left mid-connect', states.at(-1)?.connecting === false);
  delete globalThis.window;
}

// ── (h) a scheme rewritten behind our back is caught at the socket ─────────
section('(h) runtime upgrade detection');
{
  const { createObsClient } = await import('../src/lib/qualia/obs.js');
  // Exactly what Chromium does under upgrade-insecure-requests: the socket is
  // constructed, but `url` comes back with the scheme swapped. The precheck
  // can't see a future policy change; this can.
  globalThis.WebSocket = class {
    constructor(u) { this.url = String(u).replace(/^ws:/, 'wss:') + '/'; }
    close() {} addEventListener() {}
  };
  globalThis.window = { isSecureContext: false };   // precheck deliberately passes
  const client = createObsClient({});
  let err = null;
  try { await client.connect({ url: 'ws://192.168.68.58:4444' }); }
  catch (e) { err = e; }
  check('rejects', !!err, 'resolved');
  check('reports the upgrade', /upgraded/.test(err?.message || ''), err?.message);
  check('names both schemes',
        /ws:\/\/192\.168\.68\.58:4444/.test(err?.message || '')
        && /wss:\/\/192\.168\.68\.58:4444/.test(err?.message || ''), err?.message);
  delete globalThis.window;
}

console.log(`\n${failed ? `FAILED ${failed} check(s)` : 'obs address checks passed'}`);
process.exit(failed ? 1 : 0);
