/**
 * ui-detail.js — Detail panel: timeline + full panel HTML.
 * Depends on: computeSunWindows, formatHour, userLocation, datePicker (app.js)
 *             getWeatherAt (weather.js)
 *             getBusynessAt (busyness.js)
 *             computeVenueScore (scoring.js)
 *             catLabel (data.js)
 *             nowMode (app.js)
 *             drawShelterDiagram (ui-shelter.js)
 */


// ── Detail panel content ──────────────────────────────────────────────────────

/** Single-photo hero: size the frame to the photo's own aspect ratio, clamped
 *  to a [140, 200] px band. Wide shots get shorter (a band), tall/odd ratios cap
 *  and peek (object-fit: cover) rather than hard-cropping a fixed 168px box.
 *  Only wired for single-photo venues — carousels keep the uniform CSS height. */
function _fitHeroPhoto(img) {
  try {
    const frame = img && img.closest('.detail-new-photos');
    if (!frame || !img.naturalWidth || !img.naturalHeight) return;
    const w = frame.clientWidth || 336;
    const h = Math.max(140, Math.min(200, Math.round(w * img.naturalHeight / img.naturalWidth)));
    frame.style.height = h + 'px';
  } catch { /* leave the CSS default height */ }
}
if (typeof window !== 'undefined') window._fitHeroPhoto = _fitHeroPhoto;

function renderDetailPanelContent(v, dateStr, fromHour) {
  const s = typeof computeVenueScore === 'function'
    ? computeVenueScore(v, dateStr, fromHour, typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null, userLocation)
    : null;

  const { windows } = computeSunWindows(v, dateStr);
  const distMeters = s?.distKm != null ? s.distKm * 1000 : null;
  const distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : null;

  const walkTime = typeof calcWalkTime === 'function' ? calcWalkTime(distMeters) : null;

  const phoneIcon = typeof getMapsIcon === 'function' ? getMapsIcon('phone') : '';
  const globeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('globe') : '';
  const shareIcon = typeof getMapsIcon === 'function' ? getMapsIcon('share') : '';
  const dirIcon = typeof getMapsIcon === 'function' ? getMapsIcon('directions') : '';

  // Sun section headline
  const state = typeof venueState === 'function' ? venueState(v, fromHour) :
    { state: 'sun', mainText: '—', subText: '', className: 'state-sun' };

  let sunHeadline = '';
  if (state.state === 'sun') {
    const lastWin = windows[windows.length - 1];
    const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
    const remaining = curWin ? curWin.end - fromHour : 0;
    const remH = Math.floor(remaining), remM = Math.round((remaining - remH) * 60);
    const remStr = remH > 0 ? `${remH}t ${remM}m` : `${remM} min`;
    sunHeadline = `Sol til ${formatHour(lastWin.end)} · <span class="hi">${remStr} igjen</span>`;
  } else if (state.state === 'shadow') {
    const nextWin = windows.find(w => w.start > fromHour);
    const wait = nextWin.start - fromHour;
    const waitH = Math.floor(wait), waitM = Math.round((wait - waitH) * 60);
    const waitStr = waitH > 0 ? `${waitH}t ${waitM}m` : `${waitM} min`;
    sunHeadline = `Sol fra ${formatHour(nextWin.start)} · <span class="hi">om ${waitStr}</span>`;
  } else {
    sunHeadline = `Sol ferdig i dag`;
  }

  // Info — collected as { icon, strong, sub?, chipText } so we can render
  // either as compact chips (when ≤3 items) or as a full vertical list
  // (when ≥4). Address always appears as the first item so the user knows
  // exactly where they're looking at.
  const infoItems = [];
  const pinIcon   = typeof getMapsIcon === 'function' ? getMapsIcon('pin') : '';
  const beerIcon  = typeof getMapsIcon === 'function' ? getMapsIcon('beer') : '';
  const peopleIcon = typeof getMapsIcon === 'function' ? getMapsIcon('people') : '';
  const volumeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('volume') : '';
  const clockIcon = typeof getMapsIcon === 'function' ? getMapsIcon('clock') : '';
  const windIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>`;

  if (v.address) infoItems.push({ icon: pinIcon, strong: v.address });
  if (v.beerPrice) infoItems.push({ icon: beerIcon, strong: `${v.beerPrice} kr / 0,5 l` });

  const busynessNow = typeof getBusynessAt === 'function' ? getBusynessAt(v, dateStr, fromHour) : null;
  if (busynessNow != null) {
    const busyWord = (typeof busynessLabel === 'function') ? busynessLabel(busynessNow) : null;
    if (busyWord) {
      // 5-bar signal indicator for the crowd level (mock 1).
      const bars = Math.max(1, Math.min(5, Math.round(busynessNow / 20)));
      const barsHtml = `<span class="dp-bars" aria-hidden="true">${[1,2,3,4,5].map(i => `<span class="dp-bar${i <= bars ? ' on' : ''}"></span>`).join('')}</span>`;
      infoItems.push({ icon: peopleIcon, strong: busyWord, rightHtml: barsHtml });
    }
  }

  const noiseScore = s?.noise != null ? s.noise : (v.noiseScore != null ? v.noiseScore * 100 : null);
  if (noiseScore != null) {
    const noiseBucket = typeof noiseScoreToBucket === 'function' ? noiseScoreToBucket(noiseScore) : null;
    if (noiseBucket) infoItems.push({ icon: volumeIcon, strong: noiseBucket.label });
  }

  // Wind shelter — venueWindShelter(facing, windFrom) → 0 (exposed) … 1 (lee).
  const _wxNow = (typeof getWeatherAt === 'function') ? getWeatherAt(dateStr, fromHour) : null;
  if (_wxNow && typeof venueWindShelter === 'function' && v.facing != null) {
    const shelter = venueWindShelter(v.facing, _wxNow.wdir);
    if (shelter != null) {
      const windLabel = shelter >= 0.66 ? t('wind_sheltered') : shelter >= 0.33 ? t('wind_partial') : t('wind_exposed');
      infoItems.push({ icon: windIcon, strong: windLabel });
    }
  }

  const hours = getVenueHoursForDay(v, dateStr);
  const hoursLine = hours.close != null
    ? t('open_until', { time: formatHour(hours.close) })
    : t('open_label');
  let hoursSubtext = '';
  if (v.kitchenCloseHour != null) {
    hoursSubtext = t('kitchen_until', { time: formatHour(v.kitchenCloseHour) });
  }
  // Hours live as an info row now (clock + "Open until X · Kitchen til Y"),
  // right after the address — the standalone line above friends was awkward.
  infoItems.splice(v.address ? 1 : 0, 0, {
    icon: clockIcon,
    strong: hoursLine + (hoursSubtext ? ' · ' + hoursSubtext : ''),
  });

  // Info as cream-frost rows (mock 1): icon + label, optional right indicator
  // (busyness bars). One card with divided rows.
  let infoListHtml = '';
  if (infoItems.length) {
    infoListHtml = `<div class="dp-info-card">${
      infoItems.map(it => `<div class="dp-info-row">
        <span class="dp-info-icon">${it.icon}</span>
        <span class="dp-info-text">${it.strong}</span>
        ${it.rightHtml || ''}
      </div>`).join('')
    }</div>`;
  }

  // Footer — community-correction links at the bottom of the panel. Reworded
  // to a softer crowd-sourcing tone ("suggest a change" / "report a problem")
  // and made discoverable (clear underlined links, see .dp-footer-quiet).
  const footerHtml = `
    <div class="secondary-row dp-footer-quiet">
      <button class="secondary-link" onclick="enterEditMode(${v.id})">${t('dp_suggest_change')}</button>
      <span class="dp-footer-sep">·</span>
      <button class="secondary-link" onclick="alert('${t('dp_report_problem_alert')}')">${t('dp_report_problem')}</button>
    </div>`;

  // Wind shelter — pinned for now. Wind direction + speed already render as
  // animated particles on the map (render-wind.js); the per-venue shelter
  // STATUS ("Le / Delvis le / Eksponert") would be a separate compact text
  // chip here, but the shelter % isn't computed at the venue level yet.
  // Revisit when venueWindShelter() is wired into the detail render.
  const shelterHtml = '';

  // Friend chip on the photo overlay removed — friends-here is now the
  // pin's primary signal (avatar-card design), so the chip duplicated info.
  const photoChipHtml = '';

  // Meta line on the photo overlay. Star + rating prepended when present so
  // the trust signal reads alongside identity. Falls back gracefully when any
  // single field is missing.
  const _distStr = s?.distKm != null
    ? (s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m` : `${s.distKm.toFixed(1)} km`)
    : '';
  const _catLabel = (typeof catLabel === 'function') ? catLabel(v) : '';
  const _ratingStr = (typeof v.rating === 'number')
    ? `★ ${v.rating.toFixed(1).replace('.', ',')}`
    : '';
  const _metaParts = [_ratingStr, v.area, _catLabel, _distStr].filter(Boolean);
  const _metaLine = _metaParts.join(' · ');

  // Photo count indicator (top-left). Only when multi-photo. Cream-on-glass
  // pill: "1 / 8". Currently not scroll-tracked — shows total count only.
  const _photoCount = v.photoUrls?.length || 0;
  const photoCountHtml = _photoCount > 1
    ? `<div class="photo-overlay-count">1 / ${_photoCount}</div>`
    : '';

  // Sun verdict chip on the photo: REMOVED. The titled "Sun conditions" card
  // right below the photo now owns the verdict, so the chip duplicated it
  // ("removed the chip clutter"). app.js's #dp-sun-chip sync is guarded and
  // simply no-ops now that the element is gone.

  // Photo block — shared header overlay (title + meta + count + dark gradient)
  // sits on top of every state.
  const photoOverlayHtml = `
    <div class="photo-overlay-grad"></div>
    ${photoCountHtml}
    ${photoChipHtml}
    <div class="photo-overlay-header">
      <div class="photo-overlay-title">${v.name}</div>
      ${_metaLine ? `<div class="photo-overlay-meta">${_metaLine}</div>` : ''}
    </div>`;

  // Aspect-aware hero: a single photo sizes its frame to its OWN ratio (within
  // a band) so wide shots read as a band and odd/tall ratios cap + peek instead
  // of hard-cropping. Multi-photo carousels keep the fixed CSS height (the
  // carousel needs a uniform frame), so only the single case gets the onload.
  const _singlePhoto = v.photoUrls?.length === 1;
  const photosHtml = v.photoUrls?.length
    ? `<div class="detail-new-photos${_singlePhoto ? ' is-single' : ''}">
        <div class="detail-new-photos-scroll">${
          v.photoUrls.map(url => `<img src="${url}" loading="lazy" alt="" onerror="this.remove()"${_singlePhoto ? ' onload="_fitHeroPhoto(this)"' : ''}>`).join('')
        }</div>
        ${photoOverlayHtml}
      </div>`
    : `<div class="detail-new-photos detail-new-photos-empty" role="img" aria-label="Ingen bilder">
        <div class="detail-new-photos-empty-art">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
        </div>
        ${photoOverlayHtml}
      </div>`;

  // Heart + bell live in the action row alongside Directions/Share. Active
  // state fills with the accent so the row reads as a peer set of toggles.
  const _favActive = typeof isFavorite === 'function' && isFavorite(v.id);
  const _alertActive = typeof hasSunAlert === 'function' && hasSunAlert(v.id);
  // Buttons keep the LONG, descriptive label as title + aria for
  // accessibility, but render a SHORT word as the visible button label so
  // the row stays compact (the bell's "Notify me 30 min before sun" was
  // far too long for a 3-column grid).
  const _favLabel       = typeof t === 'function' ? t('favorites') : 'Favoritt';
  const _alertLabelLong = typeof t === 'function' ? t('sun_alert_label') : 'Sol-varsel';
  const _alertLabelShort = typeof t === 'function' ? t('sun_alert_short') : 'Varsle';
  const heartBtn = `<button class="dp-secondary-btn${_favActive ? ' is-active' : ''}" onclick="toggleFavorite(${v.id}, event)" title="${_favLabel}" aria-label="${_favLabel}">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="${_favActive ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>
    <span class="dp-secondary-label">${_favLabel}</span>
  </button>`;
  const bellBtn = `<button class="dp-secondary-btn${_alertActive ? ' is-active' : ''}" onclick="toggleSunAlert(${v.id}, event)" title="${_alertLabelLong}" aria-label="${_alertLabelLong}">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="${_alertActive ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
    <span class="dp-secondary-label">${_alertLabelShort}</span>
  </button>`;

  // The card-style header is rebuilt by _populateDpCardSlot → renderCard
  // (ui-list.js). The metaParts/metaHtml block that used to live here was
  // dead code — kept removed so future readers don't try to edit it.
  const stateClass = state.className || '';
  const cardRightMain = state.mainText || '—';
  const cardRightSub  = state.subText  || '';

  return `
    <div id="dp-scroll">
      <div class="detail-new-photos-wrap">
        ${photosHtml}
      </div>

      <!-- Sun panel — placeholder slot replaced by updateDetailPanel with a
           freshly-rendered .dp-card (verdict + timeline + facts). -->
      <div id="dp-card-slot" class="dp-card-slot"></div>

      <!-- Order (per Claude-Design): sun → social/plans → invite (all in the
           VENNER zone) → divider → actions → divider → info. Hours moved into
           the info card (was a standalone line here). -->
      ${_renderSocialSection(v)}

      <div class="dp-divider" aria-hidden="true"></div>

      <div class="dp-actions">
        <a class="s-rnd dp-directions" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.lat + ',' + v.lng)}&travelmode=walking" target="_blank" rel="noopener" aria-label="${t('directions')}${walkTime ? ' · ' + walkTime : ''}">
          ${dirIcon}
          <span class="dp-directions-label">${t('directions')}${walkTime ? ' · ' + walkTime : ''}</span>
        </a>
        <div class="dp-secondary-row">
          <button class="dp-secondary-btn" title="${t('share')}" aria-label="${t('share')}" onclick="shareVenue(${v.id})">
            ${shareIcon}
            <span class="dp-secondary-label">${t('share')}</span>
          </button>
          ${heartBtn}
          ${bellBtn}
        </div>
      </div>

      <div class="dp-divider" aria-hidden="true"></div>

      ${infoListHtml}

      ${footerHtml}
    </div>`;
}

