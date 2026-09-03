// Build (or refresh) a real Spotify playlist from a setlist — the write-side
// counterpart to the read-only reference-playlist machinery in sync.js.
// Everything runs as the signed-in user (PKCE token from spotify-auth.js):
// since the Feb 2026 API migration a client-credentials token can't touch
// playlist contents at all, and creating one on the user's account needs
// their consent (the playlist-modify scopes) anyway. No worker involved.
//
// Which songs go in, in what order, and what's reported as left out is the
// pure module spotify-export-core.js; this file is only the HTTP.

import { getSpotifyUserToken, isSpotifyConnected, hasSpotifyScope } from './spotify-auth.js';
import { collectSetlistTrackUris, exportPlaylistName, exportPlaylistDescription } from './spotify-export-core.js';

const API = 'https://api.spotify.com/v1';

async function spotifyCall(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch {}
    const err = new Error(`Spotify rejected ${method} ${path} (${res.status}${msg ? `: ${msg}` : ''})`);
    err.status = res.status;
    throw err;
  }
  try { return await res.json(); } catch { return null; }
}

// The Feb 2026 migration renamed the playlist-contents path /tracks → /items
// for reads, and which name writes answer to varies by app quota mode (the
// same reason sync.js parses both `item` and `track`). Probe /items first to
// match the read path, fall back to /tracks when Spotify refuses the path,
// and remember what worked. A retired path answers a BARE 403 Forbidden for
// development-mode apps (observed in the field on playlist creation, and
// documented for the old contents reads) — so 403 falls back too, alongside
// 404/405; anything else (401, 429) is a real answer the other path can't
// fix. When both paths refuse, the canonical /items answer is the one
// reported (a scope 403 there says "Insufficient client scope" outright).
let _writeSuffix = null;
async function writeContents(token, playlistId, method, body) {
  const candidates = _writeSuffix ? [_writeSuffix] : ['items', 'tracks'];
  let firstErr = null;
  for (const suffix of candidates) {
    try {
      const out = await spotifyCall(token, method, `/playlists/${playlistId}/${suffix}`, body);
      _writeSuffix = suffix;
      return out;
    } catch (e) {
      firstErr = firstErr || e;
      if (e.status !== 403 && e.status !== 404 && e.status !== 405) throw e;
    }
  }
  throw firstErr; // both paths refused — a 404 here means the playlist is gone
}

// Playlist creation moved in the same migration: the classic documented
// path, POST /users/{id}/playlists, answers a bare 403 Forbidden for
// development-mode apps no matter the token's scopes (the retired-path
// signature — this is exactly the bug the first release of this feature
// shipped with), while POST /me/playlists works. Probe /me/playlists first
// and keep the classic path as the fallback for app modes that retained it;
// when both refuse, report the canonical attempt plus a reconnect hint so a
// genuine scope problem stays diagnosable from the status line.
async function createPlaylist(token, body) {
  let first = null;
  try {
    return await spotifyCall(token, 'POST', '/me/playlists', body);
  } catch (e) {
    if (e.status !== 403 && e.status !== 404 && e.status !== 405) throw e;
    first = e;
  }
  try {
    const me = await spotifyCall(token, 'GET', '/me');
    return await spotifyCall(token, 'POST', `/users/${encodeURIComponent(me.id)}/playlists`, body);
  } catch (e2) {
    const err = new Error(`${first.message} — the legacy create path also failed (${e2.status || e2.message}). If this persists, disconnect and reconnect Spotify in Settings so the session re-consents to the playlist-modify scopes.`);
    err.status = first.status;
    throw err;
  }
}

// Create a private playlist from the setlist's linked songs, or make the
// previously-exported one (existingPlaylistId) match the setlist again — the
// first write batch replaces the contents, so removals and re-orders on the
// setlist propagate. A recorded playlist that no longer exists (404) is
// quietly rebuilt as a fresh one.
//
// Throws user-readable errors; `needsConnect` / `needsReauth` on the error
// mark the two auth cases the UI can do something about (send to Settings /
// re-run the login for the modify scopes).
export async function exportSetlistToSpotify(setlist, songs, { existingPlaylistId = '', onProgress } = {}) {
  const { uris, skipped, duplicates, guessCount } = collectSetlistTrackUris(setlist, songs);
  if (!uris.length) {
    throw new Error('No song on this setlist has a Spotify track link yet — run auto-link, or the library tools\' spotify quick-link.');
  }

  const token = await getSpotifyUserToken();
  if (!token) {
    const e = new Error(isSpotifyConnected()
      ? 'The saved Spotify session could not refresh — disconnect and reconnect in Settings → spotify account.'
      : 'Building a playlist needs your Spotify account — connect it in Settings → spotify account.');
    e.needsConnect = true;
    throw e;
  }
  if (!hasSpotifyScope('playlist-modify-private')) {
    const e = new Error('The connected Spotify session predates playlist building, so it can\'t create playlists yet — reconnect to grant it.');
    e.needsReauth = true;
    throw e;
  }

  const name = exportPlaylistName(setlist);
  const description = exportPlaylistDescription(setlist);
  let playlistId = existingPlaylistId;
  let created = false;
  let url = playlistId ? `https://open.spotify.com/playlist/${playlistId}` : '';

  if (playlistId) {
    onProgress?.('updating the exported playlist…');
    try {
      await writeContents(token, playlistId, 'PUT', { uris: uris.slice(0, 100) });
      for (let i = 100; i < uris.length; i += 100) {
        onProgress?.(`adding tracks ${Math.min(i + 100, uris.length)}/${uris.length}…`);
        await writeContents(token, playlistId, 'POST', { uris: uris.slice(i, i + 100) });
      }
      // Keep the playlist's name/description following the setlist —
      // best-effort, the contents are the point.
      try { await spotifyCall(token, 'PUT', `/playlists/${playlistId}`, { name, description }); } catch {}
    } catch (e) {
      if (e.status !== 404) throw e;
      playlistId = '';
    }
  }

  if (!playlistId) {
    onProgress?.('creating the playlist…');
    const pl = await createPlaylist(token, { name, description, public: false });
    playlistId = pl.id;
    created = true;
    url = pl?.external_urls?.spotify || `https://open.spotify.com/playlist/${playlistId}`;
    for (let i = 0; i < uris.length; i += 100) {
      onProgress?.(`adding tracks ${Math.min(i + 100, uris.length)}/${uris.length}…`);
      await writeContents(token, playlistId, 'POST', { uris: uris.slice(i, i + 100) });
    }
  }

  return { playlistId, url, name, created, trackCount: uris.length, skipped, duplicates, guessCount };
}
