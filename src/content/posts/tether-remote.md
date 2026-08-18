---
title: "tether: run the whole rig from your pocket"
description: "The companion PWA that turns your phone into a wireless remote for qualia — pair once with a QR, then freeze loops and swap visuals from ten feet away."
pubDate: 2026-08-08
tags: ["tether", "qualia", "pwa", "live-performance", "phone-remote"]
---

Live coding has one dirty secret: it chains you to the keyboard. You want to walk out front, pick up the steel, actually *play* — but the loop needs freezing and the visualizer needs swapping, and both of those live behind a laptop that's now ten feet away.

tether is the fix. It's a little PWA that turns your phone into a wireless remote for the [qualia](/qualia) rig. No audio ever crosses the wire — just tiny control messages — so you can drive the whole set from your pocket while your hands do something better.

## pairing (once)

Open [/lab/tether](/lab/tether), install it, and you get a fullscreen app with a cyan ⌁ icon. Then pair: in qualia, hit **⌁ sync → leader** and it throws up a private QR. Scan it. That's the whole handshake.

Do it once. After that the installed app relaunches straight into the room — no QR, no fiddling. Phone comes out of your pocket already connected.

## one action map, three ways in

Here's the part I'm smug about. tether doesn't have its own logic. Every pad, slider, and drum pad dispatches through the *same action map* as my DOIO macro-pad keystrokes and my MIDI controller. Three input paths, one behavior, zero drift. Rebind "freeze" once and all three follow.

The surface splits into tabs:

- **rig** — freeze/grab, drives, strip toggles, gain sliders
- **loop** — looper transport + grab; one rec button that cycles three states
- **seq** — strudel/seq transport, tempo slider, live drum pads you tap to sound a voice, plus undo/redo/clear
- **quale** — switch quale/phase, auto-cycle toggles, the set-clock readout, camera, blackout

So the whole rig — audio, looper, sequencer, visuals — is reachable from across the stage.

## built for a stage, not a demo

Two things separate this from a toy web remote.

First: it's a control surface, not an audio pipe. Only control messages ride a Cloudflare relay, ingress is allowlisted, rate-limited per phone, and *never* eval'd. Your phone can't stream sound or run arbitrary code into the rig — it can only ask for actions that already exist.

Second: it survives the venue. There's a ⏻ "pocket lock" so a stray thigh can't fire a blackout mid-song — tap to deactivate, press-and-hold ~0.4s to re-arm. A screen wake-lock keeps the phone awake through a long ambient stretch. And because venue wifi is reliably garbage, sends are buffered and it auto-reconnects when the network flaps.

None of that is glamorous. All of it is why I trust it live.

## why bother

The best moments happen away from the laptop. tether is the difference between "person hunched over a keyboard" and "playing steel out front while the loop freezes on cue" — same rig, hands free.

→ [the qualia instrument](/qualia)
→ [what qualia actually is](/posts/qualia-overview)
→ [tether lives here](/lab/tether)
→ [letting the audience in, too](/posts/audience-entanglement)
