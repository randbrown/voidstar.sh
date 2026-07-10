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
  markdown: {
    shikiConfig: {
      theme: 'vesper',
      wrap: true,
    },
  },
});
