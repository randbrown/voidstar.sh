---
title: "qualia: a whole rig in one browser tab"
description: "One browser tab that fuses live coding, a pedal-steel rig, pose tracking, and 20+ visualizers into a single instrument. No install — here's how to open it and start poking."
pubDate: 2026-08-16
tags: ["qualia", "livecoding", "web-audio", "strudel", "getting-started"]
---

qualia is a whole band's worth of gear crammed into one browser tab. No install, no server, no login — you open a URL and start playing.

It lives at [/qualia](/qualia). It's a static site — the browser does all the work, no server round-trips once it's loaded.

## what's in the box

One page, a pile of subsystems, all wired together:

- **live coding** — Strudel patterns for sound, with a Hydra bridge for visuals
- **a guitar / pedal-steel rig** — a Web-Audio channel strip: neural amp model, cab, EQ, delay, reverb, tuner
- **a looper** and a **step sequencer** for stacking stuff up live
- **vocal processing** — vocoder, harmonizer, voice shifter
- **realtime analysis** — FFT, RMS, beat detection
- **pose tracking** via MediaPipe, running off the main thread so it doesn't drop frames
- **audience participation** (we call it "entanglement")
- **20+ swappable visualizers** called quales, plus a little arcade because why not

You don't have to use all of it. Most nights I don't.

## how to start

Genuinely: open [/qualia](/qualia) in Chrome (or something Chrome-ish). That's the install step. There isn't another one.

Then:

1. **Pick a quale.** That's the visual that's running. Twenty-something of them, swap anytime.
2. **Allow the mic and/or camera** if you want it to react. Mic makes it audio-reactive, camera makes it move with your body. Skip both and it still runs — it just won't listen.
3. **Make noise.** Type a Strudel pattern, plug a guitar into the rig, or sing into the vocoder. Whatever's handy.

Never touched Strudel? One line gets you a beat:

```js
sound("bd sd bd sd")
```

...and then go read the actual [Strudel docs](https://strudel.cc/learn/), because I'm not going to teach it here and they do it better. Same deal with Hydra for the visual side — [hydra.video](https://hydra.video), go wild.

## the field

Here's the one idea that makes it all hang together. Every frame, everything — your audio, your body pose, the crowd — gets dumped into one shared data structure. I call it the field.

The visualizers read from the field. They don't care where a signal came from; a kick drum and a raised arm are both just numbers pushing a parameter around. That's why adding a new quale is basically one file: the field gets handed to you, you draw something, done.

Important bit: it all only *suggests*. The audio, the pose, the audience — they nudge parameters, they don't grab the wheel. The performer stays in control, always. It targets 30+ fps and it's built to survive a solo set.

## the name, quickly

voidstar is C's `void*` — `#define NULL ((void *)0)`, a pointer to nothing. qualia is the other end of that: taking the invisible stuff — sound, motion, attention — and making it something you can see.

Go poke at it.

→ [Open qualia](/qualia)
→ [Run it from your phone (tether)](/posts/tether-remote)
→ [Let the crowd into the visuals (entanglement)](/posts/audience-entanglement)
→ [Watch it in a real set](/videos)
→ [Learn Strudel](https://strudel.cc/learn/) · [Learn Hydra](https://hydra.video)
→ [Source on GitHub](https://github.com/randbrown)
