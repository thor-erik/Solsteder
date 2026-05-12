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

  const phoneIcon = typeof getMapsIcon === 'function' ? getMapsIcon('phone') : '📞';
  const globeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('globe') : '🌐';
  const shareIcon = typeof getMapsIcon === 'function' ? getMapsIcon('share') : '↗';
  const dirIcon = typeof getMapsIcon === 'function' ? getMapsIcon('directions') : '↗';

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
  const pinIcon   = typeof getMapsIcon === 'function' ? getMapsIcon('pin') : '📍';
  const beerIcon  = typeof getMapsIcon === 'function' ? getMapsIcon('beer') : '🍺';
  const peopleIcon = typeof getMapsIcon === 'function' ? getMapsIcon('people') : '👥';
  const volumeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('volume') : '🔊';
  const clockIcon = typeof getMapsIcon === 'function' ? getMapsIcon('clock') : '🕐';

  if (v.address) {
    infoItems.push({ icon: pinIcon, strong: v.address, chipText: v.address });
  }

  if (v.beerPrice) {
    infoItems.push({
      icon: beerIcon,
      strong: `${v.beerPrice} kr / 0,5 l`,
      sub: `Kilde: <a href="https://pilsguiden.no" target="_blank" rel="noopener" style="color:var(--accent)">Pilsguiden</a>`,
      chipText: `${v.beerPrice} kr · 0,5l`,
    });
  }

  const busynessNow = typeof getBusynessAt === 'function' ? getBusynessAt(v, dateStr, fromHour) : null;
  if (busynessNow != null) {
    infoItems.push({
      icon: peopleIcon,
      strong: 'Travelt nå',
      sub: `~${Math.round(busynessNow)}%`,
      chipText: `~${Math.round(busynessNow)}% travelt`,
    });
  }

  const noiseScore = s?.noise != null ? s.noise : (v.noiseScore != null ? v.noiseScore * 100 : null);
  if (noiseScore != null) {
    const noiseBucket = typeof noiseScoreToBucket === 'function' ? noiseScoreToBucket(noiseScore) : null;
    if (noiseBucket) {
      infoItems.push({
        icon: volumeIcon,
        strong: noiseBucket.label,
        chipText: noiseBucket.label,
      });
    }
  }

  const hours = getVenueHoursForDay(v, dateStr);
  const closingStr = hours.close != null ? formatHour(hours.close) : 'Åpent';
  let hoursSubtext = '';
  if (v.kitchenCloseHour != null) {
    hoursSubtext = `Kjøkken til ${formatHour(v.kitchenCloseHour)}`;
  }
  infoItems.push({
    icon: clockIcon,
    strong: `Åpent til ${closingStr}`,
    sub: hoursSubtext || '',
    chipText: `Åpent til ${closingStr}`,
  });

  // Adaptive shape: ≤3 → compact chip row (each chip is icon + chipText);
  // ≥4 → full vertical list (icon + strong + optional sub).
  let infoListHtml = '';
  if (infoItems.length > 0 && infoItems.length <= 3) {
    infoListHtml = `<div class="info-chips">${
      infoItems.map(it => `<div class="info-chip">
        <span class="info-chip-icon">${it.icon}</span>
        <span class="info-chip-text">${it.chipText}</span>
      </div>`).join('')
    }</div>`;
  } else if (infoItems.length > 0) {
    infoListHtml = `<div class="info-list">${
      infoItems.map(it => `<div class="info-row">
        <div class="info-icon">${it.icon}</div>
        <div class="info-label">
          <div class="info-label-strong">${it.strong}</div>
          ${it.sub ? `<div class="info-label-sub">${it.sub}</div>` : ''}
        </div>
      </div>`).join('')
    }</div>`;
  }

  // Footer toned down — secondary actions for rare admin paths. Smaller,
  // dimmer, sits at the very bottom of the panel so it doesn't compete
  // with venue content.
  const footerHtml = `
    <div class="secondary-row dp-footer-quiet">
      <button class="secondary-link" onclick="enterEditMode(${v.id})">Rediger informasjon</button>
      <span class="dp-footer-sep">·</span>
      <button class="secondary-link" onclick="alert('Rapportfunksjon kommer snart')">Rapporter feil</button>
    </div>`;

  // Wind shelter — pinned for now. Wind direction + speed already render as
  // animated particles on the map (render-wind.js); the per-venue shelter
  // STATUS ("Le / Delvis le / Eksponert") would be a separate compact text
  // chip here, but the shelter % isn't computed at the venue level yet.
  // Revisit when venueWindShelter() is wired into the detail render.
  const shelterHtml = '';

  // Friend chip on the photo top-right. Tap-to-expand: the compact pill
  // ("Anna +N her") expands inline to a small panel listing every friend
  // with their check-in time ("siden 13:24"). For 1 friend the panel is
  // suppressed (the pill already shows the name).
  const _photoFriendCheckins = typeof getFriendCheckinsForVenue === 'function'
    ? getFriendCheckinsForVenue(v.id) : [];
  const _fmtCheckin = (c) => {
    if (!c.created_at) return '';
    const d = new Date(c.created_at);
    if (isNaN(d.getTime())) return '';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `siden ${hh}:${mm}`;
  };
  const photoChipHtml = _photoFriendCheckins.length
    ? `<div class="photo-overlay-chip${_photoFriendCheckins.length >= 2 ? ' is-expandable' : ''}"
            onclick="this.classList.toggle('expanded'); event.stopPropagation();">
        <div class="photo-overlay-chip-summary">
          <div class="avatar-row sm">${_renderFriendAvatarsHtml(_photoFriendCheckins, 3, 18)}</div>
          <span>${_friendsHereChipLabel(_photoFriendCheckins)}</span>
        </div>
        ${_photoFriendCheckins.length >= 2 ? `<div class="photo-overlay-chip-list">
          ${_photoFriendCheckins.map(c => {
            const u = c.user || {};
            const name = (u.name || u.email || '').replace(/"/g, '&quot;');
            const initial = ((u.name || u.email || '?')[0] || '?').toUpperCase();
            const av = u.avatar_url
              ? `<img class="chip-list-avatar" src="${u.avatar_url}" alt="">`
              : `<span class="chip-list-avatar chip-list-avatar-init" style="background:${_dpFriendColor(u.id)}">${initial}</span>`;
            return `<div class="chip-list-row">
              ${av}
              <div class="chip-list-name">${name}</div>
              <div class="chip-list-time">${_fmtCheckin(c)}</div>
            </div>`;
          }).join('')}
        </div>` : ''}
      </div>`
    : '';

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

  // Photo block — shared header overlay (title + meta + friend chip + count
  // + dark gradient) sits on top of every state.
  const photoOverlayHtml = `
    <div class="photo-overlay-grad"></div>
    ${photoCountHtml}
    ${photoChipHtml}
    <div class="photo-overlay-header">
      <div class="photo-overlay-title">${v.name}</div>
      ${_metaLine ? `<div class="photo-overlay-meta">${_metaLine}</div>` : ''}
    </div>`;

  const photosHtml = v.photoUrls?.length
    ? `<div class="detail-new-photos">
        <div class="detail-new-photos-scroll">${
          v.photoUrls.map(url => `<img src="${url}" loading="lazy" alt="" onerror="this.remove()">`).join('')
        }</div>
        ${photoOverlayHtml}
      </div>`
    : `<div class="detail-new-photos detail-new-photos-empty" role="img" aria-label="Ingen bilder">
        <div class="detail-new-photos-empty-art">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="${_favActive ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>
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

      <!-- Placeholder slot replaced by openDetailPanel/updateDetailPanel
           with a freshly-rendered .dp-card. Reserves layout space so photos
           / social / info sit in their final positions before the card
           lands. -->
      <div id="dp-card-slot" class="dp-card-slot"></div>

      ${_renderSocialSection(v)}

      ${_renderPlansBlock(v)}

      <div class="dp-actions">
        <a class="dp-primary-cta" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.lat + ',' + v.lng)}&travelmode=walking" target="_blank" rel="noopener" aria-label="${t('directions')}${walkTime ? ' · ' + walkTime : ''}">
          ${dirIcon}
          <span class="dp-primary-cta-label">${t('directions')}${walkTime ? ' · ' + walkTime : ''}</span>
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

      ${infoListHtml}

      ${shelterHtml}

      ${footerHtml}
    </div>`;
}