// Deterministic friend color, mirrors the canvas pin palette so the avatar
// reads as the same person between map pin and detail panel.
const _DP_FRIEND_COLORS = ['#F5C25E', '#9CBDE7', '#FFD488', '#E6C08A', '#FFCFAA', '#DECCC0'];
function _dpFriendColor(userId) {
  const s = String(userId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return _DP_FRIEND_COLORS[h % _DP_FRIEND_COLORS.length];
}

/** Build avatar markup for a list of friend check-ins.
 *  Renders up to `max` avatars with a `+N` overflow chip when there are more.
 *  Initial-fallback avatars use a deterministic color hash. */
function _renderFriendAvatarsHtml(checkins, max, sizePx) {
  const slots = checkins.slice(0, max);
  const overflow = checkins.length > max ? checkins.length - max : 0;
  const initialFontSize = Math.round(sizePx * 0.42);
  const overflowFontSize = Math.round(sizePx * 0.36);
  const html = slots.map(c => {
    const u = c.user || {};
    const label = (u.name || u.email || '').replace(/"/g, '&quot;');
    if (u.avatar_url) {
      return `<img class="avatar" src="${u.avatar_url}" alt="${label}" title="${label}" style="width:${sizePx}px;height:${sizePx}px;">`;
    }
    const initial = ((u.name || u.email || '?')[0] || '?').toUpperCase();
    const bg = _dpFriendColor(u.id);
    return `<span class="avatar avatar-init" title="${label}" style="width:${sizePx}px;height:${sizePx}px;background:${bg};font-size:${initialFontSize}px;">${initial}</span>`;
  }).join('');
  const overflowHtml = overflow
    ? `<span class="avatar avatar-overflow" style="width:${sizePx}px;height:${sizePx}px;font-size:${overflowFontSize}px;">+${overflow}</span>`
    : '';
  return html + overflowHtml;
}

/** "Anna +2 her nå" — short label for the photo overlay chip. */
function _friendsHereChipLabel(checkins) {
  const first = checkins[0]?.user;
  const firstName = (first?.name || first?.email || '').split(' ')[0] || '';
  const extra = checkins.length - 1;
  if (typeof t === 'function') {
    return extra > 0
      ? t('friends_here_now_chip_plural', { name: firstName, n: extra })
      : t('friends_here_now_chip', { name: firstName });
  }
  return extra > 0 ? `${firstName} +${extra} her nå` : `${firstName} her nå`;
}

/** "Anna er i solen her" / "Anna +2 venner i solen her" — friends card headline. */
function _friendsInSunHeadline(checkins) {
  const first = checkins[0]?.user;
  const firstName = (first?.name || first?.email || '').split(' ')[0] || '';
  const extra = checkins.length - 1;
  if (typeof t === 'function') {
    return extra > 0
      ? t('friends_in_sun_here_plural', { name: firstName, n: extra })
      : t('friends_in_sun_here', { name: firstName });
  }
  return extra > 0
    ? `${firstName} +${extra} venner i solen her`
    : `${firstName} er i solen her`;
}

/** True when this venue has a plan the user is invited to and hasn't answered.
 *  Drives the invite-CTA demotion below (one honey per screen). */
function _venueHasPendingInvite(v) {
  const plans = typeof getPlansForVenue === 'function' ? getPlansForVenue(v.id) : [];
  return plans.some(p => p._invite && p._invite.status === 'pending');
}

/** Social section: just the Invite-friends CTA. The "friends here now" chip
 *  is rendered on the photo overlay (top-right). Plans got promoted to their
 *  own block, _renderPlansBlock, rendered separately by the caller.
 *  When the venue has a pending RSVP, the plans block shows a honey "Accept" —
 *  so the invite CTA steps back to a Secondary outline to keep ONE honey CTA
 *  per screen (DESIGN.md "Primary = the decision, exactly one"). */
function _renderSocialSection(v) {
  // VENNER zone (Claude-Design pass 2): a "who's here now" card + plan cards +
  // the invite CTA, all under one section label, told as one story.
  const checkins = (typeof getFriendCheckinsForVenue === 'function')
    ? (getFriendCheckinsForVenue(v.id) || []) : [];

  // "Friends here now" card — avatars + label + a honey "Nå" chip.
  let hereCard = '';
  if (checkins.length) {
    const avatars = _renderFriendAvatarsHtml(checkins, 3, 30);
    const label   = _friendsHereChipLabel(checkins);
    hereCard = `
      <div class="dp-social-card dp-here-card">
        <div class="dp-here-avatars">${avatars}</div>
        <div class="dp-here-label">${label}</div>
        <span class="dp-here-now"><span class="dp-here-dot" aria-hidden="true"></span>${t('now') || 'Nå'}</span>
      </div>`;
  }

  // Plan cards (own helper). Empty string when no plans.
  const plansHtml = (typeof _renderPlanCards === 'function') ? _renderPlanCards(v) : '';

  // EMPTY STATE → the plan/share composer (default moment + share-text preview
  // + one "Send to friends"). When friends are here or a plan exists, fall back
  // to the regular zone (cards + the honey invite CTA).
  if (!checkins.length && !plansHtml) {
    // No external "FRIENDS" label here — the composer card owns its title
    // ("Inviter venner hit", top-left, like the sun card's "Solforhold").
    return `
      <div class="dp-social-zone">
        ${_renderSocialComposer(v)}
      </div>`;
  }

  // Invite CTA — the one honey unless a pending RSVP already owns the honey
  // (then it steps back to a secondary outline).
  const inviteSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z"/><circle cx="9.6" cy="9.5" r="1.6"/><circle cx="14.4" cy="9.5" r="1.6"/><path d="M7 13.5c.6-1.1 1.6-1.7 2.6-1.7M14.4 11.8c1 0 2 .6 2.6 1.7"/></svg>`;
  const inviteCls = _venueHasPendingInvite(v) ? 'dp-invite-cta is-secondary' : 'p-pill dp-invite-cta';
  const inviteBtn = `<button class="${inviteCls}" onclick="_openInviteSheet(${v.id})">${inviteSvg}<span>${t('invite_friends')}</span></button>`;

  return `
    <div class="dp-social-zone">
      <div class="dp-section-title">${t('friends')}</div>
      ${hereCard}
      ${plansHtml}
      ${inviteBtn}
    </div>`;
}

/** Empty-state composer (no friends here, no plans yet): a default plan moment
 *  ("Tomorrow · 15:30" — STATIC for now, editing is being reworked), your
 *  avatar, a Jordy-blue share-text preview bubble, and one navy "Send to
 *  friends" button that opens the invite sheet. */
function _renderSocialComposer(v) {
  const cap = (s) => (s && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now  = new Date();
  const tmrw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const pad  = (n) => String(n).padStart(2, '0');
  const tmrwStr  = `${tmrw.getFullYear()}-${pad(tmrw.getMonth() + 1)}-${pad(tmrw.getDate())}`;
  const planHour = 15.5;
  const dayHeader = (typeof _dayLabel === 'function') ? cap(_dayLabel(tmrwStr)) : 'Tomorrow';
  const dayInline = (typeof _dayLabel === 'function') ? _dayLabel(tmrwStr) : 'tomorrow';
  const timeStr   = (typeof formatHour === 'function') ? formatHour(planHour) : '15:30';

  // Sun at the planned moment (its own date) → the share-text context.
  let sunUntil = null;
  try {
    const { windows } = computeSunWindows(v, tmrwStr);
    const cur = (windows || []).find(w => planHour >= w.start && planHour < w.end);
    if (cur) sunUntil = formatHour(cur.end);
  } catch (e) { /* no sun data */ }

  const msg = sunUntil
    ? t('composer_preview_sun', { venue: v.name, day: dayInline, time: timeStr, sunUntil })
    : t('composer_preview',     { venue: v.name, day: dayInline, time: timeStr });

  // Your avatar (right side) — reuse the friend-avatar renderer with one slot.
  const me = (typeof _currentUser !== 'undefined' && _currentUser)
    ? _currentUser
    : (typeof window !== 'undefined' ? window._currentUser : null);
  const meAv = me
    ? _renderFriendAvatarsHtml([{ user: {
        id: me.id, name: me.user_metadata?.name, email: me.email,
        avatar_url: me.user_metadata?.avatar_url,
      } }], 1, 34)
    : '';

  const chev  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const plane = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>`;

  return `
    <div class="dp-social-card dp-composer">
      <div class="dp-composer-titlerow">
        <div class="dp-composer-title">${t('invite_friends')}</div>
        ${meAv ? `<div class="dp-composer-me">${meAv}</div>` : ''}
      </div>
      <button type="button" class="dp-composer-when" onclick="_openNarPanel(${v.id})" aria-label="${t('nar_card_title')}">
        <span class="dp-composer-day">${esc(dayHeader)}</span>
        <span class="dp-composer-sep">·</span>
        <span class="dp-composer-time">${timeStr}</span>
        <span class="dp-composer-chev" aria-hidden="true">${chev}</span>
      </button>
      <div class="dp-composer-bubble">${esc(msg)}</div>
      <button class="dp-composer-send" onclick="_openInviteSheet(${v.id})">${plane}<span>${t('send_to_friends')}</span></button>
    </div>`;
}

// ── NÅR picker — combined date + time picker (replaces invite stage 1) ───────
// Opens from the composer's "when" tap. body.nar-mode collapses the detail
// panel to handle + plan card, then the picker (inside #dp-scroll, after the
// plan card) grows up from max-height:0 — reusing the global day-strip
// (_renderQcCalendarStrip) + the reparented FTS (#fts). "Velg venner / Del"
// hands off to the invite sheet's select-friends page (transition comes later).
let _narVenueId = null;

function _narDateLabel(dateStr) {
  try {
    const loc = (typeof lang !== 'undefined' && lang) ? lang : 'nb-NO';
    return new Date(dateStr + 'T12:00:00')
      .toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch (e) { return dateStr || ''; }
}

// Keep the card's date label in sync with the global moment (the reparented
// day-strip + FTS drive datePicker).
function _narSyncStatus() {
  const dEl = document.getElementById('nar-date');
  if (!dEl) return;
  const dateStr = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : '';
  dEl.textContent = _narDateLabel(dateStr);
}

function _openNarPanel(venueId) {
  if (document.querySelector('.nar-picker')) return; // already open
  const scroll = document.getElementById('dp-scroll');
  const social = scroll && scroll.querySelector('.dp-social-zone');
  if (!scroll || !social) return;
  _narVenueId = venueId;

  const planeSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/></svg>`;

  // The picker lives INSIDE the detail panel, right after the plan card. CSS
  // (body.nar-mode) hides every other #dp-scroll child, leaving handle + plan
  // card, then grows the picker up (max-height) — pushing the plan card up as
  // the bottom-anchored panel expands. No reparenting, no full-panel recede
  // (that froze on the panel's backdrop-filter).
  const picker = document.createElement('div');
  picker.className = 'nar-picker';
  picker.innerHTML = `
    <div class="dp-divider" aria-hidden="true"></div>
    <div class="nar-card">
      <div class="nar-card-head">
        <span class="nar-card-title">${t('nar_card_title')}</span>
      </div>
      <div class="nar-strip" id="nar-strip"></div>
      <div class="nar-fts-slot" id="nar-fts-slot"></div>
    </div>
    <div class="dp-divider" aria-hidden="true"></div>
    <div class="dpinvite-cta-row">
      <button type="button" class="nar-send" onclick="_narGoToShare(${venueId})">
        ${planeSvg}<span>${t('send_to_friends')}</span>
      </button>
    </div>
    <div class="dprcv-cta-row">
      <button type="button" class="dprcv-cta-link" onclick="_closeNarPanel()"><span>${t('invite_cancel')}</span></button>
    </div>`;
  social.insertAdjacentElement('afterend', picker);

  // Day-strip — reuse the global QC strip renderer (its day taps set the date).
  const strip = picker.querySelector('#nar-strip');
  if (strip && typeof _renderQcCalendarStrip === 'function') {
    try { _renderQcCalendarStrip(strip); } catch (e) { /* strip optional */ }
  }

  // Reparent the FTS in (proven pattern — see the invite sheet). Remember its
  // home so _closeNarPanel can put it back exactly where it was.
  const fts = document.getElementById('fts');
  const slot = picker.querySelector('#nar-fts-slot');
  if (fts && slot) {
    picker._ftsHome = fts.parentNode;
    if (fts.parentNode !== slot) slot.appendChild(fts);
  }

  // Tap outside the detail panel (map) closes the picker back to the full card.
  picker._onDocDown = (ev) => {
    const dp = document.getElementById('detail-panel');
    if (dp && !dp.contains(ev.target)) _closeNarPanel();
  };
  setTimeout(() => document.addEventListener('pointerdown', picker._onDocDown), 0);

  // Collapse the panel to handle + plan card, then grow the picker up.
  void picker.offsetWidth; // commit max-height:0 before the grow
  document.body.classList.add('nar-mode');
  // Un-clip once grown so the FTS scrub popup isn't cut off by overflow:hidden.
  picker._overflowTimer = setTimeout(() => { picker.style.overflow = 'visible'; }, 440);
}

function _closeNarPanel() {
  const picker = document.querySelector('.nar-picker');
  if (!picker) return;
  // Return the FTS to its home parent.
  const fts = document.getElementById('fts');
  if (fts && picker._ftsHome && fts.parentNode !== picker._ftsHome) {
    fts.style.cssText = '';
    picker._ftsHome.appendChild(fts);
  }
  if (picker._onTime && typeof timeFromEl !== 'undefined' && timeFromEl) {
    timeFromEl.removeEventListener('input', picker._onTime);
  }
  if (picker._onDocDown) document.removeEventListener('pointerdown', picker._onDocDown);
  if (picker._overflowTimer) clearTimeout(picker._overflowTimer);
  picker.style.overflow = 'hidden';        // re-clip for the collapse
  document.body.classList.remove('nar-mode'); // siblings reappear, picker collapses
  setTimeout(() => { try { picker.remove(); } catch (e) {} }, 420);
}

// Hand off to the invite sheet's select-friends (share) page. The polished
// WHEN→WHO transition is deferred; for now we open + jump straight to share.
function _narGoToShare(venueId) {
  _closeNarPanel();
  if (typeof _openInviteSheet === 'function') {
    _openInviteSheet(venueId);
    if (typeof _dpinviteGoToShare === 'function') {
      setTimeout(() => { try { _dpinviteGoToShare(venueId); } catch (e) {} }, 60);
    }
  }
}

if (typeof window !== 'undefined') {
  window._openNarPanel = _openNarPanel;
  window._closeNarPanel = _closeNarPanel;
  window._narGoToShare = _narGoToShare;
}

/** Plans block — own section below the social card. Empty string when no
 *  plans for this venue, so the section disappears cleanly.
 *
 *  Cream-frost redesign (2026-05-28): the block is a cream tile on the frost
 *  sheet (#detail-panel scope flips its text tokens to ink — see
 *  components-content.css). Each plan is a tidy vertical row:
 *    · WHEN  — a calendar-clock glyph + strong-ink date + a honey-dim time chip
 *              (deep amber on dim honey — honey TEXT would wash out on cream).
 *    · WHO   — "from {creator}" muted-ink, with an optional quoted message.
 *    · GUESTS— (creator only) avatars + per-person status pip + arrival chip.
 *    · ACTIONS — Accept (the ONE honey .p-pill, only when a pending invite is
 *              the user's), Decline (.d-pill destructive), Preview (.g-rnd ghost,
 *              ink via .on-light). Non-pending invitees see a status chip.
 *  All data/logic (getPlansForVenue, creator check, _invitees, arrival_time,
 *  message) is unchanged — markup + CSS only. */
/** Plan cards for the VENNER zone (Claude-Design pass 2). Returns just the
 *  cards (no wrapper/section title — the social zone owns those). Empty string
 *  when there are no plans. Each card: day · time + going-avatars, "N skal hit",
 *  a sun chip for the planned moment, and actions (Bli med / Kanskje). */
function _renderPlanCards(v) {
  const plans = typeof getPlansForVenue === 'function' ? getPlansForVenue(v.id) : [];
  if (!plans.length) return '';

  const sunGlyph = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
  const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cap = (s) => (s && s.length) ? s.charAt(0).toUpperCase() + s.slice(1) : s;

  return plans.map(p => {
    const d = new Date(p.planned_at);
    const planDateStr = (p.planned_at || '').slice(0, 10);
    const planHour = d.getHours() + d.getMinutes() / 60;
    const dayLabel = (typeof _dayLabel === 'function' && planDateStr)
      ? cap(_dayLabel(planDateStr))
      : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = (typeof formatHour === 'function') ? formatHour(planHour)
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Going = creator + accepted invitees → avatars + count ("N skal hit").
    const accepted = Array.isArray(p._invitees) ? p._invitees.filter(i => i.status === 'accepted') : [];
    const goingUsers = [];
    if (p.creator) goingUsers.push({ user: p.creator });
    accepted.forEach(i => { if (i.user) goingUsers.push({ user: i.user }); });
    const goingCount = goingUsers.length || 1;
    const goingAv = goingUsers.length ? _renderFriendAvatarsHtml(goingUsers, 4, 28) : '';

    // Sun for the planned moment (its own date) — the reason you'd meet here.
    let sunMain = '', sunSub = '', sunCls = 'no-sun';
    try {
      const { windows: pw } = computeSunWindows(v, planDateStr);
      const cur = pw.find(w => planHour >= w.start && planHour < w.end);
      if (cur) {
        sunCls = 'in-sun';
        sunMain = cap(t('state_sun_until_big', { time: formatHour(cur.end) }));
        const mins = Math.max(1, Math.round((cur.end - planHour) * 60));
        const _hu = t('unit_h_short');
        const dur = mins >= 60 ? `${Math.floor(mins / 60)}${_hu} ${mins % 60}m` : `${mins} min`;
        sunSub = t('plan_sun_when_meet', { dur });
      } else {
        const next = pw.find(w => w.start > planHour);
        sunMain = next ? cap(t('state_sun_from', { time: formatHour(next.start) })) : t('plan_in_shade');
        sunSub = next ? t('plan_sun_later') : t('plan_no_sun_when_meet');
      }
    } catch (e) { /* no sun data */ }

    const invite = p._invite;
    const pending = invite && invite.status === 'pending';
    let actions;
    if (pending) {
      actions = `<button class="p-pill dp-plan-join" onclick="respondToPlanInvite('${invite.id}','accepted')">${t('plan_join')}</button>
        <button class="dp-plan-maybe" onclick="openPlanPreview({venueId:${v.id}, plannedAt:'${p.planned_at}', mode:'preview'})">${t('plan_maybe')}</button>`;
    } else if (invite) {
      actions = `<span class="plan-status plan-status-${invite.status}">${t('plan_invite_' + invite.status)}</span>
        <button class="dp-plan-maybe" onclick="openPlanPreview({venueId:${v.id}, plannedAt:'${p.planned_at}', mode:'preview'})">${t('preview_plan')}</button>`;
    } else {
      actions = `<button class="dp-plan-maybe" onclick="openPlanPreview({venueId:${v.id}, plannedAt:'${p.planned_at}', mode:'preview'})">${t('preview_plan')}</button>`;
    }

    return `<div class="dp-social-card dp-plan-card${pending ? ' is-pending' : ''}">
      <div class="dp-plan-top">
        <div class="dp-plan-when"><span class="dp-plan-day">${esc(dayLabel)}</span> · <span class="dp-plan-time">${timeStr}</span></div>
        ${goingAv ? `<div class="dp-plan-going-av">${goingAv}</div>` : ''}
      </div>
      <div class="dp-plan-going">${t('pp_going_count', { n: goingCount })}</div>
      ${p.message ? `<div class="plan-msg">${esc(p.message)}</div>` : ''}
      ${sunMain ? `<div class="dp-plan-sun ${sunCls}">${sunGlyph}<div class="dp-plan-sun-txt"><span class="dp-plan-sun-main">${esc(sunMain)}</span>${sunSub ? `<span class="dp-plan-sun-sub">${esc(sunSub)}</span>` : ''}</div></div>` : ''}
      <div class="dp-plan-actions">${actions}</div>
    </div>`;
  }).join('');
}

/** Friend-add: debounced send + tap-again-to-undo flow.
 *
 *  v1 fired the friendships upsert synchronously on tap, with no UI
 *  state change on the card afterwards. The user could mis-tap with
 *  no way back, and the action card stuck around as if nothing had
 *  happened. Phase A of the new flow:
 *
 *    Tap →
 *      1. Show 'Friend request sent' toast immediately (optimistic UI)
 *      2. Swap the card content to a benefit line + 'tap to undo' hint
 *      3. Wait 4 s, THEN fire the actual upsert
 *
 *    Tap again during the 4 s window →
 *      1. Cancel the timer (upsert never runs)
 *      2. Revert the card content + show 'withdrawn' toast
 *
 *  Phase B (slide-out + promote next card) layers on top later.
 *
 *  State is tracked on the card DOM via data-pending="1" + a per-id
 *  timer in a module-level Map so the second tap can find and clear
 *  the right timer. */
const _friendRequestTimers   = new Map();
const _committedFriendRequests = new Set();
const FRIEND_DEBOUNCE_MS = 3000;
// SVG glyphs for the friend-flow toast — same Lucide-style 'user-plus'
// the action card uses for 'sent', and a 'user-minus' (- instead of +
// next to the silhouette) for the cancelled state. SVGs are passed
// via notif.iconHtml so the toast renders proper line art rather than
// emoji that vary by platform.
const FRIEND_ICON_SENT      = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>';
const FRIEND_ICON_CANCELLED = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="17" y1="11" x2="23" y2="11"/></svg>';

/** Friend-flow toast helper — bypasses _showToast so we can pass an
 *  icon AND animate a clean swap when the user cancels mid-debounce.
 *  v1 called _showToast on both send and cancel, which routed to
 *  _notifShowImmediate. That function dismissed + re-showed
 *  synchronously, so the wrap's .show class oscillated removed →
 *  added in one tick — no exit-then-enter animation. Here we
 *  manually remove .show first, wait for the slide-up + fade-out to
 *  complete, then show the new toast (which slides down + fades in
 *  via the same CSS). */
function _friendFlowToast(iconHtml, bodyKey) {
  const fire = () => {
    if (typeof _notifShowImmediate === 'function' &&
        typeof _notifInitDone !== 'undefined' && _notifInitDone) {
      _notifShowImmediate({
        id:       'friend_flow_' + Date.now(),
        priority: 1,
        category: 'system',
        iconHtml: iconHtml,
        bodyKey:  bodyKey,
        _legacyDismiss: 3500,
      });
    } else if (typeof _showToast === 'function') {
      _showToast(t(bodyKey));
    }
  };
  const wrap = document.getElementById('notif-toast-wrap');
  if (wrap && wrap.classList.contains('show')) {
    wrap.classList.remove('show'); // triggers slide-up + fade-out
    setTimeout(fire, 280);          // ~ matches CSS opacity 0.3 s + transform
  } else {
    fire();
  }
}
function _commitFriendRequest(inviterId) {
  // Test-token inviters are namespaced 'test-' — skip the actual
  // Supabase upsert (the fake UUID would fail the foreign key) but
  // pretend everything succeeded so the UI flow still completes.
  if (typeof inviterId === 'string' && inviterId.startsWith('test-')) return;
  if (typeof _supabase === 'undefined' || typeof authCurrentUser !== 'function' || !authCurrentUser()) return;
  return _supabase.from('friendships').upsert({
    user_id:   inviterId,
    friend_id: authCurrentUser().id,
    status:    'pending',
  }, { onConflict: 'user_id,friend_id' }).then(() => {
    if (typeof loadFriends === 'function') loadFriends();
  }).catch(() => { /* ignore */ });
}
function _revertFriendCard(cardEl, inviterName) {
  if (!cardEl) return;
  cardEl.removeAttribute('data-pending');
  const titleEl = cardEl.querySelector('.dpacc-action-title');
  const subEl   = cardEl.querySelector('.dpacc-action-sub');
  if (titleEl) titleEl.textContent = inviterName
    ? t('accepted_action_add_friend',      { name: inviterName })
    : t('accepted_action_add_friend_anon');
  if (subEl)   subEl.textContent   = t('accepted_action_add_friend_sub');
}
function _pendingFriendCard(cardEl, inviterName) {
  if (!cardEl) return;
  cardEl.setAttribute('data-pending', '1');
  const titleEl = cardEl.querySelector('.dpacc-action-title');
  const subEl   = cardEl.querySelector('.dpacc-action-sub');
  if (titleEl) titleEl.textContent = inviterName
    ? t('accepted_action_add_friend_done',      { name: inviterName })
    : t('accepted_action_add_friend_done_anon');
  if (subEl)   subEl.textContent   = t('accepted_action_add_friend_undo');
}
/** Three-phase slide-out for the committed friend card. Used after
 *  the 4-s debounce fires so the user gets a clear 'done, moving on'
 *  beat. Phases:
 *    1. Fade out the friend card (opacity 0, in place).
 *    2. Remove from layout; record sibling positions; apply inverse
 *       translateX so siblings appear in their OLD positions.
 *    3. Promote the next card to primary AND clear inline transforms —
 *       siblings slide left into the gap while the new leader's
 *       background animates glass → accent (both via CSS transitions
 *       on .dpacc-action-card). */
function _slideOutFriendCard(cardEl) {
  if (!cardEl || !cardEl.isConnected) return;
  cardEl.classList.add('is-fading');
  setTimeout(() => {
    if (!cardEl.isConnected) return;
    const row = cardEl.parentElement;
    if (!row) return;
    const siblings = Array.from(row.children).filter(s => s !== cardEl);
    const prevRects = siblings.map(s => s.getBoundingClientRect());
    cardEl.style.display = 'none';
    // Use Web Animations API for the FLIP — keyframe each sibling
    // from its OLD pixel position back to its NEW one. This avoids
    // touching the element's inline `transition` property, which
    // would clobber the CSS background/color transitions and make
    // the new leader's glass→accent swap snap instead of fade.
    siblings.forEach((s, i) => {
      const newRect = s.getBoundingClientRect();
      const dx = prevRects[i].left - newRect.left;
      if (Math.abs(dx) < 0.5) return;
      if (typeof s.animate === 'function') {
        s.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
          { duration: 340, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'none' }
        );
      }
    });
    // Promote new leader — add .dpacc-action-primary alongside .card.
    // CSS transitions on .dpacc-action-card handle the bg/color
    // animation; they run in parallel with the WAAPI slide above.
    const newLead = siblings[0];
    if (newLead && newLead.classList) {
      newLead.classList.add('dpacc-action-primary');
    }
    setTimeout(() => {
      try { cardEl.remove(); } catch (e) { /* ignore */ }
    }, 360);
  }, 220);
}
function _handleFriendPromptAdd(inviterId, inviterName) {
  // Already-committed guard: once the debounce has fired and the
  // friendships row exists, further taps on the same card are no-ops
  // (we don't want a duplicate row OR a misleading 'undo' UI).
  if (_committedFriendRequests.has(inviterId)) return;
  const cardEl = document.querySelector('.dpacc-action-card[data-action="add_friend"]');
  // If a request is already pending for this inviter, this second tap
  // is an UNDO — cancel the timer + revert.
  if (_friendRequestTimers.has(inviterId)) {
    const tid = _friendRequestTimers.get(inviterId);
    clearTimeout(tid);
    _friendRequestTimers.delete(inviterId);
    _revertFriendCard(cardEl, inviterName);
    if (typeof _aTrack === 'function') _aTrack('invite_friend_prompt', { action: 'withdrawn' });
    _friendFlowToast(FRIEND_ICON_CANCELLED, 'friend_request_withdrawn');
    return;
  }
  // First tap — optimistic UI + debounced commit.
  if (typeof _aTrack === 'function') _aTrack('invite_friend_prompt', { action: 'added' });
  _pendingFriendCard(cardEl, inviterName);
  _friendFlowToast(FRIEND_ICON_SENT, 'friend_request_sent');
  const tid = setTimeout(() => {
    _friendRequestTimers.delete(inviterId);
    _committedFriendRequests.add(inviterId);
    _commitFriendRequest(inviterId);
    if (typeof window !== 'undefined') window._pendingFriendPrompt = null;
    // Three-phase commit animation:
    //   1. Friend card fades out in place (220 ms)
    //   2. Cards to the right slide left into the gap (FLIP, 340 ms)
    //   3. New leading card transitions glass → honey accent during
    //      the slide (CSS bg/color transitions tied to class swap)
    if (cardEl && cardEl.isConnected) _slideOutFriendCard(cardEl);
  }, FRIEND_DEBOUNCE_MS);
  _friendRequestTimers.set(inviterId, tid);
  // Legacy banner cleanup — irrelevant on the new post-accept panel
  // but kept so older surfaces that surface the same handler clean up.
  const banner = document.getElementById('friend-prompt-banner');
  if (banner) banner.remove();
}

function _handleFriendPromptDismiss(inviterId) {
  if (typeof _aTrack === 'function') _aTrack('invite_friend_prompt', { action: 'dismissed' });
  try {
    const KEY = 'solsteder_dismissed_friend_prompts';
    const dismissed = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!dismissed.includes(inviterId)) dismissed.push(inviterId);
    localStorage.setItem(KEY, JSON.stringify(dismissed));
  } catch {}
  if (typeof userStateAddDismissedPrompt === 'function') userStateAddDismissedPrompt(inviterId);
  if (typeof window !== 'undefined') window._pendingFriendPrompt = null;
  const banner = document.getElementById('friend-prompt-banner');
  if (banner) banner.remove();
  // After friend-prompt clears, the share nudge (if pending) takes its slot.
  if (typeof window !== 'undefined' && window._pendingShareNudge && typeof updateDetailPanel === 'function') {
    updateDetailPanel();
  }
}

/** Post-accept share nudge — Del videre action. Routing:
 *    - User has no friends saved, OR every friend has already
 *      accepted this plan → native share (just the link).
 *    - Otherwise → open the invite sheet pre-filled with the plan's
 *      venue + meet time so the user can pick specific friends.
 *  v1 always fired native share; the invite-sheet path is a much
 *  higher-engagement way to invite the next friend(s) to the same
 *  plan without re-entering the venue / time. */
function _handleShareNudgeShare(venueId) {
  const sn = (typeof window !== 'undefined') ? window._pendingShareNudge : null;
  if (typeof _aTrack === 'function') _aTrack('share_nudge', { action: 'shared' });
  if (typeof window !== 'undefined') window._pendingShareNudge = null;
  const banner = document.getElementById('share-nudge-banner');
  if (banner) banner.remove();

  // Decide routing.
  const friends = (typeof _friends !== 'undefined' && Array.isArray(_friends)) ? _friends : [];
  let allFriendsAccepted = false;
  if (friends.length > 0 && sn && sn.planId && typeof getPlansForVenue === 'function') {
    try {
      const plans = getPlansForVenue(venueId) || [];
      const plan = plans.find(p => String(p.id) === String(sn.planId)) || plans[0];
      if (plan && Array.isArray(plan._invitees)) {
        const acceptedIds = new Set(plan._invitees
          .filter(i => i.status === 'accepted' && i.user && i.user.id)
          .map(i => String(i.user.id)));
        const remaining = friends.filter(f => !acceptedIds.has(String(f.id)));
        allFriendsAccepted = remaining.length === 0;
      }
    } catch (e) { /* ignore — fall through to native share */ }
  }
  const canOpenInviteSheet = friends.length > 0
    && !allFriendsAccepted
    && typeof _openInviteSheet === 'function';

  if (canOpenInviteSheet) {
    // Pre-fill the global date/time pickers with the plan's plannedAt
    // so _openInviteSheet inherits the right moment. Sheet reads from
    // datePicker.value / timeFromEl.value at open-time.
    if (sn && sn.plannedAt && typeof datePicker !== 'undefined' && datePicker) {
      const dt = new Date(sn.plannedAt);
      if (!isNaN(dt.getTime())) {
        const pad = n => String(n).padStart(2, '0');
        const dateStr = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        const hour = dt.getHours() + dt.getMinutes() / 60;
        if (datePicker.value !== dateStr) {
          datePicker.value = dateStr;
          datePicker.dispatchEvent(new Event('change'));
        }
        if (typeof timeFromEl !== 'undefined' && timeFromEl) {
          timeFromEl.value = hour;
          timeFromEl.dispatchEvent(new Event('input'));
        }
      }
    }
    // Close the post-accept panel cleanly, then open the invite sheet
    // after the slide-down — same 320 ms handoff the change-response
    // path uses. The 'return to post-accept' flag tells _closeInviteSheet
    // to reopen the confirmation panel if the user backs out (cancel,
    // backdrop tap, drag-down).
    if (typeof window !== 'undefined') {
      window._inviteSheetReturnToPostAccept = true;
    }
    _closePostAcceptPanel({
      skipExitToExplore:    true,
      skipClearShareNudge:  true,
      skipBodyClassRemoval: true,
    });
    setTimeout(() => {
      try { _openInviteSheet(venueId); } catch (e) { /* ignore */ }
    }, 320);
    return;
  }
  // Fallback: native share (existing behaviour).
  if (typeof _shareInviteLink === 'function') {
    _shareInviteLink(venueId, {
      planId:    sn && sn.planId,
      plannedAt: sn && sn.plannedAt,
    });
  }
}

function _handleShareNudgeDismiss() {
  if (typeof _aTrack === 'function') _aTrack('share_nudge', { action: 'dismissed' });
  if (typeof window !== 'undefined') window._pendingShareNudge = null;
  const banner = document.getElementById('share-nudge-banner');
  if (banner) banner.remove();
}

/** Format a Date as a UTC ICS timestamp (YYYYMMDDTHHMMSSZ). */
function _icsFmtUtc(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** Escape per RFC 5545 — backslash, comma, semicolon, newline. */
function _icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r?\n/g, '\\n');
}

