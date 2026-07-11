// Pure sharding + merge core for the mind Drive sync (no IndexedDB / DOM), so it
// imports safely under plain node and is covered by scripts/check-mind-shard.mjs.
//
// The dataset shape is exactly store.exportAll(): a flat
//   { notes, folders, tasks, tasklists, attachments, annotations, settings }.
// On Drive it is split into:
//   - index.json  = { schema, shardCount, folders, tasklists, settings }  (small, global)
//   - shards/shard-NNN.json = { notes, tasks, attachments, annotations }  filtered to a
//     bucket b = fnv1a(key) % N  (notes/tasks/attachments by id, annotations by key).
// Only the changed shard(s) re-upload, so an edit costs ~one small file instead
// of the whole corpus. The merge rules (mergeRecord + conflict copies) are the
// SAME as before — this module only relocates and parameterizes them so the
// client and the test can share one implementation.

import { mergeRecord, NOTE_FILL_FIELDS, ATTACHMENT_FILL_FIELDS, TASK_FILL_FIELDS } from './store.js';

export const SCHEMA_VERSION = 2;
export const DEFAULT_SHARD_COUNT = 64;

// The exportAll() arrays that live in shards, and the key field each is keyed by.
export const SHARD_ARRAYS = { notes: 'id', tasks: 'id', attachments: 'id', annotations: 'key' };
// The exportAll() arrays that live in index.json (keyed by id).
export const INDEX_ARRAYS = { folders: 'id', tasklists: 'id' };

const defaultIdGen = () => globalThis.crypto.randomUUID();
const defaultNow = () => Date.now();

// ── Bucketing ──

// 32-bit FNV-1a — a fast, stable, non-cryptographic hash. Only used to spread
// records across buckets; collisions are fine (a bucket just holds more records).
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function bucket(key, n = DEFAULT_SHARD_COUNT) {
  return fnv1a(String(key)) % n;
}

export function shardName(b) {
  return `shard-${String(b).padStart(3, '0')}.json`;
}

export function parseShardName(name) {
  const m = /^shard-(\d{3,})\.json$/.exec(name || '');
  return m ? parseInt(m[1], 10) : null;
}

// ── Canonical serialization + content hashing ──
// Two devices must serialize the SAME logical shard to the SAME bytes, or the
// content hash never matches and the shard re-uploads forever (ping-pong).
// canonicalJSON sorts object keys recursively; record arrays are pre-sorted by
// their key field (normalizeShard/normalizeIndex) before hashing. Arrays inside
// a record (e.g. tags) are left as-is — after a merge both devices hold the
// identical record object, so their order already agrees.

function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

export function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

function sortByKey(arr, keyField) {
  return [...(arr || [])].sort((a, b) => String(a[keyField]).localeCompare(String(b[keyField])));
}

function normalizeShard(shard) {
  const out = {};
  for (const [coll, keyField] of Object.entries(SHARD_ARRAYS)) out[coll] = sortByKey(shard?.[coll], keyField);
  return out;
}

function normalizeIndex(index) {
  return {
    schema: index?.schema ?? SCHEMA_VERSION,
    shardCount: index?.shardCount ?? DEFAULT_SHARD_COUNT,
    folders: sortByKey(index?.folders, 'id'),
    tasklists: sortByKey(index?.tasklists, 'id'),
    settings: index?.settings || {},
  };
}

// cyrb53 — a well-distributed 53-bit string hash, returned as 16 hex chars.
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(16).padStart(8, '0');
  const lo = (h1 >>> 0).toString(16).padStart(8, '0');
  return hi + lo;
}

export function hashShard(shard) {
  return cyrb53(canonicalJSON(normalizeShard(shard)));
}

export function hashIndex(index) {
  return cyrb53(canonicalJSON(normalizeIndex(index)));
}

// ── Split / combine ──

export function emptyShard() {
  return { notes: [], tasks: [], attachments: [], annotations: [] };
}

export function isEmptyShard(shard) {
  return Object.keys(SHARD_ARRAYS).every(coll => !(shard?.[coll]?.length));
}

