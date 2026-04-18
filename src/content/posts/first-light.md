---
title: "First Light: Why I Made This Site"
description: "On building a home for code, art, and the space between them."
pubDate: 2026-04-18
tags: ["meta", "intro", "art", "code"]
---

Every project starts with a question. For this site, the question was: *where do I put the things that don't fit anywhere else?*

The particle systems, the pose-tracking experiments, the music visualizers — these live in that weird intersection between code and art that doesn't have a clean category on a resume or a portfolio. This site is meant to be that category.

## What's voidstar?

`void*` is a pointer type in C — it points to *something*, but the type system doesn't know what. It's raw memory. Potential without form.

That felt right. I build things that start as raw potential: a camera feed, a sine wave, a point cloud. The code gives them form.

## What to expect

- **Posts** like this one: writing about process, tools, ideas
- **Videos**: embedded previews of art/music pieces from YouTube
- **Lab**: interactive in-browser experiments — particle systems, pose detection, generative visuals
- **Projects**: links out to GitHub repos

The lab section will be where the real chaos lives. Canvas2D, WebGL, TensorFlow.js pose estimation, Web Audio API — if it runs in a browser, it might end up there.

## Stack

Built with [Astro](https://astro.build) — static by default, interactive by choice. Deployed to Cloudflare Pages. The interactive bits use vanilla JS or lightweight WebGL, no React overhead for a particle system.

More soon.
