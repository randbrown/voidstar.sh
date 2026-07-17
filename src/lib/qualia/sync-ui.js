// Playback sync — host UI. initSyncUI(deps) builds its own DOM (topbar
// launcher + modal) around the headless engine in sync.js, mirroring the
// entangle-ui pattern: self-mounting, zero page-init DOM edits.
//
// The modal covers both stage roles:
//   LEADER   — pins/mints the sync room, shows the private SPOOKY QR (the
//              phone controller join — carries the control token, so it's for
//              the performer's own phone, never the crowd projection), the
//              follower join link, and live peer counts.
//   FOLLOWER — joins a leader's room, shows offset/RTT/phase-error and the
//              lock state, with a by-ear trim slider and a follow-transport
//              toggle.
//
// Role + room + trim persist across reloads (venue setups survive a refresh),
// and a `?syncroom=` query param auto-joins as follower — that's the link the
// leader hands a second rig.

import { createSync } from './sync.js';
import { AV_MODES } from './sync-av.js';
import {
  makeSyncRoomId, normalizeSyncRoomSlug,
  getPinnedSyncRoom, pinSyncRoom, unpinSyncRoom,
  getOrCreateControlToken, buildControllerUrl, buildFollowerUrl,
  readSyncRoomFromQuery,
} from './sync-protocol.js';

const ROLE_KEY = 'voidstar.sync.role';
const TRIM_KEY = 'voidstar.sync.trimMs';
const FOLLOW_KEY = 'voidstar.sync.followTransport';
const AV_KEY = 'voidstar.sync.av';

const STYLE_ID = 'qsync-style';
const CSS = `
#qsync-launch { position: relative; }
#qsync-dot { display:inline-block; width:.45em; height:.45em; border-radius:50%;
  background:#555; margin-right:.4em; vertical-align:middle; transition:background .2s; }
#qsync-launch.role-leader #qsync-dot { background: var(--cyan,#22d3ee); }
#qsync-launch.role-follower #qsync-dot { background: var(--amber,#fbbf24); }
#qsync-launch.locked #qsync-dot { box-shadow: 0 0 6px currentColor; }
#qsync-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55); z-index:60; display:none; }
#qsync-modal { position:fixed; z-index:61; top:50%; left:50%; transform:translate(-50%,-50%);
  width:min(30rem, calc(100vw - 1.5rem)); max-height:min(88vh, 46rem); overflow:auto;
  background:var(--panel,#0d0b1d); border:1px solid var(--border,#2a2745); border-radius:.8rem;
  padding:1rem 1.1rem 1.2rem; display:none; font-family:var(--font-mono,monospace);
  color:var(--text,#eee); box-shadow:0 8px 40px rgba(0,0,0,.5); }
#qsync-modal h2 { font-size:.95rem; letter-spacing:.1em; margin:0 0 .2rem; }
#qsync-modal .qsync-sub { color:var(--muted,#888); font-size:.72rem; margin-bottom:.8rem; }
#qsync-modal .qsync-x { position:absolute; top:.5rem; right:.6rem; background:none; border:none;
  color:var(--muted,#888); font-size:1.1rem; cursor:pointer; }
.qsync-sect { border:1px solid var(--border,#2a2745); border-radius:.6rem;
  padding:.7rem .8rem; margin-bottom:.8rem; background:rgba(12,10,28,.45); }
.qsync-sect h3 { font-size:.7rem; text-transform:uppercase; letter-spacing:.08em;
  color:#b9b3e6; margin:0 0 .55rem; }
.qsync-roles { display:flex; gap:.45rem; }
.qsync-chip { padding:.45rem .8rem; border-radius:.5rem; cursor:pointer; font:inherit;
  font-size:.8rem; background:#120f24; color:var(--text,#eee); border:1px solid var(--border,#2a2745); }
.qsync-chip.on { border-color:var(--cyan,#22d3ee); color:var(--cyan,#22d3ee); }
.qsync-row { display:flex; gap:.5rem; align-items:center; margin:.4rem 0; flex-wrap:wrap; }
.qsync-row input[type=text] { flex:1; min-width:8rem; padding:.45rem .55rem; font:inherit;
  font-size:.82rem; background:#0c0a18; color:var(--text,#eee);
  border:1px solid var(--border,#2a2745); border-radius:.45rem; }
.qsync-row button, .qsync-btn { padding:.45rem .7rem; font:inherit; font-size:.78rem; cursor:pointer;
  border-radius:.45rem; background:#120f24; color:var(--text,#eee); border:1px solid var(--border,#2a2745); }
.qsync-row button:hover, .qsync-btn:hover { border-color:var(--cyan,#22d3ee); }
.qsync-qr { display:flex; flex-direction:column; align-items:center; gap:.5rem; padding:.4rem 0; }
.qsync-qr canvas { border-radius:.5rem; background:#fff; max-width:100%; }
.qsync-stat { display:grid; grid-template-columns:auto 1fr; gap:.2rem .8rem;
  font-size:.8rem; font-variant-numeric:tabular-nums; }
.qsync-stat .k { color:var(--muted,#888); }
.qsync-lock { font-weight:600; }
.qsync-lock[data-on="1"] { color:var(--cyan,#22d3ee); }
.qsync-lock[data-on="0"] { color:var(--amber,#fbbf24); }
.qsync-note { color:var(--muted,#888); font-size:.72rem; margin-top:.45rem; line-height:1.5; }
.qsync-warn { color:var(--amber,#fbbf24); font-size:.72rem; margin-top:.45rem; }
.qsync-trim { width:100%; accent-color:var(--cyan,#22d3ee); }
label.qsync-check { display:flex; gap:.45rem; align-items:center; font-size:.8rem; cursor:pointer; }
`;

