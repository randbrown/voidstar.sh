// Local reminder scheduler + UI (Phase A — client-only, no backend).
//
// Fires task reminders while the app is open or the installed PWA is running:
//   - TIME reminders (`remindAt` / `snoozedUntil`) — a 60s scan loop, mirroring
//     the housekeeping/`rollOffCompletedTasks` cadence in app.js.
//   - PLACE reminders (`remindPlace`) — a foreground `geolocation.watchPosition`
//     geofence, active only while a place-reminder exists (battery).
// The reminder itself is just synced fields on the task (store.js), so it rides
// Drive sync for free; this module is only the alarm clock + the setter UI.
//
// LIMITATIONS (documented, by design in Phase A):
//   - Nothing fires when the app is fully closed (no server / Web Push yet — see
//     the Phase B roadmap). Time reminders fire on the next open/scan; place
//     reminders need the app open.
//   - Two devices open at once can both fire the same reminder once. The
//     synced `remindStatus:'notified'` and a per-device fired-set keep it to at
//     most one per device; a taskId-keyed push DO (Phase B) removes it entirely.
//   - iOS: notifications require an INSTALLED PWA (iOS 16.4+); no background
//     geolocation. We degrade gracefully — the reminder is still stored/synced.

import * as store from './store.js';
import { el, esc, btn } from './ui.js';

const FIRED_KEY = 'voidstar.mind.reminders.fired';
const SCAN_MS = 60_000;
const DEFAULT_RADIUS_M = 150;
const SNOOZE_MS = 10 * 60_000;

let _started = false;
let _onChange = () => {};
let _geoWatchId = null;

// ── capability + permission ───────────────────────────────────────────────

export function notifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

// Must be called from inside a user gesture (setting/arming a reminder).
export async function ensureNotifyPermission() {
  if (!notifySupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; }
  catch { return false; }
}

async function swRegistration() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try { return (await navigator.serviceWorker.getRegistration()) || null; }
  catch { return null; }
}

// ── firing ────────────────────────────────────────────────────────────────

function firedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(FIRED_KEY) || '[]')); }
  catch { return new Set(); }
}
function rememberFired(id) {
  try {
    const s = firedSet(); s.add(id);
    // Cap so the list can't grow unbounded on a long-lived device.
    localStorage.setItem(FIRED_KEY, JSON.stringify([...s].slice(-500)));
  } catch {}
}

async function fireNotification(task) {
  const title = task.text || 'Reminder';
  const body = task.remindPlace?.label
    ? `you're near ${task.remindPlace.label}`
    : 'reminder';
  const opts = {
    body,
    tag: `mind-task-${task.id}`,
    data: { taskId: task.id, listId: task.listId, url: `/lab/mind#task/${task.id}` },
    actions: [
      { action: 'done', title: 'Done' },
      { action: 'snooze', title: 'Snooze 10m' },
    ],
  };
  const reg = await swRegistration();
  try {
    if (reg && reg.showNotification) { await reg.showNotification(title, opts); return; }
  } catch { /* fall through to the constructor path */ }
  try { new Notification(title, { body, tag: opts.tag, data: opts.data }); } catch {}
}

// ── the scan loop ─────────────────────────────────────────────────────────

async function scan() {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  const now = Date.now();
  const tasks = await store.getAllTasks(); // live() already drops tombstones
  const fired = firedSet();
  let changed = false;
  let wantsGeo = false;

  for (const t of tasks) {
    if (t.done || t.archivedAt) continue;
    if (t.remindPlace) wantsGeo = true;

    if (t.remindStatus === 'notified') continue;
    const dueAt = t.snoozedUntil || t.remindAt;
    if (!dueAt || dueAt > now) continue;
    if (fired.has(t.id)) continue;

    await fireNotification(t);
    rememberFired(t.id);
    fired.add(t.id);
    await store.putTask({ ...t, remindStatus: 'notified' });
    changed = true;
  }

  syncGeoWatch(wantsGeo);
  if (changed) _onChange();
}

// ── foreground geofence ───────────────────────────────────────────────────

