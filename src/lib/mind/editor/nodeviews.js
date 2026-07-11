// NodeViews for the mind editor: interactive task checkboxes and
// IDB-backed images (mn-attach:// srcs resolve to blob object URLs).

import { getObjectUrl, registerMissingImage, unregisterMissingImage } from '../attachments.js';

export class TaskItemView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement('li');
    this.dom.className = 'mn-task-item';
    this.dom.setAttribute('data-task', 'true');

    this.checkbox = document.createElement('input');
    this.checkbox.type = 'checkbox';
    this.checkbox.className = 'mn-task-check';
    this.checkbox.contentEditable = 'false';
    // mousedown (not click) so toggling never moves the text selection first.
    this.checkbox.addEventListener('mousedown', (e) => e.preventDefault());
    this.checkbox.addEventListener('change', () => {
      const pos = this.getPos();
      if (pos == null) return;
      const { tr } = this.view.state;
      tr.setNodeMarkup(pos, null, { ...this.node.attrs, checked: this.checkbox.checked });
      this.view.dispatch(tr);
    });

    this.contentDOM = document.createElement('div');
    this.contentDOM.className = 'mn-task-body';

    this.dom.appendChild(this.checkbox);
    this.dom.appendChild(this.contentDOM);
    this.sync(node);
  }

  sync(node) {
    this.checkbox.checked = node.attrs.checked;
    this.dom.classList.toggle('mn-task-done', node.attrs.checked);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.sync(node);
    return true;
  }

  // Keep checkbox interaction out of ProseMirror's event handling.
  stopEvent(e) { return e.target === this.checkbox; }
  ignoreMutation(m) { return m.target === this.checkbox || m.target === this.dom; }
}

export class ImageView {
  constructor(node) {
    this.node = node;
    this.dom = document.createElement('img');
    this.dom.className = 'mn-editor-img';
    this.dom.alt = node.attrs.alt || '';
    this.dom.title = 'double-click to annotate';
    // Double-click (or double-tap) an inline image → annotation canvas.
    // Single click stays with ProseMirror for node selection.
    this.dom.addEventListener('dblclick', () => {
      const src = this.node.attrs.src || '';
      const m = /^mn-attach:\/\/(.+)$/.exec(src);
      const noteMatch = /^#note\/([^/]+)/.exec(location.hash || '');
      if (m && noteMatch) location.hash = `#note/${noteMatch[1]}/annotate/${m[1]}`;
    });
    this._resolve(node.attrs.src);
  }

  async _resolve(src) {
    if (src?.startsWith('mn-attach://')) {
      this.dom.classList.add('mn-img-loading');
      const url = await getObjectUrl(src.slice('mn-attach://'.length));
      this.dom.classList.remove('mn-img-loading');
      if (url) {
        this.dom.src = url;
        this.dom.classList.remove('mn-img-missing');
        unregisterMissingImage(this);
      } else {
        // Binary not on this device yet — mark missing and wait for a sync to
        // (re)connect Drive, at which point retryMissingImages() re-resolves us.
        this.dom.classList.add('mn-img-missing');
        registerMissingImage(this);
      }
    } else {
      this.dom.src = src || '';
    }
  }

  // Called by retryMissingImages() after Drive (re)connects. No-op unless we're
  // still showing the "unavailable" state, so a settled image never re-fetches.
  retry() {
    if (this.dom.classList.contains('mn-img-missing')) this._resolve(this.node.attrs.src);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.src !== this.node.attrs.src) this._resolve(node.attrs.src);
    this.node = node;
    return true;
  }

  ignoreMutation() { return true; }
  destroy() { unregisterMissingImage(this); }
}
