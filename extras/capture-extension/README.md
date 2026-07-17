# qualia capture — banner-free full-tab recording

A tiny companion Chrome extension for the qualia workstation. It records the
**full tab** (fx + HUD panels + strudel REPL — the whole "how it's made" view)
**without** Chrome's `Sharing this tab` banner.

## Why

Chrome pins a "Sharing this tab to …" banner over the page for every
`getDisplayMedia` tab capture — fullscreen included, in regular tabs and
installed-PWA windows alike. There is no flag, policy, or page API to disable
it. The banner is browser chrome, so it never appears in the recorded file —
but a live audience watching the screen sees it for the whole take.

The `chrome.tabCapture` **extension** API records the same tab pixels with no
banner and no share picker: its only indicator is the small recording badge on
the tab strip, which fullscreen (or an installed-app window) hides. This
extension mints a tabCapture stream ID and hands it to the qualia page, which
records through its normal pipeline — mix-bus audio (mic + strudel + sequencer
+ vocoder), OPFS streaming sink, MP4 duration fix, auto-download at stop. In
the app this shows up as the `full tab · ext` backend.

## Install (once, on the performance machine)

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → pick this folder (`extras/capture-extension`).
3. Optional but recommended: `chrome://extensions/shortcuts` → set/adjust the
   **qualia capture** shortcut (suggested: `⌘⇧9` on macOS, `Ctrl+Shift+9`
   elsewhere). Pin the toolbar icon if you prefer clicking.

No build step, no external dependencies, nothing granted beyond `tabCapture`.

## Use

1. Open the qualia workstation (tab or installed app) and get the stage ready.
2. Press the shortcut (or click the toolbar icon). Recording starts instantly:
   no picker, no banner. The in-app `rec` button lights up with the timer, and
   the tooltip reports `full tab · ext`.
3. Press the shortcut again (or click the in-app `rec` button) to stop. The
   take auto-downloads like any other qualia recording.

Notes:

- The tabCapture API requires a fresh extension invocation per capture (an
  `activeTab`-style grant), so the in-page rec button can only *stop* these
  takes, never start one — the shortcut is the banner-free record button.
- The extension only talks to pages it's content-scripted into
  (`voidstar.sh`, `localhost`, `127.0.0.1`). Pressing it elsewhere logs a
  warning and does nothing.
- If the shortcut does nothing on the qualia page, check that the page was
  reloaded after installing the extension (the content script injects at
  load).

## Future option

Chromium's `--allowlisted-extension-id=<id>` switch lifts the invocation
requirement for a given extension id, which would let the in-app rec button
start banner-free takes directly (page → content script → background →
`getMediaStreamId` with no hotkey). Left out of v1: it requires launching
Chrome with a flag and pinning the unpacked extension's id via a manifest
`key`.
