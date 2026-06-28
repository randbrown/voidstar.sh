# voidstar.sh

A **browser-native audiovisual live-coding instrument** — a single-performer workstation that fuses
live coding (Strudel + Hydra), a pedal-steel/guitar rig with neural amp modeling, a multi-track
looper, a sequencer, vocal processing, realtime audio analysis, pose tracking, audience
participation, and shader/canvas visuals into one realtime instrument: **qualia**.

Built for solo pedal-steel + live-coded ambient performance with audio-reactive visuals. Astro
static site, hosted on Cloudflare Pages.

## Where to start (for agents & contributors)

Read **[`AGENTS.md`](AGENTS.md)** first — it's the map and the non-negotiables. Then the canonical
docs it links:

- **[`docs/architecture.md`](docs/architecture.md)** — tech stack, decisions, realtime budgets.
- **[`src/lib/qualia/README.md`](src/lib/qualia/README.md)** — how to author a visualizer ("fx").
- **[`docs/audio-engine.md`](docs/audio-engine.md)**, **[`docs/looper-and-sequencer.md`](docs/looper-and-sequencer.md)**,
  **[`docs/livecoding.md`](docs/livecoding.md)**, **[`docs/entanglement.md`](docs/entanglement.md)** — the subsystems.
- **[`docs/agent-reference.md`](docs/agent-reference.md)** — the creative/brand/aesthetic canon.

## Develop

```sh
npm install
npm run dev        # http://localhost:4321  — the workstation is at /qualia
npm run build      # static output to ./dist/
npm run preview    # preview the production build
```

The audience-signaling Cloudflare Worker lives in `workers/entangle-signal/` and is deployed
separately (`wrangler deploy -c workers/entangle-signal/wrangler.toml`).

## Qualia Lab recordings: post-processing for multi-camera sync

Recordings produced by the qualia-lab recorder are fragmented MP4 with a SMPTE
`tmcd` timecode track and a wall-clock `creation_time` (see
`src/lib/qualia/mp4-timecode.js`). The video track is **variable frame rate** —
MediaRecorder writes frames on the browser's compositor cadence, so each
"second" has slightly more or fewer than 30/60 frames. NLEs (Resolve,
Premiere, FCP, Reaper) assume constant frame rate and will drift the clip
against a separately-recorded audio/video source over a long take.

When you intend to align a qualia clip against another recording from the
same performance, normalize it to constant frame rate first:

```sh
# 30 fps viewport capture (the default backend). For tab capture, use -r 60.
ffmpeg -i in.mp4 \
       -map 0 -c:d copy -map_metadata 0 \
       -vf fps=30 -c:v libx264 -preset slow -crf 18 \
       -c:a aac -b:a 320k \
       -movflags +faststart \
       out_cfr.mp4
```

What the flags are doing:

- `-map 0 -c:d copy` — keep every input stream, and pass the `tmcd` data
  stream through unchanged so the embedded start timecode survives.
- `-map_metadata 0` — preserve `creation_time` so the clip still says
  "media created" at the wall-clock capture moment.
- `-vf fps=30` (or `60`) — duplicate/drop frames as needed to land on an
  exact constant frame rate. Use whichever rate matches the capture; the
  recorder log line (`[mp4-timecode] track N added · Xfps non-drop · …`)
  tells you which.
- `-c:v libx264 -crf 18` — visually transparent re-encode. Drop to `-crf 20`
  if file size matters.
- `-c:a aac -b:a 320k` — re-encode audio at the same 320 kb/s the recorder
  now writes (matters only if you transcoded the input from WebM/Opus;
  with an MP4 source you can swap this for `-c:a copy`).

Verify the round-trip kept everything intact:

```sh
ffprobe -hide_banner out_cfr.mp4 2>&1 \
  | grep -iE 'timecode|creation_time|fps|tmcd|bitrate'
```

Expect to see `timecode: HH:MM:SS:FF` matching the original wall-clock start,
`creation_time` for today (not 1904), and the video stream reporting a clean
`30 fps` / `60 fps` rather than a fractional VFR figure.
