# public/videos — local clips for the Video quale

Committed defaults (wired into `DEFAULT_URLS` in `src/lib/qualia/fx/video.js`):

- `waterfall-portrait.mp4` — 720×1280, H.264, **no audio**, 30 fps, ~7.0 MiB
- `waterfall-cascade.mp4` — 960×720, H.264, **no audio**, 30 fps, ~5.9 MiB

> **Mux decorative clips without an audio track.** A `<video>` that carries an
> audio track engages the browser's shared audio output the moment it plays —
> an audible click on the device, *even when the element is muted*. The Video
> quale plays these as silent visual loops (volume defaults to 0), so an audio
> track only buys you that click. Strip it: `-map 0:v -c:v copy -an` on an
> already-encoded clip, or `-an` in the encode recipes below.

Drop `.mp4` (or `.webm`) files here to serve them as same-origin sources for
the Video quale (`src/lib/qualia/fx/video.js`). Astro copies everything under
`public/` to the site root verbatim, so a file at `public/videos/clip.mp4` is
reachable at `/videos/clip.mp4`.

Same-origin is the whole point: the glitch shader reads each frame into a WebGL
texture, which only works for CORS-clean sources. Local files are same-origin,
so they always get the full FX (no "no-cors" fallback) and persist across
reloads.

## Hard constraint: 25 MiB per file

This site deploys on **Cloudflare Pages**, which **rejects any single asset
larger than 25 MiB** — the deploy fails, it doesn't just skip the file. Git LFS
does not help: Pages still sees a 30 MB file at the checked-out path. So every
clip in here must be re-encoded under 25 MiB before committing.

FHD (1080×1920) source at ~30 MB compresses under the cap easily. The built-in
defaults are 720p; you rarely need full 1080p for a glitch-shader source.

### Compress (single pass, simplest)

```sh
ffmpeg -i input.mp4 \
  -c:v libx264 -crf 26 -preset slow \
  -an \
  -movflags +faststart \
  output.mp4
```

`-an` drops the audio (see the click warning above). If a clip's sound is
genuinely wanted, swap `-an` for `-c:a aac -b:a 128k`.

Bump `-crf` higher (28–30) if a clip is still over 25 MiB. `+faststart` moves
the moov atom to the front so the browser can start playing before the full
file downloads.

### Hard size cap (two-pass, when CRF won't fit)

For a clip of length `D` seconds, target ~22 MiB to leave headroom:
`bitrate ≈ (22 * 8192) / D` kbps, minus ~128 for audio.

```sh
ffmpeg -i input.mp4 -c:v libx264 -b:v <BITRATE>k -preset slow -pass 1 -an -f mp4 /dev/null && \
ffmpeg -i input.mp4 -c:v libx264 -b:v <BITRATE>k -preset slow -pass 2 \
  -c:a aac -b:a 128k -movflags +faststart output.mp4
```

## Wiring as defaults

The first-ever-load playlist seed lives in `DEFAULT_URLS` in
`src/lib/qualia/fx/video.js`. To make a local clip a default, add it there with
a root-relative path (the existing Mixkit URLs stay):

```js
{ src: '/videos/your-clip.mp4', name: 'your clip' },
```

Only entries that exist will load cleanly — a default pointing at a missing
file shows an error badge — so add a line here only once the file is committed.

You don't have to make a clip a default to use it: just paste `/videos/clip.mp4`
into the URL field in the Video quale UI. URL entries persist in localStorage
across reloads (file uploads do not).
