// mind editor schema — prosemirror-markdown's schema extended with:
//   - task_item: a checkbox list item (lives inside bullet_list alongside
//     plain list_item). Carries a stable `taskId` attr that survives the
//     markdown round-trip as a trailing `<!--t:id-->` comment, so the same
//     task keeps its identity across devices (tasks-in-notes materialization).
//   - strikethrough mark (~~text~~).
// Every node here MUST stay representable in markdown — the markdown string
// on the note record is canonical, the editor is just a surface.

import { Schema } from 'prosemirror-model';
import { schema as mdSchema } from 'prosemirror-markdown';

const nodes = mdSchema.spec.nodes
  .update('bullet_list', {
    ...mdSchema.spec.nodes.get('bullet_list'),
    content: '(list_item | task_item)+',
  })
  .addToEnd('task_item', {
    attrs: { checked: { default: false }, taskId: { default: '' } },
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{
      tag: 'li[data-task]',
      getAttrs: (dom) => ({
        checked: dom.getAttribute('data-checked') === 'true',
        taskId: dom.getAttribute('data-task-id') || '',
      }),
    }],
    toDOM(node) {
      return ['li', {
        'data-task': 'true',
        'data-checked': String(node.attrs.checked),
        'data-task-id': node.attrs.taskId,
        class: `mn-task-item${node.attrs.checked ? ' mn-task-done' : ''}`,
      }, 0];
    },
  });

const marks = mdSchema.spec.marks
  .addToEnd('strikethrough', {
    parseDOM: [
      { tag: 's' }, { tag: 'del' },
      { style: 'text-decoration=line-through' },
    ],
    toDOM() { return ['s', 0]; },
  });

export const schema = new Schema({ nodes, marks });