// Deterministic friend color, mirrors the canvas pin palette so the avatar
// reads as the same person between map pin and detail panel.
const _DP_FRIEND_COLORS = ['#FFAF85', '#9CBDE7', '#FFD488', '#E6C08A', '#FFCFAA', '#DECCC0'];
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

/** Social section: just the Invite-friends CTA. The "friends here now" chip
 *  is rendered on the photo overlay (top-right). Plans got promoted to their
 *  own block, _renderPlansBlock, rendered separately by the caller. */
function _renderSocialSection(v) {
  // "Invite friends here" — a location-pin-with-people glyph reads more
  // contextually than the old generic user-plus icon. Pin says "this
  // place"; the two figures inside say "friends".
  const inviteSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0z"/><circle cx="9.6" cy="9.5" r="1.6"/><circle cx="14.4" cy="9.5" r="1.6"/><path d="M7 13.5c.6-1.1 1.6-1.7 2.6-1.7M14.4 11.8c1 0 2 .6 2.6 1.7"/></svg>`;
  return `
    <div class="social-card">
      <button class="dp-invite-cta" onclick="_openInviteSheet(${v.id})">
        ${inviteSvg}
        <span>${t('invite_friends')}</span>
      </button>
    </div>`;
}

/** Plans block — own section below the social card. Empty string when no
 *  plans for this venue, so the section disappears cleanly. */
