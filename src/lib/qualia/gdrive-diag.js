// Shared Google-Drive diagnostics: a normalized report shape, a text formatter,
// and a tiny framework-free panel — reused by the mind, setlist, and qualia
// settings so each app can answer "why isn't Drive working?" without
// duplicating UI. Each app's gdrive module builds the report (it knows its own
// localStorage keys and sync state); this module only reads/renders it.
//
// Report shape:
//   { app, generatedAt, sections: [ { title, rows: [ [key, value], … ] } ] }

// ms-timestamp → short relative string ("3m ago", "yesterday", "never").
export function relTime(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return 'in the future';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

// Read the { token, expiresAt } blob a gdrive module stores at `tokenKey`.
export function readTokenInfo(tokenKey) {
  try {
    const data = JSON.parse(localStorage.getItem(tokenKey));
    if (!data || !data.token) return { present: false };
    const secLeft = Math.round((data.expiresAt - Date.now()) / 1000);
    return { present: true, expired: secLeft <= 0, secLeft, expiresAt: data.expiresAt };
  } catch { return { present: false }; }
}

// Human summary of a token info blob for a diagnostics row.
export function tokenRow(tokenKey) {
  const info = readTokenInfo(tokenKey);
  if (!info.present) return 'none stored (will silently renew on next sync)';
  if (info.expired) return `expired ${relTime(info.expiresAt)} — silent renew on next sync`;
  return `valid, ~${Math.max(1, Math.floor(info.secLeft / 60))}m left`;
}

export function formatDiagText(report) {
  const lines = [`voidstar ${report.app} — Drive diagnostics`, report.generatedAt, ''];
  for (const s of report.sections || []) {
    lines.push(`[${s.title}]`);
    for (const [k, v] of s.rows) lines.push(`  ${k}: ${v}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

// Mount an interactive panel into `container`. `gather(live)` returns a report
// object; live=true means "also hit Drive" (a read-only peek). Framework-free
// (raw DOM + inline styles) so any of the three apps can host it unchanged;
// buttons carry class `mn-btn`/`sl-btn` so app CSS can style them if present.
export function mountDiagPanel(container, gather) {
  container.innerHTML = '';

  const pre = document.createElement('pre');
  Object.assign(pre.style, {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.72rem',
    lineHeight: '1.55', margin: '0.5rem 0', maxHeight: '20rem', overflow: 'auto',
    opacity: '0.92',
  });
  pre.textContent = 'gathering…';

  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' });

  const mkBtn = (label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.className = 'mn-btn sl-btn';
    Object.assign(b.style, { cursor: 'pointer', font: 'inherit', padding: '0.3rem 0.75rem' });
    return b;
  };

  const draw = async (live) => {
    pre.textContent = live ? 'testing Drive…' : 'gathering…';
    try {
      pre.textContent = formatDiagText(await gather(live));
    } catch (e) {
      pre.textContent = `diagnostics failed: ${e && e.message ? e.message : e}`;
    }
  };

  const runBtn = mkBtn('run live check');
  runBtn.addEventListener('click', () => draw(true));

  const copyBtn = mkBtn('copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      copyBtn.textContent = 'copied ✓';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1200);
    } catch { copyBtn.textContent = 'copy failed'; }
  });

  row.appendChild(runBtn);
  row.appendChild(copyBtn);
  container.appendChild(pre);
  container.appendChild(row);
  draw(false);
}