/** Build an .ics calendar event for an invite. UID is stable when planId is
 *  present (so re-shares update the existing event rather than duplicate, per
 *  RFC 5545). Default duration is 2 hours.
 *  Title format: "{venue} with {inviter}" or "{venue}" (no app-name prefix
 *  — calendar apps already group by source app, so prefixing with "Solsteder"
 *  is noise that competes with the meeting context). */
function _buildIcs({ venue, plannedAt, planId, durationMin = 120, link, inviterName }) {
  if (!venue || !plannedAt) return null;
  const start = new Date(plannedAt);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + durationMin * 60 * 1000);
  const now = new Date();

  const uid = planId
    ? `plan-${planId}@findshades.app`
    : `invite-${venue.id}-${start.getTime()}@findshades.app`;

  const inviterPart = inviterName
    ? ` ${t('with_inviter_label', { name: inviterName }) || `with ${inviterName}`}`
    : '';
  const titleText = `${venue.name}${inviterPart}`;
  const summary = _icsEscape(titleText);
  const location = _icsEscape(venue.area ? `${venue.name}, ${venue.area}` : venue.name);
  const description = _icsEscape(link
    ? `${titleText}\n${link}`
    : titleText);
  const url = link || '';
  const geo = (venue.lat != null && venue.lng != null) ? `${venue.lat};${venue.lng}` : '';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Solsteder//Plan//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${_icsFmtUtc(now)}`,
    `DTSTART:${_icsFmtUtc(start)}`,
    `DTEND:${_icsFmtUtc(end)}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location}`,
  ];
  if (geo) lines.push(`GEO:${geo}`);
  if (url) lines.push(`URL:${url}`);
  lines.push(`DESCRIPTION:${description}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  // RFC 5545 requires CRLF line endings.
  return lines.join('\r\n') + '\r\n';
}

/** Slug a string for filename use — strip diacritics, keep [a-z0-9-]. */
function _slugForFile(s) {
  return String(s || 'plan')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'plan';
}

/** Post-accept calendar action — generates an .ics file from the stashed
 *  share-nudge context and triggers a download. iOS Safari opens the system
 *  "Add to Calendar" sheet; Android Chrome offers a calendar app picker;
 *  desktop browsers download the .ics so the user can double-click into
 *  Calendar.app / Outlook. */
function _handleCalendarAdd(venueId, inviterName) {
  const sn = (typeof window !== 'undefined') ? window._pendingShareNudge : null;
  if (typeof _aTrack === 'function') _aTrack('share_nudge', { action: 'calendar' });

  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  let plannedAt = sn && sn.plannedAt;
  if (!plannedAt) {
    // Fallback to the live pickers — same shape as _shareInviteLink overrides
    const { d, h } = (typeof _getInviteDateTime === 'function') ? _getInviteDateTime() : {};
    if (d && h != null) {
      const hh = Math.floor(h);
      const mm = Math.round((h - hh) * 60);
      plannedAt = new Date(`${d}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00`).toISOString();
    }
  }
  if (!v || !plannedAt) {
    if (typeof console !== 'undefined') {
      console.warn('[calendar] aborted —',
        !v ? `venue ${venueId} not in VENUES` : 'no plannedAt (share-nudge cleared and pickers empty)');
    }
    return;
  }

  const ics = _buildIcs({
    venue: v,
    plannedAt,
    planId: sn && sn.planId,
    durationMin: 120,
    link: sn && sn.link,
    inviterName,
  });
  if (!ics) return;

  // Calendar download is fiddly on mobile WebKit. Two distinct paths:
  //   * iOS Safari: the data: URI via window.location is the only thing
  //     that triggers the system 'Add to Calendar' sheet — blob downloads
  //     just navigate to the blob URL showing raw ICS text.
  //   * iOS Chrome (CriOS): does NOT recognise data:text/calendar as a
  //     calendar event — it shows a Save-to-Files prompt with a filename
  //     of 'unknown'. The blob+download path gives it a proper .ics
  //     filename, which the user can then tap from Files to open in
  //     Calendar. User-reported: 'iPhone 17 Chrome, downloaded ics
  //     labeled "unknown" with Disk/Filer options'.
  //   * Desktop: blob+download (filename preserved, no navigation).
  const ua = navigator.userAgent || '';
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isIosSafari = isIos && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  const filename = `solsteder-${_slugForFile(v.name)}.ics`;

  if (isIosSafari) {
    // btoa needs latin-1; use the unescape/encodeURIComponent trick to
    // handle any non-ASCII chars in venue names ('Ekebergrestauranten' etc.).
    const b64 = btoa(unescape(encodeURIComponent(ics)));
    const dataUri = `data:text/calendar;charset=utf-8;base64,${b64}`;
    window.location.href = dataUri;
  } else {
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (typeof window !== 'undefined') window._pendingShareNudge = null;
  const banner = document.getElementById('share-nudge-banner');
  if (banner) banner.remove();
}

// ── Accepted panel — parallel-action carousel ──────────────────────────────

/** Open the accepted confirmation panel after RSVP "I'm in". Replaces the
 *  prior sequential question carousel with a 5-card horizontal action row
 *  (Calendar, Directions, Open venue, Add friend if applicable, Share onward).
 *  Slides up from the bottom; backdrop tap or "Endre svar" link closes.
 *
 *  opts: { venueId, venueName, plannedAt, whenLabel, inviterName, inviterId,
 *          arrivalDate, sunUntil, attendees }
 *  Reads window._pendingFriendPrompt / window._pendingShareNudge to decide
 *  which optional cards to surface; clears them on close. */
function _openPostAcceptPanel(opts) {
  const existing = document.getElementById('post-accept-overlay');
  if (existing) existing.remove();

  // Stash the full opts so Share Onward can reopen this exact panel
  // when the user backs out of the invite sheet (cancel/backdrop).
  if (typeof window !== 'undefined') window._lastPostAcceptOpts = opts;

  const venueName  = opts.venueName || '';
  const whenLabel  = opts.whenLabel || '';
  const arrivalDate = opts.arrivalDate || '';
  const sunUntil   = opts.sunUntil || '';
  const fp = (typeof window !== 'undefined') ? window._pendingFriendPrompt : null;
  const sn = (typeof window !== 'undefined') ? window._pendingShareNudge : null;
  const inviterName = (fp && fp.inviterName) || opts.inviterName || '';
  const inviterId   = (fp && fp.inviterId)   || opts.inviterId   || null;
  // Gate the friend card on the inviter id only — the name is best-effort
  // (profile lookup may fail under stricter RLS or transient errors), so
  // dropping the card when it's missing surprises users who expected to
  // see an Add Friend option. User-reported: 'In her confirmation page
  // she also did not get the option to add me as a friend.' Card title
  // falls back to a name-less string when inviterName is empty.
  const showAddFriend = !!(fp && fp.inviterId);
  const showShare     = !!(sn && String(sn.venueId) === String(opts.venueId));

  // Subtitle: drop the redundant {arrivalDate} segment — whenLabel
  // already carries the date in user-friendly form ('today at 14:00'
  // / 'on Sunday at 20:40' / 'Saturday 4 May at 14:00'), so showing
  // both produced lines like 'Sun 17 May · on Sunday at 20:40' that
  // repeat the day. After-sundown variant collapses 'on Sunday at
  // 20:40 · sun went down at 20:40' into 'on Sunday at 20:40 · sun
  // gone' so the same time doesn't appear twice.
  const isAfterSundown = (opts.sunEndNum != null && opts.arrivalHour != null
                          && opts.sunEndNum <= opts.arrivalHour + 0.01);
  let sunFragment = '';
  if (isAfterSundown) {
    sunFragment = t('invite_hero_remaining_no_sun').toLowerCase();
  } else if (sunUntil) {
    sunFragment = `${t('invite_hero_sun_until').toLowerCase()} ${sunUntil}`;
  }
  const subtitle = [whenLabel, sunFragment].filter(Boolean).join(' · ') || venueName;

  const checkSvg   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const safeName    = venueName.replace(/</g, '&lt;');
  const safeWhen    = (whenLabel || '').replace(/</g, '&lt;');
  const safeSubtitle = subtitle.replace(/</g, '&lt;');

  // Build action card list — contextual ordering. The first card is always
  // primary (solid accent) per the design system's "one Primary per screen"
  // rule. When the receiver isn't yet friends with the inviter, AddFriend
  // takes priority (highest social value). Otherwise Share onward leads.
  const actions = [];
  if (showAddFriend) actions.push('add_friend');
  // Always offer Share onward (the share-nudge global flags whether to
  // surface it as a *card*; if absent, fall back to the share button so
  // the carousel still has a clear primary post-AddFriend).
  actions.push('share');
  if (opts.venueId && opts.plannedAt) actions.push('calendar');
  if (typeof userLocation !== 'undefined' && userLocation && opts.venueId) actions.push('directions');
  if (opts.venueId) actions.push('open');

  const cardsHtml = actions.map((type, i) =>
    _renderAcceptedActionCard(type, {
      venueId: opts.venueId,
      venueName,
      plannedAt: opts.plannedAt,
      inviterName,
      inviterId,
      primary: i === 0,
    })
  ).join('');

  // Attendees row — fed by opts.attendees (array of {name, avatar_url?}).
  const attendees = Array.isArray(opts.attendees) ? opts.attendees : [];
  let attendeesHtml = '';
  if (attendees.length) {
    const stack = attendees.slice(0, 4).map(a => {
      const init = (a.name || '?')[0].toUpperCase();
      const colorIdx = (init.charCodeAt(0) || 0) % 8;
      if (a.avatar_url) {
        return `<img class="dpacc-att-av init-color-${colorIdx}" src="${a.avatar_url}" alt="" style="object-fit:cover">`;
      }
      return `<div class="dpacc-att-av dpinvite-avatar-init init-color-${colorIdx}">${init}</div>`;
    }).join('');
    const otherNames = attendees.filter(a => a.name && a.name !== 'You').map(a => a.name).slice(0, 3);
    attendeesHtml = `
      <div class="dpacc-attendees">
        <div class="dpacc-att-stack">${stack}</div>
        <div class="dpacc-att-info">
          <div class="dpacc-att-count">${t('accepted_attending_count', { n: attendees.length })}</div>
          ${otherNames.length ? `<div class="dpacc-att-names">${t('accepted_attending_names', { names: otherNames.join(', ') })}</div>` : ''}
        </div>
      </div>`;
  }

  const overlay = document.createElement('div');
  overlay.id = 'post-accept-overlay';
  overlay.className = 'dpacc-overlay';
  overlay.onclick = e => { if (e.target === overlay) _closePostAcceptPanel(); };

  const panel = document.createElement('div');
  panel.id = 'post-accept-panel';
  panel.className = 'dpacc-panel';
  panel.innerHTML = `
    <div class="dpacc-handle" aria-hidden="true">
      <div class="dpacc-grabber"></div>
    </div>
    <div class="dpacc-header-row">
      <div class="dpacc-header-text">
        <div class="dpacc-eyebrow-row">
          <div class="dpacc-eyebrow">${t('accepted_eyebrow')}</div>
          <button class="dpacc-change-rsvp" type="button" onclick="_reopenInviteFromAccept()">
            <span>${t('accepted_change_rsvp')}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
        <div class="dpacc-venue-row">
          <span class="dpacc-venue">${safeName}</span>
        </div>
        <div class="dpacc-subtitle">${safeSubtitle}</div>
      </div>
    </div>
    <div class="dpacc-action-row no-scrollbar">${cardsHtml}</div>
    ${attendeesHtml}
    <div class="dpacc-close-row">
      <button class="dpacc-close-link" type="button" onclick="_closePostAcceptPanel()">${t('accepted_close')}</button>
    </div>`;

  // Floating "you're in" toast pill removed — the panel header below
  // already says "Confirmed · {venue} · {date} · at {time}", which is
  // the same information with more context. v1 surfaced both, which
  // the user read as duplicate yellow toasts.
  overlay.appendChild(panel);
  // Stash the venueId on the overlay so _closePostAcceptPanel can open
  // the detail panel for the accepted venue after the panel fades.
  // Matches the user-requested flow: accept → post-accept panel →
  // (on close) detail panel → (on close) explore mode.
  if (opts.venueId != null) {
    overlay._followupVenueId = opts.venueId;
    // Stash the original invite opts so 'Change response' can reopen
    // the plan-preview with the same context (venue, time, inviter).
    overlay._inviteOpts = {
      venueId:     opts.venueId,
      plannedAt:   opts.plannedAt || null,
      inviteId:    opts.inviteId || null,
      inviterId:   opts.inviterId || null,
      inviterName: opts.inviterName || null,
      planTokenP:  opts.planId || null,
      mode:        opts.inviteId ? 'invite' : 'invite-anon',
    };
  }
  // Hide the main app chrome behind the panel — set BEFORE the overlay
  // is appended so the transition aligns with the panel's slide-up.
  // Removed in _closePostAcceptPanel.
  document.body.classList.add('post-accept-active');
  document.body.appendChild(overlay);
  document.body.classList.add('post-accept-active');

  requestAnimationFrame(() => {
    overlay.classList.add('open');
    panel.classList.add('open');
  });
}

/** Render one of the action cards in the accepted-panel carousel.
 *  type ∈ 'calendar' | 'directions' | 'open' | 'add_friend' | 'share'.
 *  When opts.primary is true the tile is solid-accent (one Primary per
 *  screen); otherwise it uses the .card surface. */
function _renderAcceptedActionCard(type, opts) {
  const surfaceCls = opts.primary ? ' dpacc-action-primary' : ' card';
  const venueId = opts.venueId;
  const titleStr = (key, vars) => (t(key, vars || {}) || '').replace(/</g, '&lt;');

  let title = '', sub = '', iconSvg = '';
  if (type === 'calendar') {
    title = titleStr('accepted_action_calendar');
    sub   = titleStr('accepted_action_calendar_sub');
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
  } else if (type === 'directions') {
    title = titleStr('accepted_action_directions');
    const walkMin = _dpaccWalkMinutes(venueId);
    sub = walkMin != null
      ? titleStr('accepted_action_directions_sub', { n: walkMin })
      : titleStr('accepted_action_open_sub');
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;
  } else if (type === 'open') {
    title = titleStr('accepted_action_open');
    sub   = titleStr('accepted_action_open_sub');
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  } else if (type === 'add_friend') {
    // Name-less fallback when the inviter's profile lookup didn't give
    // us a name. Avoids rendering 'Add ' with a dangling space.
    title = opts.inviterName
      ? titleStr('accepted_action_add_friend', { name: opts.inviterName })
      : titleStr('accepted_action_add_friend_anon');
    sub   = titleStr('accepted_action_add_friend_sub');
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>`;
  } else if (type === 'share') {
    title = titleStr('accepted_action_share');
    sub   = titleStr('accepted_action_share_sub');
    iconSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;
  }

  return `<button type="button" class="dpacc-action-card${surfaceCls}" data-action="${type}" onclick="_acceptedActionClick('${type}', ${venueId}, ${opts.inviterId ? `'${opts.inviterId}'` : 'null'}, ${JSON.stringify(opts.inviterName || '').replace(/"/g,'&quot;')})">
    <div class="dpacc-action-icon">${iconSvg}</div>
    <div class="dpacc-action-text">
      <div class="dpacc-action-title">${title}</div>
      <div class="dpacc-action-sub">${sub}</div>
    </div>
  </button>`;
}

