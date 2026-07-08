// Spotify user login (Authorization Code + PKCE) — lets the app read
// playlists AS THE SIGNED-IN USER, straight from the browser (Spotify's Web
// API and token endpoint both allow CORS). This exists because playlist
// reads with the worker's client-credentials token return 403 Forbidden for
// newer Spotify app registrations (and always did for private/collaborative
// playlists) — a user token reads anything the user can see in Spotify.
//
// PKCE keeps this browser-only: no client secret is involved, so the same
// client id the worker uses is safe in localStorage. The redirect URI must
// be registered EXACTLY in the Spotify developer dashboard (your app →
// Settings → Redirect URIs) — the Settings page shows the exact value to
// paste. Spotify requires HTTPS redirect URIs; the one exception is the
// loopback IP literal (http://127.0.0.1:4321/...) — "localhost" is not
// accepted, use the IP for local dev.
//
// Login is a full-page redirect (not a popup), so it needs no gesture
// gymnastics on mobile: beginSpotifyLogin() navigates away, and
// completeSpotifyLogin() (called once at app init) finishes the exchange
// when Spotify sends the user back with ?code=.

const CLIENT_ID_KEY = 'voidstar.setlist.spotify.clientId';
const TOKEN_KEY = 'voidstar.setlist.spotify.token';
// sessionStorage, only alive during the redirect round-trip: the PKCE
// verifier plus the hash to restore so the user lands back where they left.
const PKCE_KEY = 'voidstar.setlist.spotify.pkce';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SCOPES = 'playlist-read-private playlist-read-collaborative';

export function getSpotifyClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || '';
}

export function setSpotifyClientId(id) {
  localStorage.setItem(CLIENT_ID_KEY, id.trim());
}

// The page itself is the redirect target — computed, not hardcoded, so it
// matches however this deployment is reached (prod domain, preview, dev).
// Normalized to NO trailing slash: the page is reachable both ways
// (/lab/setlist and /lab/setlist/), and Spotify compares redirect URIs
// character-for-character, so the raw pathname made the sent URI depend on
// how the page happened to be loaded. One canonical form keeps the value
// shown in Settings, the authorize request, and the token exchange
// identical. Coming back, the host's redirect to the slash form keeps the
// ?code= query intact.
export function spotifyRedirectUri() {
  const path = location.pathname.replace(/\/+$/, '');
  return location.origin + (path || '/');
}

export function isSpotifyConnected() {
  return !!readToken();
}

export function disconnectSpotify() {
  localStorage.removeItem(TOKEN_KEY);
}

function readToken() {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return t?.accessToken ? t : null;
  } catch { return null; }
}

function saveToken(data, prevRefreshToken) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    accessToken: data.access_token,
    // Spotify rotates refresh tokens on use but omits the field when it
    // doesn't — keep the old one in that case.
    refreshToken: data.refresh_token || prevRefreshToken || '',
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000,
  }));
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Kick off the login redirect. Throws (with a user-readable message) when no
// client id is configured yet.
export async function beginSpotifyLogin() {
  const clientId = getSpotifyClientId();
  if (!clientId) throw new Error('Enter your Spotify client id first (from developer.spotify.com).');

  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));

  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, hash: location.hash || '#settings' }));

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

let _lastLoginError = null;
// A user-readable message when the most recent redirect return failed
// (denied consent, redirect-URI mismatch, expired round-trip) — Settings
// shows it so a failed connect never looks like a silent no-op.
export function spotifyLoginError() {
  return _lastLoginError;
}

// Finish the redirect round-trip. Call once at app init, before the first
// route. Returns null when this page load isn't an auth return; otherwise
// {ok} after cleaning ?code= out of the URL and restoring the saved hash.
// Never throws.
export async function completeSpotifyLogin() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const authError = params.get('error');
  if (!code && !authError) return null;

  let rec = null;
  try { rec = JSON.parse(sessionStorage.getItem(PKCE_KEY)); } catch {}
  sessionStorage.removeItem(PKCE_KEY);

  // Clean the one-shot ?code= URL either way (a reload of it can't succeed —
  // auth codes are single-use) and put the user back on the page they left.
  history.replaceState(null, '', location.pathname + (rec?.hash || '#settings'));

  if (authError) {
    _lastLoginError = `Spotify login was ${authError === 'access_denied' ? 'declined' : `refused (${authError})`}.`;
    return { ok: false };
  }
  if (!rec?.verifier) {
    _lastLoginError = 'Spotify login round-trip expired — tap connect again.';
    return { ok: false };
  }

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: spotifyRedirectUri(),
        client_id: getSpotifyClientId(),
        code_verifier: rec.verifier,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      _lastLoginError = `Spotify token exchange failed: ${data.error_description || data.error || res.status}. Check that the Redirect URI in your Spotify app settings is exactly ${spotifyRedirectUri()}`;
      return { ok: false };
    }
    saveToken(data);
    _lastLoginError = null;
    return { ok: true };
  } catch (e) {
    _lastLoginError = `Spotify token exchange failed: ${e.message}`;
    return { ok: false };
  }
}

// Prove the connected session actually works by asking Spotify who it is —
// "Connected" based on a stored token alone can lie (revoked app access, a
// dev-mode app the user was removed from). Returns {ok:true, name} or
// {ok:false, reason}; never throws. Settings shows the result so a broken
// session is visible BEFORE an auto-link run fails on it.
export async function checkSpotifyConnection() {
  if (!readToken()) return { ok: false, reason: 'not connected' };
  const token = await getSpotifyUserToken();
  if (!token) {
    return { ok: false, reason: 'the saved session could not refresh — disconnect and reconnect' };
  }
  try {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch {}
      return {
        ok: false,
        reason: `Spotify rejected the session (${res.status}${detail ? `: ${detail}` : ''}) — disconnect and reconnect; if it persists, check that this Spotify account is added under User Management in the app's dashboard (developer.spotify.com), which development-mode apps require`,
      };
    }
    const me = await res.json();
    return { ok: true, name: me.display_name || me.id || '' };
  } catch {
    return { ok: true, name: '' }; // offline — not a verdict on the session
  }
}

// Serialize concurrent refreshes (several playlist fetches can race at once).
let _refreshing = null;

// A valid user access token, silently refreshing when expired, or null when
// not connected / the refresh token was revoked (the user reconnects via
// Settings — token refresh needs no gesture, so null really means gone).
export async function getSpotifyUserToken() {
  const t = readToken();
  if (!t) return null;
  if (Date.now() < t.expiresAt) return t.accessToken;
  if (!t.refreshToken) { disconnectSpotify(); return null; }

  if (!_refreshing) {
    _refreshing = (async () => {
      try {
        const res = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: t.refreshToken,
            client_id: getSpotifyClientId(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
          console.warn('[setlist] spotify token refresh failed:', data.error_description || data.error || res.status);
          disconnectSpotify();
          return null;
        }
        saveToken(data, t.refreshToken);
        return data.access_token;
      } catch (e) {
        // Transient network failure — keep the record so a later call retries.
        console.warn('[setlist] spotify token refresh failed:', e.message);
        return null;
      } finally {
        _refreshing = null;
      }
    })();
  }
  return _refreshing;
}