function getNum(key, dflt) {
  try { const v = parseFloat(localStorage.getItem(key)); return Number.isFinite(v) ? v : dflt; } catch { return dflt; }
}

export function initSyncUI(deps) {
  // ── Engine ────────────────────────────────────────────────────────────────
  const avPrefs = (() => {
    try { return JSON.parse(localStorage.getItem(AV_KEY)) || {}; } catch { return {}; }
  })();
  const saveAvPrefs = () => {
    const av = sync.getAV?.();
    if (!av) return;
    try {
      localStorage.setItem(AV_KEY, JSON.stringify({
        mode: av.getViewMode(), volume: av.getVolume(),
        sendVideo: av.getSendVideo(), sendAudio: av.getSendAudio(),
      }));
    } catch {}
  };

  const sync = createSync({
    ...deps,
    av: deps.av ? { ...deps.av, viewMode: avPrefs.mode, volume: avPrefs.volume } : undefined,
    trimMs: getNum(TRIM_KEY, 0),
    followTransport: (() => { try { return localStorage.getItem(FOLLOW_KEY) !== '0'; } catch { return true; } })(),
    onStatus: (s) => reflectStatus(s),
  });
  // Re-arm persisted send toggles (publish itself waits for a follower role +
  // a visible leader — see sync-av onLeaderSeen).
  {
    const av = sync.getAV?.();
    if (av) {
      if (avPrefs.sendVideo) av.setSendVideo(true);
      if (avPrefs.sendAudio) av.setSendAudio(true);
    }
  }

  // ── Style + launcher ─────────────────────────────────────────────────────
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID; st.textContent = CSS;
    document.head.appendChild(st);
  }
  const launch = document.createElement('button');
  launch.id = 'qsync-launch';
  launch.className = 'ctrl-btn';
  launch.title = 'Playback sync — lock cycles/CPS across devices + spooky controller';
  launch.innerHTML = '<span id="qsync-dot"></span>⌁ sync';
  const topbarRight = document.getElementById('topbar-right');
  if (topbarRight) topbarRight.appendChild(launch);
  else { launch.style.cssText = 'position:fixed;top:.6rem;right:7rem;z-index:42'; document.body.appendChild(launch); }

  // ── Modal shell ───────────────────────────────────────────────────────────
  const backdrop = document.createElement('div'); backdrop.id = 'qsync-backdrop';
  const modal = document.createElement('div');    modal.id = 'qsync-modal';
  document.body.append(backdrop, modal);

  let open = false;
  let room = getPinnedSyncRoom() || makeSyncRoomId();
  let lastStatus = sync.getStatus();

  function show(on) {
    open = on;
    backdrop.style.display = on ? 'block' : 'none';
    modal.style.display = on ? 'block' : 'none';
    if (on) render();
  }
  launch.addEventListener('click', () => show(!open));
  backdrop.addEventListener('click', () => show(false));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) show(false); });

  function copy(text, btn) {
    try {
      navigator.clipboard?.writeText(text);
      if (btn) { const t = btn.textContent; btn.textContent = '✓ copied'; setTimeout(() => { btn.textContent = t; }, 1200); }
    } catch {}
  }

  function fmtMs(v) { return (v == null || !Number.isFinite(v)) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} ms`; }

  // Update only the live fields (never rebuild inputs mid-drag).
  function reflectStatus(s) {
    lastStatus = s;
    launch.classList.toggle('role-leader', s.role === 'leader');
    launch.classList.toggle('role-follower', s.role === 'follower');
    launch.classList.toggle('locked', s.role === 'leader' || (s.role === 'follower' && s.locked));
    if (!open) return;
    const q = (sel) => modal.querySelector(sel);
    const set = (sel, txt) => { const el = q(sel); if (el) el.textContent = txt; };
    set('[data-qs-peers]', s.role === 'leader'
      ? `${s.followers} follower${s.followers === 1 ? '' : 's'} · ${s.controllers} controller${s.controllers === 1 ? '' : 's'}`
      : `${s.peers ? 'leader connected' : 'looking for the leader…'}`);
    set('[data-qs-offset]', fmtMs(s.offsetMs));
    set('[data-qs-rtt]', s.rttMs == null ? '—' : `${s.rttMs.toFixed(0)} ms`);
    set('[data-qs-err]', fmtMs(s.errMs));
    const lock = q('[data-qs-lock]');
    if (lock) {
      lock.dataset.on = s.locked ? '1' : '0';
      lock.textContent = s.role !== 'follower' ? '' :
        (s.locked ? '⌁ locked to the leader' : (s.errMs == null ? '… measuring' : '… converging'));
    }
    if (s.av) {
      set('[data-qs-avfeeds]', `· ${s.av.feeds} live`);
      const sendEl = q('[data-qs-avsend]');
      if (sendEl) {
        sendEl.textContent = (!s.av.sending.video && !s.av.sending.audio)
          ? 'off' : s.av.sending.state;
        sendEl.style.color = s.av.sending.state === 'live' ? 'var(--cyan,#22d3ee)' : '';
      }
    }
  }

  function startRole(role) {
    if (role === 'leader') {
      pinSyncRoom(room);
      sync.startLeader(room).catch(err => console.error('[sync] leader start failed:', err));
      try { localStorage.setItem(ROLE_KEY, 'leader'); } catch {}
    } else if (role === 'follower') {
      pinSyncRoom(room);
      sync.startFollower(room).catch(err => console.error('[sync] follower start failed:', err));
      try { localStorage.setItem(ROLE_KEY, 'follower'); } catch {}
    } else {
      sync.stop();
      try { localStorage.removeItem(ROLE_KEY); } catch {}
    }
    if (open) render();
  }

  function render() {
    const role = sync.getRole();
    const chip = (id, label) =>
      `<button class="qsync-chip ${role === id ? 'on' : ''}" data-role="${id}">${label}</button>`;

    modal.innerHTML = `
      <button class="qsync-x" title="close">×</button>
      <h2>⌁ PLAYBACK SYNC</h2>
      <div class="qsync-sub">spooky action at a distance — cycles &amp; CPS locked across devices; audio stays local</div>

      <div class="qsync-sect">
        <h3>Role</h3>
        <div class="qsync-roles">
          ${chip('off', 'off')}${chip('leader', '⚑ leader')}${chip('follower', '⇢ follower')}
        </div>
        <div class="qsync-note">The <b>leader</b> owns the tempo; followers lock their Strudel /
        sequencer / looper grid to it. Each device keeps its own audio output.</div>
      </div>

      <div class="qsync-sect">
        <h3>Room</h3>
        <div class="qsync-row">
          <input type="text" data-qs-room value="${room}" spellcheck="false" autocomplete="off"
                 ${role !== 'off' ? 'disabled' : ''} aria-label="sync room code">
          <button data-act="fresh" ${role !== 'off' ? 'disabled' : ''} title="Mint a fresh random room (rotates the controller token)">↺ fresh</button>
        </div>
        <div class="qsync-note">Both rigs + the controller use the same room code.</div>
      </div>

      ${role === 'leader' ? `
      <div class="qsync-sect">
        <h3>Spooky controller <span style="text-transform:none">(your phone)</span></h3>
        <div class="qsync-qr"><canvas id="qsync-qr" width="300" height="300"></canvas></div>
        <div class="qsync-row">
          <button data-act="copyctl">copy controller link</button>
          <button data-act="copyfollow">copy follower link</button>
        </div>
        <div class="qsync-warn">⚠ this QR carries the control token — scan it yourself, don't project it.
        The follower link is safe to share (listen-only).</div>
      </div>` : ''}

      ${role !== 'off' ? `
      <div class="qsync-sect">
        <h3>Status</h3>
        <div class="qsync-stat">
          <span class="k">peers</span><span data-qs-peers>—</span>
          ${role === 'follower' ? `
          <span class="k">clock offset</span><span data-qs-offset>—</span>
          <span class="k">ping (rtt)</span><span data-qs-rtt>—</span>
          <span class="k">phase error</span><span data-qs-err>—</span>` : ''}
        </div>
        <div class="qsync-lock" data-qs-lock data-on="0"></div>
      </div>` : ''}

      ${role === 'leader' && sync.getAV?.() ? `
      <div class="qsync-sect">
        <h3>Remote feeds <span data-qs-avfeeds style="text-transform:none;color:var(--muted,#888)"></span></h3>
        <div class="qsync-roles" style="flex-wrap:wrap">
          ${AV_MODES.map(m => `<button class="qsync-chip ${sync.getAV().getViewMode() === m ? 'on' : ''}" data-avmode="${m}">${m}</button>`).join('')}
        </div>
        <div class="qsync-row" style="margin-top:.6rem">
          <span style="font-size:.78rem;color:var(--muted,#888)">feed volume</span>
        </div>
        <input type="range" class="qsync-trim" data-qs-avvol min="0" max="1.5" step="0.01" value="${sync.getAV().getVolume()}">
        <div class="qsync-note">A follower rig can send its fx canvas + audio mix here (rig-to-rig
        WebRTC, media never touches the relay). <b>blend</b> = screen-composite, the Hydra look.
        Remote audio drives visuals and lands in recordings; feed video is view-only for now.</div>
      </div>` : ''}

      ${role === 'follower' && sync.getAV?.() ? `
      <div class="qsync-sect">
        <h3>A/V feed → leader <span style="text-transform:none;color:var(--muted,#888)">· <span data-qs-avsend>off</span></span></h3>
        <label class="qsync-check"><input type="checkbox" data-qs-avvideo ${sync.getAV().getSendVideo() ? 'checked' : ''}>
          send video (this rig's fx canvas)</label>
        <label class="qsync-check" style="margin-top:.4rem"><input type="checkbox" data-qs-avaudio ${sync.getAV().getSendAudio() ? 'checked' : ''}>
          send audio (recordable mix)</label>
        <div class="qsync-note">For one-point recording / streaming on the leader. Wire audio lands
        ~40–100 ms late — keep performance audio local per rig; the cycle lock is what keeps you tight.</div>
      </div>` : ''}

      ${role === 'follower' ? `
      <div class="qsync-sect">
        <h3>Follower tuning</h3>
        <label class="qsync-check"><input type="checkbox" data-qs-follow ${sync.getFollowTransport() ? 'checked' : ''}>
          follow the leader's play / stop</label>
        <div class="qsync-row" style="margin-top:.6rem">
          <span style="font-size:.78rem;color:var(--muted,#888)">trim <span data-qs-trimval>${sync.getTrimMs().toFixed(0)} ms</span></span>
        </div>
        <input type="range" class="qsync-trim" data-qs-trim min="-200" max="200" step="1" value="${sync.getTrimMs()}">
        <div class="qsync-note">By-ear fine alignment: positive = this rig plays earlier.
        Room acoustics + interface buffers differ per machine — trust your ears over the number.</div>
      </div>` : ''}
    `;

    modal.querySelector('.qsync-x')?.addEventListener('click', () => show(false));
    modal.querySelectorAll('[data-role]').forEach(b =>
      b.addEventListener('click', () => startRole(b.dataset.role)));
    const roomInput = modal.querySelector('[data-qs-room]');
    roomInput?.addEventListener('change', () => {
      const slug = normalizeSyncRoomSlug(roomInput.value);
      room = slug || makeSyncRoomId();
      roomInput.value = room;
      unpinSyncRoom();
    });
    modal.querySelector('[data-act="fresh"]')?.addEventListener('click', () => {
      room = makeSyncRoomId();
      unpinSyncRoom();
      render();
    });
    modal.querySelector('[data-act="copyctl"]')?.addEventListener('click', (e) =>
      copy(buildControllerUrl(room, getOrCreateControlToken(room)), e.currentTarget));
    modal.querySelector('[data-act="copyfollow"]')?.addEventListener('click', (e) =>
      copy(buildFollowerUrl(room), e.currentTarget));
    modal.querySelector('[data-qs-follow]')?.addEventListener('change', (e) => {
      sync.setFollowTransport(e.currentTarget.checked);
      try { localStorage.setItem(FOLLOW_KEY, e.currentTarget.checked ? '1' : '0'); } catch {}
    });
    modal.querySelectorAll('[data-avmode]').forEach(b =>
      b.addEventListener('click', () => {
        sync.getAV?.()?.setViewMode(b.dataset.avmode);
        saveAvPrefs();
        modal.querySelectorAll('[data-avmode]').forEach(x =>
          x.classList.toggle('on', x.dataset.avmode === b.dataset.avmode));
      }));
    const avVol = modal.querySelector('[data-qs-avvol]');
    avVol?.addEventListener('input', () => {
      sync.getAV?.()?.setVolume(+avVol.value);
      saveAvPrefs();
    });
    modal.querySelector('[data-qs-avvideo]')?.addEventListener('change', (e) => {
      sync.getAV?.()?.setSendVideo(e.currentTarget.checked);
      saveAvPrefs();
    });
    modal.querySelector('[data-qs-avaudio]')?.addEventListener('change', (e) => {
      sync.getAV?.()?.setSendAudio(e.currentTarget.checked);
      saveAvPrefs();
    });
    const trim = modal.querySelector('[data-qs-trim]');
    trim?.addEventListener('input', () => {
      sync.setTrimMs(+trim.value);
      try { localStorage.setItem(TRIM_KEY, String(+trim.value)); } catch {}
      const tv = modal.querySelector('[data-qs-trimval]');
      if (tv) tv.textContent = `${(+trim.value).toFixed(0)} ms`;
    });

    if (role === 'leader') {
      const canvas = modal.querySelector('#qsync-qr');
      if (canvas) {
        const url = buildControllerUrl(room, getOrCreateControlToken(room));
        import('./qr.js')
          .then(m => m.renderArtisticQR(canvas, url, 300).catch(() => m.renderQR(canvas, url, 300)))
          .catch(err => console.warn('[sync] qr', err));
      }
    }
    reflectStatus(lastStatus);
  }

  // ── Auto-start: ?syncroom= (follower hand-off link) or persisted role ─────
  const queryRoom = readSyncRoomFromQuery();
  if (queryRoom) {
    room = normalizeSyncRoomSlug(queryRoom) || room;
    startRole('follower');
  } else {
    let saved = null;
    try { saved = localStorage.getItem(ROLE_KEY); } catch {}
    if ((saved === 'leader' || saved === 'follower') && getPinnedSyncRoom()) {
      startRole(saved);
    }
  }

  return sync;
}
