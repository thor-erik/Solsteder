/**
 * ui-plan-preview.js — Full-screen invitation preview takeover.
 *
 * Triggered when:
 *   1. A user lands via a `#invite/<token>` or `/i/<token>` link
 *   2. A user taps "Preview" on a plan card in the detail panel
 *
 * The takeover hides app chrome and lets the live map (with shadows) show
 * through. The live `#fts` element is reparented into the bottom card and
 * acts as the time scrubber while the preview is open. On close, the FTS
 * is handed off to the detail panel's docked-card timeline slot via the
 * existing FLIP morph in app.js (_flipFtsFromCardTimeline).
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
 *             _flipFtsFromCardTimeline, drawFtsCanvas, _showToast.
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

  // Camera: instant snap to the dive state directly above the venue. No pan
  // animation — the receiver shouldn't see a wandering camera before the
  // content lands. The bottom panel slides up over this fixed view.
  //
  // The Mapbox `padding.bottom` offset shifts the camera's logical center up
  // so the venue sits centered in the visible map area (the map extends below
  // the bottom panel, but the panel covers it). Estimated panel height — used
  // before the panel is in the DOM, so we approximate from the viewport.
  const TIMELAPSE_MS = 5000;
  const phase3TimeoutId = { id: null };
  if (typeof map !== 'undefined' && map && typeof map.jumpTo === 'function') {
    const vh = (window.visualViewport?.height ?? window.innerHeight);
    // Bottom panel typically takes ~42% of the viewport (cap matches CSS max-height).
    const panelH = Math.min(Math.round(vh * 0.42), 460);
    // Top bar (back button + inviter chip + weather) takes ~80px including
    // safe-area + 16px margin. Including it in the camera padding centers the
    // venue VISUALLY between the top bar and the bottom panel — without it
    // Mapbox centers between viewport top and panel top, leaving the venue
    // ~40px above visual center on a typical phone.
    const topBarH = 96;
    try {
      map.jumpTo({
        center:  [venue.lng, venue.lat],
        zoom:    17.6,
        pitch:   58,
        bearing: 0,
        padding: { top: topBarH, bottom: panelH, left: 0, right: 0 },
      });
    } catch (e) { /* ignore */ }
  }
  // Camera has settled on the venue — reveal the map (the head-script gate
  // had #map hidden so the receiver wouldn't see the Oslo fallback flash).
  document.documentElement.classList.remove('invite-loading');

  const overlay = _ppBuildDom(venue, opts, { planHour, animateTo, dateStr });
  document.body.appendChild(overlay);

  // Reparent the live #fts element into the bottom card's slot. The same canvas,
  // listeners, and time-sync as the rest of the app — so dragging it during the
  // preview drives shadow rendering exactly like elsewhere.
  _ppFtsAttach();

  _planPreviewState = {
    overlay,
    venueId:  venue.id,
    inviterId: opts.inviterId || null,
    savedTime, savedDate, savedCamera,
    planHour, animateTo, dateStr,
    rafId: null,
    timeouts: [phase3TimeoutId],
    autoplayDone: false,
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

/** Wire up the drag handle (.pp-grabber) for drag-to-dismiss. Tracks touch
 *  Y-delta, applies translateY to the panel during drag, and either closes
 *  or snaps back on release based on a 100px threshold (or fast flick). */
function _ppWireDragHandle(overlay) {
  const grabber = overlay.querySelector('.pp-grabber');
  const panel = overlay.querySelector('.pp-bottom');
  if (!grabber || !panel) return;
  let startY = null;
  let startT = null;
  let dragging = false;
  const THRESHOLD_PX = 100;
  const FLICK_VELOCITY = 0.6; // px/ms

  const onStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    startY = t.clientY;
    startT = performance.now();
    dragging = true;
    panel.style.transition = 'none';
  };
  const onMove = (e) => {
    if (!dragging || startY == null) return;
    const t = e.touches ? e.touches[0] : e;
    const dy = Math.max(0, t.clientY - startY);
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
    }
  };

  grabber.addEventListener('touchstart', onStart, { passive: true });
  grabber.addEventListener('touchmove', onMove, { passive: false });
  grabber.addEventListener('touchend', onEnd, { passive: true });
  grabber.addEventListener('touchcancel', onEnd, { passive: true });
  // Mouse fallback for desktop testing
  grabber.addEventListener('mousedown', (e) => {
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
  // Visual affordance for the grabber as a pointer area
  grabber.style.cursor = 'grab';
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
  if (st.savedDate != null && datePicker && datePicker.value !== st.savedDate) {
    datePicker.value = st.savedDate;
    datePicker.dispatchEvent(new Event('change'));
  }
  if (st.savedTime != null && timeFromEl) {
    timeFromEl.value = st.savedTime;
    timeFromEl.dispatchEvent(new Event('input'));
  }

  // Capture FTS rect IN preview slot before we detach — used as the FLIP source.
  const fts = document.getElementById('fts');
  const ftsSrcRect = (fts && fts.classList.contains('fts-in-preview'))
    ? fts.getBoundingClientRect() : null;
  // Detach FTS from preview slot, reset it to body so openDetailPanel can run
  // its own pre-stage. We pass ftsSrcRect to the FLIP routine after the panel
  // morph completes, animating FTS from the preview position into the docked card.
  _ppFtsDetach();

  // Choose post-close destination:
  //  - venueId set → open the detail panel (proper docked card with FTS)
  //  - no venueId → just remove the takeover and restore camera
  const venueId = st.venueId;
  const venue = (typeof VENUES !== 'undefined') ? VENUES.find(v => String(v.id) === String(venueId)) : null;

  st.overlay.classList.remove('open');
  document.body.classList.remove('plan-preview-active');
  setTimeout(() => { try { st.overlay.remove(); } catch {} }, 320);
  _planPreviewState = null;

  if (venue && typeof selectVenue === 'function') {
    // Open the detail panel from a clean state (no plan-preview-active class
    // hiding the source venue-card). openDetailPanel runs its FLIP morph on the
    // venue-card → docked-card; FTS will be appended into the docked-card
    // .card-timeline after the morph (~340ms).
    selectVenue(venueId, true);
    // After the morph completes, FLIP the FTS from the captured preview-slot rect
    // to its current docked-card position. The user sees a single smooth motion
    // from the bottom card to the timeline slot.
    if (ftsSrcRect && typeof _flipFtsFromCardTimeline === 'function') {
      setTimeout(() => _flipFtsFromCardTimeline(ftsSrcRect), 380);
    }
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

/** Reparent #fts into the plan-preview's slot. CSS rule with .fts-in-preview
 *  flattens position and width to fill the slot. drawFtsCanvas re-renders at
 *  the new size. _syncFtsPosition skips while fts-in-preview is set. */
function _ppFtsAttach() {
  const fts = document.getElementById('fts');
  const slot = document.querySelector('.pp-fts-slot');
  if (!fts || !slot) return;
  // If FTS is currently docked into a detail-panel card, lift it cleanly first.
  fts.classList.remove('fts-in-card');
  fts.style.cssText = '';
  fts.classList.add('fts-in-preview');
  slot.appendChild(fts);
  // Ensure the slider is fully visible (defensive — the body.plan-preview-active
  // hide rule sets opacity 0; the .fts-in-preview override should re-show it,
  // but explicitly setting the property here protects against any cascade
  // race when the panel opens for an anon receiver landing fresh on the link).
  fts.style.opacity = '1';
  fts.style.pointerEvents = 'auto';
  // Force a repaint at the new container size on the next frame, then again
  // after data loads (solar tables / weather may arrive late on a fresh
  // invite-link landing).
  requestAnimationFrame(() => {
    if (typeof drawFtsCanvas === 'function') drawFtsCanvas();
  });
  setTimeout(() => {
    if (typeof drawFtsCanvas === 'function') drawFtsCanvas();
  }, 600);
}

/** Reverse: detach FTS from the preview slot and put it back on the body. The
 *  caller (closePlanPreview) is responsible for whatever follows. */
function _ppFtsDetach() {
  const fts = document.getElementById('fts');
  if (!fts) return;
  fts.classList.remove('fts-in-preview');
  fts.style.cssText = '';
  if (fts.parentNode !== document.body) document.body.appendChild(fts);
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

function _ppWxIcon(wx) {
  if (!wx) return '☀';
  if ((wx.precip || 0) > 0.4) return '🌧';
  if ((wx.cloud  || 0) > 0.7) return '☁';
  if ((wx.cloud  || 0) > 0.35) return '⛅';
  return '☀';
}

function _ppWxDetail(wx) {
  if (!wx) return '';
  const parts = [];
  if (wx.wspd != null)               parts.push(`${Math.round(wx.wspd)} m/s`);
  if (wx.precip != null && wx.precip > 0.1) parts.push(`${wx.precip.toFixed(1)} mm`);
  return parts.join(' · ');
}

/** Short condition label for the bottom-card weather row (e.g. "Lett skyet"). */
function _ppWxLabel(wx) {
  if (!wx) return '';
  if ((wx.precip || 0) > 0.4) return t('wx_rain') || 'Regn';
  if ((wx.cloud  || 0) > 0.7) return t('wx_overcast') || 'Overskyet';
  if ((wx.cloud  || 0) > 0.35) return t('wx_partly_cloudy') || 'Lett skyet';
  return t('wx_clear') || 'Sol';
}

function _ppBuildDom(venue, opts, { planHour, animateTo, dateStr }) {
  const el = document.createElement('div');
  el.id = 'plan-preview';
  el.className = 'plan-preview';

  const wx       = (typeof getWeatherAt === 'function') ? getWeatherAt(dateStr, Math.floor(planHour)) : null;
  const wxIcon   = _ppWxIcon(wx);
  const wxTemp   = (wx && wx.temp != null) ? `${Math.round(wx.temp)}°` : '';
  const wxDetail = _ppWxDetail(wx);

  // Attendees (logged-in only — getPlansForVenue is empty for anonymous users)
  let attendeesHtml = '';
  if (typeof getPlansForVenue === 'function') {
    const plans = getPlansForVenue(venue.id);
    const target = opts.plannedAt ? new Date(opts.plannedAt).getTime() : null;
    const plan = target == null
      ? plans[0]
      : plans.find(p => p.planned_at && Math.abs(new Date(p.planned_at).getTime() - target) < 30 * 60 * 1000)
        || plans[0];
    if (plan && Array.isArray(plan._invitees) && plan._invitees.length) {
      const accepted = plan._invitees.filter(i => i.status === 'accepted');
      if (accepted.length) {
        const max  = 5;
        const planMs = plan.planned_at ? new Date(plan.planned_at).getTime() : null;
        const fmtArrival = (i) => {
          if (!i.arrival_time || !planMs) return '';
          const arrMs = new Date(i.arrival_time).getTime();
          if (Math.abs(arrMs - planMs) < 5 * 60 * 1000) return ''; // <5min off → not worth flagging
          const d = new Date(arrMs);
          return formatHour(d.getHours() + d.getMinutes() / 60);
        };
        // Avatars come with a tiny time chip when arrival_time differs from the plan
        const dots = accepted.slice(0, max).map(i => {
          const u = i.user;
          const av = (u && u.avatar_url)
            ? `<img class="pp-av" src="${u.avatar_url}" alt="">`
            : `<div class="pp-av pp-av-init">${(((u && (u.name || u.email)) || '?')[0]).toUpperCase()}</div>`;
          const arr = fmtArrival(i);
          return `<div class="pp-av-wrap">${av}${arr ? `<span class="pp-av-time">${arr}</span>` : ''}</div>`;
        }).join('');
        const more  = accepted.length > max ? `<div class="pp-av-wrap"><div class="pp-av pp-av-init">+${accepted.length - max}</div></div>` : '';
        const names = accepted.map(i => {
          const n = (i.user && (i.user.name || i.user.email)) || '';
          const first = n.split(' ')[0].split('@')[0];
          const arr = fmtArrival(i);
          return arr ? `${first} (${arr})` : first;
        }).filter(Boolean).slice(0, 4).join(', ');
        attendeesHtml = `
          <div class="pp-attendees">
            <div class="pp-att-label">${t('attendees_label', { count: accepted.length })}</div>
            <div class="pp-att-row">${dots}${more}</div>
            ${names ? `<div class="pp-att-names">${names}</div>` : ''}
          </div>`;
      }
    }
  }

  // CTAs vary by mode. For ANY invite-style URL (mode invite / invite-anon),
  // we surface Accept / Decline so the design + intent reads correctly. Buttons
  // gracefully no-op when no real plan_invites row exists (testing tokens, or
  // the user is the plan creator clicking their own link). 'preview' shows Lukk.
  const isInviteUI = (opts.mode === 'invite' || opts.mode === 'invite-anon');
  // Arrival-time chip is integrated INTO the accept button so the action and
  // the time the user is committing to read as one cohesive concept (vs. a
  // separate "Kommer kl." row that competed with the meeting-time hero). Only
  // built for logged-in invite mode (anon users can't write yet).
  const arrivalChipHtml = (opts.mode === 'invite')
    ? `<span class="pp-arrival-chip" id="pp-arrival-chip" role="button" tabindex="0" aria-label="${t('arrival_change_label') || 'Change arrival time'}">
         <span id="pp-arrival-time">${formatHour(planHour)}</span>
         <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 5 6 8 9 5"/></svg>
       </span>`
    : '';
  let ctaHtml = '';
  if (isInviteUI && opts.mode === 'invite-anon') {
    // Anon receivers see the same accept/decline pair as logged-in receivers.
    // The accept tap stashes intent and opens the login modal; after login,
    // _tryPendingInvite re-opens the takeover in invite mode (with a real
    // inviteId) and the user confirms with a second tap. Lower friction +
    // mirrors Eventbrite/Partiful conventions vs the prior 'Logg inn for å
    // svare' gate. Decline in anon mode = just close the takeover (no DB
    // write needed for an anonymous "no").
    ctaHtml = `
      <button class="pp-cta pp-cta-accept" id="pp-anon-accept" type="button">
        <span class="pp-cta-label">${t('plan_preview_im_in_at') || t('plan_preview_im_in')}</span>
        <span class="pp-cta-time">${formatHour(planHour)}</span>
      </button>
      <button class="pp-cta-decline" id="pp-anon-decline">${t('plan_decline')}</button>`;
  } else if (isInviteUI) {
    ctaHtml = `
      <button class="pp-cta pp-cta-accept pp-cta-with-chip" id="pp-accept" type="button">
        <span class="pp-cta-label">${t('plan_preview_im_in_at') || t('plan_preview_im_in')}</span>
        ${arrivalChipHtml}
      </button>
      <button class="pp-cta-decline" id="pp-decline">${t('plan_decline')}</button>`;
  } else {
    ctaHtml = `<button class="pp-cta pp-cta-accept" id="pp-close-cta">${t('close')}</button>`;
  }

  const isInvite = (opts.mode === 'invite' || opts.mode === 'invite-anon');
  // Inviter chip: avatar + name when known. When no name (anon token, missing
  // metadata), show only the text — a "?" placeholder reads as a broken state.
  const inviterAvatarHtml = isInvite && opts.inviterName
    ? (opts.inviterAvatarUrl
        ? `<img class="pp-inviter-av" src="${opts.inviterAvatarUrl}" alt="">`
        : `<div class="pp-inviter-av pp-inviter-av-init">${opts.inviterName[0].toUpperCase()}</div>`)
    : '';
  const inviterText = isInvite
    ? (opts.inviterName ? t('pp_eyebrow_invited_by', { name: opts.inviterName }) : t('pp_eyebrow_invited'))
    : '';

  // Sun-til chip on the right of the venue row (replaces the cryptic
  // "{time} → {sunUntil}" arrow and the "kl. {time} · sol til {sunUntil}" sub).
  const sunUntilLabel = (animateTo > planHour + 0.05 && typeof formatHour === 'function')
    ? t('invite_sun_until', { time: formatHour(animateTo) })
    : '';

  // Meeting time hero — date next to time so the receiver doesn't have to
  // infer the day. Norwegian short-date formatter is reused from ui-detail.
  const meetingDateLabel = (typeof _fmtInviteDate === 'function' && dateStr)
    ? _fmtInviteDate(dateStr) : '';
  const meetingTimeHtml = `
    <div class="pp-meet-row">
      <span class="pp-meet-label">${t('pp_meet_label')}</span>
      <span class="pp-meet-time" id="pp-meet-time">${formatHour(planHour)}</span>
      ${meetingDateLabel ? `<span class="pp-meet-date">· ${meetingDateLabel}</span>` : ''}
    </div>`;

  // Weather row — icon + temp + wind + condition. Replaces the small
  // disconnected weather chip in the top bar with a proper context line in
  // the bottom card. All fields are optional; the row hides if nothing useful.
  const wxConditionLabel = wx ? _ppWxLabel(wx) : '';
  const wxWindLabel = (wx && wx.wspd != null) ? `${Math.round(wx.wspd)} m/s` : '';
  const weatherParts = [];
  if (wxTemp) weatherParts.push(`<span class="pp-wx-row-temp">${wxIcon} ${wxTemp}</span>`);
  if (wxWindLabel) weatherParts.push(`<span>${wxWindLabel}</span>`);
  if (wxConditionLabel) weatherParts.push(`<span>${wxConditionLabel}</span>`);
  const weatherRowHtml = weatherParts.length
    ? `<div class="pp-wx-row">${weatherParts.join(' <span class="pp-wx-row-sep">·</span> ')}</div>`
    : '';

  el.innerHTML = `
    <div class="pp-top ${isInvite ? 'pp-top-invite' : ''}">
      <button class="pp-back" id="pp-back" aria-label="${t('back')}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      ${isInvite ? `
        <div class="pp-inviter">
          ${inviterAvatarHtml}
          <div class="pp-inviter-text">${inviterText}</div>
        </div>
      ` : ''}
      ${!isInvite ? `
        <div class="pp-wx">
          <span class="pp-wx-icon">${wxIcon}</span>
          ${wxTemp ? `<span class="pp-wx-temp">${wxTemp}</span>` : ''}
          ${wxDetail ? `<span class="pp-wx-detail">${wxDetail}</span>` : ''}
        </div>` : ''}
    </div>
    <div class="pp-bottom">
      <div class="pp-grabber" aria-hidden="true"></div>
      <div class="pp-card-row">
        <div class="pp-card-left">
          <div class="pp-card-name">${venue.name}</div>
          ${venue.area ? `<div class="pp-card-meta">${venue.area}</div>` : ''}
        </div>
        ${sunUntilLabel ? `<div class="pp-sun-chip">☀️ ${sunUntilLabel}</div>` : ''}
      </div>
      ${meetingTimeHtml}
      <div class="pp-fts-slot"></div>
      ${weatherRowHtml}
      ${attendeesHtml}
      <div class="pp-cta-row">${ctaHtml}</div>
    </div>`;

  el.querySelector('#pp-back').onclick = () => closePlanPreview();

  // First user FTS interaction cancels the autoplay + camera timeouts. The
  // map shadows + slider knob now provide all the scrub feedback (the textual
  // readout that used to live below the slider was redundant with both).
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

  // Arrival-time chip — opens a hidden <input type="time"> on tap. The chosen
  // hour rides along on the I'm in click as plan_invites.arrival_time. Default
  // (chip not interacted with) = plan time, written as the same ISO so the
  // host's view reads consistently. Floating-point hour is converted to ISO
  // using opts.plannedAt as the date anchor.
  // Arrival chip lives INSIDE the accept button. Click on the chip opens the
  // hidden time picker but must not bubble up to the button (which would also
  // accept the invite). Keyboard: Space/Enter on the chip opens the picker.
  const arrivalChip = el.querySelector('#pp-arrival-chip');
  let arrivalHour = planHour;
  let arrivalInput = null;
  if (arrivalChip) {
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
      // Visual cue when arrival differs from plan
      arrivalChip.classList.toggle('pp-arrival-off', Math.abs(arrivalHour - planHour) > 0.05);
    });
  }

  const acceptBtn = el.querySelector('#pp-accept');
  if (acceptBtn) acceptBtn.onclick = async () => {
    // Compute arrival_time ISO from the chip (or null if the user kept plan time)
    let arrivalIso = null;
    if (arrivalChip && Math.abs(arrivalHour - planHour) > 0.05) {
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
    // Post-accept share nudge — only when the receiver is friends with the
    // inviter (or has no inviter context). For non-friends, the friend-add
    // banner (set in app.js token resolution as window._pendingFriendPrompt)
    // takes priority — adding a friend matters more than sharing right after
    // an invite from a stranger.
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
    // Post-accept question panel — slides up from the bottom over the peeked
    // detail panel after the takeover finishes closing. Replaces the prior
    // in-social-card banners (friend-prompt + share-nudge) which felt like
    // misplaced notifications. Delay matches the close-animation tail (320ms).
    setTimeout(() => {
      if (typeof _openPostAcceptPanel !== 'function') return;
      const whenLabel = (typeof _inviteWhenLabel === 'function' && opts.plannedAt)
        ? _inviteWhenLabel(opts.plannedAt.slice(0, 10), planHour) : '';
      _openPostAcceptPanel({
        venueId:   venue.id,
        venueName: venue.name,
        planId:    opts.planTokenP || null,
        plannedAt: opts.plannedAt || null,
        whenLabel,
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
  const loginCta = el.querySelector('#pp-login');
  if (loginCta) loginCta.onclick = () => {
    if (typeof _aTrack === 'function') _aTrack('plan_preview_login_prompt', { venue_id: venue.id });
    if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
  };
  // Anon accept: stash intent (window._pendingInvite was set during token
  // resolution) and open the login modal. After login,
  // auth.js _tryPendingInvite re-opens the takeover in invite mode with a
  // real inviteId; the user confirms with a second tap. Anon decline just
  // closes the takeover — no DB write needed for an anonymous "no".
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

window.openPlanPreview  = openPlanPreview;
window.closePlanPreview = closePlanPreview;