function _renderPlansBlock(v) {
  const plans = typeof getPlansForVenue === 'function' ? getPlansForVenue(v.id) : [];
  if (!plans.length) return '';

  const myUid = (typeof authCurrentUser === 'function' && authCurrentUser()) ? authCurrentUser().id : null;
  const plansHtml = plans.map(p => {
      const when = new Date(p.planned_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const creator = p.creator?.name || p.creator?.email || '';
      const invite = p._invite;
      let actions = '';
      if (invite && invite.status === 'pending') {
        actions = `<div class="plan-actions">
          <button class="btn-accept" onclick="respondToPlanInvite('${invite.id}','accepted')">${t('plan_accept')}</button>
          <button class="btn-decline" onclick="respondToPlanInvite('${invite.id}','declined')">${t('plan_decline')}</button>
        </div>`;
      } else if (invite) {
        actions = `<span class="plan-status">${t('plan_invite_' + invite.status)}</span>`;
      }

      // Status pips: only meaningful when current user is the plan creator
      let pipsHtml = '';
      if (myUid && String(p.creator_id) === String(myUid) && Array.isArray(p._invitees) && p._invitees.length) {
        const planMs = p.planned_at ? new Date(p.planned_at).getTime() : null;
        const fmtArrival = (inv) => {
          if (!inv.arrival_time || !planMs) return '';
          const arrMs = new Date(inv.arrival_time).getTime();
          if (Math.abs(arrMs - planMs) < 5 * 60 * 1000) return '';
          const d = new Date(arrMs);
          return (typeof formatHour === 'function')
            ? formatHour(d.getHours() + d.getMinutes() / 60)
            : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
        };
        pipsHtml = `<div class="plan-invitees">${p._invitees.map(inv => {
          const u = inv.user || {};
          const initial = ((u.name || u.email || '?')[0] || '?').toUpperCase();
          const av = u.avatar_url
            ? `<img src="${u.avatar_url}" alt="">`
            : `<div class="pi-init">${initial}</div>`;
          const pipCls = inv.status === 'accepted' ? 'pi-pip-accepted'
                       : inv.status === 'declined' ? 'pi-pip-declined'
                       : 'pi-pip-pending';
          const arr = fmtArrival(inv);
          const arrLabel = arr ? ` — ${arr}` : '';
          const arrChip = arr ? `<span class="pi-time">${arr}</span>` : '';
          return `<div class="plan-invitee" title="${(u.name || u.email || '')} — ${t('plan_invite_' + inv.status)}${arrLabel}">${av}<span class="pi-pip ${pipCls}"></span>${arrChip}</div>`;
        }).join('')}</div>`;
      }

      const previewBtn = `<button class="plan-preview-btn" onclick="openPlanPreview({venueId:${v.id}, plannedAt:'${p.planned_at}', mode:'preview'})">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8-10-8-10-8z"/></svg>
        ${t('preview_plan')}
      </button>`;

      return `<div class="detail-plan-item">
        <div class="plan-info"><span class="plan-when">${when}</span><span class="plan-creator">${creator}</span>${p.message ? `<span class="plan-msg">${p.message}</span>` : ''}</div>
        ${pipsHtml}
        ${actions}
        ${previewBtn}
      </div>`;
  }).join('');

  return `
    <div class="dp-section dp-plans-block">
      <div class="dp-section-title">Avtaler</div>
      ${plansHtml}
    </div>`;
}

/** Friend-add banner: insert pending friendship row + clear banner. */
async function _handleFriendPromptAdd(inviterId) {
  if (typeof _aTrack === 'function') _aTrack('invite_friend_prompt', { action: 'added' });
  if (typeof _supabase !== 'undefined' && typeof authCurrentUser === 'function' && authCurrentUser()) {
    try {
      await _supabase.from('friendships').upsert({
        user_id:   inviterId,
        friend_id: authCurrentUser().id,
        status:    'pending',
      }, { onConflict: 'user_id,friend_id' });
      if (typeof loadFriends === 'function') loadFriends();
      if (typeof _showToast === 'function') _showToast(t('friend_request_sent'));
    } catch (e) { /* ignore */ }
  }
  if (typeof window !== 'undefined') window._pendingFriendPrompt = null;
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
  if (typeof window !== 'undefined') window._pendingFriendPrompt = null;
  const banner = document.getElementById('friend-prompt-banner');
  if (banner) banner.remove();
  // After friend-prompt clears, the share nudge (if pending) takes its slot.
  if (typeof window !== 'undefined' && window._pendingShareNudge && typeof updateDetailPanel === 'function') {
    updateDetailPanel();
  }
}

/** Post-accept share nudge — Del lenke action. Reuses _shareInviteLink with
 *  the original plan's id + plannedAt so the link points to THE same meetup
 *  rather than minting a new one. */
function _handleShareNudgeShare(venueId) {
  const sn = (typeof window !== 'undefined') ? window._pendingShareNudge : null;
  if (typeof _aTrack === 'function') _aTrack('share_nudge', { action: 'shared' });
  if (typeof window !== 'undefined') window._pendingShareNudge = null;
  const banner = document.getElementById('share-nudge-banner');
  if (banner) banner.remove();
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
  if (!v || !plannedAt) return;

  const ics = _buildIcs({
    venue: v,
    plannedAt,
    planId: sn && sn.planId,
    durationMin: 120,
    link: sn && sn.link,
    inviterName,
  });
  if (!ics) return;

  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `solsteder-${_slugForFile(v.name)}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

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

  const venueName  = opts.venueName || '';
  const whenLabel  = opts.whenLabel || '';
  const arrivalDate = opts.arrivalDate || '';
  const sunUntil   = opts.sunUntil || '';
  const fp = (typeof window !== 'undefined') ? window._pendingFriendPrompt : null;
  const sn = (typeof window !== 'undefined') ? window._pendingShareNudge : null;
  const inviterName = (fp && fp.inviterName) || opts.inviterName || '';
  const inviterId   = (fp && fp.inviterId)   || opts.inviterId   || null;
  const showAddFriend = !!(fp && fp.inviterId && fp.inviterName);
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

  const checkSvg   = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
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
        <div class="dpacc-eyebrow">${t('accepted_eyebrow')}</div>
        <div class="dpacc-venue-row">
          <span class="dpacc-venue-pin" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg></span>
          <span class="dpacc-venue">${safeName}</span>
        </div>
        <div class="dpacc-subtitle">${safeSubtitle}</div>
      </div>
      <button class="g-rnd dpacc-change-rsvp" type="button" onclick="_reopenInviteFromAccept()">${t('accepted_change_rsvp')}</button>
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
    title = titleStr('accepted_action_add_friend', { name: opts.inviterName || '' });
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
      if (inviterId) _handleFriendPromptAdd(inviterId);
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
  if (typeof window !== 'undefined') {
    window._pendingFriendPrompt = null;
    window._pendingShareNudge = null;
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
      document.body.classList.remove('post-accept-active');
    }, 320);
  }
  // Default close path → drop straight into explore mode. User: 'the
  // detail panel should not even appear when clicking I'm in. It's a
  // lot simpler than you made it.' The previous version opened the
  // detail panel as an intermediate step, then explore-on-close — too
  // many surfaces. Now: accept → post-accept → explore. 'Open venue'
  // action card opts out via skipExitToExplore and selects the venue
  // explicitly; 'Change response' opts out + reopens plan-preview.
  if (!opts.skipExitToExplore && typeof _exitToExploreMode === 'function') {
    setTimeout(() => {
      try { _exitToExploreMode(); } catch (e) { /* ignore */ }
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
  setTimeout(() => {
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
  const checkSvgSm = `<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 7 6 11 12 3"/></svg>`;

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

  // Friends block — compact horizontal row preceded by a small "Send til"
  // eyebrow. The v1 section title ("Hvem inviterer du?") and the
  // Recent / All chip toggle (both chips showed 4 in a 4-friend list,
  // making the toggle meaningless) are gone. Empty state retains its
  // own copy + sub.
  const friendsBlock = hasFriends ? `
        <div>
          <div class="dpinvite-friends-label">${t('invite_friends_label')}</div>
          <div class="dpinvite-avatar-row no-scrollbar" id="dpinvite-avatar-row">
            ${avatarsHtml}
          </div>
        </div>` : `
        <div class="dpinvite-empty-card">
          <div class="dpinvite-empty-title">${t('invite_no_friends_title')}</div>
          <div class="dpinvite-empty-sub">${t('invite_no_friends_sub')}</div>
        </div>`;

  // CTA row — single .p-pill that morphs based on selection state, with an
  // .s-circ link companion that only appears when 1+ friends are picked.
  // _refreshInvitePrimaryCTA handles the swap. Initial render reflects the
  // 0-selected state ("Send delingslenke", full-width, link icon).
  // Inline copy icon — small clipboard glyph, same stroke weight as the
  // other CTA icons. Reused by the .s-circ Copy companion in both
  // selection modes so desktop users have a reliable clipboard path
  // (macOS Safari's native share sheet doesn't include a Copy option).
  const copySvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  const ctaRow = hasFriends ? `
        <div class="dpinvite-cta-row">
          <button class="p-pill" id="invite-primary-btn" data-mode="share" onclick="_invitePrimaryClick(${venueId})">
            <span id="invite-primary-icon">${linkSvg}</span>
            <span id="invite-primary-label">${t('share_link')}</span>
          </button>
          <button class="s-circ" id="invite-secondary-btn" type="button" onclick="_copyInviteLink(${venueId})" title="${t('copy_invite_link')}" aria-label="${t('copy_invite_link')}">
            ${copySvg}
          </button>
        </div>` : `
        <div class="dpinvite-cta-row">
          <button class="p-pill" onclick="_shareInviteLink(${venueId})" style="flex:1">
            ${linkSvg}
            <span>${t('share_link')}</span>
          </button>
          <button class="s-circ" type="button" onclick="_copyInviteLink(${venueId})" title="${t('copy_invite_link')}" aria-label="${t('copy_invite_link')}">
            ${copySvg}
          </button>
        </div>`;

  // The "moment" block — venue name + live time/sun readout, folded
  // INTO the top of the sheet so it sits right below the FTS slider
  // (which now sits flush against the sheet's top edge). The v1
  // floating top-card has been dropped; the question/answer split it
  // created is replaced by a single persistent answer surface adjacent
  // to the control that produces it.
  // Dedup: when the venue's name already ends with the area name (e.g.
  // "Mamma Pizza Nydalen" + area "Nydalen"), drop the redundant suffix.
  const dispArea = _dedupeAreaForVenue(venueName, v?.area);
  const venueLineLabel = dispArea ? `${venueName} · ${dispArea}` : venueName;
  const momentBlock = `
        <div class="dpinvite-moment">
          <div class="dpinvite-moment-pin" aria-hidden="true">${pinSvg}</div>
          <div class="dpinvite-moment-text">
            <div class="dpinvite-venue-line">${venueLineLabel}</div>
            <div class="dpinvite-when-line" id="dpinvite-when-line">
              <span class="when-primary" id="dpinvite-when-primary"></span>
              <span class="when-sep" aria-hidden="true">·</span>
              <span class="when-sun" id="dpinvite-when-sun"></span>
            </div>
          </div>
        </div>`;

  // Sheet body order:
  //   1. Moment block (venue + live time/sun readout)
  //   2. Friends row (compact, no title chrome)
  //   3. CTA row (primary pill + Copy companion)
  //   4. Cancel link (small, centred, demoted from full-width pill)
  sheet.innerHTML = `
    <div class="dpinvite-handle" id="dpinvite-handle" aria-label="${t('close') || 'Close'}">
      <div class="dpinvite-grabber" aria-hidden="true"></div>
    </div>
    <div class="dpinvite-body">
      ${momentBlock}
      ${friendsBlock}
      ${ctaRow}
      <div class="dpinvite-cancel-row">
        <button class="g-rnd" type="button" onclick="_closeInviteSheet()">${t('invite_cancel')}</button>
      </div>
    </div>`;

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  sheet._venueName = venueName;
  sheet._venueId = venueId;
  sheet._venue = v;
  sheet._friendCount = friends.length;
  sheet._activeGroup = 'recent';
  sheet._recentSet   = recentSet;

  // Apply initial group filter so the carousel matches the active chip.
  _dpinviteApplyGroupFilter('recent');
  _refreshInvitePrimaryCTA();

  // Drag-to-dismiss on the handle (primary close gesture). Mirrors the
  // plan-preview's _ppWireDragHandle: track Y-delta, translate the sheet
  // during the drag, close on >100px or fast flick.
  const _handleEl = sheet.querySelector('#dpinvite-handle');
  if (_handleEl) {
    let _dStartY = null, _dStartT = null, _dragging = false, _moved = false;
    const THRESHOLD_PX = 100;
    const FLICK_VELOCITY = 0.6;
    const MOVE_TRIGGER_PX = 4;
    const onStart = (e) => {
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
      const dy = Math.max(0, t.clientY - _dStartY);
      if (dy > MOVE_TRIGGER_PX) {
        _moved = true;
        _handleEl.dataset.dragging = '1';
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
      if (_moved) requestAnimationFrame(() => { delete _handleEl.dataset.dragging; });
    };
    _handleEl.addEventListener('touchstart', onStart, { passive: true });
    _handleEl.addEventListener('touchmove', onMove, { passive: false });
    _handleEl.addEventListener('touchend', onEnd, { passive: true });
    _handleEl.addEventListener('touchcancel', onEnd, { passive: true });
    _handleEl.addEventListener('mousedown', (e) => {
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
    // Tap (not drag) on the handle also closes the sheet — explicit
    // discoverability for users who don't intuit the swipe gesture.
    _handleEl.addEventListener('click', () => {
      if (_handleEl.dataset.dragging === '1') return;
      _closeInviteSheet();
    });
  }

  // Track sheet height in --dpinvite-sheet-h so the FTS rule can sit just
  // above the sheet edge (CSS rule body.invite-sheet-open #fts).
  const _writeSheetH = () => {
    document.documentElement.style.setProperty('--dpinvite-sheet-h', sheet.offsetHeight + 'px');
  };
  let _sheetRO = null;
  if (typeof ResizeObserver !== 'undefined') {
    _sheetRO = new ResizeObserver(_writeSheetH);
    _sheetRO.observe(sheet);
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
      const hInt = Math.floor(h);
      const mInt = Math.round((h - hInt) * 60);
      const timeVal = `${d}T${String(hInt).padStart(2,'0')}:${String(mInt).padStart(2,'0')}`;
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

  (async () => {
    if (typeof _supabase === 'undefined') return;
    const user = (typeof authCurrentUser === 'function') ? authCurrentUser() : null;
    if (!user) return;
    const isoTime = new Date(`${curDate}T${String(Math.floor(curHour)).padStart(2,'0')}:${String(Math.round((curHour-Math.floor(curHour))*60)).padStart(2,'0')}:00`).toISOString();
    try {
      const { data: plan } = await _supabase
        .from('plans')
        .insert({ creator_id: user.id, venue_id: String(venueId), planned_at: isoTime, message: '' })
        .select('id')
        .single();
      if (plan && plan.id && document.getElementById('invite-sheet') === sheet) {
        sheet._planId = plan.id;
      }
    } catch (e) { /* graceful — share-link still works without plan_id */ }
    // Plan id is now available (or absent); kick off the shortener regardless.
    _eagerShortenUrl();
  })();

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

  // Detach the FTS from any docked-card / preview parent so the
  // body.invite-sheet-open #fts CSS rule can position it above the sheet.
  // If the FTS was inside #detail-panel (which gets opacity:0 during the
  // share sheet), it would otherwise cascade-fade to invisible.
  const _ftsForReparent = document.getElementById('fts');
  if (_ftsForReparent) {
    if (_ftsForReparent.classList.contains('fts-in-card')) _ftsForReparent.classList.remove('fts-in-card');
    if (_ftsForReparent.classList.contains('fts-in-preview')) _ftsForReparent.classList.remove('fts-in-preview');
    _ftsForReparent.style.cssText = '';
    if (_ftsForReparent.parentNode !== document.body) document.body.appendChild(_ftsForReparent);
  }

  document.body.classList.add('invite-sheet-open');

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
        zoom:     17.5,
        pitch:    45,
        padding:  sheet._mapPadOpen,
        duration: 480,
      });
    });
  }

  // Animate in — backdrop fades, sheet slides up. (v1 also had a top
  // card to slide down; gone now.)
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    sheet.classList.add('open');
  });
}

