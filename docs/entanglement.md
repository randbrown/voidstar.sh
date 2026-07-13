# Entanglement (audience participation) & pose

Two related systems: **pose tracking** (the performer's body, and each audience phone's body, drive
visuals) and **entanglement** (audience phones become part of the show). Read
[`architecture.md`](architecture.md) §1–§4 for context.

All paths under `src/lib/qualia/` and `workers/`.

---

## Pose tracking

Body drives visuals. The performer's camera (and each phone) feeds MediaPipe `PoseLandmarker`;
landmarks become named joints, then `pose.*` / `crowd.*` modulation channels.

| File | Responsibility |
|---|---|
| `pose.js` | `createPose()` — owns the video element, the `getUserMedia` attempt-ladder, the detect loop, adaptive smoothing, linger, and joint reshaping (`shapePerson`). |
| `pose-worker.js` | Classic worker running `detectForVideo()` off-thread. |
| `pose-features.js` | Shared normalization math + wire pack/unpack (8 floats) + skeleton pack/unpack/orient. Used by **both** the host engine and the participant client, so a participant's "wrist spread" means exactly what the performer's does. |
| `vision-loader.js` | Memoizes a single shared `FilesetResolver` (prevents a known mobile hang when two Tasks-Vision consumers each initialize). |
| `video.js` | The performer's local camera rotation + mirror; `lmToCanvas` maps a normalized landmark to on-screen canvas pixels matching the mirrored/rotated `<video>` preview. |

**Off-main-thread design (important):** `detectForVideo()` is synchronous and blocks its thread for
the whole forward pass (~20–40 ms), which would jank the editor and starve the Strudel cyclist. So
the main thread only does `createImageBitmap(source)` and transfers it to the worker; the worker
runs inference; smoothing/linger/reshaping stay on the (cheap) main thread. One frame in flight at a
time (`workerBusy`) with a 2 s watchdog, graceful fallback to synchronous main-thread inference if
the worker fails, **CPU delegate first** (the GPU is busy with shaders + Hydra), detection throttled
to ~15 fps (raw landmark noise updates faster than smoothing settles).

> **Note:** `video.js` and `pose-features.js` implement the orientation transform twice (performer
> canvas-pixel space vs participant normalized space). `pose-features.js` is the better-factored one
> (single `orientPoint` shared between wire and preview). Don't add a third.

---

## Entanglement — the audience mesh

Turns audience phones into part of the show. The performer opens a "field" (a room); the audience
scans a QR (`/lab/entangle#r=<roomId>`) and joins on their phones. **Each phone runs its own pose
tracking** and ships small derived signals; the host reduces the whole crowd into 8 `crowd.*`
scalars that modulate the active quale, and can draw every participant's skeleton on the projection.

**The headline constraint — THE NO-LAG GUARANTEE:** nothing heavy runs on the performer's machine
for the audience. Phones do the ML; inbound messages only stamp tiny per-peer records and never
touch the render loop.

| File | Responsibility |
|---|---|
| `entangle-protocol.js` | The wire contract (no DOM, no transport): topic constants `T`, `MODES`, room-id helpers, and the two ingress validators `clampToSpec` / `manifestParam`. **The single security gate.** |
| `entangle.js` | `createEntangle({core, mesh, actions})` — headless host manager. Owns the peers Map, manifest, vote tally, phase quorum, and `reduceInto(out, dt)` (the only field write). Knows nothing about the DOM. |
| `entangle-ui.js` | `initEntangleUI(...)` — self-mounting host UI: launcher, QR/moderation modal, crowd HUD, the full-screen skeleton overlay, and the hot-path glue `core.onTick(field => entangle.reduceInto(field.crowd, field.reactDt))`. |
| `entangle-client.js` | `initEntangleClient(root)` — runs on the phone. Renders controls from the host manifest, runs local pose, ships throttled `pose`/`skeleton`/`param`/`vote`/`phase`. Loads none of the viz engine. |
| `entangle-transport-cf.js` | The transport in use (see below). |
| `qr.js` | Lazy `qrcode` CDN wrapper (theme-aware on-screen + dark-on-white for print), plus the artistic voidstar renderer (`renderArtisticQR` — portal-ring finders, star-dust modules, `void*` chip at ECL H). |
| `qr-interject.js` | `initQRInterject(...)` — self-mounting corner QR card. Chron's `qr.every` marks fire it on a schedule (entangle join / site link, resolved at fire time); the chron card has a "show qr now" manual trigger. |
| `workers/entangle-signal/` | The Cloudflare Worker + Durable Object star relay. |

