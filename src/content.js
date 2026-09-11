/**
 * AddBGone - ISOLATED world.
 *
 * Two jobs:
 *   1. Find and neutralise "click shields" - the invisible full-bleed elements
 *      that sit on top of a video player so your first click goes to an ad.
 *   2. Catch the ones that appear too late to be scanned, by intercepting the
 *      click at capture phase and replaying it onto whatever is underneath.
 *
 * Scoring is deliberately conservative: an element must look inert (no text, no
 * media of its own), sit above the page, and cover real estate before it is
 * touched. Anything that is or contains a player is off-limits.
 */
(() => {
  'use strict';

  const FLAG = '__addbgone_content__';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const EV_REPORT = '__addbgone_report__';
  const EV_CONFIG = '__addbgone_config__';
  const MARK = 'data-addbgone';

  const SCORE_THRESHOLD = 6;

  /** Class/id fragments that mean "this is an ad container". */
  const AD_WORDS =
    /\b(ads?|adv|advert(ising|isement)?|banner|popup|pop-?under|pop-?up|interstitial|sponsor(ed)?|promo|preroll)\b|adsbygoogle|googlesyndication|doubleclick|taboola|outbrain|propeller|popads|exoclick|adsterra|juicyads|hilltopads|mgid|revcontent|adcash|clickadu|trafficjunky/i;

  /** Hosts that are ads no matter how they are dressed up. */
  const AD_HOSTS =
    /doubleclick|googlesyndication|googleadservices|adservice|adnxs|adsterra|propellerads|popads|popcash|exoclick|juicyads|hilltopads|mgid|taboola|outbrain|revcontent|trafficjunky|adcash|clickadu|onclickalgo|bidgear|admaven/i;

  /** Player chrome we must never hide - these legitimately overlay the video. */
  const PLAYER_SAFE =
    /(^|[\s_-])(vjs|jw|jwplayer|plyr|video-js|videojs|shaka|ytp|flowplayer|mejs|clappr|dplayer|artplayer|player-?(control|ui|overlay|poster|big|play))/i;

  const PLAYER_HINT = /embed|player|stream|live|hls|watch|video|iframe/i;

  const config = {
    enabled: true,
    removeOverlays: true,
    blockPopups: true,
    autoCloseTabs: true
  };

  const stats = { overlays: 0, popups: 0 };

  /** element -> original inline style attribute, for undo. */
  const hidden = new Map();
  /** Scroll locks we released, so undo can put them back. */
  const scrollLocks = [];

  const isTop = window === window.top;

  // ---------------------------------------------------------------------------
  // messaging
  // ---------------------------------------------------------------------------

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_) {
      /* context invalidated on extension reload */
    }
  }

  function pushConfig(extra) {
    const payload = Object.assign(
      { enabled: config.enabled, blockPopups: config.blockPopups },
      extra || {}
    );
    try {
      window.dispatchEvent(new CustomEvent(EV_CONFIG, { detail: JSON.stringify(payload) }));
    } catch (_) {}
  }

  window.addEventListener(EV_REPORT, (e) => {
    let msg;
    try {
      msg = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (msg.kind === 'popup') {
      stats.popups++;
      send({ type: 'popup-blocked', url: msg.detail });
      flash('Popup blocked');
    } else if (msg.kind === 'open-override') {
      send({ type: 'open-override' });
    }
  });

  // ---------------------------------------------------------------------------
  // player discovery (the protected set)
  // ---------------------------------------------------------------------------

  function rectOf(el) {
    try {
      return el.getBoundingClientRect();
    } catch (_) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
  }

  function findPlayers() {
    const players = [];
    for (const v of document.querySelectorAll('video')) players.push(v);

    let best = null;
    let bestArea = 0;
    for (const f of document.querySelectorAll('iframe')) {
      const r = rectOf(f);
      const area = r.width * r.height;
      if (area < 40000) continue;
      const src = f.getAttribute('src') || '';
      const weight = PLAYER_HINT.test(src) ? area * 2 : area;
      if (weight > bestArea) {
        bestArea = weight;
        best = f;
      }
    }
    if (best && !AD_HOSTS.test(best.getAttribute('src') || '')) players.push(best);
    return players;
  }

  /** Ancestors of the players - hiding one of these would hide the player. */
  function protectedSet(players) {
    const set = new Set();
    for (const p of players) {
      let n = p;
      while (n && n !== document.documentElement) {
        set.add(n);
        n = n.parentElement;
      }
    }
    return set;
  }

  // ---------------------------------------------------------------------------
  // scoring
  // ---------------------------------------------------------------------------

  function isTransparent(color) {
    return !color || color === 'transparent' || /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)/.test(color);
  }

  function nameOf(el) {
    const cls = typeof el.className === 'string' ? el.className : '';
    return `${cls} ${el.id || ''}`;
  }

  function shieldScore(el, ctx) {
    if (!(el instanceof Element)) return 0;

    const tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO' || tag === 'BODY' || tag === 'HTML' || tag === 'HEAD') return 0;
    if (el.hasAttribute(MARK)) return 0;
    if (ctx.protectedEls.has(el)) return 0;
    if (PLAYER_SAFE.test(nameOf(el))) return 0;
    if (el.querySelector('video, audio')) return 0;

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (_) {
      return 0;
    }
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return 0;
    if (cs.pointerEvents === 'none') return 0;

    const pos = cs.position;
    if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') return 0;

    const r = rectOf(el);
    if (r.width < 100 || r.height < 80) return 0;

    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const coverage = (r.width * r.height) / (vw * vh);
    if (coverage < 0.1) return 0;

    let score = 0;
    score += coverage > 0.85 ? 3 : coverage > 0.35 ? 2 : 1;

    const z = parseInt(cs.zIndex, 10);
    if (Number.isFinite(z)) {
      if (z >= 1000000) score += 3;
      else if (z >= 1000) score += 2;
      else if (z >= 50) score += 1;
    }

    const opacity = parseFloat(cs.opacity);
    if (opacity <= 0.05) score += 3;
    else if (opacity < 0.4) score += 1;

    const text = (el.innerText || '').trim();
    const hasOwnContent = !!el.querySelector('img, svg, canvas, iframe, video, input, button, picture');
    const bgTransparent = isTransparent(cs.backgroundColor) && cs.backgroundImage === 'none';

    if (!text && !hasOwnContent) score += 3; // the classic empty click shield
    else if (!text && bgTransparent) score += 2;

    if (tag === 'A') {
      const target = (el.getAttribute('target') || '').toLowerCase();
      if (target === '_blank') score += 3;
      if (!text && !hasOwnContent) score += 2;
    }

    if (tag === 'IFRAME') {
      const src = el.getAttribute('src') || '';
      if (AD_HOSTS.test(src)) score += 4;
      if (opacity <= 0.05) score += 2;
    }

    if (AD_WORDS.test(nameOf(el))) score += 2;
    if (cs.cursor === 'pointer' && !text && !hasOwnContent) score += 1;

    // Strongest signal available: it is physically sitting on the player.
    if (ctx.coveringPlayer.has(el)) score += 4;

    return score;
  }

  /**
   * Probe the players with elementFromPoint. Whatever answers instead of the
   * player is on top of it. Native/custom player controls are excluded by
   * requiring the hit to live outside the player's own subtree.
   */
  function findPlayerCovers(players) {
    const covering = new Set();
    for (const p of players) {
      const r = rectOf(p);
      if (r.width < 100 || r.height < 80) continue;
      // Skip players scrolled out of view - elementFromPoint needs viewport coords.
      if (r.bottom < 0 || r.top > (window.innerHeight || 0)) continue;

      const container = p.parentElement || p;
      const points = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + r.width * 0.25, r.top + r.height * 0.3],
        [r.left + r.width * 0.75, r.top + r.height * 0.3],
        [r.left + r.width * 0.25, r.top + r.height * 0.7],
        [r.left + r.width * 0.75, r.top + r.height * 0.7]
      ];

      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
        let hit;
        try {
          hit = document.elementFromPoint(x, y);
        } catch (_) {
          continue;
        }
        if (!hit || hit === p) continue;
        if (p.contains(hit) || container.contains(hit)) continue; // player's own UI
        covering.add(hit);
      }
    }
    return covering;
  }

  // ---------------------------------------------------------------------------
  // hiding / undo
  // ---------------------------------------------------------------------------

  function hide(el, reason) {
    if (hidden.has(el)) return false;
    hidden.set(el, el.getAttribute('style'));
    el.setAttribute(MARK, reason || 'overlay');
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
    stats.overlays++;
    return true;
  }

  function restoreAll() {
    for (const [el, style] of hidden) {
      if (style === null) el.removeAttribute('style');
      else el.setAttribute('style', style);
      el.removeAttribute(MARK);
    }
    hidden.clear();
    for (const { el, prop, value } of scrollLocks.splice(0)) {
      el.style.setProperty(prop, value);
    }
    stats.overlays = 0;
    send({ type: 'stats', overlays: 0, popups: stats.popups });
  }

  /** Full-screen ads often lock the page scroll; give it back. */
  function unlockScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.position === 'fixed') {
        scrollLocks.push({ el, prop: 'overflow', value: el.style.overflow });
        scrollLocks.push({ el, prop: 'position', value: el.style.position });
        el.style.setProperty('overflow', 'auto', 'important');
        if (cs.position === 'fixed') el.style.setProperty('position', 'static', 'important');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // scanning
  // ---------------------------------------------------------------------------

  /**
   * Candidate elements. A full-document sweep with getComputedStyle is too
   * expensive to run on a timer, so the periodic path only looks at elements
   * that are plausibly positioned: direct children of body/html (where injected
   * overlays land) plus anything the MutationObserver flagged.
   */
  function candidates(extra) {
    const out = new Set(extra || []);
    if (!document.body) return out;

    for (const el of document.body.children) out.add(el);
    for (const el of document.documentElement.children) {
      if (el.tagName !== 'HEAD') out.add(el);
    }
    // Elements that declare themselves as overlays inline - cheap selector, no
    // style resolution needed to enumerate.
    for (const el of document.querySelectorAll(
      '[style*="fixed"], [style*="z-index"], [style*="absolute"], a[target="_blank"], ins, iframe'
    )) {
      out.add(el);
    }
    return out;
  }

  let scanning = false;

  function scan(extra) {
    if (scanning || !config.enabled || !config.removeOverlays || !document.body) return 0;
    scanning = true;
    let removed = 0;
    try {
      const players = findPlayers();
      const ctx = {
        protectedEls: protectedSet(players),
        coveringPlayer: findPlayerCovers(players)
      };

      const pool = candidates(extra);
      // Anything sitting on a player is worth scoring even if it was not in the
      // cheap candidate pool.
      for (const el of ctx.coveringPlayer) pool.add(el);

      for (const el of pool) {
        if (!el.isConnected) continue;
        if (shieldScore(el, ctx) >= SCORE_THRESHOLD) {
          if (hide(el, 'scan')) removed++;
        }
      }

      if (removed) {
        unlockScroll();
        send({ type: 'stats', overlays: stats.overlays, popups: stats.popups });
        flash(`${removed} overlay${removed > 1 ? 's' : ''} removed`);
      }
    } finally {
      scanning = false;
    }
    return removed;
  }

  // ---------------------------------------------------------------------------
  // click interception (catches shields that appear between scans)
  // ---------------------------------------------------------------------------

  function handleClickCapture(e) {
    if (!config.enabled || !e.isTrusted) return;

    send({ type: 'user-click' });

    if (!config.removeOverlays) return;

    const players = findPlayers();
    const ctx = {
      protectedEls: protectedSet(players),
      coveringPlayer: findPlayerCovers(players)
    };

    // Walk up from the click target: the shield may be an ancestor of whatever
    // leaf node received the event.
    let node = e.target;
    let shield = null;
    for (let depth = 0; node && node instanceof Element && depth < 6; depth++, node = node.parentElement) {
      if (shieldScore(node, ctx) >= SCORE_THRESHOLD) {
        shield = node;
        break;
      }
    }
    if (!shield) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    hide(shield, 'click');
    unlockScroll();
    send({ type: 'stats', overlays: stats.overlays, popups: stats.popups });
    // Tell the background a popunder is likely imminent so it can close one.
    send({ type: 'expect-popunder' });
    flash('Overlay removed - click again');

    // Replay the click on whatever was underneath. The synthetic event is
    // untrusted, so it cannot itself be used to open a popup.
    const x = e.clientX;
    const y = e.clientY;
    let under = null;
    try {
      under = document.elementFromPoint(x, y);
    } catch (_) {}
    if (under && under !== shield) {
      under.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })
      );
    }
  }

  window.addEventListener('click', handleClickCapture, true);
  window.addEventListener('mousedown', (e) => {
    if (config.enabled && e.isTrusted) send({ type: 'user-click' });
  }, true);

  // ---------------------------------------------------------------------------
  // toast
  // ---------------------------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;

  function flash(text) {
    if (!isTop || !document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute(MARK, 'toast');
      Object.assign(toastEl.style, {
        position: 'fixed',
        zIndex: '2147483647',
        left: '16px',
        bottom: '16px',
        padding: '8px 12px',
        font: '13px/1.3 system-ui, sans-serif',
        color: '#fff',
        background: 'rgba(17,17,19,.92)',
        border: '1px solid rgba(255,255,255,.15)',
        borderRadius: '8px',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity .15s ease'
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = `AddBGone: ${text}`;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.opacity = '0';
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // observers & scheduling
  // ---------------------------------------------------------------------------

  const pending = new Set();
  let scheduled = 0;

  function schedule() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = 0;
      const batch = Array.from(pending);
      pending.clear();
      scan(batch);
    }, 200);
  }

  const observer = new MutationObserver((records) => {
    if (!config.enabled || !config.removeOverlays) return;
    for (const rec of records) {
      if (rec.type === 'childList') {
        for (const n of rec.addedNodes) if (n.nodeType === 1) pending.add(n);
      } else if (rec.target.nodeType === 1) {
        pending.add(rec.target);
      }
      if (pending.size > 400) break; // cap work on chatty pages
    }
    if (pending.size) schedule();
  });

  function startObserving() {
    if (!document.documentElement) return;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'target']
    });
  }

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === 'scan-now') {
      const n = scan();
      respond({ ok: true, removed: n, overlays: stats.overlays, popups: stats.popups });
      return true;
    }
    if (msg.type === 'restore') {
      restoreAll();
      respond({ ok: true });
      return true;
    }
    if (msg.type === 'config') {
      Object.assign(config, msg.config);
      pushConfig();
      if (!config.enabled) restoreAll();
      else scan();
      respond({ ok: true });
      return true;
    }
    if (msg.type === 'allow-next-popup') {
      pushConfig({ allowNext: true });
      respond({ ok: true });
      return true;
    }
    if (msg.type === 'get-stats') {
      respond({ ok: true, overlays: stats.overlays, popups: stats.popups });
      return true;
    }
    return false;
  });

  try {
    chrome.runtime.sendMessage({ type: 'get-config', url: location.href }, (res) => {
      if (chrome.runtime.lastError || !res || !res.config) return;
      Object.assign(config, res.config);
      pushConfig();
      if (config.enabled) scan();
    });
  } catch (_) {
    /* orphaned frame or reloaded extension - keep the safe defaults */
  }

  startObserving();

  // Ads inject on a delay; a handful of cheap follow-up sweeps catches them
  // without a permanent timer.
  const sweeps = [400, 1200, 2500, 5000, 9000];
  for (const ms of sweeps) setTimeout(() => scan(), ms);

  document.addEventListener('DOMContentLoaded', () => scan(), { once: true });
  window.addEventListener('load', () => setTimeout(() => scan(), 300), { once: true });
})();
