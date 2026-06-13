# Bigfoot 3D model asset

`bigfoot-rig.glb` is loaded by the **Bigfoot 3D** qualia quale
(`src/lib/qualia/fx/bigfoot3d.js`) and rendered as a flat void-black
silhouette with a Fresnel rim + glowing eyes, so its surface detail is
irrelevant — only the rigged skeleton + walk cycle matter.

## Current placeholder

The committed `bigfoot-rig.glb` is **RobotExpressive** from the three.js
examples (by Tomás Laulhé; CC0 modifications by Don McCurdy). It is a
chunky rigged biped with `Idle`, `Walking`, `Wave`, `Standing`, etc. clips
— a stand-in to validate the real-time pipeline.

## Swapping in a real Sasquatch

Drop a different rigged, walk-animated **glTF/GLB** in here named
`bigfoot-rig.glb` (or change `MODEL_URL` in `bigfoot3d.js`), then update the
`STATE_CLIPS` map in that file to match the new model's animation clip names.

Recommended free sources:
- **Quaternius "Ultimate Monsters Pack"** — CC0, glTF, Walk/Idle/Run.
  https://quaternius.com/packs/ultimatemonsters.html
- **Mixamo** — auto-rig any ape/humanoid mesh + a free "Walking (In Place)"
  clip, export FBX, convert to GLB (Blender / gltf-transform). Embed-only
  license; review Adobe's terms. https://www.mixamo.com

Keep it uncompressed (no Draco/KTX2) so no extra decoder is needed; a
low-poly rigged GLB with one walk clip is ~0.1–0.5 MB.
