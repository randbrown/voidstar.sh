// Playback sync — the A/V wire (stretch layer over sync.js).
//
// One rig can render the COMBINED show: a follower publishes its fx canvas
// (video) and/or its recordable audio mix over a direct WebRTC peer
// connection to the leader, which composites the remote feed(s) over its own
// scene. Signaling (SDP/ICE) rides the existing sync room as targeted relay
// messages (topic 'rtc'); the media itself goes peer-to-peer — on the same
// LAN that's a direct host-candidate path, no TURN, no media through
// Cloudflare.
//
// Direction is deliberately one-way: followers → leader. The leader is the
// house mix / projector machine; followers keep their local monitors.
//
//   FOLLOWER (publisher)                LEADER (receiver)
//   canvas.captureStream(30) ─┐          ontrack → <video> in #qsync-feeds
//   audio.getRecordableStream ┴→ RTCPC →  audio → WebAudio bus (volume) →
//                                          speakers + analyser adopted into
//                                          audio.js as 'remote' (drives
//                                          visuals + lands in recordings)
//
// View modes (leader, compositor-only CSS — zero pixel cost, cam-walk style):
//   off | pip (corner) | split (right half) | full (cut to remote) |
//   blend (fullscreen mix-blend-mode:screen — the Hydra-composite look)
//
// Honest caveats (also in docs/playback-sync.md):
//   • WebRTC audio is NOT cycle-locked — Opus + jitter buffer lands ~40–100ms
//     late. Perfect for single-point recording/streaming; for tight musical
//     layering keep audio local per rig (the core sync design).
//   • The feed carries the follower's fx canvas (not its Hydra layer or DOM
//     overlays), and the leader's viewport recorder does not composite the
//     feed <video> elements — remote AUDIO lands in recordings, video is
//     view-only for now.

const RTC_CONFIG = {
  // Host candidates carry a same-LAN connection by themselves; the STUN entry
  // is a fallback for split-subnet venue wifi. No TURN — if the network needs
  // a media relay, this feature isn't the right tool that night.
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};
const CAPTURE_FPS = 30;
const RETRY_MS = 5000;

export const AV_MODES = ['off', 'pip', 'split', 'full', 'blend'];

const STYLE_ID = 'qsync-av-style';
const CSS = `
#qsync-feeds { position: fixed; inset: 0; z-index: 12; pointer-events: none; display: none; }
#qsync-feeds video { object-fit: cover; background: transparent; }
#qsync-feeds[data-mode="pip"] { display: flex; flex-direction: column; gap: .5rem;
  align-items: flex-end; justify-content: flex-end; inset: auto 1rem 3.2rem auto; }
#qsync-feeds[data-mode="pip"] video { width: min(28vw, 340px); aspect-ratio: 16/9;
  border-radius: .6rem; border: 1px solid var(--border, #2a2745);
  box-shadow: 0 4px 24px rgba(0,0,0,.5); }
#qsync-feeds[data-mode="split"] { display: flex; flex-direction: column;
  left: 50vw; }
#qsync-feeds[data-mode="split"] video { flex: 1; width: 100%; min-height: 0; }
#qsync-feeds[data-mode="full"], #qsync-feeds[data-mode="blend"] { display: flex; }
#qsync-feeds[data-mode="full"] video, #qsync-feeds[data-mode="blend"] video {
  flex: 1; height: 100%; min-width: 0; }
#qsync-feeds[data-mode="blend"] video { mix-blend-mode: screen; }
`;