// dataset (exportAll shape) → { index, shards: Map<bucket, shardObj> }.
// Only non-empty buckets get an entry (empty buckets are never materialized).
export function splitIntoShards(dataset, n = DEFAULT_SHARD_COUNT) {
  const shards = new Map();
  const ensure = (b) => {
    let s = shards.get(b);
    if (!s) { s = emptyShard(); shards.set(b, s); }
    return s;
  };
  for (const [coll, keyField] of Object.entries(SHARD_ARRAYS)) {
    for (const rec of dataset[coll] || []) ensure(bucket(rec[keyField], n))[coll].push(rec);
  }
  const index = {
    schema: SCHEMA_VERSION,
    shardCount: n,
    folders: dataset.folders || [],
    tasklists: dataset.tasklists || [],
    settings: dataset.settings || {},
  };
  return { index, shards };
}

// index + iterable of shard objects → dataset (exportAll shape). Inverse of
// splitIntoShards up to record order (which is irrelevant — everything is keyed).
export function combineShards(index, shardObjs) {
  const out = {
    notes: [], folders: index?.folders || [], tasks: [], tasklists: index?.tasklists || [],
    attachments: [], annotations: [], settings: index?.settings || {},
  };
  for (const s of shardObjs || []) {
    if (!s) continue;
    for (const coll of Object.keys(SHARD_ARRAYS)) if (s[coll]) out[coll].push(...s[coll]);
  }
  return out;
}

// ── Merge (relocated from gdrive-sync.js; rules unchanged) ──

export function mergeById(localArr, remoteArr, keyField = 'id', fillFields = null) {
  const map = new Map();
  for (const item of localArr) map.set(item[keyField], item);
  for (const remote of remoteArr) {
    const key = remote[keyField];
    const local = map.get(key);
    map.set(key, local ? mergeRecord(local, remote, fillFields) : remote);
  }
  return [...map.values()];
}

export function mergeConfig(local, remote) {
  const out = { ...(remote || {}) };
  for (const [k, v] of Object.entries(local || {})) {
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (!empty || !(k in out)) out[k] = v;
  }
  return out;
}

export function configChanged(local = {}, remote = {}) {
  const merged = mergeConfig(local, remote);
  const keys = new Set([...Object.keys(merged), ...Object.keys(local)]);
  for (const k of keys) {
    if (JSON.stringify(merged[k]) !== JSON.stringify(local[k])) return true;
  }
  return false;
}

export function recordsChanged(localArr = [], mergedArr = [], keyField = 'id') {
  if (localArr.length !== mergedArr.length) return true;
  const map = new Map(localArr.map(i => [i[keyField], i]));
  return mergedArr.some(rec => {
    const cur = map.get(rec[keyField]);
    if (cur === rec) return false;
    return !cur || JSON.stringify(cur) !== JSON.stringify(rec);
  });
}

