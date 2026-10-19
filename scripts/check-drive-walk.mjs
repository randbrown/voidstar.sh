// Node check for the worker's resumable recursive Drive walk. Drive can't be
// hit from CI, so a fake tree is served through a mocked fetch that answers
// files.list "'a' in parents or 'b' in parents" queries with paging, and the
// walk is driven the way the client does it: follow `cursor` until null.
// Run via `npm run check`.

import { __driveInternals as drive } from '../workers/setlist-sync/index.js';

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

// Tree: root → 30 artist folders → 12 album folders each (390 folders, far
// past the old 200-folder cap) → 15 charts each (5400 files, past the old
// 2000-file cap). Plus one chain nested 10 deep to exercise the depth cap.
const FOLDER = 'application/vnd.google-apps.folder';
const children = new Map(); // parentId → [file]
const add = (parent, f) => { if (!children.has(parent)) children.set(parent, []); children.get(parent).push({ ...f, parents: [parent] }); };
const id = (s) => `id_${s}`.padEnd(12, 'x');
const ROOT = id('root');
let chartCount = 0;
for (let a = 0; a < 30; a++) {
  const art = id(`a${a}`);
  add(ROOT, { id: art, name: `Artist ${a}`, mimeType: FOLDER });
  for (let b = 0; b < 12; b++) {
    const alb = id(`a${a}b${b}`);
    add(art, { id: alb, name: `Album ${b}`, mimeType: FOLDER });
    for (let c = 0; c < 15; c++) {
      add(alb, { id: id(`a${a}b${b}c${c}`), name: `Song ${a}-${b}-${c} - Artist ${a}.pdf`, mimeType: 'application/pdf', webViewLink: `https://drive/${a}/${b}/${c}` });
      chartCount++;
    }
  }
}
let deep = ROOT;
for (let d = 1; d <= 10; d++) {
  const next = id(`deep${d}`);
  add(deep, { id: next, name: `deep ${d}`, mimeType: FOLDER });
  add(next, { id: id(`deepchart${d}`), name: `Deep Song ${d}.pdf`, mimeType: 'application/pdf', webViewLink: `https://drive/deep/${d}` });
  deep = next;
}

let calls = 0;
let failNext = 0;
globalThis.fetch = async (url) => {
  calls++;
  if (failNext > 0) { failNext--; return { ok: false, status: 429, json: async () => ({}) }; }
  const u = new URL(url);
  const q = u.searchParams.get('q');
  const parents = [...q.matchAll(/'([^']+)' in parents/g)].map(m => m[1]);
  const all = parents.flatMap(p => children.get(p) || []);
  const size = Number(u.searchParams.get('pageSize'));
  const start = Number(u.searchParams.get('pageToken') || 0);
  const page = all.slice(start, start + size);
  const nextPageToken = start + size < all.length ? String(start + size) : undefined;
  return { ok: true, status: 200, json: async () => ({ files: page, nextPageToken }) };
};

async function walkAll(opts = {}) {
  const files = [];
  let cursor = null, requests = 0, depthCapped = false;
  do {
    // round-trip the cursor through JSON, as the client's POST does
    const r = await drive.walkDriveFolder(ROOT, 'k', { ...opts, cursor: cursor && JSON.parse(JSON.stringify(cursor)) });
    files.push(...r.files);
    depthCapped ||= r.depthCapped;
    cursor = r.cursor;
    requests++;
  } while (cursor && requests < 100);
  return { files, requests, depthCapped, cursor };
}

{
  const r = await walkAll();
  const links = new Set(r.files.map(f => f.webViewLink));
  check(`every chart in a 390-folder tree is found (${links.size - 8}/${chartCount})`, [...links].filter(l => !l.includes('/deep/')).length === chartCount);
  check('no duplicates across resumed requests', links.size === r.files.length);
  check(`walk finishes with a null cursor in a few requests (${r.requests})`, !r.cursor && r.requests <= 5);
  check('depth cap reported for the 10-deep chain', r.depthCapped);
  check('charts down to depth 8 are found', links.has('https://drive/deep/8') && !links.has('https://drive/deep/9'));
}

{
  calls = 0;
  const r = await drive.walkDriveFolder(ROOT, 'k', { maxCalls: 3 });
  check('a request never spends more than maxCalls Drive calls', calls <= 3);
  check('a budget-limited request returns a cursor to resume', !!r.cursor && r.truncated);
}

{
  failNext = 1;
  const first = await drive.walkDriveFolder(ROOT, 'k');
  check('a Drive 429 on the first call keeps the root in the cursor', first.files.length === 0 && !!first.cursor);
  const r = await walkAll();
  check('…and the walk still completes after it', !r.cursor && r.files.length === chartCount + 8);
}

{
  const s = drive.sanitizeDriveCursor({ pending: [["x' or name contains 'a", 0], [id('ok'), 1], [id('neg'), -1]], batch: { ids: [[id('b'), 'two']], pageToken: 5 } });
  check('cursor sanitizer drops ids that could break out of the Drive query', s.pending.length === 1 && s.pending[0][0] === id('ok'));
  check('cursor sanitizer drops a batch with no valid ids', s.batch === null);
}

{
  calls = 0;
  const r = await drive.walkDriveFolder(ROOT, 'k', { maxDepth: 3, maxFolders: 20, maxFiles: 600, maxCalls: 6 });
  check('web-search caller keeps its tight caps', calls <= 6 && r.foldersVisited <= 20 && r.truncated);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ndrive walk: all checks passed');
