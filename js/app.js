/**
 * app.js — Application state, orchestration, map setup, worker glue.
 * Loaded after solar.js and data.js. render.js, ui.js, osm.js load after this.
 * Init (updateRangeFill / update / initFacings) is called from inline script at
 * bottom of index.html after all files are loaded.
 */

// No JS viewport-height fix needed — mobile panels use position:fixed + svh units.

// ── Feature flags ─────────────────────────────────────────────────────────────
const USE_FLOATING_TIME_SLIDER = true; // round 12 — set false to revert to round-7 docked group

// ── Mutable state ─────────────────────────────────────────────────────────────
let currentSun        = null;   // {az, alt} for the FROM time
let currentSunTable   = null;   // Float64Array built once per date
let currentDateStr    = null;   // tracks which date the table belongs to
let selectedId        = null;
let editingVenueId    = null;
let editHoveredWallIdx = null;
let _editBeforeSnapshot = null;   // venue state captured when entering edit mode
let _editHasChanges    = false;   // true once any edit-mode modification is made
let popup             = null;
let nowMode           = false;
let nowInterval       = null;
let userLocation      = null;
let filterFullSunActive = false;
let filterMapViewActive = true; // viewport filter always on — list reflects what's on the map
let activeArea    = '';
let activeSortBy  = 'match';
let _userPickedSort = false; // true once the user explicitly picks a sort — locks out auto-default

// Venue list expansion. While in viewport mode (_expansionPages === 0) the
// list is filtered to venues inside the map viewport. When the user pulls up
// at the end of the list, _expansionPages is incremented and the next page
// of venues from outside the viewport is appended; the map auto-fits to show
// where they are. Reset to 0 whenever the user pans/zooms the map manually
// or when sort/area/search/date/time changes.
let _expansionPages   = 0;
// Set to true around our own programmatic camera moves (auto-fit on
// expansion, panToVenueCenter) so the moveend handler can distinguish
// "user moved the map" (reset expansion) from "we moved the map" (don't).
let _programmaticPan  = false;
let activeIntent  = null;
let panelVisible      = true;
// Consolidated hover/raise state.
//   id       — currently highlighted pin (drives glow ring); null when nothing is hovered
//   source   — 'map' | 'list'
//   raisedId — last list-hovered pin; drives pin lift; persists after cursor leaves sidebar
const highlight = { id: null, source: null, raisedId: null };
let mapLoaded         = false;
let _qcActiveSection  = null; // 'date' | 'time' | null
let _preCalPanelState = null; // saved panel state before calendar open (mobile)
let _qcCalExpanded    = false; // true = full month calendar
let _qcCalViewYear    = null;  // year shown in expanded view
let _qcCalViewMonth   = null;  // month shown in expanded view (0–11)
let _navMode          = false; // true after clicking a pin/card — use radius filter instead of map bounds
let _preSelectZoom    = null;  // zoom level saved before zooming into a selected venue
let _preSelectCenter  = null;  // map center saved before zooming into a selected venue
let _frozenBounds     = null;  // map bounds frozen at the moment of venue selection (for list filter)
let _mapMovedWhileDetailOpen = false; // true if user panned/zoomed while detail panel was open

// ── Back-button / browser history nav ────────────────────────────────────────
// Each dismissible layer ('venue', 'dp-fullscreen', 'qc', 'sort', 'profile',
// 'edit') pushes one history entry. Pressing back fires popstate → pop the top
// layer, check if it's still open, and dismiss it.
//
// UI closes (X, swipe, outside-click) call _navDropLayer() which ONLY updates
// the logical stack — it never calls history.go(). This avoids triggering
// browser navigation (which would interrupt touch gestures on mobile). The
// resulting "dead" history entries are consumed silently in the popstate handler
// via _navIsLayerOpen().
const _navStack = [];
let _navHandlingPop = false; // true while popstate handler is running

function _navPush(layer) {
  _navStack.push(layer);
  history.pushState({ navLayer: layer, navDepth: _navStack.length }, '');
}

// Remove a layer (and anything stacked on top) from the logical stack.
// Does NOT touch browser history — safe to call mid-gesture.
function _navDropLayer(layerName) {
  const idx = _navStack.lastIndexOf(layerName);
  if (idx >= 0) _navStack.splice(idx, _navStack.length - idx);
}

// Returns true if the given layer is currently active in the UI.
// Used to detect dead history entries left by UI closes.
function _navIsLayerOpen(layer) {
  switch (layer) {
    case 'venue':         return selectedId != null;
    case 'dp-fullscreen': return !!document.getElementById('detail-panel')?.classList.contains('dp-fullscreen');
    case 'qc':            return _qcActiveSection != null;
    case 'sort':          return !!document.getElementById('sort-panel')?.classList.contains('open');
    case 'filter':        return !!document.getElementById('filter-panel')?.classList.contains('open');
    case 'profile':       return !!document.getElementById('profile-panel')?.classList.contains('open');
    case 'friends':       return !!document.getElementById('friends-modal')?.classList.contains('open');
    case 'edit':          return editingVenueId != null;
    default:              return false;
  }
}

window._navPush      = _navPush;
window._navDropLayer = _navDropLayer;

// ── Time animation ────────────────────────────────────────────────────────────
const TIME_ANIM_MS = 520;
let _timeAnimId    = null;
let _timeAnimFrom  = 0;
let _timeAnimTo    = 0;
let _timeAnimStart = 0;

// ── Intro sequence state ──────────────────────────────────────────────────────
let _introMapReady  = false;
let _introGeoReady  = false;
let _introDataReady = false; // true after initFacings() + worker finish (all sun data computed)
let _introCenter    = [10.728, 59.9125]; // Oslo fallback
let _introRunning   = false;
let _introSeqId     = 0; // incremented on skip to invalidate pending timeouts
const _splashStart  = performance.now();
const SPLASH_MIN_MS = 1500; // minimum branded splash time
let _sharedVenueId  = null; // set when page is loaded via a #v= share link
let _sharedDate     = null; // date string from share link (YYYY-MM-DD)
let _sharedHour     = null; // hour (float) from share link

// ── Floating time slider (round 12) ──────────────────────────────────────────
let _ftsAppstartDone   = false; // one-shot appstart popup
let _ftsDragging       = false; // true during scrub
let _ftsHideTimeout    = null;  // scrub popup auto-hide timer
const FTS_GAP          = 8;    // px gap between pill and panel top edge

/** Update FTS position — mobile: --fts-bottom var; desktop: left edge.
 *
 *  Anchors the FTS pill above whichever .fts-host panel is currently open.
 *  Each open-state class on a host yields a target bottom-offset (in viewport
 *  units), and changing --fts-bottom triggers the CSS transition that slides
 *  the pill between positions. To register a new panel, add `.fts-host` to its
 *  root and extend `_ftsHostBottom()` with the rule that maps its open
 *  state(s) to a bottom expression. */
function _syncFtsPosition() {
  if (!USE_FLOATING_TIME_SLIDER) return;
  const ftsEl = document.getElementById('fts');
  const panel = document.getElementById('panel');
  const dp    = document.getElementById('detail-panel');
  if (!panel) return;

  // Stage 2b: FTS now lives inside #panel as a normal-flow child — no
  // JS positioning of the FTS itself is needed. Clear any leftover
  // inline styles from the previous fixed-position implementation.
  if (ftsEl) {
    ftsEl.style.left = '';
    ftsEl.style.removeProperty('--fts-left');
    ftsEl.style.removeProperty('--fts-width');
    ftsEl.style.opacity = '';
    ftsEl.style.pointerEvents = '';
  }

  const locateEl = document.getElementById('locate-btn');
  const zoomJog  = document.getElementById('zoom-jog');
  const dpOpen     = dp?.classList.contains('open');
  const isHidden   = panel.classList.contains('mobile-hidden');
  const isExpanded = panel.classList.contains('mobile-expanded');
  const isFull     = panel.classList.contains('mobile-fullscreen');

  // Resolve the panel-anchored bottom for locate-me + zoom-jog as a
  // concrete pixel value, then set inline `bottom` on each button. iOS
  // Safari doesn't transition `bottom: calc(var(--fts-bottom)...)` even
  // with @property registration, so the previous CSS-var-based anchoring
  // snapped on state change instead of riding the panel. Inline length
  // values transition reliably via the existing `transition: bottom`
  // rule. Mobile-only — desktop keeps its position-independent layout.
  // SKIPPED when plan-preview / post-accept / invite-sheet is active —
  // those modes anchor locate-btn to their own bottom-panel via CSS
  // (--pp-bottom-h or similar). Writing inline bottom here would
  // override and cause the button to overlap the takeover sheet. Clear
  // any inline bottom we left from a prior panel-state pass.
  const _isMobile = window.innerWidth < 640;
  const _isPreviewTakeover = typeof document !== 'undefined' && (
    document.body.classList.contains('plan-preview-active')
    || document.body.classList.contains('post-accept-active')
    || document.body.classList.contains('invite-sheet-open'));
  if (_isMobile && _isPreviewTakeover) {
    if (locateEl) locateEl.style.bottom = '';
    if (zoomJog)  zoomJog.style.bottom  = '';
  }
  if (_isMobile && !_isPreviewTakeover) {
    const FTS_BTM_PX = (() => {
      // Mirror _ftsHostBottom but resolve to px so transitions interpolate.
      if (editingVenueId) return null; // edit mode owns positioning
      if (dpOpen && dp) {
        if (dp.classList.contains('dp-fullscreen')) {
          // Same calc as _ftsHostBottom dp-fullscreen branch.
          return Math.round(window.innerHeight - 16 - 46 - 16 - 4 - 14);
        }
        const dpH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dp-open-h')) || dp.offsetHeight || 0;
        return Math.round(dpH + FTS_GAP);
      }
      if (panel.classList.contains('mobile-hidden')) return FTS_GAP;
      if (panel.classList.contains('mobile-fullscreen')) {
        return Math.round(window.innerHeight - 34 - 50 - 8 - 34);
      }
      if (panel.classList.contains('mobile-expanded')) {
        return Math.round(window.innerHeight * 0.5 + FTS_GAP);
      }
      const peekH = parseInt(panel.style.getPropertyValue('--peek-h')) || 252;
      return peekH + FTS_GAP;
    })();
    if (locateEl && FTS_BTM_PX != null) {
      locateEl.style.bottom = (FTS_BTM_PX + 6) + 'px';
    }
    if (zoomJog && FTS_BTM_PX != null) {
      zoomJog.style.bottom = (FTS_BTM_PX + 6 + 40 + 10) + 'px';
    }
  }

  if (locateEl) {
    if (dpOpen || isFull) {
      locateEl.style.opacity = '0';
      locateEl.style.pointerEvents = 'none';
    } else {
      locateEl.style.opacity = '';
      locateEl.style.pointerEvents = '';
    }
  }
  if (zoomJog) {
    // Edit mode owns the zoom-jog visibility via body.edit-mode CSS rules.
    if (editingVenueId) {
      zoomJog.style.opacity = '';
      zoomJog.style.pointerEvents = '';
    } else if (dpOpen || isExpanded || isFull) {
      zoomJog.style.opacity = '0';
      zoomJog.style.pointerEvents = 'none';
    } else {
      zoomJog.style.opacity = '';
      zoomJog.style.pointerEvents = '';
    }
  }

  // Track the live #detail-panel height so the FTS slider's bottom-anchor
  // stays glued to the panel's top edge even though the panel is now
  // content-fit (Sheet contract) rather than a fixed 58svh slab. Cleared
  // when the panel closes so _ftsHostBottom's fallback (58svh) kicks in
  // during the close transition. dp-fullscreen has its own branch and
  // doesn't depend on this var.
  if (dp?.classList.contains('open') && !dp.classList.contains('dp-fullscreen')) {
    document.documentElement.style.setProperty('--dp-open-h', dp.offsetHeight + 'px');
  } else {
    document.documentElement.style.removeProperty('--dp-open-h');
  }

  const ftsBottom = _ftsHostBottom(panel, dp);
  if (ftsBottom !== null) {
    document.body.style.setProperty('--fts-bottom', ftsBottom);
  }
  // (When editingVenueId, --fts-bottom is set by the ResizeObserver instead.)

  // Popup stays ABOVE the thumb — finger doesn't obscure the readout.
  // FTS has enough margin-top inside the panel to fit the compact popup;
  // expanded popup intentionally overlaps the handle area.
  const popup = document.getElementById('fts-popup');
  if (popup) popup.classList.remove('fts-popup-below');

  // Track panel state across calls so we can pan the map in sync with the list
  // when the user just located themselves and is centered on the user dot.
  const newState = isFull ? 'fullscreen' : isExpanded ? 'expanded' : isHidden ? 'hidden' : 'peek';
  if (_prevPanelMobileState && _prevPanelMobileState !== newState) {
    _maybePanMapForPanelState(_prevPanelMobileState, newState);
  }
  _prevPanelMobileState = newState;
}

/** Compute the FTS pill's mobile bottom-offset for the active fts-host panel.
 *  Detail panel wins when open. In edit mode the ResizeObserver writes
 *  --fts-bottom directly so we return null here to skip the panel-class rules.
 *  To support a new panel, add `fts-host` to its root and a branch here that
 *  maps its open-state class(es) to a CSS bottom expression. */
function _ftsHostBottom(panel, dp) {
  if (editingVenueId) return null;
  if (dp?.classList.contains('open')) {
    if (dp.classList.contains('dp-fullscreen')) {
      return `calc(100svh - env(safe-area-inset-top, 0px) - 46px - 16px - 4px - 14px)`;
    }
    // --dp-open-h is set by _syncFtsPosition each call from the live
    // detail-panel offsetHeight. Fallback to 58svh matches the pre-Sheet-
    // contract value so the FTS doesn't jump during the first paint
    // before _syncFtsPosition has run.
    return `calc(var(--dp-open-h, 58svh) + ${FTS_GAP}px)`;
  }
  if (panel.classList.contains('mobile-hidden'))     return `${FTS_GAP}px`;
  // Fullscreen: FTS sits below the chip row (not at the very top), so users
  // see a stable chip row → FTS → section bar stack instead of a slider
  // suspended above the chips. Calculation:
  //   safe-area + handle (34) + chip-row (50) + 8px gap = top edge of FTS
  if (panel.classList.contains('mobile-fullscreen')) return `calc(100svh - env(safe-area-inset-top, 0px) - 34px - 50px - 8px - 34px)`;
  if (panel.classList.contains('mobile-expanded'))   return `calc(50svh + ${FTS_GAP}px)`;
  const peekH = panel.style.getPropertyValue('--peek-h') || '160px';
  return `calc(${peekH} + ${FTS_GAP}px)`;
}

let _prevPanelMobileState = null;

/** Whole-item overflow handling for the accept-panel / invite-sheet meta
 *  rows. Browsers don't natively support "drop the last flex item when
 *  the container would overflow" — text-overflow ellipses cut mid-text
 *  on the trailing pill ("5 mi…"), which user feedback explicitly
 *  rejected. This helper measures scrollWidth vs offsetWidth after
 *  layout and hides trailing pills (with their preceding separator
 *  dot) until the row fits. Items need class `.dprcv-meta-item` (or
 *  `.dpinvite-meta-item`); dots need class `.dprcv-meta-dot` (or
 *  `.dpinvite-meta-dot`). */
window._fitMetaPills = function(container) {
  if (!container) return;
  const items = Array.from(container.querySelectorAll('.dprcv-meta-item, .dpinvite-meta-item'));
  if (items.length === 0) return;
  // Reset any previous hides so the measurement is from the full set —
  // re-renders / resizes should re-evaluate.
  for (const el of items) el.style.display = '';
  const dots = container.querySelectorAll('.dprcv-meta-dot, .dpinvite-meta-dot');
  for (const el of dots)  el.style.display = '';
  // Force layout. Bail if there's no overflow.
  if (container.scrollWidth <= container.offsetWidth + 1) return;
  // Walk the items in reverse, hiding each one + its preceding sibling
  // dot until the row fits OR only the first pill remains.
  for (let i = items.length - 1; i >= 1; i--) {
    items[i].style.display = 'none';
    const prev = items[i].previousElementSibling;
    if (prev && (prev.classList.contains('dprcv-meta-dot')
              || prev.classList.contains('dpinvite-meta-dot'))) {
      prev.style.display = 'none';
    }
    if (container.scrollWidth <= container.offsetWidth + 1) break;
  }
};

/** When the venue list expands/collapses and the map is currently centered on
 *  the user's location, animate the map so the user dot stays visually centered
 *  in the visible area above the panel — moving in lock-step with the list. */
function _maybePanMapForPanelState(prev, next) {
  if (!isMobile() || !mapLoaded || !userLocation) return;
  // Only pan on peek ↔ expanded — fullscreen has no visible map area, and
  // hidden transitions are detail-panel morphs (handled elsewhere).
  const ok = (s) => s === 'peek' || s === 'expanded';
  if (!ok(prev) || !ok(next)) return;

  const VH = window.innerHeight;
  const VW = window.innerWidth;
  const panelEl = document.getElementById('panel');
  if (!panelEl) return;
  const peekH = parseInt(panelEl.style.getPropertyValue('--peek-h')) || 252;

  function _panelTopFor(state) {
    if (state === 'expanded') return Math.round(VH * 0.50); // panel is 50svh tall
    return VH - peekH;                                       // peek
  }

  const prevVisCenterY = _panelTopFor(prev) / 2;
  const newVisCenterY  = _panelTopFor(next) / 2;
  if (Math.abs(newVisCenterY - prevVisCenterY) < 1) return;

  // Only pan when the user dot is currently near the visible center on screen.
  const userPt = map.project([userLocation.lng, userLocation.lat]);
  if (Math.abs(userPt.x - VW / 2) > VW * 0.35) return;
  if (Math.abs(userPt.y - prevVisCenterY) > 100) return;

  // Compute the map center that puts userLocation at (VW/2, newVisCenterY).
  // Shifting the geographic center on screen by (userPt - target) makes the
  // fixed lat/lng point move to the target — the camera moves with the dot.
  const centerPt = map.project(map.getCenter());
  const newCenterPt = [
    centerPt.x + (userPt.x - VW / 2),
    centerPt.y + (userPt.y - newVisCenterY),
  ];
  const newCenter = map.unproject(newCenterPt);

  // Match the panel's transition: 0.22s, cubic-bezier(0.25, 0.9, 0.4, 1).
  map.easeTo({
    center: newCenter,
    duration: 220,
    easing: _cssBezierEasing(0.25, 0.9, 0.4, 1),
  });
}

/** Build an easing function matching CSS cubic-bezier(p1x, p1y, p2x, p2y).
 *  Mapbox passes time-fraction t ∈ [0,1] and expects progress ∈ [0,1]. */
function _cssBezierEasing(p1x, p1y, p2x, p2y) {
  // Cubic Bezier 1D with P0=0, P3=1: B(s) = 3(1-s)²s·p1 + 3(1-s)s²·p2 + s³
  const _b  = (s, p1, p2) => { const u = 1 - s; return 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s; };
  const _bd = (s, p1, p2) => { const u = 1 - s; return 3 * u * u * p1 + 6 * u * s * (p2 - p1) + 3 * s * s * (1 - p2); };
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // Newton-Raphson: find s such that x(s) = t, then return y(s).
    let s = t;
    for (let i = 0; i < 6; i++) {
      const dx = _bd(s, p1x, p2x);
      if (Math.abs(dx) < 1e-6) break;
      s = Math.max(0, Math.min(1, s - (_b(s, p1x, p2x) - t) / dx));
    }
    return _b(s, p1y, p2y);
  };
}

// Localized day/month abbreviations for FTS date button (from i18n)
function _ftsDays()   { return typeof tA === 'function' ? tA('days_short') : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; }
function _ftsMonths() { return typeof tA === 'function' ? tA('months_short') : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; }

/** Initialise the floating time slider: bind events, draw canvas, show appstart popup. */
function initFts() {
  const canvas = document.getElementById('fts-canvas');
  const track  = document.getElementById('fts-track');
  if (!canvas || !track) return;

  _syncFtsPosition();
  updateHeaderDateChip();
  _populateFtsEvents();
  drawFtsCanvas();

  // Redraw the slider bitmap whenever the canvas's CSS width changes.
  // Skip during panel transitions — the canvas resizes step-by-step as the
  // panel height interpolates, which previously redrew the FTS canvas 10-15×
  // per swipe for no visible benefit. A single redraw at transitionend
  // (driven by _repaintPinsAfterPanel's downstream syncFts call) is enough.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (document.body.classList.contains('panel-transitioning')) return;
      drawFtsCanvas();
    }).observe(canvas);
  }

  // The popup is a child of #fts-track and positioned with `left: X%`,
  // so it follows the track natively when the track's margin-left or
  // bottom transitions — no transitionend reposition is needed.

  // Wire date chip tap directly (onclick can be unreliable on mobile in some edge cases)
  const calBtn = document.getElementById('header-date-chip');
  if (calBtn) {
    calBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQcPanel('date');
    });
    calBtn.removeAttribute('onclick');
  }

  // -- Pointer / touch events on the track --
  // Value snaps to the 5-min grid every move (so the popup reads as
  // discrete steps), but the thumb's visual x and the popup's x stash
  // the raw pointer hour in window._ftsRawHour. _updateFtsThumbDom and
  // showFtsPopup read it to render smoothly. On release the raw is
  // cleared and the thumb settles onto the snapped position.
  const setTimeFromPointer = (clientX) => {
    const rect = track.getBoundingClientRect();
    // Inset the pointer→time mapping by one cap radius (= track.height/2)
    // so cursor positions inside the curved ends pin to MIN/MAX instead of
    // producing intermediate times. Without this, dragging the cursor across
    // the cap area kept updating tClamped, and the popup kept showing
    // different time values even though the thumb itself was at its limit.
    const R       = rect.height / 2;
    const xMin    = R;
    const xMax    = rect.width - R;
    const xRel    = Math.max(xMin, Math.min(xMax, clientX - rect.left));
    const usable  = Math.max(1, xMax - xMin);
    const t       = MIN_H_ARC + (xRel - xMin) / usable * (MAX_H_ARC - MIN_H_ARC);
    const tClamped = Math.max(MIN_H_ARC, Math.min(MAX_H_ARC, t));
    const hour = _clampHour(t);
    if (nowMode) {
      nowMode = false;
      nowBtn?.classList.remove('active');
      timeRangeWrap?.classList.remove('now-active');
      clearInterval(nowInterval); nowInterval = null;
    }
    setActiveIntentBtn(null);
    window._ftsRawHour = tClamped;
    timeFromEl.value = hour;
    update();
    timeFromEl.dispatchEvent(new Event('input'));
    showFtsPopup(tClamped);
  };

  // Pointer down — start drag; close calendar picker if open. The popup
  // morphs from compact (just the time) into the expanded weather card
  // for the duration of the drag, then collapses back on release. The
  // DOM thumb gets .is-active for the "picked up" CSS state (scale +
  // halo + deeper shadow), and .is-tilting is cleared so it straightens.
  track.addEventListener('pointerdown', e => {
    // Drag only starts when the user grabs the thumb. Anything outside
    // the thumb passes through so the FTS area can be a panel-drag
    // surface (wired separately via _wireSwipeTarget on #fts).
    const _thumbEl = document.getElementById('fts-thumb');
    if (!_thumbEl || !_thumbEl.contains(e.target)) return;
    e.preventDefault();
    if (_qcActiveSection) _closeQcPanel();
    _ftsDragging = true;
    track.setPointerCapture(e.pointerId);
    window._qcThumbActive = true;
    _thumbEl.classList.remove('is-hover');
    _thumbEl.classList.add('is-active');
    if (typeof _injectScrubSkeletons === 'function' &&
        !document.body.classList.contains('list-scrubbing')) {
      _injectScrubSkeletons();
      document.body.classList.add('list-scrubbing');
    }
    setFtsPopupExpanded(true);
  });

  // Pointer move — drag scrub
  track.addEventListener('pointermove', e => {
    if (!_ftsDragging) return;
    setTimeFromPointer(e.clientX);
  });

  // Pointer up — end drag
  track.addEventListener('pointerup', e => {
    if (!_ftsDragging) return;
    _ftsDragging = false;
    window._qcThumbActive = false;
    window._ftsRawHour = null;
    const _thumbEl = document.getElementById('fts-thumb');
    const _popupEl = document.getElementById('fts-popup');
    if (_thumbEl) {
      _thumbEl.classList.remove('is-active');
      // Release bounce — quick compress + overshoot back to rest. CSS
      // keyframe runs for ~320ms; class self-removes after so re-press
      // doesn't compound.
      _thumbEl.classList.add('is-releasing');
      setTimeout(() => _thumbEl.classList.remove('is-releasing'), 340);
    }
    if (_popupEl) {
      _popupEl.classList.add('is-releasing');
      setTimeout(() => _popupEl.classList.remove('is-releasing'), 340);
    }
    // Settle the thumb onto the snapped position (the step shown in
    // the popup). _updateFtsThumbDom now reads timeFromEl.value since
    // _ftsRawHour was just cleared.
    _updateFtsThumbDom(parseFloat(timeFromEl.value));
    drawFtsCanvas();
    _qcSpringBackFts();
    setFtsPopupExpanded(false);
    scheduleFtsPopupHide();
    // Flush the list render NOW so the user sees the new cards on release
    // instead of waiting the full 300 ms debounce tail.
    if (typeof flushRenderListNow === 'function') flushRenderListNow();
  });

  // ── Thumb tilt-on-hover ──────────────────────────────────────────────
  // Mouse position over the track sets --tilt-x / --tilt-y CSS vars on
  // #fts-thumb. CSS uses those to drive perspective + rotateX/Y for a
  // real 3D tilt + a parallax-translated sheen. Smooth lerp so the
  // motion never jitters; suppressed during drag.
  const thumbEl = document.getElementById('fts-thumb');
  window._ftsThumbTiltCur = { x: 0, y: 0 };
  window._ftsThumbTiltTar = { x: 0, y: 0 };
  let _ftsTiltRaf = null;
  function _applyThumbTiltCss() {
    if (!thumbEl) return;
    const c = window._ftsThumbTiltCur;
    thumbEl.style.setProperty('--tilt-x', c.x.toFixed(3));
    thumbEl.style.setProperty('--tilt-y', c.y.toFixed(3));
  }
  function _ftsTiltStep() {
    const cur = window._ftsThumbTiltCur;
    const tar = window._ftsThumbTiltTar;
    const dx  = tar.x - cur.x;
    const dy  = tar.y - cur.y;
    if (Math.abs(dx) < 0.003 && Math.abs(dy) < 0.003) {
      window._ftsThumbTiltCur = { x: tar.x, y: tar.y };
      _ftsTiltRaf = null;
      _applyThumbTiltCss();
      return;
    }
    window._ftsThumbTiltCur = { x: cur.x + dx * 0.22, y: cur.y + dy * 0.22 };
    _applyThumbTiltCss();
    _ftsTiltRaf = requestAnimationFrame(_ftsTiltStep);
  }
  const _ftsTiltMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  function _ftsTiltSetTarget(target) {
    window._ftsThumbTiltTar = target;
    // Reduced motion: parallax/tilt is disabled (DESIGN.md) — snap, don't spring.
    if (_ftsTiltMq.matches) {
      window._ftsThumbTiltCur = { x: target.x, y: target.y };
      _applyThumbTiltCss();
      return;
    }
    if (!_ftsTiltRaf) _ftsTiltRaf = requestAnimationFrame(_ftsTiltStep);
  }
  function _ftsThumbPosition() {
    if (!thumbEl) return null;
    const r = thumbEl.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: r.width / 2 };
  }
  track.addEventListener('pointermove', (e) => {
    if (window._qcThumbActive) return;
    const p = _ftsThumbPosition();
    if (!p) return;
    // Hover state — visible lift + edge bump when the cursor is near
    // the thumb. Uses thumb-radius distance (proximity to the lens),
    // independent from the tilt computation below.
    const proxDx = (e.clientX - p.cx) / p.R;
    const proxDy = (e.clientY - p.cy) / p.R;
    const proxDist = Math.hypot(proxDx, proxDy);
    if (thumbEl) {
      if (proxDist < 2.5) thumbEl.classList.add('is-hover');
      else                thumbEl.classList.remove('is-hover');
    }
    // Glint drive — the highlight on the lens reads as a fixed light
    // source far above the slider. So as the cursor moves anywhere
    // along the WHOLE bar, the glint should shift accordingly: cursor
    // far right → glint shifts left (lens "tilts toward" the cursor);
    // cursor right next to the thumb → glint stays put. Normalize by
    // half the track width so the full span of the bar maps to ±1.
    const trackR = track.getBoundingClientRect();
    if (!trackR.width) return;
    const halfW = trackR.width  / 2;
    const halfH = trackR.height / 2 || 20;
    const tx = Math.max(-1, Math.min(1, (e.clientX - p.cx) / halfW));
    const ty = Math.max(-1, Math.min(1, (e.clientY - p.cy) / halfH));
    _ftsTiltSetTarget({ x: tx, y: ty });
  });
  track.addEventListener('pointerleave', () => {
    _ftsTiltSetTarget({ x: 0, y: 0 });
    if (thumbEl) thumbEl.classList.remove('is-hover');
  });

  // Pointer cancel
  track.addEventListener('pointercancel', () => {
    _ftsDragging = false;
    window._qcThumbActive = false;
    window._ftsRawHour = null;
    const _thumbEl = document.getElementById('fts-thumb');
    const _popupEl = document.getElementById('fts-popup');
    if (_thumbEl) {
      _thumbEl.classList.remove('is-active');
      _thumbEl.classList.add('is-releasing');
      setTimeout(() => _thumbEl.classList.remove('is-releasing'), 340);
    }
    if (_popupEl) {
      _popupEl.classList.add('is-releasing');
      setTimeout(() => _popupEl.classList.remove('is-releasing'), 340);
    }
    _updateFtsThumbDom(parseFloat(timeFromEl.value));
    drawFtsCanvas();
    setFtsPopupExpanded(false);
    hideFtsPopup();
    if (typeof flushRenderListNow === 'function') flushRenderListNow();
  });

  // Appstart popup: show time once for 2s, then fade
  // Deferred until body.fts is active (after intro) so element is visible
  if (!_ftsAppstartDone && document.body.classList.contains('fts')) {
    _ftsAppstartDone = true;
    const h = parseFloat(timeFromEl.value);
    showFtsPopup(h);
    scheduleFtsPopupHide(2000);
  }
}

/** Draw the weather-ramp canvas inside the floating slider track. */
function drawFtsCanvas() {
  const canvasEl = document.getElementById('fts-canvas');
  if (!canvasEl || !currentSunTable) return;
  if (!canvasEl.clientWidth) return;  // not yet visible (display:none before intro)

  const dpr  = window.devicePixelRatio || 1;
  const cssW = canvasEl.clientWidth  || 200;
  const cssH = canvasEl.clientHeight || 50;
  const pw   = Math.round(cssW * dpr);
  const ph   = Math.round(cssH * dpr);
  if (canvasEl.width !== pw || canvasEl.height !== ph) {
    canvasEl.width  = pw;
    canvasEl.height = ph;
  }
  const c = canvasEl.getContext('2d');
  c.clearRect(0, 0, pw, ph);
  c.save();
  c.scale(dpr, dpr);

  const dateStr = datePicker.value;
  const fromH   = parseFloat(timeFromEl.value);
  const isToday_ = datePicker.value === todayStr();
  const nowH_    = new Date().getHours() + new Date().getMinutes() / 60;

  // Shadow gaps for the currently-selected venue (when a detail panel is open).
  let sunWindowsForShadow = null;
  let openHour = null, closeHour = null;
  if (selectedId != null) {
    const sv = VENUES.find(x => x.id === selectedId);
    if (sv) {
      sunWindowsForShadow = computeSunWindows(sv, dateStr);
      const dayHours = (typeof getVenueHoursForDay === 'function')
        ? getVenueHoursForDay(sv, dateStr) : null;
      if (dayHours) { openHour = dayHours.open; closeHour = dayHours.close; }
    }
  }

  // Thumb is a DOM element (#fts-thumb) now — drawn outside the canvas so
  // it can use backdrop-filter:blur + CSS 3D tilt. Canvas only renders the
  // weather bands, sheen, dim overlays, hour labels, and the NÅ tick.
  drawTimeline(c, {
    cssW, cssH,
    bleed: 6,
    minH: MIN_H_ARC, maxH: MAX_H_ARC,
    dateStr,
    sunTable: currentSunTable,
    nowH: nowH_, isToday: isToday_,
    openHour, closeHour,
    sunWindows: sunWindowsForShadow,
    drawSheen: false,
    drawIndent: true,
    drawThumb: false,
  });

  c.restore();

  _updateFtsThumbDom(fromH);
  // Refresh the event row whenever the canvas redraws — cheap (idempotent
  // via signature cache) and catches weather/worker updates without a
  // separate hook.
  _populateFtsEvents();
}

/** Sync the DOM thumb's position with the slider value, or with the raw
 *  pointer hour during a smooth drag (window._ftsRawHour). Also updates
 *  the in-thumb weather icon (with push-on-direction animation when the
 *  weather state changes mid-scrub). */
function _updateFtsThumbDom(fromH) {
  const thumb = document.getElementById('fts-thumb');
  const track = document.getElementById('fts-track');
  if (!thumb || !track) return;
  const trackW = track.offsetWidth || 300;
  if (!trackW) return;
  const visualH = (typeof window._ftsRawHour === 'number') ? window._ftsRawHour : fromH;
  const xPct = (visualH - MIN_H_ARC) / (MAX_H_ARC - MIN_H_ARC);
  // Clamp by the track's cap radius (not the thumb radius). At the extreme,
  // thumb center lands at (trackW - capR, trackH/2) — concentric with the
  // pill's corner curve — so the gap between the thumb's edge and the pill's
  // curve is uniform (= capR − thumbR = 4px) all the way around the thumb,
  // matching the 4px margin on top/bottom.
  const capPx = (track.offsetHeight / 2) || 20;
  const capPct = (capPx / trackW) * 100;
  const pct = Math.max(capPct, Math.min(100 - capPct, xPct * 100));
  thumb.style.left = pct + '%';

  // Position-based glint — the bright arc on the rim tracks a fixed
  // overhead-centre sun. As the thumb slides left → right, the arc
  // rotates from upper-right (left thumb) through top (centre) to
  // upper-left (right thumb). --glint-base-angle is the conic START;
  // the gradient's peak sits 30° after that, so we offset by -30°
  // to land the peak straight up at centre.
  const tNorm = Math.max(0, Math.min(1, xPct));
  const baseAngleDeg = -tNorm * 60;  // 0° (left) → -60° (right)
  thumb.style.setProperty('--glint-base-angle', baseAngleDeg + 'deg');

  _updateThumbWxIcon(visualH);
}

/** Place the current state glyph inside the FTS thumb. State priority
 *  matches the bar: closed > shade > weather. When the state changes
 *  mid-scrub the new icon enters from the drag-direction side and the
 *  old one pushes out the other side. No animation when nothing
 *  changed.  Also toggles #fts-popup.is-closed for the expanded
 *  popup's "Closed" treatment. */
function _updateThumbWxIcon(hour) {
  const thumb = document.getElementById('fts-thumb');
  if (!thumb) return;
  const glyphs = window.TIMELINE_EVENT_GLYPHS;
  if (!glyphs) return;
  const dateStr = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : null;
  if (!dateStr || typeof getWeatherAt !== 'function') return;

  // Resolve state at this hour with closed > shade > weather priority.
  let wxKey = null;
  if (typeof selectedId !== 'undefined' && selectedId != null
      && typeof VENUES !== 'undefined') {
    const sv = VENUES.find(x => x.id === selectedId);
    if (sv) {
      if (typeof getVenueHoursForDay === 'function') {
        const dh = getVenueHoursForDay(sv, dateStr);
        if (dh) {
          if (hour < dh.open || hour >= dh.close) wxKey = 'closed';
        }
      }
      if (!wxKey && typeof computeSunWindows === 'function') {
        const sw = computeSunWindows(sv, dateStr);
        const wins = (sw && sw.windows) || [];
        if (wins.length > 0) {
          const inSun = wins.some(w => hour >= w.start && hour < w.end);
          if (!inSun) wxKey = 'shade';
        }
      }
    }
  }
  if (!wxKey) {
    const wx = getWeatherAt(dateStr, hour);
    if (wx) {
      const cf  = wx.sunBlock ?? wx.cloud ?? 0;
      // Canonical classifier (ui-shared) — one threshold set with the FTS,
      // pins, list and calendar. Three sunny tiers map to the sun/partly glyphs.
      const cls = (typeof wxClassify === 'function')
        ? wxClassify(cf, wx.precip ?? wx.prec ?? 0) : 'clear';
      wxKey = cls === 'rain'     ? 'rain'
            : cls === 'overcast' ? 'cloud'
            : cls === 'partly'   ? 'partly'
            : 'sun'; // clear / clearSoft
    }
  }
  if (!wxKey) return;

  // Sync the popup's closed state alongside the in-thumb icon.
  const popup = document.getElementById('fts-popup');
  if (popup) popup.classList.toggle('is-closed', wxKey === 'closed');

  const prevKey  = thumb._lastWxKey;
  const prevHour = thumb._lastWxHour;
  thumb._lastWxHour = hour;

  let mainIcon = thumb.querySelector('.fts-thumb-icon:not(.fts-thumb-icon-ghost)');
  const glyph  = glyphs[wxKey];
  if (!glyph) return;

  // First paint — just place the icon.
  if (!mainIcon) {
    mainIcon = document.createElement('span');
    mainIcon.className = 'fts-thumb-icon';
    mainIcon.dataset.wxKey = wxKey;
    mainIcon.innerHTML = glyph;
    thumb.appendChild(mainIcon);
    thumb._lastWxKey = wxKey;
    return;
  }
  if (prevKey === wxKey) return;

  // State changed — animate. direction: +1 = drag toward later hour.
  const direction = (prevHour != null && hour > prevHour) ? 1 : -1;

  // Old icon clone slides OUT in the opposite of drag direction.
  const ghost = mainIcon.cloneNode(true);
  ghost.classList.add('fts-thumb-icon-ghost');
  thumb.appendChild(ghost);
  requestAnimationFrame(() => {
    const exitPx = direction > 0 ? -22 : 22;
    ghost.style.transform = `translate(calc(-50% + ${exitPx}px), -50%)`;
    ghost.style.opacity   = '0';
  });
  setTimeout(() => ghost.remove(), 320);

  // New icon enters from the drag-direction side.
  const enterPx = direction > 0 ? 22 : -22;
  mainIcon.innerHTML = glyph;
  mainIcon.dataset.wxKey = wxKey;
  mainIcon.style.transition = 'none';
  mainIcon.style.transform  = `translate(calc(-50% + ${enterPx}px), -50%)`;
  mainIcon.style.opacity    = '0';
  // Force layout flush before re-enabling transition.
  void mainIcon.offsetWidth;
  requestAnimationFrame(() => {
    mainIcon.style.transition = '';
    mainIcon.style.transform  = 'translate(-50%, -50%)';
    mainIcon.style.opacity    = '1';
  });
  thumb._lastWxKey = wxKey;
}

/** Build / refresh the event row inside the FTS bar.
 *
 *  Each segment of continuous EFFECTIVE state gets one icon at its
 *  midpoint. Priority of state when a venue is selected:
 *      closed  >  shade  >  weather
 *  Closed = current hour is outside the venue's open hours.
 *  Shade  = venue selected and the hour falls in a shadow gap.
 *  Weather = sun / partly / cloud / rain bucket.
 *
 *  With no venue selected only weather states exist.
 *
 *  Animation: when the segment sequence is unchanged but positions
 *  shift (venue swap, panel open/close), each icon's left:% is updated
 *  in place and CSS transitions slide it to the new spot. When the
 *  sequence itself changes (date / weather / selection change) the row
 *  is rebuilt from scratch. */
function _populateFtsEvents() {
  const host  = document.getElementById('fts-events');
  const track = document.getElementById('fts-track');
  if (!host || !track) return;
  if (!(MAX_H_ARC > MIN_H_ARC + 0.1)) return;
  const dateStr = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : null;
  if (!dateStr) return;

  const glyphs = window.TIMELINE_EVENT_GLYPHS;
  if (!glyphs) return;

  // Weather classification — matches the canvas band thresholds.
  const wxKeyAt = (h) => {
    if (typeof getWeatherAt !== 'function') return null;
    const wx = getWeatherAt(dateStr, h + 0.5);
    if (!wx) return null;
    const rain = (wx.precip ?? wx.prec ?? 0) > 0.3;
    if (rain) return 'rain';
    const cf = wx.sunBlock ?? wx.cloud ?? 0;
    if (cf < 0.50) return 'sun';
    if (cf < 0.75) return 'partly';
    return 'cloud';
  };

  // Selected venue — pulls sun windows + open hours so we can compute
  // the shade and closed states for the bar.
  let sunWindows = null;
  let openH = null, closeH = null;
  if (typeof selectedId !== 'undefined' && selectedId != null
      && typeof VENUES !== 'undefined') {
    const sv = VENUES.find(x => x.id === selectedId);
    if (sv && typeof computeSunWindows === 'function') {
      const sw = computeSunWindows(sv, dateStr);
      sunWindows = (sw && sw.windows) || [];
    }
    if (sv && typeof getVenueHoursForDay === 'function') {
      const dh = getVenueHoursForDay(sv, dateStr);
      if (dh) { openH = dh.open; closeH = dh.close; }
    }
  }

  // Effective state at a given hour — closed beats shade beats weather.
  const effectiveStateAt = (h) => {
    if (openH != null && h < openH)  return 'closed';
    if (closeH != null && h >= closeH) return 'closed';
    if (sunWindows && sunWindows.length > 0) {
      const inSun = sunWindows.some(w => h >= w.start && h < w.end);
      if (!inSun) return 'shade';
    }
    return wxKeyAt(h);
  };

  // Build segments of continuous effective state.
  const startH = Math.ceil(MIN_H_ARC);
  const endH   = Math.floor(MAX_H_ARC);
  const segs   = [];
  let curStart = startH;
  let curState = effectiveStateAt(startH);
  for (let h = startH + 1; h <= endH; h++) {
    const s = effectiveStateAt(h);
    if (s !== curState) {
      if (curState != null) segs.push({ start: curStart, end: h, state: curState });
      curStart = h;
      curState = s;
    }
  }
  if (curState != null) segs.push({ start: curStart, end: endH + 1, state: curState });

  // Emit one icon per segment at its midpoint.
  const events = segs.map((seg, i) => ({
    hour:   (seg.start + seg.end) / 2,
    state:  seg.state,
    segKey: `${seg.state}-${i}`,
    segStart: seg.start,
    segEnd:   seg.end,
  }));

  // Current thumb hour — raw during drag, snapped otherwise. Used to fade
  // only the icon in the thumb's current segment (not crossing boundaries),
  // so the icon vanishes only as the thumb passes directly over it.
  const thumbVisualH = (typeof window._ftsRawHour === 'number')
    ? window._ftsRawHour
    : (typeof timeFromEl !== 'undefined' && timeFromEl ? parseFloat(timeFromEl.value) : null);
  // Returns opacity 0..1. Icons in adjacent segments stay fully opaque.
  // Within the active segment: 0 inside ±1 h of the thumb (fully clear so
  // the thumb's own glyph reads), ramps from 0 → 1 between ±1 h and ±2 h,
  // 1 beyond ±2 h.
  const FADE_INNER_H = 1;  // fully transparent inside this radius
  const FADE_OUTER_H = 2;  // fully opaque outside this radius
  const opacityFor = (e) => {
    if (!Number.isFinite(thumbVisualH)) return 1;
    if (thumbVisualH < e.segStart || thumbVisualH >= e.segEnd) return 1;
    const dist = Math.abs(thumbVisualH - e.hour);
    if (dist <= FADE_INNER_H) return 0;
    if (dist >= FADE_OUTER_H) return 1;
    return (dist - FADE_INNER_H) / (FADE_OUTER_H - FADE_INNER_H);
  };

  const pctFor = (e) => {
    const x = ((e.hour - MIN_H_ARC) / (MAX_H_ARC - MIN_H_ARC)) * 100;
    return Math.max(2, Math.min(98, x));
  };
  // Position via transform (px) so the drop-shadow filter follows on iOS (a
  // `left` transition lagged it). translateX to the track-% position, then
  // -50% to centre the glyph on it.
  const hostW = host.clientWidth || host.getBoundingClientRect().width || 0;
  const xFor = (e) => `translateX(${(pctFor(e) / 100 * hostW).toFixed(2)}px) translateX(-50%)`;

  // 4. Diff: if the segKey sequence matches the existing nodes, just
  //    update left:% (CSS transition slides them). Otherwise rebuild.
  const existing = Array.from(host.querySelectorAll('.fts-event'));
  const sameSequence = existing.length === events.length &&
    events.every((e, i) => existing[i].dataset.key === e.segKey);

  if (sameSequence) {
    events.forEach((e, i) => {
      existing[i].style.transform = xFor(e);
      existing[i].style.opacity = opacityFor(e);
    });
    return;
  }

  host.innerHTML = '';
  for (const e of events) {
    const glyph = glyphs[e.state];
    if (!glyph) continue;
    const node = document.createElement('div');
    node.className = 'fts-event';
    node.dataset.key = e.segKey;
    node.style.transform = xFor(e);
    node.style.opacity = opacityFor(e);
    node.innerHTML   = glyph + '<div class="fts-event-tick"></div>';
    host.appendChild(node);
  }
}

/** Spring-back animation for the FTS thumb. */
function _qcSpringBackFts() {
  window._ftsSpringOffset = 6;
  const start    = performance.now();
  const duration = 220;
  function step(now) {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 2);
    window._ftsSpringOffset = 6 * (1 - eased);
    drawFtsCanvas();
    if (p < 1) requestAnimationFrame(step);
    else { window._ftsSpringOffset = 0; drawFtsCanvas(); }
  }
  requestAnimationFrame(step);
}

/** Update the header date chip (date label + active state for picker). */
function updateHeaderDateChip() {
  const chip      = document.getElementById('header-date-chip');
  const dateLabel = document.getElementById('header-date-label');
  if (!chip || !dateLabel) return;

  const sel   = datePicker.value;
  const today = todayStr();
  const d     = new Date(sel + 'T12:00:00');
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const diffDays = Math.round((d - new Date(today + 'T12:00:00')) / 86400000);

  if (sel === today) {
    dateLabel.textContent = t('today');
  } else if (sel === tomorrowStr) {
    dateLabel.textContent = t('tomorrow');
  } else if (diffDays > 0 && diffDays <= 6) {
    // Days 1–6 ahead: weekday name only. Day 7 (next same weekday)
    // falls through to the date format below so it doesn't collide with
    // today's weekday. Locale-aware via toLocaleDateString.
    const lang = (typeof prefLang === 'function') ? prefLang() : undefined;
    const longDay = d.toLocaleDateString(lang, { weekday: 'long' });
    dateLabel.textContent = longDay.charAt(0).toUpperCase() + longDay.slice(1);
  } else {
    dateLabel.textContent = d.getDate() + '. ' + _ftsMonths()[d.getMonth()];
  }

  chip.classList.toggle('active', _qcActiveSection === 'date');
  document.getElementById('fts-date-btn')?.classList.toggle('active', _qcActiveSection === 'date');
  // Mirror date label + active state into the top-strip date link.
  const tsLabel = document.getElementById('ts-date-label');
  if (tsLabel) tsLabel.textContent = dateLabel.textContent;
  document.getElementById('ts-date-btn')?.classList.toggle('active', _qcActiveSection === 'date');
}

/** Update the sun-section bar labels and apply current scroll state.
 *  Called after every list render. Toggles ssb-empty when only one bucket
 *  has content (no morphing needed). */
function updateSunSectionBar() {
  const bar = document.getElementById('sun-section-bar');
  if (!bar) return;
  const textEl = bar.querySelector('.ssb-text');
  if (!textEl) return;

  const dateStr  = datePicker.value;
  const fromHour = parseFloat(timeFromEl.value);

  const sundownH = (typeof currentSunTable !== 'undefined' && currentSunTable
                    && typeof findSunCrossingFromTable === 'function')
    ? findSunCrossingFromTable(currentSunTable, false) : null;
  const outlook = (typeof computeCityWideSunOutlook === 'function' && sundownH != null)
    ? computeCityWideSunOutlook(dateStr, fromHour, sundownH) : null;

  // Header takes ownership of the "no sun" state — shows the message
  // and an inline "Tomorrow →" CTA. Body class drives the empty-state
  // styling (CTA shown, sort hidden) and tells renderList to skip its
  // own duplicate .empty-all block.
  const isNoSun = !!(outlook && outlook.code === 'no_sun');
  document.body.classList.toggle('day-no-sun', isNoSun);
  const ctaBtn = document.getElementById('sun-empty-cta');
  if (ctaBtn) {
    const label = ctaBtn.querySelector('.sun-empty-cta-label');
    if (label) label.textContent = t('tomorrow_arrow');
    if (!ctaBtn._wired) {
      ctaBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof advanceDay === 'function') advanceDay(1, 12);
      });
      ctaBtn._wired = true;
    }
  }

  // Always show the outlook row. On clear days the sentence is "Sun all
  // day" (or sunset-bounded variant) — it's reassuring + keeps the
  // header from going visually empty.
  bar.classList.remove('ssb-empty');
  if (!outlook || outlook.code === 'clear') {
    textEl.textContent = t('outlook_clear');
    return;
  }

  // When the slider is set to a future hour (not "now"), the outlook
  // sentences read more clearly with "at HH:MM" instead of "now":
  //   "Sun at 14:45, then cloudy from 17:00"
  // Computed once here and passed into the templates as {nowState}.
  const isFuture = (typeof nowMode !== 'undefined' && !nowMode &&
                    dateStr === todayStr() &&
                    Math.abs(fromHour - currentHour()) > 5/60)
                || dateStr > todayStr();
  const nowState = isFuture ? t('outlook_at_time', { time: formatHour(fromHour) }) : t('outlook_now');

  const p = { ...outlook.params, nowState };
  for (const k of ['start', 'end', 'aStart', 'aEnd', 'cStart', 'cEnd']) {
    if (p[k] != null) p[k] = formatHour(p[k]);
  }

  const w = p.weather === 'rain' ? 'rain' : 'cloud';
  let key;
  if (outlook.code === 'sun_then_again')   key = 'outlook_sun_then_again';
  else if (outlook.code === 'two_windows') key = `outlook_two_windows_${w}`;
  else                                     key = `outlook_${outlook.code}_${w}`;

  textEl.textContent = t(key, p);
}

/** Update the header weather chip (icon + temp + wind) for given hour. */
function updateHeaderWxChip(hour) {
  const iconEl = document.getElementById('header-wx-icon');
  const tempEl = document.getElementById('header-wx-temp');
  const windEl = document.getElementById('header-wx-wind');
  if (!iconEl && !tempEl && !windEl) return;
  if (typeof getWeatherAt !== 'function') return;

  const wx = getWeatherAt(datePicker.value, hour);
  if (!wx) {
    if (iconEl) iconEl.textContent = '';
    if (tempEl) tempEl.textContent = '';
    if (windEl) windEl.textContent = '';
    return;
  }
  const rain = (wx.precip ?? wx.prec ?? 0) > 0.3;
  if (iconEl) {
    // SVG glyphs (not emoji) — iOS WKWebView tofu's the cloud codepoints
    // even with VS-16. innerHTML is safe here: no user input flows in.
    iconEl.innerHTML = rain
      ? (typeof rainIconSvg === 'function' ? rainIconSvg() : '')
      : (typeof skyIconSvg === 'function' ? skyIconSvg(wx.sunBlock ?? wx.cloud ?? 0) : '');
  }
  if (tempEl) tempEl.textContent = wx.temp != null ? Math.round(wx.temp) + '°' : '';
  if (windEl) windEl.textContent = wx.wspd != null ? Math.round(wx.wspd) + ' m/s' : '';
}

/** Show the floating time label above the FTS thumb. Always visible while
 *  FTS is up — strictly a position+text update, no hide animation. The
 *  popup has two visual states (compact ↔ expanded with weather), toggled
 *  by `setFtsPopupExpanded`. Both states share the same horizontal anchor,
 *  so this just keeps the centerline locked to the thumb. */
function showFtsPopup(hour) {
  const popup       = document.getElementById('fts-popup');
  const timeEl      = document.getElementById('fts-popup-time');
  const wxIconEl    = document.getElementById('fts-popup-wx-icon');
  const tempEl      = document.getElementById('fts-popup-temp');
  const windEl      = document.getElementById('fts-popup-wind');
  const closedLabel = document.getElementById('fts-popup-closed-label');
  if (!popup || !timeEl) return;

  if (_ftsHideTimeout) { clearTimeout(_ftsHideTimeout); _ftsHideTimeout = null; }

  // `hour` may be raw (mid-drag) or snapped (release/idle callers).
  // Text + weather always read the snapped value so the popup steps
  // through discrete 5-min increments; position uses the raw hour so
  // the popup glides under the smoothly-moving thumb.
  const snappedHour = _clampHour(hour);
  timeEl.textContent = formatHour(snappedHour);

  // Closed detection — selected venue + hour outside open range.
  // Toggles the popup's is-closed treatment (swaps temp + wind row for
  // a "Closed" label) and uses the moon glyph for the primary icon.
  let isClosed = false;
  if (typeof selectedId !== 'undefined' && selectedId != null
      && typeof VENUES !== 'undefined'
      && typeof getVenueHoursForDay === 'function') {
    const sv = VENUES.find(x => x.id === selectedId);
    const dh = sv ? getVenueHoursForDay(sv, datePicker.value) : null;
    if (dh) isClosed = (snappedHour < dh.open || snappedHour >= dh.close);
  }
  popup.classList.toggle('is-closed', isClosed);
  if (closedLabel && isClosed) closedLabel.textContent = t('closed');

  // Weather: keep the secondary row populated even while it's collapsed, so
  // when the user starts dragging and the popup expands, the values are
  // already in place (no flash of empty content).
  const dateStr = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : null;
  if (dateStr && typeof getWeatherAt === 'function') {
    const wx = getWeatherAt(dateStr, snappedHour);
    if (wx) {
      const rain = (wx.precip ?? wx.prec ?? 0) > 0.3;
      const cf   = wx.sunBlock ?? wx.cloud ?? 0;
      const wxKey = isClosed
        ? 'closed'
        : (rain ? 'rain' : (cf < 0.50 ? 'sun' : cf < 0.75 ? 'partly' : 'cloud'));
      if (wxIconEl) wxIconEl.innerHTML = (window.TIMELINE_EVENT_GLYPHS && window.TIMELINE_EVENT_GLYPHS[wxKey]) || '';
      if (tempEl)   tempEl.textContent = wx.temp != null ? Math.round(wx.temp) + '°' : '';
      if (windEl)   windEl.textContent = wx.wspd != null ? Math.round(wx.wspd) + ' m/s' : '';
    } else {
      if (wxIconEl) wxIconEl.innerHTML = '';
      if (tempEl)   tempEl.textContent = '';
      if (windEl)   windEl.textContent = '';
    }
  }

  // Position the popup centered on the thumb. Track has overflow:visible,
  // so the popup can extend past the track's left/right ends — we clamp
  // against the viewport instead of the track. The tail (--tail-offset)
  // tracks the thumb's actual x when the body has to be clamped.
  const MIN_H = MIN_H_ARC, MAX_H = MAX_H_ARC;
  const trackEl   = document.getElementById('fts-track');
  const trackRect = trackEl ? trackEl.getBoundingClientRect() : null;
  // BCR.width reflects the *current* layout (including transitional
  // states). offsetWidth rounds + can be stale during the compact↔
  // expanded popup morph, which made the tail tip drift away from the
  // thumb mid-scrub. BCR is the reliable read here.
  const trackW    = (trackRect ? trackRect.width : trackEl?.offsetWidth) || 300;
  const trackL    = trackRect ? trackRect.left : 0;
  const popupBCR  = popup.getBoundingClientRect();
  // BCR.width includes the popup's transform: scale during the
  // .is-releasing bounce. Re-running showFtsPopup at the scaled width
  // would set polygon points and SVG width for the scaled body, then
  // the parent's transform would scale the SVG again — double-scaling
  // → tail wiggles. offsetWidth ignores transforms (intrinsic layout
  // width) and the SVG inherits the popup's transform, so the tail
  // bounces in unison with the body.
  const isBouncing = popup.classList.contains('is-releasing');
  const popupW    = isBouncing
    ? (popup.offsetWidth || popupBCR.width || 60)
    : (popupBCR.width || popup.offsetWidth || 60);
  const viewportW = window.innerWidth || trackW;

  // In mobile peek the zoom-jog floats at the bottom-right and the popup
  // can crash into it at the day's tail. Reserve space on the right when
  // peek mode is the live state. Other states (panel expanded / detail
  // open) push the zoom-jog out of the way already.
  const _zjEl = document.getElementById('zoom-jog');
  const _zjVisible = !!(_zjEl && _zjEl.offsetWidth > 0 &&
                        getComputedStyle(_zjEl).display !== 'none' &&
                        getComputedStyle(_zjEl).opacity !== '0');
  const LEFT_MARGIN  = 4;
  const RIGHT_MARGIN = _zjVisible ? 56 : 4;

  const rawPct = (hour - MIN_H) / (MAX_H - MIN_H) * 100;
  // Match the thumb's visual clamp (cap radius, not thumb radius) so the
  // popup body lands directly over the thumb at all positions.
  const _thumbEl = document.getElementById('fts-thumb');
  const _trackH  = trackEl ? trackEl.offsetHeight : 40;
  const capPxPop = (_trackH / 2) || 20;
  const capPctPop = (capPxPop / trackW) * 100;
  const thumbVisualPctEarly = Math.max(capPctPop, Math.min(100 - capPctPop, rawPct));
  // Center the popup body on the thumb — no viewport clamp. The tail's
  // offset (computed below) then stays at zero, so the popup never slides
  // sideways or angles its tail away from the thumb at the extremes.
  const pct = thumbVisualPctEarly;
  popup.style.left = pct + '%';

  // Tail geometry — anchor-and-shift (YouTube scrubber pattern).
  // The popup body is allowed to clamp against the viewport edge so its
  // text stays readable, but the tail tip points at the visual thumb
  // position. The thumb itself is clamped slightly inside the slider
  // (capPct in _updateFtsThumbDom), so the tail tip is clamped to the
  // SAME visual range — otherwise the tail overshoots the visible thumb
  // at extreme hours (rawPct can hit 100% while the thumb visually stops
  // at 95%). Shoulders stay on the popup's flat bottom outline.
  const tailSvg = document.getElementById('fts-popup-tail');
  if (tailSvg) {
    const polyBase    = tailSvg.querySelector('polygon.tail-base');
    const polyOverlay = tailSvg.querySelector('polygon.tail-overlay');
    const polyline    = tailSvg.querySelector('polyline');
    const poly        = polyBase || tailSvg.querySelector('polygon');
    if (poly) {
      const TAIL_HALF = 7;
      // Tail must bridge popup-bottom (6 px above track top) and thumb-top
      // (4 px below track top) — total 10 px — or the tip floats above the
      // thumb with a visible gap.
      const TIP_DEPTH = 10;

      // Visual thumb clamping — match _updateFtsThumbDom (cap radius, not
      // thumb radius) so the tail tip lands on the thumb circle.
      const thumbCapPx = (_trackH / 2) || 20;
      const thumbCapPct = (thumbCapPx / trackW) * 100;
      const thumbVisualPct = Math.max(thumbCapPct,
                                      Math.min(100 - thumbCapPct, rawPct));
      const tailOffsetPx = (thumbVisualPct - pct) * trackW / 100;
      const tipX = popupW / 2 + tailOffsetPx;

      // Shoulder center clamped so both shoulders remain on the popup's
      // flat bottom outline (avoids the corner-curve area).
      const r = parseFloat(getComputedStyle(popup).borderTopLeftRadius) || 10;
      const minAttach = TAIL_HALF + r;
      const maxAttach = popupW - TAIL_HALF - r;
      const attachX = (maxAttach < minAttach)
        ? popupW / 2
        : Math.max(minAttach, Math.min(maxAttach, tipX));
      const sLx = attachX - TAIL_HALF;
      const sRx = attachX + TAIL_HALF;

      tailSvg.setAttribute('width',  popupW);
      tailSvg.setAttribute('height', TIP_DEPTH);
      const points = `${sLx},0 ${sRx},0 ${tipX},${TIP_DEPTH}`;
      if (polyBase)    polyBase.setAttribute('points', points);
      if (polyOverlay) polyOverlay.setAttribute('points', points);
      if (!polyBase)   poly.setAttribute('points', points);
      // Polyline strokes only the two slanted sides (not the top edge,
      // which sits flush with the popup's bottom border). Continues the
      // popup's hairline visually into the tail.
      if (polyline) {
        polyline.setAttribute('points',
          `${sLx},0 ${tipX},${TIP_DEPTH} ${sRx},0`);
      }
    }
  }

  popup.classList.add('visible');
}

/** Toggle the popup's expanded (weather) state. The morph happens via CSS
 *  transitions on padding/border-radius/secondary-row max-height. The
 *  popup's `left` is a percent of the track, so the centerline stays
 *  locked on the thumb regardless of the new width. */
function setFtsPopupExpanded(expanded) {
  const popup = document.getElementById('fts-popup');
  if (!popup) return;
  popup.classList.toggle('fts-popup-expanded', !!expanded);
  // The compact↔expanded morph runs as a 180 ms CSS transition on the
  // popup's padding / border-radius / secondary-row max-height, which
  // changes popupW continuously. showFtsPopup recomputes the tail tip
  // from popupW, but it's only normally called on slider input — so on
  // shrink-back the tail's last-set polygon (sized for the wide popup)
  // floats to the right of the now-compact body. Drive showFtsPopup per
  // frame for the duration of the morph so the tail tracks.
  const startTs = performance.now();
  const tick = (now) => {
    if (typeof timeFromEl !== 'undefined' && timeFromEl) {
      const h = (typeof window._ftsRawHour === 'number')
        ? window._ftsRawHour : parseFloat(timeFromEl.value);
      showFtsPopup(h);
    }
    if (now - startTs < 220) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Hide the floating time label. (Retained for API compatibility — the label
 *  is now always visible, so this is a no-op.) */
function hideFtsPopup() {
  if (_ftsHideTimeout) { clearTimeout(_ftsHideTimeout); _ftsHideTimeout = null; }
}

/** Schedule popup auto-hide after a delay. */
function scheduleFtsPopupHide(ms) {
  if (_ftsHideTimeout) clearTimeout(_ftsHideTimeout);
  _ftsHideTimeout = setTimeout(hideFtsPopup, ms || 1500);
}

/** Sync floating slider state with current app state (called from update). */
function syncFts() {
  if (!USE_FLOATING_TIME_SLIDER) return;
  drawFtsCanvas();
  updateHeaderDateChip();
  updateHeaderWxChip(parseFloat(timeFromEl.value));
  // Keep the floating time label in sync with the current slider value
  if (document.body.classList.contains('fts')) {
    showFtsPopup(parseFloat(timeFromEl.value));
  }
  // Desktop: keep the popup permanently populated + positioned. It's CSS-
  // forced to opacity:1 on desktop, so without a refresh on each update() it
  // would freeze with stale time/weather while the user changed date/time.
  if (!isMobile() && document.body.classList.contains('fts')) {
    if (_ftsHideTimeout) { clearTimeout(_ftsHideTimeout); _ftsHideTimeout = null; }
    _ftsAppstartDone = true;
    const h = parseFloat(timeFromEl.value);
    showFtsPopup(h);
    return;
  }
  // Mobile: trigger appstart popup on first sync after FTS becomes visible
  if (!_ftsAppstartDone && document.body.classList.contains('fts')) {
    _ftsAppstartDone = true;
    const h = parseFloat(timeFromEl.value);
    showFtsPopup(h);
    scheduleFtsPopupHide(2000);
  }
}

// ── Sun window cache ──────────────────────────────────────────────────────────
// Keyed by `${venueId}-${dateStr}`. Populated by the worker (background) and
// by computeSunWindows() on cache miss (sync fallback on the main thread).
const sunWindowCache = new Map();

/**
 * Get sun windows for a venue, using cache if available.
 * On cache miss: when a worker is available, compute the fast (simple-facing)
 * variant — the worker is computing the precise (shadow-casting) variant in
 * parallel and will overwrite this entry when it finishes. Without `fast`,
 * a wholesale cache wipe (e.g. on date change) would force ~22M shadow checks
 * on the main thread and freeze the UI for 1–2 s at 300+ venues.
 * On file:// (no worker) we fall back to the precise sync computation.
 */
function computeSunWindows(venue, dateStr) {
  const key = `${venue.id}-${dateStr}`;
  if (sunWindowCache.has(key)) return sunWindowCache.get(key);
  // currentSunTable is built for whatever date the user is currently
  // viewing (datePicker.value). For dates OTHER than that — e.g.
  // _findFirstSunDayAndHour scanning the next 7 days for an exit-to-
  // explore landing — using the wrong table gives sun positions for
  // the WRONG day. v1 cached results per dateStr but still used the
  // stale table for the actual computation, so 'next day with sun'
  // never picked up the real next-day sun. Build a fresh table when
  // the requested date doesn't match the viewer's current date.
  const viewerDate = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : null;
  const table = (dateStr === viewerDate && currentSunTable)
    ? currentSunTable
    : buildSunTable(dateStr);
  // Also seed currentSunTable on first ever call (defensive).
  if (!currentSunTable) currentSunTable = table;
  const result = computeSunWindowsFromTable(venue, table, { fast: !!sunWorker });
  sunWindowCache.set(key, result);
  return result;
}

// ── Web Worker ────────────────────────────────────────────────────────────────
// Workers require a server origin (http://). On file:// the constructor throws a
// SecurityError, so we wrap it and fall back to sync computation gracefully.
let sunWorker = null;
// Generation counter: incremented on each dispatch so stale results from an
// earlier dispatch (e.g. the pre-initFacings() worker that lacks nearbyBuildings)
// are silently discarded instead of overwriting the correct cache.
let _workerGeneration = 0;

// Boot-time signal: has the worker delivered its first batch of sun
// windows? The intro path waits on this before fading the splash, so the
// first heavy classifyPin pass hits the precise (worker-computed) cache
// instead of the sync fallback (which is ~22M shadow checks for ~300
// venues — a 200-500ms main-thread freeze on mid-tier mobile).
let _bootWorkerReady = false;
const _bootWorkerReadyCbs = [];
function _onBootWorkerReady(cb, maxWaitMs) {
  if (_bootWorkerReady) { cb(); return; }
  _bootWorkerReadyCbs.push(cb);
  if (maxWaitMs && maxWaitMs > 0) {
    setTimeout(() => {
      const idx = _bootWorkerReadyCbs.indexOf(cb);
      if (idx >= 0) {
        _bootWorkerReadyCbs.splice(idx, 1);
        cb();
      }
    }, maxWaitMs);
  }
}
try {
  sunWorker = new Worker('js/worker.js');
  sunWorker.onmessage = function(e) {
    const { type, dateStr, result } = e.data;
    if (type !== 'result') return;
    // Discard stale results if the user changed the date while the worker was running
    if (dateStr !== datePicker.value) return;
    // Accept all generations. The worker is FIFO, so an older-gen result is
    // just an earlier snapshot (e.g. pre-initFacings simple-facing windows)
    // that a newer-gen result will overwrite naturally. Letting it land keeps
    // the cache warm and prevents sync-compute freezes during the gap before
    // the precise post-initFacings result arrives.
    for (const [idStr, windows] of Object.entries(result)) {
      sunWindowCache.set(`${idStr}-${dateStr}`, windows);
    }
    // Sprites may have been built against the sync-fallback windows; rebuild them
    // now that the worker has confirmed (or corrected) the sun window data.
    clearSpriteCache();
    // Worker may have replaced sync-fallback windows with precise ones — drop
    // the classifyPin cache so pin tiers re-evaluate against the new windows.
    if (typeof invalidateClassifyPin === 'function') invalidateClassifyPin();
    // First worker batch — fire any pending boot-wait callbacks so the
    // intro can release the draw gate and start the splash fade.
    if (!_bootWorkerReady) {
      _bootWorkerReady = true;
      const cbs = _bootWorkerReadyCbs.splice(0);
      for (const cb of cbs) { try { cb(); } catch (e) { console.warn('[boot] worker-ready cb threw', e); } }
    }
    // Refresh audit flag chips now that we have accurate sun windows.
    if (typeof refreshReviewFlags === 'function' &&
        typeof auditModeActive !== 'undefined' && auditModeActive) {
      refreshReviewFlags(dateStr);
    }
    // Re-render with worker-computed data. drawAllCardTimelines runs
    // with no root so it scans the whole document — important because
    // the accept page's timeline (.dprcv-timeline-canvas) lives OUTSIDE
    // #venue-list and was previously stuck with the sync-fallback
    // 'simple facing' windows even after the worker corrected them.
    // Result: bar showed sunny while the polygon + scrubber label
    // (both reading the corrected cache) showed shade.
    draw();
    // The worker corrects an already-rendered card set (sync-fallback → precise
    // windows). Render silently so the cardIn cascade doesn't re-fire — that
    // re-animation was the "list flashes/updates a moment after load". The
    // user-facing renders (date/sort/filter/scrub-release) animate via their
    // own renderList calls; this correction just updates values in place.
    window._renderListSilent = true;
    try { renderList(); } finally { window._renderListSilent = false; }
    if (typeof drawAllCardTimelines === 'function') drawAllCardTimelines();
    // The accept page's in-bar weather row was populated once at initial
    // RAF against the sync-fallback windows; now that the worker has
    // corrected the cache, refresh it so the glyphs re-bucket against the
    // precise sun-window boundaries. Without this the bar updated (canvas
    // redraw) but the weather icons stayed locked to stale shade/sun
    // bands — user would see a 'partly' glyph over what's now a sun band.
    document.querySelectorAll('.dprcv-timeline-weather').forEach(host => {
      if (typeof host._refresh === 'function') host._refresh();
    });
    // Same correction for the hero's right-subtitle (Sun until X,
    // remaining duration, meet-time temp) — built once from the
    // sync-fallback windows, can show e.g. '20:40' while the bar's
    // precise data has sun until 21:20.
    if (typeof window._refreshAcceptPageHero === 'function') window._refreshAcceptPageHero();
    // Reveal any plan-preview timelines that were masked while we
    // waited for the precise windows. Idempotent.
    document.body.classList.add('timeline-ready');
  };
} catch (e) {
  console.warn('Web Worker unavailable (run via http:// for background computation):', e.message);
}

function dispatchToWorker(dateStr) {
  if (!sunWorker || !currentSunTable) return;
  const gen = ++_workerGeneration;
  const venues = VENUES.map(v => ({
    id:               v.id,
    facing:           v.facing,
    openingHours:     v.openingHours,
    lat:              v.lat,
    lng:              v.lng,
    terraceType:      v.terraceType       ?? null,
    nearbyBuildings:  v.nearbyBuildings   ?? null,
    wallSegment:      v.wallSegment       ?? null,
    terraceTestPoints: v.terraceTestPoints ?? null,
  }));
  // Slice the buffer so we transfer a copy, keeping currentSunTable intact on main thread
  const transferBuf = currentSunTable.buffer.slice(0);
  sunWorker.postMessage({ type: 'compute', venues, sunTableBuffer: transferBuf, dateStr, generation: gen }, [transferBuf]);
}

// ── Map ───────────────────────────────────────────────────────────────────────
mapboxgl.accessToken = MAPBOX_TOKEN; // defined in js/config.js (gitignored)
const map = new mapboxgl.Map({
  container: 'map',
  style: buildShadeStyle(),
  center: [10.728, 59.9125],
  // 14 = Google Maps' "neighbourhood" level for Oslo. 13 read as Sentrum-
  // only; 12 (a/b round) was too wide — too many off-screen pins after the
  // intro settle. 14 keeps Aker brygge → Grünerløkka in frame.
  zoom: 14,
  pitch: 15,
  // MSAA is very expensive on native WebViews at device DPR (the S25's
  // ~1440×3120 WebGL surface), and it's the dominant per-frame cost during
  // map pan/zoom. Disable on native (Capacitor); keep on web/desktop where
  // the GPU budget is ample and the smoother edges are worth it.
  antialias: !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()),
  attributionControl: false,
});

map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

// ── User location dot ─────────────────────────────────────────────────────────
function _updateLocationDot() {
  const el = document.getElementById('user-location-dot');
  if (!el || !mapLoaded) return;
  if (!userLocation) { el.style.display = 'none'; return; }
  const pt = map.project([userLocation.lng, userLocation.lat]);
  el.style.left    = Math.round(pt.x) + 'px';
  el.style.top     = Math.round(pt.y) + 'px';
  el.style.display = '';
}

/** Apply a new locate-cycle state to the button — swaps state classes
 *  AND animates the icon (push-down: previous icon slides out
 *  translateY(100%), new icon slides in from translateY(-100%)). All
 *  callers (selectVenue / closeDetailPanel / _locateCycleForVenue /
 *  openPlanPreview / closePlanPreview / _planPreviewLocate) go through
 *  this so the animation is consistent across surfaces.
 *
 *  newState ∈ null | 'venue' | 'dive' | 'fit' | 'user'.
 *  Maps to icon: null/fit → user, venue/dive → fit, user → venue. */
function _setLocateBtnState(newState) {
  const btn = document.getElementById('locate-btn');
  if (!btn) return;
  const iconForState = {
    null:  'locate-icon-user',
    venue: 'locate-icon-fit',
    dive:  'locate-icon-fit',
    fit:   'locate-icon-user',
    user:  'locate-icon-venue',
  };
  const newIconCls = iconForState[newState || 'null'] || 'locate-icon-user';
  btn.classList.remove('locate-state-venue', 'locate-state-dive', 'locate-state-fit', 'locate-state-user');
  if (newState) btn.classList.add('locate-state-' + newState);
  const prevActive = btn.querySelector('.locate-icon.is-active');
  const newActive  = btn.querySelector('.' + newIconCls);
  if (prevActive === newActive) return;
  if (prevActive) {
    prevActive.classList.add('is-leaving');
    prevActive.classList.remove('is-active');
    setTimeout(() => prevActive.classList.remove('is-leaving'), 280);
  }
  if (newActive) newActive.classList.add('is-active');
}
window._setLocateBtnState = _setLocateBtnState;
// Seed the initial visible icon (user/crosshair) so the very first tap
// animates cleanly instead of popping the icon in from nowhere.
if (typeof document !== 'undefined') {
  const _seed = () => _setLocateBtnState(null);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _seed);
  else _seed();
}

function locateUser() {
  // Plan-preview takeover owns the locate button while it's active — the
  // 3-state cycle (dive ↔ fit ↔ user) is handled by _planPreviewLocate
  // in ui-plan-preview.js, which has access to the invited venue's coords.
  if (typeof _planPreviewLocate === 'function' && typeof _planPreviewState !== 'undefined' && _planPreviewState) {
    return _planPreviewLocate();
  }
  // Detail-panel context: 3-state cycle venue → fit → user → venue.
  // Same affordance as plan-preview so the locate button has the same
  // 'where do I want the camera' semantics whenever the user is focused
  // on a specific venue. Without this, locate was a single-shot 'fly
  // to me' that left the venue out of frame after one tap.
  const dpOpen = document.getElementById('detail-panel')?.classList.contains('open');
  if (dpOpen && selectedId != null) {
    return _locateCycleForVenue(selectedId);
  }
  if (!userLocation) return;
  _aTrack('locate_user', {});
  // Dismiss keyboard / search if active so the map is visible
  const si = document.getElementById('venue-search');
  if (si && document.activeElement === si) si.blur();
  const btn = document.getElementById('locate-btn');
  if (btn) { btn.classList.add('tracking'); setTimeout(() => btn.classList.remove('tracking'), 1200); }
  // Account for the bottom panel covering part of the map: pass padding so
  // the user dot lands in the *visible* (non-occluded) portion, not the
  // viewport center. Padding shifts the camera's logical center.
  let padding;
  if (isMobile()) {
    const panelEl = document.getElementById('panel');
    let panelTop = window.innerHeight;  // panel hidden = no occlusion
    if (panelEl && !panelEl.classList.contains('mobile-hidden')) {
      const r = panelEl.getBoundingClientRect();
      // r.top is where the visible top of the panel sits in the viewport.
      // Below that line is occluded by the panel.
      if (r.top > 0 && r.top < window.innerHeight) panelTop = r.top;
    }
    const occluded = Math.max(0, window.innerHeight - panelTop);
    // Reserve 56px for the search bar at the top + safe-area
    padding = { top: 80, bottom: occluded + 16, left: 16, right: 16 };
  } else {
    padding = { top: 96, bottom: 96, left: 16, right: 16 };
  }
  map.flyTo({
    center: [userLocation.lng, userLocation.lat],
    zoom: Math.max(map.getZoom(), 15.2),
    duration: 600,
    padding,
  });
}

// Detail-panel locate cycle: venue → fit → user → venue. Mirrors the
// plan-preview locate behaviour so the same button has the same
// semantics whenever a specific venue is on screen. State lives on
// the button's class (locate-state-venue / locate-state-fit /
// locate-state-user) so the icon swap is purely CSS-driven.
function _locateCycleForVenue(venueId) {
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  if (!v || typeof map === 'undefined' || !map) return;
  const btn = document.getElementById('locate-btn');
  const hasUser = userLocation && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng);

  // Read the current state from the button's class. Fall back to 'venue'
  // since the detail panel always opens with the camera framed on the
  // venue (selectVenue runs _flyToVenue before this is hit).
  const cur = btn?.classList.contains('locate-state-fit')  ? 'fit'
            : btn?.classList.contains('locate-state-user') ? 'user'
            : 'venue';
  let next;
  if (!hasUser) {
    next = 'venue'; // collapse to single-state when geolocation isn't available
  } else if (cur === 'venue') next = 'fit';
  else if (cur === 'fit')     next = 'user';
  else                        next = 'venue';

  _setLocateBtnState(next);
  if (btn) {
    btn.classList.add('tracking');
    setTimeout(() => btn.classList.remove('tracking'), 1200);
  }
  if (typeof _aTrack === 'function') _aTrack('locate_cycle', { state: next, venue_id: venueId });

  // Bottom padding accounts for the detail panel covering part of the map.
  let bottomPad = 16;
  if (isMobile()) {
    const dp = document.getElementById('detail-panel');
    if (dp && dp.classList.contains('open')) {
      const r = dp.getBoundingClientRect();
      if (r.top > 0 && r.top < window.innerHeight) bottomPad = window.innerHeight - r.top + 16;
    }
  }
  const padding = { top: 96, bottom: bottomPad, left: 24, right: 24 };

  if (next === 'fit' && hasUser) {
    const sw = [Math.min(v.lng, userLocation.lng), Math.min(v.lat, userLocation.lat)];
    const ne = [Math.max(v.lng, userLocation.lng), Math.max(v.lat, userLocation.lat)];
    try {
      map.fitBounds([sw, ne], {
        padding: isMobile()
          ? padding
          : { top: 96, bottom: 96, left: 720, right: 80 },
        maxZoom: 15.5,
        pitch: 30,
        bearing: 0,
        duration: 700,
      });
    } catch (e) { /* ignore */ }
    return;
  }
  if (next === 'user' && hasUser) {
    try {
      map.easeTo({
        center: [userLocation.lng, userLocation.lat],
        zoom: 16,
        pitch: 45,
        bearing: 0,
        duration: 700,
        padding,
      });
    } catch (e) { /* ignore */ }
    return;
  }
  // 'venue' — re-run the same dive _flyToVenue uses on initial selection.
  _flyToVenue(v);
}

// Sync the location dot to Mapbox's frame loop. v1 used a standalone
// requestAnimationFrame; that ran in a separate frame slot from Mapbox's
// tile commit, so the dot visibly trailed the map by ~16ms during pan.
// Hooking 'render' keeps the dot's screen position commit in the SAME
// browser tick as Mapbox's tile commit.
let _locDotDirty = false;
const _markLocDotDirty = () => { _locDotDirty = true; };
map.on('move',    _markLocDotDirty);
map.on('moveend', _markLocDotDirty);
map.on('zoomend', _markLocDotDirty);
map.on('render',  () => {
  if (!_locDotDirty) return;
  _locDotDirty = false;
  _updateLocationDot();
});
map.on('zoom',    _updateZoomDebug);
map.on('pitch',   _updateZoomDebug);

// ── Zoom jog slider ─────────────────────────────────────────────────────────
(function initZoomJog() {
  const el    = document.getElementById('zoom-jog');
  const track = el?.querySelector('.zj-track');
  const thumb = el?.querySelector('.zj-thumb');
  if (!el || !track || !thumb) return;

  const MAX_PX     = 30;   // max thumb displacement from center (px)
  const ZOOM_RATE  = 3.5;  // zoom levels per second at full deflection
  const EASE_POW   = 2;    // quadratic acceleration curve

  let active   = false;
  let rafId    = null;
  let lastTime = 0;
  let displacement = 0;    // -1 … +1  (negative = zoom in, positive = zoom out)

  function _setThumbPos(d) {
    // d is normalised -1…+1, clamped
    displacement = Math.max(-1, Math.min(1, d));
    const offsetY = displacement * MAX_PX;
    thumb.style.transform = `translate(-50%, calc(-50% + ${offsetY}px))`;
    thumb.style.transition = 'background 0.15s'; // remove snap transition during drag
  }

  function _snapBack() {
    displacement = 0;
    thumb.style.transition = 'transform 0.25s cubic-bezier(0.25, 0.9, 0.4, 1), background 0.15s';
    thumb.style.transform  = 'translate(-50%, -50%)';
    thumb.classList.remove('active');
  }

  function _zoomLoop(ts) {
    if (!active) return;
    if (!lastTime) { lastTime = ts; rafId = requestAnimationFrame(_zoomLoop); return; }
    const dt = (ts - lastTime) / 1000;
    lastTime = ts;

    if (Math.abs(displacement) > 0.05) {
      // Quadratic curve: gentle near center, aggressive at edges
      const sign  = displacement > 0 ? -1 : 1; // drag down → zoom out (negative), drag up → zoom in (positive)
      const power = Math.pow(Math.abs(displacement), EASE_POW);
      const dz    = sign * power * ZOOM_RATE * dt;
      const z     = map.getZoom() + dz;
      map.setZoom(Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z)));
    }
    rafId = requestAnimationFrame(_zoomLoop);
  }

  function _start(clientY, e) {
    e.preventDefault();
    e.stopPropagation();
    active = true;
    lastTime = 0;
    thumb.classList.add('active');
    // Engage the pin renderer's motion gate so labels ride their pins (cached
    // anchors) during the jog instead of re-scoring every frame — same as a
    // pan/pinch. setZoom() doesn't reliably drive that gate, so do it here.
    if (typeof window._setZoomJogActive === 'function') window._setZoomJogActive(true);
    const trackRect = track.getBoundingClientRect();
    const center    = trackRect.top + trackRect.height / 2;
    _setThumbPos((clientY - center) / MAX_PX);
    rafId = requestAnimationFrame(_zoomLoop);
  }

  function _move(clientY) {
    if (!active) return;
    const trackRect = track.getBoundingClientRect();
    const center    = trackRect.top + trackRect.height / 2;
    _setThumbPos((clientY - center) / MAX_PX);
  }

  function _end() {
    if (!active) return;
    active = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (typeof window._setZoomJogActive === 'function') window._setZoomJogActive(false);
    _snapBack();
  }

  // Pointer events on the whole element (not just thumb) so tapping track also works
  el.addEventListener('pointerdown', e => { _start(e.clientY, e); el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', e => { if (active) _move(e.clientY); });
  el.addEventListener('pointerup',   _end);
  el.addEventListener('pointercancel', _end);
  el.addEventListener('lostpointercapture', _end);
})();

function _updateZoomDebug() {
  const zoomDebug = document.getElementById('zoom-debug');
  if (zoomDebug && !zoomDebug.classList.contains('hidden')) {
    const hour = parseFloat(timeFromEl.value);
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    const timeStr = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    zoomDebug.textContent = `${timeStr} | zoom: ${map.getZoom().toFixed(2)} | tilt: ${map.getPitch().toFixed(1)}°`;
  }
}

function toggleZoomDebugHelper() {
  // Admin-only feature
  if (typeof authIsAdmin !== 'function' || !authIsAdmin()) return;

  const zoomDebug = document.getElementById('zoom-debug');
  const label = document.getElementById('zoom-debug-toggle-label');
  if (!zoomDebug || !label) return;

  const isHidden = zoomDebug.classList.toggle('hidden');
  zoomDebug.style.display = isHidden ? 'none' : '';
  label.textContent = isHidden ? 'Show Debug' : 'Hide Debug';
  localStorage.setItem('solsteder_zoom_debug_visible', !isHidden);

  if (!isHidden) {
    _updateZoomDebug();
  }
}

function _initZoomDebugVisibility() {
  const zoomDebug = document.getElementById('zoom-debug');
  if (!zoomDebug) return;

  // Start hidden by default, only show if explicitly enabled by admin
  const shouldShow = localStorage.getItem('solsteder_zoom_debug_visible') === 'true'
    && typeof authIsAdmin === 'function' && authIsAdmin();
  if (shouldShow) {
    zoomDebug.classList.remove('hidden');
    zoomDebug.style.display = '';
  } else {
    zoomDebug.classList.add('hidden');
    zoomDebug.style.display = 'none';
  }
}

function _onMapStyleReady() {
  if (mapLoaded) return;           // already handled
  mapLoaded = true;

  if (!editSatelliteActive) {
    map.setFog({
      range: [1, 10],
      color: 'rgba(160, 180, 210, 0.25)',
      'horizon-blend': 0.04,
      'high-color': '#1a3a6e',
      'space-color': '#0a0a1e',
      'star-intensity': 0.2
    });
  }

  updateSunLighting();
  _updateZoomDebug();
  _initZoomDebugVisibility();

  _introMapReady = true;
  _introCheckReady();
}

map.on('style.load', _onMapStyleReady);
map.on('load', _onMapStyleReady);

// If map is already loaded by the time we register listeners (cached style),
// fire immediately
if (map.isStyleLoaded()) _onMapStyleReady();

map.on('error', (e) => {
  console.error('Mapbox GL error:', e.error);
  // If style fails to load, still mark as ready so intro can proceed
  if (!mapLoaded) {
    mapLoaded = true;
    _introMapReady = true;
    _introCheckReady();
  }
});

// Fallback: if map style never loads, proceed after 8 seconds
setTimeout(() => {
  if (!_introMapReady) {
    _introMapReady = true;
    _introCheckReady();
  }
}, 8000);

// Fallback: if geometry data never loads, proceed after 6 seconds
setTimeout(() => {
  if (!_introDataReady) {
    console.warn('[intro] data readiness timeout — proceeding without geometry');
    _introDataReady = true;
    _introCheckReady();
  }
}, 6000);

// Show loader only if map is still loading after the branded splash minimum
setTimeout(() => {
  if (!_introRunning) {
    const loader = document.getElementById('splash-loader');
    if (loader) loader.classList.add('visible');
  }
}, SPLASH_MIN_MS);

// Safety net: if splash is still visible after 12s, force-skip
setTimeout(() => {
  if (!_introRunning) {
    _introMapReady  = true;
    _introGeoReady  = true;
    _introDataReady = true;
    _skipIntro();
  }
}, 12000);

// ── Sun lighting (Mapbox GL v3) ───────────────────────────────────────────────
// Fixed neutral white light: the basemap palette stays brand-stable across
// the time slider, and the moving 3D shadows carry the time-of-day story.
function updateSunLighting() {
  if (!mapLoaded || !currentSun) return;
  const { az, alt } = currentSun;
  if (alt > 0) {
    // Lift ambient (0.30→0.42) + lower directional intensity (0.9→0.78)
    // so the lit/shadow contrast drops. The shadow-map aliasing (stair-
    // stepping along shadow edges, flickering on zoom) is intrinsic to
    // Mapbox's renderer — there's no soft-shadow knob — so the only
    // lever we have is contrast. Lower contrast makes the jaggy edge
    // pixels much less visible without losing the shadow story.
    map.setLights([
      {
        id: 'sun',
        type: 'directional',
        properties: {
          direction: [az, 90 - alt],
          'cast-shadows': true,
          intensity: 0.78,
          color: '#ffffff',
        }
      },
      {
        id: 'ambient',
        type: 'ambient',
        properties: { intensity: 0.42, color: '#ffffff' }
      }
    ]);
  } else {
    map.setLights([
      {
        id: 'ambient',
        type: 'ambient',
        properties: { intensity: 0.45, color: '#ffffff' }
      }
    ]);
  }
}

// ── Canvas ────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas-overlay');
const ctx    = canvas.getContext('2d');

// ── DOM refs (all defined after DOMContentLoaded since scripts are at end of body) ──
const datePicker      = document.getElementById('date-picker');
const timeFromEl      = document.getElementById('time-from');
const timeDisplayFrom = document.getElementById('time-display-from');
const nowBtn          = document.getElementById('now-btn');
const timeRangeWrap   = document.getElementById('time-range-wrap');
const tooltip         = document.getElementById('hover-tooltip');

// ── Utility formatters ────────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ── Explore-mode post-flow helper ───────────────────────────────────────────
// After the user declines an invite (or closes the detail panel they
// landed on after accepting), drop them into a state that invites
// exploration: the first day with sun, the start of its earliest sun
// window, camera centred on their geolocation, venue list expanded.
// Used by ui-plan-preview.js's decline handler and the closeDetailPanel
// post-accept hook (window._exitToExploreOnDetailClose). Universal: any
// auto-day-switch from here triggers a "Now showing {day}" notification.
function _findFirstSunDayAndHour() {
  if (typeof VENUES === 'undefined' || typeof computeSunWindows !== 'function') return null;
  const today = todayStr();
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  const pad = n => String(n).padStart(2, '0');
  // Search up to 7 days out — beyond that the practical answer is
  // "you live in the wrong city for this app", and we don't want an
  // infinite loop in the unlikely edge case.
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() + dayOffset);
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const minHour = (dayOffset === 0) ? nowH : 0;
    // Weather lookup for this day, memoized per integer hour. wxBucket
    // returns 'sol' / 'skyer' / 'regn' / null. Beyond the forecast
    // horizon (~10 days), getWeatherAt → null → wxBucket null → both
    // flags false → astronomical sun wins. User: 'Still not going to
    // the next sun window. All it does is go to today, set the time
    // to current time' — the previous scan ignored weather, so an
    // overcast day still resolved to "now" via astronomical sun.
    const _wxCache = new Map();
    const wxLookup = (h) => {
      const hb = Math.floor(h);
      if (!_wxCache.has(hb)) {
        const b = (typeof wxBucket === 'function') ? wxBucket(dateStr, hb + 0.5) : null;
        _wxCache.set(hb, { rainy: b === 'regn', overcast: b === 'skyer' });
      }
      return _wxCache.get(hb);
    };
    // Sundown anchor — clamp the qualifyingWindows search range.
    const sunTable = (typeof buildSunTable === 'function') ? buildSunTable(dateStr) : null;
    const sundownH = (sunTable && typeof findSunCrossingFromTable === 'function')
      ? (findSunCrossingFromTable(sunTable, false) ?? 22) : 22;
    let earliest = null;
    for (const v of VENUES) {
      // Skip search-added venues (negative ids) from the scan. Their
      // facing/terraceTestPoints come from OSM enrichment at runtime
      // and can be unreliable — terrace points sometimes land inside
      // adjacent buildings, and the wall scoring can pick a wall that
      // faces the wrong direction. A bad candidate's fake sun window
      // anchors the scan to a useless result. User: 'I am not taken
      // to another sun window because of Hummus & Wine, a venue
      // added through the search bar'.
      if (typeof v.id === 'number' && v.id < 0) continue;
      try {
        const { windows } = computeSunWindows(v, dateStr) || {};
        if (!windows || !windows.length) continue;
        // Use the same qualifying-windows logic the list surfacing
        // uses: weather-gated dry slices + 45-min duration floor.
        // This keeps the scan in lockstep with what the user will
        // actually see when the list re-renders for the new day.
        const open  = v.openingHours?.open  ?? 11;
        const close = v.openingHours?.close ?? 23;
        const qual = (typeof qualifyingWindows === 'function')
          ? qualifyingWindows(windows, wxLookup, {
              selectedHour: minHour, sundownHour: sundownH,
              openHour:     open,    closeHour:   close,
            })
          : null;
        if (!qual || !qual.surfaced || !qual.earliest) continue;
        const start = Math.max(qual.earliest.start, minHour);
        if (earliest == null || start < earliest) earliest = start;
      } catch (e) { /* ignore */ }
    }
    if (earliest != null) {
      // Pre-snap the hour to the slider's 5-minute step (anchored at
      // min=4) so the value lands cleanly on a grid point. The input
      // element auto-snaps too, but rounding here means our internal
      // `found.hour` matches what the user sees in the popup label
      // (formatHour) without depending on browser snap rounding. User
      // reported the slider 'stopped at 0600' when the actual first
      // sun window was 0640 — explicit pre-snap eliminates the drift.
      const STEP = 5 / 60;
      const N = Math.round((earliest - 4) / STEP);
      const snapped = Math.max(4, Math.min(23, 4 + N * STEP));
      return { date: dateStr, hour: snapped };
    }
  }
  return null;
}

function _dayLabel(dateStr) {
  if (!dateStr) return '';
  const lang = (typeof prefLang === 'function') ? prefLang() : 'no';
  const locale = ({ en: 'en-GB', no: 'nb-NO', se: 'sv-SE', dk: 'da-DK' })[lang] || 'nb-NO';
  const today = todayStr();
  const pad = n => String(n).padStart(2, '0');
  const tom = new Date(); tom.setDate(tom.getDate() + 1);
  const tomStr = `${tom.getFullYear()}-${pad(tom.getMonth() + 1)}-${pad(tom.getDate())}`;
  if (dateStr === today)  return t('day_today');
  if (dateStr === tomStr) return t('day_tomorrow');
  const d = new Date(dateStr + 'T12:00:00');
  const todayMs = new Date(today + 'T12:00:00').getTime();
  const daysOut = Math.round((d.getTime() - todayMs) / (24 * 60 * 60 * 1000));
  if (daysOut === -1) return t('day_yesterday');
  if (daysOut > 0 && daysOut <= 7) {
    return d.toLocaleDateString(locale, { weekday: 'long' });
  }
  // Past week (e.g. Saturday) — same weekday rendering as the upcoming
  // week. Callers that need to distinguish past vs upcoming (e.g. the
  // plan-preview past-event eyebrow) wrap this with their own context.
  if (daysOut < -1 && daysOut >= -6) {
    return d.toLocaleDateString(locale, { weekday: 'long' });
  }
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

/** Slide the venue list panel UP from off-screen to the expanded state.
 *  Used by the takeover-close recovery paths (closePlanPreview after
 *  accept/decline, _closePostAcceptPanel after the confirmation closes)
 *  so the user sees the venue list arrive with the same motion the
 *  page-load intro uses — not appear instantly. Mobile only; desktop's
 *  panel is always visible. Idempotent guard via opts.skipIfVisible if
 *  the panel is already on-screen we leave it alone. */
function _slideUpVenueListToExpanded(opts) {
  const panel = document.getElementById('panel');
  if (!panel) return;
  if (typeof isMobile === 'function' && !isMobile()) return;
  // Clear any inline overrides that could fight the slide animation.
  panel.style.transition = 'none';
  panel.style.opacity    = '1';
  panel.style.bottom     = `-${Math.round(window.innerHeight)}px`;
  panel.classList.remove('mobile-hidden', 'mobile-fullscreen');
  panel.classList.add('mobile-expanded');
  // Force layout so the off-screen bottom is committed as the start of
  // the transition.
  panel.getBoundingClientRect();
  panel.style.transition = 'bottom 0.45s cubic-bezier(0.2, 0.8, 0.3, 1)';
  panel.style.bottom     = '';
  if (typeof _syncFtsPosition === 'function') _syncFtsPosition();
}
window._slideUpVenueListToExpanded = _slideUpVenueListToExpanded;

function _exitToExploreMode(opts) {
  opts = opts || {};
  // Surface the venue list (mobile only). Callers can pass
  // skipPanelSlide:true when they want to coordinate the slide
  // themselves (e.g., _closePostAcceptPanel synchronises it with the
  // 320 ms post-accept slide-down). Default: slide up immediately.
  if (typeof isMobile === 'function' && isMobile() && !opts.skipPanelSlide) {
    _slideUpVenueListToExpanded();
  }
  // Cold invite-link entries skip the intro sequence, so the chrome keeps its
  // boot-time `intro-hidden` (opacity:0) — the top bar never reappeared after
  // the accept→confirm→close flow because nothing cleared it. Exiting to
  // explore IS the normal app view, so reveal the full chrome set here.
  // Idempotent: a no-op once the intro has already removed these classes.
  if (typeof _revealCanvasAndChrome === 'function') { try { _revealCanvasAndChrome(); } catch (e) { /* ignore */ } }
  ['floating-brand', 'qc-wrap'].forEach((id) => {
    document.getElementById(id)?.classList.remove('intro-hidden');
  });
  // Top strip: slide it DOWN into place rather than pop in. Reuse the intro's
  // gentle entrance (start just above the rest position, ease down). Use an
  // explicit translateY(0) target — not '' — so it lands at rest even while a
  // takeover body-class (e.g. post-accept-active) still pins the CSS transform
  // off-screen during its 320ms slide-down. Inline styles are cleared once
  // that's settled so future takeovers' transform-hide still works.
  const _ts = document.getElementById('top-strip');
  if (_ts && _ts.classList.contains('intro-hidden')) {
    _ts.style.transition = 'none';
    _ts.style.opacity = '1';
    _ts.style.transform = 'translateY(-72px)';
    _ts.classList.remove('intro-hidden');
    _ts.getBoundingClientRect();
    _ts.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.4s ease';
    _ts.style.transform = 'translateY(0)';
    setTimeout(() => { if (_ts) { _ts.style.transition = ''; _ts.style.transform = ''; } }, 500);
  }
  const found = _findFirstSunDayAndHour();
  if (!found) return;
  // Sync date + time pickers — both dispatch the events the rest of the
  // app listens to (renderList re-runs, slider repaints, etc.).
  // Order matters: setting the date first triggers update() which
  // recomputes MIN_H_ARC and may clamp timeFromEl.value to it. We set
  // the time AFTER the date change to put the slider at the intended
  // first-sun-window start. We also re-set the value on the next frame
  // in case any synchronous listener inside update() clamps it down.
  // Always dispatch the date change — even when the value already
  // matches found.date — so any listener that needs to refresh in
  // response (sun-table rebuild, MIN/MAX_H_ARC recompute, list filter)
  // re-runs. v1's `!==` guard skipped the dispatch when the date was
  // already today, which could leave inherited invite state on the
  // slider chain.
  if (datePicker) {
    datePicker.value = found.date;
    datePicker.dispatchEvent(new Event('change'));
  }
  const applyTime = () => {
    if (!timeFromEl) return;
    timeFromEl.value = String(found.hour);
    timeFromEl.dispatchEvent(new Event('input'));
  };
  applyTime();
  // Belt-and-suspenders re-apply at 200 ms — long enough for the
  // date-change update() chain to settle (sun table rebuilt, sliders
  // resized) but short enough not to feel laggy. v1 used a single
  // rAF (~16 ms), which wasn't enough on slower devices.
  setTimeout(() => {
    if (timeFromEl && Math.abs(parseFloat(timeFromEl.value) - found.hour) > 0.02) {
      applyTime();
    }
  }, 200);
  // Camera → user's geolocation. Falls through silently when location
  // is unavailable; the date/time/list changes still apply.
  if (typeof userLocation !== 'undefined' && userLocation
      && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng)
      && typeof map !== 'undefined' && map && typeof map.flyTo === 'function') {
    try {
      map.flyTo({
        center: [userLocation.lng, userLocation.lat],
        zoom: 14,
        pitch: 30,
        bearing: 0,
        duration: 900,
        essential: true,
      });
    } catch (e) { /* ignore */ }
  }
  // Day-switch notification — universal: any time we auto-pick a
  // non-today date, tell the user what day they're looking at.
  if (found.date !== todayStr() && typeof _notifShowImmediate === 'function') {
    _notifShowImmediate({
      id: 'explore_day_switch_' + found.date,
      priority: 1,
      category: 'weather',
      icon: '☀️',
      bodyKey: 'notif_explore_day_switch_body',
      bodyVars: { day: _dayLabel(found.date) },
      _legacyDismiss: 4500,
    });
  }
}
if (typeof window !== 'undefined') {
  window._exitToExploreMode = _exitToExploreMode;
}
function currentHour() { const n = new Date(); return n.getHours() + n.getMinutes() / 60; }

function formatHour(h) {
  if (h == null) return '—';
  const total = Math.round(h * 60);
  const hr = Math.floor(total / 60), min = total % 60;
  return `${String(hr).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
}

function formatSliderTime(val) {
  const total = Math.round(val * 60);
  const h = Math.floor(total / 60), m = total % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function formatDatePill(dateStr) {
  // Returns inline readout phrase date portion WITHOUT trailing comma.
  // The comma is a separate span in HTML so it falls outside the button hit area.
  // e.g.: "Today"  /  "I morgen"  /  "Man 20 Apr"
  const today = todayStr();
  const tom   = new Date(); tom.setDate(tom.getDate() + 1);
  const tomS  = tom.toISOString().slice(0, 10);
  if (dateStr === today) return t('today');
  if (dateStr === tomS)  return t('tomorrow');
  const d   = new Date(dateStr + 'T12:00:00');
  const _locale = { en: 'en-GB', no: 'nb-NO', se: 'sv-SE', dk: 'da-DK' }[prefLang()] || 'nb-NO';
  const day = d.toLocaleDateString(_locale, { weekday: 'short' });
  const num = d.getDate();
  const mon = d.toLocaleDateString(_locale, { month: 'short' });
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1).replace(/\.$/, '');
  return `${cap(day)} ${num} ${cap(mon)}`;
}

// ── Slider ────────────────────────────────────────────────────────────────────
function updateRangeFill() {
  const min = 4, max = 23;
  const fv  = parseFloat(timeFromEl.value);
  const fp  = (fv - min) / (max - min) * 100;
  timeDisplayFrom.textContent = formatSliderTime(fv);
  timeDisplayFrom.style.left  = `calc(${fp.toFixed(2)}% - ${(fp / 100 * 14 - 7).toFixed(2)}px)`;
}

function toggleNowMode() {
  if (nowMode) {
    nowMode = false;
    clearInterval(nowInterval); nowInterval = null;
    nowBtn.classList.remove('active');
    timeRangeWrap.classList.remove('now-active');
  } else {
    nowMode = true;
    nowBtn.classList.add('active');
    timeRangeWrap.classList.add('now-active');
    applyNowTime();
    nowInterval = setInterval(_nowModeTick, 30000);
  }
  update();
}

function applyNowTime() {
  timeFromEl.value = Math.min(23, Math.max(4, currentHour()));
  updateRangeFill();
}

// Periodic "now" tick (every 30 s while nowMode). Re-renders as the clock
// advances. _nowTickRender tells scheduleRenderList to render SILENTLY (no
// per-tick fade) and tells renderList to play the skeleton crossfade ONLY when
// the venue order actually changed — not on every silent tick.
function _nowModeTick() {
  if (!nowMode) return;
  window._nowTickRender = true;
  applyNowTime();
  update();
}

function _activateNowMode() {
  if (nowMode) return;
  nowMode = true;
  nowBtn?.classList.add('active');
  timeRangeWrap?.classList.add('now-active');
  setActiveIntentBtn('now');
  nowInterval = setInterval(_nowModeTick, 30000);
}

// ── Intent shortcuts ──────────────────────────────────────────────────────────
const _PRESET_HOURS = { lunch: 11, 'after-work': 16, evening: 20 };
const PAD_X_ARC = 20;
let MIN_H_ARC = 4, MAX_H_ARC = 23; // updated dynamically from sunrise/sunset
let SUNRISE_H_ARC = null, SUNSET_H_ARC = null; // exact crossing hours

function _arcTimeToLeft(h, canvasW) {
  return PAD_X_ARC + (h - MIN_H_ARC) / (MAX_H_ARC - MIN_H_ARC) * (canvasW - PAD_X_ARC * 2);
}

function positionPresetButtons() {
  const isToday = datePicker.value === todayStr();
  const sunsetH = currentSunTable ? (findSunCrossingFromTable(currentSunTable, false) ?? 21) : 21;

  document.querySelectorAll('.intent-btn').forEach(btn => {
    if (btn.dataset.intent === 'evening') btn.style.display = sunsetH >= 20 ? '' : 'none';
    if (btn.dataset.intent === 'now')     btn.textContent = isToday ? t('now') : t('sunrise');
  });

  positionIntentPill();
}

function positionIntentPill() {
  const pill = document.getElementById('intent-pill');
  const row  = document.getElementById('time-presets-row');
  const active = row?.querySelector('.intent-btn.active');
  if (!pill || !active || !row) { if (pill) pill.style.opacity = '0'; return; }
  const rowRect = row.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  pill.style.opacity = '1';
  pill.style.left   = (btnRect.left   - rowRect.left) + 'px';
  pill.style.top    = (btnRect.top    - rowRect.top)  + 'px';
  pill.style.width  = btnRect.width  + 'px';
  pill.style.height = btnRect.height + 'px';
}

function setActiveIntentBtn(intent) {
  activeIntent = intent;
  document.querySelectorAll('.intent-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.intent === intent));
  positionIntentPill();
}

function setIntent(intent) {
  setActiveIntentBtn(intent);
  if (intent === 'now') {
    const isToday = datePicker.value === todayStr();
    if (isToday) {
      if (!nowMode) {
        nowMode = true;
        nowBtn?.classList.add('active');
        timeRangeWrap?.classList.add('now-active');
        nowInterval = setInterval(_nowModeTick, 30000);
      }
      animateToTime(Math.min(23, Math.max(4, currentHour())));
    } else {
      // Future date: animate to sunrise
      if (nowMode) { nowMode = false; clearInterval(nowInterval); nowInterval = null; }
      const sunriseH = currentSunTable ? (findSunCrossingFromTable(currentSunTable, true) ?? 7) : 7;
      animateToTime(Math.max(MIN_H_ARC, Math.min(MAX_H_ARC, sunriseH)));
    }
    return;
  }
  if (nowMode) {
    nowMode = false;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  animateToTime(_PRESET_HOURS[intent]);
}

// ── Date display button + weather strip ──────────────────────────────────────
function updateDateDisplayBtn() {
  const btn = document.getElementById('date-display-btn');
  if (!btn) return;
  const val  = datePicker.value;
  const d    = new Date(val + 'T12:00:00');
  const tod  = todayStr();
  const tom  = new Date(); tom.setDate(tom.getDate() + 1);
  const tomS = tom.toISOString().slice(0, 10);
  const DAYS = tA('days_short');
  const MONS = tA('months_short');
  const dateStr = `${d.getDate()} ${MONS[d.getMonth()]}`;
  if (val === tod)       btn.textContent = t('today_date',    { date: dateStr });
  else if (val === tomS) btn.textContent = t('tomorrow_date', { date: dateStr });
  else btn.textContent = `${DAYS[d.getDay()]} ${dateStr}`;
}

function updateDateWeatherStrip() {
  const el = document.getElementById('date-wx-strip');
  if (!el) return;
  const wx = typeof getWeatherAt === 'function'
    ? getWeatherAt(datePicker.value, parseFloat(timeFromEl.value))
    : null;
  if (!wx) { el.style.display = 'none'; return; }
  el.style.display = '';
  // SVG wind arrow rotated by direction (0° = north = up). wx.wdir is the
  // meteorological FROM-direction, so add 180° to get the TO-direction the
  // arrow should point. Inline SVG avoids the iOS tofu we used to hit when
  // Unicode arrow codepoints (↗ ↘ ↙ ↖) had no glyph in the WKWebView font
  // fallback chain.
  const windAngle = ((wx.wdir + 180) % 360);
  const arrow = `<svg class="wx-arrow" viewBox="0 0 12 12" aria-hidden="true" style="transform: rotate(${windAngle}deg);"><path d="M6 11 L6 2 M3 5 L6 2 L9 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const skySvg  = (typeof skyIconSvg === 'function')
    ? skyIconSvg(wx.sunBlock ?? wx.cloud)
    : skyIcon(wx.sunBlock ?? wx.cloud);
  const rainSvg = (typeof rainIconSvg === 'function') ? rainIconSvg() : '';
  const rain    = wx.precip >= 0.2
    ? `<span class="wx-rain">${rainSvg} ${wx.precip.toFixed(1)}</span>`
    : '';
  el.innerHTML = `<span>${skySvg}</span>`
    + `<span class="wx-temp-strip">${formatTemp(wx.temp)}</span>`
    + `<span class="wx-sep">·</span>`
    + `<span class="wx-wind">${arrow} ${Math.round(wx.wspd)} m/s</span>`
    + rain;

  // Mirror into the new top-strip sentence (Stage 1b).
  const tsIcon = document.getElementById('ts-wx-icon');
  const tsTemp = document.getElementById('ts-temp');
  const tsWind = document.getElementById('ts-wind');
  if (tsIcon) tsIcon.innerHTML = skySvg;
  if (tsTemp) tsTemp.textContent = formatTemp(wx.temp);
  if (tsWind) tsWind.innerHTML = `${arrow} ${Math.round(wx.wspd)} m/s`;
}


// ── Date calendar picker ──────────────────────────────────────────────────────
function renderDateCalendar() {
  const cal = document.getElementById('date-calendar');
  if (!cal) return;
  const selected = datePicker.value;
  const DAYS = tA('days_short');
  let html = '<div class="dc-grid">';
  for (let i = 0; i < 14; i++) {
    const d    = new Date(); d.setDate(d.getDate() + i);
    const dStr = d.toISOString().slice(0, 10);
    const summ = typeof getDayWeatherSummary === 'function' ? getDayWeatherSummary(dStr) : null;
    let cls = 'dc-tile';
    if (i === 0)        cls += ' today';
    if (dStr === selected) cls += ' selected';
    if (summ) {
      // Classify the border on the SAME value the icon uses (avgSunBlock) and
      // through the canonical wxClassify, so tint and glyph never disagree
      // (was minSunBlock for the border vs avgSunBlock for the icon). The three
      // sunny tiers all read as "sun-high".
      const sb = summ.avgSunBlock ?? summ.avgCloud ?? 0;
      const dc = (typeof wxClassify === 'function') ? wxClassify(sb, 0) : 'clear';
      if (dc === 'clear' || dc === 'clearSoft') cls += ' sun-high';
      else if (dc === 'partly')                 cls += ' sun-mid';
      else                                      cls += ' sun-low';
    } else {
      cls += ' no-data';
    }
    // Use the same SVG glyphs as the top-bar / date-strip so the calendar
    // visual matches the rest of the app. Emoji cloud codepoints (the prior
    // summ.icon path) tofu on iOS WKWebView even with VS-16 — Apple Color
    // Emoji isn't reached via the WebView font-fallback chain.
    const sbForIcon = summ ? (summ.avgSunBlock ?? summ.avgCloud ?? 0) : null;
    const icon = (summ && typeof skyIconSvg === 'function')
      ? skyIconSvg(sbForIcon)
      : (summ ? summ.icon : '·');
    const temp = summ ? formatTemp(summ.peakTemp) : '';
    html += `<button class="${cls}" onclick="selectCalendarDate('${dStr}')">`
      + `<span class="dc-day">${DAYS[d.getDay()]}</span>`
      + `<span class="dc-num">${d.getDate()}</span>`
      + `<span class="dc-icon">${icon}</span>`
      + `<span class="dc-temp">${temp}</span>`
      + `</button>`;
  }
  html += '</div>';
  cal.innerHTML = html;
}

function toggleDateCalendar() {
  const cal = document.getElementById('date-calendar');
  const btn = document.getElementById('date-display-btn');
  if (!cal) return;
  const isOpen = cal.classList.toggle('open');
  if (btn) btn.classList.toggle('open', isOpen);
  if (isOpen) {
    _aTrack('calendar_open', { current_date: datePicker.value });
    renderDateCalendar();
  }
}

function selectCalendarDate(dateStr) {
  // Detect "leaving a post-sundown position" BEFORE we mutate datePicker.
  // currentSunTable was built for the OLD date, so its sundown crossing
  // is the relevant comparison for the slider's current hour. Without
  // this, picking a new day from the calendar at e.g. 23:00 strands the
  // thumb at 23:00 on the new date — every subsequent day looks sunless.
  const oldHour = parseFloat(timeFromEl.value);
  const oldSundown = (typeof currentSunTable !== 'undefined' && currentSunTable && typeof findSunCrossingFromTable === 'function')
    ? findSunCrossingFromTable(currentSunTable, false) : null;
  const wasPostSundown = oldSundown != null && oldHour >= oldSundown - 0.001;

  datePicker.value = dateStr;
  if (dateStr !== todayStr()) {
    // Picking ANY non-today date snaps the slider to the first sun
    // window of that day. Without this the slider sticks at the old
    // hour (e.g. 22:00) on the new date, and the user thinks "no sun
    // today either" when actually they're just looking past sundown.
    if (nowMode) {
      nowMode = false;
      clearInterval(nowInterval); nowInterval = null;
      nowBtn?.classList.remove('active');
      timeRangeWrap?.classList.remove('now-active');
    }
    if (wasPostSundown) setActiveIntentBtn(null);
    const earliestSun = (typeof _earliestSunHourFor === 'function') ? _earliestSunHourFor(dateStr) : null;
    timeFromEl.value = earliestSun != null ? earliestSun : 12;
  }
  const cal = document.getElementById('date-calendar');
  const btn = document.getElementById('date-display-btn');
  if (cal) cal.classList.remove('open');
  if (btn) btn.classList.remove('open');
  update();
}

// ── Hover from sidebar list ───────────────────────────────────────────────────
function setHoveredVenue(id) {
  if (id !== null) {
    highlight.id = id;
    highlight.source = 'list';
    highlight.raisedId = id;   // persists after cursor leaves sidebar
  } else {
    highlight.id = null;
    highlight.source = null;
    // highlight.raisedId intentionally kept
  }
  draw();
}

// ── Favorites filter ──────────────────────────────────────────────────────────
// Favorites filter removed — now handled as sortBy === 'favorites'

// ── Area filter ───────────────────────────────────────────────────────────────
function setAreaFilter(area) {
  _aTrack('filter_change', { filter: 'area', value: area });
  activeArea = area;
  _expansionPages = 0;
  document.querySelectorAll('.area-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.area === area));
  renderList();
  if (typeof saveUserPreference === 'function') saveUserPreference('default_area', area);
}

// ── Cluster proximity ────────────────────────────────────────────────────────
// True when the user's GPS is outside the venue cluster (or unknown). Drives the
// "distance from city center" fallback so users browsing from another country
// still see a useful list. City-agnostic: VENUE_CLUSTER is derived from data.
function _isFarFromCluster() {
  if (!userLocation || !VENUE_CLUSTER.radiusKm) return true;
  const c = VENUE_CLUSTER.center;
  const dLat = (userLocation.lat - c.lat) * 111;
  const dLng = (userLocation.lng - c.lng) * 111 * Math.cos(c.lat * Math.PI / 180);
  return Math.hypot(dLat, dLng) > VENUE_CLUSTER.radiusKm;
}

// Apply auto-default sort. After Soft Zebra: 'score' (Mest sol) is the
// default for all users — qualifying-window duration sorts identify the
// best sun-availability venues regardless of where the user is. Kept as a
// function so callers (geolocation grant, locale change) can still ping it
// without churn. Always triggers updateSortBtns so the label/active chip
// gets localized on first paint, even when the value is already 'score'.
function _applyAutoDefaultSort() {
  if (_userPickedSort) return;
  if (activeSortBy !== 'match') activeSortBy = 'match';
  if (typeof updateSortBtns === 'function') updateSortBtns();
}

// ── Sort ──────────────────────────────────────────────────────────────────────
/** Find whichever sort button is currently in the layout. The HTML has two
 *  (a chrome-styled #sort-toggle-btn in #sun-section-bar, and a filter-bar
 *  #panel-actions-sort in #panel-actions); only one is visible at a time
 *  depending on panel state and body.day-no-sun. Both onclicks call
 *  toggleSortPanel(), so we anchor the dropdown to the one the user
 *  actually sees. offsetParent === null is the standard "is this element
 *  in the render tree" check (covers display:none on the node or any
 *  ancestor). */
function _visibleSortBtn() {
  const a = document.getElementById('sort-toggle-btn');
  if (a && a.offsetParent !== null) return a;
  const b = document.getElementById('panel-actions-sort');
  if (b && b.offsetParent !== null) return b;
  return a || b || null;
}

function _closeSortPanel() {
  if (!_navHandlingPop) _navDropLayer('sort');
  document.getElementById('sort-panel')?.classList.remove('open');
  document.getElementById('sort-toggle-btn')?.classList.remove('open');
  document.getElementById('panel-actions-sort')?.classList.remove('open');
  document.getElementById('sort-backdrop')?.remove();
}

function toggleSortPanel() {
  const panel = document.getElementById('sort-panel');
  const btn   = _visibleSortBtn();
  if (!panel || !btn) return;
  if (panel.classList.contains('open')) { _closeSortPanel(); return; }

  // Sort button is now always visible — including peek mode. Tapping it from
  // peek expands the list panel first so the dropdown anchors on a stable
  // button position (the panel-state transition would otherwise drag the
  // anchor mid-animation). Defer the open by one transition tick.
  // Mobile-only: desktop has no peek/expand state — its panel is always
  // open, so the inPeek path would add a no-op .mobile-expanded class and
  // burn 360 ms before showing the dropdown, making the button feel dead.
  const listPanel = document.getElementById('panel');
  const inPeek = isMobile()
    && listPanel
    && !listPanel.classList.contains('mobile-expanded')
    && !listPanel.classList.contains('mobile-fullscreen')
    && !listPanel.classList.contains('mobile-hidden');
  if (inPeek) {
    listPanel.classList.add('mobile-expanded');
    if (typeof _syncFtsPosition === 'function') _syncFtsPosition();
    // Wait for the panel transition (0.34s) to settle so the dropdown
    // anchors at the new button position.
    setTimeout(() => _openSortPanelNow(), 360);
    return;
  }
  _openSortPanelNow();
}

function _openSortPanelNow() {
  const panel = document.getElementById('sort-panel');
  const btn   = _visibleSortBtn();
  if (!panel || !btn) return;
  if (panel.classList.contains('open')) return;
  _navPush('sort');
  panel.classList.add('open');
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  panel.style.top  = (r.bottom + 4) + 'px';
  panel.style.left = r.right + 'px';
  panel.style.transform = 'translateX(-100%)';
  // Transparent backdrop blocks taps from leaking through to venue cards
  // behind the dropdown. Tapping the backdrop closes the panel.
  if (!document.getElementById('sort-backdrop')) {
    const bd = document.createElement('div');
    bd.id = 'sort-backdrop';
    bd.className = 'sort-backdrop';
    bd.onclick = () => _closeSortPanel();
    document.body.appendChild(bd);
  }
}

function setSortBy(sort) {
  _aTrack('sort_change', { sort_by: sort });
  _userPickedSort = true;
  _expansionPages = 0;
  if (sort === 'favorites' && !userLocation) {
    // Request location for distance-based ordering, but don't block — show favorites even without it
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        _aTrack('geolocation_grant', { trigger: 'favorites_sort' });
        renderList();
      },
      () => { _aTrack('geolocation_deny', { trigger: 'favorites_sort' }); showToast(t('location_denied')); }
    );
    // Fall through — set sort immediately, re-render will happen again if location arrives
  } else if (sort === 'distance' && !userLocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        _aTrack('geolocation_grant', { trigger: 'distance_sort' });
        activeSortBy = 'distance';
        updateSortBtns();
        renderList();
      },
      () => { _aTrack('geolocation_deny', { trigger: 'distance_sort' }); showToast(t('location_denied')); }
    );
    return;
  }
  activeSortBy = sort;
  updateSortBtns();
  _closeSortPanel();
  renderList();
}

function updateSortBtns() {
  document.querySelectorAll('.sort-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.sort === activeSortBy));
  // When user is far from the venue cluster, "distance" means "from city
  // center" rather than "from you" — surface that with a label swap.
  const distLabel = (activeSortBy === 'distance' && _isFarFromCluster())
    ? t('sort_distance_center')
    : t('sort_distance');
  const labels = { match: t('sort_match'), score: t('sort_score'), distance: distLabel, beer: t('sort_beer'), favorites: t('sort_favorites') };
  const labelEl = document.getElementById('sort-label');
  if (labelEl) labelEl.textContent = labels[activeSortBy] ?? t('sort_match');
}

// ── Filter dropdown (over the venue list) ─────────────────────────────────────
// Single "Filtre" button opens this panel; toggles inside reuse
// toggleListFilter / window._activeFilters. Mirrors the sort-panel lifecycle
// (nav layer, fixed positioning from the button, tap-blocking backdrop).
function _activeFilterCount() {
  const f = window._activeFilters || {};
  let n = (f.categories ? f.categories.size : 0);
  if (f.sun2h)   n++;
  if (f.friends) n++;
  if (f.quiet)   n++;
  return n;
}

function _updateFilterBadge() {
  const n   = _activeFilterCount();
  const btn = document.getElementById('panel-actions-filter');
  const bdg = document.getElementById('filter-count-badge');
  if (btn) btn.classList.toggle('has-active', n > 0);
  if (bdg) {
    if (n > 0) { bdg.textContent = String(n); bdg.hidden = false; }
    else       { bdg.textContent = '';        bdg.hidden = true; }
  }
}

function _closeFilterPanel() {
  if (!_navHandlingPop) _navDropLayer('filter');
  document.getElementById('filter-panel')?.classList.remove('open');
  document.getElementById('panel-actions-filter')?.classList.remove('open');
  document.getElementById('filter-backdrop')?.remove();
}

function toggleFilterPanel() {
  const panel = document.getElementById('filter-panel');
  const btn   = document.getElementById('panel-actions-filter');
  if (!panel || !btn) return;
  if (panel.classList.contains('open')) { _closeFilterPanel(); return; }

  // From peek, expand the list panel first so the dropdown anchors on a stable
  // button position (mirrors toggleSortPanel).
  const listPanel = document.getElementById('panel');
  const inPeek = isMobile()
    && listPanel
    && !listPanel.classList.contains('mobile-expanded')
    && !listPanel.classList.contains('mobile-fullscreen')
    && !listPanel.classList.contains('mobile-hidden');
  if (inPeek) {
    listPanel.classList.add('mobile-expanded');
    if (typeof _syncFtsPosition === 'function') _syncFtsPosition();
    setTimeout(() => _openFilterPanelNow(), 360);
    return;
  }
  _openFilterPanelNow();
}

function _openFilterPanelNow() {
  const panel = document.getElementById('filter-panel');
  const btn   = document.getElementById('panel-actions-filter');
  if (!panel || !btn || panel.classList.contains('open')) return;
  // Close the sort panel if it's open — only one dropdown at a time.
  if (typeof _closeSortPanel === 'function') _closeSortPanel();
  _navPush('filter');
  panel.classList.add('open');
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  panel.style.top  = (r.bottom + 4) + 'px';
  panel.style.left = r.left + 'px';
  panel.style.transform = 'none';
  if (!document.getElementById('filter-backdrop')) {
    const bd = document.createElement('div');
    bd.id = 'filter-backdrop';
    bd.className = 'sort-backdrop';
    bd.onclick = () => _closeFilterPanel();
    document.body.appendChild(bd);
  }
}

/** Clear every list filter and reset the panel toggles + badge. */
function clearListFilters() {
  const f = window._activeFilters;
  if (f) { f.categories.clear(); f.sun2h = false; f.quiet = false; f.friends = false; }
  document.querySelectorAll('#filter-panel .filter-opt').forEach(b => b.classList.remove('active'));
  _updateFilterBadge();
  if (typeof renderList === 'function') renderList();
  if (typeof window.markPinLayoutStale === 'function') window.markPinLayoutStale();
  if (typeof draw === 'function') draw();
}

// ── Debounced time change analytics ──────────────────────────────────────────
let _aTimeChangeTimer = null;
function _aTrackTimeChange() {
  clearTimeout(_aTimeChangeTimer);
  _aTimeChangeTimer = setTimeout(() => {
    _aTrack('time_change', {
      date: datePicker.value,
      hour: parseFloat(timeFromEl.value),
      now_mode: nowMode,
    });
  }, 3000);
}

// ── Debounced list render (avoids jitter when dragging time slider) ────────────
// On the first call in a scrub cycle we IMMEDIATELY swap the real cards for
// skeleton placeholders so the user sees a strong "list is being recomputed"
// signal — instead of stale cards lingering until release. The actual
// renderList still fires on the debounce tail (or sooner via
// flushRenderListNow when the slider's pointerup hook calls it).
let _renderListTimer = null;
function scheduleRenderList() {
  clearTimeout(_renderListTimer);
  // Reveal skeleton hold: don't render real cards over the boot-reveal skeletons.
  if (window._revealSkeletonHold) return;
  // Periodic now-tick: render silently (no per-tick skeleton fade). renderList
  // plays the skeleton crossfade itself, but only if the order actually changed.
  if (window._nowTickRender) {
    _renderListTimer = setTimeout(_runListRenderAndUnmark, 300);
    return;
  }
  // Mark scrubbing so the section divider fades out — prevents flicker as
  // venues cross sun-window boundaries during a drag. Kept on across
  // renderList so the new divider mounts hidden, then fades in on the next
  // frame after the class is removed.
  if (!document.body.classList.contains('list-scrubbing')) {
    _injectScrubSkeletons();
  }
  document.body.classList.add('list-scrubbing');
  // Hold the skeletons in place for the entire duration of an FTS drag.
  // Without this guard a 300 ms pause mid-drag would swap real cards back
  // in under the user's finger. Pointerup will flushRenderListNow().
  if (window._qcThumbActive) return;
  _renderListTimer = setTimeout(_runListRenderAndUnmark, 300);
}

function _runListRenderAndUnmark() {
  _renderListTimer = null;
  // Cancel any pending skeleton-fade swap + ensure the list is visible, so the
  // real render never lands while #venue-list is mid-fade (stuck-invisible guard).
  clearTimeout(_scrubXfTimer); _scrubXfTimer = null;
  // Fade the new cards in: clearing data-mounted lets renderList's
  // initial-mount cardIn animation fire once for this batch (renderList
  // sets it back via rAF). Matches the strong skeleton-out / cards-in
  // signal the user expects on slider release.
  const list = document.getElementById('venue-list');
  if (list) { list.classList.remove('list-xfading'); delete list.dataset.mounted; }
  renderList();
  setTimeout(_syncQcPanelHeight, 80);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.remove('list-scrubbing');
    });
  });
}

// Flush the pending list render NOW — bound to the slider's pointerup so
// the user sees the new list as soon as they release. During an active
// drag the debounce timer is never set (scheduleRenderList returns early
// when _qcThumbActive), so we render whenever the list is in scrubbing
// state, with or without a pending timer.
function flushRenderListNow() {
  if (_renderListTimer) {
    clearTimeout(_renderListTimer);
    _renderListTimer = null;
  }
  if (document.body.classList.contains('list-scrubbing')) {
    _runListRenderAndUnmark();
  }
}

// Swap the real venue cards for skeleton placeholders. Reuses the same
// .venue-card.skeleton design used by the after-sunset state so we only
// have one wireframe style to maintain. The infinite-scroll observer
// bound to the previous cards becomes inert once those nodes leave the
// DOM; renderList rebinds it on the next real render.
let _scrubXfTimer = null;
function _injectScrubSkeletons() {
  const list = document.getElementById('venue-list');
  if (!list || typeof renderSkeletonCards !== 'function') return;
  // Phase 7 skeleton crossfade: fade the real card values OUT first, then swap
  // in the skeletons and dissolve them IN — instead of a hard cut. Runs once at
  // scrub start (guarded by !list-scrubbing in the caller). The swap is deferred
  // ~1 fade so the values visibly dissolve; guarded so a quick release that
  // renders real cards first doesn't get clobbered by a late skeleton swap.
  list.classList.add('list-xfading');                 // real values fade out
  clearTimeout(_scrubXfTimer);
  _scrubXfTimer = setTimeout(() => {
    _scrubXfTimer = null;
    if (!document.body.classList.contains('list-scrubbing')) { list.classList.remove('list-xfading'); return; }
    // Match the skeleton count to the cards currently shown so the box count
    // doesn't change — every visible venue card becomes a skeleton.
    const n = list.querySelectorAll('.venue-card:not(.skeleton)').length || 7;
    list.innerHTML = '';
    // Reserve the leading section-header's box so the skeleton cards stay on the
    // same axis as the real venue cards (body.list-scrubbing fades it but keeps height).
    const hdr = document.createElement('div');
    hdr.className = 'venue-section-header';
    hdr.innerHTML = '&nbsp;';
    list.appendChild(hdr);
    renderSkeletonCards(list, n);
    // Double-rAF: the freshly-mounted skeleton content inherits opacity:0 from
    // .list-xfading; commit that frame BEFORE removing the class, or the
    // transition is skipped and the skeletons flash in at full opacity.
    requestAnimationFrame(() => requestAnimationFrame(() => list.classList.remove('list-xfading')));
  }, 110);
}

// ── QC notice (below date/time picker) ───────────────────────────────────────
function showQcNotice(msg) {
  const el = document.getElementById('qc-notice');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(el._tid);
  el._tid = setTimeout(() => el.classList.remove('visible'), 4000);
}

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('visible'), 3500);
}

// Network resilience (Phase 6) — surface online/offline transitions via the
// transient toast. Data is service-worker-cached, so offline still shows saved
// venues; the toast just tells the user why things may be stale. (A persistent
// banner is the spec'd upgrade.) Only fires on real transitions, not at boot.
window.addEventListener('offline', () => { try { showToast(t('net_offline')); } catch {} });
window.addEventListener('online',  () => { try { showToast(t('net_online'));  } catch {} });

let _autoAdvancedAfterSunset = false;

// ── Day navigation ────────────────────────────────────────────────────────────
function advanceDay(delta, setHour) {
  _aTrack('day_navigate', { direction: delta > 0 ? 'forward' : 'back' });
  const d = new Date(datePicker.value + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  const newDateStr = d.toISOString().slice(0, 10);
  // Detect post-sundown on the OLD date before mutating datePicker so we
  // can rescue the slider from a stranded "after sundown" hour. Without
  // this, paging forward at 23:00 keeps 23:00 across every new day —
  // every new day reads as sunless even when there's plenty of sun.
  const oldHour = parseFloat(timeFromEl.value);
  const oldSundown = (typeof currentSunTable !== 'undefined' && currentSunTable && typeof findSunCrossingFromTable === 'function')
    ? findSunCrossingFromTable(currentSunTable, false) : null;
  const wasPostSundown = oldSundown != null && oldHour >= oldSundown - 0.001;
  datePicker.value = newDateStr;
  // When jumping forward and sun is currently below horizon, default to noon.
  if (setHour === undefined && delta > 0 && currentSun && currentSun.alt < 0) setHour = 12;
  // Either direction: if the old day was post-sundown and the new day
  // isn't today, snap to that day's earliest sun so the user lands at
  // a meaningful hour.
  if (setHour === undefined && wasPostSundown && newDateStr !== todayStr()) {
    setHour = (typeof _earliestSunHourFor === 'function')
      ? (_earliestSunHourFor(newDateStr) ?? 12)
      : 12;
  }
  if (setHour !== undefined) {
    if (nowMode) {
      nowMode = false;
      nowBtn.classList.remove('active');
      timeRangeWrap.classList.remove('now-active');
      clearInterval(nowInterval); nowInterval = null;
    }
    setActiveIntentBtn(null);
    timeFromEl.value = setHour;
  }
  update();
}

// ── Sun curve click → set time ────────────────────────────────────────────────
// ── Time snapping (shared by the FTS + timelines) ─────────────────────────────
function _clampHour(t) {
  // Snap to 5-minute grid; floor at MIN_H_ARC (the global day-domain floor).
  const snapped = Math.round(t * 12) / 12;
  return Math.max(MIN_H_ARC, Math.min(MAX_H_ARC, snapped));
}

function animateToTime(targetHour, durationMs) {
  const dur     = durationMs ?? TIME_ANIM_MS;
  const current = parseFloat(timeFromEl.value);
  if (Math.abs(current - targetHour) < 0.02) { update(); return; }
  if (_timeAnimId) cancelAnimationFrame(_timeAnimId);
  _timeAnimFrom  = current;
  _timeAnimTo    = targetHour;
  _timeAnimStart = performance.now();
  function tick() {
    const t    = Math.min(1, (performance.now() - _timeAnimStart) / dur);
    const ease = t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3) / 2; // ease-in-out cubic
    timeFromEl.value = _timeAnimFrom + (_timeAnimTo - _timeAnimFrom) * ease;
    update();
    if (t < 1) { _timeAnimId = requestAnimationFrame(tick); }
    else        { _timeAnimId = null; }
  }
  _timeAnimId = requestAnimationFrame(tick);
}

// ── Readout panel ─────────────────────────────────────────────────────────────
// Cross-fade helper: animates only when not actively scrubbing (animate=true).
function _readoutSet(el, newText, animate) {
  if (!el) return;
  if (el.textContent === newText) return;
  if (!animate) { el.textContent = newText; return; }
  el.style.opacity = '0';
  setTimeout(() => {
    el.textContent = newText;
    el.style.opacity = '';
  }, 55);
}

function updateQcIndicator(h) {
  const hour = (typeof h === 'number') ? h : parseFloat(timeFromEl.value);
  // Floating time label tracks the live (hover or selected) hour
  if (document.body.classList.contains('fts')) showFtsPopup(hour);
  updateHeaderWxChip(hour);
}

function updateQcLabels() {
  const val = datePicker.value;
  const tod = todayStr();

  updateQcIndicator(null);

  const isToday = val === tod;
  document.querySelectorAll('.qc-preset-btn[data-intent="now"]').forEach(b => {
    b.textContent = isToday ? t('now') : t('sunrise');
  });

  document.querySelectorAll('.qc-preset-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.intent === activeIntent));
}

function _closeQcPanel() {
  const panel = document.getElementById('qc-panel');
  if (!panel) return;

  if (!_navHandlingPop) _navDropLayer('qc');
  _qcActiveSection = null;
  // _qcCalExpanded is intentionally NOT reset here — session mode (strip/month) persists

  const calFloat = document.getElementById('ptb-cal-float');
  if (calFloat) {
    calFloat.classList.remove('open');
    calFloat.style.top = '';
    calFloat.style.bottom = '';
    calFloat.style.left = '';
    calFloat.style.width = '';
  }
  // Fade the dim OUT (remove .open → CSS transitions to transparent) then
  // remove the node after the transition — an instant .remove() skipped it.
  const _calBd = document.getElementById('ptb-cal-backdrop');
  if (_calBd) { _calBd.classList.remove('open'); setTimeout(() => _calBd.remove(), 320); }
  // Release the cal-open class — CSS animates the detail panel back up
  // and fades the FTS back in.
  document.body.classList.remove('cal-open');
  // Update header date chip: remove active state, restore visibility, update label
  if (USE_FLOATING_TIME_SLIDER) {
    document.getElementById('header-date-chip')?.classList.remove('active');
    document.getElementById('fts')?.classList.remove('fts-cal-open');
    updateHeaderDateChip();
  }
  // Restore panel state saved before calendar opened (the list was fully
  // hidden while the calendar was up). Default to peek so it can't strand
  // off-screen if the prior state wasn't captured.
  if (isMobile() && typeof window._applyMobilePanelState === 'function') {
    window._applyMobilePanelState(_preCalPanelState || 'peek');
    _preCalPanelState = null;
  }

  panel.classList.remove('open');
  panel.classList.remove('cal-expanded');
  panel.style.removeProperty('--qc-panel-h');

  // Remove active class via transitionend (desktop) with a fallback for mobile
  // where max-height:none !important means the transitionend never fires.
  const dateSection = document.getElementById('qc-date-section');
  const cleanup = e => {
    if (e.propertyName !== 'max-height') return;
    panel.removeEventListener('transitionend', cleanup);
    // Guard against a fast close→open: if the panel was re-opened before this
    // (close) transition ended, the listener fires on the OPEN's transitionend
    // instead — don't strip the date section then, or the 2nd open shows only
    // the collapsed panel border (the stray "line"). Only deactivate if closed.
    if (!panel.classList.contains('open')) dateSection?.classList.remove('active');
  };
  panel.addEventListener('transitionend', cleanup);
  // Fallback: if panel has no transition (mobile override), clean up immediately
  const cs = getComputedStyle(panel).transition;
  if (!cs || cs === 'none' || cs === 'all 0s') dateSection?.classList.remove('active');
}

function toggleQcPanel(section) {
  if (section !== 'date') return;

  const panel   = document.getElementById('qc-panel');
  const calFloat = document.getElementById('ptb-cal-float');
  if (!panel) return;

  if (_qcActiveSection === 'date') {
    _closeQcPanel();
    return;
  }

  _qcActiveSection = 'date';
  _navPush('qc');
  // On desktop, position calendar float BELOW the top-strip date button
  // (Stage 2b — was anchored above the FTS, which is now inside the panel).
  if (!isMobile() && calFloat) {
    const anchor = document.getElementById('ts-date-btn')
                || document.getElementById('header-date-chip')
                || document.getElementById('fts');
    const listPanel = document.getElementById('panel');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      calFloat.style.bottom = '';
      calFloat.style.top = (r.bottom + 8) + 'px';
      // Match the venue-list panel: same width + left edge, overlapping the list.
      if (listPanel) {
        const pr = listPanel.getBoundingClientRect();
        calFloat.style.left = pr.left + 'px';
        calFloat.style.width = pr.width + 'px';
        calFloat.style.maxWidth = pr.width + 'px';
      } else {
        calFloat.style.left = Math.max(16, r.left) + 'px';
        calFloat.style.width = '';
      }
    }
  }
  calFloat?.classList.add('open');
  // body.cal-open is the CSS hook that slides the detail panel back
  // down (translateY 100% + opacity 0) AND fades the FTS slider out.
  // The outside-click handler now excludes fts-date-btn so the
  // calendar doesn't auto-close mid-tap.
  document.body.classList.add('cal-open');
  // On mobile, add a backdrop overlay behind the bottom-sheet calendar
  if (isMobile() && !document.getElementById('ptb-cal-backdrop')) {
    const bd = document.createElement('div');
    bd.id = 'ptb-cal-backdrop';
    bd.className = 'invite-backdrop';
    bd.onclick = () => _closeQcPanel();
    document.body.appendChild(bd);
    // Commit the transparent state (forced reflow) before adding .open so the
    // 0.3s background transition fires — a bare rAF sometimes batched both into
    // one paint, making the dim appear instantly.
    void bd.offsetWidth;
    bd.classList.add('open');
  }
  // Mark header date chip as active while picker is open
  if (USE_FLOATING_TIME_SLIDER) {
    document.getElementById('header-date-chip')?.classList.add('active');
    document.getElementById('fts')?.classList.add('fts-cal-open');
  }
  // On mobile, fully slide the list off-screen (not just to peek) so nothing
  // shows behind the calendar sheet; restored to its prior state on close.
  if (isMobile() && typeof window._applyMobilePanelState === 'function') {
    _preCalPanelState = window._currentMobilePanelState?.() ?? 'peek';
    window._applyMobilePanelState('hidden');
  }
  panel.classList.add('open');
  document.getElementById('qc-date-section')?.classList.add('active');
  renderQcCalendar();
  if (!_qcCalExpanded) _syncQcPanelHeight();
}

function renderQcCalendar() {
  const cal = document.getElementById('qc-cal');
  if (!cal) return;
  if (_qcCalExpanded) {
    _renderQcCalendarMonth(cal);
  } else {
    _renderQcCalendarStrip(cal);
  }
}

// Determine how many days ahead have weather forecast data by checking
// the first date where getDayWeatherSummary returns null.
function _wxForecastDays() {
  let limit = 0;
  for (let i = 0; i < 20; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const dStr = d.toISOString().slice(0, 10);
    if (typeof getDayWeatherSummary === 'function' && getDayWeatherSummary(dStr)) {
      limit = i + 1;
    } else if (limit > 0) {
      break;
    }
  }
  return limit || 10; // fallback if weather not loaded yet
}

function _dcTileHtml(dStr, todayStr_, selected) {
  const d    = new Date(dStr + 'T12:00:00');
  const DAYS = tA('days_short');
  const summ = typeof getDayWeatherSummary === 'function' ? getDayWeatherSummary(dStr) : null;
  const hasForecast = summ != null;

  let cls = 'dc-tile';
  if (dStr === todayStr_)  cls += ' today';
  if (dStr === selected)   cls += ' selected';
  if (hasForecast) {
    // Border classified on avgSunBlock (same value the icon uses) through the
    // canonical wxClassify, so tint and glyph agree. Three sunny tiers → high.
    const sb = summ.avgSunBlock ?? summ.avgCloud ?? 0;
    const dc = (typeof wxClassify === 'function') ? wxClassify(sb, 0) : 'clear';
    if (dc === 'clear' || dc === 'clearSoft') cls += ' sun-high';
    else if (dc === 'partly')                 cls += ' sun-mid';
    else                                      cls += ' sun-low'; // overcast — dimmed
  } else {
    cls += ' solar-only'; // beyond forecast window — solar data only
  }

  // SVG glyph (parity with top-strip / date-strip) — avoids iOS WKWebView
  // tofu on the cloud emoji codepoints.
  const sbForIcon = hasForecast ? (summ.avgSunBlock ?? summ.avgCloud ?? 0) : null;
  const icon = (hasForecast && typeof skyIconSvg === 'function')
    ? skyIconSvg(sbForIcon)
    : (hasForecast ? summ.icon : '');
  const temp = hasForecast ? `${summ.peakTemp}°` : '';

  // Today indicator: --accent dot, centered in flow, below day number / glyph
  const todayDot = dStr === todayStr_ ? '<span class="dc-today-dot" aria-hidden="true"></span>' : '';

  return `<button class="${cls}" onclick="selectQcDate('${dStr}')" title="${hasForecast ? '' : 'Ingen prognose — sol/skygge kun'}">`
    + `<span class="dc-day">${DAYS[d.getDay()]}</span>`
    + `<span class="dc-num">${d.getDate()}</span>`
    + `<span class="dc-icon">${icon}</span>`
    + `<span class="dc-temp">${temp}</span>`
    + todayDot
    + `</button>`;
}

function _renderQcCalendarStrip(cal) {
  const today_   = todayStr();
  const selected = datePicker.value;
  const fxDays   = _wxForecastDays();

  const stripDays = isMobile() ? 10 : 14; // 5×2 on mobile, 7×2 on desktop
  let html = '<div class="dc-grid">';

  for (let i = 0; i < stripDays; i++) {
    const d    = new Date(); d.setDate(d.getDate() + i);
    const dStr = d.toISOString().slice(0, 10);
    html += _dcTileHtml(dStr, today_, selected);
  }

  html += '</div>';

  const chevDown = `<svg class="dc-btn-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  html += `<button class="dc-expand-btn-wide" onclick="event.stopPropagation();_toggleQcCalExpand()">Vis full kalender ${chevDown}</button>`;

  cal.innerHTML = html;
}

function _isoWeek(year, month, day) {
  const d = new Date(Date.UTC(year, month, day));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const y1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y1) / 86400000 + 1) / 7);
}

function _renderQcCalendarMonth(cal) {
  const now      = new Date();
  const today_   = todayStr();
  const selected = datePicker.value;
  const MONTH_NAMES = tA('months_long');
  const DAY_ABBR    = tA('day_abbr');
  const _p2 = n => String(n).padStart(2, '0');

  // Scroll container wraps both the sticky weekday row AND the month grid.
  // CSS sticky handles month-label pinning — no JS scroll listener needed.
  let html = '<div class="dc-cal-scroll">';

  // Weekday row — sticky at top of scroll area (position: sticky; top: 0 in CSS)
  html += '<div class="dc-weekday-row">';
  DAY_ABBR.forEach(a => { html += `<span class="dc-weekday">${a}</span>`; });
  html += '</div>';

  // Continuous month grid — no week-number column; 7-column pure day grid
  html += '<div class="dc-grid dc-month-grid">';

  // Start from Monday of current week
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayDow  = (todayDate.getDay() + 6) % 7; // Mon=0
  const startMon  = new Date(todayDate);
  startMon.setDate(todayDate.getDate() - todayDow);

  let prevMonthKey = null;

  for (let w = 0; w < 56; w++) { // ~13 months of weeks
    const mon  = new Date(startMon);
    mon.setDate(startMon.getDate() + w * 7);
    const monY = mon.getFullYear();
    const monM = mon.getMonth();

    // Insert month label on the week that contains the 1st of a new month.
    // (Not when Monday crosses months — if the 1st falls mid-week the Monday
    //  is still in the previous month, so we scan all 7 days instead.)
    // For the very first week, fall back to Monday's month if no 1st is present.
    let labelM = null, labelY = null;
    for (let sd = 0; sd < 7; sd++) {
      const probe = new Date(startMon);
      probe.setDate(startMon.getDate() + w * 7 + sd);
      if (probe.getDate() === 1) { labelM = probe.getMonth(); labelY = probe.getFullYear(); break; }
    }
    if (w === 0 && labelM === null) { labelM = monM; labelY = monY; }
    if (labelM !== null) {
      const mk = `${labelY}-${labelM}`;
      if (mk !== prevMonthKey) {
        prevMonthKey = mk;
        html += `<div class="dc-month-row-label">${MONTH_NAMES[labelM]} ${labelY}</div>`;
      }
    }

    // 7 day tiles Mon–Sun (no week-number cell)
    for (let d = 0; d < 7; d++) {
      const day  = new Date(startMon);
      day.setDate(startMon.getDate() + w * 7 + d);
      const yr   = day.getFullYear();
      const mo   = day.getMonth();
      const dt   = day.getDate();
      const dStr = `${yr}-${_p2(mo+1)}-${_p2(dt)}`;
      const isOv = mo !== monM;

      if (dStr < today_) {
        const cls = isOv ? 'dc-tile dc-tile-past dc-tile-overflow' : 'dc-tile dc-tile-past';
        html += `<div class="${cls}"><span class="dc-num">${dt}</span></div>`;
      } else {
        let tile = _dcTileHtml(dStr, today_, selected);
        if (isOv) tile = tile.replace('"dc-tile', '"dc-tile dc-tile-overflow');
        html += tile;
      }
    }
  }

  html += '</div>'; // .dc-month-grid
  html += '</div>'; // .dc-cal-scroll

  html += `<p class="dc-forecast-note">Værvarsel er tilgjengelig for de neste 10 dagene.</p>`;

  const chevUp = `<svg class="dc-btn-chev dc-btn-chev-up" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  html += `<button class="dc-expand-btn-wide" onclick="event.stopPropagation();_toggleQcCalExpand()">Skjul full kalender ${chevUp}</button>`;

  cal.innerHTML = html;
  _syncQcPanelHeightExpanded();
}


function _toggleQcCalExpand() {
  const collapsing = _qcCalExpanded; // true if we're about to collapse
  const qcPanel = document.getElementById('qc-panel');
  const _calEl  = document.getElementById('qc-cal');

  // Capture expanded height BEFORE swapping content
  let expandedH = 0;
  if (collapsing && qcPanel) expandedH = qcPanel.scrollHeight;

  _qcCalExpanded = !_qcCalExpanded;

  // Hide before render to prevent flash of un-animated content
  if (_calEl) {
    _calEl.classList.remove('dc-cal-entering');
    _calEl.style.opacity = '0';
  }
  renderQcCalendar();
  // Single rAF: restore visibility and start animation
  requestAnimationFrame(() => {
    if (_calEl) {
      _calEl.style.removeProperty('opacity');
      _calEl.classList.add('dc-cal-entering');
    }
  });

  if (collapsing && qcPanel) {
    // Freeze at expanded height, then animate to compact strip height
    qcPanel.style.setProperty('--qc-panel-h', expandedH + 'px');
    qcPanel.classList.remove('cal-expanded');
    // Force layout so the browser registers the starting max-height
    qcPanel.offsetHeight; // eslint-disable-line no-unused-expressions
    _syncQcPanelHeight();
  }
}


function _syncQcPanelHeightExpanded() {
  const qcPanel = document.getElementById('qc-panel');
  if (!qcPanel) return;
  // Mark expanded so CSS applies max-height + scroll to #qc-cal.
  // --qc-panel-h only needs to be large enough for the transition to open fully;
  // the panel shrinks to content height because overflow:hidden clips to natural height.
  qcPanel.classList.add('cal-expanded');
  qcPanel.style.setProperty('--qc-panel-h', '500px');
  const dateSection = document.getElementById('qc-date-section');
  if (dateSection) dateSection.style.height = '';
}

function selectQcDate(dateStr) {
  const dateChanged = dateStr !== datePicker.value;
  datePicker.value = dateStr;
  // On any date change, snap the slider to the start of the first sun
  // window of the new day. Without this the slider sticks at the previous
  // hour (e.g. 22:00), stranding the user past sundown.
  if (dateChanged) {
    if (nowMode) {
      nowMode = false;
      clearInterval(nowInterval); nowInterval = null;
      nowBtn?.classList.remove('active');
      timeRangeWrap?.classList.remove('now-active');
    }
    setActiveIntentBtn(null);
    const sunWindow = _firstSunWindowStartFor(dateStr);
    timeFromEl.value = sunWindow != null ? sunWindow : 12;
    // Notify listeners that read timeFromEl via events (e.g. invite sheet
    // confirmation hook). update() handles the main rendering pipeline.
    timeFromEl.dispatchEvent(new Event('input'));
  }
  _closeQcPanel();
  document.getElementById('header-date-chip')?.focus();
  update();
}

/** Returns the sunrise hour for `dateStr`, or null if the sun never rises
 *  enough that day. Builds a temporary sun table — cheap, doesn't disturb
 *  the cached currentSunTable.
 *  Why no MIN_H_ARC floor here: MIN_H_ARC is set for the CURRENT date — on
 *  today it's "now". When the user picks a future date, flooring sunrise
 *  to today's "now" stranded the slider at the current time. update()
 *  auto-clamps timeFromEl.value to the new date's MIN_H_ARC after the sun
 *  table is rebuilt. */
function _earliestSunHourFor(dateStr) {
  if (typeof buildSunTable !== 'function' || typeof findSunCrossingFromTable !== 'function') return null;
  return findSunCrossingFromTable(buildSunTable(dateStr), true);
}

/** Returns the hour where the first *useful* sun window of `dateStr`
 *  begins. Rules:
 *    - Walk [sunrise, sunset] hour-by-hour.
 *    - A "sun-touched" hour has sunBlock < 0.75 (matches drawTimeline's
 *      "not overcast" cutoff — slider lands where the canvas first looks
 *      sun-touched).
 *    - Require a contiguous run of MIN_USEFUL_HOURS sun-touched hours
 *      before counting it as a window — a single sunny hour wedged
 *      between cloudy ones isn't worth surfacing.
 *    - Return the START of that first qualifying run. Falls back to
 *      sunrise on overcast / no-forecast days. */
function _firstSunWindowStartFor(dateStr) {
  if (typeof buildSunTable !== 'function' || typeof findSunCrossingFromTable !== 'function') return null;
  const table   = buildSunTable(dateStr);
  const sunrise = findSunCrossingFromTable(table, true);
  if (sunrise == null) return null;
  if (typeof getWeatherAt !== 'function') return sunrise;
  const sunset = findSunCrossingFromTable(table, false);
  const endH   = sunset != null ? Math.floor(sunset) : 21;
  const MIN_USEFUL_HOURS = 2;
  // Start at floor(sunrise) so we don't skip a half-hour-overlap with
  // sunrise itself — at high latitudes sunrise can land at e.g. 04:20
  // and Math.ceil() would otherwise push the scan to hour 5, missing
  // an already-sun-touched 04:00 slot. The eventual return value is
  // clamped to >= sunrise so the slider doesn't land before the sun
  // is actually up.
  let runStart = null, runLen = 0;
  for (let h = Math.floor(sunrise); h <= endH; h++) {
    const wx = getWeatherAt(dateStr, h);
    const blocked = wx?.sunBlock ?? wx?.cloud;
    // "Sun-touched" = any sunny tier (not overcast/rain), via canonical wxClassify.
    const cls = (blocked != null && typeof wxClassify === 'function')
      ? wxClassify(blocked, wx?.precip ?? 0) : null;
    const isSun = cls === 'clear' || cls === 'clearSoft' || cls === 'partly';
    if (isSun) {
      if (runStart == null) runStart = h;
      runLen++;
      if (runLen >= MIN_USEFUL_HOURS) return Math.max(sunrise, runStart);
    } else {
      runStart = null;
      runLen = 0;
    }
  }
  return sunrise;
}

let _qcPanelHeight = 0; // cached, set on load/resize/list-render

function _syncQcPanelHeight() {
  // Set --qc-panel-h large enough for the max-height transition.
  // The panel shrinks to content via overflow:hidden — no inline height needed.
  const qcPanel = document.getElementById('qc-panel');
  if (!qcPanel) return;
  const dateSection = document.getElementById('qc-date-section');
  if (dateSection) dateSection.style.height = '';
  // Use rAF to measure after render, so --qc-panel-h matches actual content
  requestAnimationFrame(() => {
    const h = qcPanel.scrollHeight || 290;
    qcPanel.style.setProperty('--qc-panel-h', h + 'px');
  });
}

// ── Peek height: measure handle + time bar + list-sun-header + venue-peek ────
function _updatePeekHeight() {
  if (!isMobile()) return;
  const panel = document.getElementById('panel');
  if (!panel) return;
  // Peek stack: handle (16) + FTS margin-top (20) + FTS (40) + FTS
  // margin-bottom (10) + action row (32 + 10 pad) + venue-peek pad (12)
  // + card top sliver (~18) = 158.
  panel.style.setProperty('--peek-h', '158px');
  _syncFtsPosition();
}

// Drop expensive backdrop-filter while the panel slides between
// peek/expanded/fullscreen — re-blurring the map underneath at 60fps
// was the visible lag on iOS Chrome PWA. Auto-managed via transition
// events so every class-change site benefits without code changes.
(function _wirePanelSlideClass() {
  const panel = document.getElementById('panel');
  if (!panel) return;
  let pending = 0;
  panel.addEventListener('transitionrun', (e) => {
    if (e.target !== panel) return;
    if (e.propertyName !== 'transform' && e.propertyName !== 'height') return;
    pending++;
    panel.classList.add('is-sliding');
  });
  const clear = (e) => {
    if (e.target !== panel) return;
    if (e.propertyName !== 'transform' && e.propertyName !== 'height') return;
    pending = Math.max(0, pending - 1);
    if (pending === 0) panel.classList.remove('is-sliding');
  };
  panel.addEventListener('transitionend',    clear);
  panel.addEventListener('transitioncancel', clear);
})();

// ── Venue peek: render actual first venue card into #venue-peek ──────────────
function updateVenuePeek(venues) {
  const el = document.getElementById('venue-peek');
  if (!el) return;
  const v = venues && venues[0];
  if (!v) { el.innerHTML = ''; _updatePeekHeight(); return; }

  const dateStr  = datePicker.value;
  const fromHour = parseFloat(timeFromEl.value);
  const toHour   = 23;
  const isPoint  = true;
  el.innerHTML = renderCard(v, dateStr, fromHour, toHour, isPoint);

  // Measure after content is set
  requestAnimationFrame(_updatePeekHeight);
}

// ── Main update cycle ─────────────────────────────────────────────────────────
function update() {
  const fromHour = parseFloat(timeFromEl.value);
  const dateStr  = datePicker.value;
  updateRangeFill();
  _aTrackTimeChange();

  // Rebuild sun table once per date change, then reuse for all lookups
  if (!currentSunTable || currentDateStr !== dateStr) {
    currentSunTable  = buildSunTable(dateStr);
    currentDateStr   = dateStr;
    sunWindowCache.clear();
    clearSpriteCache();
    if (typeof invalidateClassifyPin === 'function') invalidateClassifyPin();
    dispatchToWorker(dateStr);
  }

  currentSun = getSunFromTable(currentSunTable, fromHour);
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);

  // Dynamic arc range — place sunrise/sunset labels inside the pill's curved ends.
  // PAD_FRAC 0.06 means sunrise/sunset land ~6% from each pill edge, which equals
  // roughly TRACK_R pixels (≈13px) on a ~220px bar, consistently across all seasons.
  // On TODAY: anchor the slider's left edge to "now" so the draggable region
  // doesn't shrink as the day progresses. Past hours become unreachable. On
  // other dates the full sunrise→sunset day is reachable.
  if (sunrise != null && sunset != null) {
    SUNRISE_H_ARC = sunrise;
    SUNSET_H_ARC  = sunset;
    const _dayLen = sunset - sunrise;
    const _range  = _dayLen / (1 - 2 * 0.06);
    const _buf    = _range * 0.06;
    const _isToday = dateStr === todayStr();
    if (_isToday) {
      const nowH_ = new Date().getHours() + new Date().getMinutes() / 60;
      // Snap "now" to a 5-min grid so the leftmost reachable thumb position
      // matches the slider's step. Stay at sunrise pre-dawn so early-morning
      // users still see the full upcoming day.
      const nowSnapped = Math.round(nowH_ * 12) / 12;
      MIN_H_ARC = Math.max(2, Math.min(sunset + _buf - 0.0833, Math.max(sunrise - _buf, nowSnapped)));
    } else {
      MIN_H_ARC = Math.max(2, sunrise - _buf);
    }
    MAX_H_ARC = Math.min(24, sunset + _buf);
    // If the user's selected time is now in the past (e.g. clock ticked past
    // their selection), nudge it to MIN_H_ARC so the thumb stays on-canvas.
    if (parseFloat(timeFromEl.value) < MIN_H_ARC) timeFromEl.value = MIN_H_ARC;
    // Refresh DOM hour labels whenever the range changes — bookends shift.
    if (typeof _populateFtsEvents === 'function') _populateFtsEvents();
  }

  // Auto-advance to tomorrow after sunset (once per session startup)
  if (!_autoAdvancedAfterSunset && dateStr === todayStr() && sunset != null) {
    const realNow = new Date().getHours() + new Date().getMinutes() / 60;
    if (realNow > sunset) {
      _autoAdvancedAfterSunset = true;
      setTimeout(() => {
        advanceDay(1, 12);
        // qc-notice (transient picker hint) is enough — the auto-advance
        // toast was landing in the bell inbox and reading as a stored
        // event rather than a one-time "by the way, I bumped the date".
        showQcNotice(t('sunset_notice'));
      }, 0);
      return;
    }
  }

  // Status bar (elements may be absent if removed from HTML)
  document.getElementById('stat-azimuth')?.textContent != null && (document.getElementById('stat-azimuth').textContent  = currentSun.alt < 0 ? '—' : `${Math.round(currentSun.az)}°`);
  document.getElementById('stat-altitude')?.textContent != null && (document.getElementById('stat-altitude').textContent = currentSun.alt < 0 ? 'Below horizon' : `${Math.round(currentSun.alt)}°`);
  document.getElementById('stat-sunrise')?.textContent != null && (document.getElementById('stat-sunrise').textContent  = formatHour(sunrise));
  document.getElementById('stat-sunset')?.textContent != null && (document.getElementById('stat-sunset').textContent   = formatHour(sunset));

  // Sunrise–sunset highlight on slider track
  const sunBg = document.getElementById('time-range-sun-bg');
  if (sunBg && sunrise != null && sunset != null) {
    const slMin = 4, slMax = 23;
    const sp = Math.max(0, (sunrise - slMin) / (slMax - slMin) * 100);
    const ep = Math.min(100, (sunset  - slMin) / (slMax - slMin) * 100);
    sunBg.style.left    = sp.toFixed(2) + '%';
    sunBg.style.width   = Math.max(0, ep - sp).toFixed(2) + '%';
    sunBg.style.display = 'block';
  } else if (sunBg) { sunBg.style.display = 'none'; }

  draw();
  positionPresetButtons();
  scheduleRenderList();
  updatePopup();
  updateSunLighting();

  if (highlight.id != null && tooltip.classList.contains('visible')) {
    const hv = VENUES.find(x => x.id === highlight.id);
    if (hv) {
      tooltip.innerHTML = buildTooltipContent(hv);
      if (typeof drawAllCardTimelines === 'function') drawAllCardTimelines(tooltip);
    }
  }

  updateDateDisplayBtn();
  updateDateWeatherStrip();
  updateQcLabels();
  updateQcIndicator(null);
  syncFts();
  // _notifEvaluate is intentionally NOT called here — it runs on its own
  // 60s interval (see notifications.js _notifInit) and on datePicker change.
  // Firing it on every update() tick would re-evaluate every notification
  // rule 60× per second during slider drag, which both wastes work and
  // risks firing spurious notifications mid-drag.
}

// ── Popup helpers ─────────────────────────────────────────────────────────────

function popupSunLine(v) {
  const dateStr = datePicker.value;
  const hour    = parseFloat(timeFromEl.value);
  const { windows, open, close } = computeSunWindows(v, dateStr);
  const isOpen  = hour >= open && hour <= close;

  if (!isOpen) {
    const waitToOpen = open - hour;
    if (waitToOpen > 0 && waitToOpen <= 0.75) {
      return `<div class="popup-status opening-soon">Opens at ${formatHour(open)}</div>`;
    }
    return `<div class="popup-status shaded">Closed now</div>`;
  }

  const curWin = windows.find(w => hour >= w.start && hour < w.end);
  if (curWin) {
    const rem = curWin.end - hour;
    const h = Math.floor(rem), m = Math.round((rem - h) * 60);
    const dur = (h > 0 ? h + 'h ' : '') + (m > 0 ? m + 'm' : '');
    return `<div class="popup-status sunny"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg> In sun until ${formatHour(curWin.end)} · ${dur.trim()} left</div>`;
  }

  const next = windows.find(w => w.start > hour);
  if (next) {
    const wait = next.start - hour;
    const h = Math.floor(wait), m = Math.round((wait - h) * 60);
    const dur = (h > 0 ? h + 'h ' : '') + (m > 0 ? m + 'm' : '');
    return `<div class="popup-status shaded">● In shade · Sun at ${formatHour(next.start)} (${dur.trim()})</div>`;
  }

  return `<div class="popup-status shaded">${windows.length ? '● Sun passed for today' : '● No sun today'}</div>`;
}

function popupDirectionsUrl(v) {
  return `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`;
}

function _venueSlug(v) {
  return v.name.toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function shareVenue(venueId) {
  _aTrack('share', { venue_id: venueId, method: navigator.share ? 'native' : 'clipboard' });
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  const slug = _venueSlug(v);
  const d    = datePicker.value.replace(/-/g, '');          // 20260420
  const hNum = parseFloat(timeFromEl.value);
  const h    = String(Math.round(hNum)).padStart(2, '0');
  const url  = `${location.origin}${location.pathname}#${slug}-${venueId}/${d}T${h}`;
  // Compose text with sun-end time when available
  let sunUntil = null;
  if (typeof computeSunWindows === 'function') {
    const { windows } = computeSunWindows(v, datePicker.value) || {};
    if (windows && windows.length) {
      const cur  = windows.find(w => hNum >= w.start && hNum < w.end);
      const next = !cur ? windows.find(w => w.start > hNum) : null;
      const win  = cur || next;
      if (win) sunUntil = formatHour(win.end);
    }
  }
  const text = sunUntil
    ? t('share_venue_text',        { venue: v.name, sunUntil })
    : t('share_venue_text_no_sun', { venue: v.name, area: v.area || '' });
  if (navigator.share) {
    navigator.share({ title: `${v.name} — ${v.area}`, text, url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(`${text}\n${url}`).then(() => {
      // Confirm on whichever surface triggered the share. The list card swaps
      // its whole button label; the detail panel has a dedicated label span
      // (swapping the button's textContent there would drop the icon).
      const btn = document.querySelector(`.venue-card[data-vid="${venueId}"] .card-action-btn:last-child`);
      if (btn) { btn.textContent = t('copied'); setTimeout(() => btn.textContent = '⎘ ' + t('share'), 1500); }
      const dpLabel = document.querySelector('#detail-panel .dp-secondary-btn .dp-secondary-label');
      if (dpLabel) { const orig = dpLabel.textContent; dpLabel.textContent = t('copied'); setTimeout(() => { dpLabel.textContent = orig; }, 1500); }
    });
  }
}

const EDIT_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const DIR_ICON  = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;

function popupActionsHTML(v) {
  return `
    <div class="popup-actions">
      <a class="popup-directions-btn" href="${popupDirectionsUrl(v)}" target="_blank" rel="noopener">
        ${DIR_ICON} Directions
      </a>
      <button class="popup-edit-btn" onclick="if(popup)popup.remove();enterEditMode(${v.id})">
        ${EDIT_ICON} Edit
      </button>
    </div>`;
}

// ── Venue selection + popup ───────────────────────────────────────────────────
let _switchingVenue = false;

// ── Shared venue camera animation ────────────────────────────────────────────
// Single place for all venue camera animations — pin clicks AND list clicks.
// Uses easeTo (smooth interpolation) so the animation looks correct whether
// the user is already zoomed in (pin click) or coming from overview (list click).
function _flyToVenue(v) {
  // Dynamic fit-to-bounds: frame the outdoor seating area + the venue's own
  // building footprint, centered on the seating area. Large building → zooms
  // out more; small café → closer (zoom derived from the geometry extent, not
  // a fixed level). Falls back to a fixed, slightly zoomed-out level when no
  // geometry is available.
  const FALLBACK_ZOOM = 16.0;
  const ZOOM_MIN = 15.0, ZOOM_MAX = 17.0;

  // Padding reserves the (opaque) detail panel so the framed area lands in the
  // visible strip — deliberately panel-aware (unlike the translucent list).
  let padding;
  if (isMobile()) {
    // Reserve the ACTUAL half-open detail panel (58svh) plus a top inset for the
    // top-strip — so the seating centres in the middle of the visible map strip
    // rather than its top edge. (Was 0.69 + top:0, which over-reserved and
    // parked the seating high.)
    const vh = window.visualViewport?.height ?? window.innerHeight;
    padding = { top: 80, bottom: Math.round(vh * 0.58), left: 0, right: 0 };
  } else {
    const dp = document.getElementById('detail-panel');
    const padLeft = (dp && dp.classList.contains('open')) ? (dp.offsetLeft + dp.offsetWidth) : 0;
    padding = padLeft > 0 ? { left: padLeft, right: 0, top: 60, bottom: 0 }
                          : { top: 60, bottom: 60, left: 40, right: 40 };
  }

  // Bearing: face the seating area (wall bearing + 180). Only re-orient when
  // the current bearing is far off, so small selections don't spin the map.
  const wallBearing   = v.wallSegment?.bearing ?? v.facing;
  const targetBearing = (((wallBearing ?? 0) + 180) % 360);
  const curBearing    = ((map.getBearing() % 360) + 360) % 360;
  let   diff          = Math.abs(targetBearing - curBearing);
  if (diff > 180) diff = 360 - diff;
  const bearing = (diff > 60) ? targetBearing : map.getBearing();

  const PITCH = 45;

  // Collect the seating polygon verts ([lat,lng]) + the venue's own building
  // footprint ({lat,lon} within ~60 m). The camera frames the SEATING; the
  // building only informs the zoom.
  const pts = []; // [lng, lat]
  let cLat = 0, cLng = 0, cN = 0;
  const seating = (typeof getSeatingPolygon === 'function') ? getSeatingPolygon(v, { includeAi: true }) : null;
  if (Array.isArray(seating) && seating.length >= 3) {
    for (const p of seating) { pts.push([p[1], p[0]]); cLat += p[0]; cLng += p[1]; cN++; }
  }
  if (Array.isArray(v.nearbyBuildings)) {
    for (const b of v.nearbyBuildings) {
      const nodes = b && b.geometry;
      if (!Array.isArray(nodes) || nodes.length < 3) continue;
      const aLat = nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
      const aLon = nodes.reduce((s, n) => s + n.lon, 0) / nodes.length;
      if (Math.hypot(aLat - v.lat, aLon - v.lng) > 60 / 111320) continue; // own building only
      for (const n of nodes) pts.push([n.lon, n.lat]);
    }
  }

  let center = (cN > 0) ? [cLng / cN, cLat / cN] : [v.lng, v.lat];
  let zoom   = FALLBACK_ZOOM;

  // Frame from a bounds SYMMETRIC about the seating centroid (so the fit is
  // centred on the seating, not pulled toward an off-to-one-side building),
  // and crucially pass the SAME pitch + bearing to cameraForBounds so the fit
  // accounts for the dramatic tilt — a tilted view shows more ground, which
  // shifts both the zoom and the apparent centre. We then take the camera's
  // tilt-aware center + zoom (v3 cameraForBounds is pitch-aware).
  if (pts.length >= 3 && typeof map.cameraForBounds === 'function') {
    let hLng = 0, hLat = 0;
    for (const [lng, lat] of pts) {
      hLng = Math.max(hLng, Math.abs(lng - center[0]));
      hLat = Math.max(hLat, Math.abs(lat - center[1]));
    }
    if (hLng > 0 || hLat > 0) {
      try {
        const sym = new mapboxgl.LngLatBounds(
          [center[0] - hLng, center[1] - hLat],
          [center[0] + hLng, center[1] + hLat]
        );
        const cam = map.cameraForBounds(sym, { padding, bearing, pitch: PITCH, maxZoom: ZOOM_MAX });
        // Take only the tilt-aware ZOOM. Keep the explicit seating centroid as
        // the center — Mapbox places `center` at the padded-viewport optical
        // centre at any pitch, whereas cam.center is shifted to frame the bounds
        // in the tilted frustum (which pushed the seating toward the top).
        if (cam && typeof cam.zoom === 'number') zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, cam.zoom));
      } catch (e) { /* keep centroid + FALLBACK_ZOOM */ }
    }
  }

  map.easeTo({ center, zoom, pitch: PITCH, bearing, padding, duration: 600 });
}

function selectVenue(id, flyTo) {
  _aTrack('venue_view', { venue_id: id, source: flyTo ? 'list' : 'map' });
  const freshOpen = selectedId === null; // opening panel for the first time (not switching venues)
  selectedId = id;
  _navMode   = true;   // show all venues in radius, not just current map view
  clearSpriteCache();
  const v = VENUES.find(x => x.id === id);
  if (!v) return;

  if (flyTo) {
    // Save pre-select state (guarded so switching venues while one is open doesn't overwrite)
    if (_preSelectZoom === null) {
      _preSelectZoom   = map.getZoom();
      _preSelectCenter = map.getCenter();
      _frozenBounds    = map.getBounds();
    }
    _mapMovedWhileDetailOpen = false;
  }

  _switchingVenue = true;
  if (popup) { popup.remove(); popup = null; }
  _switchingVenue = false;

  if (freshOpen) _navPush('venue');

  openDetailPanel(v);
  draw();
  drawFtsCanvas();

  // renderList() rebuilds #venue-list from scratch — wipes any placeholder
  // openDetailPanel inserted and creates a fresh duplicate of the source
  // card. On mobile (during the open-morph) we defer it past the morph so
  // the user doesn't see a fresh duplicate alongside the lifted source.
  // Cancel any prior pending deferred render so rapid open/close/open doesn't
  // pile up timers (the most recent open's renderList wins).
  // Desktop: render immediately so the selected-card highlight updates.
  if (_deferredRenderListTimer) {
    clearTimeout(_deferredRenderListTimer);
    _deferredRenderListTimer = null;
  }
  if (isMobile() && document.body.dataset.dpMorph === '1') {
    _deferredRenderListTimer = setTimeout(() => {
      _deferredRenderListTimer = null;
      renderList();
    }, 720);
  } else {
    renderList();
  }

  // Camera pans immediately on click — the morph runs in the lower half of
  // the screen (panel rising), the fly-to runs in the upper half (visible map
  // area), so the two motions don't conflict.
  if (flyTo) _flyToVenue(v);

  setTimeout(() => {
    const card = document.querySelector(`.venue-card[data-vid="${id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

function updatePopup() {
  updateDetailPanel();
}

// ── Detail panel ──────────────────────────────────────────────────────────────

let _deferredRenderListTimer = null;  // pending renderList() from selectVenue
let _panelStateBeforeOpen = null; // 'fullscreen' | 'expanded' | 'peek' — restored on close


function openDetailPanel(v) {
  _aDetailOpenTs = Date.now();
  _aTrack('detail_open', { venue_id: v.id, time_slot: parseFloat(timeFromEl.value) });
  _mapMovedWhileDetailOpen = false;
  const dp      = document.getElementById('detail-panel');
  const content = document.getElementById('dp-content');
  if (!dp || !content) return;

  // Capture the venue list's state once per open transition so closeDetailPanel
  // can restore it. selectVenue() sets selectedId before calling openDetailPanel,
  // so gate on the panel's own .open class instead.
  if (!dp.classList.contains('open')) {
    const _panel = document.getElementById('panel');
    if (_panel?.classList.contains('mobile-fullscreen')) _panelStateBeforeOpen = 'fullscreen';
    else if (_panel?.classList.contains('mobile-expanded')) _panelStateBeforeOpen = 'expanded';
    else _panelStateBeforeOpen = 'peek';
  }

  content.innerHTML = renderDetailPanelContent(v, datePicker.value, parseFloat(timeFromEl.value));
  dp.classList.remove('dp-fullscreen');
  dp.classList.add('open');
  // Seed the locate-button cycle to 'venue' — selectVenue runs _flyToVenue
  // before this, so the camera is currently framed on the venue. First
  // tap on locate then moves to 'fit'. _setLocateBtnState handles the
  // animated icon swap (push-down) too.
  _setLocateBtnState('venue');

  _startWindForVenue(v);

  if (isMobile()) {
    document.getElementById('locate-btn')?.classList.add('mobile-ui-hidden');
    document.getElementById('zoom-jog')?.classList.add('mobile-ui-hidden');
    const panel = document.getElementById('panel');
    if (panel) {
      panel.classList.remove('mobile-expanded', 'mobile-fullscreen');
      panel.classList.add('mobile-hidden');
    }
    document.getElementById('floating-search')?.classList.add('mobile-ui-hidden');
    // top-strip intentionally NOT hidden — user needs the date/time
    // affordance to re-evaluate this venue at another moment.
    document.getElementById('qc-wrap')?.classList.add('mobile-ui-hidden');
  }

  _populateDpCardSlot(v);
  if (typeof _populateDpShelter === 'function') _populateDpShelter(v);
  if (typeof _updateFriendsPill === 'function') _updateFriendsPill();

  _syncFtsPosition();
  // Re-position the floating time label after the date pill slides in and
  // fts-track's margin-left transition completes (240ms ≥ 220ms transition).
  // Fallback in case transitionend doesn't fire (e.g., element invisible).
  if (USE_FLOATING_TIME_SLIDER) {
    setTimeout(() => {
      if (timeFromEl) showFtsPopup(parseFloat(timeFromEl.value));
    }, 240);
  }
}

/** Replace #dp-card-slot with the same venue-card the list renders. Calls
 *  renderCard() with the venue enriched the way renderList() enriches it
 *  (score, isOpen, isOpeningSoon, sunInWin) so the panel's card and the
 *  list's card are byte-identical for the same time/date. */
function _populateDpCardSlot(v) {
  const slot = document.getElementById('dp-card-slot');
  if (!slot || typeof renderCard !== 'function') return;
  const dateStr  = datePicker.value;
  const fromHour = parseFloat(timeFromEl.value);
  const enriched = _enrichVenueForCard(v, dateStr, fromHour);
  const tmp = document.createElement('div');
  // dpVariant: rows 1–3 from the compact list card (name+duration / meta /
  // v2 disruption pills) + the detailed timeline bar from the rich variant.
  // No bottom fill bar.
  tmp.innerHTML = renderCard(enriched, dateStr, fromHour, fromHour, true, { dpVariant: true });
  const newCard = tmp.firstElementChild;
  if (!newCard) return;
  newCard.classList.add('dp-card');
  newCard.classList.remove('selected');
  newCard.removeAttribute('onclick');
  newCard.removeAttribute('onmouseenter');
  newCard.removeAttribute('onmouseleave');
  slot.parentNode.replaceChild(newCard, slot);
  if (typeof drawAllCardTimelines === 'function') drawAllCardTimelines(newCard);
}

/** Mirror renderList's per-venue enrichment so renderCard receives the same
 *  shape it does inside the list (with .score, .isOpen, etc.). */
function _enrichVenueForCard(v, dateStr, fromHour) {
  const dayHours = (typeof getVenueHoursForDay === 'function')
    ? getVenueHoursForDay(v, dateStr) : { open: 0, close: 24 };
  const isOpen        = fromHour >= dayHours.open && fromHour <= dayHours.close;
  const isOpeningSoon = !isOpen && (dayHours.open - fromHour) > 0 && (dayHours.open - fromHour) <= 0.75;
  const isClosingSoon = isOpen  && (dayHours.close - fromHour) > 0 && (dayHours.close - fromHour) <= 0.5;
  const sunInWin = (typeof venueHasSunInRange === 'function')
    ? venueHasSunInRange(v, dateStr, fromHour, fromHour) : false;
  const wxNow = (typeof getWeatherAt === 'function') ? getWeatherAt(dateStr, fromHour) : null;
  const score = (typeof computeVenueScore === 'function')
    ? computeVenueScore(v, dateStr, fromHour, wxNow, userLocation) : null;
  return { ...v, sunInWin, isOpen, isOpeningSoon, isClosingSoon, score };
}

function _getWxNow() {
  return typeof getWeatherAt === 'function'
    ? getWeatherAt(datePicker.value, parseFloat(timeFromEl.value))
    : null;
}

function _startWindForVenue(v) {
  if (typeof startWindOverlay === 'function') startWindOverlay(v, _getWxNow());
}

function closeDetailPanel(expandList = true) {
  if (selectedId != null) {
    const dwell = _aDetailOpenTs ? Date.now() - _aDetailOpenTs : null;
    _aTrack('detail_close', { venue_id: selectedId, dwell_ms: dwell });
    _aDetailOpenTs = null;
  }
  if (_deferredRenderListTimer) {
    clearTimeout(_deferredRenderListTimer);
    _deferredRenderListTimer = null;
  }
  if (!_navHandlingPop) _navDropLayer('venue');
  if (typeof stopWindOverlay === 'function') stopWindOverlay();

  const dp = document.getElementById('detail-panel');
  if (dp) dp.classList.remove('open', 'dp-fullscreen');
  // Drop the locate-button cycle state when leaving the venue context —
  // back to single-action 'fly to me' (default user icon).
  _setLocateBtnState(null);
  if (typeof _updateFriendsPill === 'function') _updateFriendsPill();

  if (isMobile()) {
    const panel = document.getElementById('panel');
    if (panel) {
      panel.classList.remove('mobile-hidden', 'mobile-expanded', 'mobile-fullscreen');
      const prev = _panelStateBeforeOpen;
      if (prev === 'fullscreen')    panel.classList.add('mobile-fullscreen');
      else if (prev === 'expanded') panel.classList.add('mobile-expanded');
      else if (prev == null && expandList) panel.classList.add('mobile-expanded');
    }
    _panelStateBeforeOpen = null;
    document.getElementById('floating-search')?.classList.remove('mobile-ui-hidden');
    document.getElementById('top-strip')?.classList.remove('mobile-ui-hidden');
    document.getElementById('qc-wrap')?.classList.remove('mobile-ui-hidden');
    document.getElementById('locate-btn')?.classList.remove('mobile-ui-hidden');
    document.getElementById('zoom-jog')?.classList.remove('mobile-ui-hidden');
  }

  _syncFtsPosition();
  // Re-position the floating time label once the date pill slides out and
  // fts-track's margin-left returns to 0.
  if (USE_FLOATING_TIME_SLIDER) {
    setTimeout(() => {
      if (timeFromEl) showFtsPopup(parseFloat(timeFromEl.value));
    }, 240);
  }

  if (selectedId != null) {
    const idx = VENUES.findIndex(v => v.id === selectedId && v._isCandidate);
    if (idx !== -1) {
      VENUES.splice(idx, 1);
      if (typeof rebuildVenuesById === 'function') rebuildVenuesById();
    }

    selectedId = null;
    // Clear stale hover so the suppressed-while-selected hover ring doesn't
    // re-appear on the just-closed pin.
    highlight.id = null;
    highlight.source = null;
    _frozenBounds  = null;
    clearSpriteCache();
    draw();
    drawFtsCanvas();
    renderList();
    const interacted    = _mapMovedWhileDetailOpen;
    _mapMovedWhileDetailOpen = false;
    const restoreZoom   = _preSelectZoom  ?? map.getZoom();
    const restoreCenter = _preSelectCenter ?? map.getCenter();
    _preSelectZoom   = null;
    _preSelectCenter = null;
    if (interacted) {
      map.easeTo({ pitch: 15, bearing: 0, duration: 500,
                   padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    } else {
      map.easeTo({ center: restoreCenter, zoom: restoreZoom, pitch: 15, bearing: 0, duration: 600,
                   padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    }
  }
  // Post-accept hook: if the accept handler in ui-plan-preview set this
  // flag, transition into explore mode now (the user has finished
  // inspecting the venue they just accepted for). Cleared on
  // consumption so the next ordinary detail close doesn't fire it.
  if (typeof window !== 'undefined' && window._exitToExploreOnDetailClose) {
    window._exitToExploreOnDetailClose = false;
    setTimeout(() => {
      if (typeof _exitToExploreMode === 'function') _exitToExploreMode();
    }, 280);
  }
}

function updateDetailPanel() {
  if (selectedId == null) return;
  const dp      = document.getElementById('detail-panel');
  const content = document.getElementById('dp-content');
  if (!dp || !dp.classList.contains('open') || !content) return;
  if (!authCurrentUser()) return;
  const v = VENUES.find(x => x.id === selectedId);
  if (!v) return;

  // Preserve scroll position across the re-render. Notification toasts +
  // worker callbacks + 30s nowMode ticks all call updateDetailPanel; without
  // this save/restore each tick reset the user's scroll to the top of the
  // panel.
  const scroll = document.getElementById('dp-scroll');
  const savedScroll = scroll ? scroll.scrollTop : 0;
  content.innerHTML = renderDetailPanelContent(v, datePicker.value, parseFloat(timeFromEl.value));
  if (scroll && savedScroll) scroll.scrollTop = savedScroll;
  _populateDpCardSlot(v);
  if (typeof _populateDpShelter === 'function') _populateDpShelter(v);
  _startWindForVenue(v);
  if (typeof _updateFriendsPill === 'function') _updateFriendsPill();
}

/** Populate window._friendsPin with the data the canvas renderer needs
 *  to draw the invite-style avatar card above the venue when its detail
 *  panel is open and at least one friend is attending an upcoming plan.
 *  Mirrors the structure ui-plan-preview.js builds for window._invitePin,
 *  so render-pins.js can reuse _drawInviteAvatarPin verbatim. Cleared
 *  when no friends are going, the panel closes, or auth is anonymous. */
function _updateFriendsCanvasPin() {
  const prev = (typeof window !== 'undefined') ? window._friendsPin : null;
  const dp = document.getElementById('detail-panel');
  const isOpen = dp && dp.classList.contains('open') && selectedId != null;
  const dateStr = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : null;
  let next = null;
  if (isOpen && dateStr && typeof getPlansForVenue === 'function') {
    const plans = getPlansForVenue(selectedId) || [];
    // Pick the plan on the selected date — if multiple, prefer the one
    // closest to the slider's current hour so the meet-time bubble lines
    // up with what the user is looking at on the timeline.
    const fromHour = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : 12;
    const sameDate = plans.filter(p => typeof p.planned_at === 'string' && p.planned_at.slice(0, 10) === dateStr);
    let plan = null;
    if (sameDate.length) {
      sameDate.sort((a, b) => {
        const ha = new Date(a.planned_at).getHours() + new Date(a.planned_at).getMinutes() / 60;
        const hb = new Date(b.planned_at).getHours() + new Date(b.planned_at).getMinutes() / 60;
        return Math.abs(ha - fromHour) - Math.abs(hb - fromHour);
      });
      plan = sameDate[0];
    }
    if (plan && Array.isArray(plan._invitees)) {
      const myId = (typeof authCurrentUser === 'function' && authCurrentUser())
        ? authCurrentUser().id : null;
      const planDateMs = new Date(plan.planned_at).getTime();
      const planHour   = new Date(plan.planned_at).getHours()
                       + new Date(plan.planned_at).getMinutes() / 60;
      const fallbackName = (typeof t === 'function' ? t('attendee_someone') : 'Someone');
      const toAttendee = (inv) => {
        const u = inv.user || {};
        let offsetMin = 0;
        if (inv.arrival_time) {
          offsetMin = Math.round((new Date(inv.arrival_time).getTime() - planDateMs) / 60000);
        }
        const name = (u.name || u.email || '').split('@')[0] || fallbackName;
        return { id: u.id || null, name, offsetMin };
      };
      const attendees = [];
      const declined  = [];
      for (const inv of plan._invitees) {
        const u = inv.user || {};
        if (myId && u.id && String(u.id) === String(myId)) continue;
        if (inv.status === 'accepted') attendees.push(toAttendee(inv));
        else if (inv.status === 'declined') declined.push(toAttendee(inv));
      }
      if (attendees.length || declined.length) {
        next = { venueId: selectedId, meetHour: planHour, attendees, declined };
      }
    }
  }
  if (typeof window !== 'undefined') window._friendsPin = next;
  // Trigger a redraw only when the pin's presence actually changed, so
  // we don't thrash the canvas on every renderList tick.
  const _len = (p) => (p ? (p.attendees?.length || 0) + (p.declined?.length || 0) : 0);
  const changed = (!!prev) !== (!!next)
    || (prev && next && (prev.venueId !== next.venueId
                      || prev.meetHour !== next.meetHour
                      || _len(prev) !== _len(next)));
  if (changed && typeof draw === 'function') draw();
}
// Back-compat shim: external callers still reference _updateFriendsPill.
function _updateFriendsPill() { _updateFriendsCanvasPin(); }

/** Toggle the small dot on the search-bar avatar when ANYTHING is
 *  waiting for the user — incoming friend requests OR pending plan
 *  invites they haven't responded to. The full breakdown lives in the
 *  profile panel's Activity view; the dot is just the at-a-glance
 *  'you have something waiting' signal. */
/** Cold-link welcome card for anon visitors clicking #friend/<id>.
 *  Looks up the sender's name (best-effort via the public profile read),
 *  shows a centred glass card naming them, and opens the profile login
 *  panel on tap. Auto-dismisses after sign-in via the auth-state-change
 *  resume in auth.js. */
async function _showFriendInviteWelcome(friendUserId) {
  let senderName = '';
  try {
    const { data: prof } = await _supabase
      .from('profiles').select('name, email').eq('id', friendUserId).single();
    if (prof) senderName = (prof.name || prof.email || '').split('@')[0];
  } catch (e) { /* ignore — falls back to generic copy */ }
  const existing = document.getElementById('friend-invite-welcome');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.id = 'friend-invite-welcome';
  wrap.className = 'friend-invite-welcome';
  const titleKey = senderName ? 'friend_welcome_title' : 'friend_welcome_title_generic';
  wrap.innerHTML = `
    <div class="fiw-card glass-panel">
      <div class="fiw-icon" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
      </div>
      <div class="fiw-title">${t(titleKey, { name: senderName || '' })}</div>
      <div class="fiw-sub">${t('friend_welcome_sub')}</div>
      <button class="p-pill fiw-cta" type="button" onclick="_fiwSignIn()">${t('friend_welcome_cta')}</button>
      <button class="fiw-dismiss" type="button" onclick="_fiwDismiss()">${t('friend_welcome_dismiss')}</button>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('show'));
}

function _fiwSignIn() {
  if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
}
function _fiwDismiss() {
  const wrap = document.getElementById('friend-invite-welcome');
  if (!wrap) return;
  wrap.classList.remove('show');
  setTimeout(() => wrap.remove(), 280);
  // Clear the pending state so a later auth event doesn't fire the
  // friendship insert behind the user's back.
  if (typeof window !== 'undefined') window._pendingFriendInvite = null;
  if (typeof history !== 'undefined') history.replaceState(null, '', location.pathname);
}
if (typeof window !== 'undefined') {
  window._showFriendInviteWelcome = _showFriendInviteWelcome;
  window._fiwSignIn = _fiwSignIn;
  window._fiwDismiss = _fiwDismiss;
}

/** Auto-dismiss the welcome card the moment a friendship insert
 *  resolves successfully. Wired via _tryFriendInvite -> on success. */
function _dismissFriendInviteWelcomeIfOpen() {
  const wrap = document.getElementById('friend-invite-welcome');
  if (wrap) _fiwDismiss();
}
if (typeof window !== 'undefined') window._dismissFriendInviteWelcomeIfOpen = _dismissFriendInviteWelcomeIfOpen;

function _updateAvatarBadge() {
  const btn = document.getElementById('search-profile-btn');
  // "Has unread" = pending friend reqs OR pending plan invites OR any
  // captured notification newer than the last bell-open timestamp.
  // _bellHasUnread (auth.js) consolidates the check across all three.
  const has = (typeof _bellHasUnread === 'function')
    ? _bellHasUnread()
    : (((typeof _pendingRequests !== 'undefined' && _pendingRequests.length) || 0)
     + ((typeof _planInvites !== 'undefined'
         && _planInvites.filter(i => i.status === 'pending' && i.plan).length) || 0)
       ) > 0;
  if (btn) btn.classList.toggle('has-badge', has);
  const dot = document.getElementById('ts-bell-dot');
  if (dot) dot.style.display = has ? 'block' : 'none';
  if (typeof _renderBellDropdown === 'function'
      && document.getElementById('bell-dropdown')?.classList.contains('open')) {
    _renderBellDropdown();
  }
}

if (typeof window !== 'undefined') {
  window._updateFriendsPill  = _updateFriendsPill;
  window._updateAvatarBadge  = _updateAvatarBadge;
}

// ── Edit mode ─────────────────────────────────────────────────────────────────
function _venueEditSnapshot(v) {
  return {
    terraceType:             v.terraceType ?? 'street',
    terraceWallIndices:      (v.terraceWallIndices ?? []).slice(),
    terraceDepth:            v.terraceDepth ?? null,
    terraceWallTrimStart:    v.terraceWallTrimStart ?? null,
    terraceWallTrimEnd:      v.terraceWallTrimEnd   ?? null,
    facing:                  v.facing,
    facingSource:            v.facingSource ?? null,
    terraceDetachedLocation: v.terraceDetachedLocation ? { ...v.terraceDetachedLocation } : null,
    // Manual seating polygon edit (vertex-drag in render-editor). Captured
    // here so the corrections-log → merge-seating-corrections.mjs round trip
    // sees the edit and writes it into data/seating-detected.json.
    seatingPolygonOverride:  Array.isArray(v.seatingPolygonOverride) ? v.seatingPolygonOverride.map(p => p.slice()) : null,
    // Courtyard / detached polygons for the new resizable shapes.
    courtyardPolygon:        Array.isArray(v.courtyardPolygon) ? v.courtyardPolygon.map(p => p.slice()) : null,
    detachedPolygon:         Array.isArray(v.detachedPolygon)  ? v.detachedPolygon.map(p => p.slice())  : null,
  };
}

/** Apply a snapshot back to a venue object and its localStorage cache (used when reverting a proposal). */
function _applyVenueSnapshot(v, snap) {
  v.terraceType             = snap.terraceType;
  v.terraceWallIndices      = (snap.terraceWallIndices ?? []).slice();
  v.terraceDepth            = snap.terraceDepth;
  v.terraceWallTrimStart    = snap.terraceWallTrimStart ?? null;
  v.terraceWallTrimEnd      = snap.terraceWallTrimEnd   ?? null;
  v.facing                  = snap.facing;
  v.facingSource            = snap.facingSource;
  v.terraceDetachedLocation = snap.terraceDetachedLocation ? { ...snap.terraceDetachedLocation } : null;
  v.seatingPolygonOverride  = Array.isArray(snap.seatingPolygonOverride) ? snap.seatingPolygonOverride.map(p => p.slice()) : null;
  v.courtyardPolygon        = Array.isArray(snap.courtyardPolygon) ? snap.courtyardPolygon.map(p => p.slice()) : null;
  v.detachedPolygon         = Array.isArray(snap.detachedPolygon)  ? snap.detachedPolygon.map(p => p.slice())  : null;
  saveFacingCache(v.id, v.facing, v.facingSource,
    v.terraceWallIndices, v.terraceDepth, null, v.terraceType, v.terraceDetachedLocation,
    v.terraceWallTrimStart, v.terraceWallTrimEnd, v.seatingPolygonOverride);
}

/** Called from auth.js adminApproveEdit — applies an approved proposal to local state. */
function applyVenueEditProposal(venueId, afterState) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  _applyVenueSnapshot(v, afterState);
  saveCorrection('correction', {
    id: v.id, name: v.name, category: v.category,
    before: _venueEditSnapshot(v),
    after: afterState,
    buildingNodeCount: v.buildingGeometry?.length ?? null,
  });
  sunWindowCache.clear();
  dispatchToWorker(datePicker.value);
  clearSpriteCache();
  draw();
  renderList();
}

/** Submit a proposed edit from a non-admin user to Supabase. */
async function submitEditProposal(v, before, after) {
  _aTrack('edit_proposal_submit', { venue_id: v.id });
  const user = authCurrentUser();
  if (!user) return;
  const { error } = await _supabase
    .from('pending_edits')
    .insert({
      venue_id:    v.id,
      venue_name:  v.name,
      user_id:     user.id,
      user_email:  user.email,
      user_name:   user.user_metadata?.name ?? null,
      before_state: before,
      after_state:  after,
    });
  if (error) {
    showMapToast('Kunne ikke sende forslag. Prøv igjen.', 3500);
  } else {
    showMapToast('Forslag sendt for godkjenning!', 3000);
  }
}

function enterEditMode(venueId) {
  _aTrack('edit_mode_enter', { venue_id: venueId });
  if (typeof stopWindOverlay === 'function') stopWindOverlay();
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;

  _navPush('edit');

  // body.edit-mode hides notifications + repositions zoom-jog/FTS via CSS.
  // body.edit-satellite is set immediately so the FTS doesn't flash visible
  // before the satellite tiles arrive.
  document.body.classList.add('edit-mode');
  document.body.classList.add('edit-satellite');
  document.getElementById('edit-overlay').style.display = 'flex';
  const _fsEdit = document.getElementById('floating-search');
  if (_fsEdit) _fsEdit.style.display = 'none';
  const _tsEdit = document.getElementById('top-strip');
  if (_tsEdit) _tsEdit.style.display = 'none';
  document.getElementById('panel').style.display = 'none';
  document.getElementById('detail-panel').style.display = 'none';
  document.getElementById('qc-wrap').style.display = 'none';
  document.getElementById('qc-panel').style.display = 'none';
  document.getElementById('panel-reveal-btn').style.display = 'none';
  const _locateBtn = document.getElementById('locate-btn');
  if (_locateBtn) _locateBtn.style.display = 'none';
  // Detail panel may have added mobile-ui-hidden (display:none) to the zoom-jog
  // when it opened. Strip that here so our edit-mode CSS rules can show it.
  // We'll restore on exit if it was set.
  const _zj = document.getElementById('zoom-jog');
  _editPriorZoomHidden = !!_zj?.classList.contains('mobile-ui-hidden');
  _zj?.classList.remove('mobile-ui-hidden');
  _wireTypeDropdown();
  _startEditBannerObserver();
  // Switch to satellite immediately — Mapbox handles the cross-fade for us.
  // (Replaces the previous map.once('moveend') deferral so the camera animates
  // ON the satellite tiles rather than after them.)
  editSatelliteActive = true;
  _syncMapToggleSwitch();
  map.setStyle('mapbox://styles/mapbox/satellite-streets-v12');
  _syncFtsPosition();

  if (popup) { popup.remove(); popup = null; }
  tooltip.classList.remove('visible');

  // Per-venue setup (also re-run on auto-advance to the next venue).
  _loadVenueIntoEditor(venueId);
}

/** Load a venue into the (already-open) editor: snapshot, labels, camera,
 *  audit-top header + progress. Reused by enterEditMode and the audit
 *  auto-advance so walking the catalog never tears down the edit chrome. */
function _loadVenueIntoEditor(venueId) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;
  editingVenueId     = venueId;
  editHoveredWallIdx = null;
  if (typeof setEditVertexMode === 'function') setEditVertexMode(null);

  _editBeforeSnapshot = _venueEditSnapshot(v);
  _editHasChanges = false;

  // Broadcast that I'm editing this venue (soft edit-lock for other admins).
  if (typeof auditStorePresenceTrack === 'function') auditStorePresenceTrack(venueId);

  const lbl = document.getElementById('edit-venue-label');
  if (lbl) lbl.textContent = v.name;
  const type = v.terraceType ?? 'street';
  _syncTerraceTypeUI(type);
  _updateEditActionBtn();
  _updateEditToolButtons();
  _updateAuditEditTop(v);
  _updateAuditProgress();

  if (v.buildingGeometry) {
    const lats = v.buildingGeometry.map(n => n.lat);
    const lons = v.buildingGeometry.map(n => n.lon);
    map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 110, maxZoom: 19, pitch: 0, duration: 900 }
    );
  } else {
    map.flyTo({ center: [v.lng, v.lat], zoom: 19, pitch: 0, duration: 900 });
  }

  // Scroll to + highlight the venue card in the sidebar (no-op while the panel
  // is hidden during audit edit, but keeps non-audit edits anchored).
  setTimeout(() => {
    document.querySelectorAll('.venue-card.editing').forEach(c => c.classList.remove('editing'));
    const card = document.querySelector(`.venue-card[data-vid="${venueId}"]`);
    if (card) {
      card.classList.add('editing');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 200);

  draw();
}

/** Update the edit-mode top header (name · area · type) for bearings. */
function _updateAuditEditTop(v) {
  const nameEl = document.getElementById('edit-top-name');
  const metaEl = document.getElementById('edit-top-meta');
  if (nameEl) nameEl.textContent = v.name || '—';
  if (metaEl) {
    const parts = [v.area, (typeof catLabel === 'function' ? catLabel(v) : v.category)].filter(Boolean);
    metaEl.textContent = parts.join(' · ');
  }
}

/** Update the overall audit-completion progress bar + count. */
function _updateAuditProgress() {
  const fill  = document.getElementById('edit-progress-fill');
  const count = document.getElementById('edit-top-count');
  if (!fill && !count) return;
  if (typeof auditTotalCount !== 'function') return;
  const total    = auditTotalCount();
  const archived = (typeof auditArchivedCount === 'function') ? auditArchivedCount() : 0;
  const done     = (typeof auditReviewedCount === 'function') ? auditReviewedCount() : 0;
  const denom    = Math.max(1, total - archived);
  const pct      = Math.min(100, Math.round((done / denom) * 100));
  if (fill)  fill.style.width = pct + '%';
  if (count) count.textContent = `${done} / ${denom}`;
}

/** Next venue to audit after `afterId`, following the current list order
 *  (_listFiltered = filtered+sorted audit list). Skips reviewed + archived;
 *  wraps to the top; returns null when every venue is done. */
function _nextUnreviewedVenueId(afterId) {
  const list = (typeof _listFiltered !== 'undefined' && Array.isArray(_listFiltered) && _listFiltered.length)
    ? _listFiltered : VENUES;
  if (!list || !list.length) return null;
  const needsReview = (v) => v
    && !v.auditArchived
    && !(typeof isVenueAudited === 'function' && isVenueAudited(v));
  const startIdx = list.findIndex(v => v.id === afterId);
  // Scan forward from after the current venue, then wrap around to the start.
  for (let step = 1; step <= list.length; step++) {
    const v = list[((startIdx >= 0 ? startIdx : 0) + step) % list.length];
    if (needsReview(v)) return v.id;
  }
  return null;
}

/** Previous venue in the current list order (for the editor "back" control). */
function _prevVenueId(beforeId) {
  const list = (typeof _listFiltered !== 'undefined' && Array.isArray(_listFiltered) && _listFiltered.length)
    ? _listFiltered : VENUES;
  if (!list || !list.length) return null;
  const idx = list.findIndex(v => v.id === beforeId);
  if (idx < 0) return list[0]?.id ?? null;
  const prev = list[(idx - 1 + list.length) % list.length];
  return prev ? prev.id : null;
}

/** Editor "back": jump to the previous venue without marking the current one. */
function editGoBack() {
  if (!editingVenueId) return;
  const prevId = _prevVenueId(editingVenueId);
  // Discard any in-progress changes on the current venue before leaving.
  if (_editBeforeSnapshot) {
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) _applyVenueSnapshot(v, _editBeforeSnapshot);
    sunWindowCache.clear();
    dispatchToWorker(datePicker.value);
  }
  if (prevId != null) _loadVenueIntoEditor(prevId);
}

/** Editor "skip": advance to the next unreviewed venue without marking current.
 *  Discards in-progress edits on the current venue (revert to its snapshot). */
function editSkip() {
  if (!editingVenueId) return;
  if (_editBeforeSnapshot) {
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) _applyVenueSnapshot(v, _editBeforeSnapshot);
    sunWindowCache.clear();
    dispatchToWorker(datePicker.value);
  }
  const nextId = _nextUnreviewedVenueId(editingVenueId);
  if (nextId != null) { _loadVenueIntoEditor(nextId); return; }
  if (typeof showMapToast === 'function') showMapToast('Ingen flere å gå gjennom', 2200);
}

/** Collapse / expand the edit sheet (grabber tap) to free up the work area. */
function toggleEditSheet() {
  const ov = document.getElementById('edit-overlay');
  if (ov) ov.classList.toggle('edit-collapsed');
}

/** Swipe DOWN on the edit-sheet grabber → exit the editor back to the list. */
(function _wireEditGrabberSwipe() {
  const g = document.getElementById('edit-grabber');
  if (!g) return;
  let startY = null;
  g.addEventListener('touchstart', e => { startY = e.touches[0]?.clientY ?? null; }, { passive: true });
  g.addEventListener('touchmove', e => {
    if (startY == null) return;
    const dy = (e.touches[0]?.clientY ?? startY) - startY;
    if (dy > 40) { startY = null; if (typeof exitEditMode === 'function') exitEditMode(); }
  }, { passive: true });
  g.addEventListener('touchend',   () => { startY = null; }, { passive: true });
  g.addEventListener('touchcancel', () => { startY = null; }, { passive: true });
})();

// ── Audit card click → focus on satellite (no detail panel, no edit) ─────────
let _auditSatActive = false;
/** Clicking an audit card pans the map to the venue and switches the base to
 *  satellite — a quick look without opening the editor or a detail panel. The
 *  venue list stays open; the card gets a selection border. */
function auditFocusVenue(venueId) {
  const v = VENUES.find(x => x.id === venueId);
  if (!v || typeof map === 'undefined') return;
  // Clicking the already-focused card toggles back to the default 3D map.
  if (window._auditFocusId === venueId) {
    _resetAuditSatellite();
    return;
  }
  window._auditFocusId = venueId;
  document.querySelectorAll('.venue-card.audit-focus').forEach(c => c.classList.remove('audit-focus'));
  document.querySelector(`.venue-card[data-vid="${venueId}"]`)?.classList.add('audit-focus');
  // Switch the base map to satellite once — the admin is reviewing imagery.
  if (!_auditSatActive && map.setStyle) {
    _auditSatActive = true;
    try { map.setStyle('mapbox://styles/mapbox/satellite-streets-v12'); } catch (_) {}
  }
  // Panel-aware padding so the venue lands in the VISIBLE map strip, not under
  // the venue-list panel (bottom sheet on mobile, left panel on desktop).
  let padding;
  if (isMobile()) {
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const panel = document.getElementById('panel');
    const ph = (panel && panel.offsetHeight) ? panel.offsetHeight : Math.round(vh * 0.52);
    padding = { top: 80, bottom: ph + 16, left: 0, right: 0 };
  } else {
    const panel = document.getElementById('panel');
    const padLeft = (panel && panel.offsetWidth) ? (panel.offsetLeft + panel.offsetWidth) : 0;
    padding = { top: 60, bottom: 60, left: padLeft + 24, right: 40 };
  }

  if (v.buildingGeometry && v.buildingGeometry.length) {
    const lats = v.buildingGeometry.map(n => n.lat), lons = v.buildingGeometry.map(n => n.lon);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding, maxZoom: 19, pitch: 0, duration: 700 });
  } else {
    map.flyTo({ center: [v.lng, v.lat], zoom: 18.5, pitch: 0, padding, duration: 700 });
  }
}

/** Restore the styled (3D) map when leaving audit mode. Called from
 *  toggleAuditMode's off-branch. */
function _resetAuditSatellite() {
  window._auditFocusId = null;
  document.querySelectorAll('.venue-card.audit-focus').forEach(c => c.classList.remove('audit-focus'));
  if (_auditSatActive && typeof map !== 'undefined' && map.setStyle && typeof buildShadeStyle === 'function') {
    _auditSatActive = false;
    try { map.setStyle(buildShadeStyle()); } catch (_) {}
  }
}

let editSatelliteActive = false;

function toggleEditSatellite() {
  editSatelliteActive = !editSatelliteActive;
  document.body.classList.toggle('edit-satellite', editSatelliteActive);
  _syncMapToggleSwitch();
  map.setStyle(editSatelliteActive
    ? 'mapbox://styles/mapbox/satellite-streets-v12'
    : buildShadeStyle()
  );
}

/** Sync the segmented map-mode switch (Satellitt ↔ 3D-kart) with the active state.
 *  The thumb width tracks the currently-selected option so the highlight hugs
 *  the label rather than always being half the pill. */
function _syncMapToggleSwitch() {
  const tog = document.getElementById('edit-map-toggle');
  if (!tog) return;
  tog.setAttribute('aria-checked', editSatelliteActive ? 'true' : 'false');
  const sat = tog.querySelector('.map-toggle-option[data-option="satellite"]');
  const mp  = tog.querySelector('.map-toggle-option[data-option="map"]');
  const active = editSatelliteActive ? sat : mp;
  if (!active) return;
  // Wait one frame so the option layout settles before measuring.
  requestAnimationFrame(() => {
    const tx = active.offsetLeft;
    const tw = active.offsetWidth;
    tog.style.setProperty('--map-toggle-thumb-x', `${tx}px`);
    tog.style.setProperty('--map-toggle-thumb-w', `${tw}px`);
  });
}

// ── Edit-banner ResizeObserver (drives FTS + zoom-jog vertical positioning) ──
let _editBannerObserver = null;
let _editPriorZoomHidden = false;   // remembers if detail-panel had hidden zoom-jog
function _startEditBannerObserver() {
  const banner = document.getElementById('edit-banner');
  if (!banner || typeof ResizeObserver === 'undefined') return;
  if (_editBannerObserver) return;
  _editBannerObserver = new ResizeObserver(() => {
    const rect = banner.getBoundingClientRect();
    const viewportH = window.visualViewport?.height ?? window.innerHeight;
    // Distance from viewport bottom to the banner's TOP edge — handles desktop
    // 16px inset and mobile safe-area-inset-bottom uniformly. + FTS_GAP gives
    // the same pill→panel gap used by the venue list elsewhere.
    const above = Math.round(viewportH - rect.top + FTS_GAP);
    document.body.style.setProperty('--fts-bottom',       `${above}px`);
    document.body.style.setProperty('--edit-zoom-bottom', `${above}px`);
  });
  _editBannerObserver.observe(banner);
}
function _stopEditBannerObserver() {
  if (_editBannerObserver) {
    _editBannerObserver.disconnect();
    _editBannerObserver = null;
  }
  document.body.style.removeProperty('--edit-zoom-bottom');
}

/** Tilbakestill button: clear the manual polygon override / courtyard / detached
 *  override and fall back to the AI / wall-derived default. */
function resetEditPolygonToAI() {
  if (!editingVenueId) return;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;
  const type = v.terraceType ?? 'street';
  if (type === 'courtyard')      v.courtyardPolygon       = null;
  else if (type === 'detached')  v.detachedPolygon        = null;
  else                           v.seatingPolygonOverride = null;
  // Re-derive test points so the timeline/shadows reflect the cleared state.
  if (typeof computeTerraceTestPoints === 'function') {
    v.terraceTestPoints = computeTerraceTestPoints(v, null);
  }
  saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
    null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd,
    v.seatingPolygonOverride);
  sunWindowCache.clear();
  dispatchToWorker(datePicker.value);
  _setEditChanged();
  _updateEditToolButtons();
  draw();
}

/** Slå sammen button: merge multi-chain wall-derived polygons into a single
 *  polygon (baked into seatingPolygonOverride) so the user can edit it as one. */
function mergeEditPolygons() {
  if (!editingVenueId) return;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;
  if ((v.terraceType ?? 'street') !== 'street') return;
  if (v.seatingPolygonOverride) return;
  const walls = (typeof getTerraceWalls === 'function') ? getTerraceWalls(v) : [];
  if (walls.length < 2) return;
  const pxPerM  = pxPerMetre(v);
  const depthPx = getEffectiveDepth(v) * pxPerM;
  const polys = terracePolygons(v, walls, depthPx);
  if (polys.length < 2) return;
  // terracePolygons returns pixel-space polygons. Convert each to lat/lng,
  // then union via convex hull.
  const polysLL = polys.map(poly => poly.map(p => {
    const ll = map.unproject([p.x, p.y]);
    return [ll.lat, ll.lng];
  }));
  const merged = (typeof unionPolygons === 'function') ? unionPolygons(polysLL) : null;
  if (!merged || merged.length < 3) return;
  v.seatingPolygonOverride = merged;
  if (typeof seatingPolygonTestPoints === 'function') {
    const pts = seatingPolygonTestPoints(merged);
    if (pts.length) v.terraceTestPoints = pts;
  }
  saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
    null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd,
    v.seatingPolygonOverride);
  sunWindowCache.clear();
  dispatchToWorker(datePicker.value);
  _setEditChanged();
  _updateEditToolButtons();
  draw();
}

/** Cancel button: discard changes, exit edit mode without submitting. */
function cancelEditMode() {
  if (editingVenueId && _editBeforeSnapshot) {
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) _applyVenueSnapshot(v, _editBeforeSnapshot);
    sunWindowCache.clear();
    dispatchToWorker(datePicker.value);
  }
  // Bypass the "submit on exit" diff check — we've already reverted state.
  _editBeforeSnapshot = null;
  _editHasChanges = false;
  exitEditMode();
}

function exitEditMode() {
  if (!_navHandlingPop) _navDropLayer('edit');
  // Release the soft edit-lock so other admins can take this venue.
  if (typeof auditStorePresenceClear === 'function') auditStorePresenceClear();
  // Detect and record corrections before clearing state
  if (editingVenueId && _editBeforeSnapshot) {
    const v    = VENUES.find(x => x.id === editingVenueId);
    const after = v ? _venueEditSnapshot(v) : null;
    if (v && after && JSON.stringify(_editBeforeSnapshot) !== JSON.stringify(after)) {
      if (authCanDirectEdit()) {
        // Admin: save directly to corrections log
        saveCorrection('correction', {
          id: v.id, name: v.name, category: v.category,
          before: _editBeforeSnapshot,
          after,
          buildingNodeCount: v.buildingGeometry?.length ?? null,
        });
        // Editing a polygon implicitly counts as a polygon review.
        if (typeof markVenueAudited === 'function') markVenueAudited(v.id, 'edited');
      } else {
        // Regular user: submit proposal, revert local state
        submitEditProposal(v, _editBeforeSnapshot, after);
        _applyVenueSnapshot(v, _editBeforeSnapshot);
        sunWindowCache.clear();
        dispatchToWorker(datePicker.value);
      }
    }
  }
  _editBeforeSnapshot = null;
  _editHasChanges = false;
  editingVenueId = null;
  editHoveredWallIdx = null;
  document.body.classList.remove('edit-mode');
  document.body.classList.remove('edit-satellite');
  _stopEditBannerObserver();
  document.getElementById('edit-overlay').style.display = 'none';
  const _fsExit = document.getElementById('floating-search');
  if (_fsExit) _fsExit.style.display = '';
  const _tsExit = document.getElementById('top-strip');
  if (_tsExit) _tsExit.style.display = '';
  document.getElementById('panel').style.display = '';
  document.getElementById('detail-panel').style.display = '';
  document.getElementById('qc-wrap').style.display = '';
  document.getElementById('qc-panel').style.display = '';
  document.getElementById('panel-reveal-btn').style.display = '';
  const _locateBtn = document.getElementById('locate-btn');
  if (_locateBtn) _locateBtn.style.display = '';
  // Restore the zoom-jog's mobile-ui-hidden state if the detail panel had set it.
  if (_editPriorZoomHidden) {
    document.getElementById('zoom-jog')?.classList.add('mobile-ui-hidden');
  }
  _editPriorZoomHidden = false;
  // Reset vertex-tool state so the next edit session starts fresh.
  if (typeof setEditVertexMode === 'function') setEditVertexMode(null);
  document.querySelectorAll('.venue-card.editing').forEach(c => c.classList.remove('editing'));
  if (editSatelliteActive) {
    editSatelliteActive = false;
    map.setStyle(buildShadeStyle());
  }
  // The base is back on the shade style — let the next audit card click
  // re-enable satellite preview.
  _auditSatActive = false;
  map.easeTo({ pitch: 15, bearing: 0, duration: 500 });
  _syncFtsPosition();
  draw();
  renderList();
}

/** User confirmed the model is already correct — record as positive signal and close. */
function confirmEditCorrect() {
  if (editingVenueId && _editBeforeSnapshot) {
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) {
      saveCorrection('confirmed', {
        id: v.id, name: v.name, category: v.category,
        state: _editBeforeSnapshot,
        buildingNodeCount: v.buildingGeometry?.length ?? null,
      });
      // Confirming "looks good" inside the editor also ticks the audit box.
      if (typeof markVenueAudited === 'function') markVenueAudited(v.id, 'good');
    }
  }
  exitEditMode();
}

/** Commit the current venue for the audit walk-through (save a correction when
 *  changed, else a confirmation) and tick the audit box — WITHOUT tearing down
 *  the editor, so the caller can auto-advance to the next venue. */
function _commitEditForAudit() {
  if (!editingVenueId || !_editBeforeSnapshot) return;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;
  const meta = { id: v.id, name: v.name, category: v.category,
                 buildingNodeCount: v.buildingGeometry?.length ?? null };
  const after = _venueEditSnapshot(v);
  const changed = _editHasChanges && JSON.stringify(_editBeforeSnapshot) !== JSON.stringify(after);
  if (changed) {
    if (authCanDirectEdit()) {
      saveCorrection('correction', { ...meta, before: _editBeforeSnapshot, after });
      if (typeof markVenueAudited === 'function') markVenueAudited(v.id, 'edited');
    } else {
      submitEditProposal(v, _editBeforeSnapshot, after);
      _applyVenueSnapshot(v, _editBeforeSnapshot);
      sunWindowCache.clear();
      dispatchToWorker(datePicker.value);
    }
  } else {
    // markVenueAudited('good') already records a 'confirmed' correction —
    // don't double-save here.
    if (typeof markVenueAudited === 'function') markVenueAudited(v.id, 'good');
  }
}

/** Single adaptive button handler. In audit mode: commit + auto-advance to the
 *  next unreviewed venue (fast catalog walk-through). Otherwise: confirm (no
 *  changes) or save/submit (changes made) and close. */
function onEditActionBtn() {
  const auditing = (typeof auditModeActive !== 'undefined' && auditModeActive);
  if (!auditing) {
    if (_editHasChanges) exitEditMode();
    else                 confirmEditCorrect();
    return;
  }
  // Commit current venue, then jump straight to the next one to review.
  _commitEditForAudit();
  // Null the snapshot so exitEditMode (below / via back button) won't re-commit.
  const currentId = editingVenueId;
  _editBeforeSnapshot = null;
  _editHasChanges = false;
  const nextId = _nextUnreviewedVenueId(currentId);
  if (nextId != null) {
    _loadVenueIntoEditor(nextId);
    return;
  }
  _updateAuditProgress();
  if (typeof showMapToast === 'function') showMapToast('Alle steder gjennomgått 🎉', 2800);
  exitEditMode();
}

function _setEditChanged() {
  _editHasChanges = true;
  _updateEditActionBtn();
}

function _updateEditActionBtn() {
  const btn = document.getElementById('edit-action-btn');
  if (!btn) return;
  // Single primary-pill style; switches text and a no-changes ghost variant
  // when nothing has been edited yet so it still looks distinct from Avbryt.
  btn.classList.add('primary-pill');
  // In audit mode the action button is the screen's primary decision (commit +
  // advance) — keep it honey (DESIGN.md: one honey CTA per screen). Outside
  // audit, the no-changes confirm stays a quiet ghost.
  const auditing = (typeof auditModeActive !== 'undefined' && auditModeActive);
  btn.classList.toggle('is-no-changes', !_editHasChanges && !auditing);
  const next = auditing ? ' · neste' : '';
  if (!_editHasChanges) {
    btn.textContent = (auditing ? 'Bra' : 'Ser bra ut') + next;
  } else {
    btn.textContent = (authCanDirectEdit() ? 'Lagre' : 'Send forslag') + next;
  }
}

/** Show / hide AI-helper chips based on the active venue's polygon state. */
function _updateEditToolButtons() {
  if (!editingVenueId) return;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;

  // Tilbakestill: visible when there's an override that differs from the AI / wall-derived default.
  const resetBtn = document.getElementById('edit-reset-ai-btn');
  if (resetBtn) {
    const hasOverride = !!v.seatingPolygonOverride
      || !!v.courtyardPolygon
      || !!v.detachedPolygon;
    resetBtn.hidden = !hasOverride;
  }

  // Slå sammen: visible when the wall-derived preview yields ≥ 2 chains
  // (i.e. user selected non-adjacent walls). Once a polygon override exists
  // there's only one polygon, so the button hides automatically.
  const mergeBtn = document.getElementById('edit-merge-btn');
  if (mergeBtn) {
    let chains = 0;
    if ((v.terraceType ?? 'street') === 'street' && !v.seatingPolygonOverride
        && typeof getTerraceWalls === 'function'
        && typeof terracePolygons === 'function') {
      const walls = getTerraceWalls(v);
      if (walls.length) {
        const depthPx = getEffectiveDepth(v) * pxPerMetre(v);
        chains = terracePolygons(v, walls, depthPx).length;
      }
    }
    mergeBtn.hidden = chains < 2;
  }

  // Hjørne add/del chips: only meaningful for editable polygon types
  const type = v.terraceType ?? 'street';
  const polyEditable = type === 'street' || type === 'courtyard' || type === 'detached';
  ['edit-add-vertex-btn', 'edit-del-vertex-btn'].forEach(id => {
    const el = document.getElementById(id); if (el) el.hidden = !polyEditable;
  });
}

function selectWallByIdx(idx) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v?.wallNormals) return;

  if (!v.terraceWallIndices) v.terraceWallIndices = [];
  const pos = v.terraceWallIndices.indexOf(idx);
  if (pos >= 0) {
    v.terraceWallIndices.splice(pos, 1);   // deselect
  } else {
    v.terraceWallIndices.push(idx);        // add
  }

  // Street is wall-driven: re-picking walls rebuilds the polygon from
  // walls + depth, so drop any baked free-vertex override and let it re-derive.
  if (v.seatingPolygonOverride) {
    v.seatingPolygonOverride = null;
    if (typeof computeTerraceTestPoints === 'function') {
      v.terraceTestPoints = computeTerraceTestPoints(v, null);
    }
  }

  // Primary wall = first selected; fallback to index 0
  const primaryIdx = v.terraceWallIndices[0] ?? 0;
  v.wallSegment    = v.wallNormals[primaryIdx];
  v.facing         = v.terraceWallIndices.length > 0 ? Math.round(v.wallSegment.bearing) : v.facing;
  v.facingSource   = 'manual';

  saveFacingCache(v.id, v.facing, 'manual', v.terraceWallIndices, v.terraceDepth ?? 7,
    null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd, null);
  clearSpriteCache();
  sunWindowCache.clear();
  _setEditChanged();
  _updateEditToolButtons();
  dispatchToWorker(datePicker.value);
  draw();
  renderList();
}

const _TYPE_LABELS_NO = { street: 'Gate', rooftop: 'Tak', courtyard: 'Innergård', detached: 'Frittstående' };

function _syncTerraceTypeUI(type) {
  const labelEl = document.getElementById('edit-type-label');
  if (labelEl) labelEl.textContent = _TYPE_LABELS_NO[type] ?? 'Gate';
  // Mark active option in the custom listbox
  document.querySelectorAll('#edit-type-list li').forEach(li => {
    li.classList.toggle('active', li.dataset.value === type);
  });
}

/** Toggle the custom terrace-type listbox open/closed. */
function _toggleTypeDropdown(force) {
  const trigger = document.getElementById('edit-type-trigger');
  const list    = document.getElementById('edit-type-list');
  if (!trigger || !list) return;
  const willOpen = typeof force === 'boolean' ? force : list.hidden;
  list.hidden = !willOpen;
  trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

/** Wire the custom dropdown click handlers (idempotent — safe to call once). */
function _wireTypeDropdown() {
  const trigger = document.getElementById('edit-type-trigger');
  const list    = document.getElementById('edit-type-list');
  if (!trigger || !list || trigger.dataset.wired === '1') return;
  trigger.dataset.wired = '1';
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    _toggleTypeDropdown();
  });
  list.querySelectorAll('li[data-value]').forEach(li => {
    li.addEventListener('click', e => {
      e.stopPropagation();
      const v = li.dataset.value;
      if (v) setTerraceType(v);
      _toggleTypeDropdown(false);
    });
  });
  // Click-outside to close
  document.addEventListener('click', () => _toggleTypeDropdown(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') _toggleTypeDropdown(false);
  });
}

function setTerraceType(type) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;
  v.terraceType = type;
  _syncTerraceTypeUI(type);

  if (type === 'rooftop') {
    v.terraceTestPoints = v.buildingGeometry?.length
      ? (() => { const c = computeCentroid(v.buildingGeometry); return [{ lat: c.lat, lng: c.lon }]; })()
      : [{ lat: v.lat, lng: v.lng }];
  } else if (type === 'courtyard') {
    // Seed an inner polygon (~6m square) at the building centroid the first time
    // courtyard is selected. Subsequent sessions reuse the saved polygon.
    if (!v.courtyardPolygon && typeof seedCourtyardPolygon === 'function') {
      v.courtyardPolygon = seedCourtyardPolygon(v);
    }
    if (v.courtyardPolygon && typeof seatingPolygonTestPoints === 'function') {
      v.terraceTestPoints = seatingPolygonTestPoints(v.courtyardPolygon);
    } else {
      const c = v.buildingGeometry?.length ? computeCentroid(v.buildingGeometry) : null;
      v.terraceTestPoints = [{ lat: c?.lat ?? v.lat, lng: c?.lon ?? v.lng }];
    }
  } else if (type === 'detached') {
    if (!v.terraceDetachedLocation) v.terraceDetachedLocation = { lat: v.lat, lng: v.lng };
    if (!v.detachedPolygon && typeof seedDetachedPolygon === 'function') {
      v.detachedPolygon = seedDetachedPolygon(v);
    }
    if (v.detachedPolygon && typeof seatingPolygonTestPoints === 'function') {
      v.terraceTestPoints = seatingPolygonTestPoints(v.detachedPolygon);
    } else {
      v.terraceTestPoints = [{ ...v.terraceDetachedLocation }];
    }
  } else {
    // street
    v.terraceTestPoints = computeTerraceTestPoints(v, null);
  }

  _setEditChanged();
  _updateEditToolButtons();

  saveFacingCache(v.id, v.facing, v.facingSource,
    v.terraceWallIndices, v.terraceDepth, v.noiseScore, type, v.terraceDetachedLocation);
  sunWindowCache.clear();
  dispatchToWorker(datePicker.value);
  draw();
  renderList();
}

/** Called from render.js when user clicks/drags the detached pin. */
function setDetachedLocation(lat, lng) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v || v.terraceType !== 'detached') return;
  v.terraceDetachedLocation = { lat, lng };
  v.terraceTestPoints = [{ lat, lng }];
  saveFacingCache(v.id, v.facing, v.facingSource,
    v.terraceWallIndices, v.terraceDepth, v.noiseScore, 'detached', { lat, lng });
  sunWindowCache.clear();
  _setEditChanged();
  dispatchToWorker(datePicker.value);
  draw();
}

// ── Sidebar + filters ─────────────────────────────────────────────────────────
function isMobile() { return window.innerWidth < 640; }

function togglePanel() {
  const panel  = document.getElementById('panel');
  const btn    = document.getElementById('panel-toggle');
  const handle = document.getElementById('panel-handle');

  function redrawAfterTransition() {
    try { if (map?.resize) map.resize(); } catch (_) {}
    if (typeof window.markPinLayoutStale === 'function') window.markPinLayoutStale();
    resizeCanvas();
    draw();
  }

  if (isMobile()) {
    if (panel.classList.contains('mobile-expanded')) {
      // expanded → peek
      panel.classList.remove('mobile-expanded');
    } else if (!panel.classList.contains('mobile-hidden')) {
      // peek → expanded
      panel.classList.add('mobile-expanded');
    } else {
      // hidden → peek
      panel.classList.remove('mobile-hidden');
    }
    _syncFtsPosition();
    panelVisible = true;
    if (handle) handle.style.display = 'flex';
    // Redraw when transition completes, with fallback timeout
    const handleTransitionEnd = (e) => {
      if (e.propertyName === 'transform' || e.propertyName === 'height') {
        panel.removeEventListener('transitionend', handleTransitionEnd);
        clearTimeout(tid);
        redrawAfterTransition();
      }
    };
    panel.addEventListener('transitionend', handleTransitionEnd);
    const tid = setTimeout(redrawAfterTransition, 240);
    return;
  }

  panelVisible = !panelVisible;
  const revealBtn   = document.getElementById('panel-reveal-btn');
  const detailPanel = document.getElementById('detail-panel');
  const qcWrap      = document.getElementById('qc-wrap');
  if (panelVisible) {
    panel.style.transform     = '';
    panel.style.opacity       = '';
    panel.style.pointerEvents = '';
    if (btn) btn.textContent  = '‹';
    if (revealBtn) revealBtn.style.display = 'none';
    if (detailPanel) { detailPanel.style.left = ''; detailPanel.style.top = ''; }
    if (qcWrap) qcWrap.style.left = '';
  } else {
    panel.style.transform     = 'translateX(calc(-100% - 20px))';
    panel.style.opacity       = '0';
    panel.style.pointerEvents = 'none';
    if (btn) btn.textContent  = '›';
    if (revealBtn) revealBtn.style.display = 'flex';
    if (detailPanel) {
      detailPanel.style.left = '16px';
      detailPanel.style.top  = qcWrap
        ? (qcWrap.offsetTop + qcWrap.offsetHeight + 8) + 'px'
        : '70px';
    }
    if (qcWrap) qcWrap.style.left = '16px';
  }
  _syncFtsPosition();
  // Redraw when transition completes, with fallback timeout
  const handleTransitionEnd = (e) => {
    if (e.propertyName === 'transform' || e.propertyName === 'opacity') {
      panel.removeEventListener('transitionend', handleTransitionEnd);
      clearTimeout(tid);
      redrawAfterTransition();
    }
  };
  panel.addEventListener('transitionend', handleTransitionEnd);
  const tid = setTimeout(redrawAfterTransition, 240);
}

document.addEventListener('DOMContentLoaded', () => {
  if (isMobile()) {
    const h       = document.getElementById('panel-handle');
    const panelEl = document.getElementById('panel');
    if (h) h.style.display = 'flex';

    // ── Panel drag-to-resize (bottom-sheet) ─────────────────────────────────
    // Three states: peek → expanded → fullscreen
    //
    // Velocity-based (swipe): steps one state in the swipe direction.
    //   Swipe up:   peek→expanded, expanded→fullscreen
    //   Swipe down: fullscreen→expanded, expanded→peek
    //
    // Position-based (slow drag): snaps to nearest state by release Y.
    //
    // Tap (<10px movement): toggles peek↔expanded.
    //
    // Venue list at top + pull-down: drags panel like the handle.
    // Venue list at top + fast swipe (no drag mode started): same state machine.
    if (h && panelEl) {
      let _dragY0 = 0, _dragT0 = 0, _dragActive = false, _dragFromList = false;
      let _dragStartState = 'peek', _dragStartTime = 0;

      function _panelTranslateNow() {
        return new DOMMatrix(getComputedStyle(panelEl).transform).m42;
      }

      function _currentState() {
        if (panelEl.classList.contains('mobile-fullscreen')) return 'fullscreen';
        if (panelEl.classList.contains('mobile-expanded'))   return 'expanded';
        return 'peek';
      }

      function _applyState(state) {
        if (state === 'fullscreen') {
          panelEl.classList.add('mobile-fullscreen', 'mobile-expanded');
          panelEl.classList.remove('mobile-hidden');
        } else if (state === 'expanded') {
          panelEl.classList.add('mobile-expanded');
          panelEl.classList.remove('mobile-fullscreen', 'mobile-hidden');
        } else if (state === 'hidden') {
          panelEl.classList.add('mobile-hidden');
          panelEl.classList.remove('mobile-expanded', 'mobile-fullscreen');
        } else {
          // Returning to peek — venue-peek goes from display:none to visible,
          // so recalc peek height after layout settles
          panelEl.classList.remove('mobile-expanded', 'mobile-fullscreen', 'mobile-hidden');
          requestAnimationFrame(_updatePeekHeight);
        }
        // Persist the last snap point so it restores next session. 'hidden'
        // AND 'fullscreen' are transient take-over states — don't persist them
        // (we never want to LAND on a map-covering panel at load), so the saved
        // value stays at the last peek/expanded.
        if (state === 'peek' || state === 'expanded') {
          try { localStorage.setItem('solsteder.sheetSnap', state); } catch {}
        }
        _syncFtsPosition();
        // A panel slide is pure CSS — Mapbox fires no camera event, so the pin
        // canvas isn't refreshed and the area a collapse reveals keeps its
        // pre-slide render until the next map move. Force a plain draw() on
        // settle. (NOT map.resize() — resize re-applies the camera padding and
        // visibly re-centers; a draw() is enough now that pin culling uses the
        // full-canvas bounds in render-pins, not the padding-shrunk getBounds.)
        let _redrawDone = false;
        const _redrawOnSettle = (e) => {
          if (e && (e.target !== panelEl || (e.propertyName !== 'bottom' && e.propertyName !== 'height'))) return;
          if (_redrawDone) return;
          _redrawDone = true;
          panelEl.removeEventListener('transitionend', _redrawOnSettle);
          if (typeof draw === 'function') draw();
        };
        panelEl.addEventListener('transitionend', _redrawOnSettle);
        setTimeout(_redrawOnSettle, 420); // fallback if no transition fires
      }

      // Saved sheet-snap is now applied UPFRONT in _introRevealUI (which
      // reads localStorage and lands the panel directly in the saved
      // state), so there's no post-intro setTimeout that yanks the panel
      // from expanded down to peek anymore — that yo-yo was the bug
      // the user reported.

      let _dragInitH = 0; // panel height at drag start (px)
      let _dragRafId = null;

      // Upper bound for the FTS during a drag — the slider should never go
      // higher than its fullscreen rest (just below the chip row). Below
      // that ceiling, FTS follows the panel top + FTS_GAP normally.
      function _ftsCeilingBottom() {
        // Mirror _ftsHostBottom's fullscreen calc:
        //   100svh - safe-area - 34 (handle) - 50 (chip row) - 8 (gap) - 34 (FTS)
        // Approximate safe-area as the env value applied to the body. We
        // read it via a CSS var or fall back to 0.
        const safeTop = parseInt(
          getComputedStyle(document.body).getPropertyValue('--safe-area-top')
        ) || 0;
        return window.innerHeight - safeTop - 34 - 50 - 8 - 34;
      }

      // Panel top + viewport height + peek top + expanded top — all captured
      // at drag start so _trackDrag can derive the current panel top from
      // arithmetic instead of getBoundingClientRect() per rAF (which forced
      // a synchronous layout per touchmove frame).
      let _dragPanelTopAtStart = 0;
      let _dragViewportH = 0;
      let _dragPeekTop = 0;
      let _dragExpandedTop = 0;
      function _beginDrag(y) {
        if (_dragActive) return; // already initiated by a child element
        _dragY0         = y;
        _dragT0         = _panelTranslateNow();
        _dragActive     = true;
        _dragStartState = _currentState();
        _dragStartTime  = Date.now();
        _dragInitH      = panelEl.offsetHeight;
        // One-time geometry capture — the panel's top edge, viewport height,
        // and snap-state thresholds don't change mid-drag. Cache them.
        _dragPanelTopAtStart = panelEl.getBoundingClientRect().top;
        _dragViewportH       = window.innerHeight;
        _dragPeekTop         = _dragViewportH - (parseInt(panelEl.style.getPropertyValue('--peek-h')) || 160);
        _dragExpandedTop     = _dragViewportH * 0.45;
        panelEl.style.transition = 'none';
        panelEl.classList.add('panel-dragging');
      }

      let _ftsEl = null; // cache FTS element ref to avoid DOM lookup per frame
      let _locateEl = null; // cache locate button ref
      let _zoomJogEl = null; // cache zoom jog ref
      let _brandEl = null; // cache floating-brand ref (tracks the sheet, left side)
      function _trackDrag(y) {
        if (!_dragActive) return;
        if (_dragRafId) cancelAnimationFrame(_dragRafId);
        _dragRafId = requestAnimationFrame(() => {
          const dy = y - _dragY0;
          const newY = Math.min(_dragInitH - 80, _dragT0 + dy);
          // When dragging above the expanded position (translateY < 0), grow the
          // panel height instead of translating upward — this avoids a gap at the
          // bottom and keeps content un-distorted (no scaleY).
          if (newY < 0) {
            panelEl.style.transform = 'translateY(0)';
            panelEl.style.height = (_dragInitH + Math.abs(newY)) + 'px';
          } else {
            panelEl.style.transform = `translateY(${newY}px)`;
            panelEl.style.height = '';
          }

          // FTS is now a child of #panel — it rides the panel transform
          // automatically, no separate bottom-tracking needed. (Setting
          // .style.bottom on a position:relative element shifts it out
          // of normal flow, which was the disappearing-FTS bug.)
          // Track locate button + zoom jog with panel during drag.
          // Locate-me now sits at the FTS row (same baseline as the slider),
          // not above it — so its bottom matches the FTS bottom exactly.
          if (!_locateEl) _locateEl = document.getElementById('locate-btn');
          if (!_zoomJogEl) _zoomJogEl = document.getElementById('zoom-jog');
          // Derive panel top arithmetically — both branches of the
          // transform/height logic above collapse to the same expression:
          //   newY >= 0: top delta = transform delta = newY - _dragT0
          //   newY <  0: transform=0 (delta = -_dragT0) plus height grew by
          //              |newY| which moves the bottom-anchored panel's top
          //              up by |newY| (= -|newY| = newY). Sum = newY - _dragT0.
          // Avoids the per-frame getBoundingClientRect that previously
          // forced a synchronous layout per touchmove rAF.
          const panelTopD = _dragPanelTopAtStart + (newY - _dragT0);
          const locateBottom = _dragViewportH - panelTopD + FTS_GAP;
          const progress = Math.max(0, Math.min(1, (_dragPeekTop - panelTopD) / (_dragPeekTop - _dragExpandedTop)));
          if (_locateEl) {
            _locateEl.style.transition = 'none';
            _locateEl.style.bottom = locateBottom + 'px';
            _locateEl.style.opacity = '';
          }
          if (_zoomJogEl) {
            _zoomJogEl.style.transition = 'none';
            _zoomJogEl.style.bottom = (locateBottom + 34 + 10) + 'px'; // above locate btn
            _zoomJogEl.style.opacity = String(1 - progress);
          }
          // Brand label rides the same baseline as locate-me, on the LEFT, so it
          // tracks the sheet top during the drag instead of lagging at its CSS bottom.
          if (!_brandEl) _brandEl = document.getElementById('floating-brand');
          if (_brandEl) {
            _brandEl.style.transition = 'none';
            _brandEl.style.bottom = locateBottom + 'px';
          }

          _dragRafId = null;
        });
      }

      function _commitDrag(y) {
        if (!_dragActive) return;
        if (_dragRafId) cancelAnimationFrame(_dragRafId);
        _dragRafId = null;
        _dragActive   = false;
        // Restore venue-list scrolling — drag handler may have frozen it
        // (overflow-y: hidden) while the panel was being dragged from a
        // list-spillover gesture. Always restore here so any exit path
        // ends with a scrollable list.
        if (_dragFromList) {
          const venueListEl = document.getElementById('venue-list');
          if (venueListEl) venueListEl.style.overflowY = '';
        }
        _dragFromList = false;

        const dy       = y - _dragY0;
        const dt       = Math.max(1, Date.now() - _dragStartTime);
        const velocity = dy / dt; // px/ms, positive = downward

        const SWIPE_V = 0.2, SAFE_DY = 40;
        let target;
        if      (velocity < -SWIPE_V)            target = _dragStartState === 'peek' ? 'expanded' : 'fullscreen';
        else if (velocity >  SWIPE_V)            target = _dragStartState === 'fullscreen' ? 'expanded' : 'peek'; // peek is the floor — no hidden via swipe
        else if (Math.abs(dy) <= SAFE_DY)        target = _dragStartState; // safe zone → snap back
        else if (dy < 0)                         target = _dragStartState === 'peek' ? 'expanded' : 'fullscreen';
        else                                     target = _dragStartState === 'fullscreen' ? 'expanded' : 'peek'; // peek is the floor

        // Restore pill + locate button + zoom jog transitions after drag
        if (!_ftsEl) _ftsEl = document.getElementById('fts');
        if (_ftsEl) { _ftsEl.style.transition = ''; _ftsEl.style.bottom = ''; }
        if (!_locateEl) _locateEl = document.getElementById('locate-btn');
        if (_locateEl) { _locateEl.style.transition = ''; _locateEl.style.bottom = ''; _locateEl.style.opacity = ''; }
        if (!_zoomJogEl) _zoomJogEl = document.getElementById('zoom-jog');
        if (_zoomJogEl) { _zoomJogEl.style.transition = ''; _zoomJogEl.style.bottom = ''; _zoomJogEl.style.opacity = ''; }
        if (!_brandEl) _brandEl = document.getElementById('floating-brand');
        if (_brandEl) { _brandEl.style.transition = ''; _brandEl.style.bottom = ''; }

        // FLIP-style commit for the new bottom-based positioning. The panel
        // now uses `bottom` (layout, transitionable, backdrop-filter-safe)
        // instead of `transform` for its resting states; only the drag
        // itself still uses `transform` for per-frame visual feedback. To
        // commit without snapping, snapshot the panel's current visual
        // bottom, apply the target state, set inline bottom + clear
        // transform to keep the panel visually pinned to the drag end-
        // point, then clear inline so the CSS new-state bottom transitions
        // from there.
        const beforeBCR = panelEl.getBoundingClientRect();
        const viewportH = window.innerHeight;
        const currentVisualBottom = viewportH - (beforeBCR.top + panelEl.offsetHeight);
        // Pin the live VISUAL height too, so going to fullscreen the height
        // ANIMATES (50svh → app-h) rather than the top edge snapping. Safe now
        // that .is-sliding keeps the frosted glass (no transparent/flash).
        const currentVisualHeight = beforeBCR.height;
        _applyState(target);
        panelEl.classList.remove('panel-dragging');
        // Pin the current visual position via inline bottom + height (override
        // the new class's values). Clear inline transform without snapping.
        panelEl.style.transition = 'none';
        panelEl.style.bottom    = currentVisualBottom + 'px';
        panelEl.style.height    = currentVisualHeight + 'px';
        panelEl.style.transform = '';
        // Force layout so the pinned position is the start of the transition.
        void panelEl.offsetHeight;
        // Velocity-aware snap — continue the gesture instead of a fixed 340ms
        // delay (the recurring "release feels laggy" complaint). A hard flick
        // lands in ~170ms; a slow release settles in ~320ms. The emphasized
        // curve front-loads so the panel leaps off the release point at once.
        // Cleared after the snap so future programmatic state changes fall back
        // to the CSS default transition.
        const _snapDur = Math.round(Math.max(170, Math.min(320, 320 - Math.abs(velocity) * 80)));
        panelEl.style.transition = `bottom ${_snapDur}ms var(--ease-emphasized), height ${_snapDur}ms var(--ease-emphasized)`;
        panelEl.style.bottom     = '';
        panelEl.style.height     = '';
        const _clearSnap = (e) => {
          // transitionend bubbles from children (cards, etc.) — only act on the
          // panel's own bottom/height transition, or the timeout fallback (no e).
          if (e && (e.target !== panelEl || (e.propertyName !== 'bottom' && e.propertyName !== 'height'))) return;
          panelEl.style.transition = '';
          panelEl.removeEventListener('transitionend', _clearSnap);
        };
        panelEl.addEventListener('transitionend', _clearSnap);
        setTimeout(_clearSnap, _snapDur + 80);
      }

      // Wire a swipe target: touchstart/move/end → panel drag state machine
      // opts.excludeInteractive: skip drag when touch starts on a button/a/input/canvas
      // opts.tapToggle: if false, taps on this element don't toggle panel state (default true)
      // opts.deferred: don't begin drag immediately — wait until movement
      //   exceeds DEFERRED_THRESHOLD. Lets interactive children receive their
      //   own click events on tap while still allowing drag from anywhere.
      function _wireSwipeTarget(el, opts = {}) {
        const _INTERACTIVE = 'button, a, input, select, textarea, canvas';
        const DEFERRED_THRESHOLD = 8;
        let _localStartY = 0;
        let _localPending = false;  // armed but not yet drag-active

        el.addEventListener('touchstart', e => {
          if (opts.peekOnly && _currentState() !== 'peek') return;
          if (opts.excludeInteractive && e.target.closest(_INTERACTIVE)) return;
          if (opts.excludeSelector && e.target.closest(opts.excludeSelector)) return;
          if (opts.deferred) {
            _localStartY  = e.touches[0].clientY;
            _localPending = true;
          } else {
            _beginDrag(e.touches[0].clientY);
          }
        }, { passive: true });

        el.addEventListener('touchmove', e => {
          // Deferred: only begin drag once movement passes threshold.
          if (_localPending) {
            const dy = e.touches[0].clientY - _localStartY;
            if (Math.abs(dy) < DEFERRED_THRESHOLD) return;
            _localPending = false;
            _beginDrag(_localStartY);
          }
          if (!_dragActive) return;
          e.preventDefault();
          _trackDrag(e.touches[0].clientY);
        }, { passive: false });

        el.addEventListener('touchend', e => {
          _localPending = false;
          if (!_dragActive) return;
          const totalDy = e.changedTouches[0].clientY - _dragY0;
          if (Math.abs(totalDy) < 10) {
            // Tap: toggle peek ↔ expanded (unless caller opted out)
            _dragActive = false;
            panelEl.classList.remove('panel-dragging');
            panelEl.style.transition = '';
            panelEl.style.transform  = '';
            panelEl.style.height     = '';
            if (!_ftsEl) _ftsEl = document.getElementById('fts');
            if (_ftsEl) { _ftsEl.style.transition = ''; _ftsEl.style.bottom = ''; }
            if (opts.tapToggle !== false) {
              const s = _currentState();
              _applyState(s === 'expanded' || s === 'fullscreen' ? 'peek' : 'expanded');
            }
          } else {
            _commitDrag(e.changedTouches[0].clientY);
          }
        }, { passive: true });

        el.addEventListener('touchcancel', () => { _localPending = false; }, { passive: true });
      }

      // Map panel state to a single key. Used to detect when a class
      // mutation actually changes the panel's MODE (vs e.g. .panel-dragging
      // toggling, which mutates the class attribute but doesn't represent a
      // new state). Skipping non-mode mutations prevents spurious repaints.
      function _panelModeKey(el) {
        if (el.classList.contains('mobile-fullscreen')) return 'fullscreen';
        if (el.classList.contains('mobile-expanded'))   return 'expanded';
        if (el.classList.contains('mobile-hidden'))     return 'hidden';
        return 'peek';
      }

      // After any panel transform/height transition (drag, tap, programmatic
      // _applyState), repaint the pin canvas. The CSS transition moves the
      // bottom sheet but doesn't trigger any Mapbox event — without this
      // listener the pin canvas keeps its previous frame, which on hard refresh
      // can leave gaps in the area the sheet just uncovered, especially for
      // friend pins that were force-pilled in the post-load redraw.
      //
      // Single-fire guard: transitionend AND the MutationObserver fallback
      // both schedule a repaint. We arm the guard when a state change starts
      // and let whichever signal arrives first do the repaint; subsequent
      // signals in the same transition are no-ops. v1 fired BOTH which
      // doubled the map.resize() + draw() cost per panel swipe.
      let _panelRepaintArmed = false;
      let _panelRepaintTid = null;
      let _lastViewportH = window.innerHeight;
      function _repaintPinsAfterPanel() {
        if (!_panelRepaintArmed) return;
        _panelRepaintArmed = false;
        if (_panelRepaintTid) { clearTimeout(_panelRepaintTid); _panelRepaintTid = null; }
        // Always resize. The map ELEMENT doesn't change size when the panel
        // slides over it (Mapbox is layered behind a position:fixed panel),
        // but map.resize() is load-bearing for a second reason: it forces
        // Mapbox to recompute its projection + getBounds(). The pin draw
        // loop culls venues outside getBounds() — and on iOS the GL viewport
        // goes stale when the layout viewport shifts (address bar, safe-area,
        // the --app-h recalc the panel drives), leaving getBounds() shorter
        // than the real screen. Without a resize, expanded → peek leaves the
        // newly-revealed lower half culled (blank). The arm/disarm guard
        // above already limits this to one resize per panel mode change, so
        // gating it on an innerHeight delta (the old approach) saved nothing
        // and broke correctness.
        try { if (typeof map !== 'undefined' && map?.resize) map.resize(); } catch (_) {}
        _lastViewportH = window.innerHeight;
        if (typeof window.markPinLayoutStale === 'function') window.markPinLayoutStale();
        if (typeof resizeCanvas === 'function') resizeCanvas();
        if (typeof draw === 'function') draw();
        // Clear the transition flag BEFORE the final FTS redraw so the
        // ResizeObserver gate releases and the canvas paints its final state.
        document.body.classList.remove('panel-transitioning');
        if (typeof drawFtsCanvas === 'function') drawFtsCanvas();
      }
      panelEl.addEventListener('transitionend', (e) => {
        if (e.target !== panelEl) return;
        if (e.propertyName !== 'transform' && e.propertyName !== 'height') return;
        _repaintPinsAfterPanel();
      });
      // MutationObserver fallback — only the four mode classes matter. The
      // .panel-dragging toggle fires class mutations at drag start AND end
      // but doesn't represent a state change, so we ignore it. Tracking the
      // previous mode lets us skip mutations that don't actually move
      // between peek/expanded/fullscreen/hidden.
      let _prevPanelMode = _panelModeKey(panelEl);
      const _panelClassObs = new MutationObserver(() => {
        const cur = _panelModeKey(panelEl);
        if (cur === _prevPanelMode) return;
        _prevPanelMode = cur;
        _panelRepaintArmed = true;
        if (_panelRepaintTid) clearTimeout(_panelRepaintTid);
        _panelRepaintTid = setTimeout(_repaintPinsAfterPanel, 320);
        // Mark transition for ResizeObserver-driven FTS redraws to skip.
        document.body.classList.add('panel-transitioning');
      });
      _panelClassObs.observe(panelEl, { attributes: true, attributeFilter: ['class'] });

      // Wire drag targets: handle + venue-peek + panel-header + chip row + sun-section bar
      // The chip row uses `deferred` mode so a tap fires the chip's onclick
      // while a drag from the same surface still drives the panel.
      _wireSwipeTarget(h);
      const listSunHdr   = document.getElementById('list-sun-header');
      const sunSectionBar = document.getElementById('sun-section-bar');
      const venuePeek    = document.getElementById('venue-peek');
      const panelHeader  = document.getElementById('panel-header');
      const ftsEl        = document.getElementById('fts');
      if (listSunHdr) _wireSwipeTarget(listSunHdr, { deferred: true, tapToggle: false });
      if (sunSectionBar) _wireSwipeTarget(sunSectionBar);
      if (venuePeek)  _wireSwipeTarget(venuePeek);
      if (panelHeader) _wireSwipeTarget(panelHeader);
      // FTS becomes a panel-drag surface EXCEPT the thumb itself, which
      // retains horizontal scrub. tapToggle:false because tapping the
      // bar shouldn't toggle peek↔expanded — keep it neutral.
      if (ftsEl) _wireSwipeTarget(ftsEl, { excludeSelector: '#fts-thumb', tapToggle: false });

      // Catch-all: anywhere above the scrollable list should drive panel
      // drag, in any panel state. excludeSelector keeps the venue-list
      // scrollable and lets the FTS thumb own its horizontal scrub.
      // excludeInteractive lets buttons (sort, filters, future actions)
      // receive their own taps. tapToggle off — tapping random empty
      // panel space shouldn't toggle peek↔expanded.
      _wireSwipeTarget(panelEl, {
        excludeInteractive: true,
        excludeSelector: '#venue-list, #fts-thumb',
        tapToggle: false,
      });


      // Expose panel state helpers for use by toggleQcPanel / _closeQcPanel
      window._applyMobilePanelState  = _applyState;
      window._currentMobilePanelState = _currentState;

      // ── Prevent iOS browser pinch-to-zoom (but not Mapbox's) ──
      document.addEventListener('gesturestart', e => {
        if (!document.getElementById('map-container')?.contains(e.target)) e.preventDefault();
      }, { passive: false });
      document.addEventListener('gesturechange', e => {
        if (!document.getElementById('map-container')?.contains(e.target)) e.preventDefault();
      }, { passive: false });

      // ── Venue list: seamless scroll → panel drag ──────────────────────────────
      // Lets the user scroll the list normally. Two spillover gestures hand
      // control over to the panel-drag state machine without breaking scroll:
      //   • At scrollTop=0 + pull-DOWN past 8px: collapses the panel.
      //   • Finger crosses above the list rect (into the chip row) at any
      //     scrollTop: panel-drag takes over so a long upward swipe out of
      //     the list grows the panel instead of stranding mid-scroll.
      // Pure upward scroll inside the list is left alone so the browser's
      // native scrolling works.
      const venueList = document.getElementById('venue-list');
      if (venueList) {
        const SPILL_THRESHOLD = 8;
        let _listStartY = 0;
        let _listWasScrolled = false;
        venueList.addEventListener('touchstart', e => {
          _listStartY = e.touches[0].clientY;
          _listWasScrolled = venueList.scrollTop > 0;
        }, { passive: true });

        // Header drop-shadow on scroll — fades in once the list scrolls under
        // the sticky header (replaces the old top fade mask).
        venueList.addEventListener('scroll', () => {
          const panel = document.getElementById('panel');
          if (panel) panel.classList.toggle('is-scrolled', venueList.scrollTop > 0);
        }, { passive: true });

        venueList.addEventListener('touchmove', e => {
          const cy = e.touches[0].clientY;
          if (venueList.scrollTop > 0) _listWasScrolled = true;
          if (!_dragActive) {
            const listRect = venueList.getBoundingClientRect();
            const fingerAboveList = cy < listRect.top - 4;
            if (venueList.scrollTop <= 0) {
              const dy = cy - _listStartY;
              if (dy > SPILL_THRESHOLD) {
                // At top, pulling down → collapse one state
                e.preventDefault();
                _dragFromList = true;
                _beginDrag(cy);
              } else if (dy < -SPILL_THRESHOLD && _listWasScrolled) {
                // Scrolled to top mid-gesture, still moving up → grow panel
                e.preventDefault();
                _dragFromList = true;
                _beginDrag(cy);
              }
            } else if (fingerAboveList) {
              // Finger has moved out of the list band into the chips above —
              // hand control to the panel drag regardless of scrollTop.
              // Freeze the list (overflow-y: hidden) so any in-flight native
              // scroll / iOS momentum stops immediately. Otherwise the list
              // keeps scrolling under the dragging panel and the user sees
              // visible jitter as the two motions fight. Unfrozen in
              // _commitDrag.
              e.preventDefault();
              _dragFromList = true;
              venueList.style.overflowY = 'hidden';
              _beginDrag(cy);
            }
          }
          if (_dragActive && _dragFromList) {
            e.preventDefault();
            _trackDrag(cy);
          }
        }, { passive: false });

        venueList.addEventListener('touchend', e => {
          if (_dragActive && _dragFromList) _commitDrag(e.changedTouches[0].clientY);
        }, { passive: true });
      }
    }

    // ── Map canvas touch → collapse panel to peek ──
    // Use capture on the map container so we catch touches before Mapbox
    document.getElementById('map-container')?.addEventListener('touchstart', () => {
      if (!panelEl || panelEl.classList.contains('mobile-hidden')) return;
      const wasOpen = panelEl.classList.contains('mobile-expanded')
                   || panelEl.classList.contains('mobile-fullscreen');
      panelEl.classList.remove('mobile-expanded', 'mobile-fullscreen');
      _syncFtsPosition();
      if (wasOpen) {
        // Pin layout was computed against the previous (smaller) visible region;
        // mark stale and redraw once the panel settles so newly-revealed venues
        // get proper pill placement instead of defaulting to dots.
        window.markPinLayoutStale?.();
        const onEnd = (e) => {
          if (e.propertyName !== 'transform') return;
          panelEl.removeEventListener('transitionend', onEnd);
          if (typeof draw === 'function') draw();
        };
        panelEl.addEventListener('transitionend', onEnd);
      }
    }, { passive: true, capture: true });

    // ── Detail panel: live-follow drag from handle OR from dp-scroll scrolling into handle ──
    // States: 'normal' (65svh) ↔ 'fullscreen' (100svh), or dismiss.
    // Safe zone: |dy| < SAFE_DY and slow → snap back. Outside: commit to next state.
    const dpHandle = document.getElementById('dp-handle');
    const dpEl     = document.getElementById('detail-panel');
    if (dpHandle && dpEl) {
      let _dpY0 = 0, _dpDragging = false, _dpStartState = 'normal', _dpStartTime = 0, _dpInitH = 0, _dpFromScroll = false;
      let _dpLastFrameY = 0, _dpRafId = null;

      function _dpCurrentState() {
        return dpEl.classList.contains('dp-fullscreen') ? 'fullscreen' : 'normal';
      }
      function _beginDpDrag(y, fromScroll = false) {
        _dpY0         = y;
        _dpDragging   = true;
        _dpFromScroll = fromScroll;
        _dpStartState = _dpCurrentState();
        _dpStartTime  = Date.now();
        _dpInitH      = dpEl.offsetHeight;
        _dpLastFrameY = y;
        dpEl.style.transition = 'none';
      }
      function _trackDpDrag(y) {
        _dpLastFrameY = y;
        if (_dpRafId) cancelAnimationFrame(_dpRafId);
        _dpRafId = requestAnimationFrame(() => {
          const dy = _dpLastFrameY - _dpY0;
          // Detail panel: downward drags dismiss; upward drags get a soft
          // resistance (rubber-band) since the panel no longer has a
          // fullscreen state to grow into.
          const clampedDy = dy < 0 ? Math.max(dy / 4, -40) : dy;
          dpEl.style.transform = `translateY(${clampedDy}px)`;
          dpEl.style.height = '';

          // Anchor the FTS to the DP's top edge so it follows the drag.
          if (USE_FLOATING_TIME_SLIDER) {
            const ftsEl = document.getElementById('fts');
            if (ftsEl) {
              const dpTop = dpEl.getBoundingClientRect().top;
              const viewH = window.innerHeight;
              ftsEl.style.transition = 'none';
              ftsEl.style.bottom = (viewH - dpTop + FTS_GAP) + 'px';
            }
          }
          _dpRafId = null;
        });
      }
      function _commitDpDrag(y) {
        if (_dpRafId) cancelAnimationFrame(_dpRafId);
        _dpRafId = null;
        dpEl.style.transition = '';
        dpEl.style.transform  = '';
        dpEl.style.height     = '';
        _dpDragging = false;

        // Release FTS back to its CSS-driven anchor — _syncFtsPosition will
        // re-publish --fts-bottom for whatever state the DP commits to.
        if (USE_FLOATING_TIME_SLIDER) {
          const ftsEl = document.getElementById('fts');
          if (ftsEl) { ftsEl.style.transition = ''; ftsEl.style.bottom = ''; }
        }

        const dy       = y - _dpY0;
        const dt       = Math.max(1, Date.now() - _dpStartTime);
        const velocity = dy / dt;
        const SWIPE_V  = 0.2, SAFE_DY = 40;

        if (Math.abs(dy) <= SAFE_DY && Math.abs(velocity) < SWIPE_V) return; // safe zone

        if (velocity < -SWIPE_V || dy < -SAFE_DY) {
          // Detail panel no longer has a fullscreen state — upward swipe is a no-op,
          // letting the panel snap back to its normal height. (User decision: the
          // DP doesn't need a fullscreen mode; dragging up was overlapping the FTS.)
        } else if (velocity > SWIPE_V || dy > SAFE_DY) {
          closeDetailPanel(false);
        }
      }

      // Handle drag (starts immediately on touch)
      dpHandle.addEventListener('touchstart', e => _beginDpDrag(e.touches[0].clientY), { passive: true });
      dpHandle.addEventListener('touchmove', e => {
        if (!_dpDragging) return;
        e.preventDefault();
        _trackDpDrag(e.touches[0].clientY);
      }, { passive: false });
      dpHandle.addEventListener('touchend', e => {
        if (!_dpDragging) return;
        _commitDpDrag(e.changedTouches[0].clientY);
      }, { passive: true });

      // dp-content: drag-to-dismiss when touching non-interactive areas.
      // When dp-scroll is at the top and the finger moves down, start panel drag.
      const dpContent = document.getElementById('dp-content');
      if (dpContent) {
        const _DP_INTERACTIVE = 'button, a, input, select, textarea, canvas, [role="button"], #fts, #fts-track, .dp-photos';
        let _dpContentStartY = 0;
        dpContent.addEventListener('touchstart', e => {
          if (e.target.closest(_DP_INTERACTIVE)) return;
          _dpContentStartY = e.touches[0].clientY;
        }, { passive: true });

        dpContent.addEventListener('touchmove', e => {
          if (_dpDragging) { e.preventDefault(); _trackDpDrag(e.touches[0].clientY); return; }
          const dpScroll = document.getElementById('dp-scroll');
          const atTop = !dpScroll || dpScroll.scrollTop <= 0;
          const cy = e.touches[0].clientY;
          if (atTop && cy > _dpContentStartY + 8 && !e.target.closest(_DP_INTERACTIVE) && !_ftsDragging) {
            e.preventDefault();
            _beginDpDrag(cy, true);
          }
        }, { passive: false });

        dpContent.addEventListener('touchend', e => {
          if (_dpDragging) _commitDpDrag(e.changedTouches[0].clientY);
        }, { passive: true });
      }
    }
  }

  // Position preset buttons after layout settles, then again on resize
  setTimeout(positionPresetButtons, 80);
  new ResizeObserver(() => positionPresetButtons()).observe(document.body);

  // Push detail panel below qc-wrap only when panel is hidden (same left column).
  // When panel is visible, detail-panel is in the right column and unaffected.
  const _qcWrapEl      = document.getElementById('qc-wrap');
  const _detailPanelEl = document.getElementById('detail-panel');
  if (_qcWrapEl && _detailPanelEl) {
    new ResizeObserver(() => {
      if (!isMobile()) {
        if (panelVisible) {
          _detailPanelEl.style.top = '';   // let CSS handle it (120px)
        } else {
          _detailPanelEl.style.top = (_qcWrapEl.offsetTop + _qcWrapEl.offsetHeight + 8) + 'px';
        }
      }
    }).observe(_qcWrapEl);
  }

  // Sync qc panel height on resize
  window.addEventListener('resize', () => {
    _syncQcPanelHeight();
    _updatePeekHeight();
    _syncFtsPosition();
    if (typeof drawAllCardTimelines === 'function') drawAllCardTimelines();
  });
  setTimeout(() => { _syncQcPanelHeight(); _updatePeekHeight(); }, 600);

  // Close sort panel when clicking outside it. Two sort-button instances
  // live in the DOM (#sort-toggle-btn in the sun-section-bar header and
  // #panel-actions-sort in the filter-pill row); the click only counts as
  // "inside" if it lands on EITHER, otherwise switching between them would
  // close the panel before _openSortPanelNow even ran.
  document.addEventListener('click', e => {
    const btnA  = document.getElementById('sort-toggle-btn');
    const btnB  = document.getElementById('panel-actions-sort');
    const panel = document.getElementById('sort-panel');
    if (panel?.classList.contains('open')
        && !btnA?.contains(e.target)
        && !btnB?.contains(e.target)
        && !panel?.contains(e.target)) {
      _closeSortPanel();
    }
    // Filter dropdown: same outside-click dismissal.
    const fBtn   = document.getElementById('panel-actions-filter');
    const fPanel = document.getElementById('filter-panel');
    if (fPanel?.classList.contains('open')
        && !fBtn?.contains(e.target)
        && !fPanel?.contains(e.target)) {
      _closeFilterPanel();
    }
    // Close date calendar when clicking outside it
    const cal       = document.getElementById('date-calendar');
    const dateArea  = document.getElementById('floating-date');
    const displayBtn = document.getElementById('date-display-btn');
    if (cal?.classList.contains('open') && !dateArea?.contains(e.target)) {
      cal.classList.remove('open');
      displayBtn?.classList.remove('open');
    }
    // Close calendar when clicking outside the float AND outside any
    // opener button (header chip OR fts date button). Including
    // fts-date-btn here is critical — without it, tapping that button
    // bubbles up to this handler RIGHT AFTER the inline onclick opened
    // the calendar, immediately closing it (and reverting the detail-
    // panel hide that toggleQcPanel just performed).
    const qcPanel   = document.getElementById('qc-panel');
    const calFloat  = document.getElementById('ptb-cal-float');
    const dateChip  = document.getElementById('header-date-chip');
    const ftsBtn    = document.getElementById('fts-date-btn');
    const tsBtn     = document.getElementById('ts-date-btn');
    if (qcPanel?.classList.contains('open')
        && !calFloat?.contains(e.target)
        && !dateChip?.contains(e.target)
        && !ftsBtn?.contains(e.target)
        && !tsBtn?.contains(e.target)) {
      _closeQcPanel();
    }
  });

  // Escape closes the calendar picker
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _qcActiveSection === 'date') _closeQcPanel();
  });

  // Request location for distance sorting, intro centering, and live dot on map
  if (navigator.geolocation) {
    const _onGeoPos = pos => {
      const wasNull   = !userLocation;
      userLocation    = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (wasNull) {
        // Only follow GPS for intro center when the user is near the venue
        // cluster — otherwise the map opens on (e.g.) Copenhagen and the
        // viewport filter hides every Oslo venue. Keep the Oslo fallback.
        if (!_isFarFromCluster()) {
          _introCenter = [pos.coords.longitude, pos.coords.latitude];
        } else if (VENUE_CLUSTER.radiusKm) {
          _introCenter = [VENUE_CLUSTER.center.lng, VENUE_CLUSTER.center.lat];
        }
        _introGeoReady = true;
        _introCheckReady();
        _applyAutoDefaultSort();
        renderList();
      }
      _updateLocationDot();
    };
    const _onGeoErr = () => {
      if (!userLocation) {
        if (VENUE_CLUSTER.radiusKm) _introCenter = [VENUE_CLUSTER.center.lng, VENUE_CLUSTER.center.lat];
        _introGeoReady = true;
        _introCheckReady();
        _applyAutoDefaultSort();
        renderList();
      }
    };
    // watchPosition keeps the dot fresh as the user moves
    navigator.geolocation.watchPosition(_onGeoPos, _onGeoErr,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    // Fallback: if geolocation never settles, proceed after 5 seconds
    setTimeout(() => {
      if (!_introGeoReady) {
        if (VENUE_CLUSTER.radiusKm) _introCenter = [VENUE_CLUSTER.center.lng, VENUE_CLUSTER.center.lat];
        _introGeoReady = true;
        _introCheckReady();
        _applyAutoDefaultSort();
        renderList();
      }
    }, 5000);
  } else {
    if (VENUE_CLUSTER.radiusKm) _introCenter = [VENUE_CLUSTER.center.lng, VENUE_CLUSTER.center.lat];
    _introGeoReady = true;
    _introCheckReady();
    _applyAutoDefaultSort();
  }
});

// toggleMapView removed — viewport filter is always active

// Auto-fit the map to a set of venues. Called after the user expands the
// list (pulls up at the end / clicks "Vis flere"), so the visible bounding
// box widens to include the freshly-added venues. The expanding rectangle
// is the user-visible feedback that the search has gone wider — no inline
// "searching wider" text needed.
//
// Suppressed when a venue is selected so we don't fight the detail-panel
// zoom-in. The _programmaticPan guard tells the moveend handler this was
// our move, not the user's, so the expansion isn't reset on the rebound.
function _autoFitMap(rendered) {
  if (selectedId != null) return;
  if (!rendered || rendered.length === 0) return;
  const first = rendered[0];
  const bounds = new mapboxgl.LngLatBounds([first.lng, first.lat], [first.lng, first.lat]);
  for (const v of rendered) bounds.extend([v.lng, v.lat]);
  _programmaticPan = true;
  map.fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 15 });
  // _programmaticPan is cleared by the moveend handler when our easeTo finishes.
}

// Incremental zoom-out: extend the *current* map viewport just enough to
// include the freshly-added venues. Used after a pull-tab expansion so the
// map nudges outward by one ring rather than fitting to all rendered venues
// (which would jump to the whole city when a high-relevance venue lives far
// away). The user keeps spatial context — what they were looking at stays
// in the frame, and the new batch is now visible at the edge.
function _autoFitToBatch(newVenues) {
  if (selectedId != null) return;
  if (!newVenues || newVenues.length === 0) return;
  const cur = map.getBounds();
  const sw = cur.getSouthWest(), ne = cur.getNorthEast();
  const bounds = new mapboxgl.LngLatBounds([sw.lng, sw.lat], [ne.lng, ne.lat]);
  for (const v of newVenues) bounds.extend([v.lng, v.lat]);
  _programmaticPan = true;
  map.fitBounds(bounds, { padding: 60, duration: 600, maxZoom: 15 });
}

// Camera padding that respects the bottom panel covering part of the map.
// Lifted from locateUser so other camera moves (the Avstand tracker, etc.)
// can place the user dot in the *visible* area of the screen, not the
// arithmetic center which is hidden behind the panel on mobile.
function _panelAwarePadding() {
  if (!isMobile()) return { top: 96, bottom: 96, left: 16, right: 16 };
  const panelEl = document.getElementById('panel');
  let panelTop = window.innerHeight;
  if (panelEl && !panelEl.classList.contains('mobile-hidden')) {
    const r = panelEl.getBoundingClientRect();
    if (r.top > 0 && r.top < window.innerHeight) panelTop = r.top;
  }
  const occluded = Math.max(0, window.innerHeight - panelTop);
  return { top: 80, bottom: occluded + 16, left: 16, right: 16 };
}

// Avstand zoom tracker. The list is sorted by distance from the user, so the
// bottom-most visible card represents the maximum distance currently in
// view. As the user scrolls down, we widen the map to keep that venue in
// frame, anchored on the user's location so they stay in the visible
// viewport (the screen minus the bottom panel). Two constraints make the
// camera feel calm:
//   1. Center is locked to userLocation, with panel-aware padding so the
//      user dot lands in the middle of the *visible* (non-occluded) area
//      rather than the arithmetic screen center, which on mobile sits
//      behind the panel.
//   2. We only zoom *out*, never in. Scrolling back up doesn't zoom back
//      in; the wider view persists until the user pans, sorts, or hits
//      locate-me (each of which gives a fresh starting zoom).
let _avstandRaf = null;
function _avstandTrackScroll() {
  if (_avstandRaf) return;
  _avstandRaf = requestAnimationFrame(() => {
    _avstandRaf = null;
    if (activeSortBy !== 'distance') return;
    if (selectedId != null || _frozenBounds) return;
    if (!userLocation) return;

    const list = document.getElementById('venue-list');
    if (!list) return;
    const listRect = list.getBoundingClientRect();
    const cards = list.querySelectorAll('.venue-card[data-vid]');
    let bottomVenue = null;
    for (let i = cards.length - 1; i >= 0; i--) {
      const r = cards[i].getBoundingClientRect();
      if (r.top < listRect.bottom && r.bottom > listRect.top) {
        const vid = cards[i].getAttribute('data-vid');
        if (typeof VENUES !== 'undefined') {
          bottomVenue = VENUES.find(x => String(x.id) === String(vid));
        }
        break;
      }
    }
    if (!bottomVenue || !Number.isFinite(bottomVenue.lat) || !Number.isFinite(bottomVenue.lng)) return;

    // Symmetric bounds around the user so cameraForBounds yields the right
    // zoom for "user is at the center, farthest visible venue at the edge."
    const halfLat = Math.abs(bottomVenue.lat - userLocation.lat);
    const halfLng = Math.abs(bottomVenue.lng - userLocation.lng);
    if (halfLat === 0 && halfLng === 0) return;
    const bounds = new mapboxgl.LngLatBounds(
      [userLocation.lng - halfLng, userLocation.lat - halfLat],
      [userLocation.lng + halfLng, userLocation.lat + halfLat]
    );
    const padding = _panelAwarePadding();
    const cam = map.cameraForBounds(bounds, { padding, maxZoom: 15 });
    if (!cam) return;

    // Zoom-out only: skip if the target would zoom in (or stay near same).
    // The 0.05 tolerance absorbs sub-pixel oscillations during scroll.
    if (cam.zoom >= map.getZoom() - 0.05) return;

    _programmaticPan = true;
    map.easeTo({
      center: [userLocation.lng, userLocation.lat],
      zoom: cam.zoom,
      padding,
      duration: 200,
      easing: t => t,
    });
  });
}

let _avstandTrackerWired = false;
function wireAvstandTracker() {
  if (_avstandTrackerWired) return;
  const list = document.getElementById('venue-list');
  if (!list) return;
  list.addEventListener('scroll', _avstandTrackScroll, { passive: true });
  _avstandTrackerWired = true;
}

// User dragging = navigating freely → revert to viewport filter
map.on('dragstart', () => {
  _navMode = false;
});

// Track user-initiated map movement while detail panel is open, so we know
// whether to restore pre-select camera position or just reset tilt on close.
map.on('movestart', (e) => {
  if (e.originalEvent && selectedId != null) _mapMovedWhileDetailOpen = true;
});

// Re-render list on map move when viewport filter is active
let _aMapMoveTimer = null;
map.on('moveend', () => {
  // Programmatic moves (auto-fit on expansion, panToVenueCenter) just clear
  // the guard and bail — they shouldn't reset the user's expansion state or
  // re-render the list (which would itself rebound the camera).
  if (_programmaticPan) {
    _programmaticPan = false;
    return;
  }
  // Debounced analytics for map moves (5 s)
  clearTimeout(_aMapMoveTimer);
  _aMapMoveTimer = setTimeout(() => {
    const b = map.getBounds();
    _aTrack('map_move', {
      zoom: Math.round(map.getZoom() * 10) / 10,
      center: [+(map.getCenter().lng.toFixed(4)), +(map.getCenter().lat.toFixed(4))],
    });
  }, 5000);

  // User panned/zoomed — pull the list back to viewport mode so the new
  // bounds drive what's listed.
  _expansionPages = 0;

  if (!filterMapViewActive) return;
  const list = document.getElementById('venue-list');
  if (list) list.dataset.noAnim = '1';
  renderList();
  updateQcIndicator(null);
  requestAnimationFrame(() => { if (list) delete list.dataset.noAnim; });
});

// ── Control event listeners ───────────────────────────────────────────────────
datePicker.value = todayStr();
timeFromEl.value = Math.min(23, Math.max(4, currentHour()));

datePicker.addEventListener('change', () => {
  _expansionPages = 0;
  if (datePicker.value !== todayStr() && nowMode) {
    nowMode = false;
    clearInterval(nowInterval); nowInterval = null;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    timeFromEl.value = 12;
  }
  update();
  if (typeof _updateFriendsPill === 'function') _updateFriendsPill();
  // Date crossings change which notifications are relevant. update() no
  // longer triggers _notifEvaluate (it was firing per slider tick), so fire
  // once here on a real date change.
  if (typeof _notifEvaluate === 'function') _notifEvaluate();
});

// rAF-coalesce slider input → update(). Touch input fires up to 60Hz, and
// update() does heavy work (draw, drawFtsCanvas, updateSunLighting). The gate
// ensures only the latest hour is processed per frame; intermediate ticks
// coalesce into the next vsync.
let _sliderUpdateScheduled = false;
function _scheduleSliderUpdate() {
  if (_sliderUpdateScheduled) return;
  _sliderUpdateScheduled = true;
  requestAnimationFrame(() => {
    _sliderUpdateScheduled = false;
    updateRangeFill();
    update();
  });
}
timeFromEl.addEventListener('input', () => {
  _expansionPages = 0;
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  if (nowMode) {
    nowMode = false;
    nowBtn.classList.remove('active');
    timeRangeWrap.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  setActiveIntentBtn(null);
  _scheduleSliderUpdate();
});

// ── Oslo candidate index (lazy-loaded on first search miss) ───────────────────

let _candidates = null;          // null = not yet loaded; [] = loaded, empty
let _candidatesLoading = false;

async function _ensureCandidates() {
  if (_candidates !== null || _candidatesLoading) return;
  _candidatesLoading = true;
  try {
    const resp = await dataFetch('oslo-candidates.json');
    _candidates = resp.ok ? await resp.json() : [];
  } catch (_) {
    _candidates = [];
  }
  _candidatesLoading = false;
}

// ── Search dropdown (live results under the search bar) ───────────────────────

const _searchInput    = document.getElementById('venue-search');
const _searchDropdown = document.getElementById('search-dropdown');

// ── Area index (built from VENUES) ───────────────────────────────────────────
// Each area has a name and a bounding box computed from its venues' coordinates.

let _areaIndex = []; // [{ name, bounds: [[w,s],[e,n]], center: [lng,lat], count }]

function _buildAreaIndex() {
  const byArea = {};
  for (const v of VENUES) {
    const a = v.area;
    if (!a) continue;
    if (!byArea[a]) byArea[a] = [];
    byArea[a].push(v);
  }
  _areaIndex = Object.entries(byArea).map(([name, vns]) => {
    const lats = vns.map(v => v.lat), lngs = vns.map(v => v.lng);
    const PAD = 0.003; // slight padding around venues
    return {
      name,
      bounds: [[Math.min(...lngs) - PAD, Math.min(...lats) - PAD],
               [Math.max(...lngs) + PAD, Math.max(...lats) + PAD]],
      center: [lngs.reduce((a, b) => a + b) / lngs.length, lats.reduce((a, b) => a + b) / lats.length],
      count:  vns.length,
    };
  });
  _buildAreaVariants();
}
// _buildAreaIndex is called after loadVenues() completes (see index.html boot chain + initFacings)

// ── Geocoding (areas only via Mapbox — fallback for areas not in our data) ───

let _geoResults  = [];      // cached geocoding results for the current query
let _geoTimer    = null;    // debounce timer
let _geoQuery    = '';      // last query sent to geocoder
let _geoMarker   = null;    // mapboxgl.Marker for address pins

const _GEO_ICON = {
  // Genuine Lucide outline (24x24, stroke-width 2): area = map, venue = map-pin.
  area:    '<svg class="sd-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg>',
  venue:   '<svg class="sd-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>',
};

function _isAreaType(type) {
  return ['neighborhood', 'locality', 'place', 'district', 'region'].includes(type);
}

async function _fetchGeocode(query) {
  if (!MAPBOX_TOKEN || query.length < 2) return [];
  try {
    const center = map.getCenter();
    const bbox = '10.4,59.75,11.0,60.1'; // Greater Oslo area
    // Only fetch area/neighborhood types — addresses are shown as venue context, not standalone
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${MAPBOX_TOKEN}` +
      `&bbox=${bbox}` +
      `&proximity=${center.lng.toFixed(4)},${center.lat.toFixed(4)}` +
      `&limit=3&language=no` +
      `&types=neighborhood,locality,place`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.features || []).map(f => ({
      name:   f.text,
      full:   f.place_name,
      center: f.center,
      bbox:   f.bbox,
      type:   f.place_type?.[0] || 'neighborhood',
      relevance: f.relevance ?? 0,
    }));
  } catch (_) { return []; }
}

function _debounceGeocode(query) {
  clearTimeout(_geoTimer);
  if (query.length < 2) { _geoResults = []; return; }
  _geoTimer = setTimeout(async () => {
    if (_searchInput.value.trim().toLowerCase() !== query) return; // stale
    _geoResults = await _fetchGeocode(query);
    _geoQuery = query;
    if (_searchInput.value.trim().toLowerCase() === query) _renderSearchDropdown(true);
  }, 400);
}

function _removeGeoMarker() {
  if (_geoMarker) { _geoMarker.remove(); _geoMarker = null; }
}

function _sdPickArea(areaName) {
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  _removeGeoMarker();
  // Rebuild area index in case it's stale (e.g. VENUES loaded after initial build)
  if (!_areaIndex.length) _buildAreaIndex();
  const area = _areaIndex.find(a => a.name === areaName);
  if (area) {
    map.fitBounds(area.bounds, {
      padding: { top: 80, bottom: 80, left: 40, right: 40 },
      maxZoom: 15.5,
      duration: 1200,
    });
  }
  // Defer renderList so fitBounds animation starts before expensive sun computation
  setTimeout(renderList, 50);
}

function _sdPickGeo(idx) {
  const g = _geoResults[idx];
  if (!g) return;
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  _removeGeoMarker();
  if (g.bbox) {
    map.fitBounds([[g.bbox[0], g.bbox[1]], [g.bbox[2], g.bbox[3]]], {
      padding: { top: 80, bottom: 80, left: 40, right: 40 },
      duration: 800,
    });
  } else {
    map.flyTo({ center: g.center, zoom: 14.5, duration: 800 });
  }
  renderList();
}

// ── Search normalization & fuzzy matching ────────────────────────────────────

/** Normalize to ASCII-ish form for comparison (ü→u, ø→o, å→a, æ→ae, é→e) */
function _stripDiacritics(s) {
  return s
    .replace(/[øØ]/g, 'o')
    .replace(/[åÅ]/g, 'a')
    .replace(/[æÆ]/g, 'ae')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// True synonyms only — sub-neighborhoods or landmarks that map to a parent area.
// These can't be derived automatically. Add entries per-city as needed.
const _SYNONYMS = {
  'briskeby':     'frogner',
  'solli plass':  'frogner',
  'vika':         'sentrum',
  'vulkan':       'grünerløkka',
  'mathallen':    'grünerløkka',
  'sofienberg':   'grünerløkka',
  'birkelunden':  'grünerløkka',
  'bjørvika':     'sentrum',
  'sørenga':      'sentrum',
  'youngstorget': 'sentrum',
  'karl johan':   'sentrum',
  'bygdøy':       'frogner',
  'bogstadveien': 'majorstuen',
  'adamstuen':    'st. hanshaugen',
  'bjølsen':      'sagene',
  'torshov':      'sagene',
  'carl berner':  'sinsen',
  'storo':        'sinsen',
  'ensjø':        'helsfyr',
  'hasle':        'helsfyr',
  'kværnerbyen':  'helsfyr',
  'ekeberg':      'nordstrand',
  'bekkelaget':   'nordstrand',
  'oppsal':       'bryn',
  'manglerud':    'østensjø',
};

// Auto-generated suffix/whitespace/punctuation variants, built from _areaIndex.
// Rebuilt whenever _buildAreaIndex runs (i.e. after loadVenues).
let _areaVariants = {}; // normalized-variant → canonical lowercase area name

function _buildAreaVariants() {
  _areaVariants = {};
  for (const area of _areaIndex) {
    const canon = area.name.toLowerCase();
    const stripped = _stripDiacritics(canon);
    // Register diacritics-stripped form
    if (stripped !== canon) _areaVariants[stripped] = canon;
    // Remove spaces ("aker brygge" → "akerbrygge")
    const nospace = canon.replace(/\s+/g, '');
    if (nospace !== canon) _areaVariants[nospace] = canon;
    const nospaceDia = _stripDiacritics(nospace);
    if (nospaceDia !== nospace) _areaVariants[nospaceDia] = canon;
    // Remove dots ("st. hanshaugen" → "st hanshaugen")
    const nodots = canon.replace(/\./g, '');
    if (nodots !== canon) _areaVariants[nodots] = canon;
    // Norwegian suffix variants: -en/-a/-et are common interchangeable endings
    // "majorstuen" → "majorstua", "majorstue"; "frogner" stays as-is
    for (const [from, ...tos] of [['en', 'a', 'et', ''], ['a', 'en', 'et', ''], ['et', 'en', 'a', '']]) {
      if (canon.endsWith(from)) {
        const stem = canon.slice(0, -from.length);
        for (const to of tos) {
          const v = stem + to;
          if (v.length >= 3 && v !== canon) _areaVariants[v] = canon;
          const vDia = _stripDiacritics(v);
          if (vDia !== v && vDia.length >= 3) _areaVariants[vDia] = canon;
        }
      }
    }
  }
  // Layer explicit synonyms on top (these override any auto-generated conflict)
  for (const [k, v] of Object.entries(_SYNONYMS)) {
    _areaVariants[k] = v;
    _areaVariants[_stripDiacritics(k)] = v;
  }
}

/** Resolve a query to its canonical area name via synonyms or auto-variants */
function _resolveAlias(q) {
  return _areaVariants[q] || _areaVariants[_stripDiacritics(q)] || null;
}

/** Damerau-Levenshtein distance (transpositions, insertions, deletions, substitutions) */
function _editDistance(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return 3; // fast bail
  const d = Array.from({ length: la + 1 }, () => new Array(lb + 1));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
    }
  }
  return d[la][lb];
}

// ── Search relevance scoring ─────────────────────────────────────────────────

/**
 * Score how well `text` matches query `q` (both lowercase).
 * Higher = better match.  0 = no match.
 *   100  exact match
 *    80  text starts with q
 *    60  word inside text starts with q
 *    40  q appears anywhere inside text (contains)
 *    30  fuzzy match (edit distance ≤ 1 for short, ≤ 2 for longer queries)
 *
 * Also tries diacritics-stripped comparison (grunerløkka ↔ grünerløkka).
 */
function _matchScore(text, q) {
  if (!text) return 0;
  // Exact / prefix / contains on raw text
  const raw = _rawMatchScore(text, q);
  if (raw > 0) return raw;
  // For 1-2 char queries, plain substring match is sufficient — skip expensive paths
  if (q.length < 3) return 0;
  // Try again with diacritics stripped (ü→u, ø→o, å→a)
  const tNorm = _stripDiacritics(text), qNorm = _stripDiacritics(q);
  if (tNorm !== text || qNorm !== q) {
    const norm = _rawMatchScore(tNorm, qNorm);
    if (norm > 0) return norm;
  }
  // Fuzzy: short queries (≥3 chars) tolerate 1 edit, longer (≥5) tolerate 2
  if (q.length >= 3) {
    const maxDist = q.length >= 5 ? 2 : 1;
    // Check against whole text or individual words
    const words = text.split(/[\s,\-]+/);
    for (const w of words) {
      if (Math.abs(w.length - q.length) > maxDist) continue;
      if (_editDistance(w, q) <= maxDist) return 30;
      // Also try diacritics-stripped
      if (_editDistance(_stripDiacritics(w), qNorm) <= maxDist) return 30;
    }
  }
  return 0;
}

function _rawMatchScore(text, q) {
  if (text === q)               return 100;
  if (text.startsWith(q))       return 80;
  if (text.match(new RegExp(`[\\s,\\-]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))) return 60;
  if (text.includes(q))         return 40;
  return 0;
}

/**
 * Score a venue against the query, checking name, area, and address.
 * Returns { score, matchedField } so we know which field matched best
 * and can show the right secondary info.
 */
function _venueMatchDetail(v, q) {
  const nameS = _matchScore(v.name.toLowerCase(), q);
  let   areaS = _matchScore((v.area ?? '').toLowerCase(), q);
  const addrS = _matchScore((v.address ?? '').toLowerCase(), q);
  // Alias boost: "majorstua" → matches venues in "Majorstuen"
  const alias = _resolveAlias(q);
  if (alias && (v.area ?? '').toLowerCase() === alias) areaS = Math.max(areaS, 90);
  const best  = Math.max(nameS, areaS, addrS);
  let matchedField = 'name';
  if (best === addrS && addrS > nameS) matchedField = 'address';
  else if (best === areaS && areaS > nameS) matchedField = 'area';
  return { score: best, matchedField };
}

// ── Search dropdown rendering ────────────────────────────────────────────────

let _googleResults = [];   // cached autocomplete results for current query
let _googleSearching = false;

/**
 * Contextual secondary text for a venue result.
 * - If the query matched the venue's address → show address
 * - Otherwise → show area
 */
function _venueSecondary(v, matchedField) {
  if (matchedField === 'address' && v.address) return v.address.split(',')[0];
  return v.area || '';
}

function _renderSearchDropdown(geoOnly) {
  const q = _searchInput.value.trim().toLowerCase();
  if (!q) { _searchDropdown.classList.remove('open'); return; }

  const MAX_RESULTS = 8;

  // ── Collect all result types with scores ────────────────────────────────
  const scored = [];

  // 1. Our own area index (e.g. "Frogner", "Grünerløkka")
  //    These get a +10 bonus so an exact area match always wins.
  const aliasTarget = _resolveAlias(q);
  const matchedAreaNames = new Set();
  for (const area of _areaIndex) {
    const aLow = area.name.toLowerCase();
    // Direct alias hit gets near-exact score
    if (aliasTarget && aLow === aliasTarget) {
      scored.push({ kind: 'area', score: 100 + 10, data: area });
      matchedAreaNames.add(aLow);
      continue;
    }
    const s = _matchScore(aLow, q);
    if (s > 0) { scored.push({ kind: 'area', score: s + 10, data: area }); matchedAreaNames.add(aLow); }
  }

  // 2. Curated venues
  for (const v of (VENUES || [])) {
    const { score, matchedField } = _venueMatchDetail(v, q);
    if (score > 0) scored.push({ kind: 'curated', score, matchedField, data: v });
  }

  // 3. Candidate venues (skip for 1-2 char queries — too broad, too many results)
  if (q.length >= 3) {
    const curatedNames = new Set(VENUES.map(v => v.name.toLowerCase()));
    for (const c of (_candidates ?? [])) {
      if (curatedNames.has(c.name.toLowerCase())) continue;
      const s = _matchScore(c.name.toLowerCase(), q);
      if (s > 0) scored.push({ kind: 'candidate', score: s, data: c });
    }
  }

  // 4. Mapbox geocoded areas (fallback for areas not in our index)
  const ownAreaNames = new Set(_areaIndex.map(a => a.name.toLowerCase()));
  for (let i = 0; i < (_geoResults || []).length; i++) {
    const g = _geoResults[i];
    if (ownAreaNames.has(g.name.toLowerCase())) continue; // already have this area
    const nameScore = _matchScore(g.name.toLowerCase(), q);
    const base = nameScore > 0 ? nameScore : Math.round((g.relevance || 0) * 60);
    if (base === 0) continue;
    scored.push({ kind: 'geo', score: base + 10, data: g, geoIdx: i });
  }

  // 5. Google autocomplete results (shown after user clicks "Search Google")
  const allNames = new Set(scored.map(r => (r.data.name || '').toLowerCase()));
  for (let i = 0; i < _googleResults.length; i++) {
    const g = _googleResults[i];
    if (allNames.has(g.name.toLowerCase())) continue;
    scored.push({ kind: 'google', score: 50, data: g, googleIdx: i });
  }

  // Sort by score descending, then alphabetically for ties
  scored.sort((a, b) => b.score - a.score || (a.data.name || '').localeCompare(b.data.name || '', 'no'));

  // Limit total results
  const results = scored.slice(0, MAX_RESULTS);

  // Count how many venue-type (non-geo/area) local matches we have
  const localVenueCount = scored.filter(r => r.kind === 'curated' || r.kind === 'candidate').length;
  const hasGoogleResults = _googleResults.length > 0;

  // ── Render rows ─────────────────────────────────────────────────────────

  let html = results.map(r => {
    if (r.kind === 'area') {
      const a = r.data;
      const aName = a.name.replace(/'/g, "\\'");
      return `
      <div class="sd-row" onclick="_sdPickArea('${aName}')">
        <span class="sd-row-icon">${_GEO_ICON.area}</span>
        <span class="sd-row-name">${a.name}</span>
        <span class="sd-row-area">${a.count} venues</span>
      </div>`;
    }
    if (r.kind === 'curated') {
      const v = r.data;
      const secondary = _venueSecondary(v, r.matchedField);
      return `
      <div class="sd-row" onclick="_sdPick(${JSON.stringify(v.id)})">
        <span class="sd-row-icon">${_GEO_ICON.venue}</span>
        <span class="sd-row-name">${v.name}</span>
        ${secondary ? `<span class="sd-row-area">${secondary}</span>` : ''}
      </div>`;
    }
    if (r.kind === 'candidate') {
      const c = r.data;
      const cData = encodeURIComponent(JSON.stringify(c)).replace(/'/g, '%27');
      return `
      <div class="sd-row sd-row-candidate" onclick="_sdPickCandidate(decodeURIComponent('${cData}'))">
        <span class="sd-row-icon">${_GEO_ICON.venue}</span>
        <span class="sd-row-name">${c.name}</span>
        <span class="sd-candidate-btn">${t('candidate_badge')}</span>
      </div>`;
    }
    if (r.kind === 'google') {
      const g = r.data;
      const i = r.googleIdx;
      return `
      <div class="sd-row sd-row-candidate" onclick="_sdPickGoogle(${i})">
        <span class="sd-row-icon">${_GEO_ICON.venue}</span>
        <span class="sd-row-name">${g.name}</span>
        <span class="sd-row-area">${g.secondary}</span>
      </div>`;
    }
    // geo (Mapbox area not in our index)
    const g = r.data;
    const i = r.geoIdx;
    const subtext = (g.full || '').split(', ').slice(1, 3).join(', ') || 'Area';
    return `
    <div class="sd-row sd-row-geo" onclick="_sdPickGeo(${i})">
      <span class="sd-row-icon">${_GEO_ICON.area}</span>
      <span class="sd-row-name">${g.name}</span>
      <span class="sd-row-area">${subtext}</span>
    </div>`;
  }).join('');

  // ── Footer: "Search Google" button when no local venue matches, or "Suggest venue" ──
  const noMatch = results.length === 0;
  const rawQ    = _searchInput.value.trim();
  if (localVenueCount === 0 && !hasGoogleResults) {
    const label = noMatch
      ? `${t('no_results_for')} "<strong>${rawQ}</strong>"`
      : '';
    const btnLabel = _googleSearching ? t('searching_google') : t('search_google');
    const btnDisabled = _googleSearching ? 'disabled' : '';
    html += `<div class="sd-suggest-row">
      ${label ? `<span class="sd-suggest-label">${label}</span>` : ''}
      <button class="sd-suggest-btn" onclick="_sdSearchGoogle()" ${btnDisabled}>${btnLabel}</button>
    </div>`;
  } else {
    const label = noMatch
      ? `${t('no_results_for')} "<strong>${rawQ}</strong>"`
      : t('not_seeing_venue');
    html += `<div class="sd-suggest-row">
      <span class="sd-suggest-label">${label}</span>
      <button class="sd-suggest-btn" onclick="_sdSuggest()">${t('suggest_venue')}</button>
    </div>`;
  }

  _searchDropdown.innerHTML = html;
  _searchDropdown.classList.add('open');

  // Kick off candidate loading in the background if not yet loaded
  if (_candidates === null) _ensureCandidates().then(() => {
    if (_searchInput.value.trim()) _renderSearchDropdown();
  });

  // Kick off geocoding (debounced)
  if (!geoOnly) _debounceGeocode(q);
}

// ── Google Places Autocomplete search (on-demand) ────────────────────────────

async function _sdSearchGoogle() {
  const q = _searchInput.value.trim();
  if (!q || _googleSearching) return;

  _googleSearching = true;
  _renderSearchDropdown();  // re-render to show "Searching…" state

  try {
    const bounds = map.getBounds();
    const sw = `${bounds.getSouth().toFixed(3)},${bounds.getWest().toFixed(3)}`;
    const ne = `${bounds.getNorth().toFixed(3)},${bounds.getEast().toFixed(3)}`;
    const resp = await fetch(`/api/places-autocomplete?q=${encodeURIComponent(q)}&sw=${sw}&ne=${ne}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    _googleResults = data.suggestions || [];
  } catch (_) {
    _googleResults = [];
  }

  _googleSearching = false;

  // Re-render with Google results injected
  if (_searchInput.value.trim()) _renderSearchDropdown();
}

function _sdPickGoogle(idx) {
  const g = _googleResults[idx];
  if (!g) return;

  // We need lat/lng to proceed — fetch Place Details for this placeId
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  _googleResults = [];

  // Use the existing candidate flow: fetch details via Places search, then load
  _loadGooglePlace(g);
}

async function _loadGooglePlace(place) {
  // Fetch full details (lat/lng, photos) via Place Details API using the placeId
  try {
    const resp = await fetch(`/api/place-details?id=${encodeURIComponent(place.placeId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.lat || !data.lng) return;

    const candidate = {
      name:    data.name || place.name,
      lat:     data.lat,
      lng:     data.lng,
      amenity: 'restaurant',
      address: data.address || place.secondary || '',
      photos:  data.photos || [],
      source:  'google',
      googlePlaceId: place.placeId,
    };

    _sdPickCandidate(candidate);
  } catch (_) { /* silently fail */ }
}


function _sdPick(id) {
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  selectVenue(id, true);
  renderList();
}

async function _sdPickCandidate(encodedOrObj) {
  const c = typeof encodedOrObj === 'string' ? JSON.parse(encodedOrObj) : encodedOrObj;
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');

  // ── Create a temporary venue object ──────────────────────────────────────
  const tmpId = -Date.now(); // negative to avoid collisions with real IDs
  const tmpVenue = {
    id:             tmpId,
    name:           c.name,
    address:        c.address || '',
    coords:         [c.lat, c.lng],
    lat:            c.lat,
    lng:            c.lng,
    category:       c.amenity || 'restaurant',
    area:           '',
    rating:         null,
    facing:         null,
    openingHours:   { open: 11, close: 23 },
    buildingOsmId:  null,
    googlePlaceId:  null,
    facingSource:   null,
    _isCandidate:   true,
    _candidateData: c,
  };

  // ── Show loading detail panel ────────────────────────────────────────────
  const dp      = document.getElementById('detail-panel');
  const content = document.getElementById('dp-content');
  if (!dp || !content) return;

  content.innerHTML = _renderCandidateLoadingPanel(c.name);
  dp.classList.remove('dp-fullscreen');
  dp.classList.add('open');
  if (isMobile()) {
    const panel = document.getElementById('panel');
    if (panel) {
      panel.classList.remove('mobile-expanded', 'mobile-fullscreen');
      panel.classList.add('mobile-hidden');
      _syncFtsPosition();
    }
    document.getElementById('floating-search')?.classList.add('mobile-ui-hidden');
    document.getElementById('top-strip')?.classList.add('mobile-ui-hidden');
    document.getElementById('qc-wrap')?.classList.add('mobile-ui-hidden');
  }

  const statusEl = document.getElementById('candidate-loading-status');
  const _setStatus = (key) => { if (statusEl) statusEl.textContent = t(key); };

  // ── Step 1: Fetch building geometry from OSM ─────────────────────────────
  _setStatus('loading_geometry');
  const enriched = await fetchAndComputeGeometryForVenue(tmpVenue);
  if (!enriched) {
    content.innerHTML = _renderCandidateErrorPanel(c.name);
    return;
  }

  // Carry over photos from Google Place Details if available
  if (c.photos?.length) enriched.photoUrls = c.photos;

  // ── Fly to the venue using geometry-corrected coordinates ────────────────
  _flyToVenue(enriched);

  // ── Step 2: Show "estimating sun" ────────────────────────────────────────
  _setStatus('loading_sun');

  // Add to VENUES temporarily so computeSunWindows and the rest works
  VENUES.push(enriched);
  if (typeof rebuildVenuesById === 'function') rebuildVenuesById();
  sunWindowCache.clear();

  // Small delay so the user sees the status progress
  await new Promise(r => setTimeout(r, 400));

  // ── Step 3: Show "finding seating" ───────────────────────────────────────
  _setStatus('loading_seating');
  await new Promise(r => setTimeout(r, 300));

  _setStatus('loading_almost');
  await new Promise(r => setTimeout(r, 200));

  // ── Step 4: Render real detail panel ─────────────────────────────────────
  selectedId = tmpId;
  _navPush('venue');
  clearSpriteCache();
  openDetailPanel(enriched);
  draw();
  renderList();

  // ── Auto-submit as venue suggestion if user is logged in ────────────────
  if (c.source === 'google' && c.googlePlaceId && typeof submitVenueSuggestion === 'function') {
    submitVenueSuggestion({
      name:          c.name,
      lat:           enriched.lat ?? c.lat,
      lng:           enriched.lng ?? c.lng,
      address:       c.address,
      googlePlaceId: c.googlePlaceId,
      notes:         'Auto-submitted from Google search',
    }).catch(() => {}); // fire-and-forget; don't block the UI
  }
}

function _renderCandidateLoadingPanel(name) {
  return `
    <div class="candidate-loading-panel">
      <div class="candidate-loading-name">${name}</div>
      <div class="candidate-loading-spinner"></div>
      <div id="candidate-loading-status" class="candidate-loading-status">${t('loading_geometry')}</div>
    </div>`;
}

function _renderCandidateErrorPanel(name) {
  return `
    <div class="candidate-loading-panel">
      <div class="candidate-loading-name">${name}</div>
      <div style="font-size:14px;color:var(--muted);margin-top:16px">
        Could not find building geometry for this location.
      </div>
      <button class="sd-suggest-btn" style="margin-top:16px"
        onclick="closeDetailPanel()">Close</button>
    </div>`;
}

function _sdSuggest() {
  const q = _searchInput.value.trim();
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  renderList();
  if (q) suggestVenueFlow(q);
}

const _searchBar = document.getElementById('floating-search');

function _syncSearchClearBtn() {
  if (_searchBar) _searchBar.classList.toggle('has-query', _searchInput.value.trim().length > 0);
}

let _preSearchPanelState = null;
let _searchSessionActive = false;
let _searchBlurTimer = null;

// ── Panel action-row filters (Stage 2c wiring) ───────────────────────────────
// Categories: 'cafe' | 'restaurant' | 'bar' — multi-select. Empty set = no
// category filter (all shown). sun2h + sheltered are placeholder toggles
// (visual-only for now); will wire once sun-hour + shelter scoring is hooked.
window._activeFilters = {
  categories: new Set(),
  sun2h: false,
  quiet: false,
  friends: false,
};

window._passesActiveFilters = function(v) {
  const f = window._activeFilters;
  if (f.categories.size > 0 && !f.categories.has(v.category)) return false;
  if (f.sun2h) {
    // Total upcoming sun hours from now until close, clamped to open hours.
    // Reads the same precomputed windows the score uses — same data path
    // means the filter agrees with what the user sees on the card.
    if (typeof computeSunWindows !== 'function') return false;
    const dateStr = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : null;
    const fromH   = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : 0;
    if (!dateStr) return true;
    const sw = computeSunWindows(v, dateStr);
    const open  = sw?.open  ?? 0;
    const close = sw?.close ?? 24;
    let total = 0;
    for (const w of (sw?.windows || [])) {
      const s = Math.max(w.start, fromH, open);
      const e = Math.min(w.end, close);
      if (e > s) total += (e - s);
    }
    if (total < 2) return false;
  }
  if (f.quiet) {
    // Stille is supposed to mean "quiet" (noise-based, not busyness).
    // venues.json carries NO noiseScore data on any row — the OSM-
    // highway-proximity backfill pipeline hasn't been run on this
    // dataset. Filtering by category as a noise proxy or by busyness
    // is dishonest, so the pill is removed from the UI for now and
    // this branch is dormant. Restore once the data is in.
    if (typeof noiseScore !== 'function') return false;
    if (noiseScore(v) < 70) return false;
  }
  // NOTE: f.friends is intentionally NOT an exclusion. The "Venner" pill now
  // *prioritises* friend venues to the top of the list (see renderList's
  // friends repartition) rather than hiding everything else — the user still
  // wants to see best-match venues below. venueHasFriends() is the shared predicate.
  return true;
};

/** True when a venue has friends checked in OR a live (non-cancelled) plan.
 *  Shared by the "Venner" list prioritisation. */
window.venueHasFriends = function(v) {
  if (typeof getFriendCheckinsForVenue === 'function'
      && (getFriendCheckinsForVenue(v.id) || []).length) return true;
  if (typeof getPlansForVenue === 'function') {
    const plans = getPlansForVenue(v.id) || [];
    if (plans.some(p => p && !p.cancelled_at)) return true;
  }
  return false;
};

function toggleListFilter(filter, btn) {
  const f = window._activeFilters;
  if (filter === 'cafe' || filter === 'restaurant' || filter === 'bar') {
    if (f.categories.has(filter)) {
      f.categories.delete(filter);
      btn?.classList.remove('active');
    } else {
      f.categories.add(filter);
      btn?.classList.add('active');
    }
    if (typeof _updateFilterBadge === 'function') _updateFilterBadge();
    if (typeof renderList === 'function') renderList();
    if (typeof window.markPinLayoutStale === 'function') window.markPinLayoutStale();
    if (typeof draw === 'function') draw();
    return;
  }
  if (filter === 'sun2h' || filter === 'quiet' || filter === 'friends') {
    f[filter] = !f[filter];
    btn?.classList.toggle('active', f[filter]);
    if (typeof _updateFilterBadge === 'function') _updateFilterBadge();
    if (typeof renderList === 'function') renderList();
    if (typeof window.markPinLayoutStale === 'function') window.markPinLayoutStale();
    if (typeof draw === 'function') draw();
    return;
  }
  // Unknown filter — just toggle the visual active state.
  btn?.classList.toggle('active');
}

/** Enter search mode — transforms #top-strip into a full-width input.
 *  Focusing #venue-search triggers _enterSearchSession via its existing
 *  focus handler, which shows the dropdown when there's a query. */
function enterSearchMode() {
  const strip = document.getElementById('top-strip');
  const input = document.getElementById('venue-search');
  if (!strip || !input) return;
  strip.classList.add('searching');
  // Kick off the typewriter so users discover what they can search for.
  // It auto-stops the moment they type anything.
  _startSearchPlaceholderAnim();
  // Focus SYNCHRONOUSLY inside the user-gesture handler so iOS Safari
  // honors it and opens the keyboard. (rAF defers past the gesture
  // window and the keyboard may not open on mobile.)
  input.focus();
}

/** Exit search mode — clears the input, blurs it, collapses the strip. */
function exitSearchMode() {
  const strip = document.getElementById('top-strip');
  const input = document.getElementById('venue-search');
  if (!strip || !input) return;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.blur();
  strip.classList.remove('searching');
  _stopSearchPlaceholderAnim();
}

// ── Search placeholder typewriter ────────────────────────────────────────────
// Cycles example queries through the placeholder so users discover what
// they can search for. Pauses while the strip is in search mode (the real
// placeholder shows then) and while there's any user input.
// Literal matches the existing keyword search handles. Skews venue-heavy
// with two areas — there are more venues than areas in the dataset, so
// the placeholder examples should reflect that.
const _SEARCH_PLACEHOLDER_EXAMPLES = [
  'Vinland',
  'Lekteren',
  'Nedre Foss Gård',
  'Michaels',
  'Mathallen',
  'Frogner',
  'Aker brygge',
];
const _SEARCH_PH_TYPE_MS   = 35;
const _SEARCH_PH_HOLD_MS   = 1100;
const _SEARCH_PH_DELETE_MS = 20;
const _SEARCH_PH_GAP_MS    = 280;
let _searchPhTimer = null;
let _searchPhExampleIdx = 0;
let _searchPhCharIdx = 0;
let _searchPhPhase = 'typing';  // typing | holding | deleting | gap
let _searchPhBaseText = 'Søk etter steder eller områder…';

function _startSearchPlaceholderAnim() {
  const input = document.getElementById('venue-search');
  if (!input) return;
  _stopSearchPlaceholderAnim();
  if (input.value) return;  // user has typed; don't fight them
  _searchPhExampleIdx = 0;
  _searchPhCharIdx = 0;
  _searchPhPhase = 'typing';
  _searchPhTick();
}

function _stopSearchPlaceholderAnim() {
  if (_searchPhTimer) {
    clearTimeout(_searchPhTimer);
    _searchPhTimer = null;
  }
  const input = document.getElementById('venue-search');
  if (input) input.placeholder = _searchPhBaseText;
}

function _searchPhTick() {
  const input = document.getElementById('venue-search');
  if (!input) return;
  // Bail if user typed something or strip is no longer in search mode.
  const inSearch = document.getElementById('top-strip')?.classList.contains('searching');
  if (input.value || !inSearch) {
    _stopSearchPlaceholderAnim();
    return;
  }
  const example = _SEARCH_PLACEHOLDER_EXAMPLES[_searchPhExampleIdx];
  if (_searchPhPhase === 'typing') {
    _searchPhCharIdx++;
    input.placeholder = example.slice(0, _searchPhCharIdx);
    if (_searchPhCharIdx >= example.length) _searchPhPhase = 'holding';
    _searchPhTimer = setTimeout(_searchPhTick,
      _searchPhPhase === 'holding' ? _SEARCH_PH_HOLD_MS : _SEARCH_PH_TYPE_MS);
  } else if (_searchPhPhase === 'holding') {
    _searchPhPhase = 'deleting';
    _searchPhTimer = setTimeout(_searchPhTick, _SEARCH_PH_DELETE_MS);
  } else if (_searchPhPhase === 'deleting') {
    _searchPhCharIdx--;
    input.placeholder = example.slice(0, _searchPhCharIdx);
    if (_searchPhCharIdx <= 0) {
      _searchPhPhase = 'gap';
      _searchPhExampleIdx = (_searchPhExampleIdx + 1) % _SEARCH_PLACEHOLDER_EXAMPLES.length;
    }
    _searchPhTimer = setTimeout(_searchPhTick,
      _searchPhPhase === 'gap' ? _SEARCH_PH_GAP_MS : _SEARCH_PH_DELETE_MS);
  } else {
    _searchPhPhase = 'typing';
    _searchPhCharIdx = 0;
    _searchPhTick();
  }
}


function _enterSearchSession() {
  if (_searchSessionActive) return;
  _searchSessionActive = true;
  // Hide the zoom-jog while the keyboard is up — it was re-anchoring into the
  // search bar as the viewport shrank, and it's useless mid-search anyway.
  document.body.classList.add('search-active');
  if (isMobile() && typeof window._applyMobilePanelState === 'function') {
    const cur = window._currentMobilePanelState?.() ?? null;
    _preSearchPanelState = cur;
    if (cur !== 'peek') window._applyMobilePanelState('peek');
  }
  if (typeof _notifSuspendForSearch === 'function') _notifSuspendForSearch();
}

function _exitSearchSession() {
  if (!_searchSessionActive) return;
  _searchSessionActive = false;
  document.body.classList.remove('search-active');
  if (_preSearchPanelState !== null) {
    const saved = _preSearchPanelState;
    _preSearchPanelState = null;
    if (isMobile() && typeof window._applyMobilePanelState === 'function'
        && window._currentMobilePanelState?.() === 'peek'
        && saved !== 'peek') {
      window._applyMobilePanelState(saved);
    }
  }
  if (typeof _notifResumeAfterSearch === 'function') _notifResumeAfterSearch();
}

let _searchListTimer = null;
let _searchDropdownTimer = null;
let _aSearchTimer = null;
_searchInput.addEventListener('input', () => {
  _syncSearchClearBtn();
  _expansionPages = 0;
  _googleResults = [];  // clear Google results when query changes
  // Both renders are debounced. The dropdown gets a tiny 60 ms delay so a
  // burst of keystrokes collapses to one venue/area scan + diacritics pass;
  // renderList() keeps its 300 ms because its solar-math work dominates.
  clearTimeout(_searchDropdownTimer);
  _searchDropdownTimer = setTimeout(_renderSearchDropdown, 60);
  clearTimeout(_searchListTimer);
  _searchListTimer = setTimeout(renderList, 300);
  // Analytics: debounced search tracking (2 s after typing stops)
  clearTimeout(_aSearchTimer);
  const q = _searchInput.value.trim();
  if (q.length >= 2) {
    _aSearchTimer = setTimeout(() => _aTrack('search', { query: q }), 2000);
  }
});
_searchInput.addEventListener('focus', () => {
  clearTimeout(_searchBlurTimer);
  _enterSearchSession();
  if (_searchInput.value.trim()) _renderSearchDropdown();
});
_searchInput.addEventListener('blur', () => {
  clearTimeout(_searchBlurTimer);
  _searchBlurTimer = setTimeout(() => {
    _searchDropdown.classList.remove('open');
    _exitSearchSession();
  }, 150);
});

// Clear button
document.getElementById('search-clear-btn')?.addEventListener('click', () => {
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  _removeGeoMarker();
  _googleResults = [];
  renderList();
  _searchInput.focus();
});

// Prevent the search input from losing focus when the user taps/clicks inside
// the dropdown — this keeps the dropdown visible so click handlers fire normally.
_searchDropdown.addEventListener('mousedown', e => e.preventDefault());
// On touch, preventDefault on touchstart suppresses the synthetic click event,
// so onclick attributes on rows would never fire. Instead we keep preventDefault
// (to prevent blur) but manually trigger the row action on touchend.
_searchDropdown.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
_searchDropdown.addEventListener('touchend', e => {
  const row = e.target.closest('[onclick]');
  if (row) { e.preventDefault(); row.click(); _searchInput.blur(); }
}, { passive: false });
// After a row is selected (desktop click path), drop focus so the mobile
// keyboard closes and the search session ends — which resumes any suspended
// notification toast.
_searchDropdown.addEventListener('click', e => {
  if (e.target.closest('[onclick]')) _searchInput.blur();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (_searchDropdown.classList.contains('open')) {
      _searchDropdown.classList.remove('open');
      _searchInput.blur();
    } else if (editingVenueId) exitEditMode();
    else if (selectedId != null) closeDetailPanel();
  }

  // Pitch controls: [ to decrease, ] to increase
  if (e.key === '[') {
    map.easeTo({ pitch: Math.max(0, map.getPitch() - 10), duration: 200 });
  }
  if (e.key === ']') {
    map.easeTo({ pitch: Math.min(85, map.getPitch() + 10), duration: 200 });
  }
});

// ── Venue suggestion flow ─────────────────────────────────────────────────────
// Entry point for searching a venue not in our curated list.
// 1. Look up via Google Places to confirm location
// 2. Show confirm card in list
// 3. Logged-in → submit to Supabase (owned by user account)
//    Anonymous  → open pre-filled GitHub issue

async function suggestVenueFlow(query) {
  // Show a brief inline notice in the dropdown area while we look up the place
  const lookupToast = document.createElement('div');
  lookupToast.style.cssText =
    'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);' +
    'background:rgba(13,31,53,0.92);border:1px solid rgba(156,189,231,0.22);' +
    'color:var(--text);font-size:13px;padding:8px 16px;border-radius:20px;' +
    'z-index:3100;white-space:nowrap;pointer-events:none;';
  lookupToast.textContent = `Looking up "${query}"…`;
  document.body.appendChild(lookupToast);

  if (!GOOGLE_PLACES_KEY) {
    console.warn('[suggestVenueFlow] GOOGLE_PLACES_KEY is not defined');
    lookupToast.remove();
    showQcNotice('API key not configured');
    return;
  }

  // Fetch from Google Places via Cloudflare Pages Function (on-demand only)
  let results = [];
  try {
    const searchQuery = query;
    const proxyUrl = `/api/places-search?q=${encodeURIComponent(searchQuery)}`;
    const resp = await fetch(proxyUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'OK' && data.results?.length) {
        results = data.results;
      } else {
        console.warn('[suggestVenueFlow] API status:', data.status, data);
      }
    } else {
      console.warn('[suggestVenueFlow] Fetch failed:', resp.status, resp.statusText);
    }
  } catch (err) {
    console.error('[suggestVenueFlow] Error:', err?.message ?? err, err);
  }

  lookupToast.remove();

  if (!results.length) {
    showQcNotice(`Couldn't find "${query}" in Oslo`);
    return;
  }

  // If only one result, proceed directly to confirmation
  if (results.length === 1) {
    const found = results[0];
    const name    = found.name                        ?? query;
    const address = found.formatted_address           ?? '';
    const lat     = found.geometry?.location?.lat     ?? 0;
    const lng     = found.geometry?.location?.lng     ?? 0;

    if (typeof map !== 'undefined') {
      map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15), duration: 800 });
    }

    _renderSuggestConfirm({ name, address, lat, lng, osmId: null });
    return;
  }

  // Multiple results: show selection modal
  _renderSuggestVenueSelection(results, query);
}

// Show a modal to select from multiple Google Places results
function _renderSuggestVenueSelection(results, query) {
  // Remove any existing modal
  document.getElementById('suggest-selection-modal')?.remove();

  const resultsHtml = results.slice(0, 5).map((r, i) => `
    <div class="suggest-result-row" onclick="_sdSelectSuggestVenue(${i}, '${encodeURIComponent(JSON.stringify(results)).replace(/'/g, '%27')}')">
      <div class="suggest-result-name">${r.name}</div>
      <div class="suggest-result-address">${r.formatted_address}</div>
    </div>
  `).join('');

  const modal = document.createElement('div');
  modal.id = 'suggest-selection-modal';
  modal.className = 'admin-modal';
  modal.innerHTML = `
    <div class="admin-modal-inner" style="max-width:380px;max-height:60vh;overflow-y:auto">
      <div class="admin-modal-header">
        <div class="admin-modal-title">Select venue</div>
        <button class="admin-modal-close" onclick="document.getElementById('suggest-selection-modal').remove()">✕</button>
      </div>
      <div class="admin-modal-body" style="padding:0;border-top:1px solid rgba(156,189,231,0.15)">
        ${resultsHtml}
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// Handle selection from multiple results
function _sdSelectSuggestVenue(idx, encodedResults) {
  const results = JSON.parse(decodeURIComponent(encodedResults));
  const found = results[idx];

  document.getElementById('suggest-selection-modal')?.remove();

  const name    = found.name                        ?? '';
  const address = found.formatted_address           ?? '';
  const lat     = found.geometry?.location?.lat     ?? 0;
  const lng     = found.geometry?.location?.lng     ?? 0;

  // Fly the map to the selected location
  if (typeof map !== 'undefined') {
    map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15), duration: 800 });
  }

  _renderSuggestConfirm({ name, address, lat, lng, osmId: null });
}

// Show a centered modal for venue suggestion confirmation.
// Used both by suggestVenueFlow (Places lookup) and _showCandidateConfirm (OSM candidate).
function _renderSuggestConfirm({ name, address, lat, lng, osmId }) {
  const user = typeof authCurrentUser === 'function' ? authCurrentUser() : null;

  const loginHint = user ? '' : `
    <p style="font-size:12px;color:var(--muted);margin:0 0 12px;line-height:1.5">${t('suggest_login_hint')}</p>`;

  const issueTitle = encodeURIComponent(`Venue suggestion: ${name}`);
  const issueBody  = encodeURIComponent(
    `**Venue:** ${name}\n**Address:** ${address}\n**Coordinates:** ${lat}, ${lng}\n\n` +
    `*Suggested via the app search. Please verify outdoor seating before adding.*`
  );
  const issueUrl = `https://github.com/thor-erik/Solsteder/issues/new?title=${issueTitle}&body=${issueBody}`;

  const dataAttr = encodeURIComponent(JSON.stringify({ name, address, lat, lng, osmId })).replace(/'/g, '%27');

  // Remove any existing suggest modal
  document.getElementById('suggest-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'suggest-modal';
  modal.className = 'admin-modal';
  modal.innerHTML = `
    <div class="admin-modal-inner" style="max-width:360px">
      <div class="admin-modal-header">
        <div class="admin-modal-title">Suggest venue</div>
        <button class="admin-modal-close" onclick="document.getElementById('suggest-modal').remove()">✕</button>
      </div>
      <div class="admin-modal-body" style="padding:16px 20px 20px">
        <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px">${name}</div>
        ${address ? `<div style="font-size:13px;color:var(--muted);margin-bottom:16px">${address}</div>` : '<div style="margin-bottom:16px"></div>'}
        <p style="font-size:13px;color:rgba(255,242,235,0.7);margin:0 0 16px;line-height:1.5">
          Does this venue have outdoor seating (uteservering)?
        </p>
        ${loginHint}
        <div style="display:flex;gap:8px;align-items:center">
          ${user
            ? `<button class="p-pill suggest-submit" style="flex:1" onclick="_submitSuggestion('${dataAttr}')">Yes, suggest it →</button>`
            : `<a class="p-pill suggest-submit" style="flex:1" href="${issueUrl}" target="_blank" rel="noopener"
                 onclick="setTimeout(()=>document.getElementById('suggest-modal')?.remove(),300)">Yes, suggest it →</a>`
          }
          <button class="g-rnd" onclick="document.getElementById('suggest-modal').remove()">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// Submits to Supabase when user is logged in
async function _submitSuggestion(dataAttrEncoded) {
  const { name, address, lat, lng, osmId } = JSON.parse(decodeURIComponent(dataAttrEncoded));

  const modal = document.getElementById('suggest-modal');
  const btn = modal?.querySelector('.suggest-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  const result = await submitVenueSuggestion({ name, address, lat, lng, osmId });
  if (result?.error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Yes, suggest it →'; }
    showQcNotice('Error: ' + (result.error.message ?? result.error));
    return;
  }
  modal?.remove();
  showQcNotice(t('suggest_submitted'));
  if (typeof _loadMySuggestions === 'function') _loadMySuggestions();
}

// Called when user clicks a candidate from the search dropdown
function _showCandidateConfirm(c) {
  // Fly map to the candidate's location so the user can assess it before confirming
  if (typeof map !== 'undefined') {
    map.flyTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom(), 15), duration: 800 });
  }
  _renderSuggestConfirm({ name: c.name, address: c.address, lat: c.lat, lng: c.lng, osmId: c.osmId });
}

// ── Intro sequence ────────────────────────────────────────────────────────────

/**
 * Restore the view saved by the auth handlers (auth.js _captureAuthRestoreState)
 * before the OAuth/magic-link redirect. Called only on auth return, after
 * _skipIntro() has already snapped the UI to now.
 *
 * OAuth (Google/Apple) returns to the same tab, so its snapshot is in
 * sessionStorage. Magic-link clicks usually open in a fresh tab, so that
 * snapshot lives in localStorage with a 30-minute TTL guard.
 */
const _AUTH_RESTORE_TTL_MS = 30 * 60 * 1000;
function _restorePreAuthState() {
  let saved = null;
  try {
    const raw = sessionStorage.getItem('solsteder_auth_restore')
             || localStorage.getItem('solsteder_auth_restore');
    if (raw) saved = JSON.parse(raw);
  } catch (_) {}
  // Always clear, even if stale — don't let it leak into a future session
  try { sessionStorage.removeItem('solsteder_auth_restore'); } catch (_) {}
  try { localStorage.removeItem('solsteder_auth_restore'); } catch (_) {}
  if (!saved) return;
  if (saved.savedAt && Date.now() - saved.savedAt > _AUTH_RESTORE_TTL_MS) return;

  if (saved.date) datePicker.value = saved.date;

  if (!saved.nowMode && saved.time != null) {
    // _skipIntro() activated nowMode; deactivate it and restore the saved time
    if (nowMode) {
      nowMode = false;
      clearInterval(nowInterval); nowInterval = null;
      nowBtn?.classList.remove('active');
      timeRangeWrap?.classList.remove('now-active');
    }
    timeFromEl.value = saved.time;
    updateRangeFill();
  }

  if (saved.area && typeof setAreaFilter === 'function') {
    setAreaFilter(saved.area);
  }

  if (saved.sortBy && saved.sortBy !== activeSortBy) {
    activeSortBy = saved.sortBy;
    if (typeof updateSortBtns === 'function') updateSortBtns();
  }

  // Restore mobile panel state if it was non-default. Only re-apply known state
  // classes to avoid clobbering intro-hidden or other transient classes.
  if (saved.panel) {
    const panelEl = document.getElementById('panel');
    if (panelEl) {
      const STATE_CLASSES = ['mobile-hidden', 'mobile-expanded', 'mobile-fullscreen'];
      const want = STATE_CLASSES.find(c => saved.panel.split(/\s+/).includes(c));
      if (want) {
        panelEl.classList.remove(...STATE_CLASSES);
        panelEl.classList.add(want);
      }
    }
  }

  update();

  if (saved.venueId != null) {
    // Small delay: let auth state settle and list render before opening the panel
    setTimeout(() => { if (typeof selectVenue === 'function') selectVenue(saved.venueId, true); }, 300);
  }

  // Replay the post-login intent (e.g. reopen the invite sheet on the
  // venue the user was about to invite friends to). Run after the venue
  // has had a moment to open so the invite sheet has a real selectedId
  // to anchor against.
  if (saved.intent && saved.intent.type === 'invite_sheet' && saved.intent.venueId != null) {
    const wantedId = saved.intent.venueId;
    setTimeout(() => {
      if (typeof _openInviteSheet === 'function' && typeof authCurrentUser === 'function' && authCurrentUser()) {
        try { _openInviteSheet(wantedId); } catch (e) { /* ignore */ }
      }
      if (typeof window !== 'undefined') window._postLoginIntent = null;
    }, 700);
  }

  // Rehydrate the pending plan-invite payload so the receiver lands back
  // on the plan-preview card after they sign in to RSVP. Supabase strips
  // the invite token from the URL during the OAuth callback, so on the
  // second page-load the URL no longer carries the data — sessionStorage
  // is the only path back. window._tryPendingInvite is now exposed
  // unconditionally so we can invoke it whether or not the URL carried
  // the original token.
  if (saved.pendingInvite) {
    window._pendingInvite = saved.pendingInvite;
    setTimeout(() => {
      if (typeof window._tryPendingInvite === 'function') {
        try { window._tryPendingInvite(); } catch (e) { /* ignore */ }
      }
    }, 900);
  }
}

function _introCheckReady() {
  if (_introMapReady && _introGeoReady && _introDataReady && !_introRunning) {
    _introRunning = true;
    // Skip intro animation if this is an OAuth redirect return. Two
    // detection paths: the URL still carries OAuth markers (fast path),
    // or sessionStorage has a fresh auth-restore snapshot left by
    // _captureAuthRestoreState (works even when Supabase already stripped
    // the URL via history.replaceState before this code ran — a race we
    // were losing on slower devices, sending the user back to today/now).
    const isOAuthReturn = window.location.hash.includes('access_token=') ||
                          new URLSearchParams(window.location.search).has('code');
    let hasFreshRestore = false;
    try {
      const raw = sessionStorage.getItem('solsteder_auth_restore')
               || localStorage.getItem('solsteder_auth_restore');
      if (raw) {
        const parsed = JSON.parse(raw);
        hasFreshRestore = !!(parsed && parsed.savedAt
          && Date.now() - parsed.savedAt < _AUTH_RESTORE_TTL_MS);
      }
    } catch (_) {}
    if (isOAuthReturn || hasFreshRestore) { _skipIntro(); _restorePreAuthState(); return; }

    // If opened via a share link, focus on that venue at the sender's time.
    // New format: #venue-name-<id>/20260420T16
    // Old format (backward compat): #v=<id>&d=YYYY-MM-DD&t=<hour>
    const hash = window.location.hash.slice(1);

    // Handle friend invite link: #friend/<userId>
    //
    // Semantics. The SENDER published the link; the RECIPIENT clicking it is
    // the recipient's consent. The sender's consent isn't proven by anything
    // verifiable — anyone with a user's UUID could craft a "/#friend/<uuid>"
    // link, so accepting a fresh row at status='accepted' on the recipient
    // side would let any attacker force-friendship anyone whose UUID they
    // could harvest from plan invites or profile embeds. sql/036 closed that
    // by rejecting recipient-side INSERTs at 'accepted'. This handler matches
    // that policy by branching on whether the inviter has already shown
    // consent (a pre-existing row) and otherwise creating a 'pending' row.
    //
    // Three outcomes:
    //   1. Row exists in either direction at status != accepted → UPDATE to
    //      'accepted'. Both sides have now opted in (sender via the prior
    //      row, recipient via clicking the link). "Now friends" toast.
    //   2. Row exists at status='accepted' → already friends. No-op, no toast.
    //   3. No row → INSERT (user_id=me, friend_id=sender, status='pending').
    //      Recipient is signalling consent; sender's consent will land when
    //      they tap Accept on the friend request that appears in their inbox.
    //      "Request sent" toast.
    if (hash.startsWith('friend/')) {
      // URL forms: '#friend/<inviter_id>' (legacy / tokenless fallback)
      //         or '#friend/<inviter_id>/<token>' (sql/041 token path)
      const tail = hash.slice(7);
      const slashIdx = tail.indexOf('/');
      const friendUserId = slashIdx === -1 ? tail : tail.slice(0, slashIdx);
      const inviteToken  = slashIdx === -1 ? null : tail.slice(slashIdx + 1) || null;
      if (friendUserId) {
        window._pendingFriendInvite = friendUserId;
        // Hoist to window so the auth-state-change handler in auth.js can
        // re-invoke this after the welcome card → login round-trip.
        window._tryFriendInvite = async () => {
          if (typeof authCurrentUser !== 'function') return;
          const user = authCurrentUser();
          if (!user) {
            // Anon visitor → show a welcome card naming the sender and
            // prompting login. The friendship gets created on the next
            // _tryFriendInvite tick after auth resumes (auth.js
            // re-invokes the pending invite handler on SIGNED_IN).
            if (typeof _showFriendInviteWelcome === 'function') {
              _showFriendInviteWelcome(friendUserId);
            }
            return;
          }
          if (user.id !== friendUserId) {
            // Look up the sender's profile so the toast can name them.
            let senderName = '';
            try {
              const { data: prof } = await _supabase
                .from('profiles').select('name, email').eq('id', friendUserId).single();
              if (prof) senderName = (prof.name || prof.email || '').split('@')[0];
            } catch (e) { /* ignore — toast falls back to generic copy */ }

            let toastKey = null;
            let writeErr = null;

            // ── Token path (sql/041): instant accept via the consume RPC.
            // The sender minted the token when they copied the link, which
            // is verifiable proof of their consent. RPC bypasses RLS to
            // create the friendship at status='accepted' directly.
            // On token failure (used / expired / invalid) we fall through
            // to the tokenless path so the user still gets *something*
            // (a pending request) rather than a silent dead-end.
            let tokenSucceeded = false;
            if (inviteToken) {
              const { data: tokRes, error: tokErr } = await _supabase
                .rpc('consume_friend_invite_token', { p_token: inviteToken });
              if (tokErr) {
                console.warn('[friend-invite] token consume errored:', tokErr.message);
              } else if (tokRes && tokRes.ok) {
                tokenSucceeded = true;
                toastKey = 'now_friends';
              } else {
                // Token didn't take (used/expired/invalid/self). Log and
                // fall through to the tokenless flow.
                console.info('[friend-invite] token rejected:', tokRes && tokRes.error);
              }
            }

            // ── Tokenless path (sql/036-compatible): used when no token in
            // URL OR when the token RPC failed. Branches on prior row state:
            //   * existing non-accepted → UPDATE to accepted
            //   * existing accepted     → no-op
            //   * no row                → INSERT pending from us → them
            if (!tokenSucceeded) {
              // Check both row directions in one query so we know whether to
              // update-existing or insert-new without racing two writes.
              const { data: existing, error: lookupErr } = await _supabase
                .from('friendships')
                .select('id, status, user_id, friend_id')
                .or(`and(user_id.eq.${friendUserId},friend_id.eq.${user.id}),and(user_id.eq.${user.id},friend_id.eq.${friendUserId})`);
              if (lookupErr) {
                console.warn('[friend-invite] lookup failed:', lookupErr.message, lookupErr);
                window._pendingFriendInvite = null;
                history.replaceState(null, '', location.pathname);
                return;
              }

              if (existing && existing.length > 0) {
                const acceptedRow = existing.find(r => r.status === 'accepted');
                if (acceptedRow) {
                  // Already friends — no write, no toast.
                } else {
                  // Flip the first non-accepted row to accepted. Either we're
                  // accepting their prior pending request, or upgrading our own.
                  const row = existing[0];
                  const { error } = await _supabase
                    .from('friendships').update({ status: 'accepted' }).eq('id', row.id);
                  writeErr = error;
                  if (!error) toastKey = 'now_friends';
                }
              } else {
                // No prior row in either direction. Insert pending from us → them.
                // sql/036 requires status='pending' for recipient-side inserts;
                // the row direction (user_id=me) matches the inviter-side branch
                // of that policy. notify_friend_request will push the sender.
                const { error } = await _supabase.from('friendships').insert({
                  user_id:   user.id,
                  friend_id: friendUserId,
                  status:    'pending',
                });
                writeErr = error;
                if (!error) toastKey = 'request_sent';
              }
            }

            if (writeErr) {
              console.warn('[friend-invite] write failed:', writeErr.message, writeErr);
              window._pendingFriendInvite = null;
              history.replaceState(null, '', location.pathname);
              return;
            }
            if (typeof _dismissFriendInviteWelcomeIfOpen === 'function') {
              _dismissFriendInviteWelcomeIfOpen();
            }
            if (toastKey && typeof _showToast === 'function') {
              if (toastKey === 'now_friends') {
                _showToast(senderName
                  ? t('friend_added_via_link', { name: senderName })
                  : t('friend_added_via_link_generic'));
              } else {
                _showToast(senderName
                  ? t('friend_request_sent_to', { name: senderName })
                  : t('friend_request_sent_generic'));
              }
            }
            if (typeof loadFriends === 'function') loadFriends();
          }
          window._pendingFriendInvite = null;
          history.replaceState(null, '', location.pathname);
        };
        setTimeout(window._tryFriendInvite, 1500);
      }
    }

    // Handle plan/checkin invite link.
    //   Hash form: #invite/<base64data>
    //   Path form: /i/<base64data>           (server-rendered OG preview redirects here)
    let _inviteToken = null;
    if (hash.startsWith('invite/')) {
      _inviteToken = hash.slice(7);
    } else {
      const _pathMatch = window.location.pathname.match(/\/i\/([A-Za-z0-9+/=_-]+)\/?$/);
      if (_pathMatch) _inviteToken = _pathMatch[1];
    }
    // _tryPendingInvite is exposed unconditionally so it can be invoked
    // AFTER an OAuth round-trip — Supabase strips the invite token from the
    // URL when it processes the callback, so on the second page load the
    // `if (_inviteToken)` branch below doesn't run. _restorePreAuthState
    // rehydrates window._pendingInvite from sessionStorage and then this
    // function (already defined) resumes the flow. _tryPendingInvite is
    // also called from auth.js on SIGNED_IN — same code path serves both.
    //
    // The function bails when window._pendingInvite is null (first line),
    // so it's safe to call any time.
    window._tryPendingInvite = async () => {
          const d = window._pendingInvite;
          if (!d) return;
          const user = (typeof authCurrentUser === 'function') ? authCurrentUser() : null;

          // Move app's date/time to the invited moment before opening the preview
          // so the camera intro starts from the right shadow state.
          if (d.t) {
            const dtMatch = String(d.t).match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{1,2})/);
            if (dtMatch && datePicker) {
              datePicker.value = dtMatch[1];
              datePicker.dispatchEvent(new Event('change'));
              if (timeFromEl) {
                const hr = parseInt(dtMatch[2], 10) + parseInt(dtMatch[3], 10) / 60;
                timeFromEl.value = hr;
                timeFromEl.dispatchEvent(new Event('input'));
              }
            }
          }

          // "Here" check-in links: skip the invitation preview, just open the venue.
          if (d.type === 'here') {
            if (d.v && typeof selectVenue === 'function') selectVenue(d.v, true);
            window._pendingInvite = null;
            history.replaceState(null, '', location.pathname);
            return;
          }

          // Inviter profile lookup is best-effort — works without auth (profiles
          // table is publicly readable for the name field).
          let inviterName = null;
          let inviterAvatarUrl = null;
          if (d.u && (!user || d.u !== user.id)) {
            try {
              const { data: prof } = await _supabase
                .from('profiles').select('name, email, avatar_url').eq('id', d.u).single();
              if (prof) {
                inviterName = (prof.name || prof.email || '').split('@')[0];
                inviterAvatarUrl = prof.avatar_url || null;
              }
            } catch (e) { /* ignore — preview still works without name */ }
          }
          // Test-token overrides (preview branch only): d.n hard-codes the
          // inviter name without needing a real profile row, and d.a seeds
          // a fake accepted-attendees count so we can review the attendee
          // row at varying sizes. Both are unused by real share-flow tokens
          // (encodeInviteToken in ui-detail.js doesn't emit them).
          if (d.n) inviterName = String(d.n);
          if (d.a != null) {
            window._testAttendeesCount = Math.max(1, parseInt(d.a, 10) || 1);
            window._testAttendeesNames = Array.isArray(d.names) ? d.names : null;
            // offsets is a per-attendee array of minutes (0 = on-time,
            // 10 = arriving 10 min later, etc.). Lets us preview the
            // discrepancy display on the pin without seeding the DB.
            window._testAttendeesOffsets = Array.isArray(d.offsets) ? d.offsets : null;
          } else {
            window._testAttendeesCount = null;
            window._testAttendeesNames = null;
            window._testAttendeesOffsets = null;
          }
          // Timeline-events override: array of {t, h} pairs that bypass
          // the real sun-windows + weather computation and seed the
          // event row above the accept-page timeline with a known
          // sequence. t ∈ 'shade' | 'sun' | 'cloud' | 'rain'.
          window._testTimelineEvents = Array.isArray(d.events) ? d.events : null;

          // Stash friend-add prompt for the post-Lukk detail panel render
          // (only meaningful when logged in — friendships are user-scoped).
          if (user && d.u && d.u !== user.id) {
            const isAlreadyFriend = (typeof _friends !== 'undefined') &&
              _friends.some(f => String(f.id) === String(d.u));
            const dismissedKey = 'solsteder_dismissed_friend_prompts';
            let dismissed = [];
            try { dismissed = JSON.parse(localStorage.getItem(dismissedKey) || '[]'); } catch {}
            if (!isAlreadyFriend && !dismissed.includes(d.u)) {
              window._pendingFriendPrompt = { inviterId: d.u, inviterName };
            }
          }
          // Test-token affordance: d.fp = 1 forces the friend-add card
          // on the post-accept panel regardless of auth state / friend
          // status / dismiss history. Lets us preview the Phase-A
          // debounce + undo flow without needing two real accounts.
          // Inviter ID is namespaced 'test-' so _commitFriendRequest
          // can skip the actual Supabase upsert (would fail FK anyway).
          if (d.fp) {
            window._pendingFriendPrompt = {
              inviterId:   'test-' + (d.u || 'anon'),
              inviterName: inviterName || d.n || 'Anna',
            };
          }

          // plan_invites upsert only runs when authenticated. Anonymous users
          // see the preview but get the "Logg inn for å svare" CTA; after login,
          // the auth listener resumes this flow and gets the inviteId.
          let inviteId = null;
          if (user && d.p && d.u && d.u !== user.id) {
            try {
              const { data: existing } = await _supabase
                .from('plan_invites').select('id, status')
                .eq('plan_id', d.p).eq('user_id', user.id).maybeSingle();
              if (existing && existing.id) {
                inviteId = existing.id;
              } else {
                const { data: ins } = await _supabase
                  .from('plan_invites')
                  .insert({ plan_id: d.p, user_id: user.id, status: 'pending' })
                  .select('id').single();
                if (ins && ins.id) inviteId = ins.id;
              }
            } catch (e) { /* ignore */ }
          }

          let plannedAt = null;
          if (d.t) {
            const m = String(d.t).match(/^(\d{4}-\d{2}-\d{2})T(\d{1,2}):(\d{1,2})/);
            if (m) {
              // Carry-correct any minute >= 60 (older links minted "11:60"
              // instead of "12:00") and clamp to 00:00–23:59, so a malformed
              // timestamp can't yield an Invalid Date whose toISOString()
              // throws and aborts the whole invite boot (empty-map symptom).
              const total = Math.min(24 * 60 - 1, Math.max(0, (+m[2]) * 60 + (+m[3])));
              const hh = String(Math.floor(total / 60)).padStart(2, '0');
              const mm = String(total % 60).padStart(2, '0');
              const dt = new Date(`${m[1]}T${hh}:${mm}:00`);
              if (!isNaN(dt.getTime())) plannedAt = dt.toISOString();
            }
          }

          // Mode: 'invite' when authenticated (Accept/Decline visible — they
          // gracefully no-op when no real inviteId, e.g. test tokens or the
          // creator clicking their own link). 'invite-anon' when logged-out
          // (Logg inn for å svare CTA). _tryInvite only fires for invite-style
          // URLs so the receiver always sees the invite CTAs, never plain Lukk.
          const mode = user ? 'invite' : 'invite-anon';

          // Stash venueId+plannedAt for post-Lukk selectVenue
          window._pendingPlanPreviewVenueId = d.v;

          if (typeof openPlanPreview === 'function' && d.v) {
            openPlanPreview({
              venueId:    d.v,
              plannedAt,
              inviterName,
              inviterAvatarUrl,
              inviteId,
              inviterId:  d.u,
              planTokenP: d.p,
              mode,
            });
          }

          // Don't clear _pendingInvite when anonymous — the auth listener needs it
          // to resume after login. Clear once authenticated.
          if (user) window._pendingInvite = null;
          history.replaceState(null, '', location.pathname);
        };

    if (_inviteToken) {
      try {
        const data = JSON.parse(atob(_inviteToken));
        window._pendingInvite = data;
        setTimeout(window._tryPendingInvite, 1500);
      } catch (e) { console.warn('[app] Invalid invite link:', e); }
    }

    let vid = null, rawDate = null, rawHour = null;
    if (hash.startsWith('v=')) {
      // Legacy format
      const params = new URLSearchParams(hash);
      vid     = parseInt(params.get('v'), 10);
      rawDate = params.get('d');           // YYYY-MM-DD
      rawHour = params.get('t');
    } else if (hash) {
      // New format: <slug>-<id>/<YYYYMMDD>T<HH>
      const slashIdx = hash.indexOf('/');
      const slugPart = slashIdx >= 0 ? hash.slice(0, slashIdx) : hash;
      const dtPart   = slashIdx >= 0 ? hash.slice(slashIdx + 1) : '';
      const idMatch  = slugPart.match(/-(\d+)$/);
      if (idMatch) vid = parseInt(idMatch[1], 10);
      const dtMatch = dtPart.match(/^(\d{8})T(\d{1,2})$/);
      if (dtMatch) {
        const s = dtMatch[1];
        rawDate = `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
        rawHour = dtMatch[2];
      }
    }
    if (vid !== null) {
      const sharedVenue = VENUES.find(x => x.id === vid);
      if (sharedVenue) {
        _sharedVenueId = vid;
        _introCenter   = [sharedVenue.lng, sharedVenue.lat];
        if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
          _sharedDate      = rawDate;
          datePicker.value = rawDate;
        }
        if (rawHour !== null && isFinite(+rawHour)) {
          _sharedHour = Math.min(23, Math.max(4, parseFloat(rawHour)));
        }
      }
    }

    // Skip intro when landing via an invite link — the plan-preview takeover
    // (queued by _tryInvite at +1500ms) owns the camera, time, and chrome,
    // and the intro's parallel animations were stomping on it.
    const _hasPlanInviteLink = hash.startsWith('invite/')
                            || /\/i\/[A-Za-z0-9+/=_-]+\/?$/.test(window.location.pathname);
    const _hasFriendInviteLink = hash.startsWith('friend/');
    if (_hasPlanInviteLink) {
      // Add the takeover body class immediately so chrome (search bar, qc-wrap,
      // FTS, list panel) stays hidden during the brief wait for auth to settle.
      // The plan-preview's open() will leave it set; close() removes it.
      document.body.classList.add('plan-preview-active');
      // Skip the regular intro flow but KEEP the splash visible. The
      // splash hides later, in openPlanPreview's map.once('idle') handler,
      // so the user doesn't see a slate flash between the splash hide
      // and the plan-preview overlay mount.
      _skipIntro({ keepSplash: true });
      return;
    }
    if (_hasFriendInviteLink) {
      // Friend-invite is a much lighter takeover than plan-invite — no
      // preview overlay to mount, just a toast + a friendship row. Skip
      // the intro animation but let the splash dismiss normally so the
      // app is interactive while the friendship upsert runs in the
      // background. Without this branch the splash stayed forever and
      // the user was stuck looking at it.
      _skipIntro();
      return;
    }

    // Returning visitors skip the intro animation. ?intro=1 forces a replay
    // (clears the flag so the next plain reload re-shows it once). For dev
    // testing, `replayIntro()` from the console clears the flag and reloads.
    window.replayIntro = () => {
      try { localStorage.removeItem('solsteder_intro_seen'); } catch (_) {}
      location.search = location.search ? location.search + '&intro=1' : '?intro=1';
    };
    const _forceIntro = new URLSearchParams(window.location.search).has('intro');
    if (_forceIntro) {
      try { localStorage.removeItem('solsteder_intro_seen'); } catch (_) {}
    } else if (localStorage.getItem('solsteder_intro_seen') === '1') {
      _skipIntro();
      return;
    }

    // Unified boot: returning AND first-time visitors both run _skipIntro.
    // The cinematic _runIntroSequence (zoom 14→16→14, pitch 0→65→15) was
    // the source of the perceived first-load lag — labels and pins had
    // to track that camera motion while classifyPin was still warming
    // its caches. With _skipIntro now positioning the map at the user
    // geolocation BEHIND the splash (worker-wait + map.idle gate), the
    // first frame the user sees is settled and stable. _runIntroSequence
    // is kept for reference but no caller routes to it.
    try { localStorage.setItem('solsteder_intro_seen', '1'); } catch (_) {}
    _skipIntro();
  }
}

function _runIntroSequence() {
  // A plan-preview / post-accept / invite-sheet takeover owns the camera and
  // splash. If one opened before the intro fired — e.g. the user granted
  // geolocation AFTER the dive, which re-runs _introCheckReady() — skip the
  // intro so its zoom-14 jump-to-user-location doesn't clobber the dive.
  // _introRunning is already set by _introCheckReady, so this won't retry.
  if (typeof document !== 'undefined' && (
        document.body.classList.contains('plan-preview-active') ||
        document.body.classList.contains('post-accept-active') ||
        document.body.classList.contains('invite-sheet-open'))) {
    return;
  }
  const seqId  = ++_introSeqId;
  const splash = document.getElementById('splash');
  const canvas = document.getElementById('canvas-overlay');
  const search = document.getElementById('floating-search');
  const brand  = document.getElementById('floating-brand');
  const qcWrap = document.getElementById('qc-wrap');
  const panel  = document.getElementById('panel');

  // Ensure sun table exists for shadow rendering during the intro
  if (!currentSunTable) {
    currentSunTable = buildSunTable(datePicker.value);
    currentDateStr  = datePicker.value;
  }
  const now = currentHour();

  // Time animation: glide from a daytime start to "now" so shadows feel alive
  // through the intro (lightweight — pure scrubbing of an already-built table).
  const introStartTime = (datePicker.value === todayStr() && now > 8) ? Math.max(7, now - 4) : 9;
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  timeFromEl.value = introStartTime;
  update();

  // Phase 0 — instant: map at user location, zoom 14, pitch 0
  map.jumpTo({ center: _introCenter, zoom: 14, pitch: 0, bearing: 0 });

  // Skip handler — any tap during intro snaps to final state
  let skipEnabled = false;
  const skipHandler = () => {
    if (!skipEnabled || _introSeqId !== seqId) return;
    _skipIntro(seqId);
  };
  document.addEventListener('click', skipHandler);
  document.addEventListener('touchstart', skipHandler);

  const elapsed = performance.now() - _splashStart;
  const waitMs  = Math.max(0, SPLASH_MIN_MS - elapsed);
  const loader     = document.getElementById('splash-loader');
  const splashLogo = document.getElementById('splash-logo');

  // Cinematic phase timings (after splash hides). Phase 1 is the long
  // establishing breath — 1700ms is slow enough that the camera reads
  // as one sustained motion instead of a snap. Phase 2 settles in
  // 750ms. Together they restore the "single breath" feel the prior
  // 900+600 ms cut introduced — that abrupt mid-phase velocity drop
  // read as robotic.
  const PHASE1_MS = 1700;  // zoom 14→16, pitch 0→65°
  const PHASE2_MS = 750;   // zoom 16→15.2, pitch 65→15° (default)
  const PHASE3_PAUSE = 280;
  const PHASE3_MS = 420;   // panel peek → expanded

  // After splash min, wait for the worker to deliver precise sun windows,
  // then fire the heavy first paint, then start the fade. Three guards:
  //   1. Wait cap (8s) — caps the worker wait so a slow / failed worker
  //      can't strand the splash; the safety net in render-pins.js at 12s
  //      is the outer backstop.
  //   2. Force renderList before fading — scheduleRenderList is normally
  //      debounced 300ms, so without this it lands DURING the fade and
  //      janks it on slow phones.
  //   3. Double-rAF wait after the heavy paint — ensures the browser
  //      has GPU-flushed the first frame before the splash starts fading,
  //      so the fade itself has full frame budget.
  setTimeout(() => {
    if (_introSeqId !== seqId) return;
    _onBootWorkerReady(() => {
      if (_introSeqId !== seqId) return;
      // Pin canvas paint deliberately DEFERRED to _revealCanvasAndChrome
      // (called at phase 3, when the panel reaches expanded). Holding
      // the boot draw gate closed throughout intro means draw() returns
      // early on every call (no paint cycles → no perf cost, and no
      // partially-painted pins visible during the splash fade or the
      // cinematic zoom). Released once at panel-expand with one deferred
      // draw() catching up.
      // Cancel the pending scheduleRenderList timer (update() armed a
      // 300ms debounce that would otherwise re-paint the list a moment
      // after our force-fire below, stuttering the fade).
      if (_renderListTimer) { clearTimeout(_renderListTimer); _renderListTimer = null; }
      // Force-run the venue list paint now, while the splash is still up.
      // (DOM render — independent of the canvas boot gate.)
      if (typeof renderList === 'function') {
        try { renderList(); } catch (e) { console.warn('[boot] renderList threw', e); }
      }
      // Wait two rAFs so the heavy paint is committed to the GPU before
      // the fade animation steals the main thread. One rAF = layout +
      // paint scheduled; two = previous frame flushed.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (_introSeqId !== seqId) return;
        _startSplashFade();
      }));
    }, 8000);
  }, waitMs);

  // The fade choreography is extracted into a named local so the worker-wait
  // path above can invoke it once the gate releases.
  function _startSplashFade() {
    const loaderVisible = loader?.classList.contains('visible');
    if (loaderVisible) loader.classList.add('fade-out');
    const loaderFadeMs = loaderVisible ? 280 : 0;

    setTimeout(() => {
      if (_introSeqId !== seqId) return;
      splash.classList.add('bg-out');

      // Logo + splash settle
      setTimeout(() => { if (splashLogo) splashLogo.classList.add('fade-out'); }, 250);
      setTimeout(() => { splash.classList.add('done'); }, 700);

      // Begin cinematic camera once the splash is fading
      setTimeout(() => {
        if (_introSeqId !== seqId) return;
        skipEnabled = true;

        // Pin canvas reveal is deferred to _introRevealUI (called at
        // phase 2) so the pins fade in synced to the panel slide-up.
        // Belt-and-braces: explicit inline opacity 0 so any stale
        // computed style or cached SW asset can't leak pins through
        // before the reveal. _introRevealUI sets opacity = '1' once
        // the panel begins to slide, and the transition animates it.
        canvas.style.opacity    = '0';
        canvas.style.transition = 'opacity 0.45s cubic-bezier(0.2, 0.8, 0.3, 1)';

        // Phase 1: zoom in + tilt up (cinematic establishing shot)
        const easing = t => t * t * (3 - 2 * t); // smoothstep
        animateToTime(now, PHASE1_MS + PHASE2_MS);
        map.easeTo({ zoom: 16, pitch: 65, duration: PHASE1_MS, easing });

        // Phase 2 (after Phase 1): settle to default zoom/tilt, panel
        // arrives in PEEK, UI slides/fades in. Bottom padding eased in
        // so the camera lifts the user dot into the upper half BEFORE
        // the panel covers the lower half — without this the dot lands
        // at viewport-centre, the panel hides it during phase 3, and
        // _maybePanMapForPanelState bails because the dot is >100 px
        // below the peek visible-centre threshold. Matches _skipIntro
        // for returning users.
        setTimeout(() => {
          if (_introSeqId !== seqId) return;
          const isMobileEnd = window.innerWidth < 640;
          const phase2Padding = isMobileEnd
            ? { top: 0, bottom: window.innerHeight * 0.5, left: 0, right: 0 }
            : undefined;
          map.easeTo({
            center: _introCenter,
            // Was 15.2 — felt too close after the cinematic; settle at 14
            // so the resting view matches the new default zoom rather
            // than dropping the user into a tighter frame than they'll
            // get on subsequent loads.
            zoom: 14,
            pitch: 15,
            bearing: 0,
            duration: PHASE2_MS,
            easing,
            ...(phase2Padding ? { padding: phase2Padding } : {}),
          });
          _introRevealUI(search, brand, qcWrap, panel);

          // _introRevealUI lands the panel directly in expanded (single
          // slide, no peek pause). Sync FTS / locate-me / zoom-jog
          // positioning to the new state, then reveal pin canvas +
          // locate-me + zoom-jog AFTER the slide settles (panel
          // transition is 0.45s; PANEL_SLIDE_MS gives us a small buffer).
          if (panel && isMobileEnd) _syncFtsPosition();
          const PANEL_SLIDE_MS = 500;
          setTimeout(() => {
            if (_introSeqId !== seqId) return;
            _revealCanvasAndChrome();
            // Final settling — happens shortly after the canvas/chrome
            // reveal so all UI states settle in one beat.
            setTimeout(() => {
              if (_introSeqId !== seqId) return;
              if (_sharedHour === null && !_autoAdvancedAfterSunset) _activateNowMode();
              update();
              document.removeEventListener('click', skipHandler);
              document.removeEventListener('touchstart', skipHandler);
              if (_sharedVenueId) selectVenue(_sharedVenueId, true);
              if (typeof _notifInit === 'function') _notifInit();
              if (typeof pushInit === 'function') pushInit();
              try { localStorage.setItem('solsteder_intro_seen', '1'); } catch (_) {}
            }, 200);
          }, PANEL_SLIDE_MS);
        }, PHASE1_MS);
      }, 220);
    }, loaderFadeMs);
  }
}

/** Reveal the pin canvas, locate-me, and zoom-jog after the venue list
 *  panel has reached its target state (expanded on mobile, slid-in on
 *  desktop). Boot draw gate is released here too — that's the moment
 *  draw() actually paints to the canvas for the first time, so the
 *  pins materialise in step with the opacity fade-in.
 *
 *  Called from:
 *   - Fresh intro: phase 3 (right after panel.classList.add('mobile-expanded'))
 *   - Skip intro: right after the panel-expand setTimeout
 *   - Desktop intro: end of _introRevealUI (panel has no peek/expanded states)
 *
 *  Idempotent — repeat calls are no-ops because intro-hidden is already
 *  removed and opacity is already '1'. */
function _revealCanvasAndChrome() {
  const canvasOverlay = document.getElementById('canvas-overlay');
  const locateBtn     = document.getElementById('locate-btn');
  const zoomJog       = document.getElementById('zoom-jog');
  // Release the gate FIRST so the deferred draw() paints into the canvas
  // BEFORE opacity transitions from 0 → 1. The pins are already painted
  // (invisible) when the fade begins.
  if (typeof _releaseBootDrawGate === 'function') {
    try { _releaseBootDrawGate(); } catch (e) { /* ignore */ }
  }
  if (canvasOverlay) {
    canvasOverlay.classList.remove('intro-hidden');
    canvasOverlay.style.opacity = '1';
  }
  // Fade locate-me + zoom-jog in. They've been held hidden via
  // intro-hidden since boot. Use the same 0.5s opacity easing the rest
  // of the chrome uses so the reveal reads as one unified moment.
  for (const el of [locateBtn, zoomJog]) {
    if (!el || !el.classList.contains('intro-hidden')) continue;
    el.style.transition = 'opacity 0.5s ease';
    requestAnimationFrame(() => {
      el.classList.remove('intro-hidden');
      setTimeout(() => { if (el) el.style.transition = ''; }, 600);
    });
  }
}
window._revealCanvasAndChrome = _revealCanvasAndChrome;

// Run cb once the Mapbox map has gone "render-quiet" (no 'render' events for
// ~300 ms) — i.e. it has finished painting all tiles for the current view.
// Used to hold the chrome slide-in until the map is fully rendered, since the
// slide animation otherwise starves the map's tile render (it only completes
// after the slide ends). Falls back to a cap so a never-quiet map can't strand.
function _afterMapQuiet(cb, capMs = 2500) {
  if (typeof map === 'undefined' || !map || typeof map.on !== 'function') { cb(); return; }
  let last = performance.now();
  let done = false;
  const onRender = () => { last = performance.now(); };
  const finish = () => {
    if (done) return; done = true;
    try { map.off('render', onRender); } catch (e) {}
    cb();
  };
  try { map.on('render', onRender); } catch (e) {}
  const tick = () => {
    if (done) return;
    if (performance.now() - last > 300) finish();
    else setTimeout(tick, 80);
  };
  // Force a full-viewport render cycle, then wait for it to settle — so quiet
  // means "the WHOLE map is painted", not "the map isn't currently drawing".
  try { if (map.resize) map.resize(); } catch (e) {}
  try { if (map.triggerRepaint) map.triggerRepaint(); } catch (e) {}
  setTimeout(tick, 120);
  setTimeout(finish, capMs);
}

// ── Shades Loader (splash) ────────────────────────────────────────────────
// The 4-phase brand launch animation that doubles as the boot loading state
// (js/shades-loader.js; design-of-record in design/shades-loader/). Mounts
// into #splash-loader and paints the static-logo first frame synchronously on
// construction. Idempotent — repeat calls return the existing instance, so
// the cold-start and invite paths share one loader.
let _shadesLoader = null;
let _nativeSplashHidden = false;
// Resolves once the native splash is FULLY hidden. The loader's Phase 1 (intro)
// waits on this so it doesn't begin behind a still-fading native cover — that
// made the intro look like it "started mid-Phase-1". On web (no Capacitor) it
// resolves immediately so the animation starts without delay.
let _nativeSplashGoneResolve;
const _nativeSplashGone = new Promise(res => { _nativeSplashGoneResolve = res; });
const _isNativePlatform = !!(typeof window !== 'undefined' && window.Capacitor
  && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
if (!_isNativePlatform) _nativeSplashGoneResolve();
// Hand off from the native Capacitor SplashScreen — which covers the WKWebView
// through launch AND any stale prior-session snapshot (the "login flash") until
// the web splash is painted — to the web splash. No-op on web (no Capacitor).
function _hideNativeSplash() {
  if (_nativeSplashHidden) return;
  _nativeSplashHidden = true;
  const ss = window.Capacitor?.Plugins?.SplashScreen;
  if (ss?.hide) {
    try {
      // Instant hide (no fade): the web static frame is pixel-aligned with the
      // native splash, so there's nothing to cross-fade — a fade only delayed
      // Phase 1 (perceived handoff lag).
      ss.hide({ fadeOutDuration: 0 }).catch(() => {});
    } catch (e) { /* fall through to the timed resolve below */ }
    // Do NOT resolve on the hide() promise: on Android the system splash
    // (Theme.SplashScreen) runs its OWN exit animation AFTER hide() resolves,
    // so starting Phase 1 then plays the static→yellow rise behind the still-
    // exiting cover — only its snap-to-yellow tail shows ("Phase 1 skipped").
    // Wait a fixed buffer that clears the native exit so Phase 1 is seen from
    // frame one. The web static frame is pixel-aligned with the native splash,
    // so the buffer shows no seam (just the held static mark).
    const _plat = window.Capacitor?.getPlatform?.();
    const _exitBuf = _plat === 'android' ? 340 : 140;
    setTimeout(() => _nativeSplashGoneResolve(), _exitBuf);
  } else {
    _nativeSplashGoneResolve();
  }
}
window._hideNativeSplash = _hideNativeSplash;
function _mountShadesLoader() {
  if (_shadesLoader) return _shadesLoader;
  const host = document.getElementById('splash-loader');
  if (!host || typeof window.createShadesLoader !== 'function') {
    _hideNativeSplash();   // still reveal the web splash if the loader is absent
    return null;
  }
  try {
    _shadesLoader = window.createShadesLoader(host, {
      variant: 'light',
      showWordmark: true,    // hidden through intro+loop; fades in on resolve
      minLoadingCycles: 1,   // always show ≥1 blinds cycle, even on instant loads
    });
  } catch (e) {
    console.warn('[boot] shades loader mount failed', e);
    _shadesLoader = null;
  }
  // Hand off from the native splash only once BOTH: (a) the web frame is
  // painted (this mount ran → a rAF confirms paint), and (b) iOS's app-open
  // dim has lifted so the native splash is at FULL brightness. Handing off
  // during the dim makes the switch from a dimmed native splash to the
  // full-brightness web frame read as a jarring flash; handing off before
  // first paint shows a black gap. Waiting out the dim from boot gives a
  // full→full, painted handoff. The native launch screen simply shows for the
  // normal app-open beat — no post-handoff static hold (Phase 1 fires right
  // after via _nativeSplashGone).
  const _DIM_CLEAR_MS = 480;  // ≈ iOS app-open animation; native is full-brightness past this
  const _waitDim = Math.max(0, _DIM_CLEAR_MS - (performance.now() - _splashStart));
  setTimeout(() => requestAnimationFrame(() => _hideNativeSplash()), _waitDim);
  return _shadesLoader;
}
window._mountShadesLoader = _mountShadesLoader;

function _introRevealUI(search, brand, qcWrap, panel, opts) {
  const locateBtn   = document.getElementById('locate-btn');
  const zoomJog     = document.getElementById('zoom-jog');
  const isMobile    = window.innerWidth < 640;
  const topStrip    = document.getElementById('top-strip');

  // Mobile: search bar slides down from above (paired with panel sliding
  // up). Desktop reveal is fully horizontal — chrome enters from the
  // side it lives on, not from the top edge.
  if (search && isMobile) {
    search.style.transition = 'none';
    search.style.opacity = '1';
    search.style.transform = 'translateY(-72px)';
    search.classList.remove('intro-hidden');
    search.getBoundingClientRect();
    search.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.4s ease';
    search.style.transform = '';
    setTimeout(() => { if (search) search.style.transition = ''; }, 500);
  } else if (search) {
    search.classList.remove('intro-hidden');
  }

  // Top-strip + venue-list panel + brand all slide in together. On
  // desktop the strip + panel come from the LEFT (the column they live
  // in) and the brand from the RIGHT (the top-right card). On mobile
  // the strip drops from above, the panel rises from below — keep the
  // legacy direction for touch.
  const _slideIn = (el, startTransform) => {
    if (!el) return;
    el.style.transition = 'none';
    el.style.opacity = '1';
    el.style.transform = startTransform;
    el.classList.remove('intro-hidden');
    el.getBoundingClientRect();
    el.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.4s ease';
    el.style.transform = '';
    setTimeout(() => { if (el) el.style.transition = ''; }, 500);
  };

  if (!isMobile) {
    // Desktop: top-strip + panel rise from the left edge in lock-step;
    // brand rises from the right. locate-btn + zoom-jog are HELD until
    // _revealCanvasAndChrome fires (alongside the pin canvas) so they
    // appear together with the pins, not before. The 110% slide distance
    // guarantees the element is fully off-screen at the start regardless
    // of where its anchored left/right offset puts it.
    _slideIn(topStrip,  'translateX(calc(-100% - 32px))');
    _slideIn(panel,     'translateX(calc(-100% - 32px))');
    // Brand is a bottom-left floating map label now (not the old top-right card)
    // — fade it in rather than slide from the right.
    if (brand) {
      brand.style.transition = 'opacity 0.5s ease';
      requestAnimationFrame(() => {
        brand.classList.remove('intro-hidden');
        setTimeout(() => { if (brand) brand.style.transition = ''; }, 600);
      });
    }
    // qc-wrap is the toast strip — fade rather than slide so a queued
    // toast on app-start doesn't appear mid-flight.
    if (qcWrap) {
      qcWrap.style.transition = 'opacity 0.5s ease';
      requestAnimationFrame(() => {
        qcWrap.classList.remove('intro-hidden');
        setTimeout(() => { qcWrap.style.transition = ''; }, 600);
      });
    }
  } else {
    // Mobile: top-strip slides down (matches the legacy search-bar
    // behavior), brand + chrome fade. The top-strip reveal is DEFERRED
    // 600 ms so it arrives alongside the panel reaching its expanded
    // state — landing it WITH the rest of the post-expand chrome (pins,
    // locate-me, zoom-jog) instead of dropping during the panel slide.
    // User feedback: "we're just missing the top bar" — the only piece
    // still revealing on the early panel-slide moment.
    if (topStrip) {
      // Slide DOWN via `top` (a layout property), NOT transform. iOS WKWebView
      // drops backdrop-filter on a transformed element, so a translateY slide
      // made the bar flash borderless/flat and "pop" to glass at the end. The
      // panel slides the same way (bottom/height) for exactly this reason.
      // Start fully above the top edge, then clear inline `top` so the CSS
      // resting value (max(env...)) becomes the transition target. Synced with
      // the panel slide so list + top bar reach their final positions as one.
      topStrip.style.transition = 'none';
      topStrip.style.opacity = '1';
      topStrip.style.top = '-72px';
      topStrip.classList.remove('intro-hidden');
      topStrip.getBoundingClientRect();
      topStrip.style.transition = 'top 0.45s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.4s ease';
      topStrip.style.top = '';   // clear inline → CSS resting top animates in
      setTimeout(() => { if (topStrip) topStrip.style.transition = ''; }, 500);
    }
    // brand + qc-wrap reveal with the rest of the chrome. locate-btn and
    // zoom-jog are intentionally HELD until the panel reaches expanded
    // state — they're revealed alongside the pin canvas in
    // _revealCanvasAndChrome (called from phase 3 / panel-expand step).
    [brand, qcWrap].forEach(el => {
      if (!el) return;
      el.style.transition = 'opacity 0.5s ease';
      requestAnimationFrame(() => {
        el.classList.remove('intro-hidden');
        setTimeout(() => { el.style.transition = ''; }, 600);
      });
    });
  }

  if (panel && isMobile) {
    // Slide up directly from off-screen → user's preferred state (default
    // EXPANDED). The old two-stage (peek → pause → expanded) sequence
    // read as a hesitation; a single unified slide is cleaner. Reading
    // the saved snap UPFRONT (instead of restoring after a 700 ms
    // setTimeout) avoids the post-intro yo-yo where the panel landed
    // at expanded then slid back to a saved peek.
    let _savedSnap = 'expanded';
    try {
      const s = localStorage.getItem('solsteder.sheetSnap');
      // Never restore to fullscreen — landing on a map-covering panel at load
      // is jarring (and this path bypasses _applyState's top-bar handling).
      // Clamp to expanded.
      if (s === 'peek' || s === 'expanded') _savedSnap = s;
    } catch {}

    panel.style.transition = 'none';
    panel.style.opacity    = '1';
    panel.style.bottom     = `-${Math.round(window.innerHeight)}px`;
    panel.classList.remove('intro-hidden');
    // Apply the saved state's classes BEFORE clearing inline bottom so
    // the CSS rule's bottom is the slide target.
    panel.classList.remove('mobile-expanded', 'mobile-fullscreen', 'mobile-hidden');
    if (_savedSnap === 'fullscreen') {
      panel.classList.add('mobile-expanded', 'mobile-fullscreen');
    } else if (_savedSnap === 'expanded') {
      panel.classList.add('mobile-expanded');
    }
    // (peek leaves all state classes off — that's the base #panel rule.)
    _prevPanelMobileState = _savedSnap;
    _updatePeekHeight();
    panel.getBoundingClientRect();
    panel.style.transition = 'bottom 0.45s cubic-bezier(0.2, 0.8, 0.3, 1), height 0.45s cubic-bezier(0.2, 0.8, 0.3, 1)';
    panel.style.bottom     = '';  // clear inline → CSS saved-state bottom takes over

    // Canvas reveal moved to _revealCanvasAndChrome (fires at phase 3 /
    // panel-expand). User wanted pins + locate-me + zoom-jog all to fade
    // in AFTER the venue list has expanded, not when it first slides
    // into peek. Boot draw gate is also released there so no paint
    // happens during intro.
  }

  if (USE_FLOATING_TIME_SLIDER && !(opts && opts.skipFts)) {
    const ftsEl = document.getElementById('fts');
    if (ftsEl) {
      ftsEl.style.transition = 'opacity 0.5s ease';
      requestAnimationFrame(() => {
        ftsEl.classList.remove('intro-hidden');
        setTimeout(() => { ftsEl.style.transition = ''; }, 600);
      });
    }
    requestAnimationFrame(() => syncFts());
  }

  // Desktop: no peek/expanded distinction, so the canvas + locate +
  // zoom reveal can't piggy-back on the panel-expand moment that mobile
  // uses. Fire it here at the end of the desktop reveal so the pins
  // appear together with the chrome slide-in. (Idempotent — the mobile
  // path's later _revealCanvasAndChrome call is a no-op once everything
  // is already revealed.)
  if (!isMobile) {
    _revealCanvasAndChrome();
  }
}

/** Short cinematic for returning visitors. Phases:
 *    0 (instant):  map at user location CENTERED (no padding), default
 *                  tilt (15°), zoom 14.5, all UI hidden, splash gone.
 *    1 (800ms):    zoom 14.5 → 15.2 (cubic ease-out, geo stays centered).
 *                  Pins fade in concurrently.
 *    2 (~300ms):   UI slides in — search from top, panel up to PEEK.
 *    3 (~900ms):   panel peek → expanded. Map ALSO eases with bottom
 *                  padding so the geo dot floats up into the visible
 *                  map area above the panel.
 *
 *  All sub-animations use the same cubic ease-out for cinematic flow. */
function _skipIntro(seqId, opts) {
  // Argument shape: _skipIntro() | _skipIntro(seqId) | _skipIntro(opts)
  // (legacy callers pass only seqId; new caller from the invite path
  // passes opts.)
  if (seqId && typeof seqId === 'object' && opts === undefined) {
    opts = seqId; seqId = undefined;
  }
  if (seqId !== undefined && _introSeqId !== seqId) return;
  const localSeq = ++_introSeqId;

  // Absolute splash kill-switch: defensive backstop that ALWAYS dismisses
  // the splash after 12s no matter what. The boot flow has multiple
  // shorter timeouts (worker-wait cap 8s, map.idle cap 2.5s) but if any
  // of the surrounding code throws unexpectedly, those nested timeouts
  // may never register. This outer setTimeout doesn't depend on
  // anything else — it grabs the splash element directly and force-hides.
  setTimeout(() => {
    const sp = document.getElementById('splash');
    if (!sp) return;
    if (sp.classList.contains('done')) return;
    console.warn('[boot] splash hard-dismissed by 12s safety timeout');
    sp.style.transition = 'none';
    sp.classList.add('bg-out', 'done');
    const sl = document.getElementById('splash-logo');
    if (sl) { sl.style.transition = 'none'; sl.classList.add('fade-out'); }
    const ldr = document.getElementById('splash-loader');
    if (ldr) { ldr.style.transition = 'none'; ldr.classList.add('fade-out'); }
    // Backstop reveal: release the gate AND make canvas + chrome visible.
    // Normal intro paths call _revealCanvasAndChrome at panel-expand; if
    // those never fire (intro stalled, this 12s kill-switch fires), the
    // backstop must surface the pins + locate-me + zoom-jog too so the
    // user isn't left looking at an empty map.
    if (typeof window._revealCanvasAndChrome === 'function') {
      try { window._revealCanvasAndChrome(); } catch (e) {}
    } else if (typeof window._releaseBootDrawGate === 'function') {
      try { window._releaseBootDrawGate(); } catch (e) {}
    }
    // Stop a stalled loader from animating behind the now-hidden splash.
    try { _shadesLoader?.destroy(); _shadesLoader = null; } catch (e) {}
    _hideNativeSplash();
  }, 12000);

  const splash = document.getElementById('splash');
  const canvas = document.getElementById('canvas-overlay');
  const search = document.getElementById('floating-search');
  const brand  = document.getElementById('floating-brand');
  const qcWrap = document.getElementById('qc-wrap');
  const panel  = document.getElementById('panel');
  const splashLogo = document.getElementById('splash-logo');
  const loader = document.getElementById('splash-loader');
  const isMobileSkip = window.innerWidth < 640;

  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }

  if (_sharedHour !== null) {
    timeFromEl.value = _sharedHour;
  } else if (datePicker.value === todayStr()) {
    timeFromEl.value = Math.min(23, Math.max(4, currentHour()));
    _activateNowMode();
  }
  update();

  // Position the map at user geolocation BEFORE the splash hides, with
  // padding equivalent to the expanded panel's bottom 50% — so the user
  // dot lands at the upper-half visual centre. When the panel transitions
  // peek → expanded a beat later, _maybePanMapForPanelState sees the dot
  // is already at the new visible centre and skips its pan: the panel
  // slides up over a static map instead of dragging the camera with it.
  //
  // User spec: "load centered in the geolocation and then the UI elements
  // slide in" + "center the map in the position where the geolocation is
  // going to be once the venue list has expanded before it actually
  // expands". No easeTo dive — the map is at its final state from frame
  // one of the visible app.
  map.stop();
  // Pre-position with padding for the expanded panel state. Splitting the
  // padding into setPadding (instead of inline in jumpTo) is the safer
  // path — some Mapbox builds quietly accept padding in jumpTo while
  // others don't, and a silent rejection would leave the user dot at
  // the default visual centre.
  try {
    const _expandedPanelH = window.innerHeight * 0.5;
    if (typeof map.setPadding === 'function') {
      map.setPadding({ top: 0, bottom: _expandedPanelH, left: 0, right: 0 });
    }
  } catch (e) { console.warn('[boot] setPadding failed', e); }
  map.jumpTo({ center: _introCenter, zoom: 14, pitch: 15, bearing: 0 });
  // Force the map to size to the full container and render its WHOLE viewport
  // NOW, during the loading phase — otherwise it renders top-first and only
  // completes the lower portion when the panel slide later triggers a resize,
  // so the reveal shows a half-painted map. Doing it here (behind the splash,
  // with the loop covering) lets the map finish before the chrome slides in.
  try { if (map.resize) map.resize(); } catch (e) {}

  // Hide splash — unless opts.keepSplash is set (plan-invite path,
  // which lets openPlanPreview's map.once('idle') handler dismiss the
  // splash so there's no slate flash between hide and overlay mount).
  //
  // Two sub-paths inside the !keepSplash branch:
  //   1. Fresh boot (gate still closed): wait for the worker to deliver
  //      precise sun windows, fire the heavy first paint + renderList
  //      synchronously, then hide the splash. Same hold-then-paint
  //      pattern as _runIntroSequence — returning users hit this path
  //      since they bypass the intro, and on slow phones the immediate
  //      hide previously left the camera-dive janking against an
  //      uncomputed pin canvas. The 8s cap matches _runIntroSequence.
  //   2. Mid-session call (gate already open): splash is mid-fade or
  //      already gone from an earlier boot path; hide instantly.
  const _hideSplashInstantly = () => {
    splash.style.transition = 'none';
    splash.classList.add('bg-out', 'done');
    if (splashLogo) { splashLogo.style.transition = 'none'; splashLogo.classList.add('fade-out'); }
    if (loader)     { loader.style.transition = 'none'; loader.classList.add('fade-out'); }
  };

  // The post-splash choreography. NO camera motion: map is already at
  // its final state (zoom 14, centered on user geolocation, padded for
  // expanded panel) from the jumpTo above. The boot gate held the splash
  // through worker-ready + map.idle so tiles are loaded too. All this
  // function does is reveal the canvas and slide the UI in over a
  // static map. Panel goes peek → expanded WITHOUT a map pan because
  // the user dot is already at the expanded-state visual centre.
  const _runSkipChoreography = () => {
    if (_introSeqId !== localSeq) return;
    if (canvas) {
      // Pre-arm the opacity tween + force inline opacity 0 (belt-and-
      // braces against stale styles / SW-cached assets). _introRevealUI
      // sets opacity = '1' in lock-step with the panel slide.
      canvas.style.opacity    = '0';
      canvas.style.transition = 'opacity 0.55s cubic-bezier(0.2, 0.8, 0.3, 1)';
    }
    // List shows SKELETONS, held so concurrent renders can't clobber them.
    const _vlist = document.getElementById('venue-list');
    if (_vlist && typeof renderSkeletonCards === 'function') {
      window._revealSkeletonHold = true;
      renderSkeletonCards(_vlist, 7);
    }
    // Let the map FINISH rendering BEFORE sliding the chrome in — the slide
    // animation starves Mapbox's tile render, so sliding first leaves the map
    // half-painted (it only completes once the slide ends). Wait for the map to
    // go render-quiet, then slide over a fully-painted map.
    // Reveal order (ALL platforms): rendered map → pins → UI slide-in.
    // The map finishes painting (above), THEN the pins fade in over it, THEN
    // the chrome + venue panel slide in over the already-populated map.
    // (Previously the chrome slid in first and pins appeared 550 ms later —
    // reversed per product direction so the map's content reads before the
    // UI arrives.) The list is swapped skeleton → real BEFORE the slide, while
    // the panel is still off-screen, so it slides in showing real cards.
    const _PIN_BEAT_MS = 450;  // pins visibly settle before the UI slides
    _afterMapQuiet(() => {
      if (_introSeqId !== localSeq) return;
      // 1) Pins (+ locate-me / zoom-jog) fade in over the fully-rendered map.
      _revealCanvasAndChrome();
      // 2) Swap skeletons → real cards now, while the panel is still hidden,
      //    so it slides in already populated (no skeleton flash).
      window._revealSkeletonHold = false;
      if (_vlist) delete _vlist.dataset.mounted;
      if (typeof renderList === 'function') { try { renderList(); } catch (e) {} }
      // 3) Then the chrome + panel (with real cards) slide in.
      setTimeout(() => {
        if (_introSeqId !== localSeq) return;
        _introRevealUI(search, brand, qcWrap, panel);
        if (panel && isMobileSkip) _syncFtsPosition();
      }, _PIN_BEAT_MS);
      // Wrap-up (after the UI has slid in).
      setTimeout(() => {
        if (_introSeqId !== localSeq) return;
        if (_sharedVenueId) selectVenue(_sharedVenueId, true);
        if (typeof _notifInit === 'function') _notifInit();
        if (typeof pushInit === 'function') pushInit();
      }, _PIN_BEAT_MS + 1050);
    });
    setTimeout(() => { window._revealSkeletonHold = false; }, 5000);  // backstop release
    if (document.documentElement.classList.contains('invite-loading')) {
      setTimeout(() => {
        document.documentElement.classList.remove('invite-loading');
      }, 1500);
    }
  };

  // Hide splash + run choreography. Two sub-paths inside !keepSplash:
  //   1. Fresh boot (gate still closed): wait for the worker so the heavy
  //      first paint + renderList land behind the splash, then hide and
  //      run the dive. Same hold-then-paint pattern as _runIntroSequence —
  //      returning users + OAuth returns hit this path.
  //   2. Mid-session (gate already open): hide instantly and dive now.
  // keepSplash path: openPlanPreview's idle handler dismisses the splash
  // AND releases the gate — the skip-intro choreography is replaced by
  // the plan-preview overlay so we don't run our own dive on that path.
  //
  // Shades Loader wiring (cold-start). The loader owns the splash visual:
  // intro → blinds loop (during the worker + tile wait) → resolve → Phase 4
  // crossfade. Two flags map onto the existing readiness gates; onComplete
  // runs the chrome slide-in. If the loader is unavailable (script failed to
  // load), `loader` is null and every path falls back to the instant hide.
  let _loaderLoaded   = false;  // worker delivered + venue list painted
  let _loaderMapReady = false;  // tiles idle (or the 2.5 s cap fired)
  let _loaderBgFaded  = false;
  const shadesLoader = (!opts?.keepSplash) ? _mountShadesLoader() : null;
  // Per-session gate. The full launch animation plays on the first cold boot
  // of a browser session (and on ?intro=1); later reloads in the same session
  // get a quick static-logo → crossfade, escalating to the blinds loop only if
  // loading is slow (>1.5 s). sessionStorage clears on a fresh app-open / new
  // tab, so each launch shows the full animation exactly once.
  let _splashFull = true;
  if (!opts?.keepSplash) {
    try {
      const _shown  = sessionStorage.getItem('solsteder_splash_shown') === '1';
      const _forced = new URLSearchParams(location.search).has('intro');
      _splashFull = _forced || !_shown;
      sessionStorage.setItem('solsteder_splash_shown', '1');
    } catch (e) { _splashFull = true; }
  }
  const _loaderOnComplete = () => {
    if (_introSeqId !== localSeq) return;
    splash.classList.add('done');
    _runSkipChoreography();
  };
  const _runFullLoader = () => {
    // Hold the (pixel-aligned) static frame until the native splash is fully
    // gone, THEN start the intro — so Phase 1 is seen from frame one, not
    // mid-rise behind a fading native cover.
    _nativeSplashGone.then(() => {
      if (_introSeqId !== localSeq || !shadesLoader) return;
      shadesLoader.start({
        isLoaded:   () => _loaderLoaded,
        isMapReady: () => {
          // Polled only after Phase 3 resolves, so adding bg-out here syncs the
          // cream backdrop fade to the Phase 4 SVG crossfade.
          if (_loaderMapReady && !_loaderBgFaded) {
            _loaderBgFaded = true;
            splash.classList.add('bg-out');
          }
          return _loaderMapReady;
        },
        onComplete: _loaderOnComplete,
      });
    });
  };
  if (!opts?.keepSplash) {
    const gateAlreadyOpen = typeof window._isBootDrawGateOpen === 'function'
      && window._isBootDrawGateOpen();
    if (gateAlreadyOpen) {
      _hideSplashInstantly();
      _runSkipChoreography();
    } else {
      // Drive the loader by gate mode. FULL: start the sequence now so the
      // blinds loop runs during the wait. GATED: hold the static logo,
      // escalating to the full loop only if loading is slow (>1.5 s) — a fast
      // gated load gets a quick crossfade in _dismissOnce.
      let _gatedCommitted = false;
      let _gatedSlowTimer = null;
      if (shadesLoader) {
        if (_splashFull) {
          _runFullLoader();
        } else {
          _gatedSlowTimer = setTimeout(() => {
            if (_gatedCommitted) return;
            _gatedCommitted = true;
            _runFullLoader();   // slow gated load → show the blinds for feedback
          }, 1500);
        }
      }
      // Dynamic hold: don't dismiss the splash until the worker has
      // delivered AND the map has reached idle (tiles loaded for the
      // current viewport). This is the "hold until performance is
      // genuinely ready" pattern — the user sees a still splash for
      // however long the device needs, then everything is smooth from
      // the moment the splash hides.
      _onBootWorkerReady(() => {
        if (_introSeqId !== localSeq) return;
        // Pin canvas paint deferred to _revealCanvasAndChrome (called at
        // panel-expand inside _runSkipChoreography). Boot draw gate stays
        // closed through the splash hide so no canvas paint happens until
        // the panel is reaching its target state.
        // Cancel the pending scheduleRenderList timer (the earlier
        // update() inside _skipIntro armed a 300ms debounce that would
        // otherwise re-paint the list a moment after our force-fire).
        if (_renderListTimer) { clearTimeout(_renderListTimer); _renderListTimer = null; }
        if (typeof renderList === 'function') {
          try { renderList(); } catch (e) { console.warn('[boot] renderList threw', e); }
        }
        // Worker delivered + list painted → let the loader resolve (Phase 3)
        // at its next yellow extreme. No-op if the loader isn't running.
        _loaderLoaded = true;
        // Wait for map.idle (tiles loaded for current view) before
        // dismissing. Cap at 2.5s so a slow / failed tile fetch can't
        // strand the splash. Whichever fires first dismisses.
        let _dismissed = false;
        const _dismissOnce = () => {
          if (_dismissed) return;
          _dismissed = true;
          if (_introSeqId !== localSeq) return;
          if (shadesLoader) {
            if (_splashFull || _gatedCommitted) {
              // Full loader running (or escalated to on a slow load) → flag
              // map-ready so its Phase 4 crossfades (Phase 3 resolve first if
              // still pending), then onComplete runs the chrome slide-in.
              _loaderMapReady = true;
            } else {
              // GATED + fast: skip intro/loop/resolve — quick crossfade only.
              _gatedCommitted = true;
              if (_gatedSlowTimer) clearTimeout(_gatedSlowTimer);
              _loaderBgFaded = true;
              splash.classList.add('bg-out');
              shadesLoader.playPhase4(_loaderOnComplete);
            }
          } else {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (_introSeqId !== localSeq) return;
              _hideSplashInstantly();
              _runSkipChoreography();
            }));
          }
        };
        if (typeof map !== 'undefined' && map && typeof map.once === 'function') {
          // Wait for a genuine post-render 'idle' — the only signal that fires
          // AFTER tiles are actually painted. map.loaded() and areTilesLoaded()
          // both report true while tiles are still rendering, which revealed a
          // blank map (#5). triggerRepaint forces a render→idle cycle so 'idle'
          // still fires if the map settled before we subscribed; the loader
          // keeps looping until it lands. 6 s cap; 12 s kill-switch backstops.
          // The map engine pauses rendering/loading tiles for the fully-occluded
          // canvas, then develops them only as the cover lifts — which reveals a
          // half-painted map (#5). Actively KICK it with triggerRepaint until all
          // tiles for the view are loaded, then a settle, so it's fully developed
          // BEFORE the crossfade. 6 s cap; 12 s kill-switch backstops.
          let _stable = 0;
          const _kick = () => {
            if (_dismissed) return;
            const tilesUp = (typeof map.areTilesLoaded !== 'function') || map.areTilesLoaded();
            if (tilesUp) {
              _stable++;
              if (_stable >= 3) { setTimeout(_dismissOnce, 250); return; }  // loaded & stable
            } else {
              _stable = 0;
            }
            try { if (map.triggerRepaint) map.triggerRepaint(); } catch (e) {}
            setTimeout(_kick, 100);
          };
          _kick();
          setTimeout(_dismissOnce, 6000);
        } else {
          _dismissOnce();
        }
      }, 8000);
    }
  }
  // keepSplash: plan-invite takeover owns the dive; we run nothing here.
}

// ── Back-button / popstate handler ───────────────────────────────────────────
// Fires on browser back button or mobile back gesture.
// Pops the top layer; if it's a dead entry (already closed via UI), silently
// consumes it. Otherwise closes the layer.
window.addEventListener('popstate', () => {
  if (_navStack.length === 0) return; // nothing we own

  const layer = _navStack[_navStack.length - 1];

  if (!_navIsLayerOpen(layer)) {
    // Dead entry: layer was already closed via in-app UI. Consume silently.
    _navStack.pop();
    return;
  }

  _navStack.pop();
  _navHandlingPop = true;

  switch (layer) {
    case 'venue':         closeDetailPanel(true); break;
    case 'dp-fullscreen': document.getElementById('detail-panel')?.classList.remove('dp-fullscreen'); _syncFtsPosition(); break;
    case 'qc':            _closeQcPanel(); break;
    case 'sort':          _closeSortPanel(); break;
    case 'filter':        _closeFilterPanel(); break;
    case 'profile':       closeProfilePanel(); break;
    case 'friends':       if (typeof closeFriendsModal === 'function') closeFriendsModal(); break;
    case 'edit':          exitEditMode(); break;
  }

  _navHandlingPop = false;
});
