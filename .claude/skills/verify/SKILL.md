---
name: verify
description: Drive the built qualia app headlessly to verify changes at runtime (rig/audio/UI), using Chromium's fake mic so capture paths open without hardware.
---

# Verifying voidstar.sh changes at runtime

## Build + serve

```bash
npm ci && npm run build
npx astro preview --port 4321 &   # serves dist/
```

## Drive the qualia page headlessly (Playwright)

`playwright-core` (install in scratchpad, not the repo) + the pre-installed
Chromium. The fake-media flags make `getUserMedia` succeed with a synthetic
beeping mic — that's what opens the rig capture and builds the strip graph.

```js
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', // adjust rev via ls /opt/pw-browsers
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required'],
});
```

## Flow gotchas

- `#status-overlay` blocks all clicks until dismissed: click `#start-btn`
  ("enable mic") and wait for `#status-overlay.hidden`.
- Rig panel: click `#btn-looper`. The strip graph only exists once capture is
  open — set the signal fader (`#rig-input-controls input[type=range]`,
  set `.value` + dispatch `input`) above 0 first.
- Strip subpanel: `#btn-rig-strip`; utility drawer (hpf/comp/eq/pan):
  `#btn-rig-strip-util`. Stage toggles:
  `.rig-stage[data-stage="<id>"] .rig-stage-toggle`.
- **Audio-flow assertion**: canvases `#rig-scope` (pre-strip input) and
  `#rig-scope-out` (post-strip + rig master output) redraw with the signal.
  Sample `toDataURL()` ~10× over ~3 s and count distinct frames — the fake mic
  has silence gaps, so a 2-frame comparison false-negatives. IN alive + OUT
  dead ⇒ the strip chain is broken; both alive ⇒ audio flows end-to-end.
- Collect `pageerror` events — audio-graph wiring bugs usually surface as
  exceptions during capture open, not as visible UI breakage.
