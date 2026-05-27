# Backlog — native polish + perf pass

Running list of noted fixes to tackle in a focused pass (mostly native).
Captured 2026-05-26. Grouped by type; each item notes where it lives so the
pass starts fast.

## A. Native performance pass (the main ask)

- [ ] **Panel drag still very laggy on Android.** Dragging the bottom sheet
      between modes janks. Handler itself is already rAF'd + transform-based
      ([app.js](js/app.js) ~5064 `_trackDrag`), so the cost is compositing/paint
      of the panel + its 100-card list, not the handler. Profile via Chrome
      DevTools attached to the debug build (frame breakdown) before changing code.
- [ ] **Release delay/jump when dropping the panel into a new mode.** Two parts:
      (1) confirmed one-frame overshoot (~328px: 1362→1690→1543) — FLIP/re-target
      glitch in `_commitDrag` ([app.js](js/app.js) ~5120); prime suspect is the
      `requestAnimationFrame(_updatePeekHeight)` in `_applyState` (~4988) firing a
      frame after the slide starts. (2) "delays too much on release" — feel; the
      snap duration is velocity-mapped 170–320ms (~5187), may want snappier.
- [ ] (already noted) Residual map-pan lag — inherent to 3D buildings +
      sun lighting + fog. Product trade-off, not a free win.
      See [[project_android_perf]] (antialias-off already shipped).

## B. Accept-panel (plan-preview) bugs

- [ ] **Locate-me button poorly placed on desktop inside the accept panel.**
      Reposition. ([js/ui-plan-preview.js](js/ui-plan-preview.js) / detail panel
      accept page; locate-btn placement.)
- [ ] **Locate-me / pin cycle does not rotate to view the outdoor serving
      area inside the accept panel.** The camera rotate-to-wall-facing behavior
      (cf. `panToVenueCenter`, [js/render-pins.js](js/render-pins.js) ~1490) isn't
      firing in the accept-panel context. Wire it up there.

## C. Design / branding

- [ ] **Venue-list + top-bar bg → match the accept-panel treatment.** Delft blue
      at 0% opacity (`--glass-panel-bg: rgba(17,30,56,0.00)`).
      **OPEN: which blur radius?** Accept panel (`.dpacc-panel`) is `blur(6px)`
      (`--glass-blur-panel`); the 22px the note referenced is the *receive* page
      (`.dprcv-bottom`). Pick 6px (match accept exactly) or 22px (heavier frost).
      Perf-neutral either way (blur proven NOT the native bottleneck).
      `#panel` already uses alpha-0 bg + blur; `#top-strip`
      ([css/components-chrome.css](css/components-chrome.css) ~125) to align.
- [ ] **Mark + wordmark, horizontal, left-anchored to the venue list**
      (Google-Maps-style logo placement). Replaces the current top-right `brand`
      card treatment (intro reveal slides `brand` from the right —
      [app.js](js/app.js) ~8107). Horizontal lockup: mark + textmark.

## D. Loader

- [ ] **Add wordmark fade-in during the LOOP phase (Phase 2)?** Currently the
      wordmark fades in at Phase 3 (resolve) — see `tickPhase3`
      ([js/shades-loader.js](js/shades-loader.js)). Proposal: fade it in earlier,
      during the blinds loop. Evaluate visually.

---
_When picking any of these up: native changes ship via `npm run cap:sync` +
native release (Tier 3), web via push to master. The Android build/test loop is
in [[reference_android_build_blocker]]._
