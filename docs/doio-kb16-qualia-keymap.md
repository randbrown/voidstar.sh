# DOIO KB16-01 → qualia performance controller

A [Keychron Launcher](https://launcher.keychron.com/) keymap that turns the
DOIO KB16-01 (16 keys + two small knobs + one big knob) into a dedicated
controller for the qualia lab (`/qualia`).

**Load it:** launcher.keychron.com → connect the pad → **Keymap** → **Import** →
pick [`doio-kb16-qualia-keymap.json`](./doio-kb16-qualia-keymap.json).

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

- **Volume** = the rig signal level (what the app already treats as "volume" /
  MIDI CC7). Knob turns nudge ±0.05 per detent.
- **Left / right small knobs:** the launcher renders these as encoder 0 (left)
  and encoder 1 (right). If your physical units feel reversed, swap `knob[0]`↔
  `knob[1]` and the encoder-push keys (`row 0,col 4` ↔ `row 1,col 4`) in the
  launcher — everything else stays put.
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
