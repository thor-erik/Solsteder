/**
 * ui-plan-preview.js — Full-screen invitation preview takeover.
 *
 * Triggered when:
 *   1. A user lands via a `#invite/<token>` or `/i/<token>` link
 *   2. A user taps "Preview" on a plan card in the detail panel
 *
 * The takeover hides app chrome and lets the live map (with shadows) show
 * through. The bottom panel renders a static venue-card (same DOM as the
 * list) plus a title/CTA block. No FTS reparenting — the receiver doesn't
 * scrub time on the accept page; the time-lapse runs the global #fts
 * slider in place to drive map shadows but the FTS chrome stays hidden by
 * the body.plan-preview-active rule.
 *
 * Modes:
 *   'invite'      — logged-in receiver of a real plan_invites row. Accept/Decline.
 *   'invite-anon' — token has plan_id but receiver isn't logged in yet.
 *                   Single "Logg inn for å svare" CTA → toggleProfilePanel.
 *                   After login, app.js's onAuthStateChange resumes the flow.
 *   'preview'     — own plan or exploratory. Single Lukk button.
 *
 * Depends on: VENUES, computeSunWindows, formatHour, getWeatherAt, timeFromEl,
 *             datePicker, map, getPlansForVenue, respondToPlanInvite, selectVenue,
 *             renderCard, drawAllCardTimelines, shortName, _showToast.
 */

let _planPreviewState = null;

/**
 * Open the full-screen invitation preview.
 * @param {object}        opts
 * @param {string|number} opts.venueId
 * @param {string}        [opts.plannedAt]   - ISO datetime; defaults to current slider time
 * @param {string}        [opts.inviterName] - "{name} inviterer deg" header line
 * @param {string}        [opts.inviteId]    - plan_invites.id, present for accept/decline
 * @param {string}        [opts.inviterId]   - profile id of the inviter (for friend-add prompt)
 * @param {string}        [opts.planTokenP]  - plan_id from the token (used for invite-anon mode)
 * @param {'invite'|'invite-anon'|'preview'} [opts.mode='preview']
 */