function haversineM(a, b) {
  const R = 6_371_000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function syncGeoWatch(wanted) {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return;
  if (wanted && _geoWatchId == null) {
    _geoWatchId = navigator.geolocation.watchPosition(
      (pos) => { checkGeofence(pos).catch(() => {}); },
      () => {},
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 60_000 },
    );
  } else if (!wanted && _geoWatchId != null) {
    try { navigator.geolocation.clearWatch(_geoWatchId); } catch {}
    _geoWatchId = null;
  }
}

async function checkGeofence(pos) {
  if (!notifySupported() || Notification.permission !== 'granted') return;
  const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  const tasks = await store.getAllTasks();
  const fired = firedSet();
  let changed = false;
  for (const t of tasks) {
    if (t.done || t.archivedAt || t.remindStatus === 'notified') continue;
    const p = t.remindPlace;
    if (!p || fired.has(t.id)) continue;
    if (haversineM(here, p) <= (p.radius || DEFAULT_RADIUS_M)) {
      await fireNotification(t);
      rememberFired(t.id);
      fired.add(t.id);
      await store.putTask({ ...t, remindStatus: 'notified' });
      changed = true;
    }
  }
  if (changed) _onChange();
}

// ── service-worker notification actions (Done / Snooze) ───────────────────

function wireSwMessages() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', async (e) => {
    const msg = e.data;
    if (msg && msg.type === 'mind-navigate' && msg.url) {
      const hash = msg.url.slice(msg.url.indexOf('#'));
      if (hash) location.hash = hash;
      return;
    }
    if (!msg || msg.type !== 'mind-reminder-action') return;
    const task = await store.getTask(msg.taskId);
    if (!task || task.deletedAt) return;
    if (msg.action === 'done') {
      const { setTaskDoneEverywhere } = await import('./tasks-sync.js');
      await setTaskDoneEverywhere(task, true);
    } else if (msg.action === 'snooze') {
      await store.putTask({ ...task, snoozedUntil: Date.now() + SNOOZE_MS, remindStatus: 'snoozed' });
      dropFired(task.id);
    }
    _onChange();
  });
}

function dropFired(id) {
  try {
    const s = firedSet(); s.delete(id);
    localStorage.setItem(FIRED_KEY, JSON.stringify([...s]));
  } catch {}
}

// ── public: scheduler lifecycle + arm ─────────────────────────────────────

export function initReminderScheduler(onChange) {
  if (_started) return;
  _started = true;
  if (typeof onChange === 'function') _onChange = onChange;
  wireSwMessages();
  scan().catch(() => {});
  setInterval(() => scan().catch(() => {}), SCAN_MS);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scan().catch(() => {});
    });
  }
}

// Called when a reminder is set/created within a user gesture: ensures
// permission, clears any stale fired-flag, and nudges the scan.
export async function armReminder(task) {
  dropFired(task.id);
  await ensureNotifyPermission();
  scan().catch(() => {});
}

// ── public: UI helpers (badge + setter sheet) ─────────────────────────────

function fmtWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${day} ${time}`;
}

// Returns a small badge element for a task's reminder, or null if none.
// True when a task's time reminder is due/overdue and not yet handled — the
// state a quick "snooze" acts on.
export function isReminderDue(task) {
  return !!task.remindAt && !task.done && task.remindStatus !== 'snoozed'
    && task.remindAt <= Date.now();
}

// Defer a task's time reminder by `ms` (default 10 min). Re-arms it: the scan
// loop treats `snoozedUntil` as the new due time and clears the fired mark, so
// it fires again. Rides sync like any task field.
export async function snoozeTask(task, ms = SNOOZE_MS) {
  const until = Date.now() + ms;
  await store.putTask({ ...task, snoozedUntil: until, remindAt: until, remindStatus: 'snoozed' });
  // Drop any local "already fired" mark so the re-armed reminder can fire.
  try {
    const fired = JSON.parse(localStorage.getItem(FIRED_KEY) || '[]').filter(id => id !== task.id);
    localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
  } catch {}
}

export function reminderBadge(task) {
  if (task.remindPlace) {
    return el('span', 'mn-remind-badge', `&#128205; ${esc(task.remindPlace.label || 'place')}`);
  }
  if (task.remindAt) {
    const overdue = !task.done && task.remindStatus !== 'notified' && task.remindAt <= Date.now();
    const b = el('span', `mn-remind-badge ${overdue ? 'mn-remind-overdue' : ''}`,
      `&#9200; ${esc(fmtWhen(task.remindAt))}`);
    return b;
  }
  return null;
}

