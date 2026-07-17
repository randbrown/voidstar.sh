// qualia capture — background service worker.
//
// Why this extension exists: Chrome pins a "Sharing this tab" banner over
// the page for every getDisplayMedia tab capture — fullscreen included, in
// tabs and installed-PWA windows alike — which wrecks a projected
// performance. The chrome.tabCapture extension API records the same tab
// pixels with no banner and no share picker; its only indicator is the
// small recording badge on the tab strip, which fullscreen hides.
//
// Flow: the user invokes the extension (toolbar icon or the shortcut bound
// at chrome://extensions/shortcuts) → getMediaStreamId() mints a stream ID
// consumable by the page itself → content.js relays it via postMessage →
// the qualia recorder builds a getUserMedia stream from it and records
// through its normal pipeline (mix-bus audio, OPFS sink, MP4 fixes).
// Invocation is required by the tabCapture API (an activeTab-style grant),
// so the page's own rec button cannot start this path — the extension
// hotkey IS the banner-free record button. Pressing it during a take stops
// the take (the page treats it as a toggle).

async function toggleCapture(tab) {
  if (!tab?.id) return;
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId:   tab.id,
      consumerTabId: tab.id,
    });
  } catch (err) {
    // Most common cause: the extension wasn't invoked on this tab (Chrome
    // requires a fresh toolbar/shortcut invocation per capture).
    console.warn('[qualia-capture] getMediaStreamId failed:', err?.message || err);
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'qualia-capture-toggle', streamId });
  } catch (err) {
    // No content script in this tab — the active tab isn't a qualia page.
    console.warn('[qualia-capture] active tab has no qualia page:', err?.message || err);
  }
}

chrome.action.onClicked.addListener((tab) => { toggleCapture(tab); });

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-capture') return;
  // Older Chrome versions don't pass `tab` to onCommand; fall back to the
  // active tab of the focused window.
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleCapture(tab);
});
