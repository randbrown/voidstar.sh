# Keeping the rig going with the lid shut or the screen off

You've dialed in the rig and you're **not projecting** — you just want qualia's
audio (rig · looper · sequencer · Strudel · vox) to keep running while you close
the MacBook lid or turn the display off, and to keep steering it from the DOIO.
This is the playbook. Short version: **it works, because qualia's sound is on the
Web Audio clock, not the animation loop** — but macOS lid-sleep and the DOIO's
keystroke-vs-MIDI wiring are the two things to get right.

---

## What actually survives a dark screen

qualia generates sound from Web Audio nodes / **AudioWorklets** (rig, looper,
neural amp), **Tone.js** `Transport` (sequencer), the Strudel cyclist, and the
vocoder's own `AudioContext` — all on the audio clock, which the browser does
**not** throttle in the background. The `requestAnimationFrame` loop in `core.js`
only drives the **visuals + audio-reactivity analysis**. So when the screen goes
dark or the tab is hidden, **the visuals freeze and the audio keeps playing.**
qualia does not pause or suspend audio on `visibilitychange`/blur.

| Situation | System | Audio | Visuals | DOIO **keys** | DOIO **MIDI** |
|---|---|---|---|---|---|
| Foreground, display on | awake | ✅ | ✅ | ✅ | ✅ |
| **Display off, Mac kept awake**, qualia focused | awake | ✅ | ✅¹ | ✅ | ✅ |
| Switched to another app / tab | awake | ✅ | ❌ frozen | ❌ | ✅ |
| Lid shut, **clamshell** (ext display + power) | awake | ✅ | ✅ | ✅ | ✅ |
| Lid shut, no ext display (keep-awake app) | awake | ✅ | ❌ frozen | ⚠️² | ✅ |
| Lid shut, **default** (no keep-awake) | **sleeps** | ❌ | ❌ | ❌ | ❌ |

¹ Turning the display off does **not** hide the page (no `visibilitychange`), so
rAF keeps running — the page is fully live behind a black panel.
² The window is usually still the focused app, so keystrokes *often* still land,
but it's flaky; MIDI is the reliable path here.

**Takeaway:** the cleanest setup for "keep the rig going, screen dark" is to
**turn the display off and keep the Mac awake** — not to physically close the
lid. Close the lid only if you truly need to (clamshell), and lean on MIDI for
control when the window may be occluded.

---

## Recipe A — display off, Mac awake (recommended)

The page stays live; you just kill the backlight.

1. **Keep qualia focused.** Use the installed app (Chrome → **Install app**) so
   it's its own window and can't get buried behind other tabs.
2. **Prevent system sleep:**
   - On AC power, enable **Settings → Battery → Options → "Prevent automatic
     sleeping on power adapter when the display is off."** (Intel: *Energy
     Saver*.) — or —
   - Run in a Terminal: `caffeinate -i` (prevents idle **system** sleep while
     still allowing the **display** to sleep). Leave it running; `Ctrl-C` to
     stop. On AC you can use `caffeinate -s` instead.
