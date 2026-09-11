/**
 * AddBGone - MAIN world hooks.
 *
 * Runs at document_start in the page's own JavaScript realm (before any page
 * script), so it can take ownership of the APIs that popunder ads rely on:
 *
 *   window.open(...)                       classic popup / popunder
 *   anchor.click()                         synthetic click on <a target="_blank">
 *   el.dispatchEvent(new MouseEvent(...))  synthetic click, same trick
 *   form.submit()                          <form target="_blank"> popunder
 *
 * Everything is blocked by default and unblocked only if the isolated-world
 * content script tells us the extension is off for this site. Failing toward
 * "blocked" matters because ad scripts run early and we would otherwise lose
 * the race during the async settings read.
 */
(() => {
  'use strict';

  const FLAG = '__addbgone_main__';
  if (window[FLAG]) return;
  Object.defineProperty(window, FLAG, { value: true });

  const EV_REPORT = '__addbgone_report__';
  const EV_CONFIG = '__addbgone_config__';

  const cfg = {
    enabled: true,
    blockPopups: true,
    // One-shot escape hatch armed from the extension popup ("Allow next popup").
    allowNext: false
  };

  const native = {
    open: window.open,
    click: HTMLElement.prototype.click,
    dispatchEvent: EventTarget.prototype.dispatchEvent,
    submit: HTMLFormElement.prototype.submit
  };

  function report(kind, detail) {
    try {
      window.dispatchEvent(
        new CustomEvent(EV_REPORT, { detail: JSON.stringify({ kind, detail: String(detail || '') }) })
      );
    } catch (_) {
      /* page may have broken CustomEvent; never let reporting throw */
    }
  }

  function blocking() {
    return cfg.enabled && cfg.blockPopups;
  }

  /** Consume the one-shot allowance, if armed. */
  function consumeAllowance() {
    if (cfg.allowNext) {
      cfg.allowNext = false;
      report('popup-allowed', '');
      return true;
    }
    return false;
  }

  // --- window.open -----------------------------------------------------------

  /**
   * Ads frequently chain off the return value (`w.document.write(...)`,
   * `w.focus()`, `w.location = ...`). Returning null makes them throw, which on
   * some sites aborts the player bootstrap too, so hand back an inert stub.
   */
  function stubWindow() {
    const noop = () => {};
    const doc = {
      write: noop,
      writeln: noop,
      open: noop,
      close: noop,
      body: null,
      head: null,
      cookie: '',
      createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: noop,
      removeEventListener: noop
    };
    const loc = {
      href: 'about:blank',
      protocol: 'about:',
      host: '',
      hostname: '',
      pathname: 'blank',
      search: '',
      hash: '',
      assign: noop,
      replace: noop,
      reload: noop,
      toString: () => 'about:blank'
    };
    const w = {
      closed: true,
      opener: null,
      name: '',
      document: doc,
      location: loc,
      focus: noop,
      blur: noop,
      close: noop,
      open: () => w,
      postMessage: noop,
      addEventListener: noop,
      removeEventListener: noop,
      alert: noop,
      confirm: () => false,
      prompt: () => null,
      print: noop,
      moveTo: noop,
      moveBy: noop,
      resizeTo: noop,
      resizeBy: noop,
      scrollTo: noop,
      setTimeout: noop,
      setInterval: noop
    };
    w.self = w;
    w.window = w;
    w.top = w;
    w.parent = w;
    w.frames = w;
    return w;
  }

  function patchedOpen(url, name, features) {
    if (!blocking() || consumeAllowance()) {
      return native.open.call(window, url, name, features);
    }
    report('popup', url);
    return stubWindow();
  }

  // Ad scripts commonly re-assign window.open to undo blockers. Expose it
  // through an accessor whose setter swallows the write but keeps the property
  // readable, so feature-detection (`typeof window.open === 'function'`) passes.
  try {
    Object.defineProperty(window, 'open', {
      configurable: false,
      enumerable: true,
      get() {
        return patchedOpen;
      },
      set(_v) {
        report('open-override', '');
      }
    });
  } catch (_) {
    window.open = patchedOpen;
  }

  // --- synthetic clicks on <a target="_blank"> -------------------------------

  function isNewTabAnchor(el) {
    if (!el || el.tagName !== 'A') return false;
    if (el.hasAttribute('download')) return true;
    const t = (el.getAttribute('target') || '').toLowerCase();
    return t === '_blank' || (t !== '' && t !== '_self' && t !== '_top' && t !== '_parent');
  }

  HTMLElement.prototype.click = function () {
    // Every call here is programmatic by definition; a real user click never
    // routes through .click(). A scripted new-tab anchor is the popunder.
    if (blocking() && isNewTabAnchor(this) && !consumeAllowance()) {
      report('popup', this.href || '(anchor)');
      return undefined;
    }
    return native.click.call(this);
  };

  EventTarget.prototype.dispatchEvent = function (event) {
    if (
      blocking() &&
      event &&
      event.type === 'click' &&
      event.isTrusted === false &&
      isNewTabAnchor(this) &&
      !consumeAllowance()
    ) {
      report('popup', this.href || '(anchor)');
      return false;
    }
    return native.dispatchEvent.call(this, event);
  };

  HTMLFormElement.prototype.submit = function () {
    const t = (this.getAttribute('target') || '').toLowerCase();
    if (blocking() && t === '_blank' && !consumeAllowance()) {
      report('popup', this.action || '(form)');
      return undefined;
    }
    return native.submit.call(this);
  };

  // --- config channel from the isolated world --------------------------------

  window.addEventListener(EV_CONFIG, (e) => {
    let next;
    try {
      next = JSON.parse(e.detail);
    } catch (_) {
      return;
    }
    if (typeof next.enabled === 'boolean') cfg.enabled = next.enabled;
    if (typeof next.blockPopups === 'boolean') cfg.blockPopups = next.blockPopups;
    if (next.allowNext === true) cfg.allowNext = true;
  });
})();
