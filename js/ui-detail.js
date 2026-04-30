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

// ── Timeline strip ────────────────────────────────────────────────────────────

function renderTimeline(v, dateStr, fromHour, toHour) {
  const { windows, open, close } = computeSunWindows(v, dateStr);
  const span = close - open;
  if (span <= 0) return '';

  const isPoint = Math.abs(fromHour - toHour) < 0.01;

  // Closed during the selected window
  const isClosed = toHour < open || fromHour > close;
  if (isClosed) {
    return `
    <div class="card-timeline">
      <div class="tl-row">
        <div class="tl-track" style="opacity:0.35"></div>
        <span class="tl-closed-badge">${t('tl_closed')}</span>
      </div>
      <div class="tl-labels">
        <span>${t('opens_at', { time: formatHour(open) })}</span>
        <span>${t('closes_at', { time: formatHour(close) })}</span>
      </div>
    </div>`;
  }

  function pct(h) { return (Math.max(open, Math.min(close, h)) - open) / span * 100; }

  // Sun segments
  const sunSegs = windows.map(w => {
    const l = pct(w.start), r = pct(w.end);
    return `<div class="tl-sun-seg" style="left:${l.toFixed(2)}%;width:${(r-l).toFixed(2)}%"></div>`;
  }).join('');

  // Shade segments
  let shadeSegs = '', prev = open;
  for (const w of windows) {
    if (w.start > prev + 0.01) {
      const l = pct(prev), r = pct(w.start);
      shadeSegs += `<div class="tl-shade-seg" style="left:${l.toFixed(2)}%;width:${(r-l).toFixed(2)}%"></div>`;
    }
    prev = w.end;
  }
  if (prev < close - 0.01) {
    const l = pct(prev), r = pct(close);
    shadeSegs += `<div class="tl-shade-seg" style="left:${l.toFixed(2)}%;width:${(r-l).toFixed(2)}%"></div>`;
  }

  // Needle (single point) or range band
  let needle = '';
  if (fromHour >= open && fromHour <= close) {
    if (isPoint) {
      needle = `<div class="tl-needle" style="left:${pct(fromHour).toFixed(2)}%"></div>`;
    } else {
      const rl = pct(fromHour), rr = pct(Math.min(close, toHour));
      needle = `<div class="tl-range-seg" style="left:${rl.toFixed(2)}%;width:${(rr-rl).toFixed(2)}%"></div>`;
    }
  }

  // End-of-sun tick — always marks the END of the last sun window for the day
  const lastWin = windows.length > 0 ? windows[windows.length - 1] : null;
  const endOfSunTick = (lastWin && lastWin.end > fromHour)
    ? `<div class="tl-end-sun" style="left:${pct(lastWin.end).toFixed(2)}%"><span class="tl-end-sun-label">${formatHour(lastWin.end)}</span></div>`
    : '';

  // Badge: point/now mode vs range mode
  const wxTl = typeof getWeatherAt === 'function' ? getWeatherAt(dateStr, fromHour) : null;
  const tlRainy = (wxTl?.precip ?? 0) > 0.3;
  const tlOvercast = !tlRainy && (wxTl?.cloud ?? 0) > 0.65;
  const tlTermKey = tlRainy ? 'term_rain' : tlOvercast ? 'term_light' : 'term_sun';
  const tlTerm = t(tlTermKey);
  const tlIcon = tlRainy ? '🌧' : tlOvercast ? '☁' : '☀';
  const tlCls  = tlRainy ? 'neutral' : 'sunny';

  const curWin = windows.find(w => fromHour >= w.start && fromHour < w.end);
  let badge = '';
  if (isPoint || nowMode) {
    if (curWin) {
      const rem = curWin.end - fromHour;
      const h = Math.floor(rem), m = Math.round((rem - h) * 60);
      const dur = `${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''}`;
      badge = `<span class="tl-badge ${tlCls}">${tlIcon} ${dur} ${t('tl_left', { term: tlTerm })}</span>`;
    } else {
      const next = windows.find(w => w.start > fromHour);
      if (next) {
        const wait = next.start - fromHour;
        const h = Math.floor(wait), m = Math.round((wait - h) * 60);
        const waitStr = `${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''}`;
        badge = `<span class="tl-badge neutral">${tlIcon} ${t('tl_in', { term: tlTerm, wait: waitStr })}</span>`;
      } else {
        badge = `<span class="tl-badge muted">${windows.length ? t('tl_passed', { term: tlTerm }) : t('tl_no', { term: tlTerm })}</span>`;
      }
    }
  } else {
    let totalSun = 0;
    for (const w of windows) {
      const overlap = Math.min(w.end, toHour) - Math.max(w.start, fromHour);
      if (overlap > 0) totalSun += overlap;
    }
    if (totalSun > 0) {
      const h = Math.floor(totalSun), m = Math.round((totalSun - h) * 60);
      badge = `<span class="tl-badge ${tlCls}">${tlIcon} ${h > 0 ? h+'h ' : ''}${m > 0 ? m+'m' : ''} ${tlTerm}</span>`;
    } else {
      badge = `<span class="tl-badge muted">${t('tl_no', { term: tlTerm })}</span>`;
    }
  }

  return `
    <div class="card-timeline">
      <div class="tl-row">
        <div class="tl-track">${shadeSegs}${sunSegs}${needle}${endOfSunTick}</div>
      </div>
      <div class="tl-labels">
        <span>${t('opens_at', { time: formatHour(open) })}</span>
        <span>${t('closes_at', { time: formatHour(close) })}</span>
      </div>
    </div>`;
}

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

  // Info list
  const infoRows = [];

  if (v.beerPrice) {
    const beerIcon = typeof getMapsIcon === 'function' ? getMapsIcon('beer') : '🍺';
    infoRows.push(`
      <div class="info-row">
        <div class="info-icon">${beerIcon}</div>
        <div class="info-label">
          <div class="info-label-strong">${v.beerPrice} kr / 0,5 l</div>
          <div class="info-label-sub">Kilde: <a href="https://pilsguiden.no" target="_blank" rel="noopener" style="color:var(--accent)">Pilsguiden</a></div>
        </div>
      </div>`);
  }

  const busynessNow = typeof getBusynessAt === 'function' ? getBusynessAt(v, dateStr, fromHour) : null;
  if (busynessNow != null) {
    const peopleIcon = typeof getMapsIcon === 'function' ? getMapsIcon('people') : '👥';
    infoRows.push(`
      <div class="info-row">
        <div class="info-icon">${peopleIcon}</div>
        <div class="info-label">
          <div class="info-label-strong">Travelt nå</div>
          <div class="info-label-sub">~${Math.round(busynessNow)}%</div>
        </div>
      </div>`);
  }

  const noiseScore = s?.noise != null ? s.noise : (v.noiseScore != null ? v.noiseScore * 100 : null);
  if (noiseScore != null) {
    const noiseBucket = typeof noiseScoreToBucket === 'function' ? noiseScoreToBucket(noiseScore) : null;
    if (noiseBucket) {
      const volumeIcon = typeof getMapsIcon === 'function' ? getMapsIcon('volume') : '🔊';
      infoRows.push(`
        <div class="info-row">
          <div class="info-icon">${volumeIcon}</div>
          <div class="info-label">
            <div class="info-label-strong">${noiseBucket.label}</div>
          </div>
        </div>`);
    }
  }

  const hours = getVenueHoursForDay(v, dateStr);
  const closingStr = hours.close != null ? formatHour(hours.close) : 'Åpent';
  let hoursSubtext = '';
  if (v.kitchenCloseHour != null) {
    hoursSubtext = `Kjøkken til ${formatHour(v.kitchenCloseHour)}`;
  }
  const clockIcon = typeof getMapsIcon === 'function' ? getMapsIcon('clock') : '🕐';
  infoRows.push(`
    <div class="info-row">
      <div class="info-icon">${clockIcon}</div>
      <div class="info-label">
        <div class="info-label-strong">Åpent til ${closingStr}</div>
        ${hoursSubtext ? `<div class="info-label-sub">${hoursSubtext}</div>` : ''}
      </div>
      <div class="info-value">Åpent</div>
    </div>`);

  const infoListHtml = infoRows.length > 0 ? `
    <div class="info-list">
      ${infoRows.join('')}
    </div>` : '';

  const footerHtml = `
    <div class="secondary-row">
      <button class="secondary-link" onclick="enterEditMode(${v.id})">Rediger informasjon</button>
      <button class="secondary-link" onclick="alert('Rapportfunksjon kommer snart')">Rapporter feil</button>
    </div>`;

  const photosHtml = v.photoUrls?.length
    ? `<div class="detail-new-photos">${
        v.photoUrls.map(url => `<img src="${url}" loading="lazy" alt="" onerror="this.remove()">`).join('')
      }</div>`
    : '<div class="detail-new-photos">[Bilde]</div>';

  // Heart + bell icon SVGs
  const _favActive = typeof isFavorite === 'function' && isFavorite(v.id);
  const _alertActive = typeof hasSunAlert === 'function' && hasSunAlert(v.id);
  const heartBtn = `<button class="dp-header-icon${_favActive ? ' active' : ''}" onclick="toggleFavorite(${v.id}, event)" title="${typeof t === 'function' ? t('favorites') : 'Favoritt'}">
    ${_favActive
      ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>`
      : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>`}
  </button>`;
  const bellBtn = `<button class="dp-header-icon${_alertActive ? ' active' : ''}" onclick="toggleSunAlert(${v.id}, event)" title="${typeof t === 'function' ? t('sun_alert_label') : 'Sol-varsel'}">
    ${_alertActive
      ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`
      : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`}
  </button>`;

  // Directions CTA label — always include text for a wider, tappable button
  const dirLabel = walkTime ? `${dirIcon} ${t('directions')} · ${walkTime}` : `${dirIcon} ${t('directions')}`;

  // Time labels under the FTS slider — match the slider's MIN/MAX range.
  // Anchor labels to fixed round hours (9, 13, 17, 21) so they don't drift with
  // sunrise/sunset, and skip any that fall too close to an edge label so the
  // sunrise/sunset readouts at left:0 / right:0 don't visually collide with them.
  const sliderMin = (typeof MIN_H_ARC !== 'undefined') ? MIN_H_ARC : 4;
  const sliderMax = (typeof MAX_H_ARC !== 'undefined') ? MAX_H_ARC : 23;
  const sliderSpan = Math.max(0.01, sliderMax - sliderMin);
  const EDGE_GAP = 1.5; // hours of clearance from edge labels
  const labelHours = [9, 13, 17, 21].filter(h =>
    h - sliderMin >= EDGE_GAP && sliderMax - h >= EDGE_GAP
  );
  let tlLabels = `<span class="dp-tl-label dp-tl-label-edge" style="left:0">${formatHour(sliderMin)}</span>`;
  for (const h of labelHours) {
    const left = ((h - sliderMin) / sliderSpan * 100).toFixed(2);
    tlLabels += `<span class="dp-tl-label" style="left:${left}%">${formatHour(h)}</span>`;
  }
  tlLabels += `<span class="dp-tl-label dp-tl-label-edge dp-tl-label-end" style="left:100%">${formatHour(sliderMax)}</span>`;

  // Card-style header content — same DOM as a venue-card, scaled up via .dp-card.
  const metaParts = [v.area, catLabel(v), distStr].filter(Boolean);
  const metaHtml = metaParts.map((p, i) =>
    (i > 0 ? '<span class="card-meta-dot">·</span>' : '') + `<span>${p}</span>`
  ).join('');
  const stateClass = state.className || '';
  const cardRightMain = state.mainText || '—';
  const cardRightSub  = state.subText  || '';

  // Heart + bell sit as a small overlay on the photo gallery's top-right
  // (replaces the orphaned chevron+actions row that used to live between photos and card).
  const photoActionsHtml = `<div class="dp-photo-actions">${heartBtn}${bellBtn}</div>`;

  return `
    <div id="dp-scroll">
      <div class="detail-new-photos-wrap">
        ${photosHtml}
        ${photoActionsHtml}
      </div>

      <!-- The dp-card slot is filled by the lifted source venue-card after
           the open-morph completes (app.js → openDetailPanel hand-off).
           Until then this placeholder reserves the layout space so photos /
           social / info sit in their final positions and don't shift when
           the source card lands. Time labels are rendered INSIDE the slot
           (hidden via CSS during the morph) — at hand-off JS extracts them
           and appends to the now-docked source card so they're visually
           attached to the slider. Pre-rendering them inside the placeholder
           keeps the placeholder's height correct + lets us animate the
           labels in (.dp-tl-labels { opacity 0 → 1 } once outside the slot)
           without a layout shift. -->
      <div id="dp-card-slot" class="dp-card-slot">
        <div class="dp-tl-labels">${tlLabels}</div>
      </div>

      ${_renderSocialSection(v)}

      <div class="dp-action-row">
        <a class="dp-action-cta" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(v.lat + ',' + v.lng)}&travelmode=walking" target="_blank" rel="noopener">${dirLabel}</a>
        ${v.phone ? `<a href="tel:${encodeURIComponent(v.phone)}" class="dp-action-icon" title="Ring">${phoneIcon}</a>` : ''}
        ${v.website ? `<a href="${v.website}" target="_blank" rel="noopener" class="dp-action-icon" title="Nettside">${globeIcon}</a>` : ''}
        <button class="dp-action-icon" title="Del" onclick="shareVenue(${v.id})">${shareIcon}</button>
      </div>

      ${infoListHtml}

      ${footerHtml}
    </div>`;
}

