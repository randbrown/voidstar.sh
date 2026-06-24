# DOIO KB16-01 → qualia performance controller

A [Keychron Launcher](https://launcher.keychron.com/) keymap that turns the
DOIO KB16-01 (16 keys + two small knobs + one big knob) into a dedicated
controller for the qualia lab (`/qualia`).

**Load the keys:** launcher.keychron.com → connect the pad → **Keymap** →
**Import** → pick [`doio-kb16-qualia-keymap.json`](./doio-kb16-qualia-keymap.json).

> ⚠️ **Import restores the 16 keys + the knob _presses_ — but NOT the knob
> _rotation_.** Keychron Launcher stores encoder rotation in a separate `knob`
> array that Import doesn't apply, so a freshly imported pad keeps the stock
> mouse-wheel mapping on the knobs — the big knob will scroll horizontally and
> navigate your browser away from the app. Set the three rotations by hand once
> (below) before performing.

**Set the knob rotations (one-time):** in **Keymap**, click a knob on the
virtual pad, then assign its **Rotate Counterclockwise** and **Rotate Clockwise**
targets from the **Basic** tab (the Symbol Keys row has all six):

| Knob | Rotate CCW (left) | Rotate CW (right) |
|---|---|---|
| **Big** — volume | `,` | `.` |
| **Left small** — delay mix | `[` | `]` |
| **Right small** — reverb mix | `-` | `=` |

No special firmware needed — the pad just sends plain keystrokes, and the page
listens for them. Open the in-app legend any time with `?` (or click the hints
strip, bottom-right).

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
- **If a knob turns the "wrong way"** (CCW raises the value instead of lowering
  it), just swap that knob's Rotate CCW / CW targets. If the two small knobs are
  reversed (left does reverb, right does delay), swap both their rotations and
  their presses (`D` ↔ `9`).
- Keys are ignored while a text editor panel (Strudel / sequencer / vocoder /
  looper) has focus, so the pad never fights your typing — click the canvas to
  re-arm.
- A true MIDI controller can instead drive **CC1** delay · **CC2** reverb ·
  **CC7** volume (absolute 0–1, any channel; Chromium browsers only). The DOIO
  on Keychron Launcher sends keystrokes, so it uses the key map above.

## Regenerating

The export carries an `"MD5"` integrity field computed as
`md5(JSON.stringify(keymap))`. If you hand-edit the matrix, recompute it or the
launcher may reject the file.
