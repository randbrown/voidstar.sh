// Evernote .enex import — PURE parsing (no DOM, no IndexedDB), so it runs under
// plain node and is covered by scripts/check-mind-enex.mjs. The browser commit
// path (enex-import.js) turns the parsed result into notes/attachments.
//
// An .enex file is XML: <en-export> with many <note>, each carrying <title>,
// <created>/<updated> (Evernote stamps), <tag>×N, a <content> CDATA holding an
// <en-note> ENML (XHTML-subset) body, and <resource>×N (base64 binaries). Inline
// <en-media hash=… type=…> in the ENML references a resource by the MD5 of its
// bytes — so we compute each resource's MD5 to map media → attachment.
//
// The ENML→markdown conversion is deliberately pragmatic: it captures text,
// headings, lists, basic inline formatting, links, checkboxes (en-todo) and
// images (en-media), and degrades unknown markup to its text. Perfect HTML
// fidelity is a non-goal; losing note text is the thing to avoid.

// ── Minimal XML parser (lenient; for machine-generated ENEX/ENML) ──

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
// Tags that never have children (self-closing in XHTML, or HTML voids).
const VOID_TAGS = new Set(['br', 'hr', 'img', 'en-media', 'en-crypt', 'meta', 'input', 'area', 'base', 'col', 'embed', 'link', 'param', 'source', 'track', 'wbr']);

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : m;
    }
    const hit = ENTITIES[e] ?? ENTITIES[e.toLowerCase()];
    return hit != null ? hit : m;
  });
}

function safeFromCodePoint(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function parseTag(s) {
  const sp = s.search(/\s/);
  if (sp === -1) return { name: s.toLowerCase(), attrs: {} };
  const name = s.slice(0, sp).toLowerCase();
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g;
  const attrStr = s.slice(sp);
  let m;
  while ((m = re.exec(attrStr))) {
    const k = (m[1] || m[3]).toLowerCase();
    attrs[k] = decodeEntities(m[2] != null ? m[2] : m[4]);
  }
  return { name, attrs };
}

// str → tree: { tag, attrs, children:[ {tag,attrs,children} | {text} ] }.
export function parseXml(str) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (t) => { if (t) top().children.push({ text: t }); };
  const n = str.length;
  let i = 0;
  while (i < n) {
    const lt = str.indexOf('<', i);
    if (lt === -1) { pushText(decodeEntities(str.slice(i))); break; }
    if (lt > i) pushText(decodeEntities(str.slice(i, lt)));

    if (str.startsWith('<!--', lt)) { const e = str.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (str.startsWith('<![CDATA[', lt)) {
      const e = str.indexOf(']]>', lt + 9);
      top().children.push({ text: str.slice(lt + 9, e === -1 ? n : e), cdata: true });
      i = e === -1 ? n : e + 3; continue;
    }
    if (str.startsWith('<!', lt) || str.startsWith('<?', lt)) { const e = str.indexOf('>', lt); i = e === -1 ? n : e + 1; continue; }

    const gt = str.indexOf('>', lt);
    if (gt === -1) { pushText(decodeEntities(str.slice(lt))); break; }
    let content = str.slice(lt + 1, gt).trim();

    if (content[0] === '/') {
      const name = content.slice(1).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) { if (stack[s].tag === name) { stack.length = s; break; } }
      i = gt + 1; continue;
    }
    const selfClose = content.endsWith('/');
    if (selfClose) content = content.slice(0, -1).trim();
    const { name, attrs } = parseTag(content);
    const el = { tag: name, attrs, children: [] };
    top().children.push(el);
    if (!selfClose && !VOID_TAGS.has(name)) stack.push(el);
    i = gt + 1;
  }
  return root;
}

// First element with the given tag (depth-first).
function findEl(node, tag) {
  if (node.tag === tag) return node;
  for (const c of node.children || []) {
    if (c.text != null) continue;
    const hit = findEl(c, tag);
    if (hit) return hit;
  }
  return null;
}
function childrenNamed(node, tag) {
  return (node.children || []).filter(c => c.tag === tag);
}
function textOf(node) {
  if (!node) return '';
  if (node.text != null) return node.text;
  return (node.children || []).map(textOf).join('');
}

// ── Evernote timestamps + tags ──