/** Walking-time estimate for the directions card. Haversine + 80m/min pace.
 *  Returns minutes (rounded), or null if location unknown. */
function _dpaccWalkMinutes(venueId) {
  if (typeof userLocation === 'undefined' || !userLocation) return null;
  const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
  if (!v) return null;
  const toRad = (d) => d * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(v.lat - userLocation.lat);
  const dLng = toRad(v.lng - userLocation.lng);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(userLocation.lat)) * Math.cos(toRad(v.lat)) * Math.sin(dLng/2)**2;
  const m = 2 * R * Math.asin(Math.sqrt(a));
  return Math.max(1, Math.round(m / 80));
}

/** Dispatch an accepted-panel action card tap to the right handler. */
function _acceptedActionClick(type, venueId, inviterId, inviterName) {
  if (typeof _aTrack === 'function') _aTrack('accepted_action_tap', { type, venueId });
  try {
    if (type === 'calendar') {
      _handleCalendarAdd(venueId, inviterName);
    } else if (type === 'directions') {
      const v = (typeof VENUES !== 'undefined') ? VENUES.find(x => x.id === venueId) : null;
      if (!v) return;
      const isApple = /iPhone|iPad|Macintosh/i.test(navigator.userAgent || '');
      const url = isApple
        ? `https://maps.apple.com/?daddr=${v.lat},${v.lng}&dirflg=w`
        : `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}&travelmode=walking`;
      window.open(url, '_blank', 'noopener');
    } else if (type === 'open') {
      // 'Open venue' is the explicit detail-panel entry from the
      // post-accept carousel. Close with skipExitToExplore so the
      // default close-→-explore-mode path doesn't fight us, then open
      // the detail panel after the panel fades.
      _closePostAcceptPanel({ skipExitToExplore: true });
      setTimeout(() => {
        if (typeof selectVenue === 'function') selectVenue(venueId, true);
      }, 320);
    } else if (type === 'add_friend') {
      if (inviterId) _handleFriendPromptAdd(inviterId, inviterName);
    } else if (type === 'share') {
      _handleShareNudgeShare(venueId);
    }
  } catch (e) { /* never block the carousel on a handler failure */ }
}

function _closePostAcceptPanel(opts = {}) {
  const overlay = document.getElementById('post-accept-overlay');
  const panel = document.getElementById('post-accept-panel');
  if (panel) panel.classList.remove('open');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
  }
  // Belt-and-suspenders: clear any post-accept stash (so reopening the
  // detail panel later doesn't surface the legacy banners).
  // skipClearShareNudge keeps the share-nudge alive so the post-accept
  // panel can reopen with the same Share card (used by the invite-sheet
  // back-out flow).
  if (typeof window !== 'undefined') {
    window._pendingFriendPrompt = null;
    if (!opts.skipClearShareNudge) window._pendingShareNudge = null;
  }
  // Fire the explore-mode hand-off IMMEDIATELY (not deferred), so the
  // slider + venue list update while the panel is still sliding down.
  // The user reveals a list already showing sunny venues at the next
  // sun-window time — the panel's slide-down feels like 'curtains
  // opening on a new scene', not 'panel falls away then app catches
  // up'. User: 'Clicking close on the confirm panel should take you
  // to the next sun window.' 'Open venue' card opts out via
  // skipExitToExplore + selects the venue explicitly; 'Change
  // response' opts out + reopens plan-preview.
  if (!opts.skipExitToExplore && typeof _exitToExploreMode === 'function') {
    // Pre-warm data (date / slider / list) but skip the panel slide here
    // — body.post-accept-active is still on (kept for 320 ms so the
    // post-accept slide-down doesn't fight a venue-list reveal). The
    // slide-up fires once that class is removed below, so the user
    // sees the venue list arrive AFTER the takeover is gone.
    try { _exitToExploreMode({ skipPanelSlide: true }); } catch (e) { /* ignore */ }
  }
  // Defer body-class removal until the slide-down completes so the
  // venue list / search / FTS doesn't reveal while the panel is still
  // visible mid-slide. User: 'When you close the confirm panel, the
  // venue list instantly displays.' v1 removed the class synchronously
  // which fired the chrome's 0.25s opacity transition the instant the
  // slide started. opts.skipBodyClassRemoval lets the change-response
  // path hand off to plan-preview-active without touching this class.
  if (!opts.skipBodyClassRemoval) {
    setTimeout(() => {
      // Clear BOTH takeover classes. The accept flow reaches this panel from
      // the plan-preview (plan-preview-active) and relies on closePlanPreview
      // to drop that class — but closePlanPreview early-returns if the awaited
      // respondToPlanInvite already tore down _planPreviewState (realtime/poll
      // race), leaving plan-preview-active set. That kept body.plan-preview-
      // active #top-strip matching, so the top bar never slid back down after
      // closing the confirmation. Removing both here guarantees the chrome
      // restores. (The change-response path skips this via skipBodyClassRemoval.)
      document.body.classList.remove('post-accept-active', 'plan-preview-active');
      // Slide the venue list up from off-screen — same motion as the
      // page-load intro. Fires AFTER the body class is gone so the
      // panel is actually visible during the slide (opacity-0 mask
      // is now lifted).
      if (window.innerWidth < 640
          && typeof window._slideUpVenueListToExpanded === 'function') {
        window._slideUpVenueListToExpanded();
      }
    }, 320);
  }
}

/** Reopen the plan-preview from the post-accept panel — the 'Change
 *  response' affordance. Closes the post-accept panel without the
 *  detail-handoff, then reopens openPlanPreview with the stashed
 *  invite opts so the user can switch their accept/decline. */
function _reopenInviteFromAccept() {
  const overlay = document.getElementById('post-accept-overlay');
  const inviteOpts = overlay && overlay._inviteOpts;
  if (!inviteOpts || typeof openPlanPreview !== 'function') {
    _closePostAcceptPanel();
    return;
  }
  // Derive the invite mode from CURRENT auth state, not the stashed
  // value. v2 used the stashed mode which could be 'invite-anon'
  // (e.g. when the original landing was anon and the user logged in
  // mid-flow): reopening with the stale mode showed the 'Log in to
  // accept' button even though the user IS now logged in. Re-derive
  // here so the reopened plan-preview matches reality.
  const isAuthed = (typeof authCurrentUser === 'function')
    ? !!authCurrentUser()
    : (typeof window !== 'undefined' && !!window._currentUser);
  inviteOpts.mode = isAuthed ? 'invite' : 'invite-anon';
  // Skip the splash + camera-dive choreography on reopen — the camera
  // is already framed on the venue and the splash is long gone. v1
  // replayed jumpTo zoom-14 → flyTo zoom-17.6 (1500 ms) every time
  // the user tapped 'Change response', which read as a 'zoom out
  // then dive back in' regression.
  inviteOpts.skipCameraDive = true;
  // Skip both the default explore-mode hand-off AND the body-class
  // removal — we hand off directly to plan-preview-active. Removing
  // post-accept-active synchronously made the venue list flash for
  // ~320 ms between the confirm slide-down and the accept slide-up.
  // openPlanPreview adds plan-preview-active (same chrome-hide rules),
  // so leaving post-accept-active on until the slide finishes keeps
  // chrome continuously hidden through the swap.
  _closePostAcceptPanel({ skipExitToExplore: true, skipBodyClassRemoval: true });
  // 320 ms gap so the confirm panel finishes its slide-down before
  // the accept panel slides up. Sequential by request — user: 'It
  // should slide up after confirm panel close.'
  //
  // Class swap order matters: ADD plan-preview-active BEFORE removing
  // post-accept-active so the chrome-hide rules are never momentarily
  // absent (both classes apply the same hide rules; with neither set,
  // the chrome's 0.25 s opacity transition would fire and the venue
  // list / search bar would flash in mid-swap). User reported this
  // exact flash before the fix.
  setTimeout(() => {
    document.body.classList.add('plan-preview-active');
    document.body.classList.remove('post-accept-active');
    try { openPlanPreview(inviteOpts); } catch (e) { /* ignore */ }
  }, 320);
}
if (typeof window !== 'undefined') {
  window._reopenInviteFromAccept = _reopenInviteFromAccept;
}

// ── Instant check-in toggle ──────────────────────────────────────────────────

/** Tap "Jeg er her" → instant check-in (or check-out if already here). */
async function _toggleCheckin(venueId) {
  if (typeof authCurrentUser === 'function' && !authCurrentUser()) {
    if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
    return;
  }
  const myCheckin = typeof getMyCheckin === 'function' ? getMyCheckin() : null;
  const isHere = myCheckin && String(myCheckin.venue_id) === String(venueId);
  if (isHere) {
    await checkOut();
  } else {
    await checkIn(venueId, '');
  }
}

// ── Invite sheet (half-screen overlay) ───────────────────────────────────────

