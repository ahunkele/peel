/**
 * Peel detector probe.
 *
 * Paste this into the DevTools console on a page that is stealing your clicks.
 * It does not modify the page - it reports what the real detector would see, so
 * the scoring in src/content.js can be tuned against actual markup.
 *
 * Read the output top-down:
 *   players[]   what the extension thinks the video player is (must be right)
 *   covers[]    what is physically sitting on top of the player  <- the shields
 *   scored[]    every candidate with its score; >= 6 gets hidden
 */
(() => {
  const AD_WORDS =
    /\b(ads?|adv|advert(ising|isement)?|banner|popup|pop-?under|pop-?up|interstitial|sponsor(ed)?|promo|preroll)\b|adsbygoogle|googlesyndication|doubleclick|taboola|outbrain|propeller|popads|exoclick|adsterra|juicyads|hilltopads|mgid|revcontent|adcash|clickadu|trafficjunky/i;
  const AD_HOSTS =
    /doubleclick|googlesyndication|googleadservices|adservice|adnxs|adsterra|propellerads|popads|popcash|exoclick|juicyads|hilltopads|mgid|taboola|outbrain|revcontent|trafficjunky|adcash|clickadu|onclickalgo|bidgear|admaven/i;
  const PLAYER_SAFE =
    /(^|[\s_-])(vjs|jw|jwplayer|plyr|video-js|videojs|shaka|ytp|flowplayer|mejs|clappr|dplayer|artplayer|player-?(control|ui|overlay|poster|big|play))/i;
  const PLAYER_HINT = /embed|player|stream|live|hls|watch|video|iframe/i;

  const vw = innerWidth;
  const vh = innerHeight;
  const nameOf = (el) => `${typeof el.className === 'string' ? el.className : ''} ${el.id || ''}`;
  const transparent = (c) => !c || c === 'transparent' || /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)/.test(c);
  const brief = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${
    typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''
  }`;

  // --- players -------------------------------------------------------------
  const players = [...document.querySelectorAll('video')];
  let best = null;
  let bestWeight = 0;
  for (const f of document.querySelectorAll('iframe')) {
    const r = f.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < 40000) continue;
    const w = PLAYER_HINT.test(f.getAttribute('src') || '') ? area * 2 : area;
    if (w > bestWeight) { bestWeight = w; best = f; }
  }
  if (best && !AD_HOSTS.test(best.getAttribute('src') || '')) players.push(best);

  const protectedEls = new Set();
  for (const p of players) { let n = p; while (n && n !== document.documentElement) { protectedEls.add(n); n = n.parentElement; } }

  // --- covers --------------------------------------------------------------
  const covers = new Set();
  const coverRows = [];
  for (const p of players) {
    const r = p.getBoundingClientRect();
    if (r.width < 100 || r.height < 80) continue;
    const container = p.parentElement || p;
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + r.width * 0.25, r.top + r.height * 0.3],
      [r.left + r.width * 0.75, r.top + r.height * 0.3],
      [r.left + r.width * 0.25, r.top + r.height * 0.7],
      [r.left + r.width * 0.75, r.top + r.height * 0.7]
    ];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x > vw || y > vh) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === p || p.contains(hit) || container.contains(hit)) continue;
      if (!covers.has(hit)) {
        covers.add(hit);
        coverRows.push({ el: brief(hit), over: brief(p), node: hit });
      }
    }
  }

  // --- score ---------------------------------------------------------------
  function score(el) {
    const why = [];
    const tag = el.tagName;
    if (['VIDEO', 'AUDIO', 'BODY', 'HTML', 'HEAD'].includes(tag)) return null;
    if (protectedEls.has(el)) return { skip: 'is/contains player' };
    if (PLAYER_SAFE.test(nameOf(el))) return { skip: 'PLAYER_SAFE match' };
    if (el.querySelector('video, audio')) return { skip: 'contains media' };

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    if (cs.pointerEvents === 'none') return null;
    if (!['fixed', 'absolute', 'sticky'].includes(cs.position)) return null;

    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 80) return null;
    const coverage = (r.width * r.height) / (vw * vh);
    if (coverage < 0.1) return null;

    let s = 0;
    const add = (n, label) => { if (n) { s += n; why.push(`${label}+${n}`); } };
    add(coverage > 0.85 ? 3 : coverage > 0.35 ? 2 : 1, `cover${Math.round(coverage * 100)}%`);
    const z = parseInt(cs.zIndex, 10);
    if (Number.isFinite(z)) add(z >= 1e6 ? 3 : z >= 1000 ? 2 : z >= 50 ? 1 : 0, `z${z}`);
    const op = parseFloat(cs.opacity);
    add(op <= 0.05 ? 3 : op < 0.4 ? 1 : 0, `opacity${op}`);
    const text = (el.innerText || '').trim();
    const own = !!el.querySelector('img, svg, canvas, iframe, video, input, button, picture');
    const bgT = transparent(cs.backgroundColor) && cs.backgroundImage === 'none';
    if (!text && !own) add(3, 'empty');
    else if (!text && bgT) add(2, 'no-text+transparent');
    if (tag === 'A') {
      if ((el.getAttribute('target') || '').toLowerCase() === '_blank') add(3, 'a[_blank]');
      if (!text && !own) add(2, 'empty-anchor');
    }
    if (tag === 'IFRAME') {
      if (AD_HOSTS.test(el.getAttribute('src') || '')) add(4, 'ad-host');
      if (op <= 0.05) add(2, 'invisible-iframe');
    }
    if (AD_WORDS.test(nameOf(el))) add(2, 'ad-words');
    if (cs.cursor === 'pointer' && !text && !own) add(1, 'pointer');
    if (covers.has(el)) add(4, 'ON-PLAYER');

    return { score: s, why: why.join(' '), size: `${Math.round(r.width)}x${Math.round(r.height)}`, pos: cs.position, node: el };
  }

  const pool = new Set(covers);
  if (document.body) {
    for (const el of document.body.children) pool.add(el);
    for (const el of document.documentElement.children) if (el.tagName !== 'HEAD') pool.add(el);
    for (const el of document.querySelectorAll('[style*="fixed"], [style*="z-index"], [style*="absolute"], a[target="_blank"], ins, iframe')) pool.add(el);
  }

  const scored = [];
  for (const el of pool) {
    const r = score(el);
    if (r && r.score != null) scored.push(Object.assign({ el: brief(el) }, r));
  }
  scored.sort((a, b) => b.score - a.score);

  console.group('%cPeel probe', 'color:#f97316;font-weight:bold');
  console.log('viewport', vw + 'x' + vh, '| candidates', pool.size);
  console.log('%cplayers', 'font-weight:bold', players.map(brief));
  console.log('%ccovers (sitting on the player)', 'font-weight:bold');
  console.table(coverRows.map(({ el, over }) => ({ el, over })));
  console.log('%cscored (>= 6 would be hidden)', 'font-weight:bold');
  console.table(scored.map(({ el, score, size, pos, why }) => ({ el, score, size, pos, why })));
  console.log('nodes:', { players, covers: [...covers], scored: scored.map((s) => s.node) });
  console.groupEnd();

  return { players: players.length, covers: covers.size, wouldHide: scored.filter((s) => s.score >= 6).length };
})();
