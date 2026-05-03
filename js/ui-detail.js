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
  }

  const inviteSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;
  // Beacon icon: dot with signal arcs
  const beaconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M5.64 5.64a9 9 0 0 0 0 12.73"/><path d="M18.36 5.64a9 9 0 0 1 0 12.73"/><path d="M8.46 8.46a5 5 0 0 0 0 7.08"/><path d="M15.54 8.46a5 5 0 0 1 0 7.08"/></svg>`;

  // Post-accept prompts (friend-add + share-nudge) used to render as banners
  // here in the social-card. They now slide up as a dedicated question panel
  // (_openPostAcceptPanel) right after closePlanPreview, so the social-card
  // stays focused on the venue's persistent social context.

  return `
    <div class="social-card">
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

// ── Post-accept question panel ────────────────────────────────────────────────

/** Build the queue of post-accept questions from context. Filters out anything
 *  that doesn't apply (no friend-prompt = skip friend question; share-nudge
 *  only fires when receiver is friends with inviter; calendar always offered).
 *  Order: friend-add first (highest social value), then calendar, then share. */
function _buildPostAcceptQueue(opts) {
  const queue = [];
  const fp = (typeof window !== 'undefined') ? window._pendingFriendPrompt : null;
  const sn = (typeof window !== 'undefined') ? window._pendingShareNudge : null;

  if (fp && fp.inviterId && fp.inviterName) {
    queue.push({
      type: 'friend',
      icon: '👥',
      titleKey: 'pap_q_friend_title',
      subKey:   'pap_q_friend_sub',
      primaryKey: 'pap_q_friend_primary',
      titleVars: { name: (fp.inviterName || '').replace(/[<>"]/g, '') },
      onPrimary: () => _handleFriendPromptAdd(fp.inviterId),
      onSkip:    () => _handleFriendPromptDismiss(fp.inviterId),
    });
  }
  // Calendar is always offered when we have a venue + plannedAt. Inviter name
  // (passed from openPlanPreview's accept handler) flows through to the .ics
  // SUMMARY as "{venue} with {inviter}".
  if (opts.venueId && opts.plannedAt) {
    queue.push({
      type: 'calendar',
      icon: '📅',
      titleKey: 'pap_q_calendar_title',
      subKey:   'pap_q_calendar_sub',
      primaryKey: 'pap_q_calendar_primary',
      onPrimary: () => _handleCalendarAdd(opts.venueId, opts.inviterName),
      onSkip:    () => {},
    });
  }
  if (sn && String(sn.venueId) === String(opts.venueId)) {
    queue.push({
      type: 'share',
      icon: '🔗',
      titleKey: 'pap_q_share_title',
      subKey:   'pap_q_share_sub',
      primaryKey: 'pap_q_share_primary',
      onPrimary: () => _handleShareNudgeShare(opts.venueId),
      onSkip:    () => _handleShareNudgeDismiss(),
    });
  }
  return queue;
}

/** Open the post-accept question panel. Slides up from the bottom over the
 *  detail panel (which is in peek state) + map. Sequential question carousel:
 *  user answers/skips → auto-advance → close after the last question. */
function _openPostAcceptPanel(opts) {
  const existing = document.getElementById('post-accept-overlay');
  if (existing) existing.remove();

  const queue = _buildPostAcceptQueue(opts);
  if (!queue.length) return;

  const venueName = opts.venueName || '';
  const subtitle = (venueName && opts.whenLabel)
    ? t('pap_subtitle', { venue: venueName, when: opts.whenLabel })
    : (venueName || '');

  const overlay = document.createElement('div');
  overlay.id = 'post-accept-overlay';
  overlay.className = 'post-accept-overlay';
  overlay.onclick = e => { if (e.target === overlay) _closePostAcceptPanel(); };

  const panel = document.createElement('div');
  panel.id = 'post-accept-panel';
  panel.className = 'post-accept-panel';
  panel._queue = queue;
  panel._idx = 0;

  panel.innerHTML = `
    <div class="pap-grabber" aria-hidden="true"></div>
    <div class="pap-header">
      <div>
        <div class="pap-title">${t('pap_title')}</div>
        ${subtitle ? `<div class="pap-subtitle">${subtitle}</div>` : ''}
      </div>
      <button class="pap-close" onclick="_closePostAcceptPanel()" aria-label="${t('close') || 'Close'}">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/></svg>
      </button>
    </div>
    <div class="pap-progress" id="pap-progress"></div>
    <div class="pap-body" id="pap-body"></div>`;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  _renderPostAcceptCard();

  requestAnimationFrame(() => {
    overlay.classList.add('open');
    panel.classList.add('open');
  });
}

/** Render the current question card + progress dots. Called on open and on
 *  each advance. Skips the dots when there's only one question. */
function _renderPostAcceptCard() {
  const panel = document.getElementById('post-accept-panel');
  if (!panel) return;
  const queue = panel._queue || [];
  const idx = panel._idx || 0;
  const q = queue[idx];
  if (!q) { _closePostAcceptPanel(); return; }

  const progressEl = panel.querySelector('#pap-progress');
  if (progressEl) {
    if (queue.length <= 1) {
      progressEl.innerHTML = '';
    } else {
      progressEl.innerHTML = queue.map((_, i) =>
        `<span class="pap-dot${i === idx ? ' pap-dot-active' : ''}${i < idx ? ' pap-dot-done' : ''}"></span>`
      ).join('');
    }
  }

  const titleVars = q.titleVars || {};
  const bodyEl = panel.querySelector('#pap-body');
  if (bodyEl) {
    bodyEl.innerHTML = `
      <div class="pap-card">
        <div class="pap-icon" aria-hidden="true">${q.icon}</div>
        <div class="pap-q-title">${t(q.titleKey, titleVars)}</div>
        <div class="pap-q-sub">${t(q.subKey)}</div>
        <button class="pap-q-primary" onclick="_postAcceptAnswer(true)">${t(q.primaryKey)}</button>
        <button class="pap-q-skip" onclick="_postAcceptAnswer(false)">${t('pap_q_skip')}</button>
      </div>`;
  }
}

/** Apply the current question's primary or skip action, then advance. */
function _postAcceptAnswer(isPrimary) {
  const panel = document.getElementById('post-accept-panel');
  if (!panel) return;
  const queue = panel._queue || [];
  const idx = panel._idx || 0;
  const q = queue[idx];
  if (q) {
    try {
      if (isPrimary) q.onPrimary && q.onPrimary();
      else           q.onSkip    && q.onSkip();
      if (typeof _aTrack === 'function') _aTrack('post_accept_answer', { type: q.type, action: isPrimary ? 'primary' : 'skip' });
    } catch (e) { /* never block the carousel on a handler failure */ }
  }
  panel._idx = idx + 1;
  if (panel._idx >= queue.length) {
    _closePostAcceptPanel();
  } else {
    _renderPostAcceptCard();
  }
}

function _closePostAcceptPanel() {
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
 *  preview and avatar-tap friend selection. */
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
  const SHOW_SEARCH_AT = 6;

  const checkSvg = `<svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 7 6 11 12 3"/></svg>`;
  // Stable color index (0–7) hashed from friend id so the initials-circle
  // fallback feels intentional — two "E"s won't collide and the same friend
  // keeps the same color across reloads.
  const _hashColor = (s) => {
    s = String(s || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 8;
  };
  const friendTiles = friends.map(f => {
    const fullName = f.name || f.email || '';
    const firstName = fullName.split(/\s+/)[0] || fullName || '?';
    const initial = (fullName || '?')[0].toUpperCase();
    const colorIdx = _hashColor(f.id);
    const avatar = f.avatar_url
      ? `<img class="invite-friend-avatar" src="${f.avatar_url}" alt="">`
      : `<div class="invite-friend-avatar invite-friend-init init-color-${colorIdx}">${initial}</div>`;
    const safeFull = fullName.replace(/"/g, '&quot;');
    const safeFirst = firstName.replace(/</g, '&lt;');
    return `<button type="button" class="invite-friend-tile" role="checkbox" aria-checked="false" aria-label="${safeFull}" data-friend-id="${f.id}" data-friend-name="${safeFull}" onclick="_toggleInviteFriend(this)">
      <span class="invite-friend-avatar-wrap">
        ${avatar}
        <span class="invite-friend-check" aria-hidden="true">${checkSvg}</span>
      </span>
      <span class="invite-friend-name">${safeFirst}</span>
    </button>`;
  }).join('');

  const shareSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;
  const sendSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
  const noFriendsSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;

  // Read current time from the main pickers — these stay the source of truth
  // while the sheet is open, so we don't duplicate controls inside the sheet.
  const curDate = typeof datePicker !== 'undefined' ? datePicker.value : new Date().toISOString().slice(0, 10);
  const curHour = typeof timeFromEl !== 'undefined' ? parseFloat(timeFromEl.value) : new Date().getHours();

  const previewText = v ? _composeInviteShareText(v, curDate, curHour) : '';

  // Build overlay
  const overlay = document.createElement('div');
  overlay.id = 'invite-sheet-backdrop';
  overlay.className = 'invite-backdrop';
  overlay.onclick = e => { if (e.target === overlay) _closeInviteSheet(); };

  const sheet = document.createElement('div');
  sheet.id = 'invite-sheet';
  sheet.className = 'invite-sheet';

  const friendsBlock = hasFriends ? `
        <div class="invite-friends-header">
          <span class="invite-friends-count" id="invite-friends-count"></span>
          <button class="invite-friends-toggle" id="invite-toggle-all" type="button" onclick="_toggleAllInviteFriends()">${t('invite_select_all')}</button>
        </div>
        ${friends.length > SHOW_SEARCH_AT ? `<input type="text" class="invite-friend-search" id="invite-friend-search" placeholder="${t('invite_friend_search_placeholder')}" oninput="_filterInviteFriends(this.value)">` : ''}
        <div class="invite-friends-list">
          ${friendTiles}
        </div>` : `
        <div class="invite-empty-card">
          <div class="invite-empty-icon">${noFriendsSvg}</div>
          <div class="invite-empty-title">${t('invite_no_friends_title')}</div>
          <div class="invite-empty-sub">${t('invite_no_friends_sub')}</div>
        </div>`;

  // Action row: primary always present, secondary appears when 1+ selected.
  // With 0 selected, primary IS "Del lenke" (filled coral). With 1+ selected,
  // primary becomes "Send til X" and "Del lenke" reappears as a glass-action
  // secondary alongside it. Avoids the disabled-button confusion where the
  // disabled coral primary visually outranked the enabled glass secondary.
  const actionRow = hasFriends ? `
      <div class="invite-action-row">
        <button class="invite-send-btn" id="invite-primary-btn" data-mode="share" onclick="_invitePrimaryClick(${venueId})">
          <span id="invite-primary-icon">${shareSvg}</span>
          <span id="invite-primary-label">${t('share_link')}</span>
        </button>
        <button class="invite-share-link" id="invite-secondary-btn" type="button" onclick="_shareInviteLink(${venueId})" hidden>
          ${shareSvg}
          <span>${t('share_link')}</span>
        </button>
      </div>` : `
      <div class="invite-action-row">
        <button class="invite-send-btn" onclick="_shareInviteLink(${venueId})">
          ${shareSvg}
          <span>${t('share_link')}</span>
        </button>
      </div>`;

  // Sheet markup — grabber + body, body in the new content order:
  //   1. Bubble preview (the receiver-perspective text — visual focus)
  //   2. FTS slot (host for reparented #fts pill — refines time)
  //   3. Friends block (count + toggle, optional search, avatar grid)
  //   4. Action row (primary send/share, optional secondary)
  // Header (title + close) is gone — backdrop tap, drag-to-dismiss grabber, and
  // Escape handle dismissal. Bubble caption + FTS label + actions hint are also
  // dropped to fit the sheet under 50svh; the venue card pinned at the top of
  // the screen carries the contextual "what venue, when" hierarchy.
  sheet.innerHTML = `
    <div class="invite-sheet-grabber" aria-hidden="true"></div>
    <div class="invite-sheet-body">
      <div class="invite-bubble" id="invite-message-preview-text">${previewText}</div>
      <div class="invite-fts-slot"></div>
      ${friendsBlock}
      ${actionRow}
    </div>`;

  // Floating top card: same compact venue card, pinned to top of viewport.
  // Sibling of the sheet (NOT inside it) so it stays put while the sheet
  // animates / scrolls. Lifecycle tied to the sheet — created here, removed
  // on _closeInviteSheet. aria-hidden because it duplicates context already
  // present in the bubble preview text.
  const topCard = document.createElement('div');
  topCard.id = 'invite-top-card';
  topCard.className = 'invite-top-card';
  topCard.setAttribute('aria-hidden', 'true');
  if (typeof renderVenueCardCompact === 'function') {
    topCard.innerHTML = renderVenueCardCompact(v, curDate, curHour);
  }

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  document.body.appendChild(topCard);

  // Update venue card + preview from the MAIN datePicker/timeFromEl. We don't
  // duplicate controls in the sheet — the existing bottom qc-wrap stays visible
  // above the (lighter) backdrop and acts as the single source of truth.
  sheet._venueName = venueName;
  sheet._venueId = venueId;
  sheet._venue = v;
  sheet._friendCount = friends.length;
  function _updateInviteConfirm() {
    const d = (typeof datePicker !== 'undefined') ? datePicker.value : curDate;
    const h = (typeof timeFromEl !== 'undefined') ? parseFloat(timeFromEl.value) : curHour;
    if (v && typeof renderVenueCardCompact === 'function' && document.body.contains(topCard)) {
      topCard.innerHTML = renderVenueCardCompact(v, d, h);
    }
    const prev = sheet.querySelector('#invite-message-preview-text');
    if (prev && v) prev.textContent = _composeInviteShareText(v, d, h);
  }
  const onTimeInput = () => _updateInviteConfirm();
  const onDateChange = () => _updateInviteConfirm();
  if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.addEventListener('input', onTimeInput);
  if (typeof datePicker !== 'undefined' && datePicker) datePicker.addEventListener('change', onDateChange);
  // Escape closes the sheet — backdrop tap and drag-down on the grabber are the
  // other dismissal paths (no X close button in the new compact design).
  const onEsc = (e) => { if (e.key === 'Escape') _closeInviteSheet(); };
  document.addEventListener('keydown', onEsc);
  sheet._sliderCleanup = () => {
    if (typeof timeFromEl !== 'undefined' && timeFromEl) timeFromEl.removeEventListener('input', onTimeInput);
    if (typeof datePicker !== 'undefined' && datePicker) datePicker.removeEventListener('change', onDateChange);
    document.removeEventListener('keydown', onEsc);
  };

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

  document.body.classList.add('invite-sheet-open');

  // Reparent the live #fts (floating time slider with sun-arc + weather)
  // into the sheet's slot so the sender can scrub time/date without closing
  // the sheet. Mirrors the plan-preview pattern (_ppFtsAttach). The shared
  // timeFromEl + datePicker means the existing onTimeInput/onDateChange
  // handlers above already pick up scrub changes — no additional wiring.
  _invFtsAttach();

  // Animate in — backdrop fades, sheet slides up from bottom, top card slides
  // down from above the viewport. All three happen in the same frame so the
  // motion reads as a single coordinated entrance.
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    sheet.classList.add('open');
    topCard.classList.add('open');
  });
}

