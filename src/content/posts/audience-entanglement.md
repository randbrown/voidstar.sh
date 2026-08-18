---
title: "the observer field is listening"
description: "Audience participation in qualia: every phone runs its own pose tracking, the crowd becomes 8 signals in the visuals, and it can't drop my framerate."
pubDate: 2026-08-12
tags: ["entanglement", "pose-tracking", "mediapipe", "websockets", "audience-participation"]
---

The best crowd participation I've built doesn't ask the crowd to do anything. They point their phone at themselves, and they're in the show.

That's entanglement — the audience mode in [qualia](/qualia). I open a "field" (really just a room), a QR goes up on the projection, and anyone who scans it lands at `/lab/entangle` on their own phone. No app, no signup. The field is listening.

## the trick: their phone does the work

Here's the thing I was scared of the first time: a room full of people all streaming to my laptop, and my framerate falls off a cliff mid-set. So I built it so that can't happen.

Every audience phone runs its *own* [pose tracking](/lab/pose-particles) locally — MediaPipe, on their device, not mine. The phone watches its owner move and ships a handful of tiny numbers. My laptop just stamps a little per-phone record when a message shows up and moves on. None of it touches the render loop.

The whole crowd collapses into 8 scalars:

```
crowd.x  crowd.y  crowd.energy  crowd.spread
crowd.rise  crowd.sway  crowd.count  crowd.confidence
```

Those wire straight into whatever visualizer is up — the same way my own body drives it. When forty people lean left, `crowd.sway` leans with them. I can also draw every participant's skeleton onto the projection, so the crowd sees itself inside the piece. There are votes and (sandboxed) parameter nudges too, if I feel like handing over a knob.

The headline: a full room can't drop my framerate. The phones do the machine learning; I just read numbers.

## I still have the wheel

Audience input is sandboxed and rate-limited — nobody's getting a raw pointer to my patch. Every crowd channel is overridable, and when nobody's connected they all read zero. So a solo set behaves exactly like a solo set. Entanglement only exists while someone's holding the other end.

## no WebRTC, no server to babysit

Transport is boring on purpose: plain WebSockets to a Cloudflare Worker with a Durable Object I call the "star relay." Not WebRTC — I did not want to negotiate peer connections with a hundred strangers' phones. Idle rooms cost nothing, the front-end stays static assets, and it's hardened where it counts: origin allowlist, size caps, rate limits, and a per-room host key so a phone that just scanned the QR can only ever join as *audience* — never claim to be me.

It's not a stadium gimmick. It's an intimate thing — a shared field in a small room, everyone's motion folded into the same visual. The field is listening.

→ [qualia](/qualia) — the instrument this lives in
→ [qualia overview](/posts/qualia-overview) — start here if you're new
→ [pose particles](/lab/pose-particles) — the pose tracking each phone runs
→ the [tether phone remote](/posts/tether-remote) — same wire, one phone, full control instead of a crowd