/** Format a date string + hour into a readable date label like "søn 27. apr". */
function _fmtInviteDate(dateStr) {
  const lang = typeof prefLang === 'function' ? prefLang() : 'no';
  const locale = { en: 'en-GB', no: 'nb-NO', se: 'sv-SE', dk: 'da-DK' }[lang] || 'nb-NO';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Smart-relative "when" label for the share message body. Examples:
 *    today           → "i dag kl. 18:00"
 *    tomorrow        → "i morgen kl. 18:00"
 *    within 7 days   → "på lørdag kl. 18:00"
 *    further out     → "lørdag 4. mai kl. 18:00"
 *  Receivers shouldn't have to infer what day a meeting is for — without this
 *  the message read "Skal til X kl. 18:00" which is ambiguous if read the day
 *  after it was sent. */
function _inviteWhenLabel(dateStr, hour) {
  if (!dateStr) return '';
  const lang = typeof prefLang === 'function' ? prefLang() : 'no';
  const locale = { en: 'en-GB', no: 'nb-NO', se: 'sv-SE', dk: 'da-DK' }[lang] || 'nb-NO';
  const timeLabel = (typeof formatHour === 'function') ? formatHour(hour) : '';

  const today = (typeof todayStr === 'function') ? todayStr() : new Date().toISOString().slice(0, 10);
  const tom = new Date(); tom.setDate(tom.getDate() + 1);
  const pad = n => String(n).padStart(2, '0');
  const tomStr = `${tom.getFullYear()}-${pad(tom.getMonth() + 1)}-${pad(tom.getDate())}`;

  if (dateStr === today)  return t('share_when_today',    { time: timeLabel });
  if (dateStr === tomStr) return t('share_when_tomorrow', { time: timeLabel });

  const d = new Date(dateStr + 'T12:00:00');
  const todayMs = new Date(today + 'T12:00:00').getTime();
  const daysOut = Math.round((d.getTime() - todayMs) / (24 * 60 * 60 * 1000));

  // Within the next 7 days — use just the weekday (e.g. "på lørdag")
  if (daysOut > 0 && daysOut <= 7) {
    const weekday = d.toLocaleDateString(locale, { weekday: 'long' });
    return t('share_when_weekday', { day: weekday, time: timeLabel });
  }
  // Further out — full weekday + day + month
  const weekday = d.toLocaleDateString(locale, { weekday: 'long' });
  const dayNum = d.getDate();
  const month = d.toLocaleDateString(locale, { month: 'short' }).replace(/\.$/, '');
  return t('share_when_explicit', { day: weekday, date: `${dayNum}. ${month}`, time: timeLabel });
}

/** Build the confirmation sentence for the invite. */
function _fmtInviteConfirm(venueName, dateStr, hour) {
  const dateLabel = _fmtInviteDate(dateStr);
  const timeLabel = typeof formatHour === 'function' ? formatHour(hour) : `${Math.floor(hour)}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`;
  return t('invite_confirm', { venue: venueName, date: dateLabel, time: timeLabel });
}

/** Open the invite sheet — full-height takeover with venue card, chat-bubble
 *  preview and avatar-tap friend selection. The "now" semantics ("I'm at X
 *  now — come join", pin-presence flip on send) are driven by the time
 *  picker itself: when the chosen time is within ±30 min of real-now,
 *  _isNowSend returns true and the send path swaps message + checks in. */
function _openInviteSheet(venueId) {
  if (typeof authCurrentUser === 'function' && !authCurrentUser()) {
    // Stash intent so _restorePreAuthState can reopen the invite sheet
    // on the same venue after the user signs in. Without this the user
    // gets bounced back to today / now and has to redo the whole
    // date-time-venue flow before they can tap 'Invite friends' again.
    if (typeof window !== 'undefined') {
      window._postLoginIntent = { type: 'invite_sheet', venueId };
    }
    if (typeof toggleProfilePanel === 'function') toggleProfilePanel();
    return;
  }
  // Toggle off if already open
  const existing = document.getElementById('invite-sheet');
  if (existing) { _closeInviteSheet(); return; }

  const v = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === venueId) : null;
  const venueName = v ? v.name : '';

  const friends = typeof _friends !== 'undefined' ? _friends : [];
  const hasFriends = friends.length > 0;

  // Stable color index (0–7) hashed from friend id so the initials-circle
  // palette feels intentional — two "E"s won't collide and the same friend
  // keeps their color across reloads.
  const _hashColor = (s) => {
    s = String(s || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 8;
  };

  // Read current time from the main pickers — these stay the source of truth
  // while the sheet is open, so we don't duplicate controls inside the sheet.
  const curDate = typeof datePicker !== 'undefined' ? datePicker.value : new Date().toISOString().slice(0, 10);
  const curHour = typeof timeFromEl !== 'undefined' ? parseFloat(timeFromEl.value) : new Date().getHours();

  // Inline SVG icon set used across the sheet.
  const pinSvg     = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  const linkSvg    = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`;
  const checkSvgSm = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

  // Friend ids ordered by recent invite history. If there's no history, fall
  // back to the first 4 friends in the canonical list.
  const recentIds = (typeof _recentInvitedFriendIds === 'function')
    ? _recentInvitedFriendIds(friends).slice(0, 4)
    : friends.slice(0, 4).map(f => String(f.id));
  const recentSet = new Set(recentIds.map(String));


  const avatarsHtml   = _renderInviteAvatarCarousel(friends, _hashColor, checkSvgSm);

  // Build overlay + sheet (IDs preserved for legacy close path).
  const overlay = document.createElement('div');
  overlay.id = 'invite-sheet-backdrop';
  overlay.className = 'dpinvite-backdrop';
  overlay.onclick = e => { if (e.target === overlay) _closeInviteSheet(); };

  const sheet = document.createElement('div');
  sheet.id = 'invite-sheet';
  sheet.className = 'dpinvite-sheet';

  // Friends body — the avatar row (hasFriends) or the empty-state card. The
  // empty state now carries a direct "Legg til venn" CTA (opens the friends
  // modal, the in-app add-by-email / share-link flow) so there's a quick path
  // to build the friend list, with the share-targets row below as the "or share
  // a link to anyone" alternative (see the "eller" divider, now shown in both
  // states). The "Send til" label is split out into sendLabel (hasFriends only).
  const userPlusSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/></svg>`;
  const addFriendCta = `<button type="button" class="p-pill dpinvite-empty-cta" onclick="openFriendsModal()">${userPlusSvg}<span>${t('add_friend')}</span></button>`;
  const friendsBlock = hasFriends ? `
        <div class="dpinvite-avatar-row no-scrollbar" id="dpinvite-avatar-row">
          ${avatarsHtml}
        </div>` : (typeof emptyState === 'function'
        ? emptyState({ glyph: 'user-plus', title: t('invite_no_friends_title'), sub: t('invite_no_friends_sub'), ink: true, ctaHtml: addFriendCta })
        : `
        <div class="dpinvite-empty-card">
          <div class="dpinvite-empty-title">${t('invite_no_friends_title')}</div>
          <div class="dpinvite-empty-sub">${t('invite_no_friends_sub')}</div>
          <div class="es-cta-slot">${addFriendCta}</div>
        </div>`);

  // Share page (IG share-sheet pattern): friend avatars on top, a row of
  // share-target circles along the bottom, and a honey Send button that
  // OVERLAPS the targets row once 1+ friends are picked. _refreshInvitePrimaryCTA
  // toggles the overlap (.has-selection) + the Send label from selection count.
  // Send paper-plane glyph for the morphing primary CTA. (The copy / share
  // marks now live inline in the share-targets row below at circle scale.)
  const sendSvg  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`;
  // Two-step flow inside ONE sheet (Instagram-style), via an in-place
  // horizontal slide pager (.dpinvite-pager clips, .dpinvite-track slides).
  // Page 1 (WHEN) picks the moment + FTS; "Neste" slides to page 2 (WHO/SHARE)
  // and LOCKS the date (disables the day picker). Page 2 has friend avatars
  // (in-app send) + Kopier lenke / Del til andre apper + a "Tilbake" link that
  // slides back + re-enables the day picker.
  const chevronRightSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  const chevronLeftSvg  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;

  // Two-column header — mirrors the accept page so sender and receiver
  // see the same shape. Left = WHAT (eyebrow + venue + meta); right =
  // WHEN (Meeting label + live time + live day) which updates as the
  // user scrubs the FTS inside the sheet.
  // 4 metas — area · category · distance · walk-time. Same shape as the
  // accept page; sender and receiver read the same row. _dprcvWalkInfo
  // is exposed from ui-plan-preview.js (assigned to window) so we can
  // reuse the same haversine + walk-pace calc instead of duplicating it.
  const dispArea = _dedupeAreaForVenue(venueName, v?.area);
  const _catLabel = (typeof catLabel === 'function') ? catLabel(v) : null;
  const _walkInfo = (typeof window !== 'undefined' && typeof window._dprcvWalkInfo === 'function')
    ? window._dprcvWalkInfo(v) : null;
  const _walkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/></svg>`;
  // Each pill is wrapped in `.dpinvite-meta-item` so _fitMetaPills can
  // drop whole trailing pills + their preceding dot when the row
  // overflows instead of clipping mid-text.
  // Area moves to its own line (.dpinvite-area) to mirror the accept/receive
  // header; the meta row is category · distance · walk only.
  const _invMetaItems = [
    _catLabel ? `<span class="dpinvite-meta-item">${String(_catLabel).replace(/</g, '&lt;')}</span>` : '',
    _walkInfo && _walkInfo.distLabel
      ? `<span class="dpinvite-meta-item">${String(_walkInfo.distLabel).replace(/</g, '&lt;')}</span>` : '',
    _walkInfo && _walkInfo.walkMin != null
      ? `<span class="dpinvite-meta-item dpinvite-meta-walk">${_walkSvg}<span>${_walkInfo.walkMin} min</span></span>` : '',
  ].filter(Boolean);
  const _invMetaHtml = _invMetaItems.length
    ? _invMetaItems.join('<span class="dpinvite-meta-dot" aria-hidden="true">·</span>')
    : '';
  const momentBlock = `
        <div class="dpinvite-moment">
          <div class="dpinvite-moment-row">
            <div class="dpinvite-moment-left">
              <div class="dpinvite-eyebrow">${t('invite_eyebrow_invite_to')}</div>
              <div class="dpinvite-venue-row">
                <span class="dpinvite-venue-line">${venueName}</span>
              </div>
              ${dispArea ? `<div class="dpinvite-area">${String(dispArea).replace(/</g, '&lt;')}</div>` : '<div class="dpinvite-area">&nbsp;</div>'}
              ${_invMetaHtml ? `<div class="dpinvite-meta">${_invMetaHtml}</div>` : '<div class="dpinvite-meta">&nbsp;</div>'}
            </div>
            <div class="dpinvite-moment-col">
              <div class="dpinvite-moment-label" id="dpinvite-moment-label">${t('invite_hero_meets')}</div>
              <div class="dpinvite-moment-time" id="dpinvite-moment-time"></div>
              <button type="button" class="dpinvite-moment-sub" id="dpinvite-moment-sub"
                      aria-label="${t('invite_eyebrow_select_time')}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
                <span id="dpinvite-moment-sub-text"></span>
              </button>
            </div>
          </div>
        </div>`;

  // Sheet body order:
  //   1. Moment block (venue + live Meeting tile + day picker) — STAYS visible
  //      across both pager pages, above the divider.
  //   2. Horizontal pager — a clip (.dpinvite-pager) wrapping a sliding track
  //      (.dpinvite-track) with two pages side by side:
  //        Page 1 "when":  "Velg tidspunkt" label + FTS slot + "Neste" CTA.
  //        Page 2 "share": "Send til" label + avatar carousel + Send CTA +
  //                        Kopier lenke · Del til andre apper + "Tilbake".
  //      The FTS lives in page 1; when the user advances to page 2 the page
  //      slides out of view (time effectively locked) and the day picker is
  //      disabled (date locked). The header keeps showing the chosen moment.
  const whenPage = `
        <div class="dpinvite-page dpinvite-page-when" data-page="when">
          <div class="dpinvite-when-slot">
            <div class="dpinvite-friends-label">${t('invite_eyebrow_select_time')}</div>
            <div class="dpinvite-fts-slot" id="dpinvite-fts-slot" aria-hidden="false"></div>
          </div>
          <div class="dpinvite-rule" aria-hidden="true"></div>
          <div class="dpinvite-foot">
            <div class="dpinvite-cta-row">
              <button class="p-pill" type="button" onclick="_dpinviteGoToShare(${venueId})">
                <span>${t('invite_next')}</span>
                ${chevronRightSvg}
              </button>
            </div>
            <div class="dprcv-cta-row">
              <button class="dprcv-cta-link" type="button" onclick="_closeInviteSheet()"><span>${t('invite_cancel')}</span></button>
            </div>
          </div>
        </div>`;
  // WhatsApp glyph — single-path Lucide-register mark (phone + speech bubble
  // tail). Outline, stroke 2, currentColor so it inherits --glassctl-icon like
  // the copy/share marks. Subset copied in (no runtime icon dependency).
  const whatsappSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/></svg>`;
  // Larger glyphs for the 48 px share-target circles (the inline copy/share
  // SVGs above are 18px, sized for the old text-link row — at circle scale
  // they read small). Rebuilt at 22px to match the WhatsApp + top-bar icons.
  const copyTargetSvg  = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const shareTargetSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98"/><path d="m15.41 6.51-6.82 3.98"/></svg>`;
  // Share-targets row — IG-style labelled circles. FIXED set (web/Capacitor
  // can't enumerate installed apps): Copy link · More apps (OS share sheet) ·
  // WhatsApp (wa.me deep-link). These are tertiary glass-control circles; the
  // single honey CTA (Send) overlays this row when 1+ friends are picked.
  const targetsRow = `
          <div class="dpinvite-targets-row" id="dpinvite-targets-row">
            <button type="button" class="dpinvite-target" onclick="_copyInviteLink(${venueId})" aria-label="${t('copy_invite_link')}">
              <span class="dpinvite-target-circle">${copyTargetSvg}</span>
              <span class="dpinvite-target-label">${t('invite_target_copy')}</span>
            </button>
            <button type="button" class="dpinvite-target" onclick="_shareInviteLink(${venueId})" aria-label="${t('invite_other_apps')}">
              <span class="dpinvite-target-circle">${shareTargetSvg}</span>
              <span class="dpinvite-target-label">${t('invite_target_share')}</span>
            </button>
            <button type="button" class="dpinvite-target" onclick="_shareInviteWhatsApp(${venueId})" aria-label="${t('invite_via_whatsapp')}">
              <span class="dpinvite-target-circle">${whatsappSvg}</span>
              <span class="dpinvite-target-label">${t('invite_via_whatsapp')}</span>
            </button>
          </div>`;
  // Bottom slot — the targets row and the honey Send button occupy the SAME
  // box. Default: targets visible, Send overlay hidden (.has-selection toggles
  // it). The Send overlay is absolutely positioned over the row so it fades /
  // slides in OVER the targets (IG pattern), and reflows nothing when it
  // appears. _refreshInvitePrimaryCTA flips .has-selection on this slot.
  // No bottom slot at all in the empty (no-friends) state — there's nobody to
  // send to, so the targets row IS the path forward and stands alone.
  const bottomSlot = hasFriends ? `
          <div class="dpinvite-share-bottom" id="dpinvite-share-bottom">
            ${targetsRow}
            <div class="dpinvite-send-overlay" id="dpinvite-send-overlay" aria-hidden="true">
              <button class="p-pill" id="invite-primary-btn" data-mode="send" disabled
                      onclick="_invitePrimaryClick(${venueId})">
                <span id="invite-primary-icon">${sendSvg}</span>
                <span id="invite-primary-label">${t('invite_send_pick')}</span>
              </button>
            </div>
          </div>` : targetsRow;
  // Back lives in the persistent header's row 3 (the date-picker slot). On the
  // share step that slot keeps showing the day but acts as back (chevron flips
  // right), so tapping it returns to the time step to change the moment. See
  // _dpinviteGoToShare / _dpinviteGoToWhen (they toggle .is-back on
  // #dpinvite-moment-sub) and the click handler's step branch. Nothing here.
  // "Send til" — a centred section label, structurally identical to the "eller"
  // divider below so both sit on the same axis with the same gap to their row.
  const sendLabel = hasFriends ? `
          <div class="dpinvite-friends-label">${t('invite_friends_label')}</div>` : '';
  // "eller" divider — forks the in-app path (send to friends / add a friend,
  // above) from the external share targets (below). Shown in both states:
  // populated = avatars · eller · targets; empty = add-friend CTA · eller · targets.
  const orDivider = `
          <div class="dpinvite-or">${t('invite_or')}</div>`;
  const sharePage = `
        <div class="dpinvite-page dpinvite-page-share" data-page="share" aria-hidden="true">
          ${sendLabel}
          ${friendsBlock}
          ${orDivider}
          ${bottomSlot}
        </div>`;
  sheet.innerHTML = `
    <div class="dpinvite-handle" id="dpinvite-handle" aria-label="${t('close') || 'Close'}">
      <div class="dpinvite-grabber" aria-hidden="true"></div>
    </div>
    <div class="dpinvite-body">
      ${momentBlock}
      <div class="dpinvite-pager" id="dpinvite-pager">
        <div class="dpinvite-track" id="dpinvite-track">
          ${whenPage}
          ${sharePage}
        </div>
      </div>
    </div>`;

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  // Whole-pill drop on overflow for the meta row (same pattern as the
  // accept page). Runs after the sheet is in the DOM so we have real
  // widths. ResizeObserver keeps it in sync if the sheet width changes.
  requestAnimationFrame(() => {
    const metaEl = sheet.querySelector('.dpinvite-meta');
    if (metaEl && typeof window._fitMetaPills === 'function') {
      window._fitMetaPills(metaEl);
    }
  });
  if (typeof ResizeObserver !== 'undefined') {
    const metaEl = sheet.querySelector('.dpinvite-meta');
    if (metaEl) {
      const ro = new ResizeObserver(() => {
        if (typeof window._fitMetaPills === 'function') window._fitMetaPills(metaEl);
      });
      ro.observe(sheet);
      sheet._metaResizeObs = ro;
    }
  }

  // Wire the day-button programmatically. Inline onclick attributes have
  // intermittent mobile-Safari reliability (see app.js:349 — same pattern
  // applied to the header date chip). pointerup runs before click and
  // dodges the rare touch-cancel that swallows click events when the
  // sheet's drag-to-dismiss handler is also listening. Sheet slides down
  // via the body.cal-open CSS rule so the calendar isn't covered.
  const _daySubBtn = sheet.querySelector('#dpinvite-moment-sub');
  if (_daySubBtn) {
    _daySubBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // On the share step this slot is the "‹ Endre" back affordance — tapping
      // it returns to the time step. On the time step it's the day picker.
      if (sheet._inviteStep === 'share') { _dpinviteGoToWhen(); return; }
      if (typeof toggleQcPanel === 'function') toggleQcPanel('date');
    });
  }

  sheet._venueName = venueName;
  sheet._venueId = venueId;
  sheet._venue = v;
  sheet._friendCount = friends.length;
  sheet._activeGroup = 'recent';
  sheet._recentSet   = recentSet;

  // Apply initial group filter so the carousel matches the active chip.
  _dpinviteApplyGroupFilter('recent');
  _refreshInvitePrimaryCTA();

  // Pager starts on the "when" page (date editable). _dpinviteSyncPagerHeight
  // sizes the clip container to the active page so the off-screen page never
  // inflates the sheet (the two pages have different heights).
  sheet._inviteStep = 'when';
  requestAnimationFrame(() => _dpinviteSyncPagerHeight(sheet, true));

  // Drag-to-dismiss — attached to the whole sheet (Vaul/Radix pattern), not
  // just the handle. Bails on interactive children (avatars, buttons, links)
  // and when the user is scrolling content inside the sheet. The handle
  // keeps its tap-to-close behavior.
  const _handleEl = sheet.querySelector('#dpinvite-handle');
  {
    let _dStartY = null, _dStartT = null, _dragging = false, _moved = false;
    const THRESHOLD_PX = 100;
    const FLICK_VELOCITY = 0.6;
    const MOVE_TRIGGER_PX = 4;
    // FTS lives INSIDE the sheet now — its thumb / track / popup are
    // pointerdown targets the user touches while picking the meet time.
    // Without #fts in the exempt list, dragging the thumb also drags the
    // sheet downward (the sheet's drag-to-dismiss handler hijacks the
    // pointer move). The .dpinvite-fts-slot wraps the relocated FTS so
    // a single selector covers all interior elements.
    const INTERACTIVE_SEL = 'button, input, textarea, select, a, [role="button"], [data-no-drag], .dpinvite-avatar, .dpinvite-friend, #fts, .dpinvite-fts-slot';
    const isInteractive = (el) => !!(el && el.closest && el.closest(INTERACTIVE_SEL));
    const onStart = (e) => {
      // Don't hijack taps on actionable elements (Del lenke, Avbryt, avatars).
      if (isInteractive(e.target)) return;
      // Don't fight native scroll if the sheet has scrolled content.
      if (sheet.scrollTop > 0) return;
      const t = e.touches ? e.touches[0] : e;
      _dStartY = t.clientY;
      _dStartT = performance.now();
      _dragging = true;
      _moved = false;
      sheet.style.transition = 'none';
    };
    const onMove = (e) => {
      if (!_dragging || _dStartY == null) return;
      const t = e.touches ? e.touches[0] : e;
      const dy = t.clientY - _dStartY;
      // Only translate downward; upward gestures let native scroll take over.
      if (dy <= 0) return;
      if (dy > MOVE_TRIGGER_PX) {
        _moved = true;
        if (_handleEl) _handleEl.dataset.dragging = '1';
      }
      sheet.style.transform = `translateY(${dy}px)`;
      if (e.cancelable) e.preventDefault();
    };
    const onEnd = (e) => {
      if (!_dragging || _dStartY == null) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      const dy = Math.max(0, t.clientY - _dStartY);
      const dt = Math.max(1, performance.now() - _dStartT);
      const velocity = dy / dt;
      sheet.style.transition = '';
      sheet.style.transform = '';
      _dragging = false;
      _dStartY = null;
      if (dy > THRESHOLD_PX || velocity > FLICK_VELOCITY) {
        _closeInviteSheet();
        return;
      }
      if (_moved && _handleEl) requestAnimationFrame(() => { delete _handleEl.dataset.dragging; });
    };
    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd, { passive: true });
    sheet.addEventListener('touchcancel', onEnd, { passive: true });
    sheet.addEventListener('mousedown', (e) => {
      if (isInteractive(e.target)) return;
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
    // Tap on the handle still closes the sheet — explicit discoverability
    // for users who don't intuit the swipe gesture.
    if (_handleEl) {
      _handleEl.addEventListener('click', () => {
        if (_handleEl.dataset.dragging === '1') return;
        _closeInviteSheet();
      });
    }
  }

  // Track sheet height in --dpinvite-sheet-h so the FTS rule can sit just
  // above the sheet edge (CSS rule body.invite-sheet-open #fts).
  const _writeSheetH = () => {
    document.documentElement.style.setProperty('--dpinvite-sheet-h', sheet.offsetHeight + 'px');
  };
  let _sheetRO = null;
  let _pagerRO = null;
  if (typeof ResizeObserver !== 'undefined') {
    _sheetRO = new ResizeObserver(_writeSheetH);
    _sheetRO.observe(sheet);
    // Re-sync the pager clip when EITHER page's content reflows (FTS popup
    // appearing during a drag, avatar selection rings, friend-list height).
    // The pager height follows the active page; observing both pages keeps it
    // accurate without depending on which one is showing.
    _pagerRO = new ResizeObserver(() => _dpinviteSyncPagerHeight(sheet));
    sheet.querySelectorAll('.dpinvite-page').forEach(p => _pagerRO.observe(p));
  }
  requestAnimationFrame(_writeSheetH);

  function _updateInviteConfirm() {
    const d = (typeof datePicker !== 'undefined') ? datePicker.value : curDate;
    const h = (typeof timeFromEl !== 'undefined') ? parseFloat(timeFromEl.value) : curHour;
    if (typeof _updateInviteHeader === 'function') _updateInviteHeader(v, d, h);
  }
  const onTimeInput = () => _updateInviteConfirm();
  const onDateChange = () => _updateInviteConfirm();
  if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.addEventListener('input', onTimeInput);
  if (typeof datePicker !== 'undefined' && datePicker) datePicker.addEventListener('change', onDateChange);
  // Recompute callout position when the FTS chrome itself resizes (orientation
  // changes, address-bar collapse). The thumb's viewport x depends on the
  // canvas's bounding rect, which moves with the FTS bottom (which moves
  // with --dpinvite-sheet-h, which the ResizeObserver already tracks).
  const onResize = () => _updateInviteConfirm();
  window.addEventListener('resize', onResize, { passive: true });
  // Esc to close — backdrop tap and drag grabber are the other dismissal paths.
  const onEsc = (e) => { if (e.key === 'Escape') _closeInviteSheet(); };
  document.addEventListener('keydown', onEsc);
  sheet._sliderCleanup = () => {
    if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.removeEventListener('input', onTimeInput);
    if (typeof datePicker !== 'undefined' && datePicker) datePicker.removeEventListener('change', onDateChange);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onEsc);
    if (_sheetRO) _sheetRO.disconnect();
    if (_pagerRO) _pagerRO.disconnect();
    document.documentElement.style.removeProperty('--dpinvite-sheet-h');
  };

  // Initial paint — wait one frame so layout is computed before we read
  // the FTS canvas's bounding rect.
  requestAnimationFrame(_updateInviteConfirm);

  // Eager plan-create — fires now (while we still have user activation context)
  // so the synchronous _shareInviteLink below can read sheet._planId without
  // awaiting anything between the user's click and navigator.share().
  sheet._planId = null;
  sheet._shortUrl = null;
  sheet._shortUrlKey = null;
  let shortenTimer = null;
  let inFlightShortenKey = null;

  // Eager shortener — generates a /s/<id> URL for the current token via KV.
  // Triggered when plan-create lands AND on each time/date change (debounced)
  // so the cached short URL stays in sync with what the message preview shows.
  // Falls back gracefully — if shortening fails the share path uses the long
  // URL synchronously, never blocks the user.
  function _eagerShortenUrl() {
    clearTimeout(shortenTimer);
    shortenTimer = setTimeout(async () => {
      if (document.getElementById('invite-sheet') !== sheet) return;
      const user = (typeof authCurrentUser === 'function') ? authCurrentUser() : null;
      if (!user) return;
      const d = (typeof datePicker !== 'undefined') ? datePicker.value : curDate;
      const h = (typeof timeFromEl !== 'undefined') ? parseFloat(timeFromEl.value) : curHour;
      const [hh, mm] = _hhmmFromHour(h);
      const timeVal = `${d}T${hh}:${mm}`;
      const tokenData = { u: user.id, v: venueId, t: timeVal };
      if (sheet._planId) tokenData.p = sheet._planId;
      const token = btoa(JSON.stringify(tokenData));
      const key = `${token}`;
      if (key === sheet._shortUrlKey || key === inFlightShortenKey) return;
      inFlightShortenKey = key;
      try {
        const res = await fetch('/api/shorten', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.id && document.getElementById('invite-sheet') === sheet) {
          sheet._shortUrl = `${location.origin}/s/${data.id}`;
          sheet._shortUrlKey = key;
        }
      } catch (e) { /* graceful — fallback to long URL on share */ }
      finally {
        if (inFlightShortenKey === key) inFlightShortenKey = null;
      }
    }, 400);
  }

  // Kick off the URL shortener immediately. The share-link's token carries
  // {u, v, t} (and optionally plan_id when one exists); when no plan
  // exists yet the recipient lands on a "join at this venue/time" preview
  // that resolves to a real plan + invite at accept-time.
  //
  // Previously this block eagerly INSERTed an empty placeholder plan (no
  // venue_name, no invitees) just to get a plan_id for the token.
  // createPlan() then INSERTed a SECOND plan with the full payload,
  // leaving the placeholder orphaned. A few test runs accumulated ~10
  // orphans in public.plans and pg_cron's plan-reminders job fired
  // "Planen din på et sted starter om 30 min" for every one (et sted =
  // COALESCE fallback when venue_name IS NULL). createPlan is now the
  // sole plan-insert path; sheet._planId stays null until then.
  _eagerShortenUrl();

  // Re-shorten on time/date change so the cached short URL matches the
  // current pickers (otherwise the receiver would land on a stale time).
  const _origOnTimeInput = onTimeInput;
  const _origOnDateChange = onDateChange;
  const _shortenOnChange = () => _eagerShortenUrl();
  if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.addEventListener('input', _shortenOnChange);
  if (typeof datePicker !== 'undefined' && datePicker) datePicker.addEventListener('change', _shortenOnChange);
  const _origCleanup = sheet._sliderCleanup;
  sheet._sliderCleanup = () => {
    if (_origCleanup) _origCleanup();
    clearTimeout(shortenTimer);
    if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.removeEventListener('input', _shortenOnChange);
    if (typeof datePicker !== 'undefined' && datePicker) datePicker.removeEventListener('change', _shortenOnChange);
  };

  // Reparent the FTS INTO the sheet so the scrubber lives next to the
  // moment tile it drives. Was: body-anchored with a fixed-position CSS
  // rule floating above the sheet (`body.invite-sheet-open #fts`). New:
  // FTS slot inside the sheet body, FTS appended into it, normal flow
  // positioning takes over via the `fts-in-invite` class. Restored to
  // <body> on close in _invFtsDetach.
  const _ftsForReparent = document.getElementById('fts');
  const _ftsSlot = sheet.querySelector('#dpinvite-fts-slot');
  if (_ftsForReparent) {
    if (_ftsForReparent.classList.contains('fts-in-card')) _ftsForReparent.classList.remove('fts-in-card');
    if (_ftsForReparent.classList.contains('fts-in-preview')) _ftsForReparent.classList.remove('fts-in-preview');
    _ftsForReparent.style.cssText = '';
    _ftsForReparent.classList.add('fts-in-invite');
    if (_ftsSlot) {
      if (_ftsForReparent.parentNode !== _ftsSlot) _ftsSlot.appendChild(_ftsForReparent);
    } else if (_ftsForReparent.parentNode !== document.body) {
      document.body.appendChild(_ftsForReparent);
    }
  }
  // The FTS just landed in the when-page slot (which was display:none while
  // empty), growing the page. Re-size the pager instantly so the sheet opens
  // at the correct height instead of growing into it after the first frame.
  // Also force a direct FTS repaint: the canvas just changed width (card slot →
  // invite slot), but the invite sheet opens FROM the detail panel, so
  // `body.panel-transitioning` is set and the FTS ResizeObserver SKIPS its
  // redraw during exactly this window — leaving a stale/blank bitmap until the
  // flag clears. drawFtsCanvas() has no such guard, so calling it directly here
  // (after a frame, so clientWidth is the new slot width) paints it correctly.
  requestAnimationFrame(() => {
    _dpinviteSyncPagerHeight(sheet, true);
    if (typeof drawFtsCanvas === 'function') drawFtsCanvas();
  });

  document.body.classList.add('invite-sheet-open');
  // Stash the venue id so _closeInviteSheet's recovery path knows which
  // venue to return to if the underlying detail panel was somehow torn
  // down during the sheet's lifetime (the "close → empty map" regression).
  if (typeof window !== 'undefined') window._inviteSheetVenueId = venueId;

  // Show the SENDER's own avatar pin on the map while the invite sheet
  // is being composed. Mirrors the accept-page _invitePin pattern (and
  // the _friendsPin pattern app.js uses for plans with friends going)
  // so the user has a visual "you're going to be here" anchor on the
  // map even before they've sent the invite or copied the link. Cleared
  // in _closeInviteSheet; _updateFriendsCanvasPin restores the real
  // attendee state if a plan was actually created.
  if (typeof window !== 'undefined' && typeof authCurrentUser === 'function') {
    const me = authCurrentUser();
    if (me) {
      const rawName = (me.user_metadata && me.user_metadata.name)
        || (me.email ? me.email.split('@')[0] : '')
        || 'Du';
      window._friendsPin = {
        venueId: venueId,
        meetHour: curHour,
        attendees: [{
          id: me.id || null,
          name: String(rawName).split(' ')[0],
          offsetMin: 0,
        }],
        declined: [],
      };
      if (typeof window.markPinLayoutStale === 'function') window.markPinLayoutStale();
      if (typeof draw === 'function') draw();
    }
  }

  // Pan the map so the venue lands centred between the floating top card and
  // the sheet. Use the proper zoom + pitch (matches panToVenueCenter) so the
  // building is actually visible — the previous attempt only set padding,
  // which left the user looking at zoom-13 city level. The padding shifts the
  // logical centre downward by half (top-card height) and upward by half
  // (sheet height) so the venue sits in the visible mid-strip.
  // Centre the venue in the visible map strip above the sheet. Mapbox
  // padding shifts the camera's logical centre — passing the height of
  // the chrome that occludes the map (sheet + FTS slider flush above
  // it) puts the venue in the middle of the *visible* area. Top
  // padding is just a safe-area inset since the v1 floating top-card
  // is gone and the map now extends to the top of the screen.
  if (typeof map !== 'undefined' && map && typeof map.easeTo === 'function' && v) {
    requestAnimationFrame(() => {
      const padTop    = 24;
      const ftsChrome = 38;
      const padBottom = (sheet.offsetHeight || 320) + ftsChrome;
      sheet._mapPadOpen = { top: padTop, bottom: padBottom, left: 0, right: 0 };
      map.easeTo({
        center:   [v.lng, v.lat],
        // Was 17.5 — user pulled the detail/invite/accept zoom back to
        // 16.75 across the board so the venue stays in context.
        zoom:     16.75,
        pitch:    45,
        padding:  sheet._mapPadOpen,
        duration: 480,
      });
    });
  }

  // Animate in — backdrop fades, sheet slides up. (v1 also had a top
  // card to slide down; gone now.)
  // Force a synchronous layout pass so the browser commits the initial
  // translateY(100%) state before the .open class flips it to 0. Without
  // this, mounting + class-add in the same task lets the browser collapse
  // both into the final state and skip the transition — the user sees the
  // sheet flash in place. User: 'The invite panel seems to first show up,
  // then start a slide up animation'.
  // eslint-disable-next-line no-unused-expressions
  sheet.offsetHeight;
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    sheet.classList.add('open');
  });
}

