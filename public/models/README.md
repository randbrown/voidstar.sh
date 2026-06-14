# Bigfoot 3D model assets

These GLBs are loaded by the **Bigfoot 3D** qualia quale
(`src/lib/qualia/fx/bigfoot3d.js`) and rendered as flat void-black
silhouettes with a Fresnel rim + glowing eyes — surface detail is irrelevant,
only the rigged skeleton + walk cycle matter. Switch between them live with the
quale's `creature` param.

| file              | `creature` | source                                   | clips |
|-------------------|------------|------------------------------------------|-------|
| `yeti.glb`        | `yeti`     | Quaternius (CC0) — a literal Sasquatch   | Walk, Idle, Run, Jump, Wave, Yes, No, Punch, Duck, Death, HitReact, … |
| `giant.glb`       | `giant`    | Quaternius (CC0) — hulking brute         | Walk, Idle, Run, Jump, Attack, Death, HitRecieve |
| `bigfoot-rig.glb` | `robot`    | three.js RobotExpressive (CC0, D. McCurdy) — control | Walking, Idle, Running, Wave, … |

All Quaternius assets are **CC0** (public domain). Clips are matched by
case-insensitive token (`STATE_CLIPS` in `bigfoot3d.js`), so a new model only
needs clips whose names contain `Walk` / `Idle` / etc.

## Swapping / adding a model

Drop a rigged, walk-animated **GLB** here and add it to the `MODELS` map (and
the `model` param options) in `bigfoot3d.js`. Keep it uncompressed (no
Draco/KTX2) so no extra decoder is required.
