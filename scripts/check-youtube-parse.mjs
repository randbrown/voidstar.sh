// Node smoke test for the pure YouTube helpers — playlist/video id parsing,
// video-title → title/artist splitting, and match scoring. Run via `npm run
// check`. youtube-parse.js imports only match.js, so we test the real module.

import {
  youtubePlaylistId,
  isYoutubePlaylistUrl,
  youtubeVideoId,
  youtubeThumb,
  songHasYoutube,
  channelArtist,
  parseYouTubeTitle,
  scoreYoutubeMatch,
  isConfidentYoutube,
} from '../src/lib/setlist/youtube-parse.js';

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

// ── playlist id ──
check('playlist id from ?list= url',
  youtubePlaylistId('https://youtube.com/playlist?list=PLQWJy1cKFG04&si=9k') === 'PLQWJy1cKFG04');
check('playlist id from watch url with &list=',
  youtubePlaylistId('https://www.youtube.com/watch?v=abc12345678&list=PL_oVy7DvnL3Cm9') === 'PL_oVy7DvnL3Cm9');
check('bare PL id accepted',
  youtubePlaylistId('PL_oVy7DvnL3Cm9Lrx1CdH8lLxcZmeiIfj') === 'PL_oVy7DvnL3Cm9Lrx1CdH8lLxcZmeiIfj');
check('bare video-ish id (no prefix) is not a playlist',
  youtubePlaylistId('dQw4w9WgXcQ') === null);
check('random text is not a playlist', youtubePlaylistId('hello world') === null);
check('isYoutubePlaylistUrl true for real link',
  isYoutubePlaylistUrl('https://youtube.com/playlist?list=PLQWJy1cKFG04') === true);
check('isYoutubePlaylistUrl false for a video link',
  isYoutubePlaylistUrl('https://youtu.be/dQw4w9WgXcQ') === false);

// ── video id + thumb ──
check('video id from watch url', youtubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('video id from youtu.be', youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=5') === 'dQw4w9WgXcQ');
check('video id from shorts', youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('no video id in a playlist-only url', youtubeVideoId('https://youtube.com/playlist?list=PLQWJy1cKFG04') === null);
check('thumb url built from id', youtubeThumb('dQw4w9WgXcQ') === 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');

// ── channelArtist ──
check('topic channel → artist', channelArtist('Patsy Cline - Topic') === 'Patsy Cline');
check('VEVO channel → spaced artist', channelArtist('TaylorSwiftVEVO') === 'Taylor Swift');
check('plain channel asserts no artist', channelArtist('Some Random Uploads') === '');

// ── parseYouTubeTitle ──
eq('artist - title with noise',
  parseYouTubeTitle('Willie Nelson - Crazy (Official Music Video) [HD]', 'Willie Nelson Official'),
  { title: 'Crazy', artist: 'Willie Nelson' });
eq('topic channel keeps whole title as song',
  parseYouTubeTitle('Crazy', 'Patsy Cline - Topic'),
  { title: 'Crazy', artist: 'Patsy Cline' });
eq('topic channel does not split a dashed song name',
  parseYouTubeTitle('T-R-O-U-B-L-E', 'Travis Tritt - Topic'),
  { title: 'T-R-O-U-B-L-E', artist: 'Travis Tritt' });
eq('bare title, plain channel → no artist',
  parseYouTubeTitle('Wagon Wheel (Live at the Ryman)', 'RymanShows'),
  { title: 'Wagon Wheel (Live at the Ryman)', artist: '' });
eq('lyric-video noise stripped',
  parseYouTubeTitle('Shenandoah - Two Dozen Roses (Lyrics)', 'Shenandoah'),
  { title: 'Two Dozen Roses', artist: 'Shenandoah' });
eq('em-dash separator',
  parseYouTubeTitle('Patsy Cline — Walkin After Midnight', ''),
  { title: 'Walkin After Midnight', artist: 'Patsy Cline' });
// A "Title - Artist" upload whose Topic channel matches the right side is swapped.
eq('title - artist swap via channel match',
  parseYouTubeTitle('Crazy - Willie Nelson', 'Willie Nelson - Topic'),
  { title: 'Crazy', artist: 'Willie Nelson' });

// ── scoring ──
const wagon = { title: 'Wagon Wheel', artist: 'Old Crow Medicine Show' };
const wagonHit = { title: 'Old Crow Medicine Show - Wagon Wheel (Official Video)', channel: 'Old Crow Medicine Show - Topic' };
check('right video is confident', isConfidentYoutube(wagon, wagonHit) === true);
const wrongHit = { title: 'Darius Rucker - Wagon Wheel', channel: 'DariusRuckerVEVO' };
const s = scoreYoutubeMatch(wagon, wrongHit);
check('same title different artist → high title score', s.title >= 0.6);
check('same title different artist → artist conflict', s.conflict === true);
check('artist conflict is not confident', isConfidentYoutube(wagon, wrongHit) === false);
const unrelated = { title: 'Some Other Song (Official Audio)', channel: 'Whoever - Topic' };
check('unrelated video is not confident', isConfidentYoutube(wagon, unrelated) === false);

// ── songHasYoutube ──
check('song with youtube altLink', songHasYoutube({ altLinks: [{ service: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' }] }) === true);
check('song with a youtube url but no service tag', songHasYoutube({ altLinks: [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }] }) === true);
check('song with only a spotify altLink', songHasYoutube({ altLinks: [{ service: 'spotify', url: 'spotify:track:x' }] }) === false);
check('song with no altLinks', songHasYoutube({}) === false);

if (failures) { console.error(`\n${failures} youtube-parse check(s) failed`); process.exit(1); }
console.log('\nall youtube-parse checks passed');