/** Wire a card-timeline-canvas to drag-scrub timeFromEl. Drag math mirrors
 *  the body-level FTS — clientX → minH..maxH range. The 'input' event
 *  dispatched on timeFromEl propagates to all listeners (weather,
 *  notifications, our own _updateInviteConfirm), which re-fires
 *  drawAllCardTimelines to repaint.
 *
 *  opts.minH / opts.maxH override the default global FTS range. The
 *  accept-page bar uses planHour..sundownH (a narrow slice of the day)
 *  so without overrides, a click at x=50% of the visible bar would set
 *  timeFromEl to ~13:30 — well outside the bar's range — and the
 *  scrubber pill would clamp to the bar's left edge. Same canvas
 *  drag handler, different mapping. */
function _wireInlineFtsCanvas(canvas, opts) {
  if (!canvas || canvas._dpInlineFtsWired) return;
  canvas._dpInlineFtsWired = true;
  const minH = (opts && Number.isFinite(opts.minH)) ? opts.minH
             : (typeof MIN_H_ARC === 'number') ? MIN_H_ARC : 4;
  const maxH = (opts && Number.isFinite(opts.maxH)) ? opts.maxH
             : (typeof MAX_H_ARC === 'number') ? MAX_H_ARC : 23;
  const range = Math.max(0.0001, maxH - minH);
  const setHourFromX = (clientX) => {
    if (typeof timeFromEl === 'undefined' || !timeFromEl) return;
    const rect = canvas.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    timeFromEl.value = minH + pct * range;
    timeFromEl.dispatchEvent(new Event('input', { bubbles: true }));
  };
  let dragging = false;
  const onDown = (e) => {
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    setHourFromX(e.clientX);
    e.preventDefault();
  };
  const onMove = (e) => { if (dragging) setHourFromX(e.clientX); };
  const onUp = (e) => {
    dragging = false;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch (_) { /* ignore */ }
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
}
if (typeof window !== 'undefined') window._wireInlineFtsCanvas = _wireInlineFtsCanvas;

/** Wire a hidden timeline scrubber (the `.dprcv-timeline-scrubber` pill + an
 *  FTS-style bubble) to the global time (timeFromEl). Shared by the detail-panel
 *  card timeline and the accept-panel timeline so both behave identically:
 *
 *    - The bubble + pill are hidden until the user taps the bar (onCanvasDown
 *      is the ONLY place .is-active is added, so synthetic 'input' events
 *      from elsewhere can't surface it).
 *    - While scrubbing, the pill tracks the current hour and the bubble shows
 *      time + weather glyph + temp + wind for that hour.
 *    - The bubble auto-hides ~2.5 s after the last input.
 *    - An outside-the-timeline pointerdown dismisses it immediately.
 *    - On release the arrival snaps to a 15-min grid (the FTS spring-to-grid).
 *
 *  The canvas itself is made draggable separately (via _wireInlineFtsCanvas),
 *  whose dispatched timeFromEl 'input' events drive `update` here.
 *
 *  opts: { scrubberEl, timelineEl, canvas, venue, dateStr, minH, maxH,
 *          chainCleanupOn }
 *  chainCleanupOn (optional) — an element whose `_cleanup` chain the listener
 *  teardown should be appended to (the accept panel passes its overlay el so
 *  closePlanPreview drops everything). When omitted (the detail panel, whose
 *  timeline DOM persists for the life of the open panel), teardown is stashed
 *  on scrubberEl._scrubberCleanup and the listeners simply live with the node. */
function _wireTimelineScrubber(opts) {
  const { scrubberEl, timelineEl, canvas, venue, dateStr } = opts || {};
  const minH = (opts && Number.isFinite(opts.minH)) ? opts.minH
             : (typeof MIN_H_ARC === 'number') ? MIN_H_ARC : 4;
  const maxH = (opts && Number.isFinite(opts.maxH)) ? opts.maxH
             : (typeof MAX_H_ARC === 'number') ? MAX_H_ARC : 23;
  if (!scrubberEl || typeof timeFromEl === 'undefined' || !timeFromEl) return;
  if (scrubberEl._scrubberWired) return; // idempotent
  scrubberEl._scrubberWired = true;

  const labelEl = scrubberEl.querySelector('.dprcv-timeline-scrubber-label');
  const _fmtHour = (h) => (typeof formatHour === 'function') ? formatHour(h)
                                                            : `${Math.floor(h)}:00`;
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
  // State at hour h — shade trumps weather (no sun on seating means weather
  // doesn't matter). Test-token override checks the most recent _testTimelineEvents
  // entry at/before h; real data uses computeSunWindows + getWeatherAt.
  const stateAt = (h) => {
    if (typeof window !== 'undefined' && Array.isArray(window._testTimelineEvents) && window._testTimelineEvents.length) {
      const sorted = window._testTimelineEvents.slice().sort((a, b) => a.h - b.h);
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].h <= h) return sorted[i].t;
      }
    }
    if (typeof computeSunWindows === 'function') {
      const sw = computeSunWindows(venue, dateStr);
      const wins = (sw && sw.windows) || [];
      const inSunWindow = wins.some(w => h >= w.start && h <= w.end);
      if (!inSunWindow) return 'shade';
    }
    return wxKeyAt(h);
  };

  let _scrubAutoHideTimer = null;
  const SCRUB_AUTO_HIDE_MS = 2500;
  const GLYPHS = (typeof window !== 'undefined' && window.TIMELINE_EVENT_GLYPHS) || {};
  const timeSlot = labelEl && labelEl.querySelector('.fts-popup-time');
  const wxSlot   = labelEl && labelEl.querySelector('.fts-popup-wx-icon');
  const tempSlot = labelEl && labelEl.querySelector('.fts-popup-temp');
  const windSlot = labelEl && labelEl.querySelector('.fts-popup-wind');

  // Position updates ALWAYS happen (so the marker is correct the instant the
  // user first interacts); .is-active is only ever added by onCanvasDown.
  const update = () => {
    const h = parseFloat(timeFromEl.value);
    if (!Number.isFinite(h)) return;
    const xPct = Math.max(0, Math.min(100, ((h - minH) / (maxH - minH)) * 100));
    scrubberEl.style.left = xPct + '%';
    if (labelEl) {
      if (timeSlot) timeSlot.textContent = _fmtHour(h);
      if (wxSlot)   wxSlot.innerHTML = GLYPHS[stateAt(h)] || '';
      try {
        if (typeof getWeatherAt === 'function') {
          const _wx = getWeatherAt(dateStr, h + 0.001);
          if (tempSlot) tempSlot.textContent = (_wx && Number.isFinite(_wx.temp)) ? `${Math.round(_wx.temp)}°` : '';
          if (windSlot) windSlot.textContent = (_wx && Number.isFinite(_wx.wspd)) ? `${Math.round(_wx.wspd)} m/s` : '';
        }
      } catch (e) { /* ignore */ }
    }
    // Only refresh the auto-hide timer if the bubble is already visible.
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
  const onCanvasDown = () => {
    scrubberEl.classList.remove('is-dragging');
    scrubberEl.classList.add('is-active');
    if (labelEl) labelEl.classList.add('fts-popup-expanded');
    if (_scrubAutoHideTimer) clearTimeout(_scrubAutoHideTimer);
    _scrubAutoHideTimer = setTimeout(() => {
      scrubberEl.classList.remove('is-active');
      scrubberEl.classList.remove('is-dragging');
      if (labelEl) labelEl.classList.remove('fts-popup-expanded');
      _scrubAutoHideTimer = null;
    }, SCRUB_AUTO_HIDE_MS);
    // Ensure the marker is at the tapped hour on the first frame.
    update();
  };
  const onCanvasMove = (ev) => {
    if (ev.buttons === 0 && ev.pressure === 0 && ev.pointerType !== 'touch') return;
    scrubberEl.classList.add('is-dragging');
  };
  const onCanvasUp = () => {
    // Keep the popup EXPANDED after release so its weather row (temp/wind +
    // wx icon — display:none in compact) stays visible for the 2.5s the popup
    // lingers. The auto-hide timer clears both is-active + expanded together.
    // (The FTS collapses on release; the detail scrubber is a "tap to inspect"
    // affordance, so weather must persist, not flash only during the drag.)
    // Smooth snap-to (FTS parity): drop is-dragging so the CSS `left` transition
    // re-engages, then snap to a 15-min grid.
    scrubberEl.classList.remove('is-dragging');
    const h = parseFloat(timeFromEl.value);
    if (Number.isFinite(h)) {
      const snapped = Math.max(minH, Math.min(maxH, Math.round(h * 4) / 4));
      if (Math.abs(snapped - h) > 1e-4) {
        timeFromEl.value = snapped;
        timeFromEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  };
  if (canvas) {
    canvas.addEventListener('pointerdown', onCanvasDown);
    canvas.addEventListener('pointermove', onCanvasMove);
    canvas.addEventListener('pointerup', onCanvasUp);
    canvas.addEventListener('pointercancel', onCanvasUp);
  }
  timeFromEl.addEventListener('input', update);
  document.addEventListener('pointerdown', onDocPointer);

  const teardown = () => {
    if (_scrubAutoHideTimer) { clearTimeout(_scrubAutoHideTimer); _scrubAutoHideTimer = null; }
    timeFromEl.removeEventListener('input', update);
    document.removeEventListener('pointerdown', onDocPointer);
    if (canvas) {
      canvas.removeEventListener('pointerdown', onCanvasDown);
      canvas.removeEventListener('pointermove', onCanvasMove);
      canvas.removeEventListener('pointerup', onCanvasUp);
      canvas.removeEventListener('pointercancel', onCanvasUp);
    }
  };
  scrubberEl._scrubberCleanup = teardown;
  // Chain teardown onto a host's _cleanup chain when asked (accept panel).
  const host = opts && opts.chainCleanupOn;
  if (host) {
    const prev = host._cleanup;
    host._cleanup = () => { try { prev?.(); } catch (e) { /* ignore */ } teardown(); };
  }
}
if (typeof window !== 'undefined') window._wireTimelineScrubber = _wireTimelineScrubber;

// ── Invite-sheet pager (one sheet, two pages, horizontal slide) ──────────────
//
// The invite sheet holds a persistent moment header + a two-page horizontal
// pager: page 1 "when" (FTS + Neste), page 2 "share" (avatars + Send + link).
// "Neste" slides to page 2 and LOCKS the date; "Tilbake" slides back + unlocks.
// The pager clip follows the ACTIVE page's height so the off-screen page can't
// inflate the sheet.

/** Size the pager clip container to the currently-active page's height and
 *  animate the change. Reading the active page's offsetHeight keeps the
 *  off-screen (differently-sized) page from inflating the clip. Pass
 *  `instant` to skip the height transition (used on first open + when the FTS
 *  is reparented in, so the sheet doesn't visibly grow from a stale size). */
function _dpinviteSyncPagerHeight(sheet, instant) {
  const _sheet = sheet || document.getElementById('invite-sheet');
  if (!_sheet) return;
  const pager = _sheet.querySelector('#dpinvite-pager');
  if (!pager) return;
  // Lock the pager to the TALLER of the two pages so the when↔share slide never
  // changes the sheet height (no jump). Both pages are always laid out (the
  // off-screen one is just translated), so offsetHeight is valid for each. The
  // shorter page is top-anchored (.dpinvite-track align-items:flex-start), so it
  // simply carries empty space below. offsetHeight includes the FTS/ring gutter.
  const whenPage  = _sheet.querySelector('.dpinvite-page-when');
  const sharePage = _sheet.querySelector('.dpinvite-page-share');
  const h = Math.max(whenPage  ? whenPage.offsetHeight  : 0,
                     sharePage ? sharePage.offsetHeight : 0);
  if (!h) return;
  if (instant) {
    const prev = pager.style.transition;
    pager.style.transition = 'none';
    pager.style.height = h + 'px';
    // Force the no-transition height to commit before restoring the transition.
    // eslint-disable-next-line no-unused-expressions
    pager.offsetHeight;
    pager.style.transition = prev;
    return;
  }
  pager.style.height = h + 'px';
}
if (typeof window !== 'undefined') window._dpinviteSyncPagerHeight = _dpinviteSyncPagerHeight;

/** "Neste" — slide the pager to page 2 (share) and LOCK the date: disable the
 *  day-picker button so the moment can't change after advancing. The FTS lives
 *  on page 1 (slid out of view), so the time is effectively locked too while
 *  the header keeps showing the chosen date/time. */
function _dpinviteGoToShare(venueId) {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const track = sheet.querySelector('#dpinvite-track');
  if (!track) return;
  sheet._inviteStep = 'share';
  track.classList.add('show-share');
  // The date is locked on the share step — the day-picker slot (header row 3)
  // keeps showing the day but now ACTS as back: same pill, chevron flips to
  // point right (.is-back), and tapping it returns to the time step to change
  // the moment (see the #dpinvite-moment-sub click handler's step branch).
  const daySub = sheet.querySelector('#dpinvite-moment-sub');
  if (daySub) {
    daySub.classList.remove('is-locked');
    daySub.disabled = false;
    daySub.classList.add('is-back');
  }
  // aria-hidden tracks the visible page for AT + the page-fade CSS rule.
  const whenPage  = sheet.querySelector('.dpinvite-page-when');
  const sharePage = sheet.querySelector('.dpinvite-page-share');
  if (whenPage)  whenPage.setAttribute('aria-hidden', 'true');
  if (sharePage) sharePage.removeAttribute('aria-hidden');
  // Reflect the correct Send-button state on entering the share page.
  _refreshInvitePrimaryCTA();
  // Follow the share page's height as it slides in.
  _dpinviteSyncPagerHeight(sheet);
}
if (typeof window !== 'undefined') window._dpinviteGoToShare = _dpinviteGoToShare;

/** "Tilbake" — slide the pager back to page 1 (when) and RE-ENABLE the day
 *  picker so the date is editable again. */
function _dpinviteGoToWhen() {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const track = sheet.querySelector('#dpinvite-track');
  if (!track) return;
  sheet._inviteStep = 'when';
  track.classList.remove('show-share');
  // Restore the day picker in header row 3 (it was the back affordance on the
  // share step) — drop .is-back so the chevron points down again + taps reopen
  // the calendar. The day label was never changed, so nothing to re-fill.
  const daySub = sheet.querySelector('#dpinvite-moment-sub');
  if (daySub) {
    daySub.classList.remove('is-back', 'is-locked');
    daySub.disabled = false;
  }
  // Reset the friend selection — going back to pick a new time should start the
  // share step fresh (no carried-over picks), and drop the Send overlay so the
  // share-targets row is the bottom again.
  sheet.querySelectorAll('.dpinvite-avatar[aria-checked="true"]')
    .forEach(a => a.setAttribute('aria-checked', 'false'));
  _refreshInvitePrimaryCTA();
  const whenPage  = sheet.querySelector('.dpinvite-page-when');
  const sharePage = sheet.querySelector('.dpinvite-page-share');
  if (sharePage) sharePage.setAttribute('aria-hidden', 'true');
  if (whenPage)  whenPage.removeAttribute('aria-hidden');
  _dpinviteSyncPagerHeight(sheet);
  // Force a clean FTS repaint as the time step comes back into view — covers any
  // stale frame left while it was the off-screen page (see the open path note).
  requestAnimationFrame(() => { if (typeof drawFtsCanvas === 'function') drawFtsCanvas(); });
}
if (typeof window !== 'undefined') window._dpinviteGoToWhen = _dpinviteGoToWhen;

/** Update the persistent invite header — refreshes the live Meeting tile
 *  (time + day) in the right column as the FTS scrubs. The eyebrow +
 *  venue + meta on the left stay static; the right column is the only
 *  thing that tracks the slider. */
function _updateInviteHeader(venue, dateStr, hour) {
  const timeEl    = document.getElementById('dpinvite-moment-time');
  const subTextEl = document.getElementById('dpinvite-moment-sub-text');
  const labelEl   = document.getElementById('dpinvite-moment-label');
  if (!timeEl && !subTextEl) return;

  const fmt = (h) => (typeof formatHour === 'function')
    ? formatHour(h)
    : `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

  // Big time — current FTS hour. Today: when the picked moment is ~now
  // (per _isNowSend's threshold), swap to a short "Now" label.
  const isNow = (typeof _isNowSend === 'function') ? _isNowSend(dateStr, hour) : false;
  if (timeEl) timeEl.textContent = isNow ? t('invite_when_at_now') : fmt(hour);
  // "Klokken" label is meaningless above a "Now" reading — hide it when now,
  // but with visibility (not display) so it keeps its row: otherwise the big
  // time jumps up to row 1 instead of staying aligned with the venue name.
  if (labelEl) labelEl.style.visibility = isNow ? 'hidden' : '';

  // Sub — day label. _dayLabel returns "i dag" / "i morgen" / "tirsdag" /
  // "12. mai" depending on how far the picked date is from today. Always
  // shown, even in the "Now" case — the day still carries useful info
  // ("Now / Today" reads cleaner than a blank chip when inviting the
  // current moment). Text goes in a separate span so the chevron isn't
  // overwritten.
  if (subTextEl) {
    const dayPart = (dateStr && typeof _dayLabel === 'function') ? _dayLabel(dateStr) : '';
    subTextEl.textContent = dayPart ? dayPart.charAt(0).toUpperCase() + dayPart.slice(1) : '';
  }
}
if (typeof window !== 'undefined') window._updateInviteHeader = _updateInviteHeader;

/** Build the avatar carousel — horizontally scrolling .dpinvite-avatar tiles
 *  with multi-select state via aria-checked. */
function _renderInviteAvatarCarousel(friends, hashColor, checkSvg) {
  return friends.map(f => {
    const fullName  = f.name || f.email || '';
    const firstName = fullName.split(/\s+/)[0] || fullName || '?';
    const initial   = (fullName || '?')[0].toUpperCase();
    const colorIdx  = hashColor(f.id);
    const safeFull  = fullName.replace(/"/g, '&quot;');
    const safeFirst = firstName.replace(/</g, '&lt;');
    const onlineDot = f.online ? '<span class="dpinvite-online-dot" aria-hidden="true"></span>' : '';
    const avatarInner = f.avatar_url
      ? `<img src="${f.avatar_url}" alt="">`
      : `<div class="dpinvite-avatar-init init-color-${colorIdx}">${initial}</div>`;
    return `<button type="button" class="dpinvite-avatar" role="checkbox" aria-checked="false" aria-label="${safeFull}" data-friend-id="${f.id}" data-friend-name="${safeFull}" onclick="_toggleInviteFriend(this)">
      <span class="dpinvite-avatar-img">
        ${avatarInner}
        <span class="dpinvite-avatar-check" aria-hidden="true">${checkSvg}</span>
        ${onlineDot}
      </span>
      <span class="dpinvite-avatar-name">${safeFirst}</span>
    </button>`;
  }).join('');
}

/** Build the group-chip strip — "Nylige (n) | Alle (m)". Uses .chip-pill
 *  primitives. Nylige is hidden when no recent ids exist; "Alle" becomes
 *  the default-active chip. */
function _renderInviteGroupChips(activeGroup, recentCount, totalCount) {
  const chips = [];
  if (recentCount > 0) {
    chips.push({ id: 'recent', label: t('invite_group_recent'), count: recentCount });
  }
  chips.push({ id: 'all', label: t('invite_group_all'), count: totalCount });
  const effectiveActive = (activeGroup === 'recent' && recentCount === 0) ? 'all' : activeGroup;
  return chips.map(c => `
    <button type="button" class="chip-pill${c.id === effectiveActive ? ' is-selected' : ''}" data-group="${c.id}" onclick="_dpinviteApplyGroupFilter('${c.id}')">
      ${c.label}
      <span class="count">${c.count}</span>
    </button>`).join('');
}

/** Apply a group filter — toggle hidden on .dpinvite-avatar tiles and update
 *  the .is-selected state on the chip strip. Selection state (aria-checked)
 *  is preserved so a friend selected in "Alle" stays selected when filtered
 *  out. */
function _dpinviteApplyGroupFilter(groupId) {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  sheet._activeGroup = groupId;
  const recentSet = sheet._recentSet || new Set();
  const tiles = sheet.querySelectorAll('.dpinvite-avatar');
  tiles.forEach(tile => {
    const fid = String(tile.getAttribute('data-friend-id'));
    const inGroup = (groupId === 'all') ? true : recentSet.has(fid);
    tile.hidden = !inGroup;
  });
  const chips = sheet.querySelectorAll('#dpinvite-group-chips .chip-pill');
  chips.forEach(chip => {
    chip.classList.toggle('is-selected', chip.getAttribute('data-group') === groupId);
  });
  _refreshInvitePrimaryCTA();
}

/** Best-effort recent-friends list — orders by most-recently-invited (from
 *  localStorage), falling back to the canonical friend order. Returns an
 *  array of friend ids as strings, capped at 8. */
function _recentInvitedFriendIds(friends) {
  const safe = (Array.isArray(friends) ? friends : []).map(f => String(f.id));
  let recent = [];
  try {
    const raw = localStorage.getItem('solsteder_recent_invited');
    if (raw) recent = JSON.parse(raw);
  } catch (e) { /* ignore */ }
  const ordered = [];
  for (const id of recent) if (safe.includes(String(id)) && !ordered.includes(String(id))) ordered.push(String(id));
  for (const id of safe) if (!ordered.includes(id)) ordered.push(id);
  return ordered.slice(0, 8);
}

/** Render the floating top venue card (NOT .venue-card — bespoke for the
 *  invite context so it doesn't inherit the muddy --glass-card-bg meant for
 *  in-panel cards). Bright, high-contrast, pinned at the top of the screen
 *  while the sheet is open. */
function _renderInviteTopCard(v, dateStr, fromHour) {
  if (!v) return '';
  const dayHours = (typeof getVenueHoursForDay === 'function')
    ? getVenueHoursForDay(v, dateStr) : { open: 0, close: 24 };
  const isOpen = (fromHour >= dayHours.open && fromHour <= dayHours.close);
  const isOpeningSoon = (!isOpen && (dayHours.open - fromHour) > 0 && (dayHours.open - fromHour) <= 0.75);
  const metaParts = [v.area, (typeof catLabel === 'function' ? catLabel(v) : null)].filter(Boolean);
  const metaHtml = metaParts.map((p, i) =>
    (i > 0 ? '<span class="itc-dot">·</span>' : '') + `<span>${p}</span>`
  ).join('');
  if (!isOpen && !isOpeningSoon) {
    return `<div class="itc-row">
      <div class="itc-left">
        <div class="itc-name">${v.name}</div>
        <div class="itc-meta">${metaHtml}</div>
      </div>
      <div class="itc-right itc-closed">${t('opens_at', { time: formatHour(dayHours.open) })}</div>
    </div>`;
  }
  const state = (typeof venueState === 'function')
    ? venueState(v, fromHour) : { mainText: '', subText: '', className: '' };
  return `<div class="itc-row ${state.className || ''}">
    <div class="itc-left">
      <div class="itc-name">${v.name}</div>
      <div class="itc-meta">${metaHtml}</div>
    </div>
    <div class="itc-right">
      <div class="itc-main">${state.mainText || ''}</div>
      <div class="itc-sub">${state.subText || ''}</div>
    </div>
  </div>`;
}

/** Reverse: detach FTS + popup from the invite slot back to body. */
function _invFtsDetach() {
  const fts = document.getElementById('fts');
  if (fts) {
    fts.classList.remove('fts-in-invite');
    fts.style.cssText = '';
    if (fts.parentNode !== document.body) document.body.appendChild(fts);
  }
  const popup = document.getElementById('fts-popup');
  if (popup) {
    popup.classList.remove('fts-popup-in-invite');
    popup.style.cssText = '';
    // The popup lives INSIDE #fts-track — its `bottom: calc(100% + 6px)` is
    // relative to the track. Re-appending it to <body> (the old behaviour)
    // positioned it 6px above the full page height (off-screen) and detached
    // it from the slider, so it vanished and stopped following the thumb after
    // an invite round-trip. Restore it into the track instead.
    const track = document.getElementById('fts-track');
    if (track && popup.parentNode !== track) track.appendChild(popup);
  }
}

/** Toggle a single friend tile's selection (avatar-tap pattern, no checkbox). */
function _toggleInviteFriend(row) {
  if (!row) return;
  const next = row.getAttribute('aria-checked') !== 'true';
  row.setAttribute('aria-checked', next ? 'true' : 'false');
  _refreshInvitePrimaryCTA();
}

/** Select-all / clear toggle. Operates on visible (non-filtered) tiles only. */
function _toggleAllInviteFriends() {
  // Avatars live on the share page inside the single invite sheet.
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const visibleRows = Array.from(sheet.querySelectorAll('.dpinvite-avatar')).filter(r => !r.hidden);
  if (!visibleRows.length) return;
  const anyUnchecked = visibleRows.some(r => r.getAttribute('aria-checked') !== 'true');
  visibleRows.forEach(r => r.setAttribute('aria-checked', anyUnchecked ? 'true' : 'false'));
  _refreshInvitePrimaryCTA();
}

/** Filter the friends list by a substring of name/email. Legacy — the new
 *  design uses group chips instead of a search input, so this is unused but
 *  kept for safety in case any callers were missed. */
function _filterInviteFriends(query) {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const q = (query || '').trim().toLowerCase();
  const rows = sheet.querySelectorAll('.dpinvite-avatar');
  rows.forEach(r => {
    const name = (r.getAttribute('data-friend-name') || '').toLowerCase();
    r.hidden = q && !name.includes(q);
  });
  _refreshInvitePrimaryCTA();
}

/** Dispatch the morphing primary button to the right action based on its
 *  current data-mode (set by _refreshInvitePrimaryCTA from selection state). */
function _invitePrimaryClick(venueId) {
  const btn = document.getElementById('invite-primary-btn');
  const mode = btn && btn.getAttribute('data-mode');
  if (mode === 'send') return _sendInvite(venueId);
  return _shareInviteLink(venueId);
}

/** Update the primary Send CTA on the share panel (step 2) based on selection.
 *  - 0 selected → DISABLED, label "Velg venner" (the user must pick at least
 *    one friend; the open-link paths live in the sub-row below).
 *  - 1+ selected → enabled "Send til {name}" / "{n} venner" / "alle ({n})". */
function _refreshInvitePrimaryCTA() {
  // Avatars + the morphing CTA live on the share page inside the single sheet.
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const total = sheet._friendCount || 0;

  const allRows = Array.from(sheet.querySelectorAll('.dpinvite-avatar'));
  const selectedRows = allRows.filter(r => r.getAttribute('aria-checked') === 'true');
  const n = selectedRows.length;

  const btn = sheet.querySelector('#invite-primary-btn');
  const label = sheet.querySelector('#invite-primary-label');
  const icon = sheet.querySelector('#invite-primary-icon');
  // The bottom slot: targets row + Send overlay share one box. .has-selection
  // fades / slides the honey Send button in OVER the targets (IG pattern);
  // dropping it returns the share-targets row. Drives the overlap purely from
  // selection count — no separate toggle path.
  const bottomSlot = sheet.querySelector('#dpinvite-share-bottom');
  const sendOverlay = sheet.querySelector('#dpinvite-send-overlay');

  // Empty (no-friends) state has no Send button at all — nothing to send to.
  // The targets row is the lone path forward; bail before touching the CTA.
  if (!btn || !label) return;

  const sendSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`;

  btn.setAttribute('data-mode', 'send');
  if (icon) icon.innerHTML = sendSvg;

  if (n === 0) {
    // No friends picked yet — hide the Send overlay so the share-targets row
    // is the bottom. The targets (copy / more apps / WhatsApp) are always
    // available underneath, so the user is never stuck here.
    btn.disabled = true;
    label.textContent = t('invite_send_pick');
    if (bottomSlot) bottomSlot.classList.remove('has-selection');
    if (sendOverlay) sendOverlay.setAttribute('aria-hidden', 'true');
    if (typeof window._dpinviteSyncPagerHeight === 'function') {
      window._dpinviteSyncPagerHeight(sheet);
    }
    return;
  }

  btn.disabled = false;
  if (n === 1) {
    const name = selectedRows[0].getAttribute('data-friend-name') || '';
    const firstName = name.split(/\s+/)[0] || name;
    label.textContent = t('invite_send_to_one', { name: firstName });
  } else if (n === total) {
    label.textContent = t('invite_send_to_all', { n });
  } else {
    label.textContent = t('invite_send_to_many', { n });
  }
  // 1+ selected → reveal the honey Send button over the targets row.
  if (bottomSlot) bottomSlot.classList.add('has-selection');
  if (sendOverlay) sendOverlay.setAttribute('aria-hidden', 'false');
  if (typeof window._dpinviteSyncPagerHeight === 'function') {
    window._dpinviteSyncPagerHeight(sheet);
  }
}

function _closeInviteSheet() {
  const overlay = document.getElementById('invite-sheet-backdrop');
  const sheet = document.getElementById('invite-sheet');
  // If the sheet was opened from the post-accept Share Onward card,
  // the cancel/backdrop path returns to the confirmation panel instead
  // of falling through to the detail panel / explore mode.
  const returnToPostAccept = (typeof window !== 'undefined')
    && window._inviteSheetReturnToPostAccept === true;
  if (typeof window !== 'undefined') window._inviteSheetReturnToPostAccept = false;
  if (sheet) {
    if (sheet._sliderCleanup) sheet._sliderCleanup();
    if (sheet._metaResizeObs) { try { sheet._metaResizeObs.disconnect(); } catch {} }
    sheet.classList.remove('open');
  }
  // Defensive: if any code path ever reparents the FTS into the sheet, detach
  // it cleanly. v2 of the sheet uses a chip picker instead, so this is a no-op
  // in normal use.
  _invFtsDetach();
  // Restore the underlying camera framing. If the detail panel is still
  // open beneath the sheet, re-apply ITS bottom padding (the same shape
  // _flyToVenue uses) so the venue sits in the visible viewport above
  // the panel instead of getting yanked back to viewport-centre — the
  // previous "padding: 0" reset put it dead-centre under the detail
  // panel chrome. When no detail panel is open, fall through to a flat
  // reset.
  if (typeof map !== 'undefined' && map && typeof map.easeTo === 'function') {
    const dp = document.getElementById('detail-panel');
    if (dp && dp.classList.contains('open')
        && !dp.classList.contains('dp-fullscreen')
        && typeof window.innerWidth === 'number' && window.innerWidth < 640) {
      // Mirror _flyToVenue mobile padding (bottom ≈ 69% of viewport).
      const panelH = Math.round((window.visualViewport?.height ?? window.innerHeight) * 0.69);
      map.easeTo({ padding: { top: 0, bottom: panelH, left: 0, right: 0 }, duration: 280 });
    } else {
      map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 280 });
    }
  }
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
  }
  document.body.classList.remove('invite-sheet-open');

  // Clear the preview pin set in _openInviteSheet and let
  // _updateFriendsCanvasPin restore the real attendee state — if a
  // plan was created during the sheet's lifetime, the pin re-populates
  // with the real attendees; if not, it stays empty.
  if (typeof window !== 'undefined') window._friendsPin = null;
  if (typeof _updateFriendsCanvasPin === 'function') {
    try { _updateFriendsCanvasPin(); } catch (e) { /* ignore */ }
  }
  if (typeof window.markPinLayoutStale === 'function') window.markPinLayoutStale();
  if (typeof draw === 'function') draw();
  // The open handler reparented #fts to <body> so the body.invite-sheet-open
  // rule could float it above the sheet. Now that the rule no longer applies,
  // put the slider back inside #panel where the FTS contract expects it to
  // live (otherwise it stays in <body> with no positioning anchor, reads as
  // "the FTS just disappeared" when the user returns to the venue list).
  const _ftsForReturn = document.getElementById('fts');
  const _panelForReturn = document.getElementById('panel');
  if (_ftsForReturn && _panelForReturn && _ftsForReturn.parentNode !== _panelForReturn) {
    // Drop the inline transform/width the desktop sheet rule applied.
    _ftsForReturn.style.cssText = '';
    // Stage 2b contract: FTS sits inside #panel as a normal-flow child,
    // immediately after #panel-handle.
    const handle = _panelForReturn.querySelector('#panel-handle');
    if (handle && handle.nextSibling) _panelForReturn.insertBefore(_ftsForReturn, handle.nextSibling);
    else _panelForReturn.appendChild(_ftsForReturn);
  }
  // The scrub popup lives inside #fts and gets inline position/below-flip
  // state during a drag-over-the-sheet session. Strip any leftover inline
  // styles + state classes so the popup is in a known state when we
  // re-show it below. Without this, the popup can be left with stale
  // `left: NN%` + a `top:` inline override that lands it off-screen in
  // the new (narrower) #panel container.
  const _ftsPopupReturn = document.getElementById('fts-popup');
  if (_ftsPopupReturn) {
    _ftsPopupReturn.style.cssText = '';
    _ftsPopupReturn.classList.remove('fts-popup-below', 'is-releasing', 'fts-popup-expanded');
  }
  // Restore the FTS to its proper position now that body.invite-sheet-open
  // is gone. _syncFtsPosition will re-attach it to the docked card slot
  // (if detail panel is open) or sit it back at the bottom of the screen.
  if (typeof _syncFtsPosition === 'function') _syncFtsPosition();
  // Re-render the popup at the current hour so the "12:00" compact pill
  // is visible the moment the user is back in the list, not deferred
  // until the next pointer interaction. Wrapped because typeof check —
  // showFtsPopup is defined in app.js and exposed at module scope.
  if (typeof showFtsPopup === 'function'
      && typeof timeFromEl !== 'undefined'
      && timeFromEl
      && document.body.classList.contains('fts')) {
    try { showFtsPopup(parseFloat(timeFromEl.value)); }
    catch (e) { /* graceful — the popup just stays whatever state it's in */ }
  }
  // Back-to-post-accept: reopen the confirmation panel with the same opts
  // we stashed at open-time. Skip the detail-panel refresh below so it
  // doesn't fight the post-accept slide-up.
  if (returnToPostAccept && typeof window !== 'undefined' && window._lastPostAcceptOpts) {
    setTimeout(() => {
      try { _openPostAcceptPanel(window._lastPostAcceptOpts); }
      catch (e) { /* ignore */ }
    }, 300);
    return;
  }
  // Defensive refresh of the detail panel underneath. The eager plan-create
  // ran during the sheet's lifetime; if any downstream listener mutated panel
  // state (e.g. the detail panel's docked card got detached), updateDetailPanel
  // re-renders cleanly. Wrapped in setTimeout so the panel's opacity has
  // returned (per the body.invite-sheet-open CSS rule) before we measure.
  setTimeout(() => {
    if (typeof updateDetailPanel === 'function') updateDetailPanel();
    // If for some reason the detail panel is not open (e.g. the sheet
    // was opened from a path that bypassed selectVenue, or the .open
    // class was dropped by another handler during the sheet's life),
    // re-open it on the venue currently associated with the sheet so
    // the user lands back on the venue page instead of a bare map.
    // This is the recovery for the "close → empty map" regression.
    try {
      const dp = document.getElementById('detail-panel');
      const sheetVenueId = (typeof window !== 'undefined') ? window._inviteSheetVenueId : null;
      if (sheetVenueId != null && (!dp || !dp.classList.contains('open'))
          && typeof selectVenue === 'function') {
        selectVenue(sheetVenueId, true);
      }
    } catch (e) { /* ignore */ }
  }, 280);
}

