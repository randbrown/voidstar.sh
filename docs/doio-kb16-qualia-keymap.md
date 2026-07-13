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

## Three layers

The pad is organized into three layers so every qualia control fits without
crowding one board:

- **Layer 0 — PERFORM:** the live-reflex essentials (freeze, quale/phase moves,
  drives, transport-lite). Self-sufficient for a normal song.
- **Layer 1 — AUDIO:** the detailed audio surface (freeze + full looper transport
  + rig drives).
- **Layer 2 — VIDEO:** the detailed video surface (all fx toggles + cameras +
  pose/walk).

Switch layers with the **top-left / top-right keys** — they send QMK layer jumps
(`TO(1)` = audio, `TO(2)` = video, `TO(0)` = home), which flip the pad *locally*
and send nothing to qualia. Tip: give each layer its own **Backlight** color so
you always know which one you're on.

### Layer 0 — PERFORM
| | col 1 | col 2 | col 3 | col 4 |
|---|---|---|---|---|
| **row 1** | → AUDIO layer | → VIDEO layer | strudel play/stop `⇧S` | zen `Z` |
| **row 2** | tuner `0` | earth drive `1` | metal zone `2` | vox mute/live `⇧W` |
| **row 3** | freeze grab `;` | pop `'` | re-grab `\` | clear `⌫` |
| **row 4** | quale ◀ `⇧V` | quale ▶ `V` | phase ◀ `⇧I` | phase ▶ `I` |

### Layer 1 — AUDIO
| | col 1 | col 2 | col 3 | col 4 |
|---|---|---|---|---|
| **row 1** | → HOME (L0) | → VIDEO layer | strudel play/stop `⇧S` | zen `Z` |
| **row 2** | tuner `0` | earth drive `1` | metal zone `2` | vox mute/live `⇧W` |
| **row 3** | freeze grab `;` | pop `'` | re-grab `\` | clear `⌫` |
| **row 4** | loop play/stop `4` | rec start `5` | rec stop `6` | grab (retro) `7` |

### Layer 2 — VIDEO
| | col 1 | col 2 | col 3 | col 4 |
|---|---|---|---|---|
| **row 1** | → HOME (L0) | → AUDIO layer | pose `P` | cam walk `U` |
| **row 2** | skeleton `J` | sparks `F` | aura `G` | ripples `B` |
| **row 3** | cam size `C` | next camera `8` | mirror `M` | rotate `R` |
| **row 4** | quale ◀ `⇧V` | quale ▶ `V` | phase ◀ `⇧I` | phase ▶ `I` |

### Knobs
**Turns are global** (one map shared by every layer):

| Knob | Turn |
|---|---|
| **Big** | rig master volume (`,` / `.`) |
| **Left small** | delay mix (`[` / `]`) |
| **Right small** | reverb mix (`-` / `=`) |

**Pushes are per-layer:**

| Knob push | L0 PERFORM | L1 AUDIO | L2 VIDEO |
|---|---|---|---|
| **Big** | pause (`Space`) | pause | pause |
| **Left small** | delay on/off (`D`) | delay on/off (`D`) | blackout (`H`) |
| **Right small** | reverb on/off (`9`) | reverb on/off (`9`) | fullscreen (`X`) |

> **Layer-2 knob scrub (quale / phase):** the exported keymap carries a *single
> global* encoder map, so per-layer knob **turns** can't be baked into the import.
> If your Launcher build exposes per-layer encoders, set Layer 2's left knob to
> `⇧V`/`V` (quale ◀▶) and right knob to `⇧I`/`I` (phase ◀▶) in the knob editor.
> Otherwise the turns stay delay-mix / reverb-mix / volume on all three layers —
> still useful, just not the scrub.

## Notes

- **Freeze** is on Layers 0 **and** 1 so the live grab (`;`) is always a tap away,
  while pop / re-grab / clear ride the audio layer. `⌫` clears the whole stack.
- **`⇧S` / `⇧W`** act on the *transport / mute* (strudel play-stop, vox mute) —
  the un-shifted `S` / `W` still open those panels on a full keyboard.
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
- **Screen off (blackout):** `H` (topbar ☾, or the Layer-2 left-knob push) blacks
  the viewport and suspends the visual render to free the GPU — **the audio
  engine, looper, sequencer and the pad keep running**; tap the dark screen or
  press `H` again to wake. Note this is an *in-app* blackout: a web page can't
  power down the panel backlight. For a real backlight-off, sleep the display at
  the OS level (macOS: `Ctrl`+`Shift`+`Power`, or bind `pmset displaysleepnow` via
  Hammerspoon) and keep the Mac awake (`caffeinate -i`, or "prevent sleep when
  display is off"). Heads-up: HID keystrokes wake a sleeping Mac display, so the
  pad's *keys* re-light it — the true-MIDI knobs (CC1/2/7) don't.

## MIDI mode (full control surface)

The default keymap sends keystrokes, which only reach the **focused** window.
For lid-shut / screen-off gigs, reflash the pad to send **MIDI** instead: Note-On
messages reach a backgrounded or occluded tab, and (unlike HID keystrokes) don't
wake a sleeping macOS display. qualia listens on **any channel** (Chromium only).

MIDI mode maps the **PERFORM-layer** action set (`MIDI_NOTE_ACTIONS` in
`page-init.js`); the freeze stack, `⇧S`/`⇧W` transport, and the per-layer video
banks are keystroke-only for now.

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
launcher may reject the file. Keycodes are stored as raw QMK quantum-keycode
integers (basic keys, `LSFT(kc) = 0x200 | kc`, and layer jumps `TO(n) = 0x5200 |
n`); the three-layer file was generated from that mapping.
