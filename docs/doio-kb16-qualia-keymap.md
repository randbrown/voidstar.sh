# DOIO KB16-01 → qualia performance controller

A [Keychron Launcher](https://launcher.keychron.com/) keymap that turns the
DOIO KB16-01 (16 keys + two small knobs + one big knob) into a dedicated
controller for the qualia lab (`/qualia`).

**Load it:** launcher.keychron.com → connect the pad → **Keymap** → **Import** →
pick [`doio-kb16-qualia-keymap.json`](./doio-kb16-qualia-keymap.json).

No special firmware needed — the pad just sends plain keystrokes, and the page
listens for them. Open the in-app legend any time with `?` (or click the hints
strip, bottom-right). For lid-shut / screen-off control there's also a **MIDI
mode** (reflash the pad) — see [MIDI mode](#midi-mode-full-control-surface) below.

## Layout

| Keys (left → right) | Action | Sends |
|---|---|---|
| **Row 1** | tuner · earth drive · metal zone · rig panel show/hide | `0` `1` `2` `O` |
| **Row 2** | loop play-stop · rec start · rec stop · grab (retro-loop) | `4` `5` `6` `7` |
| **Row 3** | cam size · next camera · mirror · rotate | `C` `8` `M` `R` |
| **Row 4** | quale prev · quale next · phase prev · phase next | `⇧V` `V` `⇧I` `I` |

| Knob | Turn | Push |
|---|---|---|
| **Big** | volume (`,` / `.`) | pause (`Space`) |
| **Left small** | delay mix (`[` / `]`) | delay on/off (`D`) |
| **Right small** | reverb mix (`-` / `=`) | reverb on/off (`9`) |

## Notes

- **Volume** = the rig master fader — your pedal-steel signal + loops (the
  mixer's "Rig master"); MIDI CC7 drives the same. Turns nudge ±0.05 per detent.
- **Left / right small knobs:** the launcher renders these as encoder 0 (left)
  and encoder 1 (right). If your physical units feel reversed, swap `knob[0]`↔
  `knob[1]` and the encoder-push keys (`row 0,col 4` ↔ `row 1,col 4`) in the
  launcher — everything else stays put.
- Keys are ignored only while a code editor (Strudel / sequencer / vocoder) or a
  text field has focus, so the pad never fights your typing. The rig panel's
  sliders and buttons do **not** disarm the pad — turn the knobs with the rig
  panel open and focused; the on-screen sliders move to match.
- **Two ways to talk to qualia — keystrokes (default) or MIDI.** The DOIO on
  Keychron Launcher sends the keystrokes above. Reflash it to send **MIDI**
  (notes for the buttons, CC for the knobs) and the whole surface keeps working
  when qualia's window is unfocused/occluded — and without waking a sleeping
  display. See [MIDI mode](#midi-mode-full-control-surface) below. Keystrokes and
  MIDI dispatch through the same action map in `page-init.js`, so they always
  behave identically.
- **Screen off (blackout):** `H` (topbar ☾) blacks the viewport and suspends the
  visual render to free the GPU — **the audio engine, looper, sequencer and the
  pad keep running**; tap the dark screen or press `H` again to wake. The 16-key
  pad is fully mapped above, so bind `H` to a freed slot if you want it on the
  pad. Note this is an *in-app* blackout: a web page can't power down the panel
  backlight. For a real backlight-off, sleep the display at the OS level
  (macOS: `Ctrl`+`Shift`+`Power`, or bind `pmset displaysleepnow` via
  Hammerspoon) and keep the Mac awake (`caffeinate -i`, or "prevent sleep when
  display is off"). Heads-up: HID keystrokes wake a sleeping Mac display, so the
  pad's *keys* re-light it — the true-MIDI knobs (CC1/2/7) don't.

## MIDI mode (full control surface)

The default keymap sends keystrokes, which only reach the **focused** window.
For lid-shut / screen-off gigs, reflash the pad to send **MIDI** instead: Note-On
messages reach a backgrounded or occluded tab, and (unlike HID keystrokes) don't
wake a sleeping macOS display. qualia listens on **any channel** (Chromium only).

**Buttons → Note-On** (velocity > 0 = press; qualia ignores note-off / velocity 0):

| Note | Action | Note | Action |
|---|---|---|---|
| 60 | tuner | 68 | cam size |
| 61 | earth drive | 69 | next camera |
| 62 | metal zone | 70 | cam mirror |
| 63 | rig panel show/hide | 71 | cam rotate |
| 64 | loop play / stop | 72 | quale prev |
| 65 | rec start | 73 | quale next |
| 66 | rec stop | 74 | phase prev |
| 67 | grab (retro-loop) | 75 | phase next |
| 76 | pause (brake all audio) | 78 | reverb on/off |
| 77 | delay on/off | 79 | blackout (screen off) |

**Knob turns → Control Change** (absolute, 0–127 → 0–1):

| CC | Controls |
|---|---|
| **CC1** | delay mix |
| **CC2** | reverb mix |
| **CC7** | rig master volume |

Notes 60–75 map the 16-key grid in reading order (row 1 left→right, then row 2…),
76–78 are the three knob-pushes, and 79 is blackout (not on the 16-key pad by
default). The numbers live in `MIDI_NOTE_ACTIONS` in `page-init.js` — change them
there if your firmware sends a different base note. Encoders must send
**absolute** CC (a pot-style 0–127 sweep), not relative increments.

> Full "keep the rig going with the lid shut / screen off" playbook — clamshell,
> `caffeinate`, display-sleep hotkeys — is in
> [`headless-and-screen-off.md`](./headless-and-screen-off.md).

## Regenerating

The export carries an `"MD5"` integrity field computed as
`md5(JSON.stringify(keymap))`. If you hand-edit the matrix, recompute it or the
launcher may reject the file.
