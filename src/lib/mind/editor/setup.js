// mind editor assembly — EditorView factory with input rules, keymap,
// history, placeholder, and paste/drop file capture.

import { EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { history, undo, redo } from 'prosemirror-history';
import {
  baseKeymap, chainCommands, toggleMark, exitCode,
  newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock,
} from 'prosemirror-commands';
import { splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import {
  inputRules, wrappingInputRule, textblockTypeInputRule,
  smartQuotes, emDash, ellipsis, InputRule,
} from 'prosemirror-inputrules';
import { dropCursor } from 'prosemirror-dropcursor';
import { gapCursor } from 'prosemirror-gapcursor';
import { schema } from './schema.js';
import { parseMarkdown, serializeMarkdown } from './markdown.js';
import { TaskItemView, ImageView } from './nodeviews.js';

function buildInputRules() {
  const rules = [...smartQuotes, ellipsis, emDash];
  rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote));
  rules.push(wrappingInputRule(
    /^(\d+)\.\s$/, schema.nodes.ordered_list,
    (match) => ({ order: +match[1] }),
    (match, node) => node.childCount + node.attrs.order === +match[1],
  ));
  rules.push(wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list));
  rules.push(textblockTypeInputRule(/^```$/, schema.nodes.code_block));
  rules.push(textblockTypeInputRule(
    new RegExp('^(#{1,6})\\s$'), schema.nodes.heading,
    (match) => ({ level: match[1].length }),
  ));
  // "[] " / "[x] " → task item. Inside a list_item it converts the item;
  // in a bare paragraph it wraps into bullet_list > task_item. Typing
  // "- [ ] " therefore works too: "- " wraps to a list first, then this.
  rules.push(new InputRule(/^\[([ xX])?\]\s$/, (state, match, start, end) => {
    const checked = (match[1] || ' ').toLowerCase() === 'x';
    const $from = state.selection.$from;
    if ($from.parent.type !== schema.nodes.paragraph) return null;
    const tr = state.tr.delete(start, end);
    const parent = $from.node(-1);
    if (parent.type === schema.nodes.list_item) {
      tr.setNodeMarkup($from.before(-1), schema.nodes.task_item, { checked, taskId: '' });
      return tr;
    }
    if (parent.type === schema.nodes.task_item) return null;
    const range = tr.selection.$from.blockRange();
    if (!range) return null;
    try {
      tr.wrap(range, [
        { type: schema.nodes.bullet_list },
        { type: schema.nodes.task_item, attrs: { checked, taskId: '' } },
      ]);
    } catch { return null; }
    return tr;
  }));
  return inputRules({ rules });
}

// Enter in a task item: split it, and reset the new item to an unchecked,
// id-less task (splitListItem copies attrs — a fresh task must not inherit
// the previous one's identity or done state).
function splitTaskItem(state, dispatch) {
  return splitListItem(schema.nodes.task_item)(state, dispatch && ((tr) => {
    const { $from } = tr.selection;
    const item = $from.node(-1);
    if (item?.type === schema.nodes.task_item && (item.attrs.checked || item.attrs.taskId)) {
      tr.setNodeMarkup($from.before(-1), null, { checked: false, taskId: '' });
    }
    dispatch(tr);
  }));
}

function buildKeymap() {
  const mod = {
    'Mod-z': undo,
    'Shift-Mod-z': redo,
    'Mod-y': redo,
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-`': toggleMark(schema.marks.code),
    'Mod-Shift-x': toggleMark(schema.marks.strikethrough),
    // List splits first, then the stock Enter chain (the spread of mod over
    // baseKeymap replaces its Enter binding, so re-chain it here).
    Enter: chainCommands(
      splitTaskItem,
      splitListItem(schema.nodes.list_item),
      newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock,
    ),
    'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
      if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
      return true;
    }),
    Tab: chainCommands(
      sinkListItem(schema.nodes.task_item),
      sinkListItem(schema.nodes.list_item),
      () => true, // swallow Tab so focus never escapes the editor
    ),
    'Shift-Tab': chainCommands(
      liftListItem(schema.nodes.task_item),
      liftListItem(schema.nodes.list_item),
      () => true,
    ),
  };
  return keymap({ ...baseKeymap, ...mod });
}

const placeholderKey = new PluginKey('mn-placeholder');

function placeholderPlugin(text) {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        const { doc } = state;
        const empty = doc.childCount === 1
          && doc.firstChild.isTextblock
          && doc.firstChild.content.size === 0;
        if (!empty) return null;
        const deco = Decoration.node(0, doc.firstChild.nodeSize, {
          class: 'mn-editor-placeholder',
          'data-placeholder': text,
        });
        return DecorationSet.create(doc, [deco]);
      },
    },
  });
}

function fileCapturePlugin(onFiles) {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = [...(event.clipboardData?.files || [])];
        if (!files.length) return false;
        event.preventDefault();
        onFiles(files, view);
        return true;
      },
      handleDrop(view, event) {
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length) return false;
        event.preventDefault();
        onFiles(files, view);
        return true;
      },
    },
  });
}

// Create an editor bound to `mount`. Returns { view, getMarkdown, insertImage,
// insertText, destroy }. `onChange` fires on every doc change (caller
// debounces the actual save); `onFiles(files, view)` receives pasted/dropped
// files so the view layer can create attachments and insert image nodes.
export function createEditor(mount, { markdown = '', onChange, onFiles, placeholder = 'write…' } = {}) {
  const state = EditorState.create({
    doc: parseMarkdown(markdown),
    plugins: [
      buildInputRules(),
      buildKeymap(),
      history(),
      dropCursor(),
      gapCursor(),
      placeholderPlugin(placeholder),
      fileCapturePlugin((files, view) => onFiles?.(files, view)),
    ],
  });

  const view = new EditorView(mount, {
    state,
    nodeViews: {
      task_item: (node, v, getPos) => new TaskItemView(node, v, getPos),
      image: (node) => new ImageView(node),
    },
    // Note links (#note/<id>) navigate on plain click; external links need
    // Ctrl/Cmd-click so ordinary editing around them stays possible.
    handleClick(v, pos, event) {
      const link = v.state.doc.resolve(pos).marks()
        .find(m => m.type === schema.marks.link);
      if (!link) return false;
      const href = link.attrs.href || '';
      if (href.startsWith('#note/')) { location.hash = href; return true; }
      if (event.ctrlKey || event.metaKey) { window.open(href, '_blank', 'noopener'); return true; }
      return false;
    },
    dispatchTransaction(tr) {
      const newState = view.state.apply(tr);
      view.updateState(newState);
      if (tr.docChanged) onChange?.();
    },
  });

  return {
    view,
    getMarkdown: () => serializeMarkdown(view.state.doc),
    insertImage(attachmentId, alt = '') {
      const node = schema.nodes.image.create({ src: `mn-attach://${attachmentId}`, alt });
      const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
      view.dispatch(tr);
    },
    insertText(text) {
      const tr = view.state.tr.insertText(text).scrollIntoView();
      view.dispatch(tr);
    },
    insertLink(label, href) {
      const node = schema.text(label, [schema.marks.link.create({ href })]);
      view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
