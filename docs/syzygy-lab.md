# syzygy — the audio ⇄ video alignment lab (`/lab/syzygy`)

*syzygy (n.): the alignment of celestial bodies.* Re-marry a better audio
recording to a video — the field-recorder take over the camera take — without
touching the video stream when it can possibly be avoided. Everything runs in
the browser; nothing is uploaded anywhere.

Standalone lab app (no BaseLayout, no PWA), following the entangle-page
pattern. It shares nothing with the qualia engine.

## Files

| file | role |
|---|---|
| `src/pages/lab/syzygy.astro` | page shell + all styling (`sz-*` classes, `is:global` because the UI is built dynamically) |
| `src/lib/syzygy/app.js` | UI + orchestration (state, dropzones, timeline viz, render flow) |
| `src/lib/syzygy/plan.js` | **pure** timeline math, strategy ladder, ffmpeg arg builders — node-testable |
| `src/lib/syzygy/meta.js` | byte-level capture-datetime + duration sniffers (mp4 `mvhd`, WAV BWF `bext`, MP3 ID3) — node-testable |
| `src/lib/syzygy/engine.js` | ffmpeg.wasm lifecycle: CDN core load, WORKERFS staging, exec/probe helpers, keyframe scan |
| `scripts/check-syzygy-plan.mjs` | node smoke test for plan.js + meta.js (in `npm run check`) |

## The engine

- `@ffmpeg/ffmpeg` + `@ffmpeg/util` (tiny wrappers) are bundled npm deps, like
  `fix-webm-duration`. The **~31 MB single-thread `@ffmpeg/core` 0.12.10** is
  lazy-loaded from CDN (jsdelivr → unpkg fallback) only when the user hits
  render — the page itself stays instant and the build stays small.
- Single-thread core is deliberate: the MT build needs SharedArrayBuffer →
  COOP/COEP headers, which would constrain every page on the origin. If we
  ever want the ~4× encode speedup, scope those headers to `/lab/syzygy` only
  and load `core-mt` when `crossOriginIsolated` (future work).
- Inputs are mounted via **WORKERFS** (zero-copy reads from the `File`),
  falling back to a MEMFS write. Outputs land in MEMFS — practical ceiling is
  roughly 1.5–2 GB of total working set (wasm32).
- Dev note: `vite.optimizeDeps.exclude` in `astro.config.mjs` keeps the dev
  server from pre-bundling the wrapper (its worker is spawned via
  `new URL('./worker.js', import.meta.url)`, which esbuild would break; the
  production build handles it fine and emits the worker as a hashed asset).
- Test/offline override: `localStorage['syzygy-core-base']` points the core
  loader at any base URL (the E2E test serves it from `/corelocal`).

## Alignment modes

1. **together at 0:00** (default) — both start at the same instant.
2. **universal clock** — offset = audio capture time − video capture time,
   sniffed instantly from the bytes (no engine load): mp4/mov/m4a `mvhd
   creation_time` (UTC per spec), WAV BWF `bext` (`TimeReference` is
   sample-accurate frames-since-midnight; falls back to
   OriginationDate/Time, then `LIST/INFO ICRD`), MP3 ID3v2.4 `TDRC` or
   v2.3 `TYER/TDAT/TIME`. Local-vs-UTC conventions differ per device and
   clocks drift, so the UI shows both timestamps with their sources and a
   ±10 ms/±100 ms/±1 s nudge. At render time the container `creation_time`
   from ffprobe backfills a video clock the sniffers missed.
3. **manual** — type the offset (audio start on the video's timeline,
   negative = audio began first).

## Output window

Default keeps the **longer** side at each end (union): silence is padded
under video-only spans, and a **still frame** fills video under audio-only
overhangs — per side, the adjacent (first/last) frame by default, or a frame
picked from any video time, or an uploaded image (letterboxed to the raster).
`trim start` / `trim end` instead cut each end to the overlap.

## The quality ladder (the point of the whole lab)

`plan.js` picks the cheapest strategy that satisfies the timeline:

| strategy | when | video quality |
|---|---|---|
| **direct** | no pads, no start cut | `-c:v copy` — bit-identical |
| **concat** | pads needed, h264 source, 8-bit pix fmt, unrotated | source stream-copied; only the still pads are encoded (x264 matched to the source's profile/level/pix_fmt/fps/SAR/timescale/color), then concat-demuxer `-c copy`. Output duration is **verified**; any anomaly auto-falls back to reencode |
| **reencode** | exact start cuts, rotated sources with pads, non-h264 sources with pads | x264 crf 17 veryfast (configurable) — slow in wasm but visually faithful; rotation is baked in |

Two tricks keep trims lossless:

- **End trims never re-encode** — `-t` on a stream-copied output cuts at
  packet granularity (a decodable GOP prefix), within a frame or two.
- **Start trims snap to the nearest keyframe** (default "preserve" mode): a
  targeted `ffprobe -read_intervals` packet scan finds the closest keyframe,
  the cut moves there, and the audio placement follows the same shift — sync
  is preserved, the trim point moves by at most a GOP. "exact" mode
  re-encodes for frame accuracy instead.

Containers: mp4 (+`faststart`, hevc tagged `hvc1`) for everything except
vp8/vp9 sources, which stay webm (vp8 can't live in mp4; vp9-in-mp4 breaks
Safari). Audio: aac 320k / vorbis 256k transcode by default (the wasm core's libopus encoder crashes, so webm audio is vorbis); stream-copy when
it's container-native and needs no cutting or leading silence (mp3-in-mp4
copy is offered behind an explicit option). Sub-stream niceties: the output
`creation_time` is restamped to the source's epoch shifted by the window
start, so the result still lines up on an NLE timeline.

## Known limits

- Wasm single-thread re-encode is slow (~1080p at a few fps). The strategy
  ladder exists precisely so the common cases never pay that cost.
- Subtitle/data tracks are dropped (`-map 0:v:0` + the new audio only).
- 10-bit sources can't take the concat path (wasm x264 is 8-bit) — pads on
  a 10-bit source re-encode to 8-bit; direct copy is unaffected.
- bext times are read as local, mvhd as UTC — cross-timezone captures may
  need the nudge.

## Verification

`node scripts/check-syzygy-plan.mjs` (in `npm run check`) covers the
timeline math, strategy ladder, arg builders, and metadata sniffers with
synthetic files. The E2E flow (headless Chromium + a locally served core,
vp8/wav fixtures) exercises direct-copy, keyframe-snap, and reencode paths
end to end — see the session notes in the PR/commit that introduced the lab.