// Notes merge with conflict copies. A note edited on BOTH sides since this
// device's last completed cycle, with different bodies, resolves LWW — and the
// losing body is preserved as a new "Conflicted copy of …" note. First sync (no
// cycle stamp) is plain LWW+fill: a missing baseline must not spam copies. The
// DOM/clock deps (device name, id, clock) are injected so this stays pure —
// pass the FULL local notes array so the dedup scan sees every existing copy.
export function mergeNotes(localArr, remoteArr, opts = {}) {
  const { lastCycleAt = 0, deviceName = 'device', idgen = defaultIdGen, now = defaultNow } = opts;
  const copies = [];
  const map = new Map(localArr.map(n => [n.id, n]));
  const existing = [...localArr, ...remoteArr];

  for (const remote of remoteArr) {
    const local = map.get(remote.id);
    if (!local) { map.set(remote.id, remote); continue; }

    const concurrent = lastCycleAt
      && !local.deletedAt && !remote.deletedAt
      && local.updatedAt !== remote.updatedAt
      && local.updatedAt > lastCycleAt && remote.updatedAt > lastCycleAt
      && (local.body || '') !== (remote.body || '');

    const merged = mergeRecord(local, remote, NOTE_FILL_FIELDS);
    map.set(remote.id, merged);

    if (concurrent) {
      const loser = merged.updatedAt === local.updatedAt ? remote : local;
      const loserIsLocal = loser === local;
      // Both devices detect the same fork — don't mint a second copy if one with
      // this exact body already exists (arrived via the remote side, possibly in
      // a different shard, which is why the caller passes the FULL local corpus).
      const dupe = existing.some(n => n.conflictOf === remote.id && (n.body || '') === (loser.body || ''))
        || copies.some(n => n.conflictOf === remote.id && (n.body || '') === (loser.body || ''));
      if (!dupe) {
        const when = new Date(loser.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
        const ts = now();
        copies.push({
          ...loser,
          id: idgen(),
          title: `Conflicted copy of ${loser.title} (${loserIsLocal ? deviceName : 'another device'}, ${when})`,
          autoTitle: false,
          conflictOf: remote.id,
          createdAt: ts,
          updatedAt: ts,
        });
      }
    }
  }
  return { merged: [...map.values(), ...copies], conflicts: copies.length };
}

// FULL local ⋈ FULL remote → { merged (exportAll shape), conflicts }. Kept for
// the bootstrap (monolith) and duplicate-file heal paths that hold both sides
// whole. Sharded steady-state uses mergeShardData + mergeIndexData below.
export function mergeData(local, remote, opts = {}) {
  const notes = mergeNotes(local.notes || [], remote.notes || [], opts);
  return {
    merged: {
      notes: notes.merged,
      folders: mergeById(local.folders || [], remote.folders || []),
      tasks: mergeById(local.tasks || [], remote.tasks || [], 'id', TASK_FILL_FIELDS),
      tasklists: mergeById(local.tasklists || [], remote.tasklists || []),
      attachments: mergeById(local.attachments || [], remote.attachments || [], 'id', ATTACHMENT_FILL_FIELDS),
      annotations: mergeById(local.annotations || [], remote.annotations || [], 'key'),
      settings: mergeConfig(local.settings, remote.settings),
    },
    conflicts: notes.conflicts,
  };
}

// FULL local shard-collections ⋈ PARTIAL remote (only the downloaded buckets'
// records). Merging against the full local corpus is what keeps conflict-copy
// dedup correct; unchanged buckets are already fully local, so re-merging them
// would be a no-op and is simply omitted from remotePartial. Returns merged
// FULL arrays (local is full) so the orchestrator can diff for a delta.
export function mergeShardData(localFull, remotePartial, opts = {}) {
  const notes = mergeNotes(localFull.notes || [], remotePartial.notes || [], opts);
  return {
    merged: {
      notes: notes.merged,
      tasks: mergeById(localFull.tasks || [], remotePartial.tasks || [], 'id', TASK_FILL_FIELDS),
      attachments: mergeById(localFull.attachments || [], remotePartial.attachments || [], 'id', ATTACHMENT_FILL_FIELDS),
      annotations: mergeById(localFull.annotations || [], remotePartial.annotations || [], 'key'),
    },
    conflicts: notes.conflicts,
  };
}

// index.json collections (folders, tasklists, settings).
export function mergeIndexData(localIndex, remoteIndex) {
  const folders = mergeById(localIndex.folders || [], remoteIndex.folders || []);
  const tasklists = mergeById(localIndex.tasklists || [], remoteIndex.tasklists || []);
  const settings = mergeConfig(localIndex.settings, remoteIndex.settings);
  const changed = recordsChanged(localIndex.folders, folders)
    || recordsChanged(localIndex.tasklists, tasklists)
    || configChanged(localIndex.settings, settings);
  return { merged: { folders, tasklists, settings }, changed };
}

// ── Delta (what actually changed vs local) — so local import is O(changed) ──

function changedRecords(localArr, mergedArr, keyField) {
  const map = new Map((localArr || []).map(r => [r[keyField], r]));
  const out = [];
  for (const rec of mergedArr || []) {
    const cur = map.get(rec[keyField]);
    if (cur === rec) continue;
    if (!cur || canonicalJSON(cur) !== canonicalJSON(rec)) out.push(rec);
  }
  return out;
}

// localFull vs mergedFull (both exportAll shape) → only the records/keys that
// changed, in importAll's additive shape. New records (conflict copies, remote
// arrivals) and updated ones are included; untouched records are omitted.
export function computeDelta(localFull, mergedFull) {
  const delta = {};
  const keyed = { ...SHARD_ARRAYS, ...INDEX_ARRAYS };
  for (const [coll, keyField] of Object.entries(keyed)) {
    const changed = changedRecords(localFull[coll], mergedFull[coll], keyField);
    if (changed.length) delta[coll] = changed;
  }
  if (configChanged(localFull.settings, mergedFull.settings)) delta.settings = mergedFull.settings;
  return delta;
}

export function isEmptyDelta(delta) {
  return !delta || Object.keys(delta).length === 0;
}
