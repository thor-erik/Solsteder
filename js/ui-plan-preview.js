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
  if (typeof map !== 'undefined' && map && typeof map.jumpTo === 'function') {
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
    savedTime, savedDate, savedCamera,
    planHour, animateTo, dateStr,
    rafId: null,
    timeouts: [phase3TimeoutId],
    autoplayDone: false,
    resizeObs,
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

  if (typeof _aTrack === 'function') _aTrack('plan_preview_locate', { state: _planPreviewState.locateState || 'fit' });

  // Toggle between the two states. State 'fit' = both visible; 'user' = zoomed on user.
  const next = _planPreviewState.locateState === 'fit' ? 'user' : 'fit';
  _planPreviewState.locateState = next;

  if (next === 'fit' && hasUser) {
    // Fit bounds containing both venue and user.
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

  if (next === 'user' && hasUser) {
    // Zoom in on the user's location.
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

  // No userLocation — center back on venue at the dive state.
  try {
    map.easeTo({
      center: [venue.lng, venue.lat],
      zoom: 17.6,
      pitch: 58,
      bearing: 0,
      duration: 600,
      padding,
    });
  } catch (e) { /* ignore */ }
  _planPreviewState.locateState = 'fit'; // reset since we couldn't toggle
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

function closePlanPreview() {
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

  if (venue && typeof selectVenue === 'function') {
    // Open the detail panel — it runs its own FLIP morph + FTS hosting from
    // the venue-card source; no FTS hand-off needed from here since the
    // plan-preview no longer reparents FTS.
    selectVenue(venueId, true);
  } else if (st.savedCamera && typeof map !== 'undefined' && map && typeof map.flyTo === 'function') {
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
  let remainingStr = '';
  if (sunEnd != null) {
    const rem = sunEnd - planHour;
    if (rem > 0) {
      const h = Math.floor(rem);
      const m = Math.max(0, Math.round((rem - h) * 60));
      remainingStr = t('invite_hero_remaining', { h, m });
    } else {
      remainingStr = t('invite_hero_remaining_no_sun');
    }
  }

  // ── Inline icon set (Lucide-style)
  const checkSvg    = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const clockSvg    = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const editSvg     = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  const xSvg        = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>`;
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

  // ── CTAs vary by mode
  let ctaHtml = '';
  if (isInvite) {
    const acceptId = isAnon ? 'pp-anon-accept' : 'pp-accept';
    const declineId = isAnon ? 'pp-anon-decline' : 'pp-decline';
    ctaHtml = `
      <button class="dprcv-cta-primary" id="${acceptId}" type="button">
        ${checkSvg}
        ${t('plan_preview_im_in')}
      </button>
      <div class="dprcv-cta-row">
        <button class="dprcv-cta-btn" id="pp-suggest" type="button">
          ${editSvg}
          ${t('invite_secondary_suggest')}
        </button>
        <button class="dprcv-cta-btn dprcv-cta-decline" id="${declineId}" type="button">
          ${xSvg}
          ${t('plan_decline')}
        </button>
      </div>`;
  } else if (isPreview) {
    ctaHtml = `
      <button class="dprcv-cta-primary" id="pp-share-onward" type="button">
        ${sendSvg}
        ${t('preview_share_onwards')}
      </button>
      <div class="dprcv-cta-row">
        <button class="dprcv-cta-btn" id="pp-close-cta" type="button">${t('close')}</button>
      </div>`;
  }

  // ── From-friend pill (top floating)
  const inviterName = (opts.inviterName || '').replace(/</g, '&lt;');
  const inviterFirstLetter = (opts.inviterName || '?')[0].toUpperCase();
  const inviterColor = (inviterFirstLetter.charCodeAt(0) || 0) % 8;
  const inviterAvHtml = opts.inviterAvatarUrl
    ? `<img src="${opts.inviterAvatarUrl}" alt="">`
    : `<div class="dpinvite-avatar-init init-color-${inviterColor}" style="width:100%;height:100%;font-size:13px;border-radius:50%">${inviterFirstLetter}</div>`;
  const sentSub = isInvite ? (t('invite_hero_sent_ago', { ago: '' }).replace(/{ago}/g, '').trim() || '') : '';
  const topPillHtml = isInvite ? `
    <div class="dprcv-top-pill">
      <div class="dprcv-top-pill-card">
        <div class="dprcv-top-pill-av">${inviterAvHtml}</div>
        <span class="dprcv-top-pill-name">${inviterName || t('pp_eyebrow_invited')}</span>
        ${sentSub ? `<span class="dprcv-top-pill-sub">${sentSub}</span>` : ''}
      </div>
    </div>` : '';

  // Eyebrow above venue name
  const eyebrow = isInvite
    ? (opts.inviterName ? t('pp_invited_line_named', { name: inviterName }) : t('pp_invited_line_anon'))
    : (sunEnd != null ? `${t('invite_hero_sun_until')} ${sunUntilStr}` : '');

  // Build full DOM
  el.innerHTML = `
    ${topPillHtml}
    <div class="dprcv-bottom">
      <div class="dprcv-handle pp-handle" id="pp-handle" aria-label="${t('close')}">
        <div class="dprcv-grabber pp-grabber" aria-hidden="true"></div>
      </div>
      <div class="dprcv-title-block">
        ${eyebrow ? `<div class="dprcv-eyebrow">${eyebrow}</div>` : ''}
        <div class="dprcv-venue">${venue.name.replace(/</g, '&lt;')}</div>
        ${metaHtml ? `<div class="dprcv-meta">${metaHtml}</div>` : ''}
      </div>
      <div class="dprcv-hero">
        <div class="dprcv-hero-row">
          <div class="dprcv-hero-left">
            <div class="dprcv-hero-label">${t('invite_hero_meets')}</div>
            ${opts.mode === 'invite' ? `
              <button class="dprcv-arrival-chip" id="pp-arrival-chip" type="button" aria-label="${t('arrival_change_label') || 'Change arrival time'}">
                <span id="pp-arrival-time">${planTimeStr}</span>
                ${chevDownSvg}
              </button>` : `<div class="dprcv-arrival-time" id="pp-arrival-time">${planTimeStr}</div>`}
            ${arrivalSub ? `<div class="dprcv-arrival-sub">${arrivalSub}</div>` : ''}
          </div>
          <div class="dprcv-hero-right">
            <div class="dprcv-hero-label">${t('invite_hero_sun_until')}</div>
            <div class="dprcv-suntil-time">${sunUntilStr}</div>
            ${remainingStr ? `<div class="dprcv-remaining">${remainingStr}</div>` : ''}
          </div>
        </div>
        <div class="dprcv-timeline">
          <canvas class="card-timeline-canvas dprcv-timeline-canvas" data-vid="${venue.id}" width="600" height="32"></canvas>
          <div class="dprcv-arrival-overlay" id="pp-arrival-overlay">
            <div class="dprcv-arrival-pin" id="pp-arrival-pin"></div>
          </div>
        </div>
      </div>
      ${attendeesHtml}
      ${ctaHtml}
    </div>`;

  // Paint the canvas via the same walker the venue list uses.
  if (typeof drawAllCardTimelines === 'function') {
    drawAllCardTimelines(el);
  }

  // Position the arrival pin overlay (mirrors the canvas's MIN_H_ARC..MAX_H_ARC domain).
  const positionPin = () => {
    const minH = (typeof MIN_H_ARC === 'number') ? MIN_H_ARC : 4;
    const maxH = (typeof MAX_H_ARC === 'number') ? MAX_H_ARC : 23;
    const span = Math.max(0.0001, maxH - minH);
    const pin = el.querySelector('#pp-arrival-pin');
    if (pin) {
      const pct = Math.max(0, Math.min(100, ((planHour - minH) / span) * 100));
      pin.style.left = `${pct}%`;
    }
  };
  positionPin();

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

  // Arrival chip — opens hidden <input type="time"> on tap. Keyboard: Space/Enter.
  const arrivalChip = el.querySelector('#pp-arrival-chip');
  let arrivalHour = planHour;
  let arrivalInput = null;
  if (arrivalChip && opts.mode === 'invite') {
    arrivalInput = document.createElement('input');
    arrivalInput.type = 'time';
    arrivalInput.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none;';
    arrivalInput.value = `${String(Math.floor(planHour)).padStart(2,'0')}:${String(Math.round((planHour - Math.floor(planHour)) * 60)).padStart(2,'0')}`;
    arrivalChip.appendChild(arrivalInput);
    const openPicker = (e) => {
      if (e) { e.stopPropagation(); e.preventDefault(); }
      arrivalInput.showPicker?.() || arrivalInput.click();
    };
    arrivalChip.addEventListener('click', openPicker);
    arrivalChip.addEventListener('keydown', e => {
      if (e.key === ' ' || e.key === 'Enter') openPicker(e);
    });
    arrivalInput.addEventListener('change', () => {
      const m = arrivalInput.value.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return;
      arrivalHour = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
      const lbl = el.querySelector('#pp-arrival-time');
      if (lbl) lbl.textContent = formatHour(arrivalHour);
    });
  }

  // "Annet tidspunkt" secondary — same opener as the chip.
  const suggestBtn = el.querySelector('#pp-suggest');
  if (suggestBtn && arrivalInput) {
    suggestBtn.onclick = (e) => {
      e.preventDefault();
      arrivalInput.showPicker?.() || arrivalInput.click();
    };
  } else if (suggestBtn) {
    suggestBtn.onclick = () => {
      if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
    };
  }

  // Accept handler — same backend contract; new UI shell.
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
    if (typeof _showToast === 'function') _showToast(t('plan_preview_joined'));
    if (typeof _aTrack === 'function') _aTrack('plan_preview_accept', { venue_id: venue.id, has_invite_id: !!opts.inviteId, off_plan_time: !!arrivalIso });
    closePlanPreview();
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
        whenLabel,
        arrivalDate: arrivalDateLabel,
        sunUntil:   sunUntilForAccepted,
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
    closePlanPreview();
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
    closePlanPreview();
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
