# Playback sync & the spooky controller

Two stage features sharing one relay room: **playback sync** (lock cycles + CPS across
devices — no audio crosses the wire) and **spooky** (the performer's phone as a wireless
control pad). Read [`architecture.md`](architecture.md) §5 and
[`livecoding.md`](livecoding.md) ("Cycle clock / sync") first — both features hang off the
same Strudel cycle clock the sequencer and looper already phase-lock to.

All paths under `src/lib/qualia/` unless noted.

---

## What these are for

- **Two performers, two rigs, one groove** — each runs qualia with local audio to the
  board; the sync room keeps their Strudel/sequencer/looper grids cycle-locked.
- **Phone sequencer + laptop rig** — the phone runs its own qualia instance as a
  *follower* (audio to the board), the laptop *leads* and renders video. Since the
  sequencer and looper phase-lock to the local Strudel grid, syncing Strudel syncs
  everything.
- **Spooky** — no second rig at all: the phone joins as a *controller* and drives the
  leader's rig remotely (the DOIO action surface + live drum pads).

| File | Responsibility |
|---|---|
| `sync-protocol.js` | Wire contract: topics, room/token/key helpers, action + slider allowlists, the clock math (`projectLeaderPos`, `csyncSample`, `estimateOffset`). **The security gate.** |
| `sync.js` | `createSync(deps)` — headless engine. Leader: beacon + csync pong + controller ingress. Follower: offset estimation + the lock loop. |
| `sync-ui.js` | `initSyncUI(deps)` — self-mounting topbar launcher (`⌁ sync`) + modal (role, room, QRs, status, trim, A/V controls). |
| `sync-av.js` | `createSyncAV(deps)` — the WebRTC A/V feed layer: follower publishes fx canvas + recordable mix; leader composites feeds (pip/split/full/blend) and adopts remote audio as source `'remote'`. |
| `spooky-client.js` + `src/pages/lab/spooky.astro` | The phone controller page. Loads no viz engine. |
| `workers/entangle-signal/` | Same relay as entanglement; the sync topics are in its allowlist. **Redeploy the Worker when topics change.** |

The transport is the existing Cloudflare DO star relay (`entangle-transport-cf.js`) in a
**separate room namespace** (`SYNC_APP_ID = 'voidstar-sync-v1'`), so a performance's sync
room never mixes with its audience room. Roles map onto the relay's existing routing with
zero server-side routing changes: leader = `host` (TOFU leader key), followers and
controllers = `participant`s.

---

## How the clock sync works

The local clock's ground truth (see `strudel-hydra.js`) is `(cps, anchorCycle, anchorSec)`
against the device's own `AudioContext.currentTime` — which is **not portable across
devices**. So:

1. **Beacon** — the leader broadcasts `{cps, pos, tw, playing}` every 1.5 s (and
   immediately on any cps/transport change, hooked into the existing `setcps` wraps in
   `page-init.js`): `pos` is the absolute *audible* cycle float corrected for the
   device's **output latency** (what actually leaves the speakers), `tw` is
   `performance.now()` at sample time.
2. **Offset estimation** — followers ping (`csync`) NTP-style: keep the lowest-RTT half
   of a rolling sample window, take the median offset. Symmetric network latency cancels;
   accuracy lands in the low single-digit ms even through the Cloudflare edge.
3. **Lock loop** (400 ms cadence, follower):
   - project the leader's position into local time (`projectLeaderPos`),
   - compare against the local audible position (also speaker-corrected),
   - **> 120 ms error** → hard jump: `strudel.setCyclePos()` (scheduler `setCycle` when
     the build has it, else a direct anchor rewrite of the h3 cyclist fields) + exact cps,
   - **4–120 ms** → soft PLL: chase with a bounded cps skew (±4 %) — inaudible,
   - **< 4 ms** → locked; settle on the leader's exact cps and hold.
   - Absolute cycle **numbers** match, not just phase — `<a b c d>`-style multi-cycle
     patterns land on the same cycle on every device.
4. The **sequencer and looper need no changes**: they already consume the local Strudel
   grid, so they inherit the lock.

A per-device **trim slider** (±200 ms, persisted) covers what physics won't cancel:
interface buffers the browser can't see, and speaker placement. Trust ears over numbers.

**Leader owns the tempo.** Follower-side tempo edits get overwritten by the next lock
tick — by design (predictable on stage). The follower can also mirror the leader's
play/stop (`follow transport`, default on); it still needs its own pattern in the editor
to make sound.

Join paths: the sync modal pins a room; a second rig opens the **follower link**
(`/qualia?syncroom=<room>` — auto-joins on load), the phone scans the **spooky QR**.

