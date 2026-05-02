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

  // Camera choreography: start from a CONSISTENT high-altitude top-down view
  // (so the user always gets the same orienting "from above" sense regardless
  // of where they were on the map), then pan/dive to the venue.
  //   Phase 0 (instant):   jumpTo zoom 12, pitch 0 — far above, top-down
  //   Phase 1 (1400ms):    flyTo overview at zoom 14.5, pitch 15 — slight tilt as we close in
  //   Phase 2 (1500ms):    easeTo dive — zoom 17.6, pitch 58° to reveal building shadows
  //   Phase 3 (after settle): begin shadow time-lapse (5s, 78% forward / 22% settle-back)
  const PHASE1_MS = 1400;
  const PHASE2_MS = 1500;
  const TIMELAPSE_MS = 5000;
  const phase2TimeoutId = { id: null };
  const phase3TimeoutId = { id: null };
  if (typeof map !== 'undefined' && map && typeof map.flyTo === 'function') {
    // Phase 0: instant snap to a known starting state — same every time.
    try {
      map.jumpTo({
        center: [venue.lng, venue.lat],
        zoom:    12,
        pitch:   0,
        bearing: 0,
      });
    } catch (e) { /* ignore */ }
    map.flyTo({
      center: [venue.lng, venue.lat],
      zoom:   14.5,
      pitch:  15,
      bearing: 0,
      duration: PHASE1_MS,
      curve: 1.5,
      easing: t => 1 - Math.pow(1 - t, 3),
      essential: true,
    });
    phase2TimeoutId.id = setTimeout(() => {
      if (!_planPreviewState) return;
      try {
        map.easeTo({
          zoom:   17.6,
          pitch:  58,
          bearing: 0,
          duration: PHASE2_MS,
          easing: t => t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2,
          essential: true,
        });
      } catch (e) { /* ignore */ }
    }, PHASE1_MS - 80);
  }

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
    timeouts: [phase2TimeoutId, phase3TimeoutId],
    autoplayDone: false,
  };

  requestAnimationFrame(() => {
    overlay.classList.add('open');
  });

  // Time-lapse only after the dive settles.
  if (animateTo > planHour + 0.05) {
    phase3TimeoutId.id = setTimeout(() => {
      if (!_planPreviewState) return;
      _ppAnimate(planHour, animateTo, TIMELAPSE_MS);
    }, PHASE1_MS + PHASE2_MS - 80);
  }

  if (typeof _aTrack === 'function') {
    _aTrack('plan_preview_opened', { venue_id: venue.id, mode: opts.mode || 'preview' });
  }
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
  // Force a repaint at the new container size on the next frame.
  requestAnimationFrame(() => {
    if (typeof drawFtsCanvas === 'function') drawFtsCanvas();
  });
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
    const readout = document.getElementById('pp-time');
    if (readout && typeof formatHour === 'function') readout.textContent = formatHour(h);
    if (t < 1) {
      _planPreviewState.rafId = requestAnimationFrame(step);
    } else {
      // Snap to exact invited hour to avoid floating-point off-by-one (e.g. 14:59 vs 15:00)
      if (timeFromEl) {
        timeFromEl.value = fromH;
        timeFromEl.dispatchEvent(new Event('input'));
      }
      if (readout && typeof formatHour === 'function') readout.textContent = formatHour(fromH);
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
        const dots = accepted.slice(0, max).map(i => {
          const u = i.user;
          if (u && u.avatar_url) return `<img class="pp-av" src="${u.avatar_url}" alt="">`;
          const initial = ((u && (u.name || u.email)) || '?')[0].toUpperCase();
          return `<div class="pp-av pp-av-init">${initial}</div>`;
        }).join('');
        const more  = accepted.length > max ? `<div class="pp-av pp-av-init">+${accepted.length - max}</div>` : '';
        const names = accepted.map(i => {
          const n = (i.user && (i.user.name || i.user.email)) || '';
          return n.split(' ')[0].split('@')[0];
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
  let ctaHtml = '';
  if (isInviteUI && opts.mode === 'invite-anon') {
    ctaHtml = `<button class="pp-cta pp-cta-accept" id="pp-login">${t('pp_login_to_respond')}</button>`;
  } else if (isInviteUI) {
    ctaHtml = `
      <button class="pp-cta pp-cta-accept" id="pp-accept">${t('plan_preview_im_in')}</button>
      <button class="pp-cta-decline" id="pp-decline">${t('plan_decline')}</button>`;
  } else {
    ctaHtml = `<button class="pp-cta pp-cta-accept" id="pp-close-cta">${t('close')}</button>`;
  }

  const isInvite = (opts.mode === 'invite' || opts.mode === 'invite-anon');
  const inviterAvatarHtml = isInvite
    ? (opts.inviterAvatarUrl
        ? `<img class="pp-inviter-av" src="${opts.inviterAvatarUrl}" alt="">`
        : `<div class="pp-inviter-av pp-inviter-av-init">${(opts.inviterName || '?')[0].toUpperCase()}</div>`)
    : '';
  const inviterText = isInvite
    ? (opts.inviterName ? t('pp_eyebrow_invited_by', { name: opts.inviterName }) : t('pp_eyebrow_invited'))
    : '';

  // Sun-til chip on the right of the venue row (replaces the cryptic
  // "{time} → {sunUntil}" arrow and the "kl. {time} · sol til {sunUntil}" sub).
  const sunUntilLabel = (animateTo > planHour + 0.05 && typeof formatHour === 'function')
    ? t('invite_sun_until', { time: formatHour(animateTo) })
    : '';

  const meetingTimeHtml = `
    <div class="pp-meet-row">
      <span class="pp-meet-label">${t('pp_meet_label')}</span>
      <span class="pp-meet-time" id="pp-meet-time">${formatHour(planHour)}</span>
    </div>`;

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
      <div class="pp-wx">
        <span class="pp-wx-icon">${wxIcon}</span>
        ${wxTemp ? `<span class="pp-wx-temp">${wxTemp}</span>` : ''}
        ${wxDetail && !isInvite ? `<span class="pp-wx-detail">${wxDetail}</span>` : ''}
      </div>
    </div>
    <div class="pp-bottom">
      <div class="pp-card-row">
        <div class="pp-card-left">
          <div class="pp-card-name">${venue.name}</div>
          ${venue.area ? `<div class="pp-card-meta">${venue.area}</div>` : ''}
        </div>
        ${sunUntilLabel ? `<div class="pp-sun-chip">☀️ ${sunUntilLabel}</div>` : ''}
      </div>
      ${meetingTimeHtml}
      <div class="pp-fts-slot"></div>
      <div class="pp-readout-row">
        <span class="pp-readout-label">${t('time_label')}</span>
        <span class="pp-readout-value" id="pp-time">${formatHour(planHour)}</span>
      </div>
      ${attendeesHtml}
      <div class="pp-cta-row">${ctaHtml}</div>
    </div>`;

  el.querySelector('#pp-back').onclick = () => closePlanPreview();

  // Listen for time changes (driven by FTS or the slider in the wider app) to
  // keep the readout in sync. FTS dispatches 'input' on timeFromEl.
  const onTimeInput = () => {
    if (_planPreviewState) {
      // First user FTS interaction also cancels the autoplay + camera timeouts.
      if (_planPreviewState.rafId) {
        cancelAnimationFrame(_planPreviewState.rafId);
        _planPreviewState.rafId = null;
        _planPreviewState.autoplayDone = true;
      }
    }
    const readout = el.querySelector('#pp-time');
    if (readout && typeof formatHour === 'function' && timeFromEl) {
      readout.textContent = formatHour(parseFloat(timeFromEl.value));
    }
  };
  if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.addEventListener('input', onTimeInput);
  el._cleanup = () => {
    if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.removeEventListener('input', onTimeInput);
  };

  const acceptBtn = el.querySelector('#pp-accept');
  if (acceptBtn) acceptBtn.onclick = async () => {
    if (typeof respondToPlanInvite === 'function' && opts.inviteId) {
      try { await respondToPlanInvite(opts.inviteId, 'accepted'); } catch (e) { /* ignore */ }
    }
    if (typeof _showToast === 'function') _showToast(t('plan_preview_joined'));
    if (typeof _aTrack === 'function') _aTrack('plan_preview_accept', { venue_id: venue.id, has_invite_id: !!opts.inviteId });
    closePlanPreview();
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

  return el;
}

window.openPlanPreview  = openPlanPreview;
window.closePlanPreview = closePlanPreview;
