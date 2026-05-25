# Shades Loader — boot integration plan

Wire the designed **Shades Loader** (4-phase brand launch animation) into the
boot sequence, replacing the placeholder honey-shimmer bar. Covers **both** the
standard cold-start path **and** the invite/share splash path.

> Status: PLAN ONLY. No code changed yet. This document is the spec to build
> from. Confirm scope before implementing.

---

## 0. What the loader is (design intent)

The authoritative spec is `design/shades-loader/chats/chat3.md` (final 4-phase
brief). Supporting context: `chat1` (logo concepts), `chat2` (why the sun is
`#F5C25E`, not tangerine), `chat4` (native mark-only splash), `chat5` (feature
graphics — unrelated to the loader). Bundle origin note: `design/shades-loader/BUNDLE-README.md`.

The loader is one continuous motion in four phases:

| Phase | Dur | Motion | Gate |
|-------|-----|--------|------|
| 1 · Intro | 350 ms | static logo → solid yellow (sun rises, shadow descends + derotates diagonal→horizontal) | one-shot on launch |
| 2 · Loading loop | 2000 ms/cycle | horizontal blinds open/close over the sun (yellow→blue→yellow), pure 2D thickness | loops while `!isLoaded`; checks `isLoaded` at each **yellow extreme** |
| 3 · Resolve | 700 ms | solid yellow → static logo (sun descends to half-dome, shadow rises + rotates horizontal→diagonal) | fires when `isLoaded` true |
| 4 · Crossfade | 300 ms | the loader SVG (logo + its own bg) fades opacity → 0, revealing the finished app underneath | **held until `isMapReady`**, then runs; `onComplete` fires after |

**First-frame contract (critical):** the loader paints `FRAMES['static-logo']`
*synchronously* on `createShadesLoader(...)` (see `shades-loader.js:364`). That
first painted frame must pixel-match the native splash asset (apple-touch
startup image / Android manifest splash) so there is no flash between native
splash → JS. The current `#splash-logo` (mark-only `shades-mark.svg`, 46vmin)
already serves that role; the loader's static frame must land in the same spot.

**Palette:** ink `#111E38`, cream `#FFF2EB`, sun `#F5C25E` only. No tangerine.
Light variant = ink stripes on cream bg → matches `#splash` (`background:#FFF2EB`).

**Reduced motion:** holds the static logo through phases 1–3, still runs Phase 4
as a plain opacity crossfade. (Built in — `shades-loader.js:430,480,525`.)

### Public API (confirmed in source)

```js
const loader = createShadesLoader(container, { variant: 'light'|'dark', showWordmark });
loader.start({
  isLoaded:    () => boolean,   // polled at each yellow extreme of Phase 2
  isMapReady:  () => boolean,   // polled (50ms) after Phase 3, gates Phase 4
  onComplete:  () => void,      // fires after Phase 4 crossfade finishes
});
// signals (alternative to polls): loader.signalLoaded(); loader.signalMapReady();
// direct:  playPhase1/2/3/4, stopPhase2, reset, setStaticFrame, destroy
// loader.svg is the appended <svg> node.
```

`checkLoaded()  = isLoadedPoll?.()  || loadedSignaled` ; `checkMapReady() =
isMapReadyPoll?.() || mapReadySignaled`. Global is `window.createShadesLoader`.
Geometry: viewBox `240×280`, baseline `y=200`; with `showWordmark:false` the
meaningful content is the upper ~200/280 (the mark); wordmark sits at `y=252`.

---

## 1. Asset preservation — DONE

Bundle copied out of ephemeral `/tmp` into the repo:

```
design/shades-loader/
  shades-loader.js            ← production v3 component (the asset to wire)
  Shades Loader (demo).html   ← standalone review page (all 4 phases + frames)
  BUNDLE-README.md            ← handoff README (read-this-first)
  chats/chat1..5.md           ← design intent transcripts
  reference/shades-mark.jsx   ← mark geometry reference
  reference/shades-lockup.jsx ← lockup geometry reference
```

When wiring, the **shipped** copy lives at repo root as a loaded JS file (see
§4); `design/shades-loader/shades-loader.js` stays as the design-of-record
reference. Keep them in sync, or load the design copy directly (decision in §6).

---

## 2. The two boot paths as they exist today

### 2a. Cold-start — LIVE path is `_skipIntro` (NOT `_runIntroSequence`)