/** Wire a card-timeline-canvas to drag-scrub timeFromEl. Drag math mirrors
 *  the body-level FTS — clientX → MIN_H_ARC..MAX_H_ARC range. The 'input'
 *  event dispatched on timeFromEl propagates to all listeners (weather,
 *  notifications, our own _updateInviteConfirm), which re-fires
 *  drawAllCardTimelines to repaint. */
function _wireInlineFtsCanvas(canvas) {
  if (!canvas || canvas._dpInlineFtsWired) return;
  canvas._dpInlineFtsWired = true;
  const minH = (typeof MIN_H_ARC === 'number') ? MIN_H_ARC : 4;
  const maxH = (typeof MAX_H_ARC === 'number') ? MAX_H_ARC : 23;
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

/** Update the persistent invite header — refreshes the when-line (primary
 *  + sun-status) in response to slider input or date change. Replaces
 *  the v1 floating callout (_updateFtsCallout). Pulls strings from i18n
 *  so the locale bug ("6t 0m sol · sol til..." stuck in Norwegian when
 *  the rest of the UI was English) is gone. */
function _updateInviteHeader(venue, dateStr, hour) {
  const primaryEl = document.getElementById('dpinvite-when-primary');
  const sunEl     = document.getElementById('dpinvite-when-sun');
  const lineEl    = document.getElementById('dpinvite-when-line');
  if (!primaryEl || !sunEl || !lineEl) return;

  const fmt = (h) => (typeof formatHour === 'function')
    ? formatHour(h)
    : `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

  // Primary: "Du drar kl. 13:25" (future) OR "Du er der nå" (within ±30 min).
  // Reuses _isNowSend from the share-text composer so the same threshold
  // governs both surfaces — header phrasing matches what the share message
  // will actually say.
  const isNow = (typeof _isNowSend === 'function') ? _isNowSend(dateStr, hour) : false;
  primaryEl.textContent = isNow
    ? t('invite_when_at_now')
    : t('invite_when_at_time', { time: fmt(hour) });

  // Sun status: pick the first applicable phrase given the venue's sun
  // windows at the selected hour.
  //   in-window  → "sol til {end}"
  //   sun-coming → "sol fra {start}"
  //   all-past   → "etter solnedgang"
  //   no-windows → "ingen sol i dag"
  let windows = [];
  try {
    if (typeof computeSunWindows === 'function' && venue) {
      const sw = computeSunWindows(venue, dateStr);
      windows = (sw && sw.windows) ? sw.windows : [];
    }
  } catch (e) { /* ignore */ }

  let sunPhrase = '';
  let noSun = false;
  if (!windows.length) {
    sunPhrase = t('invite_no_sun_today');
    noSun = true;
  } else {
    const inWin = windows.find(w => hour >= w.start && hour < w.end);
    const next  = windows.find(w => w.start > hour);
    if (inWin) {
      sunPhrase = t('invite_sun_until_compact', { time: fmt(inWin.end) });
    } else if (next) {
      sunPhrase = t('invite_sun_from_compact', { time: fmt(next.start) });
    } else {
      sunPhrase = t('invite_after_sunset_compact');
      noSun = true;
    }
  }
  sunEl.textContent = sunPhrase;
  lineEl.classList.toggle('is-no-sun', noSun);
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
    if (popup.parentNode !== document.body) document.body.appendChild(popup);
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

/** Update the primary CTA based on current selection.
 *  - 0 selected → primary becomes the link CTA: "Send delingslenke",
 *    full-width, link icon. The companion .s-circ hides (sharing the link
 *    IS the action when no friends are picked, so a duplicate icon button
 *    next to it would be redundant).
 *  - 1+ selected → split button: primary morphs to "Send til {name}" with
 *    the send icon; companion .s-circ link button reappears alongside. */
function _refreshInvitePrimaryCTA() {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const total = sheet._friendCount || 0;
  if (total === 0) return; // empty state — single full-width link CTA, no morph

  const allRows = Array.from(sheet.querySelectorAll('.dpinvite-avatar'));
  const selectedRows = allRows.filter(r => r.getAttribute('aria-checked') === 'true');
  const n = selectedRows.length;

  const btn = sheet.querySelector('#invite-primary-btn');
  const label = sheet.querySelector('#invite-primary-label');
  const icon = sheet.querySelector('#invite-primary-icon');
  const companion = sheet.querySelector('#invite-secondary-btn');

  if (!btn || !label) return;

  // SVG icons inlined here (same set used at sheet construction).
  const linkSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`;
  const sendSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`;

  // Mutate primary instantly. The companion's CSS transition (width,
  // margin-left, opacity, transform) handles the entrance/exit animation
  // — and because the row is flex with primary at flex:1, the primary's
  // width reflows in lockstep with the companion's width, so the primary
  // appears to shrink/grow alongside the companion without any explicit
  // animation needed here.
  btn.disabled = false;
  if (n === 0) {
    btn.setAttribute('data-mode', 'share');
    if (icon) icon.innerHTML = linkSvg;
    label.textContent = t('share_link');
  } else {
    btn.setAttribute('data-mode', 'send');
    if (icon) icon.innerHTML = sendSvg;
    if (n === 1) {
      const name = selectedRows[0].getAttribute('data-friend-name') || '';
      const firstName = name.split(/\s+/)[0] || name;
      label.textContent = t('invite_send_to_one', { name: firstName });
    } else if (n === total) {
      label.textContent = t('invite_send_to_all', { n });
    } else {
      label.textContent = t('invite_send_to_many', { n });
    }
  }

  // The companion is now a Copy button, useful in every state — no need
  // to hide it when 0 friends are selected. (Previously it was a redundant
  // duplicate Share button, hidden in the 0-state to avoid two identical
  // CTAs side-by-side.)
  if (companion) {
    companion.classList.add('is-visible');
    companion.setAttribute('aria-hidden', 'false');
    companion.tabIndex = 0;
  }
}

function _closeInviteSheet() {
  const overlay = document.getElementById('invite-sheet-backdrop');
  const sheet = document.getElementById('invite-sheet');
  if (sheet) {
    if (sheet._sliderCleanup) sheet._sliderCleanup();
    sheet.classList.remove('open');
  }
  // Defensive: if any code path ever reparents the FTS into the sheet, detach
  // it cleanly. v2 of the sheet uses a chip picker instead, so this is a no-op
  // in normal use.
  _invFtsDetach();
  // Restore the map's padding to zero so the venue is no longer biased
  // upward once the sheet is gone.
  if (typeof map !== 'undefined' && map && typeof map.easeTo === 'function') {
    map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 280 });
  }
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
  }
  document.body.classList.remove('invite-sheet-open');
  // Restore the FTS to its proper position now that body.invite-sheet-open
  // is gone. _syncFtsPosition will re-attach it to the docked card slot
  // (if detail panel is open) or sit it back at the bottom of the screen.
  if (typeof _syncFtsPosition === 'function') _syncFtsPosition();
  // Defensive refresh of the detail panel underneath. The eager plan-create
  // ran during the sheet's lifetime; if any downstream listener mutated panel
  // state (e.g. the detail panel's docked card got detached), updateDetailPanel
  // re-renders cleanly. Wrapped in setTimeout so the panel's opacity has
  // returned (per the body.invite-sheet-open CSS rule) before we measure.
  setTimeout(() => {
    if (typeof updateDetailPanel === 'function') updateDetailPanel();
  }, 280);
}

/** Send invite to selected friends (or broadcast to all if none selected). */
/** Read date/time from the main pickers — invite sheet no longer duplicates controls. */
function _getInviteDateTime() {
  const d = (typeof datePicker !== 'undefined' && datePicker) ? datePicker.value : new Date().toISOString().slice(0, 10);
  const h = (typeof timeFromEl !== 'undefined' && timeFromEl) ? parseFloat(timeFromEl.value) : new Date().getHours();
  return { d, h };
}

async function _sendInvite(venueId) {
  const { d, h } = _getInviteDateTime();
  const hInt = Math.floor(h);
  const mInt = Math.round((h - hInt) * 60);
  const isoTime = new Date(`${d}T${String(hInt).padStart(2,'0')}:${String(mInt).padStart(2,'0')}:00`).toISOString();

  const selectedIds = Array.from(
    document.querySelectorAll('#invite-sheet .dpinvite-avatar[aria-checked="true"]')
  ).map(r => r.getAttribute('data-friend-id'));

  // No silent broadcast — the primary CTA is disabled in this state, but
  // guard defensively in case the handler is invoked some other way.
  if (selectedIds.length === 0) return;

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
      _closeInviteSheet();
      return;
    }
    // 'separate' falls through to createPlan below.
  }

  await createPlan(venueId, isoTime, '', selectedIds);

  // Now-send → flip pin presence so friends see the user's dot on the venue.
  if (_isNowSend(d, h) && typeof checkIn === 'function') await checkIn(venueId, '');

  _closeInviteSheet();
}

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
  const isOvercast = !isRain && (wx?.cloud ?? 0) > 0.7;
  const isPartly   = !isRain && !isOvercast && (wx?.cloud ?? 0) > 0.35;

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
  const hInt = Math.floor(h);
  const mInt = Math.round((h - hInt) * 60);
  const timeVal = `${d}T${String(hInt).padStart(2,'0')}:${String(mInt).padStart(2,'0')}`;
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