function toLocalInputValue(ts) {
  const d = new Date(ts || Date.now() + 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Modal to set/clear a task's time or place reminder. `onDone` refreshes the view.
export function reminderSheet(task, onDone = () => {}) {
  const overlay = el('div', 'mn-modal-overlay');
  const box = el('div', 'mn-modal');
  box.appendChild(el('div', 'mn-modal-title', 'reminder'));

  // Time
  box.appendChild(el('label', 'mn-remind-label', 'remind me at a time'));
  const dt = el('input', 'mn-input');
  dt.type = 'datetime-local';
  if (task.remindAt) dt.value = toLocalInputValue(task.remindAt);
  box.appendChild(dt);

  // Place
  box.appendChild(el('label', 'mn-remind-label', 'or at a place (fires only while mind is open)'));
  const placeRow = el('div', 'mn-remind-placerow');
  const placeLabel = el('input', 'mn-input');
  placeLabel.type = 'text';
  placeLabel.placeholder = 'place name (e.g. work)';
  if (task.remindPlace?.label) placeLabel.value = task.remindPlace.label;
  const useHere = btn('use my location', 'mn-btn-ghost');
  let coords = task.remindPlace ? { lat: task.remindPlace.lat, lng: task.remindPlace.lng } : null;
  const coordNote = el('div', 'mn-dim', coords ? '&#10003; location set' : '');
  useHere.addEventListener('click', () => {
    if (!navigator.geolocation) { coordNote.textContent = 'geolocation unavailable'; return; }
    coordNote.textContent = 'locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => { coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; coordNote.innerHTML = '&#10003; location set'; },
      () => { coordNote.textContent = 'could not get location'; },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  });
  placeRow.appendChild(placeLabel);
  placeRow.appendChild(useHere);
  box.appendChild(placeRow);
  box.appendChild(coordNote);

  box.appendChild(el('div', 'mn-remind-help',
    'Reminders fire while mind is open or installed. For arrive-triggers when the app is closed, use an OS automation (Android Tasker / iOS Shortcuts) — see docs.'));

  const row = el('div', 'mn-modal-row');
  const clear = btn('clear', 'mn-btn-ghost', async () => {
    overlay.remove();
    store.markCleared(task, 'remindAt');
    store.markCleared(task, 'remindPlace');
    await store.putTask({ ...task, remindAt: 0, remindPlace: null, remindStatus: '', snoozedUntil: 0 });
    dropFired(task.id);
    onDone();
  });
  const cancel = btn('cancel', '', () => overlay.remove());
  const save = btn('save', 'mn-btn-primary', async () => {
    overlay.remove();
    const remindAt = dt.value ? new Date(dt.value).getTime() : 0;
    const remindPlace = (coords && placeLabel.value.trim())
      ? { lat: coords.lat, lng: coords.lng, radius: DEFAULT_RADIUS_M, label: placeLabel.value.trim() }
      : null;
    if (!remindAt && !remindPlace) {
      // Nothing set → treat as clear.
      store.markCleared(task, 'remindAt');
      store.markCleared(task, 'remindPlace');
      await store.putTask({ ...task, remindAt: 0, remindPlace: null, remindStatus: '', snoozedUntil: 0 });
      dropFired(task.id);
      onDone();
      return;
    }
    await ensureNotifyPermission();
    await store.putTask({ ...task, remindAt, remindPlace, remindStatus: 'scheduled', snoozedUntil: 0 });
    await armReminder({ ...task, remindAt, remindPlace });
    onDone();
  });
  row.appendChild(clear);
  row.appendChild(cancel);
  row.appendChild(save);
  box.appendChild(row);

  overlay.appendChild(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}
