# Bigfoot 3D model assets

These GLBs are loaded by the **Bigfoot 3D** qualia quale
(`src/lib/qualia/fx/bigfoot3d.js`) and rendered as flat void-black
silhouettes with a Fresnel rim + glowing eyes — surface detail is irrelevant,
only the rigged skeleton + walk cycle matter. Switch between them live with the
quale's `creature` param.

| file                     | `creature`  | source                                   | status |
|--------------------------|-------------|------------------------------------------|--------|
| `ramblin-visioneer.glb`  | `visioneer` | commissioned — see `docs/ramblin-visioneer/` spec | **pending delivery** |
| `yeti.glb`               | `yeti`      | Quaternius (CC0) — a literal Sasquatch   | ✅ |
| `giant.glb`              | `giant`     | Quaternius (CC0) — hulking brute         | ✅ |
| `bigfoot-rig.glb`        | `robot`     | three.js RobotExpressive (CC0) — control | ✅ |

Until `ramblin-visioneer.glb` is delivered, selecting `visioneer` gracefully
falls back to a placeholder blob (no crash). Drop the delivered GLB here with
that exact filename and it loads automatically.

## Runtime contract (what the loader expects)

- **GLB**, glTF 2.0 binary, self-contained, **no Draco/Meshopt/KTX2**.
- A bone whose name contains **`Head`** (case-insensitive) — gaze + eye fallback.
- **`Eye.L` / `Eye.R`** locator nodes (optional): if present, the glowing eyes
  are pinned to them **exactly**; otherwise they're approximated from the Head
  bone. (Matched by name containing `eye` + an L/R token.)
- Clips matched by **case-insensitive token** (`STATE_CLIPS` in `bigfoot3d.js`):
  `Walk`, `Idle`, `Run`, `Jump`, `Wave`/`Attack`, `Death`, … Prefixes like
  `Armature|Walk` are fine.
- **In-place** locomotion (no root translation); the quale owns world position.
- Any internal unit scale is fine — each model is auto-normalized to a fixed
  world height and recentered (feet at y=0).

The full art/animation brief and reference sheets live in
[`docs/ramblin-visioneer/`](../../docs/ramblin-visioneer/).
