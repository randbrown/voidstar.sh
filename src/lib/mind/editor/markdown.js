// Markdown <-> ProseMirror doc conversion for mind notes.
//
// Task items round-trip as GFM-style checkboxes with a hidden id marker:
//     - [x] buy milk <!--t:ab12cd-->
// markdown-it (html:false) has no checkbox syntax, so parsing is two-stage:
// parse as ordinary lists, then a doc-level walk converts any list_item whose
// text starts with "[ ] " / "[x] " into a task_item, stripping the prefix and
// trailing marker into attrs. Serialization writes them back. This avoids
// markdown-it token surgery entirely.

import MarkdownIt from 'markdown-it';
import { Fragment } from 'prosemirror-model';
import {
  MarkdownParser, MarkdownSerializer,
  defaultMarkdownParser, defaultMarkdownSerializer,
} from 'prosemirror-markdown';
import { schema } from './schema.js';

// html:false — raw HTML in notes stays literal text (safe), which is also
// what lets the <!--t:id--> marker survive as text we can lift into an attr.
const md = MarkdownIt('commonmark', { html: false, linkify: true });
md.enable(['strikethrough', 'linkify'], true);

const parserTokens = {
  ...defaultMarkdownParser.tokens,
  s: { mark: 'strikethrough' },
};

const rawParser = new MarkdownParser(schema, md, parserTokens);

const CHECKBOX_RE = /^\[([ xX])\]\s+/;
const MARKER_RE = /\s*<!--t:([A-Za-z0-9_-]+)-->\s*$/;

// Rebuild the parsed tree, converting checkbox-prefixed list_items into
// task_items (bottom-up so nested lists convert too).
function rebuild(node) {
  if (node.isText) return node;
  const children = [];
  node.forEach((child) => children.push(rebuild(child)));

  if (node.type === schema.nodes.list_item && children.length) {
    const converted = tryConvertListItem(children);
    if (converted) return converted;
  }
  return node.copy(Fragment.from(children));
}

function tryConvertListItem(children) {
  const first = children[0];
  if (!first || first.type !== schema.nodes.paragraph) return null;
  const firstText = first.firstChild;
  if (!firstText?.isText) return null;
  const m = CHECKBOX_RE.exec(firstText.text);
  if (!m) return null;

  const checked = m[1].toLowerCase() === 'x';
  let taskId = '';
  let paraChildren = [];
  first.forEach((c) => paraChildren.push(c));
  const stripped = firstText.text.slice(m[0].length);
  paraChildren[0] = stripped ? schema.text(stripped, firstText.marks) : null;
  paraChildren = paraChildren.filter(Boolean);

  const last = paraChildren[paraChildren.length - 1];
  if (last?.isText) {
    const mm = MARKER_RE.exec(last.text);
    if (mm) {
      taskId = mm[1];
      const rest = last.text.slice(0, mm.index);
      if (rest) paraChildren[paraChildren.length - 1] = schema.text(rest, last.marks);
      else paraChildren.pop();
    }
  }
  const para = schema.nodes.paragraph.create(first.attrs, paraChildren);
  return schema.nodes.task_item.create({ checked, taskId }, [para, ...children.slice(1)]);
}

export function parseMarkdown(text) {
  return rebuild(rawParser.parse(text || ''));
}

export const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    task_item(state, node) {
      state.write(`[${node.attrs.checked ? 'x' : ' '}] `);
      node.forEach((child, _, i) => {
        if (i === 0 && child.type === schema.nodes.paragraph) {
          state.renderInline(child);
          if (node.attrs.taskId) state.write(` <!--t:${node.attrs.taskId}-->`);
          state.closeBlock(child);
        } else {
          state.render(child, node, i);
        }
      });
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strikethrough: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  },
);

export function serializeMarkdown(doc) {
  return serializer.serialize(doc, { tightLists: true });
}

// First non-empty text line of a markdown body — the rename-prefill default.
export function firstLine(markdown) {
  for (const raw of (markdown || '').split('\n')) {
    const line = raw
      .replace(/<!--t:[A-Za-z0-9_-]+-->/g, '')
      .replace(/^[#>\-*+\s]+/, '')
      .replace(/^\[([ xX])\]\s*/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`]/g, '')
      .trim();
    if (line) return line.slice(0, 120);
  }
  return '';
}

// Plain text for search indexing / list snippets.
export function markdownToText(markdown) {
  return (markdown || '')
    .replace(/<!--t:[A-Za-z0-9_-]+-->/g, '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ''))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\s]*/gm, '')
    .replace(/^[-*+]\s+\[([ xX])\]\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!~<>])/g, '$1') // serializer escapes read as noise in snippets
    .trim();
}
