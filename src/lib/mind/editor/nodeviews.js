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
    this.overlay = null;

    // A positioned wrapper so a saved-annotation canvas can sit over the image.
    this.dom = document.createElement('span');
    this.dom.className = 'mn-editor-img-wrap';

    this.img = document.createElement('img');
    this.img.className = 'mn-editor-img';
    this.img.alt = node.attrs.alt || '';
    this.img.title = 'double-click to annotate';
    this.dom.appendChild(this.img);

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
    this._clearOverlay();
    if (src?.startsWith('mn-attach://')) {
      const attId = src.slice('mn-attach://'.length);
      this.img.classList.add('mn-img-loading');
      const url = await getObjectUrl(attId);
      this.img.classList.remove('mn-img-loading');
      if (url) {
        this.img.src = url;
        this.img.classList.remove('mn-img-missing');
        unregisterMissingImage(this);
        this._mountOverlay(attId);
      } else {
        // Binary not on this device yet — mark missing and wait for a sync to
        // (re)connect Drive, at which point retryMissingImages() re-resolves us.
        this.img.classList.add('mn-img-missing');
        registerMissingImage(this);
      }
    } else {
      this.img.src = src || '';
    }
  }

  // Draw saved annotation strokes over the image so markup is visible in the
  // note body, not only in the annotate view. Waits for the image box.
  async _mountOverlay(attId) {
    try {
      const { mountAnnotationOverlay } = await import('../annotation.js');
      const mount = async () => {
        if (this.node.attrs.src !== `mn-attach://${attId}`) return; // src changed while loading
        const o = await mountAnnotationOverlay(this.dom, attId);
        if (o) { this._clearOverlay(); this.overlay = o; }
      };
      if (this.img.complete && this.img.naturalWidth) mount();
      else this.img.addEventListener('load', mount, { once: true });
    } catch { /* overlay is best-effort */ }
  }

  _clearOverlay() {
    if (this.overlay) { this.overlay.destroy(); this.overlay = null; }
  }

  // Called by retryMissingImages() after Drive (re)connects. No-op unless we're
  // still showing the "unavailable" state, so a settled image never re-fetches.
  retry() {
    if (this.img.classList.contains('mn-img-missing')) this._resolve(this.node.attrs.src);
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    if (node.attrs.src !== this.node.attrs.src) this._resolve(node.attrs.src);
    this.node = node;
    return true;
  }

  ignoreMutation() { return true; }
  destroy() { this._clearOverlay(); unregisterMissingImage(this); }
}