/** Send invite to selected friends (or broadcast to all if none selected). */
/** Read date/time from the main pickers — invite sheet no longer duplicates controls. */
function _getInviteDateTime() {
  const d = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : new Date().toISOString().slice(0, 10);
  const h = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : new Date().getHours();
  return { d, h };
}

// Convert a fractional hour (e.g. 11.99) into a zero-padded ["HH","mm"] pair.
// Round on TOTAL minutes so a fractional hour that rounds up carries into the
// hour instead of producing minute 60 — e.g. 11.99 -> ["12","00"], never
// "11:60". Minute 60 made an invalid ISO string ("…T11:60:00" -> Invalid Date),
// which threw in toISOString() at both send and share-link open. Clamp to the
// valid 00:00–23:59 range so a slider edge can never emit 24:00 either.
function _hhmmFromHour(h) {
  const total = Math.min(24 * 60 - 1, Math.max(0, Math.round(h * 60)));
  return [
    String(Math.floor(total / 60)).padStart(2, '0'),
    String(total % 60).padStart(2, '0'),
  ];
}

async function _sendInvite(venueId) {
  const { d, h } = _getInviteDateTime();
  const [hh, mm] = _hhmmFromHour(h);
  const isoTime = new Date(`${d}T${hh}:${mm}:00`).toISOString();

  const selectedRows = Array.from(
    document.querySelectorAll('#invite-sheet .dpinvite-avatar[aria-checked="true"]')
  );
  const selectedIds = selectedRows.map(r => r.getAttribute('data-friend-id'));
  // First names for the confirmation line (data-friend-name is the full name).
  const selectedNames = selectedRows
    .map(r => (r.getAttribute('data-friend-name') || '').trim().split(/\s+/)[0])
    .filter(Boolean);

  // No silent broadcast — the primary CTA is disabled in this state, but
  // guard defensively in case the handler is invoked some other way.
  if (selectedIds.length === 0) return;

  const message = '';

  // Plan-conflict prompt — if the user already created a plan for this venue
  // within ±3h of the new time, ask whether to merge invitees into it,
  // create a separate plan, or cancel. Avoids the "Anna invited me twice
  // for the same outing" recipient confusion.
  const conflict = _findPlanConflict(venueId, isoTime);
  if (conflict) {
    const choice = await _confirmPlanConflict(conflict, isoTime);
    if (choice === 'cancel') return;
    if (choice === 'update') {
      await addInviteesToExistingPlan(conflict.id, selectedIds);
      if (_isNowSend(d, h) && typeof checkIn === 'function') await checkIn(venueId, '');
      _inviteShowSent(selectedNames);
      return;
    }
    // 'separate' falls through to createPlan below.
  }

  await createPlan(venueId, isoTime, message, selectedIds);

  // Now-send → flip pin presence so friends see the user's dot on the venue.
  if (_isNowSend(d, h) && typeof checkIn === 'function') await checkIn(venueId, '');

  // Invite's away — play the slick confirm beat (honey gleam + success check),
  // then auto-close. Mirrors the accept panel's "I'm in" confirmation.
  _inviteShowSent(selectedNames);
}