export function createSyncAV(deps = {}) {
  const noop = () => {};
  const onStatus = typeof deps.onStatus === 'function' ? deps.onStatus : noop;

  let role = 'off';               // 'off' | 'leader' | 'follower'
  let sendVideo = false, sendAudio = false;

  // ── Publisher (follower) state ────────────────────────────────────────────
  let pubPc = null, pubVideoSender = null, pubCanvasStream = null;
  let pubState = 'idle';          // idle | connecting | live | failed
  let unsubCanvas = null, retryTimer = null;

  // ── Receiver (leader) state ───────────────────────────────────────────────
  const feeds = new Map();        // peerId → { pc, videoEl, keepAlive, audioWired }
  let container = null;
  let viewMode = AV_MODES.includes(deps.viewMode) ? deps.viewMode : 'pip';
  let volume = Number.isFinite(+deps.volume) ? Math.max(0, Math.min(1.5, +deps.volume)) : 1;
  let actx = null, busGain = null, busAnalyser = null, audioFeeds = 0;

  function emit() {
    onStatus({
      role, sending: { video: sendVideo, audio: sendAudio, state: pubState },
      feeds: feeds.size, mode: viewMode, volume,
    });
  }

  // ══ Publisher (follower → leader) ═══════════════════════════════════════

  function teardownPublish(nextState = 'idle') {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (unsubCanvas) { try { unsubCanvas(); } catch {} unsubCanvas = null; }
    if (pubCanvasStream) { for (const t of pubCanvasStream.getTracks()) { try { t.stop(); } catch {} } pubCanvasStream = null; }
    if (pubPc) { try { pubPc.close(); } catch {} pubPc = null; }
    pubVideoSender = null;
    pubState = nextState;
    emit();
  }

  function scheduleRepublish() {
    if (retryTimer || role !== 'follower' || (!sendVideo && !sendAudio)) return;
    retryTimer = setTimeout(() => { retryTimer = null; publish(); }, RETRY_MS);
  }

  async function publish() {
    teardownPublish('connecting');
    if (role !== 'follower' || (!sendVideo && !sendAudio)) { pubState = 'idle'; emit(); return; }
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pubPc = pc;

      if (sendVideo) {
        const canvas = deps.getCanvas?.();
        if (canvas?.captureStream) {
          pubCanvasStream = canvas.captureStream(CAPTURE_FPS);
          const track = pubCanvasStream.getVideoTracks()[0];
          if (track) pubVideoSender = pc.addTrack(track, pubCanvasStream);
          // The fx canvas is torn down and rebuilt on every quale switch —
          // swap the outgoing track to the fresh canvas without renegotiating.
          unsubCanvas = deps.onCanvas?.((newCanvas) => {
            if (!pubVideoSender || !newCanvas?.captureStream) return;
            try {
              const old = pubCanvasStream;
              pubCanvasStream = newCanvas.captureStream(CAPTURE_FPS);
              const t = pubCanvasStream.getVideoTracks()[0];
              if (t) pubVideoSender.replaceTrack(t).catch(() => {});
              if (old) for (const ot of old.getTracks()) { try { ot.stop(); } catch {} }
            } catch (e) { console.warn('[sync-av] canvas swap failed:', e); }
          }) || null;
        }
      }

      if (sendAudio) {
        try { await deps.resumeMix?.(); } catch {}
        const mix = deps.getMixStream?.();
        const aTrack = mix?.getAudioTracks?.()[0];
        if (aTrack) pubPc.addTrack(aTrack, mix);
      }

      pc.onicecandidate = (ev) => {
        // Untargeted participant messages fan to hosts only — exactly the
        // leader. No peer-id bookkeeping needed on this side.
        if (ev.candidate) deps.sendRtc?.({ t: 'ice', c: ev.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (pc !== pubPc) return;
        const s = pc.connectionState;
        if (s === 'connected') { pubState = 'live'; emit(); }
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          pubState = 'failed'; emit();
          scheduleRepublish();
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      deps.sendRtc?.({ t: 'offer', sdp: pc.localDescription });
      emit();
    } catch (e) {
      console.warn('[sync-av] publish failed:', e);
      teardownPublish('failed');
      scheduleRepublish();
    }
  }

  // ══ Receiver (leader) ═════════════════════════════════════════════════════

  function ensureContainer() {
    if (container) return container;
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID; st.textContent = CSS;
      document.head.appendChild(st);
    }
    container = document.createElement('div');
    container.id = 'qsync-feeds';
    container.dataset.mode = 'off';
    document.body.appendChild(container);
    return container;
  }

  function ensureAudioBus() {
    if (actx) return;
    actx = new (window.AudioContext || window.webkitAudioContext)();
    busGain = actx.createGain();
    busGain.gain.value = volume;
    busAnalyser = actx.createAnalyser();
    busAnalyser.fftSize = 2048;
    busGain.connect(busAnalyser);
    busGain.connect(actx.destination);
    // Autoplay policy: the ctx may boot suspended until a user gesture — the
    // qualia page is full of gestures, so resume on the next one.
    const resume = () => { actx?.resume?.().catch(() => {}); };
    window.addEventListener('pointerdown', resume, { once: true, passive: true });
    resume();
  }

  function applyMode() {
    if (!container) return;
    container.dataset.mode = feeds.size ? viewMode : 'off';
    container.style.display = (feeds.size && viewMode !== 'off') ? '' : 'none';
  }

  function wireFeedAudio(feed, stream) {
    if (feed.audioWired || !stream.getAudioTracks().length) return;
    feed.audioWired = true;
    ensureAudioBus();
    // Chrome quirk: a remote MediaStream feeds WebAudio reliably only once a
    // media element is also consuming it — keep a muted keep-alive element.
    try {
      feed.keepAlive = new Audio();
      feed.keepAlive.srcObject = stream;
      feed.keepAlive.muted = true;
      feed.keepAlive.play?.().catch(() => {});
    } catch {}
    try {
      feed.srcNode = actx.createMediaStreamSource(stream);
      feed.srcNode.connect(busGain);
      audioFeeds++;
      if (audioFeeds === 1) deps.adoptAnalyser?.(actx, busAnalyser);
    } catch (e) { console.warn('[sync-av] remote audio wire failed:', e); }
  }

  function dropFeed(from) {
    const feed = feeds.get(from);
    if (!feed) return;
    feeds.delete(from);
    try { feed.pc.close(); } catch {}
    try { feed.videoEl?.remove(); } catch {}
    if (feed.keepAlive) { try { feed.keepAlive.srcObject = null; } catch {} }
    if (feed.srcNode) {
      try { feed.srcNode.disconnect(); } catch {}
      audioFeeds = Math.max(0, audioFeeds - 1);
      if (audioFeeds === 0) deps.releaseAdopted?.();
    }
    applyMode();
    emit();
  }

  async function acceptOffer(data, from) {
    dropFeed(from);                       // a re-offer replaces the old feed
    ensureContainer();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const feed = { pc, videoEl: null, keepAlive: null, srcNode: null, audioWired: false };
    feeds.set(from, feed);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) deps.sendRtc?.({ t: 'ice', c: ev.candidate.toJSON() }, from);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') dropFeed(from);
      else emit();
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!stream) return;
      if (ev.track.kind === 'video' && !feed.videoEl) {
        const v = document.createElement('video');
        v.autoplay = true; v.playsInline = true; v.muted = true;   // audio goes via WebAudio
        v.srcObject = stream;
        feed.videoEl = v;
        container.appendChild(v);
        applyMode();
      }
      if (ev.track.kind === 'audio') wireFeedAudio(feed, stream);
      emit();
    };

    try {
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      deps.sendRtc?.({ t: 'answer', sdp: pc.localDescription }, from);
    } catch (e) {
      console.warn('[sync-av] accept offer failed:', e);
      dropFeed(from);
    }
  }

  // ══ Shared surface ════════════════════════════════════════════════════════

  function handleRtc(data, from) {
    if (!data || typeof data.t !== 'string') return;
    try {
      if (role === 'leader') {
        if (data.t === 'offer' && data.sdp) { acceptOffer(data, from); return; }
        if (data.t === 'ice' && data.c) { feeds.get(from)?.pc.addIceCandidate(data.c).catch(() => {}); return; }
      } else if (role === 'follower' && pubPc) {
        if (data.t === 'answer' && data.sdp) { pubPc.setRemoteDescription(data.sdp).catch(() => {}); return; }
        if (data.t === 'ice' && data.c) { pubPc.addIceCandidate(data.c).catch(() => {}); return; }
      }
    } catch (e) { console.warn('[sync-av] rtc handle failed:', e); }
  }

  function stop() {
    teardownPublish('idle');
    for (const from of [...feeds.keys()]) dropFeed(from);
    role = 'off';
    emit();
  }

  return {
    handleRtc,
    stop,
    setRole: (r) => { if (r !== role) { stop(); role = r; emit(); } },
    /** Follower: (re)announce to a (re)appeared leader — republishes if armed. */
    onLeaderSeen: () => { if (role === 'follower' && (sendVideo || sendAudio) && pubState !== 'live') publish(); },
    dropPeer: dropFeed,
    // Follower controls
    setSendVideo: (on) => { sendVideo = !!on; publish(); },
    setSendAudio: (on) => { sendAudio = !!on; publish(); },
    getSendVideo: () => sendVideo,
    getSendAudio: () => sendAudio,
    // Leader controls
    setViewMode: (m) => { if (AV_MODES.includes(m)) { viewMode = m; applyMode(); emit(); } },
    getViewMode: () => viewMode,
    setVolume: (v) => {
      volume = Math.max(0, Math.min(1.5, +v || 0));
      if (busGain) busGain.gain.value = volume;
      emit();
    },
    getVolume: () => volume,
    getStatus: () => ({
      role, sending: { video: sendVideo, audio: sendAudio, state: pubState },
      feeds: feeds.size, mode: viewMode, volume,
    }),
  };
}
