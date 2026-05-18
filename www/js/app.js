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
let filterMapViewActive = true;
let activeArea    = '';
let activeSortBy  = 'score';
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
let _qcArcDragging    = false;
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

/** Update FTS position — mobile: --fts-bottom var; desktop: left edge. */
function _syncFtsPosition() {
  if (!USE_FLOATING_TIME_SLIDER) return;
  const ftsEl = document.getElementById('fts');
  const panel = document.getElementById('panel');
  const dp    = document.getElementById('detail-panel');
  if (!panel) return;

  // ── Desktop: adjust left edge to clear list + detail panels ──────────
  if (!isMobile()) {
    if (!ftsEl) return;
    const dpOpen = dp?.classList.contains('open');
    if (panelVisible) {
      // 16 (margin) + 336 (panel) + 16 (gap) = 368; + 300 (detail) + 16 (gap) = 684
      ftsEl.style.left = dpOpen ? '684px' : '368px';
    } else {
      // Panel hidden: 16 margin; + 300 (detail) + 16 (gap) = 332
      ftsEl.style.left = dpOpen ? '332px' : '16px';
    }
    return;
  }

  // ── Mobile: track panel top edge via --fts-bottom ────────────────────
  // Clear any desktop-set inline left so CSS mobile rules apply
  if (ftsEl) ftsEl.style.left = '';
  const dpOpen = dp?.classList.contains('open');
  const dpFull = dp?.classList.contains('dp-fullscreen');
  if (dpOpen) {
    if (dpFull) {
      if (ftsEl) { ftsEl.style.opacity = '0'; ftsEl.style.pointerEvents = 'none'; }
      return;
    }
    if (ftsEl) { ftsEl.style.opacity = ''; ftsEl.style.pointerEvents = ''; }
    document.body.style.setProperty('--fts-bottom', `calc(62svh + ${FTS_GAP}px)`);
    return;
  }

  if (ftsEl) { ftsEl.style.opacity = ''; ftsEl.style.pointerEvents = ''; }

  const isHidden   = panel.classList.contains('mobile-hidden');
  const isExpanded = panel.classList.contains('mobile-expanded');
  const isFull     = panel.classList.contains('mobile-fullscreen');
  let bottom;
  if (isHidden) {
    bottom = `${FTS_GAP}px`;
  } else if (isFull) {
    bottom = `calc(100svh - env(safe-area-inset-top, 0px) - 46px - 16px - 4px - 14px)`;
  } else if (isExpanded) {
    bottom = `calc(62svh + ${FTS_GAP}px)`;
  } else {
    const peekH = panel.style.getPropertyValue('--peek-h') || '160px';
    bottom = `calc(${peekH} + ${FTS_GAP}px)`;
  }
  document.body.style.setProperty('--fts-bottom', bottom);
}

// Norwegian day/month abbreviations for FTS date button
const _ftsDays   = ['søn','man','tir','ons','tor','fre','lør'];
const _ftsMonths = ['jan','feb','mar','apr','mai','jun','jul','aug','sep','okt','nov','des'];