/** Slick post-send confirmation — mirrors the accept panel's confirm beat: a
 *  one-shot honey gleam sweeps the whole sheet while a success check springs in
 *  over a short "Invitasjon sendt" line; then the sheet auto-closes. The venue
 *  header stays; only the pager region swaps to the success state. */
function _inviteShowSent(names) {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) { _closeInviteSheet(); return; }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Honey gleam across the whole sheet (reuses the @keyframes dprcv-panel-sheen
  // defined for the accept panel). Re-trigger by toggling the class off→on.
  sheet.classList.remove('is-confirming'); void sheet.offsetWidth; sheet.classList.add('is-confirming');
  try { if (navigator.vibrate) navigator.vibrate(12); } catch {}
  const list = (Array.isArray(names) ? names.filter(Boolean) : []);
  let subText = '';
  if (list.length) {
    subText = list.slice(0, 2).map(esc).join(', ');
    if (list.length > 2) subText += ` +${list.length - 2}`;
  }
  const checkSvg = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const html = `
    <div class="dpinvite-sent">
      <div class="dpinvite-sent-check" aria-hidden="true">${checkSvg}</div>
      <div class="dpinvite-sent-title">${t('invite_sent_title')}</div>
      ${subText ? `<div class="dpinvite-sent-sub">${subText}</div>` : ''}
    </div>`;
  const pager = sheet.querySelector('#dpinvite-pager');
  if (pager) {
    // Keep the pager's locked height through the swap so the sheet doesn't jump
    // — the success block fills it (min-height:100%) and centres instead.
    pager.style.transition = 'opacity 150ms var(--ease-standard)';
    pager.style.opacity = '0';
    setTimeout(() => {
      if (document.getElementById('invite-sheet') !== sheet) return;
      pager.innerHTML = html;
      pager.style.opacity = '1';
    }, 150);
  }
  setTimeout(() => _closeInviteSheet(), 1250);
}
if (typeof window !== 'undefined') window._inviteShowSent = _inviteShowSent;

/** Find an existing user-created plan for this venue within ±3h of the new
 *  time. Returns the plan record or null. _plans is populated by loadPlans()
 *  and only contains future plans + own plans, so this is the right pool. */
function _findPlanConflict(venueId, isoTime) {
  if (typeof _plans === 'undefined' || !Array.isArray(_plans)) return null;
  const me = (typeof authCurrentUser === 'function') ? authCurrentUser() : null;
  if (!me) return null;
  const newMs = new Date(isoTime).getTime();
  if (isNaN(newMs)) return null;
  const THREE_H = 3 * 3600 * 1000;
  return _plans.find(p =>
    p.creator_id === me.id &&
    String(p.venue_id) === String(venueId) &&
    Math.abs(new Date(p.planned_at).getTime() - newMs) < THREE_H
  ) || null;
}

/** Render a 3-way confirm dialog over the invite sheet. Resolves to one of
 *  'update' | 'separate' | 'cancel'. Backdrop tap and Esc both resolve to
 *  'cancel'. Inline modal (not a sheet) so it sits above the existing
 *  invite sheet without competing for the same slide-up space. */
function _confirmPlanConflict(plan, newIsoTime) {
  return new Promise((resolve) => {
    const existingTime = _formatPlanTimeShort(plan.planned_at);
    const overlay = document.createElement('div');
    overlay.className = 'plan-conflict-backdrop';
    overlay.innerHTML = `
      <div class="plan-conflict-dialog glass-action" role="dialog" aria-modal="true">
        <div class="plan-conflict-title">${t('plan_conflict_title')}</div>
        <div class="plan-conflict-body">${t('plan_conflict_body', { time: existingTime })}</div>
        <div class="plan-conflict-actions">
          <button class="plan-conflict-btn plan-conflict-primary" data-choice="update">${t('plan_conflict_update')}</button>
          <button class="plan-conflict-btn" data-choice="separate">${t('plan_conflict_separate')}</button>
          <button class="plan-conflict-btn plan-conflict-cancel" data-choice="cancel">${t('plan_conflict_cancel')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    let resolved = false;
    const cleanup = (choice) => {
      if (resolved) return;
      resolved = true;
      document.removeEventListener('keydown', onEsc);
      overlay.remove();
      resolve(choice);
    };
    const onEsc = (e) => { if (e.key === 'Escape') cleanup('cancel'); };
    document.addEventListener('keydown', onEsc);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { cleanup('cancel'); return; }
      const btn = e.target.closest('[data-choice]');
      if (btn) cleanup(btn.getAttribute('data-choice'));
    });
    requestAnimationFrame(() => overlay.classList.add('open'));
  });
}

function _formatPlanTimeShort(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  if (typeof formatHour === 'function') {
    return formatHour(d.getHours() + d.getMinutes() / 60);
  }
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Pick the contextual weather + sun phrase for the share message. Maps the
 *  state space to seven distinct user-facing strings so the message never
 *  promises sun where the venue is shaded, never says "sun until 20:50" when
 *  it's already raining, etc.
 *
 *  Decision order (first match wins):
 *    1. Rain expected at meeting hour       → "regn forventes 🌧️"
 *    2. Heavy overcast (cloud > 0.7)        → "overskyet ☁️"
 *    3. Meeting time past venue's sun close → "etter solnedgang 🌇"
 *    4. Meeting time before venue's open    → "før soloppgang 🌅"
 *    5. Meeting time inside a sun window    → "det er sol til {end} ☀️/⛅"
 *    6. Sun returns later that day          → "skygge nå, sol fra kl. {start} ☀️/⛅"
 *    7. Shaded for the rest of the day      → "skygge resten av dagen ☁️"
 *
 *  Sun icon flips to ⛅ for partly cloudy (cloud > 0.35) so the receiver gets
 *  an honest cue that it's not full sun.
 */
function _composeShareContext(v, d, h) {
  const wx = (typeof getWeatherAt === 'function') ? getWeatherAt(d, Math.floor(h)) : null;
  const isRain     = (wx?.precip ?? 0) > 0.4;
  // Layer-aware: thin high cirrus shouldn't tip the share context into
  // "overcast" when low/mid skies are clear.
  const blocked    = wx?.sunBlock ?? wx?.cloud ?? 0;
  const isOvercast = !isRain && blocked > 0.7;
  const isPartly   = !isRain && !isOvercast && blocked > 0.35;

  if (isRain)     return { context: t('share_ctx_rain'),     icon: '🌧️' };
  if (isOvercast) return { context: t('share_ctx_overcast'), icon: '☁️' };

  let open = null, close = null, windows = null;
  if (v && typeof computeSunWindows === 'function') {
    const res = computeSunWindows(v, d) || {};
    windows = res.windows || null;
    open    = res.open;
    close   = res.close;
  }

  if (close != null && h >= close) return { context: t('share_ctx_after_sunset'),   icon: '🌇' };
  if (open  != null && h <  open)  return { context: t('share_ctx_before_sunrise'), icon: '🌅' };

  const sunIcon = isPartly ? '⛅' : '☀️';
  if (windows && windows.length && typeof formatHour === 'function') {
    const cur  = windows.find(w => h >= w.start && h < w.end);
    if (cur) return { context: t('share_ctx_sun_until', { time: formatHour(cur.end) }), icon: sunIcon };
    const next = windows.find(w => w.start > h);
    if (next) return { context: t('share_ctx_sun_from', { time: formatHour(next.start) }), icon: sunIcon };
  }

  return { context: t('share_ctx_no_sun_rest'), icon: '☁️' };
}

/** True when the picked date/time is within 30 minutes of real-now. Used to
 *  switch the share-message body from "Heading to X {when}" → "I'm at X now"
 *  and to flip pin presence (check-in) on send. The 30-min window covers
 *  both "I'm here" entry (which forces time=now) and "Invite friends" entry
 *  where the global time picker happens to already be at the current hour. */
function _isNowSend(d, h) {
  try {
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (d !== todayIso) return false;
    const realNow = today.getHours() + today.getMinutes() / 60;
    return Math.abs(h - realNow) < 0.5;
  } catch { return false; }
}

/** Compose the share-text body for an invite at venue+date+hour. When `link`
 *  is provided, the message includes a "Bli med: {link}" suffix so the URL is
 *  inlined into the body (visible regardless of how the receiving platform
 *  treats Web Share's separate `url` field). Without a link, returns the
 *  body alone — used for the chat-bubble preview in the invite sheet.
 *
 *  When _isNowSend(d, h) the message swaps to the "I'm at X now — come join"
 *  variant so the receiver reads a present-tense ping, not a future invite. */
/** Returns the area string IF it would add information to the venue name,
 *  empty string if the venue name already ends with the area (e.g. data
 *  has venue.name = "Mamma Pizza Nydalen" and venue.area = "Nydalen").
 *  Suffix match is case-insensitive and word-boundary-anchored so
 *  "Café Bislett" / area "Bislett" → dedup, but "Bislett Stadion" /
 *  area "Bislett" → keep (area not at the end). */
function _dedupeAreaForVenue(name, area) {
  const n = (name || '').trim();
  const a = (area || '').trim();
  if (!a) return '';
  if (!n) return a;
  const rx = new RegExp('\\s' + a.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '$', 'i');
  return rx.test(n) ? '' : a;
}

/** Norwegian preposition for an Oslo area name. Most Oslo neighbourhoods
 *  take "på" (the local convention, going back to former farms and
 *  open-district names — "på Tjuvholmen", "på Frogner", "på Bislett").
 *  Exceptions take "i" — valleys (-dal[en]) and "sentrum"/"byen".
 *  Falls back to "i" for non-Scandinavian locales' translations of the
 *  same segment (covered via the locale switch below).
 *
 *  Hardcoded overrides cover Oslo areas that don't follow the suffix
 *  rule but where colloquial Norwegian still takes one preposition
 *  consistently. Add new exceptions here as new areas land. */
const _AREA_PREP_OVERRIDES_NO = {
  'Nydalen': 'i',
  'Sentrum': 'i',
};
function _areaPreposition(area, lang) {
  if (!area) return '';
  // Only Norwegian (and the very-similar Swedish / Danish) have the
  // i / på distinction for place names. English always uses "in".
  if (lang === 'en') return 'in';
  const a = area.trim();
  if (_AREA_PREP_OVERRIDES_NO[a]) return _AREA_PREP_OVERRIDES_NO[a];
  const lower = a.toLowerCase();
  if (/dalen?$/.test(lower)) return 'i';          // valleys (Nydalen, Sogndal)
  if (lower === 'sentrum' || lower === 'byen') return 'i';
  return 'på';
}

function _composeInviteShareText(v, d, h, link) {
  const venueName = v?.name || '';
  const lang = (typeof prefLang === 'function') ? prefLang() : 'no';
  // {area_segment} carries its own leading space so the template stays
  // "{venue}{area_segment} {when}, …" — when the venue has no area the
  // segment is empty and the surrounding template doesn't get a stray
  // double-space. Same dedup as the header: when the venue's name
  // already ends with the area name, drop the segment so the share
  // text doesn't read "Mamma Pizza Nydalen i Nydalen …".
  const dispArea = _dedupeAreaForVenue(venueName, v?.area);
  const areaSegment = dispArea
    ? ` ${_areaPreposition(dispArea, lang)} ${dispArea}`
    : '';
  const isNow = _isNowSend(d, h);
  const when = isNow ? '' : _inviteWhenLabel(d, h);
  const { context, icon } = _composeShareContext(v, d, h);
  let key;
  if (isNow) key = link ? 'share_invite_text_now_w_link' : 'share_invite_text_now';
  else       key = link ? 'share_invite_text_w_link'      : 'share_invite_text';
  return t(key, { venue: venueName, area_segment: areaSegment, when, context, icon, link: link || '' });
}

/** Share an invite link via native share or clipboard.
 *  Synchronous: must run within the same tick as the user's click so Web Share
 *  retains transient user activation (Android Chrome drops the rich text body
 *  if anything is awaited between click and navigator.share). The plan that
 *  backs the share-token's `p` field is pre-created when the sheet opens
 *  (see _openInviteSheet); this function just reads sheet._planId.
 *
 *  Optional `overrides` lets callers (e.g. the post-accept share-nudge)
 *  thread a specific planId + plannedAt instead of reading the live pickers
 *  and the invite-sheet plan id.
 */
function _prepareInvitePayload(venueId, overrides = {}) {
  let d, h;
  if (overrides.plannedAt) {
    const dt = new Date(overrides.plannedAt);
    if (!isNaN(dt.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      d = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      h = dt.getHours() + dt.getMinutes() / 60;
    }
  }
  if (d == null) ({ d, h } = _getInviteDateTime());
  const [hh, mm] = _hhmmFromHour(h);
  const timeVal = `${d}T${hh}:${mm}`;
  const user = typeof authCurrentUser === 'function' ? authCurrentUser() : null;
  if (!user) return null;

  const sheet = document.getElementById('invite-sheet');
  const planId = overrides.planId || (sheet && sheet._planId ? sheet._planId : null);

  const tokenData = { u: user.id, v: venueId, t: timeVal };
  if (planId) tokenData.p = planId;
  const data = btoa(JSON.stringify(tokenData));
  // Prefer the eager-shortened /s/<id> URL when the invite sheet has one
  // cached. Fall back to the canonical long /i/<token> URL — both routes
  // resolve to the same OG-preview render and SPA bounce.
  const longUrl = `${location.origin}${location.pathname.replace(/\/$/, '')}/i/${data}`;
  const url = (sheet && sheet._shortUrl) || overrides.url || longUrl;
  const v = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === venueId) : null;
  // Inline the URL into the body — Web Share platforms vary in how they merge
  // text + url, so the only reliable way to ensure "Bli med: <link>" reads
  // exactly as written is to bake it into the text itself. We omit the
  // separate `url` field on share() to avoid duplicate URLs on platforms that
  // append it.
  const text = _composeInviteShareText(v, d, h, url);
  return { v, d, h, url, text };
}

function _shareInviteLink(venueId, overrides = {}) {
  const payload = _prepareInvitePayload(venueId, overrides);
  if (!payload) return;
  const { v, d, h, text } = payload;
  if (navigator.share) {
    // Title kept short and venue-only — macOS Safari's share sheet
    // concatenates title + text into the preview, so an awkward title
    // like "Lorry — Invite friends here" ends up reading as "Lorry —
    // Invite friends here and I'm at Lorry…" in the recipient app.
    navigator.share({
      title: v ? v.name : '',
      text,
    }).catch(err => {
      if (err && err.name !== 'AbortError') console.warn('[share] navigator.share failed:', err);
    });
  } else {
    navigator.clipboard?.writeText(text);
    if (typeof _showToast === 'function') _showToast(t('invite_link_copied'));
  }

  // Now-share → flip pin presence so the share link's "I'm at X now"
  // body matches reality on the map. v1 fired the check-in immediately;
  // user feedback: "you should not get checked in until the notification
  // is gone — give me an option to NOT check in via a CTA." The new
  // path shows a "Checking you in…" notification with a "Don't check in"
  // action and only commits the check-in if that ~4.5s window elapses
  // without the user opting out.
  if (_isNowSend(d, h)) _deferredCheckInAfterInvite(venueId);
}

/** Explicit copy-to-clipboard variant of the invite share. Always copies
 *  the same composed text (incl. URL) regardless of navigator.share
 *  availability — exists because macOS Safari's share sheet doesn't
 *  expose a Copy option, so users on desktop had no easy path to
 *  paste the link into a non-Apple app. */
function _copyInviteLink(venueId, overrides = {}) {
  const payload = _prepareInvitePayload(venueId, overrides);
  if (!payload) return;
  const { d, h, text } = payload;
  try {
    navigator.clipboard?.writeText(text);
  } catch (e) { /* clipboard unavailable — no fallback worth the noise */ }
  if (typeof _showToast === 'function') _showToast(t('invite_link_copied'));
  if (_isNowSend(d, h)) _deferredCheckInAfterInvite(venueId);
}

/** WhatsApp deep-link share. Reuses the same composed invite text (URL already
 *  inlined by _prepareInvitePayload) so the WhatsApp message reads identically
 *  to the copy / native-share paths. wa.me/?text=<encoded> opens WhatsApp's
 *  "pick a chat → send this text" sheet on web AND native (the OS resolves the
 *  wa.me link to the installed app). */
function _shareInviteWhatsApp(venueId, overrides = {}) {
  const payload = _prepareInvitePayload(venueId, overrides);
  if (!payload) return;
  const { d, h, text } = payload;
  const waUrl = 'https://wa.me/?text=' + encodeURIComponent(text);
  window.open(waUrl, '_blank', 'noopener');
  if (_isNowSend(d, h)) _deferredCheckInAfterInvite(venueId);
}
if (typeof window !== 'undefined') window._shareInviteWhatsApp = _shareInviteWhatsApp;

/** Schedule a check-in to fire after a short notification window during
 *  which the user can tap "Don't check in" to cancel. The notification
 *  acts as the success toast — once dismissed (timeout OR action), the
 *  silent checkIn fires (or doesn't, if cancelled). */
function _deferredCheckInAfterInvite(venueId) {
  if (typeof checkIn !== 'function') return;
  const v = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === venueId) : null;
  const venueName = v?.name || '';
  let cancelled = false;
  const TIMER_MS = 4500;
  if (typeof _notifShowImmediate === 'function') {
    _notifShowImmediate({
      id: 'invite_checkin_' + venueId,
      priority: 1,
      category: 'social',
      icon: '☀️',
      _rawText: t('checkin_inviting_at', { venue: venueName }),
      actionKey: 'checkin_skip',
      action: () => { cancelled = true; },
      _legacyDismiss: TIMER_MS,
    });
  }
  setTimeout(() => {
    if (cancelled) return;
    checkIn(venueId, '', { silent: true });
  }, TIMER_MS);
}

/** Post-render hook for the wind-shelter canvas. Called from openDetailPanel
 *  / updateDetailPanel after the panel HTML is in the DOM. Resolves the
 *  current weather (for wind direction + speed) and hands the canvas to
 *  drawShelterDiagram. No-ops cleanly when the canvas isn't there (no
 *  shelter section was rendered) or when the dependency isn't loaded. */
function _populateDpShelter(v) {
  if (!v || typeof drawShelterDiagram !== 'function') return;
  const canvas = document.getElementById(`dp-shelter-${v.id}`);
  if (!canvas) return;
  const dateStr  = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : '';
  const fromHour = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : 0;
  const wx = (typeof getWeatherAt === 'function') ? getWeatherAt(dateStr, fromHour) : null;
  try { drawShelterDiagram(v, wx, canvas); } catch (_) { /* swallow render errors so the panel stays usable */ }
}

