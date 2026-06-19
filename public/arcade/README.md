# Arcade sprite assets

Drop PNG car art here to upgrade ACCRETION RUN from its procedural fallback cars.

- `outrun_ferrari.png` — the player car (rear view). Kept red in-game (it's the focus).
- `car2.png` — the NPC/traffic car (rear view). The game hue-rotates it into several
  colours automatically, so one red car2 yields blue/green/amber/purple/lime/pink traffic.

Served at `/arcade/<name>.png` (Astro `public/`). Transparent background, rear 3/4 or
straight-rear view. The game draws them into the low-res cabinet framebuffer (smoothing
on), so very fine detail (plates/faces) softens at distance — that's expected and matches
the chunky-pixel aesthetic. If a file is absent, the game falls back to a clean procedural
car, so the quale always works.
