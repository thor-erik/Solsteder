/**
 * render-sunbar.js — HTML/CSS sun bar for the share composer.
 *
 * Lightweight horizontal timeline showing today's sun window for a venue.
 * No canvas — pure DOM with CSS-variable-driven gradient stops, so the pin
 * and now indicator can be moved by mutating two custom properties without
 * a full repaint. Used only by the share composer; the invite-received hero
 * reuses the existing card-timeline canvas (drawAllCardTimelines).
 *
 * Globals: VENUES, computeSunWindows (app.js), MIN_H_ARC, MAX_H_ARC.
 */

/**
 * Build the sun bar HTML.
 * @param {object} venue
 * @param {string} dateStr   YYYY-MM-DD
 * @param {number} fromHour  arrival hour (decimal)
 * @returns {string} HTML
 */
function renderInviteSunBar(venue, dateStr, fromHour) {
  const minH = (typeof MIN_H_ARC === 'number') ? MIN_H_ARC : 4;
  const maxH = (typeof MAX_H_ARC === 'number') ? MAX_H_ARC : 23;
  const span = Math.max(0.0001, maxH - minH);

  let sunStart = null, sunEnd = null;
  try {
    if (typeof computeSunWindows === 'function' && venue) {
      const sw = computeSunWindows(venue, dateStr);
      const ws = sw && sw.windows ? sw.windows : [];
      if (ws.length) {
        sunStart = ws[0].start;
        sunEnd   = ws[ws.length - 1].end;
      }
    }
  } catch (e) { /* ignore — bar will render shadow-only */ }

  // Use a one-decimal "now" indicator at the current FTS time (not server now)
  // so the bar matches whatever the user is scrubbing to.
  const nowH = (typeof timeFromEl !== 'undefined' && timeFromEl)
    ? parseFloat(timeFromEl.value) : fromHour;

  const pct = (h) => Math.max(0, Math.min(100, ((h - minH) / span) * 100));

  const sunStartPct = sunStart != null ? pct(sunStart) : 50;
  const sunEndPct   = sunEnd   != null ? pct(sunEnd)   : 50;
  const nowPct      = pct(nowH);
  const arrPct      = pct(fromHour);
  const hasSun      = sunStart != null && sunEnd != null && sunEnd > sunStart;

  // Hour ticks every 2 hours within range.
  const ticks = [];
  for (let h = Math.ceil(minH / 2) * 2; h <= maxH; h += 2) {
    ticks.push(`<div class="dpinvite-sunbar-tick" style="left:${pct(h)}%"></div>`);
  }

  return `
    <div class="dpinvite-sunbar"
         style="--sun-start-pct:${sunStartPct}%;--sun-end-pct:${sunEndPct}%;--now-pct:${nowPct}%;--arrival-pct:${arrPct}%">
      <div class="dpinvite-sunbar-shadow dpinvite-sunbar-shadow-pre"></div>
      ${hasSun ? `
        <div class="dpinvite-sunbar-band"></div>
        <div class="dpinvite-sunbar-cap dpinvite-sunbar-cap-l"></div>
        <div class="dpinvite-sunbar-cap dpinvite-sunbar-cap-r"></div>
      ` : ''}
      <div class="dpinvite-sunbar-shadow dpinvite-sunbar-shadow-post"></div>
      ${ticks.join('')}
      <div class="dpinvite-sunbar-now"></div>
      <div class="dpinvite-sunbar-pin"></div>
    </div>`;
}

/**
 * Cheap pin-only update — mutates --arrival-pct + --now-pct in place.
 * Use this when only the time changed (no need to re-derive sun windows).
 */
function updateInviteSunBarPin(rootEl, fromHour) {
  if (!rootEl) return;
  const minH = (typeof MIN_H_ARC === 'number') ? MIN_H_ARC : 4;
  const maxH = (typeof MAX_H_ARC === 'number') ? MAX_H_ARC : 23;
  const span = Math.max(0.0001, maxH - minH);
  const pct = (h) => Math.max(0, Math.min(100, ((h - minH) / span) * 100));
  const nowH = (typeof timeFromEl !== 'undefined' && timeFromEl)
    ? parseFloat(timeFromEl.value) : fromHour;
  rootEl.style.setProperty('--arrival-pct', `${pct(fromHour)}%`);
  rootEl.style.setProperty('--now-pct', `${pct(nowH)}%`);
}

if (typeof window !== 'undefined') {
  window.renderInviteSunBar = renderInviteSunBar;
  window.updateInviteSunBarPin = updateInviteSunBarPin;
}
