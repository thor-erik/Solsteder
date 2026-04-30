/**
 * ui-plan-preview.js — Full-screen invitation preview takeover.
 *
 * Triggered when:
 *   1. A user lands via a `#invite/<token>` or `/i/<token>` link (mode='invite')
 *   2. A user taps "Preview" on a plan card in the detail panel (mode='preview')
 *
 * The takeover hides app chrome and lets the live map (with shadows) show through.
 * On open it autoplays a 3s time-lapse from the invited hour to the day's last
 * sun, then leaves a draggable scrubber so the user can replay any moment.
 *
 * Depends on: VENUES, computeSunWindows, formatHour, getWeatherAt, timeFromEl,
 *             datePicker, map, getPlansForVenue, respondToPlanInvite, _showToast.
 */

let _planPreviewState = null;

/**
 * Open the full-screen invitation preview.
 * @param {object}        opts
 * @param {string|number} opts.venueId
 * @param {string}        [opts.plannedAt]   - ISO datetime; defaults to current slider time
 * @param {string}        [opts.inviterName] - "{name} inviterer deg" header line
 * @param {string}        [opts.inviteId]    - plan_invites.id, present for accept/decline
 * @param {'invite'|'preview'} [opts.mode='preview']
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

  // Switch app to the plan's date if needed (changes shadow/sun rendering)
  if (datePicker && dateStr && datePicker.value !== dateStr) {
    datePicker.value = dateStr;
    datePicker.dispatchEvent(new Event('change'));
  }
  if (timeFromEl) {
    timeFromEl.value = planHour;
    timeFromEl.dispatchEvent(new Event('input'));
  }

  document.body.classList.add('plan-preview-active');

  // Save current camera so we can restore it on close (so the user isn't left
  // zoomed-in on the preview venue if they came from a city-zoom view).
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

  if (typeof map !== 'undefined' && map && typeof map.flyTo === 'function') {
    map.flyTo({
      center: [venue.lng, venue.lat],
      zoom: 18,
      pitch: 55,
      bearing: 0,
      duration: 1200,
      essential: true,
    });
  }

  const overlay = _ppBuildDom(venue, opts, { planHour, animateTo, dateStr });
  document.body.appendChild(overlay);

  _planPreviewState = {
    overlay,
    venueId:  venue.id,
    savedTime, savedDate, savedCamera,
    planHour, animateTo, dateStr,
    rafId: null,
    autoplayDone: false,
  };

  requestAnimationFrame(() => {
    overlay.classList.add('open');
    if (animateTo > planHour + 0.05) {
      _ppAnimate(planHour, animateTo, 3000);
    }
  });

  if (typeof _aTrack === 'function') {
    _aTrack('plan_preview_opened', { venue_id: venue.id, mode: opts.mode || 'preview' });
  }
}

function closePlanPreview() {
  const st = _planPreviewState;
  if (!st) return;
  if (st.rafId) cancelAnimationFrame(st.rafId);
  if (st.savedDate != null && datePicker && datePicker.value !== st.savedDate) {
    datePicker.value = st.savedDate;
    datePicker.dispatchEvent(new Event('change'));
  }
  if (st.savedTime != null && timeFromEl) {
    timeFromEl.value = st.savedTime;
    timeFromEl.dispatchEvent(new Event('input'));
  }
  if (st.savedCamera && typeof map !== 'undefined' && map && typeof map.flyTo === 'function') {
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
  st.overlay.classList.remove('open');
  document.body.classList.remove('plan-preview-active');
  setTimeout(() => { try { st.overlay.remove(); } catch {} }, 320);
  _planPreviewState = null;
}

function _ppAnimate(fromH, toH, durationMs) {
  const startTs = performance.now();
  function step(now) {
    if (!_planPreviewState) return;
    const t = Math.min(1, (now - startTs) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);  // easeOutCubic
    const h = fromH + (toH - fromH) * eased;
    if (timeFromEl) {
      timeFromEl.value = h;
      timeFromEl.dispatchEvent(new Event('input'));
    }
    const scrubber = document.getElementById('pp-scrubber');
    if (scrubber) scrubber.value = h;
    const readout = document.getElementById('pp-time');
    if (readout && typeof formatHour === 'function') readout.textContent = formatHour(h);
    if (t < 1) {
      _planPreviewState.rafId = requestAnimationFrame(step);
    } else {
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

  const sunRange = (animateTo > planHour + 0.05)
    ? `${formatHour(planHour)} → ${formatHour(animateTo)}`
    : formatHour(planHour);

  // Try to find a matching plan to surface attendees
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

  let ctaHtml = '';
  if (opts.mode === 'invite' && opts.inviteId) {
    ctaHtml = `
      <button class="pp-cta pp-cta-accept" id="pp-accept">${t('plan_preview_im_in')}</button>
      <button class="pp-cta-decline" id="pp-decline">${t('plan_decline')}</button>`;
  } else {
    ctaHtml = `<button class="pp-cta pp-cta-accept" id="pp-close-cta">${t('close')}</button>`;
  }

  const inviterLine = opts.inviterName ? t('inviter_invites_you', { name: opts.inviterName }) : '';

  // Range extends beyond animateTo to give the scrubber a bit of dead space
  const rangeMin = planHour;
  const rangeMax = (animateTo > planHour + 0.05) ? animateTo : Math.min(23, planHour + 2);

  el.innerHTML = `
    <div class="pp-top">
      <button class="pp-back" id="pp-back" aria-label="${t('back')}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="pp-wx">
        <span class="pp-wx-icon">${wxIcon}</span>
        ${wxTemp ? `<span class="pp-wx-temp">${wxTemp}</span>` : ''}
        ${wxDetail ? `<span class="pp-wx-detail">${wxDetail}</span>` : ''}
      </div>
    </div>
    <div class="pp-bottom">
      ${inviterLine ? `<div class="pp-inviter">${inviterLine}</div>` : ''}
      <div class="pp-title">${venue.name}</div>
      ${venue.area ? `<div class="pp-area">${venue.area}</div>` : ''}
      <div class="pp-sunline">
        <span class="pp-sun-icon">☀</span>
        <span class="pp-sun-range">${sunRange}</span>
      </div>
      <div class="pp-scrub-wrap">
        <input type="range" id="pp-scrubber"
               min="${rangeMin.toFixed(2)}"
               max="${rangeMax.toFixed(2)}"
               step="0.05"
               value="${planHour.toFixed(2)}" />
        <span id="pp-time" class="pp-scrub-readout">${formatHour(planHour)}</span>
      </div>
      ${attendeesHtml}
      <div class="pp-cta-row">${ctaHtml}</div>
    </div>`;

  el.querySelector('#pp-back').onclick = () => closePlanPreview();

  const scrubber = el.querySelector('#pp-scrubber');
  const readout  = el.querySelector('#pp-time');
  if (scrubber) {
    const onScrub = () => {
      // User interaction cancels autoplay
      if (_planPreviewState && _planPreviewState.rafId) {
        cancelAnimationFrame(_planPreviewState.rafId);
        _planPreviewState.rafId = null;
        _planPreviewState.autoplayDone = true;
      }
      const h = parseFloat(scrubber.value);
      if (timeFromEl) {
        timeFromEl.value = h;
        timeFromEl.dispatchEvent(new Event('input'));
      }
      if (readout && typeof formatHour === 'function') readout.textContent = formatHour(h);
    };
    scrubber.addEventListener('input', onScrub);
  }

  const acceptBtn = el.querySelector('#pp-accept');
  if (acceptBtn) acceptBtn.onclick = async () => {
    if (typeof respondToPlanInvite === 'function' && opts.inviteId) {
      try { await respondToPlanInvite(opts.inviteId, 'accepted'); } catch (e) { /* ignore */ }
    }
    if (typeof _showToast === 'function') _showToast(t('plan_preview_joined'));
    if (typeof _aTrack === 'function') _aTrack('plan_preview_accept', { venue_id: venue.id });
    closePlanPreview();
  };
  const declineBtn = el.querySelector('#pp-decline');
  if (declineBtn) declineBtn.onclick = async () => {
    if (typeof respondToPlanInvite === 'function' && opts.inviteId) {
      try { await respondToPlanInvite(opts.inviteId, 'declined'); } catch (e) { /* ignore */ }
    }
    if (typeof _aTrack === 'function') _aTrack('plan_preview_decline', { venue_id: venue.id });
    closePlanPreview();
  };
  const closeCta = el.querySelector('#pp-close-cta');
  if (closeCta) closeCta.onclick = () => closePlanPreview();

  return el;
}

window.openPlanPreview  = openPlanPreview;
window.closePlanPreview = closePlanPreview;