⚠️ `_runIntroSequence` ([app.js:7755](js/app.js#L7755)) is **dead code, kept for
reference** — the comment at [app.js:7743-7752](js/app.js#L7743-L7752) states no
caller routes to it. The live cold-start path is **`_skipIntro`**
([app.js:8160](js/app.js#L8160)). Plan against `_skipIntro`.

`_skipIntro(seqId?, opts?)` flow ([app.js:8160-8375](js/app.js#L8160-L8375)):
1. 12 s hard kill-switch backstop (force-dismiss splash + reveal) — `8176`.
2. Resolve DOM refs: `#splash`, `#splash-logo`, `#splash-loader`, `#canvas-overlay`, chrome.
3. Set time, `update()`.
4. **No camera dive.** `map.setPadding({bottom: 50vh})` + `map.jumpTo({center:_introCenter, zoom:14, pitch:15})` — map is at its final resting state from frame one.
5. Dismissal gate (the `!opts.keepSplash` branch):
   - `gateAlreadyOpen` → `_hideSplashInstantly()` + `_runSkipChoreography()` now.
   - else → `_onBootWorkerReady(... 8s cap)` → force `renderList()` → wait `map.once('idle')` (2.5 s cap) → `_dismissOnce()` → double-rAF → `_hideSplashInstantly()` + `_runSkipChoreography()`.
6. `_hideSplashInstantly()` ([8259](js/app.js#L8259)): `splash` += `bg-out done`, `#splash-logo` += `fade-out`, `#splash-loader` += `fade-out` (all `transition:none`).
7. `_runSkipChoreography()` ([8273](js/app.js#L8273)): canvas opacity 0 → `_introRevealUI()` slides chrome in (50 ms) → `_revealCanvasAndChrome()` releases the boot-draw gate + fades pins/locate/zoom-jog in (550 ms) → wrap-up `selectVenue`/`_notifInit`/`pushInit` (1050 ms) → drop `invite-loading` (1500 ms).
8. `keepSplash` branch → **runs nothing** (invite path owns dismissal).

So the cold-start "moment the splash goes away" = the `_dismissOnce()` gate
(worker ready ∧ map idle, capped). Today dismissal is an instant
`transition:none` hide; there is no designed crossfade.

### 2b. Invite / share — `openPlanPreview` in ui-plan-preview.js

Entry: an invite URL (`/i/<token>`, `/s/<id>`, `#invite/...`) sets
`documentElement.invite-loading` ([index.html:52-58](index.html#L52)) which
hides the map's first paint. `init()` routes to `_skipIntro({keepSplash:true})`
(splash stays up, `_skipIntro` does nothing) and `openPlanPreview(venue,...)`
takes over ([ui-plan-preview.js:111](js/ui-plan-preview.js#L111), sets
`body.plan-preview-active`).

Splash choreography inside `openPlanPreview` ([ui-plan-preview.js:250-363](js/ui-plan-preview.js#L250-L363)):
- `_startDive()` (258): `jumpTo` zoom 14 → `flyTo` zoom 16.75 / pitch 58 / 1500 ms toward the venue.
- `_hideInviteSplash()` (292): `splash` += `bg-out`, logo + loader += `fade-out`, `done` @500 ms.
- `_releaseSplash()` (311): `_revealCanvasAndChrome()` (reveal pins so the inviter avatar pin shows) → `_hideInviteSplash()` → `setTimeout(_startDive, 200)`.
- Trigger: `Promise.all([ wait(SPLASH_MIN_MS−elapsed), _waitForTimelineReady(2500) ]).then(_releaseSplash)`.
- `map.once('idle')` (+1800 ms fallback) → drops `invite-loading` (pin-canvas reveal only).

So the invite path: hold splash until splash-min ∧ timeline-ready → reveal
chrome → hide splash → **then** the camera dive plays *visibly* (per the design
note at lines 250-253: "the animation should start after the splash").

---

## 3. API → boot-gate mapping

| Loader signal | Cold-start (`_skipIntro`) | Invite (`openPlanPreview`) |
|---------------|---------------------------|----------------------------|
| `isLoaded`   | `() => document.body.classList.contains('timeline-ready')` (worker delivered precise sun windows — [app.js:1528](js/app.js#L1528)) | same — `timeline-ready` |
| `isMapReady` | the existing dismiss condition: worker-ready already implied by `isLoaded`; gate on `map.once('idle')` (∨ 2.5 s cap) — reuse `_dismissOnce`'s readiness | pre-dive map idle at zoom 14 over the venue (the dive runs *after*, on `onComplete`) |
| `onComplete` | run `_runSkipChoreography()` (the chrome slide-in) — **without** its own splash-hide, since Phase 4 already crossfaded the loader out | `_revealCanvasAndChrome()` + `_startDive()` (Phase 4 crossfade replaces `_hideInviteSplash`) |

Both `isLoaded` gates are the SAME existing class (`timeline-ready`). The loader
loops Phase 2 visibly during exactly the window the app currently fills with the
honey-shimmer bar — a strict upgrade of the same gate.

---

## 4. Markup + load order

**index.html** ([241-243](index.html#L241)) — replace the static img + empty
shimmer div with a single mount node:

```html
<div id="splash">
  <div id="splash-loader"></div>   <!-- loader SVG mounts here -->
</div>
```

- Drop `<img id="splash-logo">`. The loader's synchronous static-logo first
  frame replaces it. (Keep `shades-mark.svg` as the `<link rel=icon>` favicon —
  that reference at [index.html:10](index.html#L10) is unrelated.)
- Add the script: `<script defer src="js/shades-loader.js?v=..."></script>`
  **before** `js/app.js` (it must define `window.createShadesLoader` before
  `init()` mounts it). Copy `design/shades-loader/shades-loader.js` → `js/shades-loader.js`
  (keeps it inside the existing `?v=` cache-bust + `package.json` `www/` cp-list
  discipline; see §6 for the alternative).
- Add `js/shades-loader.js` to the `build` cp-list in `package.json` AND the
  `sw.js` pre-cache list (else iOS/Android ship without it and the splash never
  resolves — `cap-sync-check.yml` would catch the cp-list miss).

**First-frame / native-splash alignment:** mount the loader as early as possible
(inline in `<head>` after the element exists, or at the very top of `init()`),
so its static frame paints before first map paint — preserving the no-flash
contract. The mount must size/center the SVG to match the old `#splash-logo`
(46vmin mark). Recommend `showWordmark:false` to match the mark-only native
splash (chat4) and the current splash-logo — flag as a confirm (§6).

---

## 5. Implementation steps

### 5a. Shared: mount + drive (new code, likely in `init.js` or top of `_skipIntro`)

```js
function _mountShadesLoader() {
  const host = document.getElementById('splash-loader');
  if (!host || !window.createShadesLoader || host._loader) return host?._loader || null;
  const loader = window.createShadesLoader(host, { variant: 'light', showWordmark: false });
  host._loader = loader;
  return loader;
}
```

Paint it on boot (first-frame contract) — call `_mountShadesLoader()` as early
as the `#splash-loader` node exists. The static frame is painted in the
constructor, so simply mounting satisfies the no-flash requirement.

### 5b. Cold-start (`_skipIntro`)

Replace the instant splash hide with a loader-driven crossfade:

1. At the top of `_skipIntro` (non-`keepSplash`), `const loader = _mountShadesLoader();`
2. Instead of `_hideSplashInstantly()` inside `_dismissOnce`, drive the loader:
   ```js
   loader.start({
     isLoaded:   () => document.body.classList.contains('timeline-ready'),
     isMapReady: () => /* map idle reached, or cap fired */ _mapIdleOrCapped(),
     onComplete: () => { splash.classList.add('done'); _runSkipChoreography(); },
   });
   ```
   - The loader's Phase 2 loop now plays during the worker wait (replacing the
     shimmer bar). Phase 3 resolves when `timeline-ready`. Phase 4 crossfades on
     map-idle, then `onComplete` slides the chrome in.
   - **Concurrent backdrop fade:** Phase 4 fades only the loader SVG opacity. The
     cream `#splash` background is separate — add `splash.classList.add('bg-out')`
     at Phase 4 start (e.g. just before `loader` enters Phase 4, or via a short
     timer keyed to `isMapReady` becoming true) so the cream backdrop fades in
     lock-step with the logo. Simplest: keep `#splash` cream and the loader's own
     cream bg-rect; fade both together by adding `bg-out` when we know Phase 4 is
     about to run, and `done` in `onComplete`.
3. The `gateAlreadyOpen` fast-path (mid-session re-entry) can `loader.signalLoaded()`
   + `signalMapReady()` then `start(...)` so it crossfades immediately, or just
   keep the existing instant hide for that already-warm path.
4. The 12 s kill-switch backstop ([8176](js/app.js#L8176)) must also
   `loader?.destroy()` (or force `done`) so a stalled loader can't keep the
   splash up.

### 5c. Invite / share (`openPlanPreview`)

The loader is already mounted (same `#splash-loader`, painted at boot before the
invite path runs). Re-drive it for this path instead of `_releaseSplash`/`_hideInviteSplash`:

1. `const loader = host._loader` (already mounted, mid Phase 2 loop by now).
2. Replace the `Promise.all(...).then(_releaseSplash)` trigger with loader signals:
   - `isLoaded` = `timeline-ready` (Phase 3 fires when worker done + splash-min via a min-gate).
   - `isMapReady` = the pre-dive map is idle at zoom 14 over the venue (`map.once('idle')`, 1800 ms fallback).
   - `onComplete` = `_revealCanvasAndChrome()` (show the inviter avatar pin) → `_startDive()` (the visible fly-in). Phase 4 has already crossfaded the loader away, so `_hideInviteSplash` is no longer needed; just add `splash.classList.add('done')`.
3. Keep `body.plan-preview-active` and the `invite-loading` drop on map idle
   exactly as today.
4. Honor the design note (250-253): the dive plays *after* the loader resolves —
   `_startDive` in `onComplete` preserves that ordering.

### 5d. CSS (`css/components-overlays.css` 360-404)

- Remove `#splash-logo` rules (360-367) — the element is gone.
- Replace the `#splash-loader` shimmer-bar block (371-404) with sizing/centering
  for the mounted SVG: size the SVG so the **mark** renders ≈ 46vmin (matching
  the old `#splash-logo`), centered (the `#splash` flexbox already centers). The
  `@keyframes splash-shimmer` + reduced-motion shimmer fallback are no longer
  needed (the loader owns reduced-motion internally).
- Keep `#splash` (335-358) cream bg + `.bg-out` / `.done`. `.bg-out` now fades
  the cream backdrop in lock-step with the loader's Phase 4 (§5b step 2).
- The loader respects `prefers-reduced-motion` itself, so the CSS RM block for
  the shimmer can go.

### 5e. The static `shades-mark.svg` first paint

Today `#splash-logo` shows `shades-mark.svg` immediately (no JS needed). The
loader needs `js/shades-loader.js` parsed + `createShadesLoader` mounted before
its static frame paints. To preserve a true no-flash first frame on a cold cache,
either: (a) mount the loader from a tiny inline `<script>` right after the
`#splash` markup (so it paints without waiting for `defer` app.js), or (b) keep
a CSS background-image of `shades-mark.svg` on `#splash-loader` as the pre-JS
placeholder, cleared when the SVG mounts. Recommend (a). Flag in §6.

---

## 6. Decisions — LOCKED

1. **Wordmark on the splash?** → **Mark only** (`showWordmark:false`). Matches the
   native splash + current `#splash-logo`.
2. **Ship location of the JS?** → **`js/shades-loader.js`** (fits `?v=` +
   `package.json` cp-list + `sw.js` discipline). `design/shades-loader/` stays the
   design-of-record reference.
3. **First-frame paint?** → **Flash is no longer a concern** — mount via normal
   deferred JS (no inline `<script>`, no CSS placeholder needed). Drop §5e.
4. **`gateAlreadyOpen` / mid-session re-entry:** keep the existing instant hide
   (loader not driven on that already-warm path).
5. **Native splash asset alignment:** mark-only matches the existing apple-touch
   startup image; no change there.

---

## 7. Cache-bust + branch

- Bump `?v=` for every edited file: `index.html` (markup), `js/app.js`,
  `js/ui-plan-preview.js`, the new `js/shades-loader.js`, `css/components-overlays.css`.
- Bump `CACHE_VERSION` in `sw.js` (index.html + CSS are on the SW critical path).
- Add `js/shades-loader.js` to `package.json` `build` cp-list + `sw.js` pre-cache.
- Branch off master (or stack as the workflow dictates); push → Cloudflare
  preview → user confirms → fast-forward master.
- `node scripts/validate-tokens.mjs` before merge (the loader uses raw brand
  hex internally — it's a self-contained SVG component, not a tokenized UI
  surface; if validate-tokens scans `js/shades-loader.js`, treat its ink/cream/sun
  literals as a guardrail exception like the other brand-fill literals).

---

## 8. Verification (eyeball on preview — login/photos gated on previews)

1. Cold-start: static logo paints instantly (no flash), intro plays, blinds loop
   while loading, resolve lands on the static logo, crossfade reveals the
   finished map (not loading tiles), chrome slides in. No double-logo, no shimmer
   bar remnant.
2. Fast boot (warm cache): Phase 2 plays ≤1 cycle (or zero) and resolves
   promptly — never strands on the loop.
3. Slow boot: loop continues calmly until `timeline-ready`; 8 s/2.5 s caps and
   the 12 s kill-switch still dismiss.
4. Invite link (`/i/<token>`): loader resolves → crossfade → inviter avatar pin
   visible → camera dive plays *after* the loader, into the venue. `plan-preview-active`
   chrome-hiding intact.
5. `prefers-reduced-motion`: static logo holds through load, simple opacity
   crossfade to the map. No oscillation.
6. iOS/Android (Capacitor): `cap:sync` ships `js/shades-loader.js`
   (`cap-sync-check.yml` green); native splash → loader first frame has no flash.

---

## 9. Supersedes

`chore/splash-shimmer` (commit `ed115fc` "cold-start loader is a honey shimmer
bar") was a placeholder stand-in for the real loader. This plan replaces that
shimmer bar with the designed 4-phase animation. **Retire `chore/splash-shimmer`**
once this lands (its CSS shimmer block is removed in §5d).