function openPlanPreview(opts) {
  if (typeof VENUES === 'undefined') return;
  if (_planPreviewState) closePlanPreview();
  const venue = VENUES.find(v => String(v.id) === String(opts.venueId));
  if (!venue) return;

  const savedTime = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : null;
  const savedDate = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : null;

  let dateStr  = savedDate;
  let planHour = savedTime != null ? savedTime : 12;
  if (opts.plannedAt) {
    const dt = new Date(opts.plannedAt);
    if (!isNaN(dt.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      dateStr  = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      planHour = dt.getHours() + dt.getMinutes() / 60;
    }
  }

  const swRes  = (typeof computeSunWindows === 'function') ? computeSunWindows(venue, dateStr) : null;
  const windows = swRes && swRes.windows ? swRes.windows : [];
  const lastEnd = windows.length ? windows[windows.length - 1].end : null;
  const animateTo = (lastEnd && lastEnd > planHour + 0.05) ? lastEnd : planHour;

  if (datePicker && dateStr && datePicker.value !== dateStr) {
    datePicker.value = dateStr;
    datePicker.dispatchEvent(new Event('change'));
  }
  if (timeFromEl) {
    timeFromEl.value = planHour;
    timeFromEl.dispatchEvent(new Event('input'));
  }

  document.body.classList.add('plan-preview-active');

  // Stash + override selectedId so the invited venue gets the priority
  // boost in the pin renderer (priScore = -100000 for selectedId in
  // render-pins.js draw()). Without this, on locate's fit-both view
  // the pin competes with every other venue in the visible bounds and
  // gets demoted to a dot or filtered out, leaving the venue
  // unrepresented on the map. Restored on close so the underlying
  // detail-panel state isn't perturbed. The detail panel itself stays
  // hidden via the body.plan-preview-active CSS rule.
  const savedSelectedId = (typeof selectedId !== 'undefined') ? selectedId : null;
  if (typeof selectedId !== 'undefined') {
    try { selectedId = venue.id; } catch (e) { /* ignore */ }
  }

  // Save current camera so we can restore it on close.
  let savedCamera = null;
  if (typeof map !== 'undefined' && map && typeof map.getCenter === 'function') {
    try {
      const c = map.getCenter();
      savedCamera = {
        center: [c.lng, c.lat],
        zoom:    map.getZoom(),
        pitch:   map.getPitch(),
        bearing: map.getBearing(),
      };
    } catch (e) { /* ignore */ }
  }

  // Camera choreography: open from above, then dive in. Mirrors the app's
  // intro sequence (jumpTo → easeTo zoom-in + tilt-up) so receivers landing
  // on a share link get the same orienting motion as a fresh app open.
  //
  //  Phase 0 (instant): jumpTo zoom 14, pitch 0, top-down — known starting
  //    state regardless of where the camera was before.
  //  Phase 1 (1500ms):  flyTo dive — zoom 17.6, pitch 58, bearing aimed at
  //    the venue's outdoor seating (wallSegment.bearing + 180) so the front
  //    of the venue faces the camera. Same bearing logic as _flyToVenue in
  //    app.js (lines ~2286-2291), kept inline here to avoid coupling.
  //
  // The Mapbox `padding.bottom` offset shifts the camera's logical center up
  // so the venue sits centered in the visible map area (panel covers the
  // bottom). Approximated before the panel mounts.
  const TIMELAPSE_MS = 5000;
  const phase3TimeoutId = { id: null };
  // Defer the camera dive until the splash starts fading. User feedback:
  // 'the animation should start after the splash'. v1 ran the dive
  // immediately, which made it invisible behind the splash overlay —
  // the user only saw the END state when the splash faded. Coordinated
  // with SPLASH_MIN_MS (the same minimum the regular intro uses).
  const _splashElapsed = (typeof _splashStart === 'number')
    ? (performance.now() - _splashStart) : 9999;
  const _splashMinMs   = (typeof SPLASH_MIN_MS === 'number') ? SPLASH_MIN_MS : 1500;
  const _splashWaitMs  = Math.max(0, _splashMinMs - _splashElapsed);
  const _startDive = () => {
    if (typeof map === 'undefined' || !map || typeof map.jumpTo !== 'function') return;
    const vh = (window.visualViewport?.height ?? window.innerHeight);
    const panelH = Math.min(Math.round(vh * 0.42), 460);
    const topBarH = 16;
    const padding = { top: topBarH, bottom: panelH, left: 0, right: 0 };
    // Bearing: face the venue from outdoor-seating side. Same heuristic
    // as _flyToVenue — wallSegment.bearing + 180 puts the camera on the
    // sunny side looking toward the building.
    const wallBearing   = venue.wallSegment?.bearing ?? venue.facing ?? 0;
    const targetBearing = (wallBearing + 180) % 360;
    try {
      map.jumpTo({
        center:  [venue.lng, venue.lat],
        zoom:    14,
        pitch:   0,
        bearing: targetBearing,
        padding,
      });
      map.flyTo({
        center:  [venue.lng, venue.lat],
        zoom:    17.6,
        pitch:   58,
        bearing: targetBearing,
        padding,
        duration: 1500,
        curve: 1.4,
        easing: t => 1 - Math.pow(1 - t, 3),
        essential: true,
      });
    } catch (e) { /* ignore */ }
  };
  const _hideInviteSplash = () => {
    const splash = document.getElementById('splash');
    const splashLogo = document.getElementById('splash-logo');
    const splashLoader = document.getElementById('splash-loader');
    if (!splash) return;
    splash.classList.add('bg-out');
    if (splashLogo) splashLogo.classList.add('fade-out');
    if (splashLoader) splashLoader.classList.add('fade-out');
    setTimeout(() => splash.classList.add('done'), 500);
  };
  if (_splashWaitMs > 0) {
    setTimeout(() => {
      _hideInviteSplash();
      // Brief gap so the splash bg begins fading before the dive starts
      // visually — reads as 'splash gone, now show me the place'.
      setTimeout(_startDive, 200);
    }, _splashWaitMs);
  } else {
    _hideInviteSplash();
    _startDive();
  }
  // Reveal the map only after Mapbox is idle for the current view — i.e.
  // the dive's tiles have rendered. Removing the gate sooner exposes the
  // canvas-overlay pins drawn against a dark empty background (the bug
  // shown in the screenshot). 1800ms fallback in case 'idle' never fires
  // (offline / very slow connection). The class also hides #canvas-overlay
  // (CSS rule in index.html) so pins don't leak through during the wait.
  if (typeof map !== 'undefined' && map && typeof map.once === 'function') {
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      document.documentElement.classList.remove('invite-loading');
      // Splash hide is handled by the time-based SPLASH_MIN_MS branch
      // above so the splash + camera dive are coordinated. This
      // reveal handler only manages the pin canvas now.
    };
    map.once('idle', reveal);
    setTimeout(reveal, 1800);
  } else {
    document.documentElement.classList.remove('invite-loading');
  }

  // _skipIntro (run earlier on the invite path) calls _syncFtsPosition,
  // which sets inline `style.opacity = '0'` + pointerEvents = 'none' on
  // #zoom-jog (and conditionally #locate-btn) when the venue list is in
  // mobile-expanded state. Inline style trumps the body.plan-preview-active
  // CSS rule that would otherwise show them above the panel. Clear inline
  // styles here so the CSS rule wins for the duration of the takeover.
  ['locate-btn', 'zoom-jog'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.opacity = '';
      el.style.pointerEvents = '';
    }
  });

  const overlay = _ppBuildDom(venue, opts, { planHour, animateTo, dateStr });
  document.body.appendChild(overlay);

  // Track the bottom panel's height as --pp-bottom-h so the locate-me +
  // zoom-jog can anchor above it — same pattern the venue list uses via
  // --peek-h. ResizeObserver keeps the var in sync as content changes.
  const bottomEl = overlay.querySelector('.dprcv-bottom') || overlay.querySelector('.pp-bottom');
  let resizeObs = null;
  if (bottomEl) {
    const writeH = () => {
      document.documentElement.style.setProperty('--pp-bottom-h', bottomEl.offsetHeight + 'px');
    };
    requestAnimationFrame(writeH);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(writeH);
      resizeObs.observe(bottomEl);
    }
  }

  _planPreviewState = {
    overlay,
    venueId:  venue.id,
    inviterId: opts.inviterId || null,
    savedTime, savedDate, savedCamera, savedSelectedId,
    planHour, animateTo, dateStr,
    rafId: null,
    timeouts: [phase3TimeoutId],
    autoplayDone: false,
    resizeObs,
    locateState: 'dive', // dive (initial) → fit → user → dive (cycle)
  };

  requestAnimationFrame(() => {
    overlay.classList.add('open');
  });

  // Drag-to-dismiss on the grabber. Touch start anywhere on the grabber zone,
  // drag down past 100px → close. Less than that → snap back. iOS-native feel.
  _ppWireDragHandle(overlay);

  // Time-lapse starts after the panel slide-in settles (320ms transition).
  if (animateTo > planHour + 0.05) {
    phase3TimeoutId.id = setTimeout(() => {
      if (!_planPreviewState) return;
      _ppAnimate(planHour, animateTo, TIMELAPSE_MS);
    }, 360);
  }

  if (typeof _aTrack === 'function') {
    _aTrack('plan_preview_opened', { venue_id: venue.id, mode: opts.mode || 'preview' });
  }
}

/** Custom 2-state locate-me behavior for the plan-preview takeover.
 *  - First tap: frame both the venue and the user's location — easeTo a
 *    bounds that fits both, with padding for the top bar and bottom panel.
 *  - Second tap: zoom in on the user's location.
 *  - Subsequent taps toggle.
 *  When userLocation is unavailable, falls back to centering on the venue. */