/** Initialise the floating time slider: bind events, draw canvas, show appstart popup. */
function initFts() {
  const canvas = document.getElementById('fts-canvas');
  const track  = document.getElementById('fts-track');
  if (!canvas || !track) return;

  _syncFtsPosition();
  updateFtsDateBtn();
  drawFtsCanvas();

  // Wire calendar button tap directly (onclick can be unreliable on mobile in some edge cases)
  const calBtn = document.getElementById('fts-date-btn');
  if (calBtn) {
    calBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQcPanel('date');
    });
    // Remove the inline onclick to avoid double-fire
    calBtn.removeAttribute('onclick');
  }

  // -- Pointer / touch events on the track --
  const setTimeFromPointer = (clientX) => {
    const rect   = track.getBoundingClientRect();
    // Addressable range = straight section, inset by one thumb diameter so the
    // thumb's BODY stops at the cap boundary (not just its center). The caps
    // are purely cosmetic dead-zones — cursor positions inside them don't
    // update time, popup, or anything else. The previous segment's color still
    // extends through them via the leading/trailing fill in drawFtsCanvas.
    const R      = Math.floor(rect.height / 2);
    const inset  = 2 * R;
    const xRel   = clientX - rect.left;
    const usable = Math.max(1, rect.width - 2 * inset);
    const t      = MIN_H_ARC + (xRel - inset) / usable * (MAX_H_ARC - MIN_H_ARC);
    const hour   = _clampHour(t);
    if (nowMode) {
      nowMode = false;
      nowBtn?.classList.remove('active');
      timeRangeWrap?.classList.remove('now-active');
      clearInterval(nowInterval); nowInterval = null;
    }
    setActiveIntentBtn(null);
    timeFromEl.value = hour;
    update();
    showFtsPopup(hour);
  };

  // Pointer down — start drag
  track.addEventListener('pointerdown', e => {
    e.preventDefault();
    _ftsDragging = true;
    track.setPointerCapture(e.pointerId);
    // Hide the OS cursor for the duration of the scrub: the thumb stops at
    // the straight-section edge, but the cursor would otherwise drift past it
    // into the cap. With the cursor hidden, the thumb is the sole indicator.
    track.style.cursor = 'none';
    window._qcThumbActive = true;
    setTimeFromPointer(e.clientX);
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
    track.style.cursor = '';
    drawFtsCanvas();
    _qcSpringBackFts();
    scheduleFtsPopupHide();
  });

  // Pointer cancel
  track.addEventListener('pointercancel', () => {
    _ftsDragging = false;
    window._qcThumbActive = false;
    track.style.cursor = '';
    drawFtsCanvas();
    hideFtsPopup();
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
  const BLEED = 6;            // px bleed top/bottom for thumb overflow
  const TRACK_H = cssH - BLEED * 2;  // 38px — actual ramp height
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

  const MIN_H   = MIN_H_ARC;
  const MAX_H   = MAX_H_ARC;
  const TRACK_R = Math.floor(TRACK_H / 2);  // 19px — matches CSS border-radius
  const BAR_W   = cssW;
  const dateStr = datePicker.value;
  const fromH   = parseFloat(timeFromEl.value);

  // Time maps to a range INSIDE the straight section, inset by one thumb
  // diameter on each side. That way the thumb's body (radius TRACK_R) at the
  // extremes ends exactly at the cap boundary — it never enters the curvature.
  // The cap + adjacent dead-strip pick up the first/last segment color via
  // the leading/trailing fill below, so the curves look like a natural
  // extension of the timeline but carry no data.
  const insetX  = 2 * TRACK_R;
  const usableW = Math.max(1, BAR_W - 2 * insetX);
  const timeToX = t => insetX + (t - MIN_H) / (MAX_H - MIN_H) * usableW;

  // Helper: rounded-rect path for the track shape (offset by BLEED)
  function trackRoundRect() {
    c.beginPath();
    c.roundRect(0, BLEED, BAR_W, TRACK_H, TRACK_R);
  }

  // 1. Background — night color, clipped to rounded rect
  c.save();
  trackRoundRect(); c.clip();
  c.fillStyle = '#2A3B5E';
  c.fillRect(0, BLEED, cssW, TRACK_H);

  // 2. Collect hourly weather-ramp segments
  const wxHours = (typeof getWeatherHoursForDate === 'function')
    ? getWeatherHoursForDate(dateStr) : [];
  const hasWx = wxHours.length > 0 && typeof getWeatherAt === 'function';
  const nowH_ = new Date().getHours() + new Date().getMinutes() / 60;
  const isToday_ = datePicker.value === todayStr();

  const segments = [];  // {x1, x2, color}
  for (let h = MIN_H; h < MAX_H; h++) {
    const sun = getSunFromTable(currentSunTable, h + 0.5);
    if (sun.alt <= 0) continue;

    let color = '#FFD488';
    if (hasWx) {
      const wx   = getWeatherAt(dateStr, h + 0.5);
      const rain = wx ? (wx.precip ?? wx.prec ?? 0) > 0.3 : false;
      const cf   = wx ? (wx.cloud ?? 0) : 0;
      if      (rain)       color = '#5E7CA8';
      else if (cf < 0.20)  color = '#FFD488';
      else if (cf < 0.60)  color = '#E6C08A';
      else                 color = '#8EA0B8';
    }

    const x1 = Math.round(timeToX(h));
    const x2 = Math.round(timeToX(h + 1));
    if (x2 <= x1) continue;
    segments.push({ x1, x2, color });
  }

  // 3. Fill rounded ends with first/last weather color
  if (segments.length > 0) {
    const first = segments[0];
    const last  = segments[segments.length - 1];
    if (first.x1 > 0) {
      c.fillStyle = first.color;
      c.fillRect(0, BLEED, first.x1, TRACK_H);
    }
    if (last.x2 < BAR_W) {
      c.fillStyle = last.color;
      c.fillRect(last.x2, BLEED, BAR_W - last.x2, TRACK_H);
    }
  }

  // 4. Draw weather segments
  for (const seg of segments) {
    c.fillStyle = seg.color;
    c.fillRect(seg.x1, BLEED, seg.x2 - seg.x1, TRACK_H);
  }

  // 5. Dim past hours on today
  if (isToday_ && nowH_ > MIN_H) {
    const pastX = Math.min(Math.round(timeToX(nowH_)), BAR_W);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.fillRect(0, BLEED, pastX, TRACK_H);
  }

  // 6. Venue shadow overlay — dim parts where selected venue is in shade
  if (selectedId != null) {
    const sv = VENUES.find(x => x.id === selectedId);
    if (sv) {
      const { windows: svWins, open: svOpen, close: svClose } = computeSunWindows(sv, dateStr);
      // Build list of shadow gaps within the daylight range
      const gaps = [];
      // Before first sun window (from venue open to first window start)
      if (svWins.length > 0) {
        if (svWins[0].start > svOpen + 0.01) gaps.push({ start: svOpen, end: svWins[0].start });
        for (let i = 0; i < svWins.length - 1; i++) {
          if (svWins[i + 1].start > svWins[i].end + 0.01) {
            gaps.push({ start: svWins[i].end, end: svWins[i + 1].start });
          }
        }
        const lastEnd = svWins[svWins.length - 1].end;
        if (lastEnd < svClose - 0.01) gaps.push({ start: lastEnd, end: svClose });
      } else if (svClose > svOpen) {
        // No sun at all — entire range is shadow
        gaps.push({ start: svOpen, end: svClose });
      }
      // Draw shadow gaps as diagonal hatching + dim overlay
      for (const gap of gaps) {
        const x1 = Math.round(timeToX(Math.max(MIN_H, gap.start)));
        const x2 = Math.round(timeToX(Math.min(MAX_H, gap.end)));
        if (x2 <= x1) continue;
        // Semi-transparent darken
        c.fillStyle = 'rgba(0,0,0,0.35)';
        c.fillRect(x1, BLEED, x2 - x1, TRACK_H);
        // Diagonal hatching for visual distinction
        c.save();
        c.beginPath();
        c.rect(x1, BLEED, x2 - x1, TRACK_H);
        c.clip();
        c.strokeStyle = 'rgba(0,0,0,0.18)';
        c.lineWidth = 1;
        const step = 6;
        for (let lx = x1 - TRACK_H; lx < x2 + TRACK_H; lx += step) {
          c.beginPath();
          c.moveTo(lx, BLEED + TRACK_H);
          c.lineTo(lx + TRACK_H, BLEED);
          c.stroke();
        }
        c.restore();
      }
    }
  }

  // 7. Inset shadow
  const insetGrad = c.createLinearGradient(0, BLEED, 0, BLEED + 5);
  insetGrad.addColorStop(0, 'rgba(0,0,0,0.22)');
  insetGrad.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = insetGrad;
  c.fillRect(0, BLEED, BAR_W, TRACK_H);
  c.restore(); // exit rounded-rect clip — thumb + NÅ tick draw unclipped

  // 8. NÅ tick
  const nowH = new Date().getHours() + new Date().getMinutes() / 60;
  const isToday = datePicker.value === todayStr();
  if (isToday && nowH >= MIN_H && nowH <= MAX_H) {
    const nx = timeToX(nowH);
    const thumbX = Math.max(TRACK_R, Math.min(BAR_W - TRACK_R, timeToX(fromH)));
    const thumbPx = Math.abs(thumbX - nx);
    if (thumbPx >= TRACK_R) {
      c.save();
      c.setLineDash([2, 3]);
      c.strokeStyle = 'rgba(156,189,231,0.55)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(nx, BLEED);
      c.lineTo(nx, BLEED + TRACK_H);
      c.stroke();
      c.setLineDash([]);
      c.restore();
    }
  }

  // 9. Thumb — same height as track, clamped to curvature ends
  if (fromH >= MIN_H && fromH <= MAX_H) {
    const isActive  = !!(window._qcThumbActive);
    const springOff = (typeof window._ftsSpringOffset === 'number') ? window._ftsSpringOffset : 0;
    const rawX = timeToX(fromH) + springOff;
    const sx   = Math.max(TRACK_R, Math.min(BAR_W - TRACK_R, rawX));
    const cy_  = BLEED + TRACK_H / 2;
    const R    = TRACK_R;  // thumb diameter = track height

    c.save();
    c.translate(sx, cy_);
    c.scale(isActive ? 1.08 : 1.0, isActive ? 1.08 : 1.0);
    c.translate(-sx, -cy_);

    // Glow halo
    c.save();
    c.shadowColor   = isActive ? 'rgba(255,175,133,0.55)' : 'rgba(255,175,133,0.35)';
    c.shadowBlur    = 10;
    c.beginPath(); c.arc(sx, cy_, R, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,242,235,0.01)';
    c.fill();
    c.restore();

    // Drop shadow + frosted fill
    c.save();
    c.shadowColor   = 'rgba(0,0,0,0.35)';
    c.shadowBlur    = 5;
    c.shadowOffsetY = 1;
    c.beginPath(); c.arc(sx, cy_, R, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,242,235,0.18)';
    c.fill();
    c.restore();

    // Border ring
    c.save();
    c.beginPath(); c.arc(sx, cy_, R - 0.75, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(255,242,235,0.75)';
    c.lineWidth   = 1.5;
    c.stroke();
    c.restore();

    // Inner highlight
    c.save();
    c.beginPath();
    c.arc(sx, cy_ - 2, R - 4, Math.PI * 1.1, Math.PI * 1.9);
    c.strokeStyle = 'rgba(255,255,255,0.30)';
    c.lineWidth   = 1;
    c.stroke();
    c.restore();

    c.restore(); // scale
  }

  c.restore(); // dpr
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

/** Update the calendar button label based on selected date. */
function updateFtsDateBtn() {
  const btn   = document.getElementById('fts-date-btn');
  const label = document.getElementById('fts-date-label');
  if (!btn || !label) return;

  const sel   = datePicker.value;
  const today = todayStr();

  if (sel === today) {
    // Today: icon-only circle
    btn.classList.add('fts-today');
    label.textContent = '';
  } else {
    btn.classList.remove('fts-today');
    const d = new Date(sel + 'T12:00:00');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);

    // Check if same week (within 6 days)
    const diffDays = Math.round((d - new Date(today + 'T12:00:00')) / 86400000);

    if (sel === tomorrowStr) {
      label.textContent = 'I morgen';
    } else if (diffDays > 0 && diffDays <= 6) {
      // Same week: "tor 23"
      label.textContent = _ftsDays[d.getDay()] + ' ' + d.getDate();
    } else {
      // Further: "23. apr"
      label.textContent = d.getDate() + '. ' + _ftsMonths[d.getMonth()];
    }
  }

  // Highlight when calendar is open
  if (_qcActiveSection === 'date') {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
  }
}

/** Show the scrub popup with time + weather info. */
function showFtsPopup(hour) {
  const popup    = document.getElementById('fts-popup');
  const timeEl   = document.getElementById('fts-popup-time');
  const wxIconEl = document.getElementById('fts-popup-wx-icon');
  const tempEl   = document.getElementById('fts-popup-temp');
  const windEl   = document.getElementById('fts-popup-wind');
  const canvas   = document.getElementById('fts-canvas');
  if (!popup || !timeEl) return;

  // Clear any pending hide
  if (_ftsHideTimeout) { clearTimeout(_ftsHideTimeout); _ftsHideTimeout = null; }

  // Time
  timeEl.textContent = formatHour(hour);

  // Weather: icon on row 1, temp + wind on row 2
  const dateStr = datePicker.value;
  if (typeof getWeatherAt === 'function') {
    const wx = getWeatherAt(dateStr, hour);
    if (wx) {
      const rain = (wx.precip ?? wx.prec ?? 0) > 0.3;
      const cf   = wx.cloud ?? 0;
      // Weather icon (emoji)
      if (wxIconEl) wxIconEl.textContent = rain ? '🌧' : (typeof skyIcon === 'function' ? skyIcon(cf) : '☀️');
      // Temperature
      if (tempEl) tempEl.textContent = wx.temp != null ? Math.round(wx.temp) + '°' : '';
      // Wind
      if (windEl) windEl.textContent = wx.wspd != null ? Math.round(wx.wspd) + ' m/s' : '';
    } else {
      if (wxIconEl) wxIconEl.textContent = '';
      if (tempEl)   tempEl.textContent = '';
      if (windEl)   windEl.textContent = '';
    }
  }

  // Position popup horizontally centered on thumb
  if (canvas) {
    const ftsEl    = document.getElementById('fts');
    const trackEl  = document.getElementById('fts-track');
    if (ftsEl && trackEl) {
      const trackLeft = trackEl.offsetLeft;
      const trackW    = trackEl.offsetWidth;
      const MIN_H     = MIN_H_ARC, MAX_H = MAX_H_ARC;
      // Match drawFtsCanvas: time maps inside the straight section (inset by
      // one thumb diameter), so the popup follows the thumb's actual position.
      const R         = Math.floor(trackEl.offsetHeight / 2);
      const inset     = 2 * R;
      const usableW   = Math.max(1, trackW - 2 * inset);
      const thumbX    = trackLeft + inset + (hour - MIN_H) / (MAX_H - MIN_H) * usableW;
      const ftsW      = ftsEl.offsetWidth;
      // Clamp so popup doesn't overflow edges
      const popupW    = popup.offsetWidth || 160;
      const left      = Math.max(popupW / 2 + 8, Math.min(ftsW - popupW / 2 - 8, thumbX));
      popup.style.left = left + 'px';
    }
  }

  popup.classList.add('visible');
}

/** Hide the scrub popup. */
function hideFtsPopup() {
  const popup = document.getElementById('fts-popup');
  if (popup) popup.classList.remove('visible');
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
  updateFtsDateBtn();
  // Trigger appstart popup on first sync after FTS becomes visible
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
 * Falls back to sync computation on cache miss (worker will overwrite later).
 */
function computeSunWindows(venue, dateStr) {
  const key = `${venue.id}-${dateStr}`;
  if (sunWindowCache.has(key)) return sunWindowCache.get(key);
  if (!currentSunTable) currentSunTable = buildSunTable(dateStr);
  const result = computeSunWindowsFromTable(venue, currentSunTable);
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
try {
  sunWorker = new Worker('js/worker.js');
  sunWorker.onmessage = function(e) {
    const { type, dateStr, result, generation } = e.data;
    if (type !== 'result') return;
    // Discard stale results if the user changed the date while the worker was running
    if (dateStr !== datePicker.value) return;
    // Discard results from an older dispatch (e.g. pre-initFacings worker)
    if (generation !== _workerGeneration) return;
    for (const [idStr, windows] of Object.entries(result)) {
      sunWindowCache.set(`${idStr}-${dateStr}`, windows);
    }
    // Sprites may have been built against the sync-fallback windows; rebuild them
    // now that the worker has confirmed (or corrected) the sun window data.
    clearSpriteCache();
    // Re-render with worker-computed data
    draw();
    renderList();
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
  zoom: 13,
  pitch: 15,
  antialias: true,
  attributionControl: false,
});

map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
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

function locateUser() {
  if (!userLocation) return;
  // Dismiss keyboard / search if active so the map is visible
  const si = document.getElementById('venue-search');
  if (si && document.activeElement === si) si.blur();
  const btn = document.getElementById('locate-btn');
  if (btn) { btn.classList.add('tracking'); setTimeout(() => btn.classList.remove('tracking'), 1200); }
  map.flyTo({ center: [userLocation.lng, userLocation.lat], zoom: Math.max(map.getZoom(), 15.2), duration: 600 });
}

map.on('move',    _updateLocationDot);
map.on('zoomend', _updateLocationDot);
map.on('zoom',    _updateZoomDebug);
map.on('pitch',   _updateZoomDebug);

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
  const shouldShow = localStorage.getItem('solsteder_zoom_debug_visible') === 'true';
  if (!shouldShow) {
    zoomDebug.classList.add('hidden');
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

  updateLightPreset();
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
    _introMapReady = true;
    _introGeoReady = true;
    _skipIntro();
  }
}, 12000);

// ── Light preset (atmosphere + sky) ──────────────────────────────────────────
let _currentPreset = null;
function updateLightPreset() {
  if (!mapLoaded || !currentSun || !currentSunTable) return;
  const hour    = parseFloat(timeFromEl.value);
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);
  let preset;
  if (currentSun.alt < 0) {
    preset = 'night';
  } else if (sunrise && hour < sunrise + 1.5) {
    preset = 'dawn';
  } else if (sunset && hour > sunset - 1.5) {
    preset = 'dusk';
  } else {
    preset = 'day';
  }
  if (preset === _currentPreset) return; // only fire on actual change so Mapbox transition plays fully
  _currentPreset = preset;
  try { map.setConfigProperty('basemap', 'lightPreset', preset); } catch (_) {}
}

// ── Sun lighting (Mapbox GL v3) ───────────────────────────────────────────────
function updateSunLighting() {
  if (!mapLoaded || !currentSun) return;
  const { az, alt } = currentSun;
  if (alt > 0) {
    map.setLights([
      {
        id: 'sun',
        type: 'directional',
        properties: {
          direction: [az, 90 - alt],
          'cast-shadows': true,
          intensity: 0.9,
          color: alt < 10 ? '#ff9944' : alt < 25 ? '#ffdd88' : '#ffffff',
        }
      },
      {
        id: 'ambient',
        type: 'ambient',
        properties: { intensity: 0.08, color: '#ffffff' }
      }
    ]);
  } else {
    map.setLights([
      {
        id: 'ambient',
        type: 'ambient',
        properties: { intensity: 0.4, color: '#8899cc' }
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
  const day = d.toLocaleDateString('nb-NO', { weekday: 'short' });
  const num = d.getDate();
  const mon = d.toLocaleDateString('nb-NO', { month: 'short' });
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
    nowInterval = setInterval(() => { if (nowMode) { applyNowTime(); update(); } }, 30000);
  }
  update();
}

function applyNowTime() {
  timeFromEl.value = Math.min(23, Math.max(4, currentHour()));
  updateRangeFill();
}

function _activateNowMode() {
  if (nowMode) return;
  nowMode = true;
  nowBtn?.classList.add('active');
  timeRangeWrap?.classList.add('now-active');
  setActiveIntentBtn('now');
  nowInterval = setInterval(() => { if (nowMode) { applyNowTime(); update(); } }, 30000);
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
  _aTrack('intent_set', { intent });
  setActiveIntentBtn(intent);
  _currentPreset = null;
  if (intent === 'now') {
    const isToday = datePicker.value === todayStr();
    if (isToday) {
      if (!nowMode) {
        nowMode = true;
        nowBtn?.classList.add('active');
        timeRangeWrap?.classList.add('now-active');
        nowInterval = setInterval(() => { if (nowMode) { applyNowTime(); update(); } }, 30000);
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

// ── Weather display ───────────────────────────────────────────────────────────
function updateWeatherDisplay() {
  const el = document.getElementById('wx-now');
  if (!el) return;
  const wx = getWeatherAt(datePicker.value, parseFloat(timeFromEl.value));
  if (!wx) { el.classList.remove('loaded'); return; }

  const windLine = wx.wspd >= 1
    ? `<span>${Math.round(wx.wspd)} m/s ${windCardinal(wx.wdir)}</span>`
    : '';
  const rainLine = wx.precip >= 0.1
    ? `<span style="color:#7ab4ff">🌧 ${wx.precip.toFixed(1)} mm</span>`
    : '';

  el.innerHTML = `
    <span class="wx-temp">${formatTemp(wx.temp)}</span>
    <span>${skyIcon(wx.cloud)} ${Math.round(wx.cloud * 100)}%</span>
    ${windLine}
    ${rainLine}
  `;
  el.classList.add('loaded');
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
  const ARROWS = ['↑','↗','→','↘','↓','↙','←','↖'];
  const arrow   = ARROWS[Math.round(((wx.wdir + 180) % 360) / 45) % 8];
  const rain    = wx.precip >= 0.2
    ? `<span class="wx-rain">🌧 ${wx.precip.toFixed(1)}</span>`
    : '';
  el.innerHTML = `<span>${skyIcon(wx.cloud)}</span>`
    + `<span class="wx-temp-strip">${formatTemp(wx.temp)}</span>`
    + `<span class="wx-sep">·</span>`
    + `<span class="wx-wind">${arrow} ${Math.round(wx.wspd)} m/s</span>`
    + rain;
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
      if (summ.avgCloud < 0.30) cls += ' sun-high';
      else if (summ.avgCloud < 0.60) cls += ' sun-mid';
    } else {
      cls += ' no-data';
    }
    const icon = summ ? summ.icon : '·';
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
  if (isOpen) renderDateCalendar();
}

function selectCalendarDate(dateStr) {
  datePicker.value = dateStr;
  if (dateStr !== todayStr() && nowMode) {
    nowMode = false;
    clearInterval(nowInterval); nowInterval = null;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    timeFromEl.value = 12;
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
let filterFavoritesOnly = false;
function toggleFavoritesFilter() {
  filterFavoritesOnly = !filterFavoritesOnly;
  const btn = document.getElementById('fav-filter-btn');
  if (btn) btn.classList.toggle('active', filterFavoritesOnly);
  renderList();
}

// ── Area filter ───────────────────────────────────────────────────────────────
function setAreaFilter(area) {
  _aTrack('filter_change', { filter: 'area', value: area });
  activeArea = area;
  document.querySelectorAll('.area-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.area === area));
  renderList();
  if (typeof saveUserPreference === 'function') saveUserPreference('default_area', area);
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function _closeSortPanel() {
  if (!_navHandlingPop) _navDropLayer('sort');
  document.getElementById('sort-panel')?.classList.remove('open');
  document.getElementById('sort-toggle-btn')?.classList.remove('open');
}

function toggleSortPanel() {
  const panel = document.getElementById('sort-panel');
  const btn   = document.getElementById('sort-toggle-btn');
  if (!panel || !btn) return;
  if (panel.classList.contains('open')) { _closeSortPanel(); return; }
  _navPush('sort');
  panel.classList.add('open');
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  panel.style.top  = (r.bottom + 4) + 'px';
  panel.style.left = r.right + 'px';
  panel.style.transform = 'translateX(-100%)';
}

function setSortBy(sort) {
  _aTrack('sort_change', { sort_by: sort });
  if (sort === 'distance' && !userLocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        activeSortBy = 'distance';
        updateSortBtns();
        renderList();
      },
      () => {}
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
  const labels = { score: 'Mest sol', latest: 'Senest sol', distance: 'Avstand', beer: 'Ølpris' };
  const labelEl = document.getElementById('sort-label');
  if (labelEl) labelEl.textContent = labels[activeSortBy] ?? 'Mest sol';
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
let _renderListTimer = null;
function scheduleRenderList() {
  clearTimeout(_renderListTimer);
  _renderListTimer = setTimeout(() => { renderList(); setTimeout(_syncQcPanelHeight, 80); }, 300);
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

let _autoAdvancedAfterSunset = false;

// ── Day navigation ────────────────────────────────────────────────────────────
function advanceDay(delta, setHour) {
  const d = new Date(datePicker.value + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  datePicker.value = d.toISOString().slice(0, 10);
  // When jumping forward and sun is currently below horizon, default to noon
  if (setHour === undefined && delta > 0 && currentSun && currentSun.alt < 0) setHour = 12;
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
// ── Arc canvas time interaction ───────────────────────────────────────────────
let _arcDragging = false;

function _clampHour(t) {
  const snapped = Math.round(t * 4) / 4;
  const minH = (datePicker.value === todayStr()) ? Math.round(currentHour() * 4) / 4 : MIN_H_ARC;
  return Math.max(Math.max(MIN_H_ARC, minH), Math.min(MAX_H_ARC, snapped));
}

function _arcSetTimeFromX(clientX) {
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  const canvasEl = document.getElementById('sun-curve');
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  const t    = MIN_H_ARC + (clientX - rect.left - PAD_X_ARC) / (rect.width - PAD_X_ARC * 2) * (MAX_H_ARC - MIN_H_ARC);
  const hour = _clampHour(t);
  if (nowMode) {
    nowMode = false;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  setActiveIntentBtn(null);
  // Haptic tick on each 15-min step boundary
  const step = Math.round(hour * 4);
  if (_lastSliderStep !== null && step !== _lastSliderStep) navigator.vibrate?.(6);
  _lastSliderStep = step;
  timeFromEl.value = hour;
  update();
}

function handleSunCurveClick(e) { _arcSetTimeFromX(e.clientX); }

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
  const isHover = typeof h === 'number';
  const hour    = isHover ? h : parseFloat(timeFromEl.value);
  // Snap to 15-min increments for display
  const dispH   = Math.round(hour * 4) / 4;
  const dateStr = datePicker.value;
  const wx      = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, dispH) : null;
  const ARROWS  = ['↑','↗','→','↘','↓','↙','←','↖'];
  const arrow   = wx ? ARROWS[Math.round(((wx.wdir + 180) % 360) / 45) % 8] : '';
  // Arrow wrapped in fixed-width span so glyph width never shifts container
  const windHtml = wx
    ? `<span class="wind-arrow">${arrow}</span>${Math.round(wx.wspd)} m/s`
    : '';
  const temp    = wx ? `${Math.round(wx.temp)}°` : '';
  const icon    = wx && typeof skyIcon === 'function' ? skyIcon(wx.cloud) : '';

  // Row 2: selected time label (24pt/700/--accent)
  const timeLabel = formatHour(dispH);

  // List header sun count — lives in #list-sun-count, not in readout
  let sunLabel = '';
  if (typeof VENUES !== 'undefined' && typeof venueHasSunInRange === 'function') {
    let sunVenues = VENUES.filter(v => venueHasSunInRange(v, dateStr, dispH, dispH));
    if (filterMapViewActive && typeof map !== 'undefined') {
      const bounds = (selectedId != null && _frozenBounds) ? _frozenBounds : map.getBounds();
      sunVenues = sunVenues.filter(v => bounds.contains([v.lng, v.lat]));
    }
    const cnt = sunVenues.length;
    sunLabel = cnt > 0 ? t('places_in_sun', { count: cnt }) : t('no_places_in_sun');
  }

  _readoutSet(document.getElementById('readout-time'), timeLabel, false);

  // Inline weather row: icon + temp + separator (wx-sep, static) + wind
  const wxIconEl = document.querySelector('#readout-meta-wx .wx-icon');
  const wxTempEl = document.getElementById('readout-meta-temp');
  const wxWindEl = document.getElementById('readout-meta-wind');
  const wxSepEl  = document.querySelector('#readout-meta-wx .wx-sep');
  if (wxIconEl) wxIconEl.textContent = icon;
  // Show separator + wind only when weather data exists
  if (wxSepEl)  wxSepEl.style.display  = wx ? '' : 'none';
  // Always update instantly — temp/wind are small status numbers where a crossfade
  // causes visible flicker during scrubbing without adding meaningful polish.
  if (wxTempEl) wxTempEl.textContent = temp;
  if (wxWindEl) wxWindEl.innerHTML    = windHtml;

  // Sun count: belongs to list header, not readout
  _readoutSet(document.getElementById('list-sun-count'), sunLabel, false);

  // Hue-shift: tint the unified control group toward weather ramp during hover/drag
  const ctrlGroup = document.getElementById('qc-control-group');
  if (ctrlGroup) {
    if (isHover && wx) {
      const rain = (wx.precip ?? wx.prec ?? 0) > 0.3;
      const cf   = wx.cloud ?? 0;
      let [tr, tg, tb] = rain ? [28,50,88] : cf < 0.20 ? [36,54,78] : cf < 0.60 ? [32,50,76] : [26,46,80];
      ctrlGroup.style.background = `rgba(${tr},${tg},${tb},0.60)`;
    } else {
      ctrlGroup.style.background = '';
    }
  }
}

function updateQcLabels() {
  const val = datePicker.value;
  const tod = todayStr();

  // Refresh readout (sun count changes with date)
  updateQcIndicator(null);

  // Readout date label (inline phrase)
  const dateLabelEl = document.getElementById('readout-date-label');
  if (dateLabelEl) dateLabelEl.textContent = formatDatePill(val);

  // Date button active state reflects calendar open state
  document.getElementById('readout-date-btn')?.classList.toggle('active', _qcActiveSection === 'date');

  // "Now" only makes sense today — show "Sunrise" on future dates
  const isToday = val === tod;
  document.querySelectorAll('.qc-preset-btn[data-intent="now"]').forEach(b => {
    b.textContent = isToday ? t('now') : t('sunrise');
  });

  // Sync preset buttons with active intent
  document.querySelectorAll('.qc-preset-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.intent === activeIntent));
}

function _closeQcPanel() {
  const panel = document.getElementById('qc-panel');
  if (!panel) return;

  if (!_navHandlingPop) _navDropLayer('qc');
  _qcActiveSection = null;
  // _qcCalExpanded is intentionally NOT reset here — session mode (strip/month) persists

  const dateBtn = document.getElementById('readout-date-btn');
  if (dateBtn) { dateBtn.classList.remove('active'); dateBtn.setAttribute('aria-expanded', 'false'); }
  document.getElementById('ptb-cal-float')?.classList.remove('open');
  document.getElementById('floating-search')?.classList.remove('cal-dimmed');
  // Update floating slider: remove active state, restore visibility, update date label
  if (USE_FLOATING_TIME_SLIDER) {
    document.getElementById('fts-date-btn')?.classList.remove('active');
    document.getElementById('fts')?.classList.remove('fts-cal-open');
    updateFtsDateBtn();
  }
  // Restore panel state saved before calendar opened
  if (_preCalPanelState && isMobile() && typeof window._applyMobilePanelState === 'function') {
    window._applyMobilePanelState(_preCalPanelState);
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
    dateSection?.classList.remove('active');
  };
  panel.addEventListener('transitionend', cleanup);
  // Fallback: if panel has no transition (mobile override), clean up immediately
  const cs = getComputedStyle(panel).transition;
  if (!cs || cs === 'none' || cs === 'all 0s') dateSection?.classList.remove('active');
}

function toggleQcPanel(section) {
  // Only 'date' section is used now; arc is always visible in panel-time-bar
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
  calFloat?.classList.add('open');
  document.getElementById('floating-search')?.classList.add('cal-dimmed');
  // Mark floating slider as cal-open (hides track, keeps button visible for toggle-back)
  if (USE_FLOATING_TIME_SLIDER) {
    document.getElementById('fts-date-btn')?.classList.add('active');
    document.getElementById('fts')?.classList.add('fts-cal-open');
  }
  // On mobile, collapse list to peek so picker has room; restore on close
  if (isMobile() && typeof window._applyMobilePanelState === 'function') {
    _preCalPanelState = window._currentMobilePanelState?.() ?? null;
    if (_preCalPanelState !== 'peek') window._applyMobilePanelState('peek');
  }
  panel.classList.add('open');
  document.getElementById('qc-date-section')?.classList.add('active');
  const dateBtn = document.getElementById('readout-date-btn');
  if (dateBtn) { dateBtn.classList.add('active'); dateBtn.setAttribute('aria-expanded', 'true'); }
  renderQcCalendar();
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
    if (summ.avgCloud < 0.30)      cls += ' sun-high';
    else if (summ.avgCloud < 0.60) cls += ' sun-mid';
  } else {
    cls += ' solar-only'; // beyond forecast window — solar data only
  }

  const icon = hasForecast ? summ.icon : '';
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

  let html = '<div class="dc-grid">';

  for (let i = 0; i < 10; i++) {
    const d    = new Date(); d.setDate(d.getDate() + i);
    const dStr = d.toISOString().slice(0, 10);
    html += _dcTileHtml(dStr, today_, selected);
  }

  html += '</div>';

  const chevDown = `<svg class="dc-btn-chev" width="10" height="6" viewBox="0 0 10 6" fill="currentColor" aria-hidden="true"><path d="M0 0 L10 0 L5 6 Z"/></svg>`;
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

  const chevUp = `<svg class="dc-btn-chev dc-btn-chev-up" width="10" height="6" viewBox="0 0 10 6" fill="currentColor" aria-hidden="true"><path d="M0 0 L10 0 L5 6 Z"/></svg>`;
  html += `<button class="dc-expand-btn-wide" onclick="event.stopPropagation();_toggleQcCalExpand()">Skjul full kalender ${chevUp}</button>`;

  cal.innerHTML = html;
  _syncQcPanelHeightExpanded();
}


function _toggleQcCalExpand() {
  _qcCalExpanded = !_qcCalExpanded;
  // Hide before render to prevent flash of un-animated content
  const _calEl = document.getElementById('qc-cal');
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
  if (!_qcCalExpanded) {
    const qcPanel = document.getElementById('qc-panel');
    if (qcPanel) {
      qcPanel.classList.remove('cal-expanded');
      qcPanel.style.removeProperty('--qc-panel-h');
    }
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
  qcPanel.style.setProperty('--qc-panel-h', '520px');
}

function selectQcDate(dateStr) {
  datePicker.value = dateStr;
  if (dateStr !== todayStr() && nowMode) {
    nowMode = false;
    clearInterval(nowInterval); nowInterval = null;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    timeFromEl.value = 12;
  }
  _closeQcPanel();
  // Return focus to the date button so keyboard users can continue scrubbing
  document.getElementById('readout-date-btn')?.focus();
  update();
}

let _qcPanelHeight = 0; // cached, set on load/resize/list-render

function _syncQcPanelHeight() {
  // Calendar is now inside the panel; give it a fixed reasonable height.
  const qcPanel = document.getElementById('qc-panel');
  if (!qcPanel) return;
  const h = 280;
  if (h === _qcPanelHeight) return;
  _qcPanelHeight = h;
  const dateSection = document.getElementById('qc-date-section');
  if (dateSection) dateSection.style.height = h + 'px';
  qcPanel.style.setProperty('--qc-panel-h', (h + 10) + 'px');
}

// ── Peek height: measure handle + time bar + list-sun-header + venue-peek ────
function _updatePeekHeight() {
  if (!isMobile()) return;
  const panel     = document.getElementById('panel');
  const handle    = document.getElementById('panel-handle');
  const timebar   = document.getElementById('panel-time-bar');
  const sunHeader = document.getElementById('list-sun-header');
  const peek      = document.getElementById('venue-peek');
  if (!panel || !handle || !timebar) return;
  const h = handle.offsetHeight + timebar.offsetHeight
          + (sunHeader ? sunHeader.offsetHeight : 0)
          + (peek ? peek.offsetHeight : 0);
  panel.style.setProperty('--peek-h', Math.max(h, 100) + 'px');
  _syncFtsPosition();
}

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

// Spring-back animation: briefly offsets thumb toward future then eases to 0
function _qcSpringBackThumb(canvasEl) {
  if (!canvasEl) return;
  window._qcSpringOffset = 8;
  const start    = performance.now();
  const duration = 220;
  function step(now) {
    const p = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 2);  // ease-out quad
    window._qcSpringOffset = 8 * (1 - eased);
    drawTimeBar(canvasEl);
    if (p < 1) requestAnimationFrame(step);
    else { window._qcSpringOffset = 0; drawTimeBar(canvasEl); }
  }
  requestAnimationFrame(step);
}

function _qcArcSetTimeFromX(clientX) {
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  const canvasEl = document.getElementById('qc-arc');
  if (!canvasEl) return;
  const rect = canvasEl.getBoundingClientRect();
  const t    = MIN_H_ARC + (clientX - rect.left) / rect.width * (MAX_H_ARC - MIN_H_ARC); // bar fills edge-to-edge
  const hour = _clampHour(t);
  if (nowMode) {
    nowMode = false;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  setActiveIntentBtn(null);
  timeFromEl.value = hour;
  update();
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
    dispatchToWorker(dateStr);
  }

  currentSun = getSunFromTable(currentSunTable, fromHour);
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset  = findSunCrossingFromTable(currentSunTable, false);

  // Dynamic arc range — place sunrise/sunset labels inside the pill's curved ends.
  // PAD_FRAC 0.06 means sunrise/sunset land ~6% from each pill edge, which equals
  // roughly TRACK_R pixels (≈13px) on a ~220px bar, consistently across all seasons.
  if (sunrise != null && sunset != null) {
    SUNRISE_H_ARC = sunrise;
    SUNSET_H_ARC  = sunset;
    const _dayLen = sunset - sunrise;
    const _range  = _dayLen / (1 - 2 * 0.06);
    const _buf    = _range * 0.06;
    MIN_H_ARC = Math.max(2, sunrise - _buf);
    MAX_H_ARC = Math.min(24, sunset  + _buf);
  }

  // Auto-advance to tomorrow after sunset (once per session startup)
  if (!_autoAdvancedAfterSunset && dateStr === todayStr() && sunset != null) {
    const realNow = new Date().getHours() + new Date().getMinutes() / 60;
    if (realNow > sunset) {
      _autoAdvancedAfterSunset = true;
      setTimeout(() => {
        advanceDay(1, 12);
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
  drawSunCompass();
  drawSunCurve(document.getElementById('sun-curve'));
  positionPresetButtons();
  updateWeatherDisplay();
  scheduleRenderList();
  updatePopup();
  updateLightPreset();
  updateSunLighting();

  if (highlight.id != null && tooltip.classList.contains('visible')) {
    const hv = VENUES.find(x => x.id === highlight.id);
    if (hv) tooltip.innerHTML = buildTooltipContent(hv);
  }

  updateDateDisplayBtn();
  updateDateWeatherStrip();
  updateQcLabels();
  updateQcIndicator(null);
  drawTimeBar(document.getElementById('qc-arc'));
  syncFts();
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
    return `<div class="popup-status sunny">☀ In sun until ${formatHour(curWin.end)} · ${dur.trim()} left</div>`;
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
  const h    = String(Math.round(parseFloat(timeFromEl.value))).padStart(2, '0');
  const url  = `${location.origin}${location.pathname}#${slug}-${venueId}/${d}T${h}`;
  if (navigator.share) {
    navigator.share({ title: `${v.name} — ${v.area}`, url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url).then(() => {
      const btn = document.querySelector(`.venue-card[data-vid="${venueId}"] .card-action-btn:last-child`);
      if (btn) { btn.textContent = t('copied'); setTimeout(() => btn.textContent = '⎘ ' + t('share'), 1500); }
    });
  }
}

const EDIT_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
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
  const targetZoom = 17;
  const opts = { center: [v.lng, v.lat], zoom: targetZoom, pitch: 45, duration: 600 };

  if (isMobile()) {
    const panelH = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.69);
    opts.padding = { top: 0, bottom: panelH, left: 0, right: 0 };
  } else {
    // On desktop, if the detail panel is already open (venue switching), offset
    // the camera so the venue isn't hidden behind the panel.
    const dp = document.getElementById('detail-panel');
    const padLeft = (dp && dp.classList.contains('open'))
      ? (dp.offsetLeft + dp.offsetWidth) : 0;
    if (padLeft > 0) opts.padding = { left: padLeft, right: 0, top: 60, bottom: 0 };
  }

  const wallBearing   = v.wallSegment?.bearing ?? v.facing;
  const targetBearing = (wallBearing + 180) % 360;
  const curBearing    = ((map.getBearing() % 360) + 360) % 360;
  let   diff          = Math.abs(targetBearing - curBearing);
  if (diff > 180) diff = 360 - diff;
  if (diff > 60) opts.bearing = targetBearing;

  map.easeTo(opts);
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
  renderList();

  // Fly in the next task — panel/DOM mutations must be complete AND all
  // synchronous event handlers (touchend → pointerup) must have finished,
  // otherwise Mapbox calls map.stop() after our easeTo and cancels it.
  if (flyTo) setTimeout(() => _flyToVenue(v), 0);

  setTimeout(() => {
    const card = document.querySelector(`.venue-card[data-vid="${id}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

function updatePopup() {
  updateDetailPanel();
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function openDetailPanel(v) {
  _aDetailOpenTs = Date.now();
  _aTrack('detail_open', { venue_id: v.id, time_slot: parseFloat(timeFromEl.value) });
  _mapMovedWhileDetailOpen = false; // reset each time a panel opens
  const dp      = document.getElementById('detail-panel');
  const content = document.getElementById('dp-content');
  if (!dp || !content) return;

  content.innerHTML = renderDetailPanelContent(v, datePicker.value, parseFloat(timeFromEl.value));
  dp.classList.remove('dp-fullscreen');
  dp.classList.add('open');
  _startWindForVenue(v);
  if (isMobile()) {
    const panel = document.getElementById('panel');
    if (panel) {
      panel.classList.remove('mobile-expanded', 'mobile-fullscreen');
      panel.classList.add('mobile-hidden');
    }
    document.getElementById('floating-search')?.classList.add('mobile-ui-hidden');
    document.getElementById('qc-wrap')?.classList.add('mobile-ui-hidden');
  }
  _syncFtsPosition();
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
  // Closed via in-app UI — drop 'venue' and everything stacked on top of it
  // (e.g. 'dp-fullscreen'). Skipped when triggered by the popstate handler.
  if (!_navHandlingPop) _navDropLayer('venue');
if (typeof stopWindOverlay === 'function') stopWindOverlay();
  const dp = document.getElementById('detail-panel');
  if (dp) {
    dp.classList.remove('open', 'dp-fullscreen');
  }
  if (isMobile()) {
    // Delay restoring the venue list until the detail panel has finished its
    // 300ms close animation, so the two panels are never visible at the same time.
    // expandList=true (< Venues back button): restore expanded so the list is immediately browsable.
    // expandList=false (X button / swipe down): restore to peek state.
    setTimeout(() => {
      const panel = document.getElementById('panel');
      if (panel) {
        panel.classList.remove('mobile-hidden', 'mobile-fullscreen');
        if (expandList) panel.classList.add('mobile-expanded');
        else            panel.classList.remove('mobile-expanded');
        _syncFtsPosition();
      }
      document.getElementById('floating-search')?.classList.remove('mobile-ui-hidden');
      document.getElementById('qc-wrap')?.classList.remove('mobile-ui-hidden');
      document.getElementById('locate-btn')?.classList.remove('mobile-ui-hidden');
    }, 320);
  }
  _syncFtsPosition();
  if (selectedId != null) {
    // Remove temporary candidate venue from VENUES if present
    const idx = VENUES.findIndex(v => v.id === selectedId && v._isCandidate);
    if (idx !== -1) VENUES.splice(idx, 1);

    selectedId = null;
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
      // User panned/zoomed in mini-map while panel was open — keep their position,
      // only reset tilt back to standard.
      map.easeTo({ pitch: 15, bearing: 0, duration: 500,
                   padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    } else {
      map.easeTo({ center: restoreCenter, zoom: restoreZoom, pitch: 15, bearing: 0, duration: 600,
                   padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    }
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
  content.innerHTML = renderDetailPanelContent(v, datePicker.value, parseFloat(timeFromEl.value));
  _startWindForVenue(v); // restart with updated weather snapshot
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
  saveFacingCache(v.id, v.facing, v.facingSource,
    v.terraceWallIndices, v.terraceDepth, null, v.terraceType, v.terraceDetachedLocation,
    v.terraceWallTrimStart, v.terraceWallTrimEnd);
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
  if (typeof stopWindOverlay === 'function') stopWindOverlay();
  editingVenueId = venueId;
  editHoveredWallIdx = null;
  const v = VENUES.find(x => x.id === venueId);
  if (!v) return;

  _editBeforeSnapshot = _venueEditSnapshot(v);
  _editHasChanges = false;
  _navPush('edit');

  document.getElementById('edit-overlay').style.display = 'flex';
  document.getElementById('floating-search').style.display = 'none';
  document.getElementById('panel').style.display = 'none';
  document.getElementById('detail-panel').style.display = 'none';
  document.getElementById('qc-wrap').style.display = 'none';
  document.getElementById('qc-panel').style.display = 'none';
  document.getElementById('panel-reveal-btn').style.display = 'none';
  document.getElementById('edit-venue-label').textContent = v.name;
  const type = v.terraceType ?? 'street';
  _syncTerraceTypeUI(type);
  _updateEditDepthDisplay();
  _updateEditDirectionDisplay(v);
  _updateEditActionBtn();

  if (popup) { popup.remove(); popup = null; }
  tooltip.classList.remove('visible');

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

  // Scroll to + highlight the venue card in the sidebar
  setTimeout(() => {
    const card = document.querySelector(`.venue-card[data-vid="${venueId}"]`);
    if (card) {
      card.classList.add('editing');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 200);

  draw();
}

let editSatelliteActive = false;

function toggleEditSatellite() {
  editSatelliteActive = !editSatelliteActive;
  document.getElementById('edit-satellite-btn').classList.toggle('active', editSatelliteActive);
  map.setStyle(editSatelliteActive
    ? 'mapbox://styles/mapbox/satellite-streets-v12'
    : buildShadeStyle()
  );
}

function exitEditMode() {
  if (!_navHandlingPop) _navDropLayer('edit');
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
  document.getElementById('edit-overlay').style.display = 'none';
  document.getElementById('floating-search').style.display = '';
  document.getElementById('panel').style.display = '';
  document.getElementById('detail-panel').style.display = '';
  document.getElementById('qc-wrap').style.display = '';
  document.getElementById('qc-panel').style.display = '';
  document.getElementById('panel-reveal-btn').style.display = '';
  document.querySelectorAll('.venue-card.editing').forEach(c => c.classList.remove('editing'));
  if (editSatelliteActive) {
    editSatelliteActive = false;
    document.getElementById('edit-satellite-btn').classList.remove('active');
    map.setStyle(buildShadeStyle());
  }
  map.easeTo({ pitch: 15, bearing: 0, duration: 500 });
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
    }
  }
  exitEditMode();
}

/** Single adaptive button handler: confirm (no changes) or save/submit (changes made). */
function onEditActionBtn() {
  if (_editHasChanges) {
    exitEditMode();
  } else {
    confirmEditCorrect();
  }
}

function _setEditChanged() {
  _editHasChanges = true;
  _updateEditActionBtn();
}

function _updateEditActionBtn() {
  const btn = document.getElementById('edit-action-btn');
  if (!btn) return;
  if (!_editHasChanges) {
    btn.textContent = 'Looks good ✓';
    btn.className = 'ghost';
  } else {
    btn.textContent = authCanDirectEdit() ? 'Save' : 'Send suggestion';
    btn.className = 'primary';
  }
}

function _updateEditDepthDisplay() {
  const el = document.getElementById('edit-depth-display');
  if (!el) return;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v || (v.terraceType && v.terraceType !== 'street')) { el.textContent = '—'; return; }
  const depth = getEffectiveDepth(v);
  el.textContent = `${Math.round(depth * 10) / 10} m`;
}

function _updateEditDirectionDisplay(v) {
  const el = document.getElementById('edit-direction-display');
  if (!el || !v) return;
  const type = v.terraceType ?? 'street';
  if (type === 'rooftop')   { el.textContent = 'Rooftop';   return; }
  if (type === 'courtyard') { el.textContent = 'Courtyard'; return; }
  if (type === 'detached')  { el.textContent = 'Detached';  return; }
  const walls = getTerraceWalls(v);
  el.textContent = walls.length ? bearingToCardinal(v.facing) : '—';
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

  // Primary wall = first selected; fallback to index 0
  const primaryIdx = v.terraceWallIndices[0] ?? 0;
  v.wallSegment    = v.wallNormals[primaryIdx];
  v.facing         = v.terraceWallIndices.length > 0 ? Math.round(v.wallSegment.bearing) : v.facing;
  v.facingSource   = 'manual';

  saveFacingCache(v.id, v.facing, 'manual', v.terraceWallIndices, v.terraceDepth ?? 7);
  clearSpriteCache();
  sunWindowCache.clear();
  _updateEditDirectionDisplay(v);
  _setEditChanged();
  dispatchToWorker(datePicker.value);
  draw();
  renderList();
}

const _TYPE_SUBTITLES = {
  street:    'Click walls to add/remove · drag ● to set depth',
  rooftop:   'Sun based on altitude only — no wall or shadow logic',
  courtyard: 'Sun reaches floor only at high altitude (~midday in summer)',
  detached:  'Click the map to place the terrace location',
};

function _syncTerraceTypeUI(type) {
  const sel = document.getElementById('edit-type-select');
  if (sel) sel.value = type;
  const instr = document.getElementById('edit-instruction');
  if (instr) instr.textContent = _TYPE_SUBTITLES[type] ?? _TYPE_SUBTITLES.street;
}

function setTerraceType(type) {
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v) return;
  v.terraceType = type;
  _syncTerraceTypeUI(type);

  if (type === 'rooftop' || type === 'courtyard') {
    v.terraceTestPoints = v.buildingGeometry?.length
      ? (() => { const c = computeCentroid(v.buildingGeometry); return [{ lat: c.lat, lng: c.lon }]; })()
      : [{ lat: v.lat, lng: v.lng }];
  } else if (type === 'detached') {
    if (!v.terraceDetachedLocation) v.terraceDetachedLocation = { lat: v.lat, lng: v.lng };
    v.terraceTestPoints = [{ ...v.terraceDetachedLocation }];
  } else {
    // street
    v.terraceTestPoints = computeTerraceTestPoints(v, null);
  }

  _updateEditDirectionDisplay(v);
  _updateEditDepthDisplay();
  _setEditChanged();

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

// Show handle on mobile init
let arcHoverH = null;

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
        _syncFtsPosition();
      }

      let _dragInitH = 0; // panel height at drag start (px)
      let _dragRafId = null;

      function _beginDrag(y) {
        if (_dragActive) return; // already initiated by a child element
        _dragY0         = y;
        _dragT0         = _panelTranslateNow();
        _dragActive     = true;
        _dragStartState = _currentState();
        _dragStartTime  = Date.now();
        _dragInitH      = panelEl.offsetHeight;
        panelEl.style.transition = 'none';
        panelEl.classList.add('panel-dragging');
      }

      let _ftsEl = null; // cache FTS element ref to avoid DOM lookup per frame
      function _trackDrag(y) {
        if (!_dragActive) return;
        if (_dragRafId) cancelAnimationFrame(_dragRafId);
        _dragRafId = requestAnimationFrame(() => {
          const dy = y - _dragY0;
          const newY = Math.min(_dragInitH - 80, _dragT0 + dy);
          // Use a single composite transform: translateY for position + scaleY to
          // stretch the panel downward when dragging up, avoiding style.height
          // which triggers synchronous layout recalc every frame.
          if (newY < _dragT0) {
            const extra = Math.abs(newY - _dragT0);
            const scale = (_dragInitH + extra) / _dragInitH;
            panelEl.style.transform = `translateY(${newY}px) scaleY(${scale})`;
            panelEl.style.transformOrigin = 'top center';
          } else {
            panelEl.style.transform = `translateY(${newY}px)`;
          }

          // Track pill with panel during drag
          if (USE_FLOATING_TIME_SLIDER) {
            if (!_ftsEl) _ftsEl = document.getElementById('fts');
            if (_ftsEl) {
              const panelTop = panelEl.getBoundingClientRect().top;
              const viewH    = window.innerHeight;
              _ftsEl.style.transition = 'none';
              _ftsEl.style.bottom = (viewH - panelTop + FTS_GAP) + 'px';
            }
          }

          _dragRafId = null;
        });
      }

      function _commitDrag(y) {
        if (!_dragActive) return;
        if (_dragRafId) cancelAnimationFrame(_dragRafId);
        _dragRafId = null;
        _dragActive   = false;
        _dragFromList = false;

        const dy       = y - _dragY0;
        const dt       = Math.max(1, Date.now() - _dragStartTime);
        const velocity = dy / dt; // px/ms, positive = downward

        panelEl.classList.remove('panel-dragging');
        panelEl.style.transition = '';
        panelEl.style.transform  = '';
        panelEl.style.transformOrigin = '';
        // Restore pill transition after drag
        if (!_ftsEl) _ftsEl = document.getElementById('fts');
        if (_ftsEl) { _ftsEl.style.transition = ''; _ftsEl.style.bottom = ''; }

        const SWIPE_V = 0.2, SAFE_DY = 40;
        let target;
        if      (velocity < -SWIPE_V)            target = _dragStartState === 'peek' ? 'expanded' : 'fullscreen';
        else if (velocity >  SWIPE_V)            target = _dragStartState === 'fullscreen' ? 'expanded' : 'peek'; // peek is the floor — no hidden via swipe
        else if (Math.abs(dy) <= SAFE_DY)        target = _dragStartState; // safe zone → snap back
        else if (dy < 0)                         target = _dragStartState === 'peek' ? 'expanded' : 'fullscreen';
        else                                     target = _dragStartState === 'fullscreen' ? 'expanded' : 'peek'; // peek is the floor

        _applyState(target);
      }

      // Wire a swipe target: touchstart/move/end → panel drag state machine
      // opts.excludeInteractive: skip drag when touch starts on a button/a/input/canvas
      // opts.tapToggle: if false, taps on this element don't toggle panel state (default true)
      function _wireSwipeTarget(el, opts = {}) {
        const _INTERACTIVE = 'button, a, input, select, textarea, canvas';
        el.addEventListener('touchstart', e => {
          if (opts.peekOnly && _currentState() !== 'peek') return;
          if (opts.excludeInteractive && e.target.closest(_INTERACTIVE)) return;
          if (opts.excludeSelector && e.target.closest(opts.excludeSelector)) return;
          _beginDrag(e.touches[0].clientY);
        }, { passive: true });

        el.addEventListener('touchmove', e => {
          if (!_dragActive) return;
          e.preventDefault();
          _trackDrag(e.touches[0].clientY);
        }, { passive: false });

        el.addEventListener('touchend', e => {
          if (!_dragActive) return;
          const totalDy = e.changedTouches[0].clientY - _dragY0;
          if (Math.abs(totalDy) < 10) {
            // Tap: toggle peek ↔ expanded (unless caller opted out)
            _dragActive = false;
            panelEl.classList.remove('panel-dragging');
            panelEl.style.transition = '';
            panelEl.style.transform  = '';
            panelEl.style.transformOrigin = '';
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
      }

      // Wire drag targets: handle + time bar + venue-peek + panel-header + sun-count header
      _wireSwipeTarget(h);
      const timeBar      = document.getElementById('panel-time-bar');
      const listSunHdr   = document.getElementById('list-sun-header');
      const venuePeek    = document.getElementById('venue-peek');
      const panelHeader  = document.getElementById('panel-header');
      if (timeBar)    _wireSwipeTarget(timeBar,    { excludeInteractive: true, tapToggle: false });
      if (listSunHdr) _wireSwipeTarget(listSunHdr, { excludeInteractive: true });
      if (venuePeek)  _wireSwipeTarget(venuePeek);
      if (panelHeader) _wireSwipeTarget(panelHeader);

      // Catch-all: wire the panel itself for peek state so any gap between child
      // elements (handle, sun-header, venue-peek) is also draggable. The peekOnly
      // guard prevents interference with venue-list scrolling in expanded state.
      // _beginDrag's own guard prevents double-fire when a child already started drag.
      _wireSwipeTarget(panelEl, { peekOnly: true, excludeInteractive: true, excludeSelector: '#venue-list' });

      // ── First-run nudge: bounce sheet up 20px after 800ms, once only ──────
      if (!localStorage.getItem('sol_peek_nudged')) {
        setTimeout(() => {
          if (_currentState() === 'peek') {
            panelEl.style.transition = 'transform 220ms ease-out';
            panelEl.style.transform  = 'translateY(-20px)';
            setTimeout(() => {
              panelEl.style.transform = '';
              setTimeout(() => { panelEl.style.transition = ''; }, 240);
            }, 300);
          }
          localStorage.setItem('sol_peek_nudged', '1');
        }, 800);
      }

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

      // ── Venue list: finger scrolling up past the venue-header zone → drag panel ──
      // When the finger crosses into the venue-header area while scrolling the list,
      // the panel starts following the finger (both up and down). Release logic:
      //   safe zone (< SAFE_DY from start) → snap back; outside → advance/retreat state.
      const venueList = document.getElementById('venue-list');
      if (venueList) {
        let _listStartY = 0, _venueHeaderBottom = 0;
        venueList.addEventListener('touchstart', e => {
          _listStartY = e.touches[0].clientY;
          // Cache header bottom once so touchmove never triggers getBoundingClientRect
          const headerEl = document.getElementById('venue-header') ?? document.getElementById('sort-row');
          _venueHeaderBottom = headerEl ? headerEl.getBoundingClientRect().bottom : 0;
        }, { passive: true });

        venueList.addEventListener('touchmove', e => {
          const cy = e.touches[0].clientY;
          if (!_dragActive) {
            if (venueList.scrollTop === 0) {
              if (cy < _listStartY) {
                // Moving up at top → trigger drag (and prevent default) only once in header zone
                if (cy <= _venueHeaderBottom) {
                  e.preventDefault();
                  _dragFromList = true;
                  _beginDrag(cy);
                }
              } else if (cy > _listStartY) {
                // Moving down at top → pull-to-dismiss
                e.preventDefault();
                _dragFromList = true;
                _beginDrag(cy);
              }
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
      if (panelEl && !panelEl.classList.contains('mobile-hidden')) {
        panelEl.classList.remove('mobile-expanded', 'mobile-fullscreen');
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
        // Cancel any pending frame and schedule a new one for smooth 60fps updates
        if (_dpRafId) cancelAnimationFrame(_dpRafId);
        _dpRafId = requestAnimationFrame(() => {
          const dy = _dpLastFrameY - _dpY0;
          // When initiated from scroll, clamp to downward-only (dismiss only, no expand)
          const clampedDy = _dpFromScroll ? Math.max(0, dy) : dy;
          dpEl.style.transform = `translateY(${clampedDy}px)`;

          // Expand panel height when dragging up to fill the space (prevent showing background)
          if (clampedDy < 0) {
            dpEl.style.height = `${_dpInitH + Math.abs(clampedDy)}px`;
          } else {
            dpEl.style.height = '';
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

        const dy       = y - _dpY0;
        const dt       = Math.max(1, Date.now() - _dpStartTime);
        const velocity = dy / dt;
        const SWIPE_V  = 0.2, SAFE_DY = 40;

        if (Math.abs(dy) <= SAFE_DY && Math.abs(velocity) < SWIPE_V) return; // safe zone

        if (velocity < -SWIPE_V || dy < -SAFE_DY) {
          if (_dpStartState === 'normal') { dpEl.classList.add('dp-fullscreen'); _navPush('dp-fullscreen'); _syncFtsPosition(); }
        } else if (velocity > SWIPE_V || dy > SAFE_DY) {
          if (_dpStartState === 'fullscreen') { dpEl.classList.remove('dp-fullscreen'); _navDropLayer('dp-fullscreen'); _syncFtsPosition(); }
          else closeDetailPanel(false);
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

      // dp-scroll: no drag interception — content scrolls normally.
      // Only the dp-handle area (above the gallery) triggers panel drag.
    }
  }

  // Position preset buttons after layout settles, then again on resize
  setTimeout(positionPresetButtons, 80);
  new ResizeObserver(() => positionPresetButtons()).observe(document.getElementById('sun-curve') ?? document.body);

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
  window.addEventListener('resize', () => { _syncQcPanelHeight(); _updatePeekHeight(); _syncFtsPosition(); });
  setTimeout(() => { _syncQcPanelHeight(); _updatePeekHeight(); }, 600);

  // qc-arc drag + hover support
  const qcArcEl = document.getElementById('qc-arc');
  if (qcArcEl) {
    qcArcEl.addEventListener('mousedown', e => {
      _qcArcDragging = true;
      window._qcThumbActive = true;
      // Animate to clicked position; drag mousemove will cancel if user starts dragging
      const rect = qcArcEl.getBoundingClientRect();
      const t    = MIN_H_ARC + (e.clientX - rect.left) / rect.width * (MAX_H_ARC - MIN_H_ARC); // bar fills edge-to-edge
      const hour = _clampHour(t);
      if (nowMode) {
        nowMode = false;
        nowBtn?.classList.remove('active');
        timeRangeWrap?.classList.remove('now-active');
        clearInterval(nowInterval); nowInterval = null;
      }
      setActiveIntentBtn(null);
      animateToTime(hour, 280);
      drawTimeBar(qcArcEl);
    });
    qcArcEl.addEventListener('touchstart', e => {
      e.preventDefault();
      window._qcThumbActive = true;
      _qcArcSetTimeFromX(e.touches[0].clientX);
      drawTimeBar(qcArcEl);
    }, { passive: false });
    qcArcEl.addEventListener('touchmove',  e => { e.preventDefault(); _qcArcSetTimeFromX(e.touches[0].clientX); }, { passive: false });
    qcArcEl.addEventListener('touchend', e => {
      const lastX = e.changedTouches[0]?.clientX;
      window._qcThumbActive = false;
      drawTimeBar(qcArcEl);
      // Spring back if touch released in past region
      if (lastX != null && datePicker.value === todayStr()) {
        const rect = qcArcEl.getBoundingClientRect();
        const raw  = MIN_H_ARC + (lastX - rect.left) / rect.width * (MAX_H_ARC - MIN_H_ARC);
        const nh   = new Date().getHours() + new Date().getMinutes() / 60;
        if (raw < nh) _qcSpringBackThumb(qcArcEl);
      }
    }, { passive: true });
    qcArcEl.addEventListener('mousemove',  e => {
      if (_qcArcDragging) return;
      const rect = qcArcEl.getBoundingClientRect();
      const t = MIN_H_ARC + (e.clientX - rect.left) / rect.width * (MAX_H_ARC - MIN_H_ARC);
      arcHoverH = _clampHour(t);
      drawTimeBar(qcArcEl);
      updateQcIndicator(arcHoverH);
    });
    qcArcEl.addEventListener('mouseleave', () => { arcHoverH = null; drawTimeBar(qcArcEl); updateQcIndicator(null); });
  }

  // Arc canvas drag + hover support
  const arcEl = document.getElementById('sun-curve');
  if (arcEl) {
    arcEl.addEventListener('mousedown',  e => { _arcDragging = true;  _arcSetTimeFromX(e.clientX); });
    arcEl.addEventListener('touchstart', e => { e.preventDefault(); _arcSetTimeFromX(e.touches[0].clientX); }, { passive: false });
    arcEl.addEventListener('touchmove',  e => { e.preventDefault(); _arcSetTimeFromX(e.touches[0].clientX); }, { passive: false });
    arcEl.addEventListener('mousemove',  e => {
      if (_arcDragging) return; // dragging handled separately
      const rect = arcEl.getBoundingClientRect();
      const t = MIN_H_ARC + (e.clientX - rect.left - PAD_X_ARC) / (rect.width - PAD_X_ARC * 2) * (MAX_H_ARC - MIN_H_ARC);
      arcHoverH = _clampHour(t);
      drawSunCurve(arcEl);
    });
    arcEl.addEventListener('mouseleave', () => {
      arcHoverH = null;
      drawSunCurve(arcEl);
    });
  }
  document.addEventListener('mousemove', e => {
    if (_arcDragging)    _arcSetTimeFromX(e.clientX);
    if (_qcArcDragging) _qcArcSetTimeFromX(e.clientX);
  });
  document.addEventListener('mouseup', e => {
    const wasQcDragging = _qcArcDragging;
    _arcDragging = false; _qcArcDragging = false;
    if (window._qcThumbActive) {
      window._qcThumbActive = false;
      const canvasEl = document.getElementById('qc-arc');
      if (canvasEl) drawTimeBar(canvasEl);
      // Spring back if released in past region
      if (wasQcDragging && canvasEl && datePicker.value === todayStr()) {
        const rect = canvasEl.getBoundingClientRect();
        const raw  = MIN_H_ARC + (e.clientX - rect.left) / rect.width * (MAX_H_ARC - MIN_H_ARC);
        const nh   = new Date().getHours() + new Date().getMinutes() / 60;
        if (raw < nh) _qcSpringBackThumb(canvasEl);
      }
    }
  });

  // Close sort panel when clicking outside it
  document.addEventListener('click', e => {
    const btn   = document.getElementById('sort-toggle-btn');
    const panel = document.getElementById('sort-panel');
    if (panel?.classList.contains('open') && !btn?.contains(e.target) && !panel?.contains(e.target)) {
      _closeSortPanel();
    }
    // Close date calendar when clicking outside it
    const cal       = document.getElementById('date-calendar');
    const dateArea  = document.getElementById('floating-date');
    const displayBtn = document.getElementById('date-display-btn');
    if (cal?.classList.contains('open') && !dateArea?.contains(e.target)) {
      cal.classList.remove('open');
      displayBtn?.classList.remove('open');
    }
    // Close calendar when clicking outside the float AND outside the date button
    const qcPanel   = document.getElementById('qc-panel');
    const calFloat  = document.getElementById('ptb-cal-float');
    const dateBtn   = document.getElementById('readout-date-btn');
    if (qcPanel?.classList.contains('open')
        && !calFloat?.contains(e.target)
        && !dateBtn?.contains(e.target)) {
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
        _introCenter   = [pos.coords.longitude, pos.coords.latitude];
        _introGeoReady = true;
        _introCheckReady();
        renderList();
      }
      _updateLocationDot();
    };
    const _onGeoErr = () => {
      if (!userLocation) { _introGeoReady = true; _introCheckReady(); }
    };
    // watchPosition keeps the dot fresh as the user moves
    navigator.geolocation.watchPosition(_onGeoPos, _onGeoErr,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    // Fallback: if geolocation never settles, proceed after 5 seconds
    setTimeout(() => {
      if (!_introGeoReady) {
        _introGeoReady = true;
        _introCheckReady();
      }
    }, 5000);
  } else {
    _introGeoReady = true;
    _introCheckReady();
  }
});

function toggleMapView() {
  filterMapViewActive = !filterMapViewActive;
  document.getElementById('map-view-btn').classList.toggle('active', filterMapViewActive);
  renderList();
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
  // Debounced analytics for map moves (5 s)
  clearTimeout(_aMapMoveTimer);
  _aMapMoveTimer = setTimeout(() => {
    const b = map.getBounds();
    _aTrack('map_move', {
      zoom: Math.round(map.getZoom() * 10) / 10,
      center: [+(map.getCenter().lng.toFixed(4)), +(map.getCenter().lat.toFixed(4))],
    });
  }, 5000);

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
  if (datePicker.value !== todayStr() && nowMode) {
    nowMode = false;
    clearInterval(nowInterval); nowInterval = null;
    nowBtn?.classList.remove('active');
    timeRangeWrap?.classList.remove('now-active');
    timeFromEl.value = 12;
  }
  update();
});

let _lastSliderStep = null;
timeFromEl.addEventListener('input', () => {
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  if (nowMode) {
    nowMode = false;
    nowBtn.classList.remove('active');
    timeRangeWrap.classList.remove('now-active');
    clearInterval(nowInterval); nowInterval = null;
  }
  setActiveIntentBtn(null);
  updateRangeFill();
  update();
});

// ── Oslo candidate index (lazy-loaded on first search miss) ───────────────────

let _candidates = null;          // null = not yet loaded; [] = loaded, empty
let _candidatesLoading = false;

async function _ensureCandidates() {
  if (_candidates !== null || _candidatesLoading) return;
  _candidatesLoading = true;
  try {
    const resp = await fetch('data/oslo-candidates.json');
    _candidates = resp.ok ? await resp.json() : [];
  } catch (_) {
    _candidates = [];
  }
  _candidatesLoading = false;
}

// ── Search dropdown (live results under the search bar) ───────────────────────

const _searchInput    = document.getElementById('venue-search');
const _searchDropdown = document.getElementById('search-dropdown');

// ── Geocoding (addresses / areas via Mapbox) ─────────────────────────────────

let _geoResults  = [];      // cached geocoding results for the current query
let _geoTimer    = null;    // debounce timer
let _geoQuery    = '';      // last query sent to geocoder
let _geoMarker   = null;    // mapboxgl.Marker for address pins
let _geoAreaShown = false;  // whether an area highlight source/layer is active

const _GEO_ICON = {
  address: '<svg class="sd-icon" viewBox="0 0 16 16"><path d="M8 1C5.24 1 3 3.24 3 6c0 3.75 5 9 5 9s5-5.25 5-9c0-2.76-2.24-5-5-5Zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" fill="currentColor"/></svg>',
  area:    '<svg class="sd-icon" viewBox="0 0 16 16"><path d="M2 4h4v4H2V4Zm4 4h4v4H6V8Zm4-4h4v4h-4V4Z" fill="currentColor" opacity="0.7"/><rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>',
  venue:   '<svg class="sd-icon" viewBox="0 0 16 16"><circle cx="8" cy="6" r="2.5" fill="currentColor"/><path d="M4 13c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>',
};

function _geoTypeIcon(type) {
  if (type === 'address' || type === 'poi') return _GEO_ICON.address;
  if (type === 'neighborhood' || type === 'locality' || type === 'place' || type === 'district' || type === 'region') return _GEO_ICON.area;
  return _GEO_ICON.address;
}

function _isAreaType(type) {
  return ['neighborhood', 'locality', 'place', 'district', 'region'].includes(type);
}


async function _fetchGeocode(query) {
  if (!MAPBOX_TOKEN || query.length < 2) return [];
  try {
    const center = map.getCenter();
    const bbox = '10.4,59.75,11.0,60.1'; // Greater Oslo area
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
      `?access_token=${MAPBOX_TOKEN}` +
      `&bbox=${bbox}` +
      `&proximity=${center.lng.toFixed(4)},${center.lat.toFixed(4)}` +
      `&limit=4&language=no` +
      `&types=neighborhood,locality,place,address,poi`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.features || []).map(f => ({
      name:   f.text,
      full:   f.place_name,
      center: f.center, // [lng, lat]
      bbox:   f.bbox,   // [w, s, e, n] — may be null for addresses
      type:   f.place_type?.[0] || 'address',
      geometry: f.geometry,
      relevance: f.relevance ?? 0, // Mapbox relevance score (0–1)
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
    // Re-render if the user hasn't changed the input
    if (_searchInput.value.trim().toLowerCase() === query) _renderSearchDropdown(true);
  }, 400);
}

function _removeGeoMarker() {
  if (_geoMarker) { _geoMarker.remove(); _geoMarker = null; }
  if (_geoAreaShown && map.getLayer('geo-area-fill')) {
    map.removeLayer('geo-area-fill');
    map.removeLayer('geo-area-outline');
    map.removeSource('geo-area');
    _geoAreaShown = false;
  }
}

function _sdPickGeo(idx) {
  const g = _geoResults[idx];
  if (!g) return;
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  _removeGeoMarker();

  if (_isAreaType(g.type) && g.bbox) {
    // Area: fit bounds
    map.fitBounds([[g.bbox[0], g.bbox[1]], [g.bbox[2], g.bbox[3]]], {
      padding: { top: 80, bottom: 80, left: 40, right: 40 },
      duration: 800,
    });
  } else {
    // Address/POI: zoom in and drop a pin
    map.flyTo({ center: g.center, zoom: 16.5, duration: 800 });

    const el = document.createElement('div');
    el.className = 'geo-pin';
    el.innerHTML = '<svg viewBox="0 0 24 36" width="24" height="36"><path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 24 12 24s12-15 12-24C24 5.37 18.63 0 12 0Zm0 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z" fill="var(--accent)"/></svg>';
    _geoMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat(g.center)
      .addTo(map);
  }
  renderList();
}

// ── Search relevance scoring ─────────────────────────────────────────────────

/**
 * Score how well `text` matches query `q` (both lowercase).
 * Higher = better match.  0 = no match.
 *   100  exact match
 *    80  text starts with q
 *    60  word inside text starts with q
 *    40  q appears anywhere inside text (contains)
 */
function _matchScore(text, q) {
  if (!text) return 0;
  if (text === q)               return 100;
  if (text.startsWith(q))       return 80;
  // word-boundary: space, hyphen, comma before q
  if (text.match(new RegExp(`[\\s,\\-]${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))) return 60;
  if (text.includes(q))         return 40;
  return 0;
}

/** Score a venue against the query, checking name, area, and address. */
function _venueMatchScore(v, q) {
  const name = _matchScore(v.name.toLowerCase(), q);
  const area = _matchScore((v.area ?? '').toLowerCase(), q);
  const addr = _matchScore(v.address.toLowerCase(), q);
  return Math.max(name, area, addr);
}

// ── Search dropdown rendering ────────────────────────────────────────────────

function _renderSearchDropdown(geoOnly) {
  const q = _searchInput.value.trim().toLowerCase();
  console.log('[_renderSearchDropdown] Query:', q, 'geoOnly:', geoOnly);
  if (!q) { _searchDropdown.classList.remove('open'); return; }

  const MAX_RESULTS = 8;

  // ── Collect all result types with scores ────────────────────────────────
  // Each entry: { kind, score, data }

  const scored = [];

  // Curated venues
  for (const v of (VENUES || [])) {
    const s = _venueMatchScore(v, q);
    if (s > 0) scored.push({ kind: 'curated', score: s, data: v });
  }

  // Candidate venues (exclude names already in VENUES)
  const curatedNames = new Set(VENUES.map(v => v.name.toLowerCase()));
  for (const c of (_candidates ?? [])) {
    if (curatedNames.has(c.name.toLowerCase())) continue;
    const s = _matchScore(c.name.toLowerCase(), q);
    if (s > 0) scored.push({ kind: 'candidate', score: s, data: c });
  }

  // Geocoded results (areas, addresses, POIs from Mapbox)
  // Give geo-area results a bonus so "Frogner" the neighborhood ranks above
  // restaurants with "Frogner" in the name when it's an exact or starts-with match.
  const allNames = new Set(scored.map(r => (r.data.name || '').toLowerCase()));
  for (let i = 0; i < (_geoResults || []).length; i++) {
    const g = _geoResults[i];
    if (allNames.has(g.name.toLowerCase())) continue; // dedup
    // Use Mapbox relevance (0–1) to compute a score compatible with our scale.
    // A high-relevance exact area match should outscore venue "contains" matches.
    const nameScore = _matchScore(g.name.toLowerCase(), q);
    const base = nameScore > 0 ? nameScore : Math.round((g.relevance || 0) * 60);
    if (base === 0) continue;
    // Area bonus: +5 for neighborhoods/places so they float above venue
    // "contains" matches at the same score tier
    const bonus = _isAreaType(g.type) ? 5 : 0;
    scored.push({ kind: 'geo', score: base + bonus, data: g, geoIdx: i });
  }


  // Sort by score descending, then alphabetically for ties
  scored.sort((a, b) => b.score - a.score || (a.data.name || '').localeCompare(b.data.name || '', 'no'));

  // Limit total results
  const results = scored.slice(0, MAX_RESULTS);
  console.log('[_renderSearchDropdown] Results:', results.length, 'scored:', scored.length, 'curated:', VENUES.length, 'candidates:', _candidates?.length ?? 'loading', 'geo:', _geoResults.length);

  // ── Render rows ─────────────────────────────────────────────────────────

  let html = results.map(r => {
    if (r.kind === 'curated') {
      const v = r.data;
      return `
      <div class="sd-row" onclick="_sdPick(${JSON.stringify(v.id)})">
        <span class="sd-row-icon">${_GEO_ICON.venue}</span>
        <span class="sd-row-name">${v.name}</span>
        ${v.area ? `<span class="sd-row-area">${v.area}</span>` : ''}
      </div>`;
    }
    if (r.kind === 'candidate') {
      const c = r.data;
      const cData = encodeURIComponent(JSON.stringify(c));
      return `
      <div class="sd-row sd-row-candidate" onclick="_sdPickCandidate(decodeURIComponent('${cData}'))">
        <span class="sd-row-icon">${_GEO_ICON.venue}</span>
        <span class="sd-row-name">${c.name}</span>
        <span class="sd-candidate-btn">${t('candidate_badge')}</span>
      </div>`;
    }
    // geo
    const g = r.data;
    const i = r.geoIdx;
    return `
    <div class="sd-row sd-row-geo" onclick="_sdPickGeo(${i})">
      <span class="sd-row-icon">${_geoTypeIcon(g.type)}</span>
      <span class="sd-row-name">${g.name}</span>
      <span class="sd-row-area">${_geoSubtext(g)}</span>
    </div>`;
  }).join('');

  const noMatch = results.length === 0;
  const rawQ    = _searchInput.value.trim();
  const label   = noMatch
    ? `${t('no_results_for')} "<strong>${rawQ}</strong>"`
    : t('not_seeing_venue');
  html += `<div class="sd-suggest-row">
    <span class="sd-suggest-label">${label}</span>
    <button class="sd-suggest-btn" onclick="_sdSuggest()">${t('suggest_venue')}</button>
  </div>`;

  _searchDropdown.innerHTML = html;
  _searchDropdown.classList.add('open');

  // Kick off candidate loading in the background if not yet loaded
  if (_candidates === null) _ensureCandidates().then(() => {
    if (_searchInput.value.trim()) _renderSearchDropdown();
  });

  // Kick off geocoding (debounced)
  if (!geoOnly) _debounceGeocode(q);
}

function _geoSubtext(g) {
  // Extract a short context from the full place name (remove the matched name prefix)
  const parts = (g.full || '').split(', ');
  return parts.length > 1 ? parts.slice(1, 3).join(', ') : g.type;
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

  // ── Fly to the venue ─────────────────────────────────────────────────────
  if (typeof map !== 'undefined') {
    map.flyTo({ center: [c.lng, c.lat], zoom: Math.max(map.getZoom(), 17), duration: 1000 });
  }

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

  // ── Step 2: Show "estimating sun" ────────────────────────────────────────
  _setStatus('loading_sun');

  // Add to VENUES temporarily so computeSunWindows and the rest works
  VENUES.push(enriched);
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

let _searchListTimer = null;
_searchInput.addEventListener('input', () => {
  _syncSearchClearBtn();
  // Render dropdown immediately (lightweight filter) but debounce the
  // expensive renderList() which runs solar math on every venue.
  _renderSearchDropdown();
  clearTimeout(_searchListTimer);
  _searchListTimer = setTimeout(renderList, 300);
});
_searchInput.addEventListener('blur',  () => setTimeout(() => _searchDropdown.classList.remove('open'), 150));
_searchInput.addEventListener('focus', () => { if (_searchInput.value.trim()) _renderSearchDropdown(); });

// Clear button
document.getElementById('search-clear-btn')?.addEventListener('click', () => {
  _searchInput.value = '';
  _syncSearchClearBtn();
  _searchDropdown.classList.remove('open');
  _removeGeoMarker();
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
  if (row) { e.preventDefault(); row.click(); }
}, { passive: false });

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
    console.log('[suggestVenueFlow] Looking up:', searchQuery);
    const resp = await fetch(proxyUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.status === 'OK' && data.results?.length) {
        results = data.results;
        console.log('[suggestVenueFlow] Found', results.length, 'results');
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
    <div class="suggest-result-row" onclick="_sdSelectSuggestVenue(${i}, ${encodeURIComponent(JSON.stringify(results))})">
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

  const dataAttr = encodeURIComponent(JSON.stringify({ name, address, lat, lng, osmId }));

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
        <div style="display:flex;gap:8px">
          ${user
            ? `<button class="suggest-btn suggest-btn-primary" style="flex:1" onclick="_submitSuggestion('${dataAttr}')">Yes, suggest it →</button>`
            : `<a class="suggest-btn suggest-btn-primary" style="flex:1;text-align:center" href="${issueUrl}" target="_blank" rel="noopener"
                 onclick="setTimeout(()=>document.getElementById('suggest-modal')?.remove(),300)">Yes, suggest it →</a>`
          }
          <button class="suggest-btn" onclick="document.getElementById('suggest-modal').remove()">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// Submits to Supabase when user is logged in
async function _submitSuggestion(dataAttrEncoded) {
  const { name, address, lat, lng, osmId } = JSON.parse(decodeURIComponent(dataAttrEncoded));

  const modal = document.getElementById('suggest-modal');
  const btn = modal?.querySelector('.suggest-btn-primary');
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
 * Restore date/time/venue saved by authSignInWithGoogle() before the OAuth redirect.
 * Called only on OAuth return, after _skipIntro() has already snapped the UI to now.
 */
function _restorePreAuthState() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('solsteder_auth_restore') ?? 'null'); } catch (_) {}
  if (!saved) return;
  sessionStorage.removeItem('solsteder_auth_restore');

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
  update();

  if (saved.venueId != null) {
    // Small delay: let auth state settle and list render before opening the panel
    setTimeout(() => { if (typeof selectVenue === 'function') selectVenue(saved.venueId, true); }, 300);
  }
}

function _introCheckReady() {
  if (_introMapReady && _introGeoReady && !_introRunning) {
    _introRunning = true;
    // Skip intro animation if this is an OAuth redirect return
    const isOAuthReturn = window.location.hash.includes('access_token=') ||
                          new URLSearchParams(window.location.search).has('code');
    if (isOAuthReturn) { _skipIntro(); _restorePreAuthState(); return; }

    // If opened via a share link, focus on that venue at the sender's time.
    // New format: #venue-name-<id>/20260420T16
    // Old format (backward compat): #v=<id>&d=YYYY-MM-DD&t=<hour>
    const hash = window.location.hash.slice(1);

    // Handle friend invite link: #friend/<userId>
    if (hash.startsWith('friend/')) {
      const friendUserId = hash.slice(7);
      if (friendUserId) {
        window._pendingFriendInvite = friendUserId;
        // Process after auth is ready
        const _tryFriendInvite = () => {
          if (typeof authCurrentUser !== 'function') return;
          const user = authCurrentUser();
          if (!user) return; // Will re-check on auth state change
          if (user.id !== friendUserId && typeof sendFriendRequest === 'function') {
            // Use direct insert by ID instead of email lookup
            _supabase.from('friendships').upsert({
              user_id: friendUserId,
              friend_id: user.id,
              status: 'pending'
            }, { onConflict: 'user_id,friend_id' }).then(() => {
              if (typeof _showToast === 'function') _showToast(t('friend_request_sent'));
              if (typeof loadFriends === 'function') loadFriends();
            });
          }
          window._pendingFriendInvite = null;
          history.replaceState(null, '', location.pathname);
        };
        // Try now, and also on auth change
        setTimeout(_tryFriendInvite, 1500);
      }
    }

    // Handle plan/checkin invite link: #invite/<base64data>
    if (hash.startsWith('invite/')) {
      try {
        const data = JSON.parse(atob(hash.slice(7)));
        window._pendingInvite = data;
        const _tryInvite = () => {
          if (typeof authCurrentUser !== 'function') return;
          const user = authCurrentUser();
          if (!user) return;
          const d = window._pendingInvite;
          if (!d) return;
          // Auto-friend if not already friends
          if (d.u && d.u !== user.id) {
            _supabase.from('friendships').upsert({
              user_id: d.u,
              friend_id: user.id,
              status: 'accepted'
            }, { onConflict: 'user_id,friend_id' }).then(() => {
              if (typeof loadFriends === 'function') loadFriends();
            });
          }
          // If it's a "going" invite, accept the plan
          if (d.v && d.t && d.type !== 'here') {
            // Open the venue
            const venue = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === d.v) : null;
            if (venue && typeof selectVenue === 'function') selectVenue(d.v, true);
          }
          // If it's a "here" checkin link, just open the venue
          if (d.v && d.type === 'here') {
            const venue = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === d.v) : null;
            if (venue && typeof selectVenue === 'function') selectVenue(d.v, true);
          }
          window._pendingInvite = null;
          history.replaceState(null, '', location.pathname);
        };
        setTimeout(_tryInvite, 1500);
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

    _runIntroSequence();
  }
}

function _runIntroSequence() {
  const seqId  = ++_introSeqId;
  const splash = document.getElementById('splash');
  const canvas = document.getElementById('canvas-overlay');
  const search = document.getElementById('floating-search');
  const brand  = document.getElementById('floating-brand');
  const qcWrap = document.getElementById('qc-wrap');
  const panel  = document.getElementById('panel');

  // Ensure sun table exists (it's built by update(), which may not have run yet)
  if (!currentSunTable) {
    currentSunTable = buildSunTable(datePicker.value);
    currentDateStr  = datePicker.value;
  }

  // Compute intro time range: use "day" light preset boundaries (sunrise+1.5h to sunset-1.5h)
  // This ensures consistent color lighting throughout the year as sun position changes
  const sunrise = findSunCrossingFromTable(currentSunTable, true);
  const sunset = findSunCrossingFromTable(currentSunTable, false);
  const introStartTime = sunrise && sunrise + 1.5 > 4 ? sunrise + 1.5 : 7.25;  // fallback to 07:15
  const introEndTime = sunset && sunset - 1.5 < 22 ? sunset - 1.5 : 17.25;      // fallback to 17:15
  const now = currentHour();

  // Set time to intro start and render shadows at that time
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }
  timeFromEl.value = introStartTime;
  update();

  // Position map at user location — instant, before splash fades
  // Pitch will gradually increase to 45° during step 2
  map.jumpTo({ center: _introCenter, zoom: 15, pitch: 0, bearing: 0 });

  // Enable skip after the splash has faded
  let skipEnabled = false;
  const skipHandler = () => {
    if (!skipEnabled || _introSeqId !== seqId) return;
    _skipIntro(seqId);
  };
  document.addEventListener('click', skipHandler);
  document.addEventListener('touchstart', skipHandler);

  // How long has the splash been visible? Wait at least SPLASH_MIN_MS
  const elapsed = performance.now() - _splashStart;
  const waitMs  = Math.max(0, SPLASH_MIN_MS - elapsed);

  const loader    = document.getElementById('splash-loader');
  const splashLogo = document.getElementById('splash-logo');

  // After minimum branded time, begin the layered splash exit
  setTimeout(() => {
    if (_introSeqId !== seqId) return;

    // Phase 1: If loader is visible, fade it out first (300ms)
    const loaderVisible = loader && loader.classList.contains('visible');
    if (loaderVisible) loader.classList.add('fade-out');
    const loaderFadeMs = loaderVisible ? 300 : 0;

    setTimeout(() => {
      if (_introSeqId !== seqId) return;

      // Phase 2: Fade out the background (500ms CSS transition)
      splash.classList.add('bg-out');

      // Phase 3: At ~50% background opacity (250ms), start the map intro
      setTimeout(() => {
        if (_introSeqId !== seqId) return;
        skipEnabled = true;

        // Step 2: Scrub time + zoom in + tilt up (all concurrent)
        animateToTime(introEndTime, 1800);
        map.easeTo({ zoom: 16, pitch: 60, duration: 1800, easing: t => t * t * (3 - 2 * t) });

        // Step 3: Zoom out + detilt (starts when step 2 ends)
        setTimeout(() => {
          if (_introSeqId !== seqId) return;
          map.easeTo({ zoom: 15.2, pitch: 15, bearing: 0, duration: 700 });
          _introRevealUI(search, brand, qcWrap, panel);

          // Step 4: Return to current time
          setTimeout(() => {
            if (_introSeqId !== seqId) return;
            animateToTime(now, 1200);
          }, 500);

          // Step 5: Fade in pins
          setTimeout(() => {
            if (_introSeqId !== seqId) return;
            canvas.style.transition = 'opacity 0.4s ease';
            canvas.classList.remove('intro-hidden');

            setTimeout(() => {
              if (_introSeqId !== seqId) return;
              if (_sharedHour === null) _activateNowMode();
              update();
              document.removeEventListener('click', skipHandler);
              document.removeEventListener('touchstart', skipHandler);
              if (_sharedVenueId) selectVenue(_sharedVenueId, true);
            }, 350);
          }, 700);
        }, 1900);
      }, 250);

      // Phase 4: Fade out logo during zoom-in (~860ms after bg fade starts)
      setTimeout(() => {
        if (splashLogo) splashLogo.classList.add('fade-out');
      }, 860);

      // Phase 5: Fully remove splash after logo has faded (860 + 400ms transition)
      setTimeout(() => {
        splash.classList.add('done');
      }, 1300);

    }, loaderFadeMs);
  }, waitMs);
}

function _introRevealUI(search, brand, qcWrap, panel) {
  const locateBtn   = document.getElementById('locate-btn');
  const isMobile    = window.innerWidth < 640;

  const fadeEls = [search, brand, qcWrap, locateBtn];
  if (!isMobile && panel) fadeEls.push(panel);

  fadeEls.forEach(el => {
    if (!el) return;
    el.style.transition = 'opacity 0.5s ease';
    requestAnimationFrame(() => {
      el.classList.remove('intro-hidden');
      // Restore CSS transitions after fade so subsequent animations (height, transform) still work
      setTimeout(() => { el.style.transition = ''; }, 600);
    });
  });

  if (panel && isMobile) {
    // Mobile: slide up from off-screen — translateY(100%) → natural position (peek state)
    panel.style.transition = 'none';
    panel.style.opacity    = '1';
    panel.style.transform  = 'translateY(100%)';
    panel.classList.remove('intro-hidden');
    _updatePeekHeight();                         // measure with correct content
    panel.getBoundingClientRect();                // force reflow — browser commits start state
    panel.style.transition = 'transform 0.65s cubic-bezier(0.2, 0.8, 0.3, 1)';
    panel.style.transform  = '';
  }

  if (USE_FLOATING_TIME_SLIDER) {
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
}

function _skipIntro(seqId) {
  if (seqId !== undefined && _introSeqId !== seqId) return;
  ++_introSeqId; // invalidate all pending timeouts

  const splash = document.getElementById('splash');
  const canvas = document.getElementById('canvas-overlay');
  const search = document.getElementById('floating-search');
  const brand  = document.getElementById('floating-brand');
  const qcWrap = document.getElementById('qc-wrap');
  const panel  = document.getElementById('panel');

  // Cancel time animation
  if (_timeAnimId) { cancelAnimationFrame(_timeAnimId); _timeAnimId = null; }

  // Set time to shared time (if share link) or now, and activate now mode if appropriate.
  // If the date was auto-advanced to tomorrow (after-sunset), keep the 12:00 default
  // that advanceDay() already set — don't overwrite it with the current real hour.
  if (_sharedHour !== null) {
    timeFromEl.value = _sharedHour;
  } else if (datePicker.value === todayStr()) {
    timeFromEl.value = Math.min(23, Math.max(4, currentHour()));
    _activateNowMode();
  }
  // else: date already advanced to tomorrow by auto-advance — leave timeFromEl as-is (12:00)
  update();

  // Snap map to default view (centered on user location or Oslo)
  map.stop();
  map.easeTo({ center: _introCenter, zoom: 15.2, pitch: 15, bearing: 0, duration: 400 });

  // Instantly hide splash
  splash.style.transition = 'none';
  splash.classList.add('bg-out', 'done');
  const splashLogo = document.getElementById('splash-logo');
  const loader = document.getElementById('splash-loader');
  if (splashLogo) { splashLogo.style.transition = 'none'; splashLogo.classList.add('fade-out'); }
  if (loader) { loader.style.transition = 'none'; loader.classList.add('fade-out'); }

  // Instantly reveal all UI
  const locateBtnEl = document.getElementById('locate-btn');
  const ftsEl = document.getElementById('fts');
  [canvas, search, brand, qcWrap, panel, locateBtnEl, ftsEl].forEach(el => {
    if (!el) return;
    el.style.transition = 'none';
    el.classList.remove('intro-hidden');
    // Allow styles to reset on next frame
    requestAnimationFrame(() => { el.style.transition = ''; });
  });

  _updatePeekHeight();
  if (USE_FLOATING_TIME_SLIDER) requestAnimationFrame(() => syncFts());

  if (_sharedVenueId) selectVenue(_sharedVenueId, true);
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
    case 'profile':       closeProfilePanel(); break;
    case 'friends':       if (typeof closeFriendsModal === 'function') closeFriendsModal(); break;
    case 'edit':          exitEditMode(); break;
  }

  _navHandlingPop = false;
});
