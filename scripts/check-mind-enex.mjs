// Smoke tests for the pure Evernote .enex parser — no DOM/IndexedDB, so they
// run under plain node:  node scripts/check-mind-enex.mjs
//
// Covers: MD5 known-vectors, base64, entity decode, Evernote timestamps, tag
// normalization, XML parsing, ENML→markdown (headings/lists/formatting/links/
// en-todo/en-media), and a whole-file parse with a resource hash match.

import {
  md5Hex, base64ToBytes, decodeEntities, parseEvernoteTime, normalizeTag,
  parseXml, enmlToMarkdown, defaultMediaResolver, parseEnex, MEDIA_SENTINEL_PREFIX,
} from '../src/lib/mind/enex.js';

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n${title}`); }

const enc = (s) => new TextEncoder().encode(s);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// ── (a) MD5 known vectors ──
section('(a) md5Hex — RFC 1321 vectors');
{
  check('md5("")', md5Hex(enc('')) === 'd41d8cd98f00b204e9800998ecf8427e', md5Hex(enc('')));
  check('md5("abc")', md5Hex(enc('abc')) === '900150983cd24fb0d6963f7d28e17f72', md5Hex(enc('abc')));
  const fox = 'The quick brown fox jumps over the lazy dog';
  check('md5(fox)', md5Hex(enc(fox)) === '9e107d9d372bb6826bd81d3542a419d6', md5Hex(enc(fox)));
  // 56-byte input exercises the extra-block padding boundary.
  const big = 'a'.repeat(56);
  check('md5(56×a)', md5Hex(enc(big)) === '3b0c8ac703f828b04c6c197006d17218', md5Hex(enc(big)));
}

// ── (b) base64 + entities + timestamps + tags ──
section('(b) primitives');
{
  const bytes = enc('hello-image');
  check('base64 round-trips', md5Hex(base64ToBytes(b64(bytes))) === md5Hex(bytes));
  check('base64 tolerates newlines', base64ToBytes('aGVs\nbG8=').length === 5);
  check('entities: named', decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot;') === 'a & b <c> "d"');
  check('entities: numeric', decodeEntities('&#65;&#x42;C') === 'ABC');
  check('evernote time', parseEvernoteTime('20150131T142530Z') === Date.UTC(2015, 0, 31, 14, 25, 30));
  check('bad time → 0', parseEvernoteTime('not-a-date') === 0);
  check('tag normalize', normalizeTag('  My Project ') === 'my-project');
  check('tag strips #', normalizeTag('#Idea') === 'idea');
}

// ── (c) XML parser ──
section('(c) parseXml');
{
  const tree = parseXml('<root a="1"><child>hi</child><self x="2"/><![CDATA[<raw>&]]></root>');
  const root = tree.children[0];
  check('root tag+attr', root.tag === 'root' && root.attrs.a === '1');
  check('child text', root.children[0].tag === 'child' && root.children[0].children[0].text === 'hi');
  check('self-closing has no children', root.children[1].tag === 'self' && root.children[1].children.length === 0);
  check('cdata preserved raw', root.children[2].text === '<raw>&' && root.children[2].cdata === true);
}

// ── (d) ENML → markdown ──
section('(d) enmlToMarkdown');
{
  const enml = [
    '<en-note>',
    '<h1>Title</h1>',
    '<div>Some <b>bold</b> and <i>italic</i> and a <a href="https://x.io">link</a>.</div>',
    '<div><en-todo checked="true"/>done thing</div>',
    '<div><en-todo checked="false"/>todo thing</div>',
    '<ul><li>one</li><li>two</li></ul>',
    '<div><en-media hash="abc123" type="image/png"/></div>',
    '<div><br/></div>',
    '<div>tail</div>',
    '</en-note>',
  ].join('');
  const md = enmlToMarkdown(enml, defaultMediaResolver);
  check('heading', md.includes('# Title'));
  check('bold+italic+link', md.includes('**bold**') && md.includes('*italic*') && md.includes('[link](https://x.io)'));
  check('checked todo', md.includes('- [x] done thing'));
  check('unchecked todo', md.includes('- [ ] todo thing'));
  check('list items', md.includes('- one') && md.includes('- two'));
  check('image media → sentinel src', md.includes(`![](mn-attach://${MEDIA_SENTINEL_PREFIX}abc123)`), md);
  check('tail line kept', md.includes('tail'));
  check('non-image media resolves empty', defaultMediaResolver({ type: 'application/pdf', hash: 'z' }) === '');
}

// ── (e) whole-file parse + resource hash match ──
section('(e) parseEnex');
{
  const imgBytes = enc('PNGDATA-here');
  const imgHash = md5Hex(imgBytes);
  const enex = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<en-export>',
    '<note>',
    '<title>First &amp; Only</title>',
    '<created>20200102T030405Z</created>',
    '<updated>20200103T040506Z</updated>',
    '<tag>Work</tag><tag>Ideas</tag>',
    `<content><![CDATA[<en-note><div>body text</div><div><en-media hash="${imgHash}" type="image/png"/></div></en-note>]]></content>`,
    `<resource><data encoding="base64">${b64(imgBytes)}</data><mime>image/png</mime><resource-attributes><file-name>pic.png</file-name></resource-attributes></resource>`,
    '</note>',
    '<note><title>Second</title><created>20210101T000000Z</created><content><![CDATA[<en-note>just text</en-note>]]></content></note>',
    '</en-export>',
  ].join('');
  const { notes, warnings } = parseEnex(enex, { now: 1_700_000_000_000 });
  check('no warnings', warnings.length === 0, warnings.join('; '));
  check('two notes', notes.length === 2, String(notes.length));
  const n0 = notes[0];
  check('title decoded', n0.title === 'First & Only', n0.title);
  check('created parsed', n0.createdAt === Date.UTC(2020, 0, 2, 3, 4, 5));
  check('updated parsed', n0.updatedAt === Date.UTC(2020, 0, 3, 4, 5, 6));
  check('tags normalized', JSON.stringify(n0.tags) === JSON.stringify(['work', 'ideas']), JSON.stringify(n0.tags));
  check('one image resource', n0.resources.length === 1 && n0.resources[0].kind === 'image');
  check('resource hash = md5(bytes)', n0.resources[0].hash === imgHash);
  check('body has body text', n0.body.includes('body text'));
  check('body media sentinel matches resource', n0.body.includes(`mn-attach://${MEDIA_SENTINEL_PREFIX}${imgHash}`), n0.body);
  check('second note body', notes[1].body.includes('just text') && notes[1].resources.length === 0);
}

console.log(`\n${failed ? `FAILED ${failed} check(s)` : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