3. **Turn the display off** without sleeping the Mac:
   - `Ctrl`+`Shift`+`Power` (or `Ctrl`+`Shift`+`Eject` on Macs with an eject
     key), or set a hot corner to *Put Display to Sleep*, or bind
     `pmset displaysleepnow` (see [Hammerspoon](#bonus-bind-display-sleep-to-a-key)).
4. Optionally hit **`H`** (the in-app **blackout** / ☾) first — blacks qualia and
   stops the GPU rendering the visuals while audio keeps playing. See
   [In-app blackout](#in-app-blackout-h) below.

Audio, and full DOIO **keystroke** control, keep working with the panel dark.
⚠️ HID keystrokes **wake** a sleeping display, so poking the pad's *keys*
re-lights it. The MIDI knobs (CC1/2/7) don't — see [DOIO control](#doio-control-with-the-screen-dark).

---

## Recipe B — lid physically shut (clamshell)

macOS sleeps on lid-close **by default**. To keep running with the lid down:

- **Clamshell mode (supported):** connect **power + an external display**. qualia
  stays fully visible on the external screen (audio *and* visuals *and* keystroke
  control all live). No monitor handy? A **headless HDMI dummy plug** (~$8) or a
  software virtual display (**[BetterDisplay](https://github.com/waydabber/BetterDisplay)**,
  free) makes macOS think a monitor is attached and enters clamshell. **OBS
  cannot do this** — it's a capture app, not a virtual monitor.
- **Keep-awake app (hack):** **[Amphetamine](https://apps.apple.com/app/amphetamine/id937984704)**
  (free) has a closed-display mode that keeps the Mac awake lid-shut without an
  external display. Plain `caffeinate`/`pmset` alone do **not** override
  lid-close sleep.

With the lid shut and no real screen, qualia's window is treated as occluded —
**visuals freeze, audio keeps playing**, and keystroke control gets unreliable.
Use **MIDI** for control in this mode.

Route audio to an **external interface / speakers** for any lid-shut setup —
internal speakers/mic may drop when the lid is closed.

---

## DOIO control with the screen dark

The DOIO's default Keychron-Launcher keymap sends **plain keystrokes**, which the
browser only delivers to the **focused** window. That's fine for Recipe A (the
window stays focused), but breaks the moment qualia is backgrounded/occluded — and
every keystroke **wakes** a sleeping display.

**Reflash the pad to send MIDI** and none of that applies: MIDI Note-On reaches a
backgrounded/occluded tab, and doesn't wake the display. qualia maps the full
surface (16 buttons + 3 knobs) over MIDI — note/CC numbers and the reflash notes
are in [`doio-kb16-qualia-keymap.md` → MIDI mode](./doio-kb16-qualia-keymap.md#midi-mode-full-control-surface).
Keystrokes and MIDI run through the same action map in `page-init.js`, so both
behave identically.

| | Keystrokes (default) | MIDI (reflashed) |
|---|---|---|
| Reaches unfocused/occluded window | ❌ | ✅ |
| Wakes a sleeping display | ✅ (annoying) | ❌ |
| Setup | import the keymap JSON | reflash pad + configure MIDI |

---

## In-app blackout (`H`)

`H` (or the topbar **☾**, or a mapped pad key/note) toggles **blackout**: it
blacks the viewport and suspends the fx render — freeing the GPU — while the
**audio engine and controller keep running**. Tap the dark screen or press `H`
again to wake. It's transient (a reload never comes back black).

Blackout is *not* a real backlight-off — a web page can't power down the panel.
Pair it with an OS display-sleep (Recipe A) for a truly dark, low-power screen.

---

## Bonus: bind display-sleep to a key

A web page can't sleep the display, but Hammerspoon can — and its hotkeys are
global (they work regardless of which window is focused, and can be triggered by
a DOIO key or your MacBook keyboard):

```lua
-- ~/.hammerspoon/init.lua
hs.hotkey.bind({"ctrl", "alt", "cmd"}, "0", function()
  hs.execute("pmset displaysleepnow")   -- no sudo needed
end)
```

Pair it with `caffeinate -i` (or the Battery setting) so the *system* stays awake
after the display drops. Reminder: a keystroke from the pad will wake the display
back up — trigger display-sleep from a key you won't fat-finger, and steer with
the **MIDI knobs** once it's dark.

---

## Quick checklist

- [ ] qualia installed as an app (Chrome → Install app), kept focused
- [ ] Audio routed to an external interface / speakers
- [ ] Mac kept awake: Battery "prevent sleep when display off" **or** `caffeinate -i`
- [ ] Display off via `Ctrl`+`Shift`+`Power` / `pmset displaysleepnow` (not lid-close)
- [ ] `H` blackout for a dark canvas without touching the OS
- [ ] Pad on **MIDI** if the window won't stay focused / you want no display-wake
- [ ] Lid-shut only in **clamshell** (ext display / dummy plug / BetterDisplay)

See also: [`architecture.md`](./architecture.md) §4–5 (why audio is decoupled from
the render loop) and §8 (control surface).
