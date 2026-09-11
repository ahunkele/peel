# Peel

A Chrome extension (Manifest V3) for the specific annoyance on free sports-stream
sites: an invisible element is layered over the video player so your first click
opens an ad instead of starting the stream, and a popunder tab opens behind the
page.

## What it does

**1. Removes click-shield overlays.** The page is scanned for elements that are
positioned above the content, cover a meaningful share of the viewport, and are
*inert* — no text, no images of their own, often `opacity: 0` or a transparent
background. Each candidate is scored; only elements at or above the threshold
are hidden (`display: none !important`).

The strongest single signal is geometric: the extension finds the video player,
probes five points across it with `document.elementFromPoint`, and anything that
answers instead of the player is sitting on top of it.

**2. Catches shields that appear too late to scan.** A capture-phase click
listener registered at `document_start` re-scores the click target. If it is a
shield, the event is cancelled before the page ever sees it, the shield is
hidden, and the click is replayed onto whatever was underneath — so the click
reaches the play button instead of the ad.

**3. Blocks popups and popunders.** A script in the page's own JS realm takes
over the APIs these ads use before any page script runs:

| API | Trick it blocks |
| --- | --- |
| `window.open` | classic popup / popunder |
| `HTMLElement.prototype.click` | scripted click on `<a target="_blank">` |
| `EventTarget.prototype.dispatchEvent` | synthetic `MouseEvent` on the same |
| `HTMLFormElement.prototype.submit` | `<form target="_blank">` popunder |

`window.open` is re-defined through an accessor whose setter swallows writes, so
ad scripts cannot restore the original. Blocked calls return an inert stub
window rather than `null`, because ad code chains off the return value
(`w.document.write(...)`, `w.focus()`) and a throw there can take the player
bootstrap down with it.

**4. Closes popunder tabs that still get through.** Narrowly scoped: a tab is
only closed when the content script has *just* reported a blocked shield click
or a blocked `window.open` (within 3s) **and** the new tab points at a different
site than the tab that opened it. Normal same-site link clicks and middle-clicks
are never touched, and the popup offers "Reopen closed tab" as an undo.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → select this folder (`peel`).
4. Pin the extension so you can see the badge count.

After editing any file, hit the reload arrow on the extension card, then reload
the page.

## Using it

The badge counts what was blocked on the current tab. Click the icon for:

- **Scan now** (also `Alt+Shift+X`) — force a rescan.
- **Undo removals** — restore everything hidden on this page, if a scan ate
  something it shouldn't have.
- **Allow next popup** — one-shot escape hatch when you *want* a popup (a login
  window, a legitimate "open in new tab").
- **Reopen closed tab** — undo an auto-close.
- Per-site toggle, plus individual switches for overlay removal, popup blocking,
  and tab closing.

## Layout

```
manifest.json
src/main-world.js   MAIN world  · document_start · API hooks (popups)
src/content.js      ISOLATED    · document_start · scanner, click interception
src/background.js   service worker · settings, badge, popunder tab killer
popup/              toolbar UI
icons/
```

The two content scripts talk to each other over `CustomEvent` (`__peel_config__`
down, `__peel_report__` up) with JSON string payloads, since the MAIN world
has no access to `chrome.*` APIs and object identity does not cross world
boundaries cleanly.

## Tuning the detector

Everything lives at the top of `src/content.js`:

- `SCORE_THRESHOLD` (default `6`) — lower it to be more aggressive, raise it if
  a site loses legitimate UI.
- `AD_WORDS` / `AD_HOSTS` — class, id, and iframe-src fragments that add to the
  score.
- `PLAYER_SAFE` — class fragments that are *never* touched. Player skins
  (video.js, JW, Plyr, …) legitimately overlay the video; if a site's player
  breaks, its wrapper class most likely needs to go here.

Elements that are, contain, or are an ancestor of a `<video>` or the detected
player iframe are excluded before scoring, so the player itself can't be hidden.

## Known limits

- A site can navigate the current tab to an ad (`location.href = …`) instead of
  opening a new one. `window.location` is not configurable, so that route isn't
  hooked — use the back button.
- Ads inside a cross-origin iframe are handled (the content scripts run in all
  frames), but an overlay drawn *inside* that iframe can only be measured in the
  iframe's own coordinate space, not against the top page's player.
- There is no network-level blocklist. This is purely behavioural, so it doesn't
  go stale, but it also won't stop an ad from loading — only from stealing your
  click.
- Detection is heuristic. Expect to adjust `PLAYER_SAFE` for sites with unusual
  players, and use **Undo removals** when a scan is wrong.