### Transport — WebSocket → Cloudflare Worker + Durable Object

**Not WebRTC.** One DO instance per room; clients connect `wss://…/r/<appId>/<room>?id=&role=`.
Routing is **role-aware hub-and-spoke**: a participant's message fans only to hosts, a host's only
to participants, a `target`ed message goes to one peer — keeping fan-out linear, not N². Uses the
**WebSocket Hibernation API** + SQLite-backed DO so idle rooms cost nothing (free-tier eligible).
The front-end stays pure static assets; all stateful coordination lives in the separately-deployed
Worker. The CF transport resolves immediately, connects in the background with exponential-backoff
reconnect, and buffers sends in an outbox until the socket opens (built for flaky venue wifi).

### Crowd channels

The host reduces every connected participant into `field.crowd` once per react-tick:
`{x, y, energy, spread, rise, sway, count, confidence}` → the `crowd.*` modulation channels (see
`modulation.js`). All-zero when nobody's entangled (identity for any modulator), so a quale that
modulates against `crowd.*` simply sees 0 during a solo set.

### Security model

Host-side ingress is solid: every param passes `clampToSpec` against the manifest, votes are checked
against the registry, pose is a fixed-length float array, **nothing is ever `eval`'d**, and per-peer
throttles + `MAX_PEERS` apply.

**Relay hardening (worker side).** The DO is now defended at the edge — it's on a public
`workers.dev` URL, so anyone who learns the room could otherwise drive or flood it:

- **Origin allowlist** on the WebSocket upgrade (`ALLOWED_ORIGINS`, comma-separated; localhost
  always allowed for dev). WebSockets bypass CORS, so this is the only thing stopping a third-party
  page from opening sockets into a room.
- **Host key (trust-on-first-use per room).** `role=host` is no longer a free claim: the host
  presents a high-entropy per-room key (`getOrCreateHostKey`, persisted on the performer's device,
  **never in the QR/join URL**). The first host to present a key registers it in DO storage; a later
  `host` claim without the matching key is silently **downgraded to participant**. So a phone that
  scans the QR can only ever join as audience and can't hijack the projection.
- **Same-role eviction only** — a reconnect with an existing id can't close a socket of the *other*
  role, so a participant can't knock the host offline by reusing its id.
- **Targeting boundary** — a participant may only `target` a host; a host may target anyone.
- **Per-message size cap** (16 KB) + **per-socket token bucket** (best-effort, in-memory) + **topic
  allowlist** (unknown topics dropped).

Unguessable room IDs still gate discovery (custom slugs are guessable, so the host key is what
actually protects a slug-named room). This remains an intimate-art-piece design, but it's now safe
to run on the public relay.

### Known issues (see `plans/maintenance-backlog.md`)

- **Dead + misleading transport:** `entangle-transport.js` (Nostr/WebRTC) is imported nowhere **and**
  is signature-drifted (it ignores the `role` arg the live code depends on), so the "drop-in
  fallback" claim is false. Delete it or relabel it honestly.
- **No disposal** in `entangle-ui.js` (intervals, resize listener, a perpetual skeleton rAF) or full
  teardown in the client. The pose worker is never terminated on `stopCamera`.
- **Direct audience param control is unsmoothed** — a dragged phone slider applies in steppy
  ~25 Hz jumps on the projection; add a per-param slew.
- `entangle.js` initializes `modes` without a `skeleton` key (works via falsy-undefined, but should
  be explicit).