/** Reparent #fts into the invite sheet's slot. CSS rule with .fts-in-invite
 *  flattens position and width to fill the slot. drawFtsCanvas re-renders at
 *  the new size. _syncFtsPosition skips while fts-in-invite is set. */
function _invFtsAttach() {
  const fts = document.getElementById('fts');
  const slot = document.querySelector('#invite-sheet .invite-fts-slot');
  if (!fts || !slot) return;
  // Lift cleanly from any other dock (detail-panel card, plan-preview slot)
  fts.classList.remove('fts-in-card', 'fts-in-preview');
  fts.style.cssText = '';
  fts.classList.add('fts-in-invite');
  slot.appendChild(fts);
  // Reparent the scrub popup alongside the FTS so its offsetLeft-based
  // positioning math (showFtsPopup in app.js) lands at the right viewport
  // coordinates. Without this, the popup tries to position relative to body
  // while the FTS thumb lives inside the sheet — popup ends up off-screen.
  const popup = document.getElementById('fts-popup');
  if (popup) {
    popup.style.cssText = '';
    popup.classList.add('fts-popup-in-invite');
    slot.appendChild(popup);
  }
  requestAnimationFrame(() => {
    if (typeof drawFtsCanvas === 'function') drawFtsCanvas();
  });
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

/** Toggle a single friend row's selection (avatar-tap pattern, no checkbox). */
function _toggleInviteFriend(row) {
  if (!row) return;
  const next = row.getAttribute('aria-checked') !== 'true';
  row.setAttribute('aria-checked', next ? 'true' : 'false');
  _refreshInvitePrimaryCTA();
}

/** Select-all / clear toggle in the friends-section header. */
function _toggleAllInviteFriends() {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const visibleRows = Array.from(sheet.querySelectorAll('.invite-friend-tile')).filter(r => !r.hidden);
  if (!visibleRows.length) return;
  const anyUnchecked = visibleRows.some(r => r.getAttribute('aria-checked') !== 'true');
  visibleRows.forEach(r => r.setAttribute('aria-checked', anyUnchecked ? 'true' : 'false'));
  _refreshInvitePrimaryCTA();
}

/** Filter the friends list by a substring of name/email. */
function _filterInviteFriends(query) {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const q = (query || '').trim().toLowerCase();
  const rows = sheet.querySelectorAll('.invite-friend-tile');
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

/** Update the primary CTA (morphing label/icon/mode + select-all toggle text)
 *  based on current selection. Called on every selection change. */
function _refreshInvitePrimaryCTA() {
  const sheet = document.getElementById('invite-sheet');
  if (!sheet) return;
  const total = sheet._friendCount || 0;
  if (total === 0) return; // empty state has no primary-cta to update

  const allRows = Array.from(sheet.querySelectorAll('.invite-friend-tile'));
  const selectedRows = allRows.filter(r => r.getAttribute('aria-checked') === 'true');
  const n = selectedRows.length;

  const btn = sheet.querySelector('#invite-primary-btn');
  const label = sheet.querySelector('#invite-primary-label');
  const icon  = sheet.querySelector('#invite-primary-icon');
  const secondary = sheet.querySelector('#invite-secondary-btn');
  if (btn && label) {
    if (n === 0) {
      // 0 selected → primary IS "Del lenke" (no disabled state, no helper noise).
      btn.setAttribute('data-mode', 'share');
      label.textContent = t('share_link');
      if (icon) icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>`;
      if (secondary) secondary.hidden = true;
    } else {
      // 1+ selected → primary becomes "Send til X" and the secondary "Del lenke"
      // surfaces alongside.
      btn.setAttribute('data-mode', 'send');
      if (icon) icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
      if (n === 1) {
        const name = selectedRows[0].getAttribute('data-friend-name') || '';
        const firstName = name.split(/\s+/)[0] || name;
        label.textContent = t('invite_send_to_one', { name: firstName });
      } else if (n === total) {
        label.textContent = t('invite_send_to_all', { n });
      } else {
        label.textContent = t('invite_send_to_many', { n });
      }
      if (secondary) secondary.hidden = false;
    }
  }

  // Section header — title shows the count fragment ("· 3 av 4" / "· alle valgt"),
  // toggle button always shows the action ("Velg alle" / "Fjern alle"). Splitting
  // state from action makes both clearer than the previous combined label.
  const visibleRows = allRows.filter(r => !r.hidden);
  const visibleSelected = visibleRows.filter(r => r.getAttribute('aria-checked') === 'true').length;
  const countEl = sheet.querySelector('#invite-friends-count');
  if (countEl) {
    if (visibleSelected === 0) {
      countEl.textContent = '';
    } else if (visibleSelected === visibleRows.length) {
      countEl.textContent = t('invite_friends_all');
    } else {
      countEl.textContent = t('invite_friends_count', { n: visibleSelected, m: visibleRows.length });
    }
  }
  const toggle = sheet.querySelector('#invite-toggle-all');
  if (toggle) {
    toggle.textContent = (visibleSelected === visibleRows.length && visibleRows.length > 0)
      ? t('invite_clear_all')
      : t('invite_select_all');
  }
}

function _closeInviteSheet() {
  const overlay = document.getElementById('invite-sheet-backdrop');
  const sheet = document.getElementById('invite-sheet');
  const topCard = document.getElementById('invite-top-card');
  if (sheet) {
    if (sheet._sliderCleanup) sheet._sliderCleanup();
    sheet.classList.remove('open');
  }
  // Detach FTS BEFORE the overlay starts removing so the parent path is valid
  // when we move it back to body. updateDetailPanel below will re-dock it
  // into the panel's card timeline slot if a venue is currently selected.
  _invFtsDetach();
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 300);
  }
  if (topCard) {
    topCard.classList.remove('open');
    setTimeout(() => topCard.remove(), 320);
  }
  document.body.classList.remove('invite-sheet-open');
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

  const allFriends = (typeof _friends !== 'undefined') ? _friends : [];
  const selectedIds = Array.from(
    document.querySelectorAll('#invite-sheet .invite-friend-tile[aria-checked="true"]')
  ).map(r => r.getAttribute('data-friend-id'));

  // No silent broadcast — the primary CTA is disabled in this state, but
  // guard defensively in case the handler is invoked some other way.
  if (selectedIds.length === 0) return;

  await createPlan(venueId, isoTime, '', selectedIds);
  _closeInviteSheet();

  // Follow-up nudge: if the user picked a subset, suggest sharing a link with
  // the rest. Only fires when there's at least one unselected friend.
  if (allFriends.length > selectedIds.length) {
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

/** Compose the share-text body for an invite at venue+date+hour. When `link`
 *  is provided, the message includes a "Bli med: {link}" suffix so the URL is
 *  inlined into the body (visible regardless of how the receiving platform
 *  treats Web Share's separate `url` field). Without a link, returns the
 *  body alone — used for the chat-bubble preview in the invite sheet. */
function _composeInviteShareText(v, d, h, link) {
  const venueName = v?.name || '';
  const when = _inviteWhenLabel(d, h);
  const { context, icon } = _composeShareContext(v, d, h);
  const key = link ? 'share_invite_text_w_link' : 'share_invite_text';
  return t(key, { venue: venueName, when, context, icon, link: link || '' });
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
function _shareInviteLink(venueId, overrides = {}) {
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
  if (!user) return;

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
  if (navigator.share) {
    navigator.share({
      title: v ? `${v.name} — ${t('invite_friends')}` : t('invite_friends'),
      text,
    }).catch(err => {
      if (err && err.name !== 'AbortError') console.warn('[share] navigator.share failed:', err);
    });
  } else {
    navigator.clipboard?.writeText(text);
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

