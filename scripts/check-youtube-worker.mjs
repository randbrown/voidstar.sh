// Node smoke test for the worker's YouTube extraction (InnerTube / HTML shapes).
// The worker can't be exercised against live YouTube in CI, so we feed the
// real renderer shapes (playlistVideoRenderer, the newer lockupViewModel,
// videoRenderer) through the exported __ytInternals and assert the parse. Run
// via `npm run check`.

import { __ytInternals as yt } from '../workers/setlist-sync/index.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`  ok  ${name}`); }
  else { console.error(`FAIL  ${name}`); failures++; }
}
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); failures++; }
}

// ── parseClock ──
check('parseClock m:ss', yt.parseClock('3:45') === 225);
check('parseClock h:mm:ss', yt.parseClock('1:02:03') === 3723);
check('parseClock junk → 0', yt.parseClock('live') === 0);

// ── playlist id ──
check('playlist id from url', yt.youtubePlaylistIdFromUrl('https://youtube.com/playlist?list=PL_oVy7DvnL3Cm9Lrx1CdH8lLxcZmeiIfj&si=x') === 'PL_oVy7DvnL3Cm9Lrx1CdH8lLxcZmeiIfj');
check('playlist id bare', yt.youtubePlaylistIdFromUrl('PLQWJy1cKFG04') === 'PLQWJy1cKFG04');

// ── InnerTube browse fixture: classic playlistVideoRenderer rows ──
const browse = {
  header: { playlistHeaderRenderer: { title: { simpleText: 'My Gig Playlist' } } },
  contents: { some: { nesting: [
    { playlistVideoRenderer: {
      videoId: 'aaa11111111',
      title: { runs: [{ text: 'Willie Nelson - Crazy (Official Video)' }] },
      shortBylineText: { runs: [{ text: 'Willie Nelson - Topic' }] },
      lengthSeconds: '225', lengthText: { simpleText: '3:45' },
    } },
    { playlistVideoRenderer: {
      videoId: 'bbb22222222',
      title: { runs: [{ text: 'Shenandoah - Two Dozen Roses' }] },
      shortBylineText: { runs: [{ text: 'Shenandoah' }] },
      lengthText: { simpleText: '3:12' },
    } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'CONT_TOKEN_123' } } } },
  ] } },
};
const plTracks = yt.collectVideos(browse, ['playlistVideoRenderer', 'lockupViewModel'], 200);
check('browse: 2 tracks', plTracks.length === 2);
eq('browse: first track', plTracks[0], {
  title: 'Willie Nelson - Crazy (Official Video)',
  url: 'https://www.youtube.com/watch?v=aaa11111111',
  videoId: 'aaa11111111',
  thumbnail: 'https://i.ytimg.com/vi/aaa11111111/hqdefault.jpg',
  durationSec: 225,
  channel: 'Willie Nelson - Topic',
});
check('browse: second duration parsed from lengthText', plTracks[1].durationSec === 192);
check('browse: playlist title', yt.extractPlaylistTitle(browse) === 'My Gig Playlist');
check('browse: continuation token', yt.continuationToken(browse) === 'CONT_TOKEN_123');

// ── Newer lockupViewModel playlist (no playlistVideoRenderer at all) ──
const lockupData = { contents: [
  { lockupViewModel: {
    contentId: 'ccc33333333',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: {
      title: { content: 'Patsy Cline - Walkin After Midnight' },
      metadata: { contentMetadataViewModel: { metadataRows: [
        { metadataParts: [{ text: { content: 'Patsy Cline - Topic' } }] },
        { metadataParts: [{ text: { content: '1.2M views' } }, { text: { content: '3 years ago' } }] },
      ] } },
    } },
  } },
] };
const lockTracks = yt.collectVideos(lockupData, ['playlistVideoRenderer', 'lockupViewModel'], 200);
check('lockup: falls through to lockupViewModel', lockTracks.length === 1);
check('lockup: videoId', lockTracks[0].videoId === 'ccc33333333');
check('lockup: title', lockTracks[0].title === 'Patsy Cline - Walkin After Midnight');
check('lockup: channel skips the views row', lockTracks[0].channel === 'Patsy Cline - Topic');

// ── Search fixture: videoRenderer rows ──
const search = { contents: { deep: [
  { videoRenderer: {
    videoId: 'ddd44444444',
    title: { runs: [{ text: 'Old Crow Medicine Show - Wagon Wheel' }] },
    ownerText: { runs: [{ text: 'Old Crow Medicine Show' }] },
    lengthText: { simpleText: '4:12' },
  } },
  { playlistRenderer: { playlistId: 'PLxxxx', title: { simpleText: 'a playlist, not a video' } } },
] } };
const results = yt.collectVideos(search, ['videoRenderer', 'lockupViewModel'], 5);
check('search: one video', results.length === 1);
check('search: video not confused with playlistRenderer', results[0].videoId === 'ddd44444444');
check('search: duration', results[0].durationSec === 252);
check('search: channel', results[0].channel === 'Old Crow Medicine Show');

// ── HTML fallback: ytInitialData brace-matching ──
const html = `<!doctype html><script>var ytInitialData = ${JSON.stringify(browse)};</script></html>`;
const parsed = yt.extractYtInitialData(html);
check('extractYtInitialData parses the blob', parsed && yt.extractPlaylistTitle(parsed) === 'My Gig Playlist');

// ── dedupe: same videoId across rows collapses ──
const dup = { x: [
  { playlistVideoRenderer: { videoId: 'zzz', title: { simpleText: 'A' } } },
  { playlistVideoRenderer: { videoId: 'zzz', title: { simpleText: 'A again' } } },
] };
check('dedupe by videoId', yt.collectVideos(dup, ['playlistVideoRenderer'], 200).length === 1);

if (failures) { console.error(`\n${failures} youtube-worker check(s) failed`); process.exit(1); }
console.log('\nall youtube-worker checks passed');
