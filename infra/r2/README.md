# R2 hosting for full-quality Video quale clips

For clips too large for the repo / Cloudflare Pages' 25 MiB asset cap (e.g. the
1080p originals), host them in a Cloudflare R2 bucket and reference them by URL
in `DEFAULT_URLS` (`src/lib/qualia/fx/video.js`). This keeps the repo lean while
still getting full glitch FX — as long as CORS is set up correctly (below).

These steps run against **your** Cloudflare account; they can't be done from the
repo/CI. `cors.json` here is the only artifact the code depends on.

## Why CORS matters here

The Video quale reads each frame into a WebGL texture, and the `<video>` element
sets `crossOrigin = 'anonymous'` (`fx/video.js:506`). For that read to succeed
cross-origin, the response must carry `Access-Control-Allow-Origin`. Without it
the clip still *plays*, but via a DOM fallback with **no glitch FX** (the
"no-cors" badge in the source list).

Video also streams via HTTP **Range** requests, so the policy must allow the
`Range` request header and expose `Content-Range` / `Accept-Ranges` /
`Content-Length` back to the page. `cors.json` does all of this.

## 1. Create the bucket

```sh
wrangler r2 bucket create voidstar-media
```

## 2. Upload clips

```sh
wrangler r2 object put voidstar-media/clip01.mp4 --file ./clip01.mp4 \
  --content-type video/mp4
```

(or drag-drop in the Cloudflare dashboard → R2 → voidstar-media → Objects)

Optional but nice: set a long cache header since clips are effectively
immutable — `--cache-control "public, max-age=31536000, immutable"`.

## 3. Make the bucket publicly readable

R2 buckets are private by default. Pick one:

- **Custom domain (recommended)** — Dashboard → R2 → voidstar-media → Settings →
  Public access → Connect Domain, e.g. `media.voidstar.sh`. Routes through
  Cloudflare's CDN, so you control caching and there's no rate limit. URLs look
  like `https://media.voidstar.sh/clip01.mp4`.
- **Managed `r2.dev` subdomain** — one toggle, but it's rate-limited and
  Cloudflare explicitly marks it "not for production." Fine for a quick test.

Note: a subdomain like `media.voidstar.sh` is still a *different origin* from
`voidstar.sh`, so the CORS policy below is required either way.

## 4. Apply the CORS policy

Dashboard: R2 → voidstar-media → Settings → CORS Policy → Edit → paste
`cors.json`.

Or via the S3-compatible API with the AWS CLI (R2 endpoint:
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`):

```sh
aws s3api put-bucket-cors \
  --bucket voidstar-media \
  --cors-configuration file://<(jq '{CORSRules: .}' cors.json) \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

`AllowedOrigins` is `["*"]` because these are public, non-credentialed media
files — simplest and safe for this use. To scope it instead, replace `"*"` with
`"https://voidstar.sh"`, `"http://localhost:4321"` (dev), and any preview
origins you use.

## 5. Verify CORS + Range before wiring it in

```sh
curl -sI -H "Origin: https://voidstar.sh" -H "Range: bytes=0-1" \
  https://media.voidstar.sh/clip01.mp4 | grep -i -E 'access-control|content-range|accept-ranges'
```

Expect `access-control-allow-origin`, `content-range`, and `accept-ranges:
bytes` in the response.

## 6. Wire as defaults

Add each verified URL to `DEFAULT_URLS` in `src/lib/qualia/fx/video.js`,
alongside the existing Mixkit entries:

```js
{ src: 'https://media.voidstar.sh/clip01.mp4', name: 'clip 01' },
```

Or just paste the URL into the Video quale's URL field at runtime — URL entries
persist in localStorage across reloads.
