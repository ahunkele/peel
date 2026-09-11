/**
 * AddBGone - service worker.
 *
 * Owns settings, per-tab counters, the toolbar badge, and the popunder-tab
 * killer. Tab closing is deliberately narrow: a tab is only closed if the
 * content script just told us a popunder was likely (a blocked shield click or
 * a blocked window.open) AND the new tab points at a different site than the
 * one that opened it.
 */

const DEFAULTS = {
  enabled: true,
  removeOverlays: true,
  blockPopups: true,
  autoCloseTabs: true,
  disabledHosts: []
};

/** How long after a suspicious click a new tab is treated as a popunder. */
const POPUNDER_WINDOW_MS = 3000;

/** tabId -> { overlays, popups, closed } */
const stats = new Map();
/** tabId -> timestamp of the last "a popunder is likely" signal. */
const expecting = new Map();
/** Most recently auto-closed tab, for the popup's undo. */
let lastClosed = null;

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return Object.assign({}, DEFAULTS, stored);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/** Compare sites loosely: example.com matches ads.example.com. */
function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split('.').slice(-2).join('.');
  const pb = b.split('.').slice(-2).join('.');
  return pa === pb;
}

async function configFor(url) {
  const s = await getSettings();
  const host = hostOf(url);
  const siteOff = s.disabledHosts.includes(host);
  return {
    enabled: s.enabled && !siteOff,
    removeOverlays: s.removeOverlays,
    blockPopups: s.blockPopups,
    autoCloseTabs: s.autoCloseTabs
  };
}

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------

function statsFor(tabId) {
  let s = stats.get(tabId);
  if (!s) {
    s = { overlays: 0, popups: 0, closed: 0 };
    stats.set(tabId, s);
  }
  return s;
}

function updateBadge(tabId) {
  const s = statsFor(tabId);
  const total = s.overlays + s.popups + s.closed;
  chrome.action.setBadgeText({ tabId, text: total ? String(total) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#c2410c' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const tabId = sender.tab && sender.tab.id;

  switch (msg.type) {
    case 'get-config':
      configFor(msg.url || (sender.tab && sender.tab.url) || '').then((config) => respond({ config }));
      return true;

    case 'stats': {
      if (tabId == null) break;
      const s = statsFor(tabId);
      // Frames report their own totals; keep the largest frame's count for
      // overlays and sum popups, which are one-shot events.
      s.overlays = Math.max(s.overlays, msg.overlays || 0);
      s.popups = Math.max(s.popups, msg.popups || 0);
      updateBadge(tabId);
      break;
    }

    case 'popup-blocked': {
      if (tabId == null) break;
      const s = statsFor(tabId);
      s.popups++;
      expecting.set(tabId, Date.now());
      updateBadge(tabId);
      break;
    }

    case 'expect-popunder':
      if (tabId != null) expecting.set(tabId, Date.now());
      break;

    case 'user-click':
      // Not a popunder signal by itself - only refresh an existing suspicion.
      break;

    case 'open-override':
      break;

    default:
      break;
  }
  return false;
});

// ---------------------------------------------------------------------------
// popunder tab killer
// ---------------------------------------------------------------------------

const watched = new Map(); // new tabId -> { openerTabId, openerHost, at }

chrome.tabs.onCreated.addListener(async (tab) => {
  const opener = tab.openerTabId;
  if (opener == null || tab.id == null) return;

  const suspectedAt = expecting.get(opener);
  if (!suspectedAt || Date.now() - suspectedAt > POPUNDER_WINDOW_MS) return;

  const s = await getSettings();
  if (!s.enabled || !s.autoCloseTabs) return;

  let openerHost = '';
  try {
    const openerTab = await chrome.tabs.get(opener);
    openerHost = hostOf(openerTab.url || '');
  } catch (_) {
    return;
  }
  if (s.disabledHosts.includes(openerHost)) return;

  watched.set(tab.id, { openerTabId: opener, openerHost, at: Date.now() });
  setTimeout(() => watched.delete(tab.id), POPUNDER_WINDOW_MS + 2000);

  // Some popunders are created with the URL already set.
  if (tab.pendingUrl || tab.url) maybeClose(tab.id, tab.pendingUrl || tab.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!watched.has(tabId)) return;
  const url = changeInfo.pendingUrl || changeInfo.url;
  if (url) maybeClose(tabId, url);
});

async function maybeClose(tabId, url) {
  const info = watched.get(tabId);
  if (!info) return;
  if (!url || url === 'about:blank' || url.startsWith('chrome://')) return;

  const host = hostOf(url);
  if (sameSite(host, info.openerHost)) {
    watched.delete(tabId);
    return; // a normal same-site link the user opened
  }

  watched.delete(tabId);
  lastClosed = { url, host, openerTabId: info.openerTabId, at: Date.now() };

  try {
    await chrome.tabs.remove(tabId);
  } catch (_) {
    return;
  }

  const s = statsFor(info.openerTabId);
  s.closed++;
  updateBadge(info.openerTabId);
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  stats.delete(tabId);
  expecting.delete(tabId);
  watched.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    stats.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'scan-now') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'scan-now' }, () => void chrome.runtime.lastError);
  }
});

// The popup talks to the worker through these instead of duplicating logic.
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.type === 'popup:state') {
    (async () => {
      const s = await getSettings();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const host = hostOf(tab && tab.url);
      respond({
        settings: s,
        host,
        siteDisabled: s.disabledHosts.includes(host),
        stats: tab && tab.id != null ? statsFor(tab.id) : { overlays: 0, popups: 0, closed: 0 },
        lastClosed
      });
    })();
    return true;
  }

  if (msg.type === 'popup:save') {
    (async () => {
      await chrome.storage.local.set(msg.settings);
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        const config = await configFor(tab.url || '');
        chrome.tabs.sendMessage(tab.id, { type: 'config', config }, () => void chrome.runtime.lastError);
      }
      respond({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'popup:reopen') {
    if (lastClosed) {
      chrome.tabs.create({ url: lastClosed.url, active: true });
      lastClosed = null;
    }
    respond({ ok: true });
    return true;
  }

  return false;
});
