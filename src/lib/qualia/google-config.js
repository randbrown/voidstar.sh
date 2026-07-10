// App-owned Google credentials shared by the lab apps' Drive features:
//   - "Sign in with Google" (GIS OAuth Web client, drive.file scope)
//   - the Drive Picker (document import)
//
// Both are PUBLIC identifiers: they ship in the client bundle no matter where
// they're stored, and are protected by the origin/referrer + API restrictions
// configured in the Google Cloud console — not by secrecy. They come from
// `PUBLIC_` env vars (inlined by Astro at build) chiefly so a committed `AIza…`
// Picker key doesn't trip GitHub secret scanning. Set at build/deploy time:
//
//   PUBLIC_GOOGLE_CLIENT_ID       …apps.googleusercontent.com  (OAuth Web client)
//   PUBLIC_GOOGLE_PICKER_API_KEY  AIza…                        (Picker dev key)
//
// Empty values degrade gracefully: no client id → the app falls back to a
// user-entered OAuth client id (advanced override in Settings); no picker key →
// the "pick from Drive" button is hidden (paste/upload still work). Optional
// chaining guards against `import.meta.env` being absent (e.g. a node script).

export const GOOGLE_CLIENT_ID = import.meta.env?.PUBLIC_GOOGLE_CLIENT_ID || '';
export const GOOGLE_PICKER_API_KEY = import.meta.env?.PUBLIC_GOOGLE_PICKER_API_KEY || '';

export function hasAppClientId() { return !!GOOGLE_CLIENT_ID; }
export function hasPickerKey() { return !!GOOGLE_PICKER_API_KEY; }

// The Cloud project number, needed by the Picker's setAppId so a drive.file
// grant associates with this app. It's the leading segment of the client id
// (`<projectNumber>-<random>.apps.googleusercontent.com`).
export function googleAppId() {
  const seg = GOOGLE_CLIENT_ID.split('-')[0];
  return /^\d+$/.test(seg) ? seg : '';
}