function _planPreviewLocate() {
  if (!_planPreviewState) return;
  const venueId = _planPreviewState.venueId;
  const venue = (typeof VENUES !== 'undefined') ? VENUES.find(v => String(v.id) === String(venueId)) : null;
  if (!venue || typeof map === 'undefined' || !map) return;

  const btn = document.getElementById('locate-btn');
  if (btn) { btn.classList.add('tracking'); setTimeout(() => btn.classList.remove('tracking'), 1200); }

  const vh = (window.visualViewport?.height ?? window.innerHeight);
  const panelH = Math.min(Math.round(vh * 0.42), 460);
  const topBarH = 96;
  const padding = { top: topBarH, bottom: panelH, left: 24, right: 24 };

  const hasUser = (typeof userLocation !== 'undefined') && userLocation
    && Number.isFinite(userLocation.lat) && Number.isFinite(userLocation.lng);

  // Triple-state cycle: dive → fit → user → dive. v1 ping-ponged
  // between fit and user with no path back to the original
  // venue-focused dive view; this gave the user no obvious way
  // to return after exploring. The third state is the dive itself,
  // re-running the same camera params as the initial entry choreography.
  // When userLocation is missing, fit and user states are skipped
  // (locate just snaps back to dive).
  const cur = _planPreviewState.locateState || 'dive';
  let next;
  if (!hasUser) {
    next = 'dive';
  } else if (cur === 'dive')      next = 'fit';
  else if (cur === 'fit')         next = 'user';
  else                            next = 'dive';
  _planPreviewState.locateState = next;
  if (typeof _aTrack === 'function') _aTrack('plan_preview_locate', { state: next });
  if (btn) {
    btn.classList.remove('locate-state-dive', 'locate-state-fit', 'locate-state-user');
    btn.classList.add('locate-state-' + next);
  }

  if (next === 'fit') {
    try {
      const sw = [Math.min(venue.lng, userLocation.lng), Math.min(venue.lat, userLocation.lat)];
      const ne = [Math.max(venue.lng, userLocation.lng), Math.max(venue.lat, userLocation.lat)];
      map.fitBounds([sw, ne], {
        padding,
        maxZoom: 15.5,
        pitch: 30,
        bearing: 0,
        duration: 700,
      });
    } catch (e) { /* ignore */ }
    return;
  }

  if (next === 'user') {
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

  // 'dive' — same camera params as openPlanPreview's Phase 1 flyTo so
  // the user gets the same orienting view they started with.
  const wallBearing   = venue.wallSegment?.bearing ?? venue.facing ?? 0;
  const targetBearing = (wallBearing + 180) % 360;
  try {
    map.easeTo({
      center: [venue.lng, venue.lat],
      zoom: 17.6,
      pitch: 58,
      bearing: targetBearing,
      duration: 700,
      padding,
    });
  } catch (e) { /* ignore */ }
}

/** Wire up the drag handle (.pp-handle wrapper) for drag-to-dismiss. The
 *  wrapper provides a 16×N hit area around the visible .pp-grabber pill.
 *  Tracks touch Y-delta, applies translateY to the panel during drag, and
 *  either closes or snaps back on release based on a 100px threshold
 *  (or fast flick). Sets handle.dataset.dragging during the drag so the
 *  separate click-to-close listener doesn't fire on the synthetic click. */
function _ppWireDragHandle(overlay) {
  const handle = overlay.querySelector('.dprcv-handle') || overlay.querySelector('.pp-handle');
  const panel  = overlay.querySelector('.dprcv-bottom') || overlay.querySelector('.pp-bottom');
  if (!handle || !panel) return;
  let startY = null;
  let startT = null;
  let dragging = false;
  let moved = false;
  const THRESHOLD_PX = 100;
  const FLICK_VELOCITY = 0.6; // px/ms
  const MOVE_TRIGGER_PX = 4;  // jitter tolerance before counting as a real drag

  const onStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    startY = t.clientY;
    startT = performance.now();
    dragging = true;
    moved = false;
    panel.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!dragging || startY == null) return;
    const t = e.touches ? e.touches[0] : e;
    const dy = Math.max(0, t.clientY - startY);
    if (dy > MOVE_TRIGGER_PX) {
      moved = true;
      handle.dataset.dragging = '1';
    }
    panel.style.transform = `translateY(${dy}px)`;
    if (e.cancelable) e.preventDefault();
  };
  const onEnd = (e) => {
    if (!dragging || startY == null) return;
    const t = e.changedTouches ? e.changedTouches[0] : e;
    const dy = Math.max(0, t.clientY - startY);
    const dt = Math.max(1, performance.now() - startT);
    const velocity = dy / dt; // px per ms
    panel.style.transition = '';
    panel.style.transform = '';
    dragging = false;
    startY = null;
    if (dy > THRESHOLD_PX || velocity > FLICK_VELOCITY) {
      closePlanPreview();
      return;
    }
    // Clear dragging flag on the next frame so the click handler that may
    // fire after touchend can see it (and skip closing if a drag occurred).
    if (moved) {
      requestAnimationFrame(() => {
        delete handle.dataset.dragging;
      });
    }
  };

  handle.addEventListener('touchstart', onStart, { passive: true });
  handle.addEventListener('touchmove', onMove, { passive: false });
  handle.addEventListener('touchend', onEnd, { passive: true });
  handle.addEventListener('touchcancel', onEnd, { passive: true });
  // Mouse fallback for desktop testing
  handle.addEventListener('mousedown', (e) => {
    onStart(e);
    const moveHandler = (ev) => onMove(ev);
    const upHandler = (ev) => {
      onEnd(ev);
      window.removeEventListener('mousemove', moveHandler);
      window.removeEventListener('mouseup', upHandler);
    };
    window.addEventListener('mousemove', moveHandler);
    window.addEventListener('mouseup', upHandler);
  });
  handle.style.cursor = 'grab';
  grabber.style.touchAction = 'none';
  // Expand the touch target around the visible pill (44pt min target)
  grabber.style.padding = '12px';
  grabber.style.margin = '-8px auto -10px';
}

