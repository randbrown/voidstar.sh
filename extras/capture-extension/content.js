// qualia capture — content-script relay between the extension and the page.
//
// Two jobs: announce the extension to the page (so the rec tooltips can
// point at the shortcut) and forward minted tabCapture stream IDs from the
// background worker. postMessage is same-window only and the page listener
// checks `source === window` plus the `qualia-capture-ext` marker; the
// stream ID itself is single-use and expires in seconds if unconsumed.

const ORIGIN = window.location.origin;

function announce() {
  window.postMessage({ source: 'qualia-capture-ext', type: 'hello' }, ORIGIN);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'qualia-capture-toggle' && msg.streamId) {
    window.postMessage(
      { source: 'qualia-capture-ext', type: 'toggle', streamId: msg.streamId },
      ORIGIN
    );
  }
});

// The page pings when its listener attaches — page init can run after
// document_idle, so either side may come up first; answer every ping.
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.source === 'qualia-page' && e.data?.type === 'capture-ext-ping') announce();
});

announce();
