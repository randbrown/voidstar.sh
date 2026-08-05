// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://voidstar.sh',
  build: {
    // Inline CSS into each page's HTML instead of emitting separate hashed
    // /_astro/*.css files. The HTML is served network-first by the service
    // worker and always arrives; a separately-fetched stylesheet can fail on
    // its own (poisoned edge cache, deploy skew, flaky mid-load) and leave the
    // page as bare unstyled HTML — the exact failure StyleGuard exists to paper
    // over. Inlining removes that failure mode: if the document loads, its
    // styles loaded with it. 'auto' left large stylesheets (the lab apps')
    // linked; 'always' inlines them regardless of size.
    inlineStylesheets: 'always',
  },
  integrations: [
    mdx(),
    sitemap(),
  ],
  vite: {
    // The ffmpeg.wasm wrapper spawns its worker via
    // `new Worker(new URL('./worker.js', import.meta.url))`. Vite's build
    // handles that fine, but dev-server dependency pre-bundling (esbuild)
    // would inline the module and break the relative worker URL — exclude
    // the packages so dev serves them as native ESM (the upstream-documented
    // Vite recipe). The heavy ffmpeg core itself is not bundled at all; the
    // syzygy lab lazy-loads it from CDN at render time.
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
  },
  markdown: {
    shikiConfig: {
      theme: 'vesper',
      wrap: true,
    },
  },
});
