# 3D Asset Spec — Ramblin’ Visioneer

## Purpose

Create a performant, low-poly, self-contained **GLB creature asset** for the `bigfoot3d` three.js quale in `voidstar.sh / qualia lab`.

**Character:** Ramblin’ Visioneer  
**Vibe:** friendly mystical hippie Sasquatch / Bigfoot, Randyland2 energy, long blondish-brownish-greyish-whiteish-silverish hair and beard, glowing blue eyes, kind cosmic power, 80s arcade / Quaternius low-poly spirit.

The creature should read strongly in silhouette because the runtime primarily renders it as a flat void-black figure with Fresnel rim lighting and glowing eye effects.

---

## Hard Format Requirements

Deliver:

```text
creature.glb
```

Requirements:

- glTF 2.0 binary `.glb`.
- Single self-contained file: mesh + skeleton + animations + embedded textures.
- One `.glb` per creature.
- No external `.bin` or texture files.
- No compression extensions:
  - No Draco.
  - No Meshopt.
  - No KTX2 / Basis textures.
- Embedded PNG/JPG textures are fine.
- File size target: **under ~2 MB**.
- Geometry target: **~2k–15k triangles**.
- Low-poly Quaternius-like style is ideal.
- FBX is acceptable only as a fallback, but direct GLB is preferred.

---

## Rig / Skeleton Requirements

Use:

```text
EnemyArmature
```

or a Quaternius/Mixamo-compatible humanoid armature.

Required:

- One skinned mesh bound to a single skeleton / armature.
- Bone name containing `Head`, case-insensitive.
  - This is required because the quale pins glowing blue eyes to the head.
- Bipedal humanoid skeleton.
- Symmetrical limbs.
- Modest bone count.

Preferred bone naming:

```text
EnemyArmature
Body
Head
Arm.L
Arm.R
Leg.L
Leg.R
```

Optional but strongly preferred:

```text
Eye.L
Eye.R
```

These may be empty/locator nodes placed at the eye sockets. If present, the runtime can pin the glowing blue eyes exactly instead of approximating from the Head bone.

---

## Animation Clips

Export each motion as a separate named `AnimationClip` in the GLB `animations` array.

Minimum required clips:

```text
Idle
Walk
Run
Jump
Attack
HitReceive
Death
```

Also acceptable:

```text
Armature|Idle
EnemyArmature|Walk
mixamo.com|Run
```

The loader matches clip names by case-insensitive token, so prefixes are tolerated.

Nice-to-have extra clips:

```text
Wave
Yes
No
Duck
Dance
```

### Looping Rules

These clips must loop seamlessly:

```text
Idle
Walk
Run
```

Requirements:

- Last frame should match first frame closely.
- No foot-pop.
- No visible snap at loop boundary.
- Walk and Run must be **in-place**.
- No root/world translation.
- The creature should walk/run on the spot.
- The quale controls world position; root motion will make the creature drift out of frame.

Preferred animation timing:

- 24–30 fps.
- Walk cycle: ~0.6–1.0 seconds.
- Run cycle: faster and more energetic, but still readable.
- Idle: subtle breathing, hair/beard mass movement, gentle giant presence.
- Attack: expressive blue cosmic energy gesture.
- Death: non-gory dissolve / slump / star-flower release.

---

## Geometry & Material Notes

The `bigfoot3d` quale renders the body mostly as:

- flat void-black silhouette
- Fresnel rim
- glowing blue eyes
- occasional particle / aura effects

So PBR textures are not the polish priority. Still, the model should look good in normal lit viewers.

Critical geometry requirements:

- Clean, consistent, outward-facing normals.
- Smooth shading where appropriate.
- No inverted normals.
- No broken face islands.
- No stray floating geometry.
- No accidental flower/ornament fragments attached to the character mesh.
- No self-intersections that damage the silhouette.
- Clean feet, hands, beard, head, shoulder, and back silhouette.
- Beard/hair may be chunky low-poly forms, but must be attached cleanly.

The runtime’s rim lighting depends on normals. Bad normals will create ugly outline artifacts.

---

## Character Design Requirements

Ramblin’ Visioneer should look like:

- Sasquatch / Bigfoot body.
- Friendly mystical hippie energy.
- Long wild hair and full beard.
- Hair/beard color: blondish, brownish, greyish, whiteish, silverish.
- Glowing electric blue eyes.
- Powerful but kind.
- Not horror-monster.
- Not generic ape.
- Not too cartoony; keep Quaternius creature proportions.
- Slightly hunched bipedal forest-giant posture.
- Broad shoulders.
- Long arms.
- Big hands and feet.
- Expressive head and beard silhouette.

Optional ornamental/style cues for baked color version or preview renders:

- Randyland2 garden magic.
- Stained-glass color accents.
- Flowers.
- Stars.
- Golden angel motif.
- Blue Mahakala mask motif.
- Peace / love / cosmic kindness.

For the actual gameplay mesh, keep ornamentation separate from the clean character mesh unless intentionally modeled as wearable accessories. Avoid loose decorative fragments near frame edges.

---

## Orientation / Transform Conventions

Use:

```text
Up axis: +Y
Facing direction: +Z
Feet: on ground plane at y = 0
Origin: centered on x/z
Scale: approximately 1–3 units tall
```

Before export:

- Apply/freeze transforms.
- Object scale = 1.
- Object rotation = 0.
- Mesh and armature aligned.
- Creature centered.
- Feet on ground.
- Facing +Z toward camera.
- No extreme scale values.

The quale auto-normalizes height, but sane dimensions avoid precision and camera issues.

---

## Deliverables Checklist

Required:

- [ ] `creature.glb`
- [ ] Self-contained binary glTF 2.0.
- [ ] No Draco.
- [ ] No Meshopt.
- [ ] No KTX2/Basis.
- [ ] Under ~2 MB if feasible.
- [ ] ~2k–15k triangles.
- [ ] One skinned mesh bound to one skeleton.
- [ ] `Head` bone present.
- [ ] `Idle`, `Walk`, `Run`, `Jump`, `Attack`, `HitReceive`, `Death` clips.
- [ ] Idle/Walk/Run loop cleanly.
- [ ] Walk/Run are in-place, with no root/world translation.
- [ ] Clean outward normals.
- [ ] Feet at y=0.
- [ ] Facing +Z.
- [ ] License noted.

Preferred:

- [ ] `Eye.L` and `Eye.R` locator nodes.
- [ ] Optional clips: `Wave`, `Yes`, `No`, `Duck`, `Dance`.
- [ ] Turnaround render: front, 3/4 front, side, 3/4 back, back.
- [ ] Short preview video or GIF showing Idle, Walk, Run, Attack.
- [ ] CC0 or similarly permissive license.

---

## Reference Attachments

Include these visual references with the handoff:

```text
01_ramblin_visioneer_concept_sheet.png
02_ramblin_visioneer_technical_animation_reference.png
03_ramblin_visioneer_selected_sheet_user_copy.png
```

Use the concept sheet for mood, silhouette, character identity, color palette, and Ramblin’ Visioneer aesthetic.

Use the technical animation reference for:
- clean frame boundaries
- animation set
- pose readability
- rig expectations
- 48x64-ish pixel reference proportions
- Head bone / Eye glow placement

The final 3D mesh should be cleaner than the decorative concept image. Do not model accidental border flowers, UI frame fragments, labels, text, or ornamental impurities into the character asset.