---

## Spooky (remote controller)

"Spooky action at a distance." `/lab/spooky#r=<room>&k=<token>` — the fragment carries
the **control token**, minted per room on the leader, checked on every message. The QR is
for the performer's own phone: **don't project it** (the follower link is the shareable,
listen-only one). Rotate the token by minting a fresh room.

Controller actions dispatch through the **same `padActions` map** as the DOIO keystrokes
and MIDI notes (`page-init.js`) — three input paths, one behavior, no drift. Ingress is
allowlisted (`CTL_ACTIONS`, `CTL_SLIDERS` + clamps in `sync-protocol.js`), rate-limited
per peer, and never eval'd — same posture as entangle ingress.

Tabs: **rig** (freeze stack, drives, strip toggles, rig/delay/reverb sliders — absolute,
like MIDI CC), **loop** (looper transport + grab, vox mute), **seq** (strudel/seq
transport, tempo slider, **live drum pads** — tap to sound a voice; arm *write* to also
quantize the hit into the pattern at the nearest cell, via `sequencer.tapHit`), **quale**
(quale/phase steps, camera, pause, blackout).

Feedback: the leader broadcasts a 1 Hz `cstate` snapshot (transport lit-states, freeze
depth, active quale, pad voices, cps) so the phone reflects reality.

---

## A/V feed (one rig renders the combined show)

The stretch layer (`sync-av.js`): a **follower** can publish its fx canvas
(`canvas.captureStream(30)`, track swapped via `core.onCanvas` on quale switches) and/or
its **recordable audio mix** (`audio.getRecordableStream()` — the same everything-bus the
screen recorder uses) to the leader over a direct **WebRTC** peer connection. Only
SDP/ICE signaling rides the relay (`rtc` topic, targeted); the media goes rig-to-rig —
on one LAN that's a host-candidate direct path (STUN fallback, deliberately no TURN).

Leader-side compositing is **CSS-only** (cam-walk philosophy — zero pixel cost): a
`#qsync-feeds` layer above the fx canvas with modes **off / pip / split / full / blend**
(`blend` = `mix-blend-mode: screen`, the same composite the Hydra layer uses). Remote
audio runs through a WebAudio bus with a volume fader and its analyser is **adopted into
`audio.js` as `'remote'`** — so a follower's audio drives the leader's visuals and lands
in the leader's recordings exactly like every local source.

Use it for **single-point recording / streaming / projection**, not for musical
monitoring: Opus + jitter buffer lands ~40–100 ms late (constant, but late). The cycle
lock above is what keeps performers tight; the wire is for capture.

## Caveats & sharp edges

- **Worker deploy**: the new topics (`clock`, `csync`, `fhello`, `chello`, `cwelc`,
  `ctl`, `cstate`, `sbye`, `rtc`) must be in the deployed Worker's `KNOWN_TOPICS` —
  redeploy `workers/entangle-signal` or every sync message is silently dropped.
- The A/V feed carries the follower's **fx canvas only** (no Hydra layer, no DOM
  overlays), and the leader's viewport recorder doesn't composite the feed `<video>`
  elements — remote *audio* records, feed *video* is view-only. Compositing feeds into
  the recorder canvas is the natural next step.
- No TURN server: if the two rigs can't reach each other directly (cellular hotspots,
  AP client isolation), the feed won't connect — the clock sync still works (it's
  relay-carried). Venue wifi with client isolation is the classic trap.
- The follower's soft-PLL routes through the (possibly wrapped) `scheduler.setCps`, so a
  follower with sequencer-sync armed re-schedules its Tone loop on each micro-correction.
  Harmless in testing but worth knowing; a raw-setCps path is a candidate refinement.
- `setCyclePos` touches cyclist internals (same fields `probeStrudelState` reads). It's
  version-pinned like everything else in `strudel-hydra.js` — re-test after a
  `STRUDEL_VERSION` bump; if the jump path breaks, the engine falls back to slew-only
  (slower initial lock, still correct).
- Controller sliders are **send-only absolute** (the host doesn't yet expose strip-param
  getters) — touching one jumps the host value, exactly like an absolute MIDI CC knob.
- Latency on drum-pad taps is real (relay round trip ~30–100 ms). Tap-to-sound feels
  near-instant; tap-to-*write* quantizes to the nearest cell, which absorbs it for
  ordinary grids. For tight sub-100 ms grids, place hits on the rig instead.
- Clock-offset estimation assumes symmetric network delay; a pathological venue network
  (asymmetric uplink) shows up as a constant skew — that's what the trim slider is for.