function closePlanPreview(opts = {}) {
  const st = _planPreviewState;
  if (!st) return;
  if (st.rafId) cancelAnimationFrame(st.rafId);
  if (Array.isArray(st.timeouts)) {
    for (const tref of st.timeouts) { if (tref && tref.id != null) clearTimeout(tref.id); }
  }
  if (st.resizeObs) { try { st.resizeObs.disconnect(); } catch {} }
  document.documentElement.style.removeProperty('--pp-bottom-h');
  if (st.savedDate != null && datePicker && datePicker.value !== st.savedDate) {
    datePicker.value = st.savedDate;
    datePicker.dispatchEvent(new Event('change'));
  }
  if (st.savedTime != null && timeFromEl) {
    timeFromEl.value = st.savedTime;
    timeFromEl.dispatchEvent(new Event('input'));
  }

  // Choose post-close destination:
  //  - venueId set → open the detail panel (its own docked-card morph)
  //  - no venueId → just remove the takeover and restore camera
  const venueId = st.venueId;
  const venue = (typeof VENUES !== 'undefined') ? VENUES.find(v => String(v.id) === String(venueId)) : null;

  st.overlay.classList.remove('open');
  document.body.classList.remove('plan-preview-active');
  setTimeout(() => { try { st.overlay.remove(); } catch {} }, 320);
  _planPreviewState = null;

  if (!opts.skipDetailOpen && venue && typeof selectVenue === 'function') {
    // Open the detail panel — it runs its own FLIP morph + FTS hosting from
    // the venue-card source; no FTS hand-off needed from here since the
    // plan-preview no longer reparents FTS.
    selectVenue(venueId, true);
  } else {
    // skipDetailOpen path: we won't be calling selectVenue (which would
    // otherwise re-write selectedId). openPlanPreview overrode
    // selectedId to give the invited venue pin-priority — restore the
    // pre-preview selectedId so the map state doesn't carry a stale
    // selection forward. Without this, the pin keeps the selected
    // styling forever after a decline.
    if (typeof selectedId !== 'undefined' && st.savedSelectedId !== undefined) {
      try { selectedId = st.savedSelectedId; } catch (e) { /* ignore */ }
    }
    // Skip restoring savedCamera when the caller will fly somewhere
    // else next (decline → _exitToExploreMode flies to userLocation).
    // Otherwise the user sees two consecutive camera flights — first to
    // the saved pre-preview camera (800 ms), then to userLocation
    // (900 ms) — reading as a janky two-stage zoom-out. opts.keepCamera
    // = true tells closePlanPreview to leave the camera where it is.
    if (!opts.keepCamera
        && st.savedCamera && typeof map !== 'undefined' && map && typeof map.flyTo === 'function') {
      try {
        map.flyTo({
          center:  st.savedCamera.center,
          zoom:    st.savedCamera.zoom,
          pitch:   st.savedCamera.pitch,
          bearing: st.savedCamera.bearing,
          duration: 800,
          essential: true,
        });
      } catch (e) { /* ignore */ }
    }
  }
}

function _ppAnimate(fromH, toH, durationMs) {
  // Two-leg time-lapse:
  //   1. forward: invited hour → sun-end (≈80% of duration) — shows the
  //      day's shadow progression
  //   2. settle:  sun-end → invited hour (≈20%, ease-out) — lands on the
  //      bright/inviting visual that matches the narrative copy
  // Without the settle, the page rests at near-sunset (mostly shadowed)
  // and contradicts "perfekt tid for {venue}".
  const FORWARD_FRAC = 0.78;
  const forwardMs = durationMs * FORWARD_FRAC;
  const settleMs  = durationMs - forwardMs;
  const startTs = performance.now();
  function step(now) {
    if (!_planPreviewState) return;
    const t = Math.min(1, (now - startTs) / durationMs);
    let h;
    if (t < FORWARD_FRAC) {
      const f = t / FORWARD_FRAC;                       // 0→1 over forward leg
      const eased = 1 - Math.pow(1 - f, 3);             // easeOutCubic
      h = fromH + (toH - fromH) * eased;
    } else {
      const f = (t - FORWARD_FRAC) / (1 - FORWARD_FRAC); // 0→1 over settle leg
      const eased = 1 - Math.pow(1 - f, 2);             // easeOutQuad
      h = toH + (fromH - toH) * eased;                  // toH → fromH
    }
    if (timeFromEl) {
      timeFromEl.value = h;
      timeFromEl.dispatchEvent(new Event('input'));
    }
    if (t < 1) {
      _planPreviewState.rafId = requestAnimationFrame(step);
    } else {
      // Snap to exact invited hour to avoid floating-point off-by-one (e.g. 14:59 vs 15:00)
      if (timeFromEl) {
        timeFromEl.value = fromH;
        timeFromEl.dispatchEvent(new Event('input'));
      }
      _planPreviewState.autoplayDone = true;
      _planPreviewState.rafId = null;
    }
  }
  _planPreviewState.rafId = requestAnimationFrame(step);
}