/** Render the social section: "Jeg drar hit", "Jeg er her", friends, plans. */
function _renderSocialSection(v) {
  const myCheckin = typeof getMyCheckin === 'function' ? getMyCheckin() : null;
  const isCheckedInHere = myCheckin && String(myCheckin.venue_id) === String(v.id);
  const friendCheckins = typeof getFriendCheckinsForVenue === 'function' ? getFriendCheckinsForVenue(v.id) : [];
  const plans = typeof getPlansForVenue === 'function' ? getPlansForVenue(v.id) : [];

  // Friends checked in
  let friendsHtml = '';
  if (friendCheckins.length) {
    const dots = friendCheckins.map(c => {
      const u = c.user;
      const until = new Date(c.checkin.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return u.avatar_url
        ? `<img class="social-avatar" src="${u.avatar_url}" alt="${u.name || u.email}" title="${u.name || u.email} — ${t('checked_in_until', { time: until })}">`
        : `<div class="social-avatar social-avatar-init" title="${u.name || u.email} — ${t('checked_in_until', { time: until })}">${(u.name || u.email)[0].toUpperCase()}</div>`;
    }).join('');
    friendsHtml = `<div class="social-friends"><span class="social-friends-label">${friendCheckins.length} her nå</span><div class="social-friends-avatars">${dots}</div></div>`;
  }

  // Plans for this venue
  let plansHtml = '';
  if (plans.length) {
    const myUid = (typeof authCurrentUser === 'function' && authCurrentUser()) ? authCurrentUser().id : null;
    plansHtml = plans.map(p => {
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
        pipsHtml = `<div class="plan-invitees">${p._invitees.map(inv => {
          const u = inv.user || {};
          const initial = ((u.name || u.email || '?')[0] || '?').toUpperCase();
          const av = u.avatar_url
            ? `<img src="${u.avatar_url}" alt="">`
            : `<div class="pi-init">${initial}</div>`;
          const pipCls = inv.status === 'accepted' ? 'pi-pip-accepted'
                       : inv.status === 'declined' ? 'pi-pip-declined'
                       : 'pi-pip-pending';
          return `<div class="plan-invitee" title="${(u.name || u.email || '')} — ${t('plan_invite_' + inv.status)}">${av}<span class="pi-pip ${pipCls}"></span></div>`;
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
  }

  const inviteSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;
  // Beacon icon: dot with signal arcs
  const beaconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M5.64 5.64a9 9 0 0 0 0 12.73"/><path d="M18.36 5.64a9 9 0 0 1 0 12.73"/><path d="M8.46 8.46a5 5 0 0 0 0 7.08"/><path d="M15.54 8.46a5 5 0 0 1 0 7.08"/></svg>`;

  // Friend-add prompt banner: shown after a non-friend accepts an invite via /i/<token>.
  // Clears itself when the user picks Add or Not now (state in window + localStorage).
  let friendPromptHtml = '';
  const fp = (typeof window !== 'undefined') ? window._pendingFriendPrompt : null;
  if (fp && fp.inviterId) {
    const nameDisp = (fp.inviterName || '').replace(/[<>"]/g, '');
    friendPromptHtml = `
      <div class="friend-prompt-banner" id="friend-prompt-banner">
        <span class="friend-prompt-banner-text">${t('friend_prompt_after_accept', { name: nameDisp || '…' })}</span>
        <button class="friend-prompt-banner-add"  onclick="_handleFriendPromptAdd('${fp.inviterId}')">${t('friend_prompt_add')}</button>
        <button class="friend-prompt-banner-skip" onclick="_handleFriendPromptDismiss('${fp.inviterId}')">${t('friend_prompt_dismiss')}</button>
      </div>`;
  }

  return `
    <div class="social-card">
      ${friendPromptHtml}
      ${friendsHtml}
      <div class="social-btns">
        <button class="social-btn social-btn-invite" onclick="_openInviteSheet(${v.id})">
          ${inviteSvg}
          <span>${t('invite_friends')}</span>
        </button>
        <button class="social-btn social-btn-here${isCheckedInHere ? ' social-btn-active' : ''}" onclick="_toggleCheckin(${v.id})">
          ${beaconSvg}
          <span>${t('im_here')}</span>
        </button>
      </div>
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

/** Build the confirmation sentence for the invite. */
function _fmtInviteConfirm(venueName, dateStr, hour) {
  const dateLabel = _fmtInviteDate(dateStr);
  const timeLabel = typeof formatHour === 'function' ? formatHour(hour) : `${Math.floor(hour)}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`;
  return t('invite_confirm', { venue: venueName, date: dateLabel, time: timeLabel });
}

/** Open the invite sheet — compact overlay with inline date/time controls. */
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
  const friendRows = friends.map(f => {
    const avatar = f.avatar_url
      ? `<img class="invite-friend-avatar" src="${f.avatar_url}" alt="">`
      : `<div class="invite-friend-avatar invite-friend-init">${(f.name || f.email)[0].toUpperCase()}</div>`;
    return `<label class="invite-friend-row">
      <input type="checkbox" value="${f.id}">
      ${avatar}
      <span class="invite-friend-name">${f.name || f.email}</span>
    </label>`;
  }).join('');

  const shareSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;
  const sendSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  const calSvg = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="3" width="13" height="11.5" rx="2" stroke="currentColor" stroke-width="1.5"/><line x1="5" y1="1.5" x2="5" y2="4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="11" y1="1.5" x2="11" y2="4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  // Read current time from the main slider
  const curDate = typeof datePicker !== 'undefined' ? datePicker.value : new Date().toISOString().slice(0, 10);
  const curHour = typeof timeFromEl !== 'undefined' ? parseFloat(timeFromEl.value) : new Date().getHours();

  // Build overlay
  const overlay = document.createElement('div');
  overlay.id = 'invite-sheet-backdrop';
  overlay.className = 'invite-backdrop';
  overlay.onclick = e => { if (e.target === overlay) _closeInviteSheet(); };

  const sheet = document.createElement('div');
  sheet.id = 'invite-sheet';
  sheet.className = 'invite-sheet';
  sheet.innerHTML = `
    <div class="invite-sheet-header">
      <div>
        <div class="invite-sheet-title">${t('invite_friends')}</div>
        <div class="invite-sheet-venue">${venueName}</div>
      </div>
      <button class="invite-sheet-close" onclick="_closeInviteSheet()" aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/></svg>
      </button>
    </div>
    <div class="invite-sheet-body">
      <div class="invite-confirm-text" id="invite-confirm-label">${_fmtInviteConfirm(venueName, curDate, curHour)}</div>
      <div class="invite-time-controls">
        <button class="invite-date-btn" id="invite-date-btn">
          ${calSvg}
          <span id="invite-date-label">${_fmtInviteDate(curDate)}</span>
        </button>
        <div class="invite-slider-wrap">
          <input type="range" id="invite-time-slider" min="6" max="23" step="0.25" value="${curHour}" class="invite-time-range">
          <span class="invite-time-readout" id="invite-time-readout">${typeof formatHour === 'function' ? formatHour(curHour) : ''}</span>
        </div>
      </div>
      <div class="invite-time-hint">${t('invite_time_hint')}</div>
      ${hasFriends ? `
        <div class="invite-friends-list">
          ${friendRows}
        </div>` : ''}
    </div>
    <div class="invite-sheet-footer">
      ${hasFriends ? `
        <button class="invite-send-btn" onclick="_sendInvite(${venueId})">
          ${sendSvg}
          <span>${t('send_invite')}</span>
        </button>
        <button class="invite-share-link" onclick="_shareInviteLink(${venueId})">
          ${shareSvg}
          <span>${t('share_link')}</span>
        </button>` : `
        <button class="invite-send-btn" onclick="_shareInviteLink(${venueId})">
          ${shareSvg}
          <span>${t('share_link')}</span>
        </button>`}
    </div>`;

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  // Wire up inline date picker
  const inviteDateBtn = sheet.querySelector('#invite-date-btn');
  const _inviteDateInput = document.createElement('input');
  _inviteDateInput.type = 'date';
  _inviteDateInput.value = curDate;
  _inviteDateInput.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none;';
  inviteDateBtn.appendChild(_inviteDateInput);
  inviteDateBtn.onclick = () => _inviteDateInput.showPicker?.() || _inviteDateInput.click();
  _inviteDateInput.addEventListener('change', () => {
    const dateLbl = sheet.querySelector('#invite-date-label');
    if (dateLbl) dateLbl.textContent = _fmtInviteDate(_inviteDateInput.value);
    _updateInviteConfirm();
  });

  // Wire up inline time slider
  const inviteSlider = sheet.querySelector('#invite-time-slider');
  const inviteReadout = sheet.querySelector('#invite-time-readout');
  inviteSlider.addEventListener('input', () => {
    const h = parseFloat(inviteSlider.value);
    if (inviteReadout && typeof formatHour === 'function') inviteReadout.textContent = formatHour(h);
    _updateInviteConfirm();
  });

  // Store venue name for confirm updates
  sheet._venueName = venueName;

  function _updateInviteConfirm() {
    const lbl = sheet.querySelector('#invite-confirm-label');
    if (lbl) {
      const d = _inviteDateInput.value;
      const h = parseFloat(inviteSlider.value);
      lbl.textContent = _fmtInviteConfirm(sheet._venueName, d, h);
    }
  }

  // Animate in
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    sheet.classList.add('open');
  });
}

function _closeInviteSheet() {
  const overlay = document.getElementById('invite-sheet-backdrop');
  const sheet = document.getElementById('invite-sheet');
  if (sheet) {
    if (sheet._sliderCleanup) sheet._sliderCleanup();
    sheet.classList.remove('open');
  }
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
  }
}

/** Send invite to selected friends (or broadcast to all if none selected). */
/** Read invite sheet's own date/time controls, falling back to main slider. */
function _getInviteDateTime() {
  const dateInput = document.querySelector('#invite-sheet .invite-date-btn input[type="date"]');
  const slider = document.getElementById('invite-time-slider');
  const d = dateInput ? dateInput.value : (typeof datePicker !== 'undefined' ? datePicker.value : new Date().toISOString().slice(0, 10));
  const h = slider ? parseFloat(slider.value) : (typeof timeFromEl !== 'undefined' ? parseFloat(timeFromEl.value) : new Date().getHours());
  return { d, h };
}

async function _sendInvite(venueId) {
  const { d, h } = _getInviteDateTime();
  const hInt = Math.floor(h);
  const mInt = Math.round((h - hInt) * 60);
  const isoTime = new Date(`${d}T${String(hInt).padStart(2,'0')}:${String(mInt).padStart(2,'0')}:00`).toISOString();

  const allFriends = (typeof _friends !== 'undefined') ? _friends : [];
  const checks = document.querySelectorAll('#invite-sheet .invite-friend-row input:checked');
  const selectedIds = [];
  checks.forEach(cb => selectedIds.push(cb.value));
  const explicitlySelected = selectedIds.length > 0;
  // Nothing selected → treat as broadcast to everyone (existing behavior)
  const friendIds = explicitlySelected ? selectedIds : allFriends.map(f => f.id);

  await createPlan(venueId, isoTime, '', friendIds);
  _closeInviteSheet();

  // Follow-up nudge: if the user explicitly picked a subset, suggest sharing
  // a link with the rest. Only fires when there's at least one unselected
  // friend, otherwise it's noise.
  if (explicitlySelected && allFriends.length > selectedIds.length) {
    const selectedSet = new Set(selectedIds);
    const remaining = allFriends.filter(f => !selectedSet.has(f.id));
    setTimeout(() => _queueTellMoreFriendsNudge(venueId, remaining.length), 4500);
  }
}

/** Queue a P2 social toast suggesting a broadcast share-link to remaining friends. */
function _queueTellMoreFriendsNudge(venueId, remainingCount) {
  if (typeof _notifEnqueue !== 'function') return;
  if (typeof _notifAdvance !== 'function') return;
  _notifEnqueue({
    id: 'social_tell_more_' + venueId + '_' + Date.now(),
    priority: 2,
    category: 'social',
    icon: '👋',
    bodyKey: 'notif_tell_more_body',
    bodyVars: { count: remainingCount },
    actionKey: 'notif_tell_more_action',
    action: () => {
      if (typeof _aTrack === 'function') _aTrack('tell_more_nudge', { action: 'shared', remaining: remainingCount });
      if (typeof _shareInviteLink === 'function') _shareInviteLink(venueId);
    },
    ttl: 60000,
    dedupe: true,
  });
  if (typeof _aTrack === 'function') _aTrack('tell_more_nudge', { action: 'queued', remaining: remainingCount });
  _notifAdvance();
}

/** Compose the share-text body for an invite at venue+date+hour. */
function _composeInviteShareText(v, d, h) {
  const venueName = v?.name || '';
  const timeLabel = typeof formatHour === 'function' ? formatHour(h) : '';
  let sunUntil = null;
  if (v && typeof computeSunWindows === 'function') {
    const { windows } = computeSunWindows(v, d) || {};
    if (windows && windows.length) {
      // Active window covering h, else the next window after h
      const cur  = windows.find(w => h >= w.start && h < w.end);
      const next = !cur ? windows.find(w => w.start > h) : null;
      const win  = cur || next;
      if (win && typeof formatHour === 'function') sunUntil = formatHour(win.end);
    }
  }
  return sunUntil
    ? t('share_invite_text',        { venue: venueName, time: timeLabel, sunUntil })
    : t('share_invite_text_no_sun', { venue: venueName, time: timeLabel });
}

/** Share an invite link via native share or clipboard.
 *  Eagerly creates an "open" plan so the receiver becomes a tracked invitee
 *  when they tap "I'm in" in the preview takeover. plan_id is embedded as `p`
 *  in the token so the receiver doesn't need a follow-up lookup.
 */
async function _shareInviteLink(venueId) {
  const { d, h } = _getInviteDateTime();
  const hInt = Math.floor(h);
  const mInt = Math.round((h - hInt) * 60);
  const timeVal = `${d}T${String(hInt).padStart(2,'0')}:${String(mInt).padStart(2,'0')}`;
  const isoTime = new Date(`${d}T${String(hInt).padStart(2,'0')}:${String(mInt).padStart(2,'0')}:00`).toISOString();
  const user = typeof authCurrentUser === 'function' ? authCurrentUser() : null;
  if (!user) return;

  // Create an "open" plan so anyone clicking the link becomes a tracked invitee.
  let planId = null;
  try {
    if (typeof _supabase !== 'undefined') {
      const { data: plan } = await _supabase
        .from('plans')
        .insert({
          creator_id: user.id,
          venue_id:   String(venueId),
          planned_at: isoTime,
          message:    '',
        })
        .select('id')
        .single();
      if (plan && plan.id) planId = plan.id;
      if (typeof loadPlans === 'function') loadPlans(); // refresh local cache
    }
  } catch (e) { /* ignore — share still works without a plan id */ }

  const tokenData = { u: user.id, v: venueId, t: timeVal };
  if (planId) tokenData.p = planId;
  const data = btoa(JSON.stringify(tokenData));
  // Prefer path-form `/i/<token>` (server-rendered OG preview); SPA route `#invite/...` still works
  const url = `${location.origin}${location.pathname.replace(/\/$/, '')}/i/${data}`;
  const v = typeof VENUES !== 'undefined' ? VENUES.find(x => x.id === venueId) : null;
  const text = _composeInviteShareText(v, d, h);
  if (navigator.share) {
    navigator.share({
      title: v ? `${v.name} — ${t('invite_friends')}` : t('invite_friends'),
      text,
      url,
    }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(`${text}\n${url}`);
    if (typeof _showToast === 'function') _showToast(t('invite_link_copied'));
  }
}

/** Helper: render sun/cloud timeline segments for detail panel (10px track). */
function renderSunTimelineSegments(windows, fromHour) {
  const START_H = 6, END_H = 22, RANGE = END_H - START_H;
  let segments = '';

  for (const w of windows) {
    const sPos = Math.max(0, Math.min(100, ((Math.max(w.start, START_H) - START_H) / RANGE) * 100));
    const ePos = Math.max(0, Math.min(100, ((Math.min(w.end, END_H) - START_H) / RANGE) * 100));
    if (ePos > sPos) {
      segments += `<div class="big-timeline-sun" style="left:${sPos}%;width:${ePos-sPos}%"></div>`;
    }
  }

  return segments;
}