// "20150131T142530Z" (or with offset) → epoch ms. Falls back to Date.parse.
export function parseEvernoteTime(s) {
  const t = String(s || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(t);
  if (m) {
    const [, y, mo, d, h, mi, se, z] = m;
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
    return z ? ms : ms; // treat naive as UTC (Evernote exports Z)
  }
  const p = Date.parse(t);
  return Number.isNaN(p) ? 0 : p;
}

export function normalizeTag(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/^#+/, '');
}

// ── base64 + MD5 (to match <en-media hash> to a resource's bytes) ──

export function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// RFC 1321 MD5 over bytes → lowercase hex. Compact, dependency-free.
export function md5Hex(bytes) {
  const rol = (x, c) => (x << c) | (x >>> (32 - c));
  const add = (a, b) => (a + b) | 0;
  const K = [];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  const len = bytes.length;
  const withPad = ((len + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(withPad);
  buf.set(bytes);
  buf[len] = 0x80;
  const bitLen = len * 8;
  // little-endian 64-bit length (low 32 bits suffice for our sizes, but write both)
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad - 8, bitLen >>> 0, true);
  dv.setUint32(withPad - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < withPad; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D; D = C; C = B; B = add(B, rol(F, S[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  const hex = (x) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((x >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

// ── ENML → markdown ──

const HEADING = { h1: '#', h2: '##', h3: '###', h4: '####', h5: '#####', h6: '######' };
const BLOCK = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'pre', 'table', 'thead', 'tbody', 'tr', 'center', 'section', 'article']);

// Escape markdown-significant chars in plain text runs (light touch — enough to
// keep a literal * or _ from being read as emphasis on re-parse).
function escapeInline(t) {
  return t.replace(/[\\`*_[\]<>]/g, '\\$&');
}

function renderInline(node, ctx) {
  if (node.text != null) return node.cdata ? node.text : escapeInline(node.text);
  const inner = (node.children || []).map(c => renderInline(c, ctx)).join('');
  switch (node.tag) {
    case 'br': return '\n';
    case 'b': case 'strong': return inner.trim() ? `**${inner}**` : inner;
    case 'i': case 'em': return inner.trim() ? `*${inner}*` : inner;
    case 's': case 'strike': case 'del': return inner.trim() ? `~~${inner}~~` : inner;
    case 'code': case 'tt': return inner.trim() ? `\`${inner.replace(/`/g, '')}\`` : inner;
    case 'a': { const href = node.attrs?.href || ''; return href ? `[${inner || href}](${href})` : inner; }
    case 'en-media': return ctx.resolveMedia(node.attrs || {});
    case 'en-todo': return ''; // consumed at block level
    default: return inner; // span, font, u, sup, sub, … → keep text
  }
}

// Is a child an en-todo (possibly wrapped in a span)?
function leadingTodo(node) {
  for (const c of node.children || []) {
    if (c.text != null) { if (c.text.trim()) return null; continue; }
    if (c.tag === 'en-todo') return c;
    return null;
  }
  return null;
}

function renderList(node, out, ctx, ordered, depth) {
  let idx = 1;
  for (const li of childrenNamed(node, 'li')) {
    const bullet = ordered ? `${idx++}.` : '-';
    const sub = [];
    renderMixed(li, sub, ctx, depth + 1);
    const lines = sub.join('\n').split('\n');
    const indent = '  '.repeat(depth);
    let first = true;
    for (const line of lines) {
      if (!line.trim() && first) continue;
      out.push(first ? `${indent}${bullet} ${line}` : `${indent}  ${line}`);
      first = false;
    }
    if (first) out.push(`${indent}${bullet} `); // empty item
  }
}

function renderBlock(node, out, ctx, depth) {
  const tag = node.tag;
  if (tag === 'hr') { out.push('', '---', ''); return; }
  if (HEADING[tag]) { out.push('', `${HEADING[tag]} ${collectInline(node, ctx).trim()}`, ''); return; }
  if (tag === 'ul' || tag === 'ol') { renderList(node, out, ctx, tag === 'ol', depth); return; }
  if (tag === 'blockquote') {
    const sub = [];
    renderMixed(node, sub, ctx, depth);
    for (const line of sub.join('\n').split('\n')) out.push(`> ${line}`.trimEnd());
    out.push('');
    return;
  }
  if (tag === 'pre') { out.push('', '```', textOf(node).replace(/\s+$/, ''), '```', ''); return; }
  renderMixed(node, out, ctx, depth);
}

function collectInline(node, ctx) {
  return (node.children || []).map(c => renderInline(c, ctx)).join('');
}

// A node whose children mix inline runs and nested blocks: accumulate inline
// into a line, flush on block boundaries, recurse into blocks. A leading
// en-todo turns the line into a "- [ ]" checkbox.
function renderMixed(node, out, ctx, depth) {
  let line = '';
  const flush = () => { for (const p of line.split('\n')) out.push(p); line = ''; };
  const todo = leadingTodo(node);
  if (todo) line = `- [${todo.attrs?.checked === 'true' ? 'x' : ' '}] `;

  for (const c of node.children || []) {
    if (c === todo) continue;
    if (c.tag && BLOCK.has(c.tag)) {
      if (line !== '') flush();
      renderBlock(c, out, ctx, depth);
    } else {
      line += renderInline(c, ctx);
    }
  }
  if (line !== '') flush();
}

// ENML string (or a parsed <en-note> node) → markdown. resolveMedia({hash,type,…})
// returns the inline replacement for an <en-media> (image → markdown image with
// a placeholder src; other kinds → '' so they attach as chips).
export function enmlToMarkdown(enml, resolveMedia) {
  const root = typeof enml === 'string' ? parseXml(enml) : enml;
  const enNote = findEl(root, 'en-note') || root;
  const out = [];
  renderMixed(enNote, out, { resolveMedia }, 0);
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

// The default resolver used by parseEnex: image media become an inline image
// whose src is a "mn-attach://ENEXHASH:<md5>" sentinel that the commit path
// rewrites to the real attachment id; other media resolve to nothing (they end
// up as chip attachments on the note).
export const MEDIA_SENTINEL_PREFIX = 'ENEXHASH:';
export function defaultMediaResolver(attrs) {
  const type = attrs.type || '';
  const hash = attrs.hash || '';
  if (type.startsWith('image/') && hash) return `![](mn-attach://${MEDIA_SENTINEL_PREFIX}${hash})`;
  return '';
}

// ── Whole-file parse ──

function kindOfMime(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

function parseResource(res) {
  const dataNode = findEl(res, 'data');
  const b64 = dataNode ? textOf(dataNode) : '';
  let bytes;
  try { bytes = base64ToBytes(b64); } catch { bytes = new Uint8Array(0); }
  const mime = textOf(findEl(res, 'mime')).trim();
  const fileName = textOf(findEl(res, 'file-name')).trim();
  return {
    hash: bytes.length ? md5Hex(bytes) : '',
    mime,
    kind: kindOfMime(mime),
    fileName,
    bytes, // Uint8Array — the commit path wraps this in a Blob
  };
}

/**
 * Parse an .enex file into notes. PURE (no DOM/IDB).
 * @returns {{ notes: Array<{
 *   title, createdAt, updatedAt, tags:string[], body:string,
 *   resources: Array<{hash,mime,kind,fileName,bytes}> }>, warnings: string[] }}
 */
export function parseEnex(xml, opts = {}) {
  const now = opts.now || Date.now();
  const warnings = [];
  const root = parseXml(xml);
  const exportEl = findEl(root, 'en-export') || root;
  const noteEls = childrenNamed(exportEl, 'note').length
    ? childrenNamed(exportEl, 'note')
    : allDescendants(root, 'note');
  if (!noteEls.length) warnings.push('No <note> elements found — is this a valid .enex export?');

  const notes = noteEls.map((noteEl, i) => {
    const title = textOf(findEl(noteEl, 'title')).trim();
    const createdAt = parseEvernoteTime(textOf(findEl(noteEl, 'created'))) || (now - i * 1000);
    const updatedAt = parseEvernoteTime(textOf(findEl(noteEl, 'updated'))) || createdAt;
    const tags = [];
    for (const t of childrenNamed(noteEl, 'tag')) {
      const nt = normalizeTag(textOf(t));
      if (nt && !tags.includes(nt)) tags.push(nt);
    }
    const resources = childrenNamed(noteEl, 'resource').map(parseResource).filter(r => r.bytes.length);
    const contentNode = findEl(noteEl, 'content');
    const enml = contentNode ? textOf(contentNode) : '';
    const body = enmlToMarkdown(enml, defaultMediaResolver);
    return { title: title || '', createdAt, updatedAt, tags, body, resources };
  });

  return { notes, warnings };
}

function allDescendants(node, tag, acc = []) {
  for (const c of node.children || []) {
    if (c.text != null) continue;
    if (c.tag === tag) acc.push(c);
    else allDescendants(c, tag, acc);
  }
  return acc;
}