function _ppBuildDom(venue, opts, { planHour, animateTo, dateStr }) {
  const el = document.createElement('div');
  el.id = 'plan-preview';
  el.className = 'plan-preview dprcv-overlay';

  const isInvite     = (opts.mode === 'invite' || opts.mode === 'invite-anon');
  const isAnon       = (opts.mode === 'invite-anon');
  const isPreview    = (opts.mode === 'preview');

  // ── Venue meta line: area · category · "{dist} m" · "{walkMin} min å gå"
  const venueArea = venue.area || '';
  const venueCat  = (typeof catLabel === 'function') ? catLabel(venue) : '';
  const distMin   = _dprcvWalkInfo(venue);
  const metaParts = [
    [venueArea, venueCat].filter(Boolean).join(' · '),
    distMin && distMin.distLabel ? distMin.distLabel : '',
    distMin && distMin.walkMin != null ? `${distMin.walkMin} ${t('accepted_action_directions_sub', { n: distMin.walkMin }).split(/\s/).slice(1).join(' ') || 'min'}` : '',
  ].filter(Boolean);
  const metaHtml = metaParts.map((p, i) =>
    (i > 0 ? '<span class="dprcv-meta-dot">·</span>' : '') + `<span>${p.replace(/</g, '&lt;')}</span>`
  ).join('');

  // ── Hero header data (Møtes left, Sol til right)
  const planTimeStr = formatHour(planHour);
  const dateLabel   = (typeof _fmtInviteDate === 'function' && dateStr) ? _fmtInviteDate(dateStr) : '';
  const nowH        = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : planHour;
  const minutesUntil = Math.max(0, Math.round((planHour - nowH) * 60));
  const arrivalSub  = dateLabel
    ? (minutesUntil > 0 ? `${dateLabel} · ${t('invite_hero_in_minutes', { n: minutesUntil })}` : dateLabel)
    : '';
  let sunEnd = null;
  try {
    if (typeof computeSunWindows === 'function') {
      const sw = computeSunWindows(venue, dateStr);
      const ws = sw && sw.windows ? sw.windows : [];
      if (ws.length) sunEnd = ws[ws.length - 1].end;
    }
  } catch (e) { /* ignore */ }
  const sunUntilStr = (sunEnd != null) ? formatHour(sunEnd) : '—';
  // After-sundown variant: when the meeting time is past the day's last
  // sun-window end, switch the right-side hero label from 'Sun until'
  // (which implied 'still some sun left at meeting time') to 'Sun went
  // down at' so the time shown reads as a *past* sundown moment, not
  // as 'sun ends at the meeting time'. Subtext shows how long ago.
  const isAfterSundown = (sunEnd != null && sunEnd <= planHour);
  let remainingStr = '';
  if (sunEnd != null) {
    const rem = sunEnd - planHour;
    if (rem > 0) {
      const h = Math.floor(rem);
      const m = Math.max(0, Math.round((rem - h) * 60));
      remainingStr = t('invite_hero_remaining', { h, m });
    } else if (isAfterSundown) {
      const gone = planHour - sunEnd;
      if (gone < 1) {
        remainingStr = t('invite_hero_sundown_minutes_ago', { n: Math.round(gone * 60) });
      } else {
        const h = Math.floor(gone);
        const m = Math.max(0, Math.round((gone - h) * 60));
        remainingStr = (m > 0)
          ? t('invite_hero_sundown_hm_ago', { h, m })
          : t('invite_hero_sundown_h_ago',  { h });
      }
    } else {
      remainingStr = t('invite_hero_remaining_no_sun');
    }
  }
  const sunHeroLabelKey = isAfterSundown ? 'invite_hero_sun_went_down' : 'invite_hero_sun_until';

  // ── Inline icon set (Lucide-style)
  const checkSvg    = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const clockSvg    = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const editSvg     = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  const xSvg        = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const sendSvg     = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`;
  const chevDownSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  // ── Attendees + quoted message (logged-in invite mode only — anon doesn't
  // have plan_invites visibility yet).
  let attendeesHtml = '';
  if (typeof getPlansForVenue === 'function' && !isAnon) {
    const plans = getPlansForVenue(venue.id);
    const target = opts.plannedAt ? new Date(opts.plannedAt).getTime() : null;
    const plan = target == null
      ? plans[0]
      : plans.find(p => p.planned_at && Math.abs(new Date(p.planned_at).getTime() - target) < 30 * 60 * 1000)
        || plans[0];
    if (plan && Array.isArray(plan._invitees) && plan._invitees.length) {
      const accepted = plan._invitees.filter(i => i.status === 'accepted');
      if (accepted.length) {
        const stack = accepted.slice(0, 3).map(i => {
          const u = i.user;
          const init = (((u && (u.name || u.email)) || '?')[0] || '?').toUpperCase();
          const colorIdx = (init.charCodeAt(0) || 0) % 8;
          if (u && u.avatar_url) {
            return `<img class="dprcv-att-av" src="${u.avatar_url}" alt="">`;
          }
          return `<div class="dprcv-att-av dpinvite-avatar-init init-color-${colorIdx}">${init}</div>`;
        }).join('');
        const inviterFirst = (opts.inviterName || '').split(/\s+/)[0] || '';
        const others = Math.max(0, accepted.length - 1);
        const lineText = inviterFirst
          ? (others > 0 ? `${inviterFirst} + ${others} til` : `${inviterFirst} er klar`)
          : t('attendees_label', { count: accepted.length });
        const planMessage = (plan.message || '').replace(/</g, '&lt;');
        attendeesHtml = `
          <div class="dprcv-attendees">
            <div class="dprcv-att-stack">${stack}</div>
            <div class="dprcv-att-info">
              <div class="dprcv-att-line">${lineText.replace(/</g, '&lt;')}</div>
              ${planMessage ? `<div class="dprcv-quote">"${planMessage}"</div>` : ''}
            </div>
          </div>`;
      }
    }
  }

  // ── CTAs vary by mode. One Primary per screen (.p-pill); secondaries use
  // .s-rnd / .g-rnd from the design-system button kit.
  let ctaHtml = '';
  if (isInvite) {
    const acceptId = isAnon ? 'pp-anon-accept' : 'pp-accept';
    const declineId = isAnon ? 'pp-anon-decline' : 'pp-decline';
    // Anon mode: the primary button actually opens a login modal — be
    // honest about that in the label ('Log in to accept') so the user
    // isn't surprised by an unexpected auth gate. The secondary
    // 'Coming later' and 'Decline' are kept in anon mode too: now
    // that the primary CTA explicitly says 'Log in to …', the user
    // already understands the same auth wall applies to the other
    // options — no need to hide them.
    const primaryLabel = isAnon ? t('plan_preview_anon_im_in') : t('plan_preview_im_in');
    const primaryIcon  = isAnon ? '' : checkSvg;
    ctaHtml = `
      <button class="p-pill dprcv-cta-primary" id="${acceptId}" type="button">
        ${primaryIcon}
        ${primaryLabel}
      </button>
      <div class="dprcv-cta-row">
        <button class="dprcv-cta-link" id="pp-suggest" type="button">
          ${editSvg}<span>${t('invite_secondary_later')}</span>
        </button>
        <span class="dprcv-cta-sep" aria-hidden="true">·</span>
        <button class="dprcv-cta-link is-decline" id="${declineId}" type="button">
          <span>${t('plan_decline')}</span>
        </button>
      </div>`;
  } else if (isPreview) {
    ctaHtml = `
      <button class="p-pill dprcv-cta-primary" id="pp-share-onward" type="button">
        ${sendSvg}
        ${t('preview_share_onwards')}
      </button>
      <div class="dprcv-cta-row">
        <button class="dprcv-cta-link" id="pp-close-cta" type="button"><span>${t('close')}</span></button>
      </div>`;
  }

  // ── From-friend pill (top floating). Only render when we actually have an
  // inviter name AND a sent-time. Anon tokens (no name) get the eyebrow line
  // inside the sheet instead — no harsh "?" placeholder, no bare "sent " text
  // with no value. The pill is signal, not chrome.
  const inviterName = (opts.inviterName || '').replace(/</g, '&lt;');
  const sentAgoTemplate = t('invite_hero_sent_ago', { ago: '' });
  const sentAgoFilled = (opts.sentAgo || '').toString().trim();
  const sentSub = (isInvite && sentAgoFilled)
    ? sentAgoTemplate.replace('{ago}', sentAgoFilled)
    : '';
  let topPillHtml = '';
  if (isInvite && opts.inviterName) {
    const firstLetter = opts.inviterName[0].toUpperCase();
    const colorIdx = (firstLetter.charCodeAt(0) || 0) % 8;
    const inviterAvHtml = opts.inviterAvatarUrl
      ? `<img src="${opts.inviterAvatarUrl}" alt="">`
      : `<div class="dpinvite-avatar-init init-color-${colorIdx}" style="width:100%;height:100%;font-size:13px;border-radius:50%">${firstLetter}</div>`;
    topPillHtml = `
      <div class="dprcv-top-pill">
        <div class="dprcv-top-pill-card glass-action">
          <div class="dprcv-top-pill-av">${inviterAvHtml}</div>
          <span class="dprcv-top-pill-name">${inviterName}</span>
          ${sentSub ? `<span class="dprcv-top-pill-sub">${sentSub}</span>` : ''}
        </div>
      </div>`;
  }

  // Eyebrow above venue name — sentence case (was ALL-CAPS in v1). Only
  // shown when the top "From {inviter}" pill is absent (anon token), so
  // we don't duplicate the same info on two surfaces. For named invites
  // the top pill carries the attribution and the venue line gets a
  // cleaner heading. For anon, the eyebrow is "{inviterName} inviterer
  // deg" (or anon fallback "Du er invitert"). The named-with-pill case
  // suppresses the eyebrow entirely.
  const hasTopPill = !!(isInvite && opts.inviterName);
  let eyebrow = '';
  if (isInvite && !hasTopPill) {
    eyebrow = opts.inviterName
      ? t('pp_invited_line_named', { name: `<strong>${inviterName}</strong>` })
      : t('pp_invited_line_anon');
  } else if (!isInvite && sunEnd != null) {
    eyebrow = `${t('invite_hero_sun_until')} ${sunUntilStr}`;
  }

  // Venue line — pin glyph + name·area (same anchor pattern as the
  // invite sheet's moment block). Dedup area when redundant with the
  // venue name (e.g. "Mamma Pizza Nydalen" + area "Nydalen").
  const venuePinSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  const venueNameSafe = venue.name.replace(/</g, '&lt;');
  const dispArea = (typeof _dedupeAreaForVenue === 'function')
    ? _dedupeAreaForVenue(venue.name, venue.area)
    : (venue.area || '');
  const venueDisplay = dispArea ? `${venueNameSafe} · ${dispArea.replace(/</g, '&lt;')}` : venueNameSafe;

  // Build full DOM
  el.innerHTML = `
    ${topPillHtml}
    <div class="dprcv-bottom">
      <div class="dprcv-handle pp-handle" id="pp-handle" aria-label="${t('close')}">
        <div class="dprcv-grabber pp-grabber" aria-hidden="true"></div>
      </div>
      <div class="dprcv-title-block">
        ${eyebrow ? `<div class="dprcv-eyebrow">${eyebrow}</div>` : ''}
        <div class="dprcv-venue-row">
          <span class="dprcv-venue-pin" aria-hidden="true">${venuePinSvg}</span>
          <span class="dprcv-venue">${venueDisplay}</span>
        </div>
        ${metaHtml ? `<div class="dprcv-meta">${metaHtml}</div>` : ''}
      </div>
      <div class="dprcv-hero">
        <div class="dprcv-hero-row">
          <div class="dprcv-hero-left">
            <div class="dprcv-hero-label">${t('invite_hero_meets')}</div>
            <div class="dprcv-arrival-time" id="pp-arrival-time">${planTimeStr}</div>
            ${arrivalSub ? `<div class="dprcv-arrival-sub">${arrivalSub}</div>` : ''}
          </div>
          <div class="dprcv-hero-right">
            <div class="dprcv-hero-label">${t(sunHeroLabelKey)}</div>
            <div class="dprcv-suntil-time">${sunUntilStr}</div>
            ${remainingStr ? `<div class="dprcv-remaining">${remainingStr}</div>` : ''}
          </div>
        </div>
        <div class="dprcv-timeline">
          <canvas class="card-timeline-canvas dprcv-timeline-canvas" data-vid="${venue.id}" width="600" height="40"></canvas>
        </div>
      </div>
      ${attendeesHtml}
      ${ctaHtml}
    </div>`;

  // Paint the canvas via the shared walker. Defer to the next frame so the
  // canvas has a non-zero clientWidth (drawAllCardTimelines bails on
  // detached/0-sized nodes — see ui-list.js line ~54). openPlanPreview
  // appends the overlay AFTER _ppBuildDom returns; if we paint here we hit
  // the layout-skip branch and the timeline never appears.
  if (typeof drawAllCardTimelines === 'function') {
    requestAnimationFrame(() => drawAllCardTimelines(el));
  }

  // Wire the canvas to drag-scrub timeFromEl (so receivers can verify
  // weather/sun across the day). Drag updates propagate via 'input' and the
  // existing onTimeInput cancels the autoplay automatically.
  const ftsCanvas = el.querySelector('.dprcv-timeline-canvas');
  if (ftsCanvas && typeof window._wireInlineFtsCanvas === 'function') {
    window._wireInlineFtsCanvas(ftsCanvas);
  }

  // Tap-to-close on the handle area. Drag-to-dismiss is wired separately in
  // _ppWireDragHandle (which queries .pp-grabber). The wrapper hit area
  // catches taps that don't initiate a drag.
  const handleEl = el.querySelector('#pp-handle');
  if (handleEl) {
    handleEl.addEventListener('click', () => {
      if (handleEl.dataset.dragging === '1') return;
      closePlanPreview();
    });
  }

  // First user FTS interaction cancels the autoplay + camera timeouts.
  const onTimeInput = () => {
    if (_planPreviewState && _planPreviewState.rafId) {
      cancelAnimationFrame(_planPreviewState.rafId);
      _planPreviewState.rafId = null;
      _planPreviewState.autoplayDone = true;
    }
  };
  if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.addEventListener('input', onTimeInput);
  el._cleanup = () => {
    if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.removeEventListener('input', onTimeInput);
  };

  // "Kommer senere" secondary opens a hidden <input type="time"> picker.
  // Selecting a later time updates arrivalHour; tapping "Jeg er med" then
  // writes accept w/ that custom arrival_time. Anon mode opens the login
  // modal (no per-invitee write possible without auth).
  let arrivalHour = planHour;
  let arrivalInput = null;
  const suggestBtn = el.querySelector('#pp-suggest');
  if (suggestBtn) {
    if (isAnon) {
      suggestBtn.onclick = () => {
        if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
      };
    } else {
      arrivalInput = document.createElement('input');
      arrivalInput.type = 'time';
      arrivalInput.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none;';
      arrivalInput.value = `${String(Math.floor(planHour)).padStart(2,'0')}:${String(Math.round((planHour - Math.floor(planHour)) * 60)).padStart(2,'0')}`;
      suggestBtn.appendChild(arrivalInput);
      suggestBtn.onclick = (e) => {
        e.preventDefault();
        arrivalInput.showPicker?.() || arrivalInput.click();
      };
      arrivalInput.addEventListener('change', () => {
        const m = arrivalInput.value.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return;
        arrivalHour = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
        const lbl = el.querySelector('#pp-arrival-time');
        if (lbl) lbl.textContent = formatHour(arrivalHour);
      });
    }
  }

  // Accept handler — same backend contract; new UI shell.
  // Flow: plan-preview slides down → post-accept panel slides up
  // (closePlanPreview with skipDetailOpen). When post-accept closes
  // (default path), _exitToExploreMode fires from inside
  // _closePostAcceptPanel. Detail panel is NOT involved — user
  // feedback: 'the detail panel should not even appear when clicking
  // I'm in.'
  const acceptBtn = el.querySelector('#pp-accept');
  if (acceptBtn) acceptBtn.onclick = async () => {
    let arrivalIso = null;
    if (arrivalInput && Math.abs(arrivalHour - planHour) > 0.05) {
      const dateStr2 = opts.plannedAt ? opts.plannedAt.slice(0, 10) : datePicker?.value;
      if (dateStr2) {
        const hh = Math.floor(arrivalHour);
        const mm = Math.round((arrivalHour - hh) * 60);
        arrivalIso = new Date(`${dateStr2}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`).toISOString();
      }
    }
    if (typeof respondToPlanInvite === 'function' && opts.inviteId) {
      try { await respondToPlanInvite(opts.inviteId, 'accepted', arrivalIso); } catch (e) { /* ignore */ }
    }
    const friendsList = (typeof _friends !== 'undefined') ? _friends : [];
    const isFriendOfInviter = !opts.inviterId
      || friendsList.some(f => String(f.id) === String(opts.inviterId));
    if (isFriendOfInviter) {
      window._pendingShareNudge = {
        venueId:   venue.id,
        planId:    opts.planTokenP || null,
        plannedAt: opts.plannedAt || null,
      };
    }
    // Drop the legacy "You're in!" top toast — the post-accept panel
    // mounts its own static .dpacc-toast-pill at the top with more
    // informative copy ("You're in — see you on Sunday at 20:40").
    // The two surfaced simultaneously and read as duplicate yellow
    // toasts. Panel pill stays; auto-toast is gone.
    if (typeof _aTrack === 'function') _aTrack('plan_preview_accept', { venue_id: venue.id, has_invite_id: !!opts.inviteId, off_plan_time: !!arrivalIso });
    // skipDetailOpen + keepCamera: the post-accept panel mounts as the
    // ONLY UI on top of the map. v1 had closePlanPreview opening the
    // detail panel via selectVenue, then post-accept overlay mounting
    // on top — which the user saw as 'panel sits wrongly on top of the
    // detail panel'. The new flow: plan-preview closes → post-accept
    // panel alone → on close, _closePostAcceptPanel opens the detail
    // panel (via stashed followupVenueId).
    closePlanPreview({ skipDetailOpen: true, keepCamera: true });
    setTimeout(() => {
      if (typeof _openPostAcceptPanel !== 'function') return;
      const whenLabel = (typeof _inviteWhenLabel === 'function' && opts.plannedAt)
        ? _inviteWhenLabel(opts.plannedAt.slice(0, 10), arrivalHour) : '';
      const arrivalDateLabel = (typeof _fmtInviteDate === 'function' && opts.plannedAt)
        ? _fmtInviteDate(opts.plannedAt.slice(0, 10)) : '';
      const sunUntilForAccepted = (sunEnd != null) ? formatHour(sunEnd) : '';
      const accepted = (typeof getPlansForVenue === 'function')
        ? (() => {
            const ps = getPlansForVenue(venue.id);
            const tgt = opts.plannedAt ? new Date(opts.plannedAt).getTime() : null;
            const p = tgt == null ? ps[0] : ps.find(x => x.planned_at && Math.abs(new Date(x.planned_at).getTime() - tgt) < 30 * 60 * 1000) || ps[0];
            const list = (p && Array.isArray(p._invitees)) ? p._invitees.filter(i => i.status === 'accepted') : [];
            return list.map(i => ({ name: (i.user && (i.user.name || i.user.email)) || '?', avatar_url: i.user && i.user.avatar_url }));
          })()
        : [];
      _openPostAcceptPanel({
        venueId:    venue.id,
        venueName:  venue.name,
        planId:     opts.planTokenP || null,
        plannedAt:  opts.plannedAt || null,
        // inviteId is the plan_invites row id — passed through so the
        // post-accept panel's 'Change response' affordance can reopen
        // the plan-preview with the same invite context (re-trigger
        // the accept/decline decision).
        inviteId:   opts.inviteId || null,
        whenLabel,
        arrivalDate: arrivalDateLabel,
        sunUntil:   sunUntilForAccepted,
        // Pass numeric sun-end + arrival hour so the post-accept panel
        // can swap 'sun until' → 'sun went down at' when the meeting
        // time is past the day's last sun window (same after-sundown
        // wording fix landed on the accept screen).
        sunEndNum:   sunEnd,
        arrivalHour: arrivalHour,
        inviterName: opts.inviterName || null,
        inviterId:   opts.inviterId || null,
        attendees:   accepted,
      });
    }, 360);
  };

  const declineBtn = el.querySelector('#pp-decline');
  if (declineBtn) declineBtn.onclick = async () => {
    if (typeof respondToPlanInvite === 'function' && opts.inviteId) {
      try { await respondToPlanInvite(opts.inviteId, 'declined'); } catch (e) { /* ignore */ }
    }
    if (typeof _aTrack === 'function') _aTrack('plan_preview_decline', { venue_id: venue.id, has_invite_id: !!opts.inviteId });
    // Decline path: do NOT open the venue's detail panel afterwards.
    // The user said no to this venue; drop them into explore mode
    // (first day with sun, camera on their location, list expanded)
    // so the app feels useful instead of stranding them on a venue
    // they just rejected. keepCamera tells closePlanPreview not to
    // run the savedCamera flyTo — _exitToExploreMode will fly to
    // userLocation in a single move, avoiding a janky two-stage
    // zoom-out.
    closePlanPreview({ skipDetailOpen: true, keepCamera: true });
    setTimeout(() => {
      if (typeof _exitToExploreMode === 'function') _exitToExploreMode();
    }, 200);
  };

  const closeCta = el.querySelector('#pp-close-cta');
  if (closeCta) closeCta.onclick = () => closePlanPreview();

  const shareCta = el.querySelector('#pp-share-onward');
  if (shareCta) shareCta.onclick = () => {
    if (typeof _shareInviteLink === 'function') _shareInviteLink(venue.id);
  };

  // Anon flow: any social CTA → login modal (per user preference: no
  // separate "log in to reply" copy, just open login on tap).
  const anonAccept = el.querySelector('#pp-anon-accept');
  if (anonAccept) anonAccept.onclick = () => {
    if (typeof _aTrack === 'function') _aTrack('plan_preview_anon_accept', { venue_id: venue.id });
    if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
  };
  const anonDecline = el.querySelector('#pp-anon-decline');
  if (anonDecline) anonDecline.onclick = () => {
    if (typeof _aTrack === 'function') _aTrack('plan_preview_anon_decline', { venue_id: venue.id });
    if (typeof window !== 'undefined') window._pendingInvite = null;
    // Anon decline takes the same explore-mode path as the logged-in
    // decline — the user said no, drop them somewhere useful instead
    // of stranding them on the rejected venue's detail panel.
    closePlanPreview({ skipDetailOpen: true, keepCamera: true });
    setTimeout(() => {
      if (typeof _exitToExploreMode === 'function') _exitToExploreMode();
    }, 200);
  };

  return el;
}

/** Walk-info helper — distance string + walk minutes. Returns { distLabel,
 *  walkMin } or null when no userLocation. ~80m/min pace. */
function _dprcvWalkInfo(venue) {
  if (typeof userLocation === 'undefined' || !userLocation || !venue) return null;
  const toRad = (d) => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(venue.lat - userLocation.lat);
  const dLng = toRad(venue.lng - userLocation.lng);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(userLocation.lat)) * Math.cos(toRad(venue.lat)) * Math.sin(dLng/2)**2;
  const m = 2 * R * Math.asin(Math.sqrt(a));
  const distLabel = m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  const walkMin = Math.max(1, Math.round(m / 80));
  return { distLabel, walkMin };
}

window.openPlanPreview  = openPlanPreview;
window.closePlanPreview = closePlanPreview;
