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

  // Auto-detect invite mode — if the current user is the receiver of a
  // pending plan_invite for this plan, force mode='invite' so the sheet
  // renders Accept/Decline regardless of how the caller invoked us.
  // This overrides mode='preview' too (a caller passing 'preview' often
  // doesn't know the user is also an invitee — notifications.js bell
  // actions, deeplink handlers in auth.js, etc.). The only callers we
  // respect-without-override are those that explicitly set 'invite' or
  // 'invite-anon' (they already have the inviteId + inviter data).
  const matchingInvite = (
    opts.plannedAt &&
    typeof _planInvites !== 'undefined' &&
    Array.isArray(_planInvites)
  )
    ? _planInvites.find(inv => {
        if (!inv || !inv.plan) return false;
        // Match pending AND declined invites — a user re-opening a
        // notification they previously declined should land in invite
        // mode so they can change their answer to 'I'm in'. The plan-
        // preview footer reads the current status when it renders, so
        // the button row reflects "you've declined" if applicable.
        // Accepted invites also match: opening from the bell row gives
        // them the Accept/Decline footer too, so they can flip to
        // declined or just see the plan in context.
        if (String(inv.plan.venue_id) !== String(opts.venueId)) return false;
        // Tolerate sub-second differences between the ISO string in the
        // notification payload and the one Supabase stored.
        const a = new Date(inv.plan.planned_at).getTime();
        const b = new Date(opts.plannedAt).getTime();
        return !isNaN(a) && !isNaN(b) && Math.abs(a - b) < 60 * 1000;
      })
    : null;
  if (matchingInvite && opts.mode !== 'invite' && opts.mode !== 'invite-anon') {
    opts.mode = 'invite';
    opts.inviteId = opts.inviteId || matchingInvite.id;
    opts.inviterName = opts.inviterName || matchingInvite.plan?.creator?.name || '';
  }

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
  // Reset the worker-done flag — the splash hide-out below waits on
  // .timeline-ready so the user never sees the sync-fallback 'simple
  // facing' bar before the worker-corrected version lands.
  document.body.classList.remove('timeline-ready');

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

  // Stash invite-pin context for render-pins.js. While the accept page
  // (or the post-accept confirm) is on screen, the single pin on the
  // map renders as a vertical card hanging above the venue, listing
  // every accepted attendee (avatar + first name, plus a honey-tinted
  // discrepancy like '+10m' if they're arriving off the meet time).
  // The receiver themselves is excluded — pin shows 'who else is
  // going', the panel handles their own RSVP. Only set for invite
  // modes; preview mode (user looking at their own plan) keeps the
  // standard pill.
  const _isInviteMode = (opts.mode === 'invite' || opts.mode === 'invite-anon');
  let _pinAttendees = [];
  if (_isInviteMode) {
    // Resolve attendees from test override OR live plan_invites cache.
    // Order matters: inviter first (host convention), then by accept
    // time. Tests synthesize a deterministic list; production reads
    // from the plan record loaded by getPlansForVenue.
    if (typeof window !== 'undefined' && window._testAttendeesCount) {
      const n = window._testAttendeesCount;
      const fallbackNames = ['Anna', 'Jonas', 'Marit', 'Erik', 'Ida', 'Lars', 'Sofie', 'Tobias'];
      const names = (Array.isArray(window._testAttendeesNames) && window._testAttendeesNames.length)
        ? window._testAttendeesNames
        : fallbackNames;
      const offsets = Array.isArray(window._testAttendeesOffsets) ? window._testAttendeesOffsets : [];
      for (let i = 0; i < n; i++) {
        const offsetMin = Number.isFinite(offsets[i]) ? offsets[i] : 0;
        _pinAttendees.push({
          id:        'test-' + i,
          name:      names[i % names.length],
          offsetMin: offsetMin,
        });
      }
    } else if (typeof getPlansForVenue === 'function') {
      const plans = getPlansForVenue(venue.id);
      const target = opts.plannedAt ? new Date(opts.plannedAt).getTime() : null;
      const plan = target == null ? plans[0] : (
        plans.find(p => p.planned_at && Math.abs(new Date(p.planned_at).getTime() - target) < 30 * 60 * 1000)
        || plans[0]
      );
      const myId = (typeof authCurrentUser === 'function' && authCurrentUser())
        ? authCurrentUser().id : null;
      // Prepend the inviter (plan creator). They're implicitly attending
      // their own plan, and the receiver expects to see the host on the
      // pin alongside any accepted invitees. plan.creator is now the
      // embedded profile row (FK target fixed in migration 023);
      // opts.inviterName / opts.inviterId is the fallback when the
      // caller had the data before the panel opened.
      const inviterUser = (plan && plan.creator) || null;
      const inviterId   = (inviterUser && inviterUser.id) || opts.inviterId || null;
      const inviterRaw  = (inviterUser && (inviterUser.name || inviterUser.email)) || opts.inviterName || '';
      if (inviterId && (!myId || String(inviterId) !== String(myId))) {
        _pinAttendees.push({
          id:        inviterId,
          name:      String(inviterRaw).split('@')[0].split(' ')[0],
          offsetMin: 0,
        });
      }
      if (plan && Array.isArray(plan._invitees)) {
        const accepted = plan._invitees.filter(i => i.status === 'accepted');
        for (const inv of accepted) {
          if (myId && inv.user && String(inv.user.id) === String(myId)) continue; // exclude self
          if (inviterId && inv.user && String(inv.user.id) === String(inviterId)) continue; // already added
          const u = inv.user || {};
          let offsetMin = 0;
          if (inv.arrival_time && plan.planned_at) {
            offsetMin = Math.round((new Date(inv.arrival_time).getTime() - new Date(plan.planned_at).getTime()) / 60000);
          }
          _pinAttendees.push({
            id:        u.id || null,
            name:      (u.name || u.email || '').split('@')[0],
            offsetMin: offsetMin,
          });
        }
      }
    }
  }
  if (typeof window !== 'undefined') {
    window._invitePin = _isInviteMode ? {
      venueId:    venue.id,
      meetHour:   planHour,
      attendees:  _pinAttendees,
    } : null;
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
  // Skip camera dive + splash work on reopen — the 'Change response'
  // path re-enters openPlanPreview while the camera is already framed
  // on the venue and the splash is long gone. Replaying jumpTo/flyTo
  // (zoom 14 → 17.6 over 1500 ms) was visible as a 'zoom out then
  // dive back in' regression.
  const _skipDive = !!opts.skipCameraDive;
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
        // Was 17.6 — user feedback that the dive was too close across
        // detail / invite / accept. 16.75 matches _flyToVenue.
        zoom:    16.75,
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
  if (!_skipDive) {
    // Hold the splash until BOTH (a) the splash-min duration has
    // elapsed AND (b) the worker has finished the precise sun windows
    // (= body has .timeline-ready). Whichever lands second triggers
    // the hide. v1 hid on min-duration only, so the user could see
    // the sync-fallback bar briefly before the worker corrected it.
    // 2.5 s safety cap so a broken / offline worker never strands the
    // splash forever.
    const _splashReleased = { value: false };
    const _releaseSplash = () => {
      if (_splashReleased.value) return;
      _splashReleased.value = true;
      // Release the boot draw gate AND reveal the canvas + chrome at
      // the same moment we dismiss the splash. _skipIntro({keepSplash:
      // true}) left the gate closed for this path; the plan-invite
      // takeover needs the pin canvas visible so the inviter avatar
      // pin shows. (Locate-me / zoom-jog visibility is then governed
      // by body.plan-preview-active CSS rules.)
      if (typeof window._revealCanvasAndChrome === 'function') {
        window._revealCanvasAndChrome();
      } else if (typeof window._releaseBootDrawGate === 'function') {
        window._releaseBootDrawGate();
      }
      _hideInviteSplash();
      setTimeout(_startDive, 200);
    };
    const _waitForTimelineReady = (maxMs) => new Promise(res => {
      if (document.body.classList.contains('timeline-ready')) return res();
      const start = performance.now();
      const tick = () => {
        if (document.body.classList.contains('timeline-ready')) return res();
        if (performance.now() - start > maxMs) return res();
        requestAnimationFrame(tick);
      };
      tick();
    });
    Promise.all([
      new Promise(r => setTimeout(r, Math.max(0, _splashWaitMs))),
      _waitForTimelineReady(2500),
    ]).then(_releaseSplash);
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
  // Seed the locate-button cycle to 'dive' (venue icon) since the
  // plan-preview opens with the camera framed on the venue. First tap
  // moves to 'fit'. _setLocateBtnState animates the swap (push-down).
  if (typeof _setLocateBtnState === 'function') _setLocateBtnState('dive');

  const overlay = _ppBuildDom(venue, opts, { planHour, animateTo, dateStr });
  document.body.appendChild(overlay);

  // Fit meta pills after the overlay is in the DOM so we have real
  // widths to measure against. Re-run on viewport resize (e.g.
  // orientation change).
  requestAnimationFrame(() => {
    const metaEl = overlay.querySelector('.dprcv-meta');
    if (metaEl && typeof window._fitMetaPills === 'function') {
      window._fitMetaPills(metaEl);
    }
  });
  if (typeof ResizeObserver !== 'undefined') {
    const metaEl = overlay.querySelector('.dprcv-meta');
    if (metaEl) {
      const ro = new ResizeObserver(() => {
        if (typeof window._fitMetaPills === 'function') window._fitMetaPills(metaEl);
      });
      ro.observe(overlay);
      overlay._metaResizeObs = ro;
    }
  }

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

  // Remember whether the detail panel was open BEFORE the preview took
  // over — closePlanPreview restores back to that state instead of
  // unconditionally opening the detail panel. Without this, swipe-down
  // close always landed on the venue's detail panel even when the user
  // came from the list / map / bell, which read as "I dismissed it but
  // got dragged into a different layer." The bell-row / push-deeplink
  // path doesn't have a detail panel underneath; the in-app "preview
  // this plan" path from the detail panel does.
  const _detailWasOpen = (typeof document !== 'undefined')
    && !!document.getElementById('detail-panel')?.classList.contains('open');

  _planPreviewState = {
    overlay,
    venueId:  venue.id,
    inviterId: opts.inviterId || null,
    savedTime, savedDate, savedCamera, savedSelectedId,
    detailWasOpen: _detailWasOpen,
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

  // Time-lapse starts AFTER the camera dive finishes — otherwise the
  // sun + shadow scrub plays out while the camera is still tilting in,
  // and the user sees the shadow march end before the venue is even
  // framed. Two paths:
  //   - _skipDive (reopen, e.g. "Change response"): camera is already
  //     where we want it, so kick off after the panel slide-in settles
  //     (320 ms is the overlay transform transition).
  //   - Fresh open (camera dive will run): wait for the flyTo's moveend
  //     before starting, with a 3500 ms safety net in case 'moveend'
  //     somehow doesn't land (offline tile fetches stalling, etc.).
  if (animateTo > planHour + 0.05) {
    const _kickAnim = () => {
      if (!_planPreviewState) return;
      if (_planPreviewState.autoplayDone) return;
      _ppAnimate(planHour, animateTo, TIMELAPSE_MS);
    };
    if (_skipDive) {
      phase3TimeoutId.id = setTimeout(_kickAnim, 360);
    } else if (typeof map !== 'undefined' && map && typeof map.once === 'function') {
      // moveend fires when the flyTo settles. _startDive is itself
      // gated on a splash-min wait, so subscribe here (before that
      // setTimeout runs) and Mapbox queues us correctly.
      let fired = false;
      const onMoveEnd = () => { if (fired) return; fired = true; _kickAnim(); };
      map.once('moveend', onMoveEnd);
      // Safety: a 3500 ms backstop covers splash-wait (≤1500) + flyTo
      // duration (1500) + a 500 ms buffer.
      phase3TimeoutId.id = setTimeout(() => { onMoveEnd(); }, 3500);
    } else {
      phase3TimeoutId.id = setTimeout(_kickAnim, 360);
    }
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
  if (typeof _setLocateBtnState === 'function') _setLocateBtnState(next);

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
      // Was 17.6 — user wanted less aggressive zoom across detail / invite
      // / accept. 16.75 matches _flyToVenue and gives a ring of surrounding
      // context.
      zoom: 16.75,
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
  const handle  = overlay.querySelector('.dprcv-handle') || overlay.querySelector('.pp-handle');
  const grabber = overlay.querySelector('.dprcv-grabber') || overlay.querySelector('.pp-grabber');
  const panel   = overlay.querySelector('.dprcv-bottom') || overlay.querySelector('.pp-bottom');
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
  if (grabber) {
    // Only set touch-action — never inflate the visible pill with padding.
    // The expanded tap target lives on the parent .dprcv-handle wrapper
    // (10px padding above + below the pill), which is the actual
    // touchstart/mousedown target. Adding padding to the grabber itself
    // turned the 38×4 pill into a ~62×28 box because box-sizing defaults
    // to content-box on this element.
    grabber.style.touchAction = 'none';
  }
}

function closePlanPreview(opts = {}) {
  const st = _planPreviewState;
  if (!st) return;
  // Drop the hero-refresh hook so the worker callback doesn't try to
  // mutate the now-detached DOM after the takeover closes.
  if (typeof window !== 'undefined') window._refreshAcceptPageHero = null;
  if (st.rafId) cancelAnimationFrame(st.rafId);
  if (Array.isArray(st.timeouts)) {
    for (const tref of st.timeouts) { if (tref && tref.id != null) clearTimeout(tref.id); }
  }
  if (st.resizeObs) { try { st.resizeObs.disconnect(); } catch {} }
  if (st.overlay && st.overlay._metaResizeObs) {
    try { st.overlay._metaResizeObs.disconnect(); } catch {}
  }
  // Drop FTS scrubber + timeFromEl + outside-tap listeners wired during _ppBuildDom.
  if (st.overlay && typeof st.overlay._cleanup === 'function') {
    try { st.overlay._cleanup(); }
    catch (e) { console.warn('[plan-preview] overlay cleanup threw', e); }
  }
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
  // Drop the locate-button cycle state so the button reverts to its
  // default single-action 'fly to me' (user icon) when nothing on the
  // map is venue-focused anymore. _setLocateBtnState handles the animation.
  if (typeof _setLocateBtnState === 'function') _setLocateBtnState(null);
  setTimeout(() => { try { st.overlay.remove(); } catch {} }, 320);
  _planPreviewState = null;

  if (!opts.skipDetailOpen && st.detailWasOpen && venue && typeof selectVenue === 'function') {
    // Open the detail panel — it runs its own FLIP morph + FTS hosting from
    // the venue-card source; no FTS hand-off needed from here since the
    // plan-preview no longer reparents FTS.
    // Gated on detailWasOpen so we only return to the detail panel when
    // the user came from there. Bell-row / push / share-link entries fall
    // into the else branch below where the venue list is surfaced.
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
    // No detail panel was open before AND we're not in a skipDetailOpen
    // handoff (post-accept transition). Without recovery the user is
    // dropped onto a bare map: chrome was hidden by plan-preview-active,
    // and removing the class on close is a no-op visually because no
    // other surface re-appears. Slide the venue list up — same motion
    // as the page-load intro so the user sees it arrive explicitly.
    if (!opts.skipDetailOpen && !st.detailWasOpen && window.innerWidth < 640) {
      try {
        if (typeof window._slideUpVenueListToExpanded === 'function') {
          window._slideUpVenueListToExpanded();
        } else if (typeof window._applyMobilePanelState === 'function') {
          window._applyMobilePanelState('expanded');
        }
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

  // Default mode to 'preview' when callers omit it. Several entry points
  // (notifications.js bellActions, auth.js nav, deeplink handlers) call
  // openPlanPreview without setting opts.mode, which previously caused
  // both isInvite AND isPreview to evaluate false → ctaHtml='' → no
  // visible Accept/Share buttons at the bottom of the sheet. User-
  // reported as "the buttons on the accepts panel disappeared after
  // backend connection fixes" — the backend fix changed which entry
  // points fire, exposing the missing-default bug.
  if (opts.mode !== 'invite' && opts.mode !== 'invite-anon') {
    opts.mode = 'preview';
  }

  // Past-event branch — when the plan's scheduled time is more than 30
  // minutes in the past, the panel is purely retrospective: Accept /
  // Decline / Share onwards aren't meaningful actions. Override mode to
  // suppress the active-CTA branches; the eyebrow + footer below render
  // a "Tidligere · {date}" label and a single Lukk button. 30-minute
  // grace window keeps the active CTAs visible for the brief "just
  // arrived" moment when users typically still want to RSVP.
  const isPast = !!opts.plannedAt && (
    new Date(opts.plannedAt).getTime() < Date.now() - 30 * 60 * 1000
  );

  // Cancelled plan — detect from any live source we have access to.
  // Receiver-side: _planInvites[i].plan.cancelled_at. Creator-side:
  // _plans[i].cancelled_at. Fallback: opts.cancelled (some callers
  // pass it explicitly from the notification nav payload). Overrides
  // every other mode/branch: a cancelled plan only shows context +
  // Lukk, no Accept/Decline/Share.
  let isCancelled = !!opts.cancelled;
  if (!isCancelled && opts.plannedAt) {
    const planMs = new Date(opts.plannedAt).getTime();
    const findMatch = (arr, getPlan) => arr && arr.find(item => {
      const pl = getPlan(item);
      if (!pl || String(pl.venue_id) !== String(opts.venueId)) return false;
      const t = new Date(pl.planned_at).getTime();
      return !isNaN(t) && Math.abs(t - planMs) < 60 * 1000;
    });
    const fromInvites = (typeof _planInvites !== 'undefined' && Array.isArray(_planInvites))
      ? findMatch(_planInvites, i => i.plan) : null;
    const fromPlans = (typeof _plans !== 'undefined' && Array.isArray(_plans))
      ? findMatch(_plans, p => p) : null;
    if ((fromInvites && fromInvites.plan && fromInvites.plan.cancelled_at)
        || (fromPlans && fromPlans.cancelled_at)) {
      isCancelled = true;
    }
  }

  const isInvite     = !isPast && !isCancelled && (opts.mode === 'invite' || opts.mode === 'invite-anon');
  const isAnon       = !isPast && !isCancelled && (opts.mode === 'invite-anon');
  const isPreview    = !isPast && !isCancelled && (opts.mode === 'preview');

  // ── Venue meta line: area · category · "{dist} m" · walk-icon "{walkMin} min"
  const venueArea = venue.area || '';
  const venueCat  = (typeof catLabel === 'function') ? catLabel(venue) : '';
  const distMin   = _dprcvWalkInfo(venue);
  // Material 'directions_walk' glyph — walking person mid-stride. Same
  // shape Google Maps + Apple Maps both use, so the metaphor is
  // immediately legible.
  const walkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>`;
  // Walk chip drops the textual ' min walk' suffix in favour of a glyph
  // + the minute number. Less repetition with the unit and visually
  // anchors the chip as 'walking time' at a glance.
  // 4 metas: area · category · distance · walk-time (separately so each
  // reads as its own pill of information). v1 joined area+cat into one
  // chunk; user feedback was that the metas felt halved.
  // Each pill is wrapped in `.dprcv-meta-item` so _fitMetaPills (called
  // after layout) can drop whole trailing pills + their preceding dot
  // when the row overflows, instead of letting the browser ellipsise
  // a partial pill ("5 mi…").
  const metaParts = [
    venueArea ? { html: venueArea.replace(/</g, '&lt;') } : null,
    venueCat  ? { html: venueCat.replace(/</g, '&lt;')  } : null,
    distMin && distMin.distLabel ? { html: distMin.distLabel.replace(/</g, '&lt;') } : null,
    distMin && distMin.walkMin != null
      ? { html: `<span class="dprcv-meta-walk">${walkSvg}<span>${distMin.walkMin} min</span></span>` }
      : null,
  ].filter(Boolean).filter(p => p.html);
  const metaHtml = metaParts.map((p, i) =>
    (i > 0 ? '<span class="dprcv-meta-dot">·</span>' : '') + `<span class="dprcv-meta-item">${p.html}</span>`
  ).join('');

  // ── Hero header data (Møtes left, Sol til right)
  const planTimeStr = formatHour(planHour);
  // Relative-day phrasing for the subtitle — 'Today' / 'Tomorrow' /
  // 'Sunday' / '17 May'. v1 used _fmtInviteDate which always returned
  // 'Sun 17 May'-style, which read as a label, not data. The relative
  // form is what the receiver actually needs ('Tomorrow' is unmissable
  // in a way 'Sun 17 May' isn't). Capitalised so it carries weight.
  const _capFirst = (s) => (s && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const dateLabel = (typeof _dayLabel === 'function' && dateStr)
    ? _capFirst(_dayLabel(dateStr))
    : ((typeof _fmtInviteDate === 'function' && dateStr) ? _fmtInviteDate(dateStr) : '');
  const nowH        = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : planHour;
  const minutesUntil = Math.max(0, Math.round((planHour - nowH) * 60));
  // Left subtitle (under Meet at): just the day + (optionally) 'in X
  // min' for upcoming meets. Temp moved to the right side per user
  // request — pairs better with the sun-related info.
  const arrivalSubParts = [
    dateLabel,
    minutesUntil > 0 ? t('invite_hero_in_minutes', { n: minutesUntil }) : '',
  ].filter(Boolean);
  const arrivalSub = arrivalSubParts.join(' · ');
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
  // Temperature at meet time for the right subtitle.
  let meetTemp = null;
  try {
    if (typeof getWeatherAt === 'function' && dateStr) {
      const _wxMeet = getWeatherAt(dateStr, planHour + 0.001);
      if (_wxMeet && Number.isFinite(_wxMeet.temp)) meetTemp = Math.round(_wxMeet.temp);
    }
  } catch (e) { /* ignore */ }
  // Right subtitle reads: '☀ 11h 15m · 21°' (sun glyph + duration of
  // sun remaining + temp at meet time). User: 'sun icon then amount
  // of sun then · 21° (ie. remove "of sun")'. Build the duration part
  // inline so we don't have to fork the i18n keys to drop the ' of
  // sun' suffix — keeps the no/se/dk translations untouched.
  const _hSuf = (typeof t === 'function') ? (t('unit_h_short') || 't') : 't';
  const _durOnly = (rem) => {
    const h = Math.floor(rem);
    const m = Math.max(0, Math.round((rem - h) * 60));
    if (h > 0 && m > 0) return `${h}${_hSuf} ${m}m`;
    if (h > 0) return `${h}${_hSuf}`;
    return `${m}m`;
  };
  let remainingStr = '';
  if (sunEnd != null) {
    const rem = sunEnd - planHour;
    if (rem > 0) {
      // Sun glyph + duration; temp appended after a middot when available.
      const sunGlyph = (typeof TIMELINE_EVENT_GLYPHS !== 'undefined' && TIMELINE_EVENT_GLYPHS.sun)
        ? TIMELINE_EVENT_GLYPHS.sun : '';
      const parts = [`<span class="dprcv-remaining-glyph">${sunGlyph}</span><span>${_durOnly(rem)}</span>`];
      if (meetTemp != null) parts.push(`<span>${meetTemp}°</span>`);
      remainingStr = parts.join(' · ');
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

  // Sun-summary chip builder (used at render + by _refreshHero when the
  // worker delivers precise sun windows). Renders one line:
  //   "{sun-glyph} Sol til 20:40 · 2t 40m · 21°"
  // or the after-sundown variant. Returns '' when sunEnd is null so the
  // host can hide cleanly.
  const _buildSunChipContent = (endH, fromH, dStr, after, lblKey, untilStr) => {
    if (endH == null) return '';
    const sunGlyph = (typeof TIMELINE_EVENT_GLYPHS !== 'undefined' && TIMELINE_EVENT_GLYPHS.sun)
      ? TIMELINE_EVENT_GLYPHS.sun : '';
    const labelStr = `${t(lblKey)} ${untilStr}`;
    let detailParts = [];
    if (!after) {
      const rem = endH - fromH;
      if (rem > 0) detailParts.push(_durOnly(rem));
    } else {
      const gone = fromH - endH;
      if (gone < 1) {
        detailParts.push(t('invite_hero_sundown_minutes_ago', { n: Math.round(gone * 60) }));
      } else {
        const hh = Math.floor(gone);
        const mm = Math.max(0, Math.round((gone - hh) * 60));
        detailParts.push(mm > 0
          ? t('invite_hero_sundown_hm_ago', { h: hh, m: mm })
          : t('invite_hero_sundown_h_ago',  { h: hh }));
      }
    }
    let temp = null;
    try {
      if (typeof getWeatherAt === 'function' && dStr) {
        const _wx = getWeatherAt(dStr, fromH + 0.001);
        if (_wx && Number.isFinite(_wx.temp)) temp = Math.round(_wx.temp);
      }
    } catch (e) { /* ignore */ }
    if (temp != null) detailParts.push(`${temp}°`);
    // Glyph slots BEFORE the duration ("Sol til 20:40 · ☀ 2t 40m · 21°"),
    // not before the label — the label already names the metric ("Sol til"),
    // and the glyph reads as an icon FOR the duration itself. After-sundown,
    // the first detail is "X min ago" — the glyph there would read as a
    // sun glyph next to a past-tense duration, so it's omitted.
    const firstDetail = detailParts[0] || '';
    const restDetail  = detailParts.slice(1).join(' · ');
    const showGlyph   = firstDetail && !after;
    const firstHtml   = firstDetail
      ? `<span class="dprcv-sun-chip-sep" aria-hidden="true">·</span>`
      + (showGlyph ? `<span class="dprcv-sun-chip-glyph" aria-hidden="true">${sunGlyph}</span>` : '')
      + `<span class="dprcv-sun-chip-detail">${firstDetail}</span>`
      : '';
    const restHtml = restDetail
      ? `<span class="dprcv-sun-chip-sep" aria-hidden="true">·</span><span class="dprcv-sun-chip-detail">${restDetail}</span>`
      : '';
    return `<span class="dprcv-sun-chip-label">${labelStr}</span>${firstHtml}${restHtml}`;
  };

  // ── Inline icon set (Lucide-style)
  const checkSvg    = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const clockSvg    = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  const editSvg     = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;
  const xSvg        = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const sendSvg     = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`;
  const chevDownSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  // The attendees row has moved entirely onto the avatar pin (vertical
  // card above the venue) so the panel doesn't duplicate the same info.
  // Quoted message could still belong here in the future but the v1
  // share flow doesn't surface plan.message anywhere, so it's dropped.
  const attendeesHtml = '';

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
      <div class="dprcv-footer dprcv-footer-track">
        <div class="dprcv-action-track" id="pp-action-track">
          <div class="dprcv-action-pane">
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
            </div>
          </div>
          <div class="dprcv-action-pane dprcv-confirm-pane" id="pp-confirm-pane" aria-hidden="true"></div>
        </div>
      </div>`;
  } else if (isPreview) {
    // Detect creator-of-this-plan to surface the "Avlys plan" link.
    // In preview mode the user is almost always the creator (the
    // auto-detect routes invitees to 'invite' mode), but double-check
    // via _plans so we don't show Cancel to a passerby. The find-by-
    // venue+time match is the same lookup pattern used elsewhere.
    let isCreator = false;
    let cancelPlanId = null;
    try {
      const planMs = opts.plannedAt ? new Date(opts.plannedAt).getTime() : NaN;
      const ownPlan = (typeof _plans !== 'undefined' && Array.isArray(_plans))
        ? _plans.find(p => p && p.creator_id === (typeof _currentUser !== 'undefined' && _currentUser && _currentUser.id)
            && String(p.venue_id) === String(venue.id)
            && !isNaN(planMs)
            && Math.abs(new Date(p.planned_at).getTime() - planMs) < 60 * 1000
            && !p.cancelled_at)
        : null;
      if (ownPlan) { isCreator = true; cancelPlanId = ownPlan.id; }
    } catch (e) { /* leave isCreator false */ }
    const cancelLink = isCreator && cancelPlanId
      ? `<span class="dprcv-cta-sep" aria-hidden="true">·</span>
         <button class="dprcv-cta-link is-decline" id="pp-cancel-plan" data-plan-id="${cancelPlanId}" type="button"><span>Avlys plan</span></button>`
      : '';
    ctaHtml = `
      <div class="dprcv-footer">
        <button class="p-pill dprcv-cta-primary" id="pp-share-onward" type="button">
          ${sendSvg}
          ${t('preview_share_onwards')}
        </button>
        <div class="dprcv-cta-row">
          <button class="dprcv-cta-link" id="pp-close-cta" type="button"><span>${t('close')}</span></button>
          ${cancelLink}
        </div>
      </div>`;
  } else if (isPast) {
    // Past-event footer — single Lukk link, no primary CTA. Accept/Share
    // would be meaningless on a retrospective view; the eyebrow already
    // labels the context as past.
    ctaHtml = `
      <div class="dprcv-footer">
        <div class="dprcv-cta-row">
          <button class="dprcv-cta-link" id="pp-close-cta" type="button"><span>${t('close')}</span></button>
        </div>
      </div>`;
  } else if (isCancelled) {
    // Cancelled plan — same Lukk-only footer as past. The action set
    // is dead; the invitee/creator opened this just to read the
    // context of what was planned.
    ctaHtml = `
      <div class="dprcv-footer">
        <div class="dprcv-cta-row">
          <button class="dprcv-cta-link" id="pp-close-cta" type="button"><span>${t('close')}</span></button>
        </div>
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
  // Top 'From Anna' pill — removed. The vertical avatar pin anchored
  // to the venue already carries the inviter's avatar + name AND a
  // spatial relationship to the meeting place, so the top pill was
  // redundant + ambiguous ('am I Anna?'). User confirmed removal.
  const topPillHtml = '';

  // Eyebrow above venue name — sentence case (was ALL-CAPS in v1). Only
  // shown when the top "From {inviter}" pill is absent (anon token), so
  // we don't duplicate the same info on two surfaces. For named invites
  // the top pill carries the attribution and the venue line gets a
  // cleaner heading. For anon, the eyebrow is "{inviterName} inviterer
  // deg" (or anon fallback "Du er invitert"). The named-with-pill case
  // suppresses the eyebrow entirely.
  const hasTopPill = !!(isInvite && opts.inviterName);
  let eyebrow = '';
  if (isCancelled) {
    // Cancelled plan — the host called it off. Eyebrow says
    // "Kansellert" + the date the plan WAS for, so the invitee
    // knows which plan this references at a glance.
    const cancelDayLabel = (typeof _dayLabel === 'function' && dateStr)
      ? _capFirst(_dayLabel(dateStr))
      : ((typeof _fmtInviteDate === 'function' && dateStr) ? _fmtInviteDate(dateStr) : '');
    eyebrow = cancelDayLabel ? `Kansellert · ${cancelDayLabel}` : 'Kansellert';
  } else if (isPast) {
    // Past-event eyebrow — "Tidligere · i går" / "Tidligere · søndag" /
    // "Tidligere · 12. mai" depending on how far back. _dayLabel handles
    // the relative phrasing across all 4 locales.
    const pastDayLabel = (typeof _dayLabel === 'function' && dateStr)
      ? _capFirst(_dayLabel(dateStr))
      : ((typeof _fmtInviteDate === 'function' && dateStr) ? _fmtInviteDate(dateStr) : '');
    eyebrow = t('pp_past_eyebrow', { date: pastDayLabel || '' });
  } else if (isInvite) {
    // Inviter name renders inline, NOT wrapped in <strong>. User wanted
    // the whole eyebrow to read as one continuous voice (same weight,
    // same colour) — heavy-weight name was reading as a separate label
    // glued to a lighter caption.
    eyebrow = opts.inviterName
      ? t('pp_invited_line_named', { name: inviterName })
      : t('pp_invited_line_anon');
  } else {
    // Fallback so the eyebrow ALWAYS has content. Preview mode (the
    // creator viewing their own plan) and the rare race where the
    // invite row hasn't loaded yet would otherwise collapse this row
    // entirely, shifting venue + meta upward and breaking alignment
    // against the two-column header. Anon line ("You're invited to")
    // is the safest fallback — generic enough to fit either mode.
    eyebrow = t('pp_invited_line_anon');
  }

  // Venue line — pin glyph + name·area (same anchor pattern as the
  // invite sheet's moment block). Dedup area when redundant with the
  // venue name (e.g. "Mamma Pizza Nydalen" + area "Nydalen").
  const venuePinSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  // Title shows venue name only — the neighbourhood appears in the meta
  // line below ('Grünerløkka · Restaurant · 1.9 km'), so duplicating it
  // here read as redundant.
  const venueDisplay = venue.name.replace(/</g, '&lt;');

  // Sun chip content (between header and timeline). Built once here, refreshed
  // by _refreshHero below when the worker delivers precise sun windows.
  const sunChipHtml = _buildSunChipContent(sunEnd, planHour, dateStr, isAfterSundown, sunHeroLabelKey, sunUntilStr);
  // Stash for _refreshHero so it can rebuild against worker-corrected data
  // without redefining the closure.
  el._buildSunChipContent = _buildSunChipContent;

  // Build full DOM
  el.innerHTML = `
    ${topPillHtml}
    <div class="dprcv-bottom">
      <div class="dprcv-handle pp-handle" id="pp-handle" aria-label="${t('close')}">
        <div class="dprcv-grabber pp-grabber" aria-hidden="true"></div>
      </div>
      <div class="dprcv-title-block">
        <div class="dprcv-title-row">
          <div class="dprcv-title-col">
            <div class="dprcv-eyebrow">${eyebrow || '&nbsp;'}</div>
            <div class="dprcv-venue-row">
              <span class="dprcv-venue-pin" aria-hidden="true">${venuePinSvg}</span>
              <span class="dprcv-venue">${venueDisplay}</span>
            </div>
            ${metaHtml ? `<div class="dprcv-meta">${metaHtml}</div>` : ''}
          </div>
          <div class="dprcv-moment-col">
            <div class="dprcv-hero-label">${t('invite_hero_meets')}</div>
            <div class="dprcv-arrival-time" id="pp-arrival-time">${planTimeStr}</div>
            ${arrivalSub ? `<div class="dprcv-arrival-sub">${arrivalSub}</div>` : ''}
          </div>
        </div>
      </div>
      <div class="dprcv-sun-chip" aria-hidden="${sunChipHtml ? 'false' : 'true'}">${sunChipHtml}</div>
      <div class="dprcv-hero">
        <div class="dprcv-timeline">
          <!-- Weather row sits INSIDE the bar (overlayed on the canvas) —
               one centered glyph per same-state band of weather. Populated
               by _populateTimelineWeather after layout. -->
          <div class="dprcv-timeline-weather" data-vid="${venue.id}"></div>
          <!-- Scrubber pill — hidden until the user taps the bar. Then it
               appears at the touched hour with an FTS-style bubble above;
               further drags move it. Auto-hides after a brief idle. -->
          <div class="dprcv-timeline-scrubber" aria-hidden="true">
            <div class="dprcv-timeline-scrubber-label fts-popup">
              <div class="fts-popup-row fts-popup-primary">
                <span class="fts-popup-time"></span>
                <span class="fts-popup-wx-icon" aria-hidden="true"></span>
              </div>
              <div class="fts-popup-row fts-popup-secondary">
                <span class="fts-popup-temp"></span>
                <span class="fts-dot">·</span>
                <span class="fts-popup-wind"></span>
              </div>
            </div>
            <div class="dprcv-timeline-scrubber-pill"></div>
          </div>
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

  // Compute the bar's visible range — used for BOTH the canvas drag
  // mapping AND the scrubber positioning so they agree pixel-for-pixel.
  // v1 wired the canvas without overrides, so its handler mapped clicks
  // to MIN_H_ARC..MAX_H_ARC (the global FTS range, 4..23) — far wider
  // than the bar's visible range. Result: clicks in the left half of
  // the bar set timeFromEl < planHour, which clamped the scrubber to
  // xPct=0 (the meet edge). User reported 'no matter where, marker
  // appears at the start'.
  const _ppSundownH = (typeof findSunCrossingFromTable === 'function' && typeof currentSunTable !== 'undefined' && currentSunTable)
    ? findSunCrossingFromTable(currentSunTable, false)
    : (typeof MAX_H_ARC !== 'undefined' ? MAX_H_ARC : 22);
  const barMinH = planHour;
  const barMaxH = _ppSundownH || (planHour + 4);

  // Wire the canvas to drag-scrub timeFromEl, constrained to the bar's
  // own range so clicks land where the user expects.
  const ftsCanvas = el.querySelector('.dprcv-timeline-canvas');
  if (ftsCanvas && typeof window._wireInlineFtsCanvas === 'function') {
    window._wireInlineFtsCanvas(ftsCanvas, { minH: barMinH, maxH: barMaxH });
  }

  // Hero refresh — recompute sunEnd/duration/temperature against the
  // (possibly worker-corrected) cache and update the right-side
  // subtitle. v1 captured these once during DOM build, so when the
  // worker corrected the sun windows the bar repainted but the
  // 'Sun until 20:40 / 11h 15m / 21°' strings stayed stuck on the
  // sync-fallback values. Stashed on window so the app.js worker
  // callback can call it.
  const _refreshHero = () => {
    let _sunEnd = null;
    try {
      if (typeof computeSunWindows === 'function') {
        const sw2 = computeSunWindows(venue, dateStr);
        const ws2 = sw2 && sw2.windows ? sw2.windows : [];
        if (ws2.length) _sunEnd = ws2[ws2.length - 1].end;
      }
    } catch (e) { /* ignore */ }
    const chip = el.querySelector('.dprcv-sun-chip');
    if (!chip) return;
    const _isAfter = (_sunEnd != null && _sunEnd <= planHour);
    const _lblKey  = _isAfter ? 'invite_hero_sun_went_down' : 'invite_hero_sun_until';
    const _untilStr = (_sunEnd != null) ? formatHour(_sunEnd) : '—';
    const html = (typeof el._buildSunChipContent === 'function')
      ? el._buildSunChipContent(_sunEnd, planHour, dateStr, _isAfter, _lblKey, _untilStr)
      : '';
    chip.innerHTML = html;
    chip.setAttribute('aria-hidden', html ? 'false' : 'true');
  };
  window._refreshAcceptPageHero = _refreshHero;
  // Populate the in-bar weather row — one centred icon per same-state band
  // (sun / partly / cloud / rain), overlayed on the canvas. Mirrors the FTS
  // bar's segment colours, surfaced as glyphs for at-a-glance forecast.
  const weatherHost = el.querySelector('.dprcv-timeline-weather');
  const scrubberEl = el.querySelector('.dprcv-timeline-scrubber');
  const timelineEl = el.querySelector('.dprcv-timeline');
  if (weatherHost) {
    requestAnimationFrame(() => {
      try {
        _populateTimelineWeather(weatherHost, venue, dateStr, barMinH, barMaxH);
        // Wire the scrubber: when the user drags the bar (which the
        // existing _wireInlineFtsCanvas handler translates to
        // timeFromEl 'input' events) the pill slides, the label
        // updates with the hour + weather icon for that hour, and
        // the pill reveals. Outside-the-timeline clicks fade the
        // scrubber back out.
        if (scrubberEl && typeof timeFromEl !== 'undefined' && timeFromEl) {
          const labelEl = scrubberEl.querySelector('.dprcv-timeline-scrubber-label');
          const wxKeyAt = (h) => {
            if (typeof getWeatherAt !== 'function') return 'sun';
            const wx = getWeatherAt(dateStr, h + 0.5);
            if (!wx) return 'sun';
            const rain = (wx.precip ?? wx.prec ?? 0) > 0.3;
            if (rain) return 'rain';
            const cf = wx.sunBlock ?? wx.cloud ?? 0;
            if (cf < 0.25) return 'sun';
            if (cf < 0.75) return 'partly';
            return 'cloud';
          };
          // State at hour h — shade trumps weather (no sun on seating
          // means weather doesn't matter). Test-token override checks
          // the most recent d.events entry at/before h; real data uses
          // computeSunWindows + getWeatherAt.
          const stateAt = (h) => {
            if (typeof window !== 'undefined' && Array.isArray(window._testTimelineEvents) && window._testTimelineEvents.length) {
              const sorted = window._testTimelineEvents.slice().sort((a, b) => a.h - b.h);
              for (let i = sorted.length - 1; i >= 0; i--) {
                if (sorted[i].h <= h) return sorted[i].t;
              }
              // Fall through if h is before the first test event
            }
            if (typeof computeSunWindows === 'function') {
              const sw = computeSunWindows(venue, dateStr);
              const wins = (sw && sw.windows) || [];
              const inSunWindow = wins.some(w => h >= w.start && h <= w.end);
              if (!inSunWindow) return 'shade';
            }
            return wxKeyAt(h);
          };
          // Auto-hide timer — fades the scrubber back out a few seconds
          // after the last drag, so a lingering pill at a non-plan time
          // doesn't read as 'I've changed my arrival time to this'. The
          // outside-tap dismiss path (onDocPointer below) still runs
          // immediately when the user taps elsewhere; this just adds an
          // idle-timeout fallback. User: 'when you move the marker, it
          // should disappear after a while … so they don't think they
          // are selecting another time to join'.
          let _scrubAutoHideTimer = null;
          const SCRUB_AUTO_HIDE_MS = 2500;
          // Cache child slots — written per-frame as the user scrubs.
          const timeSlot = labelEl && labelEl.querySelector('.fts-popup-time');
          const wxSlot   = labelEl && labelEl.querySelector('.fts-popup-wx-icon');
          const tempSlot = labelEl && labelEl.querySelector('.fts-popup-temp');
          const windSlot = labelEl && labelEl.querySelector('.fts-popup-wind');
          // Visibility is GATED on real user interaction — autoplay scrubs
          // through the timeline by dispatching synthetic 'input' events on
          // timeFromEl, which fire this `update` function. v3 used an
          // isAutoplaying-flag toggle here, but the final autoplay frame
          // arrived AFTER autoplayDone flipped to true, briefly flashing
          // the bubble at the settle position. The new contract: position
          // updates happen always (so the marker is correct when the user
          // first interacts), but is-active is only ever added by
          // onCanvasDown below. The auto-hide timer reset still happens
          // here so continued scrubbing keeps the bubble alive.
          const update = () => {
            const h = parseFloat(timeFromEl.value);
            if (!Number.isFinite(h)) return;
            const xPct = Math.max(0, Math.min(100, ((h - barMinH) / (barMaxH - barMinH)) * 100));
            scrubberEl.style.left = xPct + '%';
            if (labelEl) {
              if (timeSlot) timeSlot.textContent = formatHour(h);
              if (wxSlot)   wxSlot.innerHTML = TIMELINE_EVENT_GLYPHS[stateAt(h)] || '';
              try {
                if (typeof getWeatherAt === 'function') {
                  const _wx = getWeatherAt(dateStr, h + 0.001);
                  if (tempSlot) tempSlot.textContent = (_wx && Number.isFinite(_wx.temp)) ? `${Math.round(_wx.temp)}°` : '';
                  if (windSlot) windSlot.textContent = (_wx && Number.isFinite(_wx.wspd)) ? `${Math.round(_wx.wspd)} m/s` : '';
                }
              } catch (e) { /* ignore */ }
            }
            // Only refresh the auto-hide timer if the bubble is already
            // visible (the user is in the middle of a scrub session).
            // Don't add is-active here.
            if (scrubberEl.classList.contains('is-active')) {
              if (_scrubAutoHideTimer) clearTimeout(_scrubAutoHideTimer);
              _scrubAutoHideTimer = setTimeout(() => {
                scrubberEl.classList.remove('is-active');
                scrubberEl.classList.remove('is-dragging');
                if (labelEl) labelEl.classList.remove('fts-popup-expanded');
                _scrubAutoHideTimer = null;
              }, SCRUB_AUTO_HIDE_MS);
            }
          };
          const onDocPointer = (ev) => {
            if (!scrubberEl.classList.contains('is-active')) return;
            if (timelineEl && timelineEl.contains(ev.target)) return;
            scrubberEl.classList.remove('is-active');
            if (_scrubAutoHideTimer) { clearTimeout(_scrubAutoHideTimer); _scrubAutoHideTimer = null; }
          };
          // Tap vs drag — first input after pointerdown uses the slow
          // 'slide-to-position' transition; subsequent pointermoves
          // switch to instant tracking. Means a tap looks like a smooth
          // glide to the tapped hour, but a drag still feels 1:1 with
          // the finger. On pointerdown the bubble morphs to the FTS-popup
          // expanded vocab (larger, accent time, wx + temp + wind row);
          // pointerup snaps back to compact.
          const onCanvasDown = () => {
            scrubberEl.classList.remove('is-dragging');
            // Reveal the bubble — this is the ONLY place is-active is
            // added, so autoplay (which only fires synthetic 'input'
            // events, never pointerdown) can't accidentally surface it.
            scrubberEl.classList.add('is-active');
            if (labelEl) labelEl.classList.add('fts-popup-expanded');
            // Kick off the auto-hide timer so an idle bar fades the
            // bubble out 2.5 s after the last input.
            if (_scrubAutoHideTimer) clearTimeout(_scrubAutoHideTimer);
            _scrubAutoHideTimer = setTimeout(() => {
              scrubberEl.classList.remove('is-active');
              scrubberEl.classList.remove('is-dragging');
              if (labelEl) labelEl.classList.remove('fts-popup-expanded');
              _scrubAutoHideTimer = null;
            }, SCRUB_AUTO_HIDE_MS);
          };
          const onCanvasMove = (ev) => {
            if (ev.buttons === 0 && ev.pressure === 0 && ev.pointerType !== 'touch') return;
            scrubberEl.classList.add('is-dragging');
          };
          const onCanvasUp = () => {
            if (labelEl) labelEl.classList.remove('fts-popup-expanded');
          };
          if (ftsCanvas) {
            ftsCanvas.addEventListener('pointerdown', onCanvasDown);
            ftsCanvas.addEventListener('pointermove', onCanvasMove);
            ftsCanvas.addEventListener('pointerup', onCanvasUp);
            ftsCanvas.addEventListener('pointercancel', onCanvasUp);
          }
          timeFromEl.addEventListener('input', update);
          document.addEventListener('pointerdown', onDocPointer);
          // Chain cleanup so closePlanPreview's _cleanup() drops all.
          const prevCleanup = el._cleanup;
          el._cleanup = () => {
            if (prevCleanup) prevCleanup();
            if (_scrubAutoHideTimer) { clearTimeout(_scrubAutoHideTimer); _scrubAutoHideTimer = null; }
            timeFromEl.removeEventListener('input', update);
            document.removeEventListener('pointerdown', onDocPointer);
            if (ftsCanvas) {
              ftsCanvas.removeEventListener('pointerdown', onCanvasDown);
              ftsCanvas.removeEventListener('pointermove', onCanvasMove);
              ftsCanvas.removeEventListener('pointerup', onCanvasUp);
              ftsCanvas.removeEventListener('pointercancel', onCanvasUp);
            }
          };
        }
      } catch (e) { /* never block render on event errors */ }
    });
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
  const _prevCleanupOnTime = el._cleanup;
  el._cleanup = () => {
    if (_prevCleanupOnTime) _prevCleanupOnTime();
    if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.removeEventListener('input', onTimeInput);
  };

  // "Kommer senere" secondary — v1 opened a free-form <input type="time">
  // picker, which let users pick literally any time including times in
  // the past or hours after the invite (often the wrong action). User
  // feedback: 'I think we should limit what the user can select in
  // later. Maybe even a pre made list: +5 min, +10, +15, +30, +45,
  // +1h, +1h 30m, +2h. Is +2h max we should allow?'
  // New: chip strip with relative offsets capped at +2h, anchored
  // above the CTA row. Tap a chip → arrivalHour updates + chip strip
  // hides. Anon mode still opens the login modal.
  let arrivalHour = planHour;
  let arrivalSelected = false; // tracks whether user picked a non-default offset
  const suggestBtn = el.querySelector('#pp-suggest');
  let laterStrip = null;
  if (suggestBtn) {
    if (isAnon) {
      suggestBtn.onclick = () => {
        if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
      };
    } else {
      const lang = (typeof prefLang === 'function') ? prefLang() : 'no';
      const hSuf = (lang === 'en') ? 'h' : 't';
      // 3 presets + a Custom ±5-min stepper (was 8 chips — choice overload).
      const fmtOffset = (m) => {
        if (m < 60) return `+${m} min`;
        const h = Math.floor(m / 60), mm = m % 60;
        return mm ? `+${h}${hSuf} ${mm} min` : `+${h}${hSuf}`;
      };
      const offsets = [{ m: 15 }, { m: 30 }, { m: 60 }];
      const CUSTOM_MIN = 5, CUSTOM_MAX = 120, CUSTOM_STEP = 5;
      let customMin = 45; // stepper start — between the presets and the +2h cap
      // Build the chip strip. Mounted as a sibling of the CTA row so
      // it can slide above it on toggle without disturbing layout.
      laterStrip = document.createElement('div');
      laterStrip.className = 'pp-later-strip';
      // The Custom element morphs in place: a chip ("Annet") that expands into
      // an inline [− value +] stepper, while the presets shrink to fit (flex).
      laterStrip.innerHTML =
        offsets.map(o =>
          `<button class="chip-pill pp-later-chip" data-offset-min="${o.m}" type="button">${fmtOffset(o.m)}</button>`
        ).join('')
        + `<div class="chip-pill pp-later-custom" role="button" tabindex="0" aria-label="${t('invite_later_custom')}">`
        +   `<span class="pp-custom-label">${t('invite_later_custom')}</span>`
        +   `<span class="pp-custom-stepper" aria-hidden="true">`
        +     `<button class="pp-step-btn" data-step="-1" type="button" tabindex="-1" aria-label="minus">−</button>`
        +     `<span class="pp-later-stepper-val"></span>`
        +     `<button class="pp-step-btn" data-step="1" type="button" tabindex="-1" aria-label="plus">+</button>`
        +   `</span>`
        + `</div>`;
      const ctaRow = el.querySelector('.dprcv-cta-row');
      if (ctaRow && ctaRow.parentNode) {
        ctaRow.parentNode.insertBefore(laterStrip, ctaRow);
      }
      const labelSpan = suggestBtn.querySelector('span');
      const suggestDefaultLabel = labelSpan ? labelSpan.textContent : '';
      const heroLabelEl = el.querySelector('.dprcv-hero-left .dprcv-hero-label');
      const meetLabel   = t('invite_hero_meets');
      const comingLabel = t('invite_hero_coming');
      const stepperVal = laterStrip.querySelector('.pp-later-stepper-val');
      const customEl   = laterStrip.querySelector('.pp-later-custom');
      const clearSelection = () =>
        laterStrip.querySelectorAll('.pp-later-chip, .pp-later-custom').forEach(c => c.classList.remove('is-selected'));
      // Collapse the Custom element from its expanded stepper back to a chip.
      const collapseCustom = () => {
        customEl.classList.remove('is-active');
        laterStrip.classList.remove('stepper-open');
      };
      // Apply an arrival offset — shared by the presets and the custom stepper.
      const applyOffset = (offsetMin, labelText) => {
        arrivalHour = planHour + (offsetMin / 60);
        arrivalSelected = true;
        const lbl = el.querySelector('#pp-arrival-time');
        if (lbl) lbl.textContent = formatHour(arrivalHour);
        if (heroLabelEl) heroLabelEl.textContent = comingLabel;
        if (labelSpan) labelSpan.textContent = labelText;
      };
      const resetArrival = () => {
        arrivalHour = planHour;
        arrivalSelected = false;
        const lbl = el.querySelector('#pp-arrival-time');
        if (lbl) lbl.textContent = planTimeStr;
        if (heroLabelEl) heroLabelEl.textContent = meetLabel;
        if (labelSpan) labelSpan.textContent = suggestDefaultLabel;
        clearSelection();
        collapseCustom();
      };
      suggestBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!laterStrip.classList.contains('open')) collapseCustom();
        laterStrip.classList.toggle('open');
      };
      laterStrip.addEventListener('click', (ev) => {
        // Custom stepper − / + : dial the offset in 5-min steps, apply live.
        const stepBtn = ev.target.closest('.pp-step-btn');
        if (stepBtn) {
          const dir = parseInt(stepBtn.dataset.step, 10);
          customMin = Math.max(CUSTOM_MIN, Math.min(CUSTOM_MAX, customMin + dir * CUSTOM_STEP));
          stepperVal.textContent = fmtOffset(customMin);
          applyOffset(customMin, fmtOffset(customMin));
          return;
        }
        // Custom chip → morph into the inline stepper (presets shrink to fit).
        // Once expanded, only the −/+ act (handled above), so tapping the chip
        // body again does nothing; pick a preset to collapse it back.
        if (ev.target.closest('.pp-later-custom')) {
          if (customEl.classList.contains('is-active')) return;
          customEl.classList.add('is-active');
          laterStrip.classList.add('stepper-open');
          stepperVal.textContent = fmtOffset(customMin);
          clearSelection();
          customEl.classList.add('is-selected');
          applyOffset(customMin, fmtOffset(customMin));
          return;
        }
        const chip = ev.target.closest('.pp-later-chip');
        if (!chip) return;
        // Tap the selected preset again → back to the original meet time.
        if (chip.classList.contains('is-selected')) {
          resetArrival();
          laterStrip.classList.remove('open');
          return;
        }
        applyOffset(parseInt(chip.dataset.offsetMin, 10), chip.textContent);
        clearSelection();
        chip.classList.add('is-selected');
        collapseCustom();           // morph the stepper back to the "Annet" chip
        laterStrip.classList.remove('open');
      });
      // Outside-tap dismiss — chained into el._cleanup so closePlanPreview
      // can drop it. Previously this leaked across plan-preview lifecycles.
      const onOutsideTap = (ev) => {
        if (!laterStrip.classList.contains('open')) return;
        if (laterStrip.contains(ev.target) || suggestBtn.contains(ev.target)) return;
        laterStrip.classList.remove('open');
      };
      document.addEventListener('click', onOutsideTap);
      const _prevCleanupLaterStrip = el._cleanup;
      el._cleanup = () => {
        if (_prevCleanupLaterStrip) _prevCleanupLaterStrip();
        document.removeEventListener('click', onOutsideTap);
      };
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
    if (arrivalSelected && Math.abs(arrivalHour - planHour) > 0.05) {
      const dateStr2 = opts.plannedAt ? opts.plannedAt.slice(0, 10) : datePicker?.value;
      if (dateStr2) {
        const hh = Math.floor(arrivalHour);
        const mm = Math.round((arrivalHour - hh) * 60);
        arrivalIso = new Date(`${dateStr2}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`).toISOString();
      }
    }
    if (!window._ppDemo && typeof respondToPlanInvite === 'function' && opts.inviteId) {
      try { await respondToPlanInvite(opts.inviteId, 'accepted', arrivalIso); }
      catch (e) { console.warn('[plan-preview] respondToPlanInvite(accepted) failed', opts.inviteId, e); }
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
    if (typeof _aTrack === 'function') _aTrack('plan_preview_accept', { venue_id: venue.id, has_invite_id: !!opts.inviteId, off_plan_time: !!arrivalIso });

    // ── Accept → confirm as an IN-SHEET horizontal push (Phase 7) ───────────
    // The venue header stays put; only the action region slides — accept CTA
    // out left, the post-accept action cards in from the right (rocks-on-ice
    // on the cards). Reuses the global _renderAcceptedActionCard so the cards
    // (and their inline _acceptedActionClick handlers) are unchanged. Falls
    // back to the old two-panel vertical crossover if the track isn't present.
    const _track = el.querySelector('#pp-action-track');
    const _confirmPane = el.querySelector('#pp-confirm-pane');
    if (_track && _confirmPane && typeof _renderAcceptedActionCard === 'function') {
      const fp = (typeof window !== 'undefined') ? window._pendingFriendPrompt : null;
      const acts = [];
      if (fp && fp.inviterId) acts.push('add_friend');
      acts.push('share');
      if (opts.plannedAt) acts.push('calendar');
      if (typeof userLocation !== 'undefined' && userLocation) acts.push('directions');
      acts.push('open');
      const cardsHtml = acts.map((type, i) => _renderAcceptedActionCard(type, {
        venueId: venue.id, venueName: venue.name, plannedAt: opts.plannedAt,
        inviterName: (fp && fp.inviterName) || opts.inviterName || '',
        inviterId:   (fp && fp.inviterId)   || opts.inviterId   || null,
        primary: i === 0,
      })).join('');
      _confirmPane.innerHTML =
        `<div class="dpacc-action-row no-scrollbar">${cardsHtml}</div>` +
        `<div class="dprcv-cta-row"><button class="dprcv-cta-link" id="pp-confirm-close" type="button"><span>${t('accepted_close')}</span></button></div>`;
      _confirmPane.setAttribute('aria-hidden', 'false');
      // 'Open venue' used the separate panel's close; re-point it now there's
      // no separate overlay (close the preview, then open the detail panel).
      const _openCard = _confirmPane.querySelector('[data-action="open"]');
      if (_openCard) _openCard.onclick = () => { closePlanPreview({ keepCamera: true }); setTimeout(() => { if (typeof selectVenue === 'function') selectVenue(venue.id, true); }, 340); };
      const _ccBtn = _confirmPane.querySelector('#pp-confirm-close');
      if (_ccBtn) _ccBtn.onclick = () => closePlanPreview({ keepCamera: true });
      // Eyebrow crossfades invited → confirmed in place (header persists).
      const _eb = el.querySelector('.dprcv-eyebrow');
      if (_eb) {
        _eb.style.transition = 'opacity var(--dur-base) var(--ease-standard)';
        _eb.style.opacity = '0';
        setTimeout(() => { _eb.textContent = t('accepted_eyebrow'); _eb.style.opacity = '1'; }, 180);
      }
      requestAnimationFrame(() => _track.classList.add('show-confirm'));
      return;
    }

    // Crossover slide — mirrors the venue-card → detail-panel transition:
    // accept panel slides DOWN, post-accept panel slides UP at the same
    // time. Both start in the same frame, same duration. v1 closed the
    // plan-preview first and waited 360 ms before mounting the post-
    // accept — read as a sluggish 'fade away, then arrive'. Setting
    // post-accept-active before the close keeps the chrome-hide rules
    // continuously applied through the swap.
    document.body.classList.add('post-accept-active');
    if (typeof _openPostAcceptPanel === 'function') {
      const whenLabel = (typeof _inviteWhenLabel === 'function' && opts.plannedAt)
        ? _inviteWhenLabel(opts.plannedAt.slice(0, 10), arrivalHour) : '';
      // Relative-day phrasing on the post-accept too, so the receiver
      // sees the same 'Tomorrow' / 'Sunday' / '17 May' shape from
      // accept → confirm.
      const _dateStr = opts.plannedAt ? opts.plannedAt.slice(0, 10) : '';
      const _capRel = (s) => (s && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
      const arrivalDateLabel = (typeof _dayLabel === 'function' && _dateStr)
        ? _capRel(_dayLabel(_dateStr))
        : ((typeof _fmtInviteDate === 'function' && _dateStr) ? _fmtInviteDate(_dateStr) : '');
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
    }
    closePlanPreview({ skipDetailOpen: true, keepCamera: true });
  };

  const declineBtn = el.querySelector('#pp-decline');
  if (declineBtn) declineBtn.onclick = async () => {
    if (typeof respondToPlanInvite === 'function' && opts.inviteId) {
      try { await respondToPlanInvite(opts.inviteId, 'declined'); }
      catch (e) { console.warn('[plan-preview] respondToPlanInvite(declined) failed', opts.inviteId, e); }
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
  if (closeCta) closeCta.onclick = () => closePlanPreview((isPast || isCancelled) ? { skipDetailOpen: true } : {});

  const cancelCta = el.querySelector('#pp-cancel-plan');
  if (cancelCta) cancelCta.onclick = async (ev) => {
    const planId = cancelCta.getAttribute('data-plan-id');
    if (!planId) return;
    // Two-tap confirm — first tap arms ("Sikker?"), second tap commits.
    // Keeps the click away from being a destructive single-tap mistake
    // without dragging in a full modal.
    if (cancelCta.dataset.armed !== '1') {
      cancelCta.dataset.armed = '1';
      const labelEl = cancelCta.querySelector('span');
      const original = labelEl ? labelEl.textContent : '';
      if (labelEl) labelEl.textContent = 'Sikker?';
      setTimeout(() => {
        if (cancelCta.dataset.armed === '1') {
          delete cancelCta.dataset.armed;
          if (labelEl) labelEl.textContent = original;
        }
      }, 4000);
      ev.preventDefault();
      return;
    }
    delete cancelCta.dataset.armed;
    cancelCta.disabled = true;
    if (typeof cancelPlan === 'function') {
      await cancelPlan(planId);
    }
    closePlanPreview({ skipDetailOpen: true });
  };

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

// ── Timeline event glyphs ────────────────────────────────────────────────────
// Small icons drawn above the accept-page sun-timeline at the hour the event
// happens (shade falling on the seating area, weather changing, etc.). The
// shade glyph is a high-res reproduction of the user's sketch — solid left
// semicircle + diagonal stripes filling the right semicircle. Same metaphor
// the timeline bar uses for shadow gaps, surfaced as a discrete icon.
window.TIMELINE_EVENT_GLYPHS = {
  // Clock face — anchors the START of the bar as the meeting time. Same
  // visual register as the weather/shade icons so the row reads as a
  // unified set of glyphs marking notable moments along the timeline.
  meet: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.18" stroke="none"/>
    <circle cx="12" cy="12" r="9"/>
    <polyline points="12 7 12 12 16 14"/>
  </svg>`,
  // Brand shade mark — shared generator in render-helpers.js (unique clipPath
  // id per call so it can repeat across list cards + this timeline safely).
  shade: (typeof shadeGlyph === 'function') ? shadeGlyph() : '',
  // Weather glyphs delegate to the same _wxSvg* set the top-strip /
  // header / date-strip / calendar uses (defined in weather.js). User
  // feedback: FTS popup, thumb, and panel timelines should match the
  // top-bar icons, not the other way around. Same currentColor +
  // drop-shadow contract handled via .wx-sky-icon CSS.
  cloud:  (typeof _wxSvgCloud         === 'function') ? _wxSvgCloud()         : '',
  partly: (typeof _wxSvgSunCloud      === 'function') ? _wxSvgSunCloud()      : '',
  rain:   (typeof rainIconSvg         === 'function') ? rainIconSvg()         : '',
  sun:    (typeof _wxSvgSun           === 'function') ? _wxSvgSun()           : '',
  // Closed — moon-shape. Used on the FTS bar for time-of-day ranges
  // before a selected venue opens or after it closes; complements the
  // sun glyph naturally (Shades brand: sun ↔ moon).
  closed: `<svg class="wx-sky-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>
  </svg>`,
};
/** Compute event timestamps (hour, type) for the accept-page timeline.
 *  Range is [minH, maxH] (meet time → sundown). Returns chronological
 *  array of {type, hour, label?} entries.
 *
 *  Events surfaced:
 *    - 'shade' at each shadow-window start within range (seating goes
 *      into shade, per computeSunWindows gap boundaries)
 *    - 'weather' at hours where adjacent-hour weather transitions
 *      between clear / cloud / rain bands (one icon per transition,
 *      icon = the NEW state)
 *
 *  Adjacent events within ~30 min get coalesced (keep the earlier one)
 *  so the row doesn't pile up. */
function _computeTimelineEvents(v, dateStr, minH, maxH) {
  // Test-token override: skip all real computation and use the supplied
  // sequence directly. Lets us preview the event row at varying weather
  // / shade densities without seeding actual venue or weather data.
  if (typeof window !== 'undefined' && Array.isArray(window._testTimelineEvents) && window._testTimelineEvents.length) {
    return window._testTimelineEvents
      .filter(e => e && Number.isFinite(e.h) && e.h > minH + 0.05 && e.h < maxH - 0.05)
      .map(e => {
        const type = (e.t === 'shade') ? 'shade' : 'weather';
        const out = { type, hour: e.h };
        if (type === 'weather') out.state = e.t;
        return out;
      })
      .sort((a, b) => a.hour - b.hour);
  }
  const events = [];
  // Shadow + sun transitions. Each sun window's END marks a sun→shade
  // transition (shade glyph); each sun window's START marks a shade→
  // sun transition (sun glyph). v1 placed the shade at the gap midpoint
  // which read as 'this region is shaded' but lost the boundary signal
  // — user wanted shade where shadow STARTS and sun where shadow ENDS
  // ('the shadow icon where the shadow start, then the full sun later
  // when the shadow ends'). Bounded by minH / maxH so transitions
  // outside the visible bar drop out.
  if (typeof computeSunWindows === 'function') {
    const sw = computeSunWindows(v, dateStr);
    const wins = (sw && sw.windows) || [];
    for (const win of wins) {
      // shade→sun transition at window start (sun arrives on the seating)
      if (win.start > minH + 0.1 && win.start < maxH - 0.1) {
        events.push({ type: 'weather', hour: win.start, state: 'sun' });
      }
      // sun→shade transition at window end (shadow falls on the seating)
      if (win.end > minH + 0.1 && win.end < maxH - 0.1) {
        events.push({ type: 'shade', hour: win.end });
      }
    }
  }
  // Weather-change events were removed — the bar's coloured bands
  // already convey weather visually. Keeping the row to JUST sun/shade
  // transitions + meet aligned the glyphs exactly with the bar's gap
  // boundaries (user: 'markers now literally missing the mark').
  events.sort((a, b) => a.hour - b.hour);
  // Coalesce: drop any event within 0.5 h of the previous one.
  const out = [];
  for (const e of events) {
    if (out.length && (e.hour - out[out.length - 1].hour) < 0.5) continue;
    out.push(e);
  }
  // Always lead with the meeting anchor at minH — every accept page has
  // this, every receiver needs to see 'this is where the meeting is on
  // the bar'. Bypasses the coalesce filter so it's never lost behind a
  // nearby shade / weather event in the first 30 min.
  out.unshift({ type: 'meet', hour: minH });
  return out;
}
/** Populate the .dprcv-timeline-events host with icons positioned by left-%.
 *  Stashes a ._refresh closure on the host so the worker callback can
 *  re-run it once the precise sun windows replace the sync-fallback ones.
 *  Without that, the events row stayed locked to the FAST/SIMPLE window
 *  positions even though the bar itself repainted with precise data. */
function _populateTimelineEvents(host, v, dateStr, minH, maxH) {
  host.innerHTML = '';
  if (!(maxH > minH + 0.1)) return;
  const events = _computeTimelineEvents(v, dateStr, minH, maxH);
  // Bar geometry for variable-length ticks. Padding from icon→tick is
  // constant; tick length stretches so the tick's bottom always lands
  // on the bar's top edge — longer at the rounded corners (x ∈ [0, R]
  // or [W-R, W]), shorter on the flat top in the middle.
  const barW = host.clientWidth || (host.offsetWidth || 360);
  const BAR_R = 13;
  const ICON_BOTTOM_Y     = 14;   // icon height
  const TICK_PADDING_TOP  = 2;    // gap icon → tick
  const TICK_PADDING_BOT  = 2;    // gap tick → bar (same as top so it reads symmetric)
  const FLAT_TOP_Y        = 22;   // events row height — y where flat bar top sits
  const tickLenAt = (xPx) => {
    let barTopAtX = FLAT_TOP_Y;
    if (xPx < BAR_R) {
      const dx = BAR_R - xPx;
      barTopAtX = FLAT_TOP_Y + BAR_R - Math.sqrt(Math.max(0, BAR_R * BAR_R - dx * dx));
    } else if (xPx > barW - BAR_R) {
      const dx = xPx - (barW - BAR_R);
      barTopAtX = FLAT_TOP_Y + BAR_R - Math.sqrt(Math.max(0, BAR_R * BAR_R - dx * dx));
    }
    return Math.max(2, Math.round(barTopAtX - ICON_BOTTOM_Y - TICK_PADDING_TOP - TICK_PADDING_BOT));
  };
  for (const e of events) {
    const xPct = ((e.hour - minH) / (maxH - minH)) * 100;
    // Meet anchor is allowed at the bar's left edge (xPct == 0). Other
    // events skip the edges so they don't crowd the meet / sundown
    // tips of the bar.
    if (e.type !== 'meet' && (xPct < 2 || xPct > 98)) continue;
    const glyphKey = e.type === 'shade' ? 'shade'
                   : e.type === 'meet'  ? 'meet'
                   : (e.state || 'sun');
    const glyph = TIMELINE_EVENT_GLYPHS[glyphKey] || TIMELINE_EVENT_GLYPHS.shade;
    const node = document.createElement('div');
    node.className = 'dprcv-timeline-event';
    if (e.type === 'meet') node.classList.add('dprcv-timeline-event-meet');
    node.style.left = xPct + '%';
    // Tick's actual x position is the icon's RENDERED centre, not
    // necessarily the event's left:%%. For non-meet events with
    // translateX(-50%), centre = left:% = xPx. For meet (flush-left,
    // translateX(0)), centre = left + icon_width/2 = 7 px. v1 used
    // xPx for everything → meet computed against x=0 (deepest curve
    // point, bar top at y=35) but the tick was actually rendered at
    // x=7 → tick overshot into the bar. Use the RENDERED centre for
    // both the geometry lookup and the visual alignment.
    let tickX;
    if (e.type === 'meet') {
      tickX = 7;
    } else {
      tickX = (xPct / 100) * barW;
    }
    const tickH = tickLenAt(tickX);
    node.innerHTML = glyph + `<div class="dprcv-timeline-event-tick" style="height:${tickH}px"></div>`;
    host.appendChild(node);
  }
  // Stash for worker-callback refresh.
  host._refresh = () => _populateTimelineEvents(host, v, dateStr, minH, maxH);
}

/** Populate the in-bar weather overlay. Each hour [minH, maxH] is bucketed
 *  into a weather state (sun / partly / cloud / rain), consecutive same-state
 *  hours are coalesced into bands, and one glyph is rendered centred over
 *  each band's midpoint (clipped to the visible bar range). Shade gaps
 *  (sun blocked by buildings on the seating) override weather and render
 *  as 'shade' glyphs since the weather doesn't matter when the seating is
 *  shaded. Stashed as host._refresh so the worker callback can re-fire
 *  once precise sun windows replace the sync-fallback data. */
function _populateTimelineWeather(host, v, dateStr, minH, maxH) {
  host.innerHTML = '';
  if (!(maxH > minH + 0.1)) return;
  if (typeof TIMELINE_EVENT_GLYPHS === 'undefined') return;
  const wxKeyAt = (h) => {
    if (typeof getWeatherAt !== 'function') return 'sun';
    const wx = getWeatherAt(dateStr, h + 0.5);
    if (!wx) return 'sun';
    const rain = (wx.precip ?? wx.prec ?? 0) > 0.3;
    if (rain) return 'rain';
    const cf = wx.sunBlock ?? wx.cloud ?? 0;
    if (cf < 0.25) return 'sun';
    if (cf < 0.75) return 'partly';
    return 'cloud';
  };
  // Shade lookup — outside any sun window means the seating is in shadow
  // and we want the shade glyph instead of the weather one.
  let sunWindows = [];
  try {
    if (typeof computeSunWindows === 'function') {
      const sw = computeSunWindows(v, dateStr);
      sunWindows = (sw && sw.windows) || [];
    }
  } catch (e) { /* ignore */ }
  const inSun = (h) => sunWindows.some(w => h >= w.start && h <= w.end);

  // Step through whole-hour buckets within the visible range, snap state.
  const startH = Math.floor(minH);
  const endH   = Math.ceil(maxH);
  const states = [];
  for (let h = startH; h < endH; h++) {
    const mid = h + 0.5;
    if (mid < minH || mid > maxH) { states.push({ h, state: null }); continue; }
    const state = (sunWindows.length && !inSun(mid)) ? 'shade' : wxKeyAt(h);
    states.push({ h, state });
  }
  // Coalesce consecutive same-state hours into bands.
  const bands = [];
  for (const s of states) {
    if (s.state == null) continue;
    const last = bands[bands.length - 1];
    if (last && last.state === s.state && last.endH === s.h) {
      last.endH = s.h + 1;
    } else {
      bands.push({ state: s.state, startH: s.h, endH: s.h + 1 });
    }
  }
  // Render one glyph per band, centred on the visible-clipped band midpoint.
  for (const band of bands) {
    const left  = Math.max(band.startH, minH);
    const right = Math.min(band.endH,   maxH);
    if (right - left < 0.35) continue; // too narrow — would crowd a neighbour
    const midH = (left + right) / 2;
    const xPct = ((midH - minH) / (maxH - minH)) * 100;
    const glyph = TIMELINE_EVENT_GLYPHS[band.state] || TIMELINE_EVENT_GLYPHS.sun;
    const node = document.createElement('div');
    node.className = 'dprcv-timeline-wx-icon';
    node.dataset.state = band.state;
    node.style.left = xPct + '%';
    node.innerHTML = glyph;
    host.appendChild(node);
  }
  host._refresh = () => _populateTimelineWeather(host, v, dateStr, minH, maxH);
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
window._dprcvWalkInfo   = _dprcvWalkInfo;
