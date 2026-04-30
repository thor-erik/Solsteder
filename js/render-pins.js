/**
 * render-pins.js — Map pins (sprites, layout, animation), main draw loop,
 *                  hit testing, and canvas event handling.
 * Depends on: map, canvas, ctx, currentSun, selectedId, highlight,
 *             editingVenueId, editHoveredWallIdx, VENUES (app.js / data.js)
 *             venueSunState (solar.js)
 *             computeSunWindows, sunScore (app.js / scoring.js)
 *             shortName, fillRoundRect, formatHourAsClock (render-helpers.js)
 *             drawBuildingEditor, editDraggingDepth, editDragWallObj,
 *             _detachedDragging, hitTestDetachedPin, hitTestDepthHandle,
 *             hitTestWall (render-editor.js)
 *             drawSeatingAreas, drawShadowOverlay, shouldShowAtZoom (render-seating.js)
 *             drawSunCurve, drawSunCompass (render-arc.js)
 *             selectVenue, closeDetailPanel, panToVenueCenter,
 *             setDetachedLocation, selectWallByIdx, saveFacingCache (app.js / ui.js)
 *             tooltip, buildTooltipContent (ui.js)
 */

// ── Sprite cache ──────────────────────────────────────────────────────────────
// Pill-shaped pins keyed by tier + icon index + selected + modifier flags.
// buildSprite returns { canvas, anchorX, anchorY, cssW, cssH, pillW, pillH, pillR }
// anchorX/Y = the point in the sprite placed at the venue's map coordinate.
const PILL_H         = 26;   // Hero pill height px
const WAITING_PILL_H = 24;   // Waiting pill height px
const PILL_R         = 13;   // Hero pill radius (height / 2 → fully rounded)
const WAITING_PILL_R = 12;   // Waiting pill radius
const STEM_H         = 14;   // stem height px
const SHADOW_PAD     = 6;    // extra canvas padding on all sides for drop shadows
const spriteCache = new Map();

// ── Icon loading ──────────────────────────────────────────────────────────────
// Shadow series: shadow-25 … shadow-100  (4 icons, index 0–3)
// Sun series PNGs (sun-0 … sun-100) are used by detail panel / day-arc only —
// they are no longer drawn on pins. Load them in whichever module consumes them.
// Wait until ALL 4 shadow images have settled before rebuilding sprites.
let _iconsReadyCount = 0;
const _ICON_TOTAL    = 4;

function _onIconLoad() {
  _iconsReadyCount++;
  if (_iconsReadyCount === _ICON_TOTAL) { clearSpriteCache(); draw(); }
}

const _shadowIcons = ['25', '50', '75', '100'].map(p => {
  const img = new Image();
  img.onload = img.onerror = _onIconLoad;
  img.src = `design/shades-status-icons/shadow-${p}-percent.png`;
  return img;
});

// ── Icon index helpers ─────────────────────────────────────────────────────────
// Shadow series retreats from the top as sun approaches.

// Tier 2a: pick shadow icon by minutes until sun arrives.
function _shadowIconIdx(minutesUntilSun) {
  if (minutesUntilSun <= 15) return 0;   // shadow-25
  if (minutesUntilSun <= 45) return 1;   // shadow-50
  if (minutesUntilSun <= 90) return 2;   // shadow-75
  return 3;                               // shadow-100
}

// ── Pin tier classification ────────────────────────────────────────────────────
// WAITING_HORIZON_MIN: venues count as Waiting if sun arrives within this window.
// 240 min (4h): covers the common Oslo afternoon case where sun arrives ~3h from now.
// HERO_ACTIONABLE_MIN: Hero pill shows `Name · til HH:mm` when this little sun is left.
// 60 min: the point where the user needs to decide whether to head there or stay.
const WAITING_HORIZON_MIN  = 240;
const HERO_ACTIONABLE_MIN  = 60;

/**
 * Classify a venue into Hero / Waiting / Context for the given hour and date.
 * Returns an object: { tier, actionable?, endHour?, minsLeft?,
 *                      minutesUntil?, nextStart?,
 *                      hasSunLaterToday?, closedOpeningIntoSun? }
 */
function classifyPin(v, dateStr, hour) {
  let windows;
  try {
    ({ windows } = computeSunWindows(v, dateStr));
  } catch (e) {
    return { tier: 'context', hasSunLaterToday: false, closedOpeningIntoSun: false };
  }

  const { open: vOpen, close: vClose } = v.openingHours ?? {};
  const isOpen = vOpen != null && hour >= vOpen && hour <= vClose;

  // Tier 1: venue has sun right now
  const nowInSun = windows.find(w => hour >= w.start && hour < w.end);
  if (nowInSun) {
    const minsLeft = Math.round(Math.max(0, nowInSun.end - hour) * 60);
    return {
      tier:       'hero',
      actionable: minsLeft <= HERO_ACTIONABLE_MIN,
      endHour:    nowInSun.end,
      minsLeft,
      closedOpeningIntoSun: false,
    };
  }

  // Tier 2a: sun arrives within WAITING_HORIZON_MIN
  const next = windows.find(w => w.start > hour);
  if (next && (next.start - hour) * 60 <= WAITING_HORIZON_MIN) {
    const mins = Math.round((next.start - hour) * 60);
    // Badge: venue is currently closed but will be open when sun arrives
    const closedOpeningIntoSun = !isOpen && vOpen != null && next.start >= vOpen;
    return { tier: 'waiting', minutesUntil: mins, nextStart: next.start, closedOpeningIntoSun };
  }

  // Tier 2b: context dot
  return { tier: 'context', hasSunLaterToday: !!next, closedOpeningIntoSun: false };
}

// ── Density caps ──────────────────────────────────────────────────────────────
// Baseline values are for a ~1000×900 px viewport (≈ 900 000 px²).
// Caps scale linearly with viewport area so iPhone SE and iPad Pro get sensible limits.
// Density caps are soft backstops only — the spatial layout (computePinLayout)
// is the primary authority on whether a pin shows as pill or dot.
// Caps kick in only at low zoom where many venues flood the viewport;
// at zoom ≥ 16 they are disabled so every hero/waiting gets a pill if space allows.
//
// Rule of thumb: cap ≥ (realistic max in-view count) → cap is never the constraint,
// spatial overlap is. Tune downward only if very-low-zoom clutter becomes a problem.
function _getDensityCaps(zoom) {
  // Hero cap is always Infinity — every venue currently in sun deserves a pill
  // if the spatial layout can find room. The layout grid is the real authority.
  // Waiting pills are secondary: they only appear when space remains after all
  // hero pills have been placed (enforced in computePinLayout, not here).
  if (zoom >= 16) return { heroCap: Infinity, waitingCap: 16 };
  if (zoom >= 14) return { heroCap: Infinity, waitingCap: 12 };
  if (zoom >= 12) return { heroCap: Infinity, waitingCap: 8  };
  return             { heroCap: Infinity, waitingCap: 4  };
}

// UX-tuning constant: each km of distance from map center adds this many "virtual minutes"
// to a waiting pin's sort score. Closer venues beat farther ones even if slightly later sun.
// Pure hypothesis — tune after real-world testing.
const WAITING_DISTANCE_PENALTY_MIN_PER_KM = 30;

// Flat-earth distance in km, accurate enough for Oslo-scale distances (<50 km).
function _geoDistKm(lat1, lng1, lat2, lng2) {
  const dlat = (lat2 - lat1) * 111.0;
  const dlng = (lng2 - lng1) * 111.0 * Math.cos(lat1 * Math.PI / 180);
  return Math.sqrt(dlat * dlat + dlng * dlng);
}

// Stable tier IDs from the last full-recompute (moveend/zoomend or time change).
// Used for hysteresis: during active pan, prefer pins that were already visible
// over newly-entered candidates at the same cap budget.
const _stableHeroIds    = new Set();
const _stableWaitingIds = new Set();

/**
 * Apply density filter in-place: demote excess Hero / Waiting entries.
 * Overflow pins get { demoted: true } added to their classResult — tier stays
 * 'hero' / 'waiting' so solar identity is always preserved. They render as
 * coloured dots (orange = hero, blue = waiting), never as context glass dots.
 *
 * isFullRecompute = true  → full re-sort + demote; rebuild stable sets afterwards.
 *                           Triggered by moveend / zoomend / time/date change.
 * isFullRecompute = false → pan frame; keep stable IDs, demote newcomers first.
 *                           Prevents existing pills from flashing away during pan.
 */
function _applyDensityFilter(projVenues, zoom, currentHour, dateStr, isFullRecompute) {
  const { heroCap, waitingCap } = _getDensityCaps(zoom);

  function _heroScore(e) {
    try { return typeof sunScore === 'function' ? (sunScore(e.v, dateStr, currentHour) ?? 0) : (e.v.rating ?? 0); }
    catch { return 0; }
  }

  // Venues with friend check-ins are never density-demoted or collapsed to dots
  _friendVenueIds = new Set();
  if (typeof getFriendCheckinsForVenue === 'function') {
    for (const e of projVenues) {
      if (getFriendCheckinsForVenue(e.v.id).length) _friendVenueIds.add(e.v.id);
    }
  }

  const heroes  = projVenues.filter(e => e.classResult.tier === 'hero');
  const waiting = projVenues.filter(e => e.classResult.tier === 'waiting');

  // ── Hero cap ──────────────────────────────────────────────────────────────
  if (heroes.length > heroCap) {
    if (isFullRecompute) {
      heroes.sort((a, b) => _heroScore(b) - _heroScore(a));
      for (let i = heroCap; i < heroes.length; i++) {
        if (_friendVenueIds.has(heroes[i].v.id)) continue; // friends never demoted
        heroes[i].classResult = { ...heroes[i].classResult, demoted: true };
      }
    } else {
      const stable = heroes.filter(h => _stableHeroIds.has(h.v.id));
      const fresh  = heroes.filter(h => !_stableHeroIds.has(h.v.id));
      fresh.sort((a, b) => _heroScore(b) - _heroScore(a));
      for (let i = Math.max(0, heroCap - stable.length); i < fresh.length; i++) {
        if (_friendVenueIds.has(fresh[i].v.id)) continue; // friends never demoted
        fresh[i].classResult = { ...fresh[i].classResult, demoted: true };
      }
    }
  }
  if (isFullRecompute) {
    // Stable set = only pill-heroes (non-demoted). Demoted heroes join the fresh
    // pool on the next pan frame so they're bumped before any newly-visible heroes.
    _stableHeroIds.clear();
    projVenues.forEach(e => {
      if (e.classResult.tier === 'hero' && !e.classResult.demoted) _stableHeroIds.add(e.v.id);
    });
  }

  // ── Waiting cap ───────────────────────────────────────────────────────────
  if (waiting.length > waitingCap) {
    // Sort score: minutesUntil + distance-from-centre penalty.
    const centre = map.getCenter();
    function _waitingScore(e) {
      const d = _geoDistKm(e.v.lat, e.v.lng, centre.lat, centre.lng);
      return (e.classResult.minutesUntil ?? 240) + d * WAITING_DISTANCE_PENALTY_MIN_PER_KM;
    }

    if (isFullRecompute) {
      waiting.sort((a, b) => _waitingScore(a) - _waitingScore(b));
      for (let i = waitingCap; i < waiting.length; i++) {
        if (_friendVenueIds.has(waiting[i].v.id)) continue; // friends never demoted
        waiting[i].classResult = { ...waiting[i].classResult, demoted: true };
      }
    } else {
      const stable = waiting.filter(w => _stableWaitingIds.has(w.v.id));
      const fresh  = waiting.filter(w => !_stableWaitingIds.has(w.v.id));
      fresh.sort((a, b) => _waitingScore(a) - _waitingScore(b));
      for (let i = Math.max(0, waitingCap - stable.length); i < fresh.length; i++) {
        if (_friendVenueIds.has(fresh[i].v.id)) continue; // friends never demoted
        fresh[i].classResult = { ...fresh[i].classResult, demoted: true };
      }
    }
  }
  if (isFullRecompute) {
    _stableWaitingIds.clear();
    projVenues.forEach(e => {
      if (e.classResult.tier === 'waiting' && !e.classResult.demoted) _stableWaitingIds.add(e.v.id);
    });
  }
}

// ── Icon draw helper ──────────────────────────────────────────────────────────
function _drawIcon(c, cx, cy, r, imgArr, idx) {
  const img = imgArr[Math.max(0, Math.min(imgArr.length - 1, idx))];
  c.save();
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
  c.clip();
  if (img && img.complete && img.naturalWidth > 0) {
    c.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  } else {
    // Fallback while image is loading
    c.fillStyle = 'rgba(20,46,82,0.88)';
    c.fill();
  }
  c.restore();
}

// ── buildSprite ────────────────────────────────────────────────────────────────
/**
 * Build a sprite canvas for the given tier + tierData.
 * Returns { canvas, anchorX, anchorY, cssW, cssH, pillW, pillH, pillR }
 * anchors are in CSS pixels; sprite is built at DPR resolution.
 *
 * Tier 1 — Hero:    tangerine pill, sun icon left, venue name right, stem solid.
 * Tier 2a — Waiting: glass pill, shadow icon left, time right, stem dashed.
 * Tier 2b — Context: 10×10 glass dot, no stem, no text.
 */
function buildSprite(v, tier, tierData, selected) {
  const dpr = window.devicePixelRatio || 1;
  const rp  = selected ? 4 : 2;  // selection ring padding

  // ── Context dot ──────────────────────────────────────────────────────────────
  if (tier === 'context') {
    const DOT_D  = 10;
    const dotR   = DOT_D / 2;
    const cW     = DOT_D + SHADOW_PAD * 2;
    const cH     = DOT_D + SHADOW_PAD * 2;
    const cx     = SHADOW_PAD + dotR;
    const cy     = SHADOW_PAD + dotR;

    const oc = document.createElement('canvas');
    oc.width  = Math.ceil(cW * dpr);
    oc.height = Math.ceil(cH * dpr);
    const c   = oc.getContext('2d');
    c.scale(dpr, dpr);

    // Dim if no sun at all today
    c.globalAlpha = (tierData && !tierData.hasSunLaterToday) ? 0.42 : 1.0;

    // Drop shadow (micro)
    c.save();
    c.shadowColor   = 'rgba(0,0,0,0.30)';
    c.shadowBlur    = 3;
    c.shadowOffsetY = 1;
    c.beginPath(); c.arc(cx, cy, dotR, 0, Math.PI * 2);
    const dotGrad = c.createLinearGradient(cx - dotR, cy - dotR, cx + dotR, cy + dotR);
    dotGrad.addColorStop(0, 'rgba(20,46,82,0.55)');
    dotGrad.addColorStop(1, 'rgba(32,73,131,0.38)');
    c.fillStyle = dotGrad;
    c.fill();
    c.restore();

    // 1px Jordy border
    c.beginPath(); c.arc(cx, cy, dotR - 0.5, 0, Math.PI * 2);
    c.strokeStyle = 'rgba(156,189,231,0.18)';
    c.lineWidth   = 1;
    c.stroke();

    // Selection ring (2px, offset 2px outside dot)
    if (selected) {
      c.beginPath(); c.arc(cx, cy, dotR + 2, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,175,133,0.9)';
      c.lineWidth   = 2;
      c.stroke();
    }

    // Anchor = center of dot
    return { canvas: oc, anchorX: cx, anchorY: cy, cssW: cW, cssH: cH, pillW: 0, pillH: 0, pillR: 0 };
  }

  // ── Hero pill (Tier 1) ────────────────────────────────────────────────────────
  // Default (>60 min sun left): tangerine pill, name only. No icon.
  // Actionable (≤60 min left): same pill, contents "Name · til HH:mm". No icon.
  // The tangerine fill IS the "in sun" signal; `til` disambiguates end-time from arrival.
  if (tier === 'hero') {
    const actionable = tierData?.actionable ?? false;
    const endHour    = tierData?.endHour ?? 0;
    // Name budget: tighter when actionable (til HH:mm adds ~50px)
    const name = shortName(v.name, actionable ? 9 : 14);

    const tmpCtx = document.createElement('canvas').getContext('2d');
    tmpCtx.font  = 'bold 11px "Inter", sans-serif';
    const nameW  = tmpCtx.measureText(name).width;

    let pillW;
    if (actionable) {
      // Layout: 12px | name | ·(3+3) | "til"(600) | 4px | "HH:mm"(700) | 12px
      const tilText  = 'til';   // i18n TODO: locale equivalent for other languages
      const timeText = formatHourAsClock(endHour);
      tmpCtx.font = '600 11px "Inter", sans-serif';
      const tilW  = tmpCtx.measureText(tilText).width;
      tmpCtx.font = 'bold 11px "Inter", sans-serif';
      const dotW  = tmpCtx.measureText('·').width;
      const timeW = tmpCtx.measureText(timeText).width;
      pillW = Math.max(60, 12 + Math.ceil(nameW) + 3 + Math.ceil(dotW) + 3 + Math.ceil(tilW) + 4 + Math.ceil(timeW) + 12);
    } else {
      // Layout: 12px | name | 12px
      pillW = Math.max(44, 12 + Math.ceil(nameW) + 12);
    }

    const pillH = PILL_H;
    const pillR = PILL_R;

    const cW  = Math.ceil(pillW + rp * 2 + 2 + SHADOW_PAD * 2);
    const cH  = Math.ceil(pillH + STEM_H + rp + SHADOW_PAD * 2);
    const ox  = SHADOW_PAD + rp + 1;   // pill left edge
    const oy  = SHADOW_PAD + rp;       // pill top edge
    const stemX = ox + pillW / 2;
    const cyA   = oy + pillH + STEM_H; // anchor y (bottom of stem)
    const cxA   = stemX;
    const textY = oy + pillH / 2;      // vertical center for all text

    const oc = document.createElement('canvas');
    oc.width  = Math.ceil(cW * dpr);
    oc.height = Math.ceil(cH * dpr);
    const c   = oc.getContext('2d');
    c.scale(dpr, dpr);

    // Soft tangerine accent glow behind pill
    {
      const gCx = ox + pillW / 2, gCy = oy + pillH / 2;
      const scaleX = (pillW * 0.72) / pillH;
      c.save();
      c.translate(gCx, gCy);
      c.scale(scaleX, 1);
      const glow = c.createRadialGradient(0, 0, 0, 0, 0, pillH);
      glow.addColorStop(0, 'rgba(255,175,133,0.18)');
      glow.addColorStop(1, 'rgba(255,175,133,0)');
      c.beginPath(); c.arc(0, 0, pillH, 0, Math.PI * 2);
      c.fillStyle = glow; c.fill();
      c.restore();
    }

    // Selection ring (2px, offset 2px outside pill bounds)
    if (selected) {
      c.beginPath();
      c.roundRect(ox - rp, oy - rp, pillW + rp * 2, pillH + rp * 2, pillR + rp);
      c.strokeStyle = 'rgba(255,175,133,0.9)';
      c.lineWidth   = 2;
      c.stroke();
    }

    // Solid tangerine stem
    c.beginPath();
    c.moveTo(stemX, oy + pillH);
    c.lineTo(stemX, cyA);
    c.strokeStyle = 'rgba(255,175,133,0.70)';
    c.lineWidth   = 2;
    c.stroke();
    // Anchor dot
    c.beginPath(); c.arc(stemX, cyA, 2, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,175,133,0.70)'; c.fill();

    // Pill fill with drop shadow
    c.save();
    c.shadowColor   = 'rgba(0,0,0,0.40)';
    c.shadowBlur    = 8;
    c.shadowOffsetX = 0;
    c.shadowOffsetY = 3;
    c.beginPath();
    c.roundRect(ox, oy, pillW, pillH, pillR);
    c.fillStyle = '#FFAF85';  // --accent: the pill color IS the "in sun" signal
    c.fill();
    c.restore();

    // Outer stroke (warm glow cue)
    c.beginPath();
    c.roundRect(ox, oy, pillW, pillH, pillR);
    c.strokeStyle = 'rgba(255,230,120,0.4)';
    c.lineWidth   = 1;
    c.stroke();

    // Inner top-edge sheen
    c.save();
    c.beginPath(); c.roundRect(ox, oy, pillW, pillH, pillR);
    c.clip();
    c.strokeStyle = 'rgba(255,242,235,0.45)';
    c.lineWidth   = 1;
    c.beginPath();
    c.moveTo(ox + pillR, oy + 0.5);
    c.lineTo(ox + pillW - pillR, oy + 0.5);
    c.stroke();
    c.restore();

    // Text (no icon — the tangerine fill is the full "sunny now" signal)
    c.textBaseline = 'middle';
    c.textAlign    = 'left';

    if (!actionable) {
      // Default: name only, bold 700, dark on tangerine
      c.font      = 'bold 11px "Inter", sans-serif';
      c.fillStyle = '#2a1a0c';
      c.fillText(name, ox + 12, textY);
    } else {
      // Actionable: name · til HH:mm (no icon, no glyph)
      const tilText  = 'til';   // i18n TODO
      const timeText = formatHourAsClock(endHour);

      // name (bold 700, full contrast)
      c.font      = 'bold 11px "Inter", sans-serif';
      c.fillStyle = '#2a1a0c';
      c.fillText(name, ox + 12, textY);
      let x = ox + 12 + c.measureText(name).width;

      // separator · (dimmed)
      c.fillStyle = 'rgba(42,26,12,0.5)';
      x += 3;
      c.fillText('·', x, textY);
      x += c.measureText('·').width + 3;

      // "til" (600 weight, lower contrast — name is the foreground)
      c.font      = '600 11px "Inter", sans-serif';
      c.fillStyle = 'rgba(42,26,12,0.72)';
      c.fillText(tilText, x, textY);
      x += c.measureText(tilText).width + 4;

      // end time (bold 700, same lower-contrast color as til)
      c.font      = 'bold 11px "Inter", sans-serif';
      c.fillStyle = 'rgba(42,26,12,0.72)';
      c.fillText(timeText, x, textY);
    }

    return { canvas: oc, anchorX: cxA, anchorY: cyA, cssW: cW, cssH: cH, pillW, pillH, pillR };
  }

  // ── Waiting pill (Tier 2a) ────────────────────────────────────────────────────
  if (tier === 'waiting') {
    const iconDiam = 14;
    const iconR    = iconDiam / 2;
    const { minutesUntil = 120, nextStart = 0, closedOpeningIntoSun = false } = tierData ?? {};
    const shadowIdx = _shadowIconIdx(minutesUntil);

    // Time label: absolute clock always — one format, always.
    const timeText = formatHourAsClock(nextStart);

    const tmpCtx = document.createElement('canvas').getContext('2d');
    tmpCtx.font  = 'bold 11px "Inter", sans-serif';
    const tw     = tmpCtx.measureText(timeText).width;

    // Layout: 6px inset + 14px icon + 4px gap + text + 10px right
    const pillW = Math.max(36, 6 + iconDiam + 4 + Math.ceil(tw) + 10);
    const pillH = WAITING_PILL_H;
    const pillR = WAITING_PILL_R;

    const cW  = Math.ceil(pillW + rp * 2 + 2 + SHADOW_PAD * 2);
    const cH  = Math.ceil(pillH + STEM_H + rp + SHADOW_PAD * 2);
    const ox  = SHADOW_PAD + rp + 1;
    const oy  = SHADOW_PAD + rp;
    const stemX = ox + pillW / 2;
    const cyA   = oy + pillH + STEM_H;
    const cxA   = stemX;

    const iconCx = ox + 6 + iconR;
    const iconCy = oy + pillH / 2;
    // Badge: bottom-right corner of icon bounding box
    const iconRight  = ox + 6 + iconDiam;
    const iconBottom = oy + (pillH - iconDiam) / 2 + iconDiam;

    const oc = document.createElement('canvas');
    oc.width  = Math.ceil(cW * dpr);
    oc.height = Math.ceil(cH * dpr);
    const c   = oc.getContext('2d');
    c.scale(dpr, dpr);

    // Selection ring
    if (selected) {
      c.beginPath();
      c.roundRect(ox - rp, oy - rp, pillW + rp * 2, pillH + rp * 2, pillR + rp);
      c.strokeStyle = 'rgba(255,175,133,0.9)';
      c.lineWidth   = 2;
      c.stroke();
    }

    // Dashed Jordy Blue stem
    c.beginPath();
    c.moveTo(stemX, oy + pillH);
    c.lineTo(stemX, cyA);
    c.setLineDash([3, 3]);
    c.strokeStyle = 'rgba(156,189,231,0.55)';
    c.lineWidth   = 2;
    c.stroke();
    c.setLineDash([]);
    c.beginPath(); c.arc(stemX, cyA, 2, 0, Math.PI * 2);
    c.fillStyle = 'rgba(156,189,231,0.55)'; c.fill();

    // Pill fill with drop shadow (Shades Glass action level)
    c.save();
    c.shadowColor   = 'rgba(0,0,0,0.35)';
    c.shadowBlur    = 6;
    c.shadowOffsetX = 0;
    c.shadowOffsetY = 2;
    c.beginPath();
    c.roundRect(ox, oy, pillW, pillH, pillR);
    const grad = c.createLinearGradient(ox, oy, ox + pillW, oy + pillH);
    grad.addColorStop(0, 'rgba(20,46,82,0.42)');
    grad.addColorStop(1, 'rgba(32,73,131,0.26)');
    c.fillStyle = grad;
    c.fill();
    c.restore();

    // 1px Jordy border
    c.beginPath();
    c.roundRect(ox, oy, pillW, pillH, pillR);
    c.strokeStyle = 'rgba(156,189,231,0.18)';
    c.lineWidth   = 1;
    c.stroke();

    // Inner top-edge sheen (Shades Glass recipe)
    c.save();
    c.beginPath(); c.roundRect(ox, oy, pillW, pillH, pillR);
    c.clip();
    c.strokeStyle = 'rgba(255,242,235,0.18)';
    c.lineWidth   = 1;
    c.beginPath();
    c.moveTo(ox + pillR, oy + 0.5);
    c.lineTo(ox + pillW - pillR, oy + 0.5);
    c.stroke();
    c.restore();

    // Time label: tangerine text (icon is the state signal; time is urgency)
    c.font         = 'bold 11px "Inter", sans-serif';
    c.fillStyle    = '#FFAF85';
    c.textBaseline = 'middle';
    c.textAlign    = 'left';
    c.fillText(timeText, ox + 6 + iconDiam + 4, iconCy);

    // Shadow icon: always on the left
    _drawIcon(c, iconCx, iconCy, iconR, _shadowIcons, shadowIdx);

    // Clock badge: venue closed now, but opens into the sun window
    if (closedOpeningIntoSun) {
      const badgeR  = 3;   // 6px diameter
      const badgeCx = iconRight - 1;
      const badgeCy = iconBottom - 1;

      c.save();
      // Badge fill (Delft Blue — dark so it reads on glass pill)
      c.beginPath(); c.arc(badgeCx, badgeCy, badgeR + 0.75, 0, Math.PI * 2);
      c.fillStyle = '#142E52';
      c.fill();
      // Badge border (--muted)
      c.strokeStyle = '#9CBDE7';
      c.lineWidth   = 1.5;
      c.stroke();
      // Clock hands (two 1px strokes in --muted; shape carries more signal than detail at 6px)
      c.strokeStyle = '#9CBDE7';
      c.lineWidth   = 1;
      const handLen = badgeR - 0.5;
      // Minute hand: 12 o'clock (top)
      c.beginPath();
      c.moveTo(badgeCx, badgeCy);
      c.lineTo(badgeCx, badgeCy - handLen);
      c.stroke();
      // Hour hand: ~2 o'clock (60° from top)
      const hAngle = -Math.PI / 2 + Math.PI / 3;
      c.beginPath();
      c.moveTo(badgeCx, badgeCy);
      c.lineTo(badgeCx + Math.cos(hAngle) * handLen, badgeCy + Math.sin(hAngle) * handLen);
      c.stroke();
      c.restore();
    }

    return { canvas: oc, anchorX: cxA, anchorY: cyA, cssW: cW, cssH: cH, pillW, pillH, pillR };
  }

  // Fallback (should not be reached)
  const oc = document.createElement('canvas');
  oc.width = oc.height = 1;
  return { canvas: oc, anchorX: 0.5, anchorY: 0.5, cssW: 1, cssH: 1, pillW: 0, pillH: 0, pillR: 0 };
}

/**
 * Get or build a cached sprite.
 * Cache key includes tier, actionable/icon flags, selected, and time buckets.
 *
 * Hero default:    key on (id, tier, actionable=0, selected)
 * Hero actionable: key on (id, tier, actionable=1, endHour bucketed to 5 min, selected)
 *                  — 5-min buckets bound re-renders as the slider ticks forward
 * Waiting:         key on (id, tier, shadowIdx threshold, selected, closedBadge, nextStart bucket)
 *                  — shadowIdx already buckets at 15/45/90 min, keeping hit rate high
 * Context:         key on (id, tier, selected, hasSunLaterToday)
 */
function getSprite(v, tier, tierData, selected, hour, dateStr) {
  if (spriteCache.size > 600) spriteCache.clear();
  let key;
  if (tier === 'hero') {
    const actionable = tierData?.actionable ? 1 : 0;
    // End-hour bucket: round to nearest 5 min (endHour * 12 → integer)
    const endBucket = actionable ? Math.round((tierData?.endHour ?? 0) * 12) : 0;
    key = `${v.id}-hero-${actionable}-${endBucket}-${selected ? 1 : 0}`;
  } else if (tier === 'waiting') {
    const idx    = _shadowIconIdx(tierData?.minutesUntil ?? 120);
    const badge  = tierData?.closedOpeningIntoSun ? 1 : 0;
    // Arrival time bucketed to 15 min for stable cache hits during scrub
    const timeBucket = Math.round((tierData?.nextStart ?? 0) * 4);
    key = `${v.id}-waiting-${idx}-${selected ? 1 : 0}-${badge}-${timeBucket}`;
  } else {
    const hasSun = tierData?.hasSunLaterToday ? 1 : 0;
    key = `${v.id}-context-${selected ? 1 : 0}-${hasSun}`;
  }
  if (!spriteCache.has(key)) spriteCache.set(key, buildSprite(v, tier, tierData, selected));
  return spriteCache.get(key);
}

function clearSpriteCache() { spriteCache.clear(); }

// ── Pin tier transition animations ────────────────────────────────────────────
const _pinPrevTier  = new Map();   // id → last rendered tier string
const _pinFadeStart = new Map();   // id → performance.now() when fade began
const PIN_FADE_MS   = 280;
let   _animRafId    = null;

function _scheduleAnimFrame() {
  if (_animRafId) return;
  _animRafId = requestAnimationFrame(() => { _animRafId = null; draw(); });
}

// ── Canvas resize + map sync ──────────────────────────────────────────────────
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const c = document.getElementById('map-container');
  canvas.width  = Math.round(c.offsetWidth  * dpr);
  canvas.height = Math.round(c.offsetHeight * dpr);
  canvas.style.width  = c.offsetWidth  + 'px';
  canvas.style.height = c.offsetHeight + 'px';
}

resizeCanvas();
window.addEventListener('resize', () => {
  resizeCanvas();
  draw();
  drawSunCurve(document.getElementById('sun-curve'));
  drawSunCompass();
});

map.on('move', draw);
map.on('moveend',  () => { _layoutStale = true; draw(); });
map.on('zoomend',  () => { _layoutStale = true; draw(); });

// ── Pin layout: anti-overlap via variable stem, dot fallback ──────────────────
// Each pin tries increasing extra-stem values until it clears all higher-priority
// pills. If no value works it degrades to a small dot. Context pins are always dots.
// Sorting by tier (hero > waiting > context) means important venues always
// keep their preferred position.
//
// extraStem is 0-based: 0 = stem flush with sprite bottom, 14 = one step raised, etc.
// The sprite always bakes a fixed STEM_H stem; extraStem extends it further.
const MAX_EXTRA_STEM = 42;  // max extra stem before pin becomes a dot (3 × STEM_STEP)
// Gives the layout 4 tries (0, 14, 28, 42) before demoting to a dot.
const STEM_STEP  = 14;      // stem extension increment (px)
const DOT_R      = 4.5;     // dot radius for overlap-demoted pins (px)
const PILL_GAP   = 8;       // min gap between pill bounding boxes (px)
let   _friendVenueIds = new Set(); // rebuilt each density-filter pass
const DOT_FADE_MS = 240;    // pill↔dot morph duration
const GRID_CELL  = 64;      // AABB grid cell size (px) for O(1) overlap queries

let _lastLayout = [];             // [{v, pt, classResult, extraStem, isDot, spr, drawExtraStem}] per frame
let _hoverClearTimer = null;      // debounce timer for clearing map hover
const _pinWasDot    = new Map();  // id → bool — was this pin a dot last frame
const _pinDotFade   = new Map();  // id → {fromDot, start} — active morph animations
const _pinAnimStemH = new Map();  // id → animated extraStem (px, float) for smooth transitions

// ── Layout stability cache ────────────────────────────────────────────────────
let _layoutStale = true;
let _layoutHour  = null;
let _layoutDate  = null;
const _venueIsDot    = new Map();
const _venueExtStem  = new Map();

// Force the next draw() to do a full layout recompute. Use when something
// outside the map's own move/zoom changes the visible region (e.g. the bottom
// panel collapsing from expanded → peek).
window.markPinLayoutStale = () => { _layoutStale = true; };

/**
 * Assigns each venue an extraStem (or isDot flag). Greedy by priority:
 * high-relevance venues get the preferred height, lower ones are bumped up
 * or collapsed to a dot when no stem value avoids overlap.
 * Context tier is always a dot and never enters the grid.
 */
function computePinLayout(projVenues, currentHour, dateStr) {
  const PRI = { hero: 0, waiting: 1, context: 2 };
  const sorted = [...projVenues].sort((a, b) => {
    if (a.v.id === highlight.raisedId) return 1;
    if (b.v.id === highlight.raisedId) return -1;
    const tierA = a.classResult.tier, tierB = b.classResult.tier;
    const pd = (PRI[tierA] ?? 2) - (PRI[tierB] ?? 2);
    if (pd !== 0) return pd;
    // Tie-break within same tier
    if (tierA === 'hero') {
      try {
        const sa = typeof sunScore === 'function' ? (sunScore(a.v, dateStr, currentHour) ?? 0) : (a.v.rating ?? 0);
        const sb = typeof sunScore === 'function' ? (sunScore(b.v, dateStr, currentHour) ?? 0) : (b.v.rating ?? 0);
        return sb - sa;
      } catch { return 0; }
    }
    if (tierA === 'waiting') {
      return (a.classResult.minutesUntil ?? 120) - (b.classResult.minutesUntil ?? 120);
    }
    return 0;
  });

  // Spatial grid: cell key → array of placed rects {rx,ry,rw,rh}
  const placedGrid = new Map();

  function gridCells(rx, ry, rw, rh) {
    const x0 = Math.floor(rx / GRID_CELL), x1 = Math.floor((rx + rw) / GRID_CELL);
    const y0 = Math.floor(ry / GRID_CELL), y1 = Math.floor((ry + rh) / GRID_CELL);
    const cells = [];
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++)
        cells.push(`${gx},${gy}`);
    return cells;
  }

  function isClear(rx, ry, rw, rh) {
    for (const key of gridCells(rx, ry, rw, rh)) {
      for (const p of (placedGrid.get(key) ?? [])) {
        if (!(rx + rw + PILL_GAP <= p.rx || p.rx + p.rw + PILL_GAP <= rx ||
              ry + rh + PILL_GAP <= p.ry || p.ry + p.rh + PILL_GAP <= ry)) return false;
      }
    }
    return true;
  }

  function addPlaced(rx, ry, rw, rh) {
    const rect = { rx, ry, rw, rh };
    for (const key of gridCells(rx, ry, rw, rh)) {
      if (!placedGrid.has(key)) placedGrid.set(key, []);
      placedGrid.get(key).push(rect);
    }
  }

  const result = [];

  // Two-pass layout: heroes first, then waiting only if every hero got a pill.
  const heroEntries    = sorted.filter(e => e.classResult.tier === 'hero'    && !e.classResult.demoted);
  const waitingEntries = sorted.filter(e => e.classResult.tier === 'waiting' && !e.classResult.demoted);
  const otherEntries   = sorted.filter(e => e.classResult.tier === 'context' || e.classResult.demoted);

  // Always dot for context / density-demoted (unless friends are checked in)
  for (const { v, pt, classResult } of otherEntries) {
    const hasFriends = _friendVenueIds.has(v.id);
    const spr = getSprite(v, hasFriends ? 'hero' : classResult.tier, classResult, v.id === selectedId, currentHour, dateStr);
    if (hasFriends) {
      // Force pill layout — try stem positions, fall back to extraStem 0
      const rw = spr.cssW, rh = spr.cssH - STEM_H;
      let placed = false;
      for (let ex = 0; ex <= MAX_EXTRA_STEM; ex += STEM_STEP) {
        const rx = pt.x - spr.anchorX, ry = pt.y - spr.anchorY - ex;
        if (isClear(rx, ry, rw, rh)) {
          addPlaced(rx, ry, rw, rh);
          result.push({ v, pt, classResult: { ...classResult, tier: 'hero' }, extraStem: ex, isDot: false, spr });
          placed = true; break;
        }
      }
      if (!placed) {
        const rx = pt.x - spr.anchorX, ry = pt.y - spr.anchorY;
        addPlaced(rx, ry, rw, rh);
        result.push({ v, pt, classResult: { ...classResult, tier: 'hero' }, extraStem: 0, isDot: false, spr });
      }
    } else {
      result.push({ v, pt, classResult, extraStem: 0, isDot: true, spr });
    }
  }

  // Pass 1: place all hero pills
  let anyHeroDot = false;
  for (const { v, pt, classResult } of heroEntries) {
    const isRaised = v.id === highlight.raisedId;
    const spr = getSprite(v, classResult.tier, classResult, v.id === selectedId, currentHour, dateStr);
    const rw = spr.cssW;
    const rh = spr.cssH - STEM_H;

    const stemDir   = isRaised ? -STEM_STEP : STEM_STEP;
    const stemStart = isRaised ? MAX_EXTRA_STEM : 0;
    const stemEnd   = isRaised ? 0 : MAX_EXTRA_STEM;

    let resolved = false;
    for (let ex = stemStart; isRaised ? ex >= stemEnd : ex <= stemEnd; ex += stemDir) {
      const rx = pt.x - spr.anchorX;
      const ry = pt.y - spr.anchorY - ex;
      if (isClear(rx, ry, rw, rh)) {
        addPlaced(rx, ry, rw, rh);
        result.push({ v, pt, classResult, extraStem: ex, isDot: false, spr });
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      const forcePill = _friendVenueIds.has(v.id);
      if (!isRaised && !forcePill) anyHeroDot = true;
      result.push({ v, pt, classResult, extraStem: 0, isDot: !isRaised && !forcePill, spr });
    }
  }

  // Pass 2: waiting pills only when every hero got a pill
  for (const { v, pt, classResult } of waitingEntries) {
    const isRaised = v.id === highlight.raisedId;
    const spr = getSprite(v, classResult.tier, classResult, v.id === selectedId, currentHour, dateStr);
    const forcePill = _friendVenueIds.has(v.id);

    if (anyHeroDot && !forcePill) {
      result.push({ v, pt, classResult, extraStem: 0, isDot: true, spr });
      continue;
    }

    const rw = spr.cssW;
    const rh = spr.cssH - STEM_H;
    const stemDir   = isRaised ? -STEM_STEP : STEM_STEP;
    const stemStart = isRaised ? MAX_EXTRA_STEM : 0;
    const stemEnd   = isRaised ? 0 : MAX_EXTRA_STEM;

    let resolved = false;
    for (let ex = stemStart; isRaised ? ex >= stemEnd : ex <= stemEnd; ex += stemDir) {
      const rx = pt.x - spr.anchorX;
      const ry = pt.y - spr.anchorY - ex;
      if (isClear(rx, ry, rw, rh)) {
        addPlaced(rx, ry, rw, rh);
        result.push({ v, pt, classResult, extraStem: ex, isDot: false, spr });
        resolved = true;
        break;
      }
    }
    if (!resolved) result.push({ v, pt, classResult, extraStem: 0, isDot: !isRaised && !forcePill, spr });
  }

  return result;
}

// ── Extended stem drawing ─────────────────────────────────────────────────────
function _drawExtStem(pt, extraStem, tier) {
  const isDashed = tier === 'waiting';
  const col = tier === 'hero' ? 'rgba(255,175,133,0.70)' : 'rgba(156,189,231,0.55)';
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - extraStem);
  ctx.lineTo(pt.x, pt.y);
  if (isDashed) ctx.setLineDash([3, 3]);
  ctx.strokeStyle = col;
  ctx.lineWidth   = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  // Anchor dot at map point
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill();
}

// ── Dot drawing (overlap-demoted hero/waiting pins) ───────────────────────────
function _drawDotHover(pt, tier) {
  const isHero = tier === 'hero';
  ctx.save();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 6, 0, Math.PI * 2);
  ctx.fillStyle = isHero ? 'rgba(255,175,133,0.22)' : 'rgba(120,150,220,0.18)';
  ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = isHero ? '#FFAF85' : 'rgba(120,150,200,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
  ctx.restore();
}

function _drawDot(pt, tier) {
  const isHero = tier === 'hero';
  ctx.save();
  ctx.globalAlpha = isHero ? 0.9 : 0.7;
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = isHero ? 'rgba(255,175,133,0.18)' : 'rgba(100,120,180,0.12)';
  ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R, 0, Math.PI * 2);
  ctx.fillStyle = isHero ? '#FFAF85' : 'rgba(100,120,170,0.65)';
  ctx.fill();
  ctx.restore();
}

// ── Friend badge on pins ──────────────────────────────────────────────────────
const FRIEND_BADGE_R = 7.5;

function _drawFriendBadge(x, y, fc) {
  const r = FRIEND_BADGE_R;
  // Dark fill with accent border
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, r + 1, 0, Math.PI * 2);
  ctx.fillStyle = '#142E52';
  ctx.fill();
  ctx.strokeStyle = '#FFAF85';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Content: initial for 1 friend, count for 2+
  ctx.fillStyle = '#FFAF85';
  ctx.font = 'bold 10px "Inter", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (fc.length === 1) {
    ctx.fillText((fc[0].user.name || fc[0].user.email || '?')[0].toUpperCase(), x, y);
  } else {
    ctx.fillText(String(fc.length), x, y);
  }
  ctx.restore();
}

// ── Map pan helper ────────────────────────────────────────────────────────────
/**
 * Pan so the venue pin appears centred in the visible area (accounting for
 * the detail sidebar on desktop).
 */
function panToVenueCenter(v) {
  if (_preSelectZoom === null) {
    _preSelectZoom   = map.getZoom();
    _preSelectCenter = map.getCenter();
    _frozenBounds    = map.getBounds();
  }

  const isMobile = window.innerWidth < 768;
  const panel    = document.getElementById('detail-panel');
  const padLeft  = (!isMobile && panel && panel.classList.contains('open'))
    ? (panel.offsetLeft + panel.offsetWidth) : 0;

  const wallBearing   = v.wallSegment?.bearing ?? v.facing;
  const targetBearing = (wallBearing + 180) % 360;
  const curBearing    = ((map.getBearing() % 360) + 360) % 360;
  let   diff          = Math.abs(targetBearing - curBearing);
  if (diff > 180) diff = 360 - diff;

  const targetZoom = 17.70;
  const opts = {
    center:   [v.lng, v.lat],
    zoom:     targetZoom,
    pitch:    45,
    padding:  { left: padLeft, right: 0, top: 60, bottom: 0 },
    duration: 480,
  };
  if (diff > 60) opts.bearing = targetBearing;
  map.easeTo(opts);
}

// ── Main draw ─────────────────────────────────────────────────────────────────

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  if (!currentSun) { ctx.restore(); return; }
  const now            = performance.now();
  let   needsAnimFrame = false;

  if (editingVenueId) {
    const editHour    = parseFloat(timeFromEl.value);
    const editDateStr = datePicker.value;
    ctx.globalAlpha = 0.18;
    VENUES.forEach(v => {
      const classResult = classifyPin(v, editDateStr, editHour);
      const pt  = map.project([v.lng, v.lat]);
      const spr = getSprite(v, classResult.tier, classResult, false, editHour, editDateStr);
      ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY, spr.cssW, spr.cssH);
    });
    ctx.globalAlpha = 1;
    drawBuildingEditor();
    ctx.restore();
    return;
  }

  const bounds = map.getBounds();
  const zoom   = map.getZoom();
  let hiddenCount = 0;

  drawSeatingAreas();
  if (selectedId) {
    const sel = VENUES.find(v => v.id === selectedId);
    if (sel) drawShadowOverlay(sel);
  }

  const currentHour = parseFloat(timeFromEl.value);
  const dateStr     = datePicker.value;

  // Project + classify all visible venues
  const projVenues = [];
  VENUES.forEach(v => {
    if (!bounds.contains([v.lng, v.lat])) return;
    if (!shouldShowAtZoom(v, zoom)) { hiddenCount++; return; }
    const classResult = classifyPin(v, dateStr, currentHour);
    projVenues.push({ v, classResult, pt: map.project([v.lng, v.lat]) });
  });

  // Compute once: drives both density hysteresis and layout recompute decision.
  // true  = map just settled (moveend/zoomend) or time/date changed → full re-rank.
  // false = pan frame → keep stable pins, demote newcomers.
  const isFullRecompute = _layoutStale || currentHour !== _layoutHour || dateStr !== _layoutDate;

  // Apply density filter (in-place, mutates classResult for excess venues)
  _applyDensityFilter(projVenues, zoom, currentHour, dateStr, isFullRecompute);

  // Recompute anti-overlap layout only when map has settled or time/date changed
  if (isFullRecompute) {
    _layoutStale = false;
    _layoutHour  = currentHour;
    _layoutDate  = dateStr;
    const fresh = computePinLayout(projVenues, currentHour, dateStr);
    const seen  = new Set();
    for (const e of fresh) {
      _venueIsDot.set(e.v.id, e.isDot);
      _venueExtStem.set(e.v.id, e.extraStem);
      seen.add(e.v.id);
    }
    for (const id of [..._venueIsDot.keys()]) {
      if (!seen.has(id)) { _venueIsDot.delete(id); _venueExtStem.delete(id); }
    }
  }

  // Build _lastLayout from stable decisions + current screen positions.
  _lastLayout = projVenues.map(({ v, pt, classResult }) => {
    const sel = v.id === selectedId;
    const spr = getSprite(v, classResult.tier, classResult, sel, currentHour, dateStr);
    return {
      v, pt, classResult, spr,
      isDot:     _venueIsDot.get(v.id)   ?? true,
      extraStem: _venueExtStem.get(v.id) ?? 0,
    };
  });

  // Smooth stem transitions — lerp each pin toward its target extraStem
  let stemAnimDirty = false;
  for (const entry of _lastLayout) {
    if (entry.isDot) { _pinAnimStemH.delete(entry.v.id); entry.drawExtraStem = 0; continue; }
    const target  = entry.extraStem;
    const current = _pinAnimStemH.get(entry.v.id) ?? target;
    if (Math.abs(current - target) < 0.5) {
      _pinAnimStemH.set(entry.v.id, target);
      entry.drawExtraStem = target;
    } else {
      const next = current + (target - current) * 0.14;
      _pinAnimStemH.set(entry.v.id, next);
      entry.drawExtraStem = next;
      stemAnimDirty = true;
    }
  }
  if (stemAnimDirty) needsAnimFrame = true;

  // Pre-scan: register dot↔pill transitions for non-context pins (context never has pills)
  for (const { v, isDot, classResult } of _lastLayout) {
    if (classResult.tier === 'context') continue;
    const wasDot = _pinWasDot.get(v.id);
    if (wasDot !== undefined && wasDot !== isDot) _pinDotFade.set(v.id, { fromDot: wasDot, start: now });
    _pinWasDot.set(v.id, isDot);
  }

  // Pre-pass — subtle tangerine halo behind every hero anchor point (pill + dot)
  // Drawn before stems and pills so it never occludes any pin chrome.
  for (const { pt, classResult } of _lastLayout) {
    if (classResult.tier !== 'hero') continue;
    const grd = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, 20);
    grd.addColorStop(0, 'rgba(255,175,133,0.10)');
    grd.addColorStop(1, 'rgba(255,175,133,0)');
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 20, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
  }

  // Pass 1 — extended stems only (all stems drawn before any pill)
  for (const entry of _lastLayout) {
    const { v, pt, classResult, isDot } = entry;
    if (isDot || _pinDotFade.has(v.id)) continue;
    const extraStem = entry.drawExtraStem ?? entry.extraStem;
    if (extraStem > 0) _drawExtStem(pt, extraStem, classResult.tier);
  }

  // Pass 2a — dots, drawn before pills so pills always sit on top
  for (const entry of _lastLayout) {
    const { v, pt, classResult, isDot, spr } = entry;
    if (_pinDotFade.has(v.id) || !isDot) continue;
    const tier = classResult.tier;
    if (tier === 'context') {
      // Context dots: drawn as sprites (include glass finish + drop shadow)
      ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY, spr.cssW, spr.cssH);
      // Hover ring on context dot
      if (v.id === highlight.id) {
        ctx.save();
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,175,133,0.9)';
        ctx.lineWidth   = 2;
        ctx.stroke();
        ctx.restore();
      }
    } else {
      // Overlap-demoted hero/waiting: simple colored dot
      if (v.id === highlight.id) _drawDotHover(pt, tier);
      else _drawDot(pt, tier);
    }
    // Friend badge on dot pins (offset to top-right)
    if (typeof getFriendCheckinsForVenue === 'function') {
      const fc = getFriendCheckinsForVenue(v.id);
      if (fc.length) {
        _drawFriendBadge(pt.x + DOT_R + 1, pt.y - DOT_R - 1, fc);
      }
    }
  }

  // Pass 2b — morph animations + pills (always above dots)
  for (const entry of _lastLayout) {
    const { v, pt, classResult, extraStem: targetExtraStem, isDot, spr } = entry;
    const extraStem = entry.drawExtraStem ?? targetExtraStem;
    const tier = classResult.tier;

    // Morph animation (pill ↔ dot)
    const morphFade = _pinDotFade.get(v.id);
    if (morphFade) {
      // Keep _pinPrevTier current throughout the morph so the tier-change fade
      // detector doesn't see a stale old tier the frame after the morph ends
      // and fire a second animation (the double-blink).
      _pinPrevTier.set(v.id, tier);
      const t = Math.min(1, (now - morphFade.start) / DOT_FADE_MS);
      if (t >= 1) { _pinDotFade.delete(v.id); }
      else {
        needsAnimFrame = true;
        ctx.save();
        if (morphFade.fromDot) {
          ctx.globalAlpha = 1 - t; _drawDot(pt, tier);
          ctx.globalAlpha = t;
          if (extraStem > 0) _drawExtStem(pt, extraStem, tier);
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem, spr.cssW, spr.cssH);
        } else {
          ctx.globalAlpha = 1 - t;
          if (extraStem > 0) _drawExtStem(pt, extraStem, tier);
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem, spr.cssW, spr.cssH);
          ctx.globalAlpha = t; _drawDot(pt, tier);
        }
        ctx.restore();
        continue;
      }
    }

    if (isDot) continue; // already drawn in Pass 2a

    // Tier-change fade
    const prevTier = _pinPrevTier.get(v.id);
    // Only start a new tier fade when no fade is already running — prevents
    // rapid slider scrubbing from keeping the pin pinned near alpha 0.
    if (prevTier !== undefined && prevTier !== tier && !_pinFadeStart.has(v.id)) {
      _pinFadeStart.set(v.id, now);
    }
    _pinPrevTier.set(v.id, tier);
    let pinAlpha = 1;
    const fs = _pinFadeStart.get(v.id);
    if (fs !== undefined) {
      const t = Math.min(1, (now - fs) / PIN_FADE_MS);
      pinAlpha = t;
      if (t >= 1) _pinFadeStart.delete(v.id);
      else needsAnimFrame = true;
    }

    const isHovered = v.id === highlight.id || v.id === highlight.raisedId;
    const rp = (v.id === selectedId ? 4 : 2) + 1;
    const sprLeft = pt.x - spr.anchorX;
    const sprTop  = pt.y - spr.anchorY - extraStem;

    ctx.save();
    if (pinAlpha < 1) ctx.globalAlpha = pinAlpha;

    // Hover/raised: glowing outline ring around the pill
    if (isHovered && spr.pillW > 0) {
      const glowCol = tier === 'hero' ? 'rgba(255,175,133,0.9)' : 'rgba(210,200,185,0.75)';
      const pillScreenLeft = sprLeft + SHADOW_PAD + rp;
      const pillScreenTop  = sprTop  + SHADOW_PAD + rp;
      ctx.save();
      ctx.shadowBlur  = 9;
      ctx.shadowColor = glowCol;
      ctx.beginPath();
      ctx.roundRect(pillScreenLeft - 3.5, pillScreenTop - 3.5,
                    spr.pillW + 7, spr.pillH + 7, spr.pillR + 3.5);
      ctx.strokeStyle = glowCol;
      ctx.lineWidth   = 2.5;
      ctx.stroke();
      ctx.restore();
    }

    ctx.drawImage(spr.canvas, sprLeft, sprTop, spr.cssW, spr.cssH);

    // Friend badge (top-right of pill)
    if (spr.pillW > 0 && typeof getFriendCheckinsForVenue === 'function') {
      const fc = getFriendCheckinsForVenue(v.id);
      if (fc.length) {
        const rp2 = (v.id === selectedId ? 4 : 2);
        const pillRight = sprLeft + SHADOW_PAD + rp2 + spr.pillW;
        const pillTop   = sprTop  + SHADOW_PAD + rp2;
        _drawFriendBadge(pillRight - 1, pillTop + 1, fc);
      }
    }

    ctx.restore();
  }

  // Hint when venues are hidden due to zoom density
  if (hiddenCount > 0) {
    const text = `Zoom in to see ${hiddenCount} more venue${hiddenCount > 1 ? 's' : ''}`;
    ctx.font = '11px "Inter", sans-serif';
    const tw = ctx.measureText(text).width;
    const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
    const pw = tw + 16, ph = 22, px = (cssW - pw) / 2, py = cssH - 36;
    ctx.fillStyle = 'rgba(16,22,38,0.82)';
    fillRoundRect(ctx, px, py, pw, ph, 11);
    ctx.fillStyle = 'rgba(240,230,211,0.7)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cssW / 2, py + ph / 2);
  }

  if (needsAnimFrame) _scheduleAnimFrame();
  ctx.restore();
}


// ── Hit testing ───────────────────────────────────────────────────────────────
function hitTestVenue(cx, cy) {
  for (const entry of _lastLayout) {
    const { v, pt, isDot, spr } = entry;
    if (isDot) continue;
    const extraStem = entry.drawExtraStem ?? entry.extraStem;
    const rx = pt.x - spr.anchorX - 4;
    const ry = pt.y - spr.anchorY - extraStem - 4;
    const rw = spr.cssW + 8;
    const rh = spr.cssH - STEM_H + 8;
    if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) return v;
  }
  return null;
}

function hitTestDot(cx, cy) {
  for (const { v, pt, isDot } of _lastLayout) {
    if (!isDot) continue;
    if (Math.hypot(cx - pt.x, cy - pt.y) <= DOT_R + 8) return v;
  }
  return null;
}

function hitTestDetachedPin(cx, cy) {
  if (!editingVenueId) return false;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v || v.terraceType !== 'detached') return false;
  const loc = v.terraceDetachedLocation ?? { lat: v.lat, lng: v.lng };
  const pt  = map.project([loc.lng, loc.lat]);
  return Math.hypot(cx - pt.x, cy - pt.y) <= 18;
}

function hitTestDepthHandle(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v || (v.terraceType && v.terraceType !== 'street')) return null;
  const walls  = getTerraceWalls(v);
  const depth  = getEffectiveDepth(v);
  const pxPerM = pxPerMetre(v);
  for (const wall of walls) {
    const { normX, normY, mx, my } = wallOutwardNormal(v, wall);
    const hx = mx + normX * depth * pxPerM;
    const hy = my + normY * depth * pxPerM;
    if (Math.hypot(cx - hx, cy - hy) <= 14) return wall;
  }
  return null;
}

function hitTestWall(cx, cy) {
  if (!editingVenueId) return null;
  const v = VENUES.find(x => x.id === editingVenueId);
  if (!v?.wallNormals) return null;
  let bestIdx = null, bestDistSq = 100;
  v.wallNormals.forEach((wall, idx) => {
    const pa = map.project([wall.aLng, wall.aLat]);
    const pb = map.project([wall.bLng, wall.bLat]);
    const dSq = distPointToSegmentSq(cx, cy, pa.x, pa.y, pb.x, pb.y);
    if (dSq < bestDistSq) { bestDistSq = dSq; bestIdx = idx; }
  });
  return bestIdx;
}

// ── Canvas event handling ─────────────────────────────────────────────────────
// On touch devices, keep canvas pointer-events:none so Mapbox receives native
// touch events directly (enabling pan + pinch-zoom). Tap detection is handled
// via document-level touchend below. On desktop, auto so mouse events work.
const _isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
canvas.style.pointerEvents = _isTouchDevice ? 'none' : 'auto';

// Mapbox GL v3 uses Pointer Events (pointerdown/pointerup), not mousedown/mouseup.
// When a pin is hit we must stop BOTH mousedown and pointerdown from reaching
// Mapbox's container — otherwise Mapbox starts drag-tracking and calls map.stop()
// during drag-end, which cancels our subsequent easeTo camera animation.
function _pinHitAtEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  return !editingVenueId && (hitTestVenue(cx, cy) || hitTestDot(cx, cy));
}

// Selector for interactive UI overlays that must receive clicks without
// interference from the canvas. Must be defined before the pointerdown handler.
const _UI_OVERLAY_SELECTOR = '#qc-wrap, #panel, #floating-search, #search-dropdown, #ptb-cal-float, ' +
  '#profile-panel, #search-wrap, #floating-date, #detail-panel, .mapboxgl-ctrl, .mapboxgl-popup, ' +
  '#locate-btn, #notif-toast, #fts';

canvas.addEventListener('pointerdown', e => {
  canvas.style.pointerEvents = 'none';
  const elUnder = document.elementFromPoint(e.clientX, e.clientY);
  if (elUnder && elUnder.closest(_UI_OVERLAY_SELECTOR)) {
    const restore = () => { canvas.style.pointerEvents = 'auto'; };
    window.addEventListener('pointerup',     restore, { once: true });
    window.addEventListener('pointercancel', restore, { once: true });
    e.stopPropagation();
    return;
  }
  canvas.style.pointerEvents = 'auto';
  if (_pinHitAtEvent(e)) e.stopPropagation();
});

canvas.addEventListener('mousedown', e => {
  // Yield to interactive UI overlays above the canvas
  canvas.style.pointerEvents = 'none';
  const elUnderMD = document.elementFromPoint(e.clientX, e.clientY);
  canvas.style.pointerEvents = 'auto';
  if (elUnderMD && elUnderMD.closest(_UI_OVERLAY_SELECTOR)) {
    elUnderMD.dispatchEvent(new MouseEvent('mousedown', e));
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    // Detached pin drag
    if (hitTestDetachedPin(cx, cy)) {
      _detachedDragging = true;
      canvas.style.cursor = 'grabbing';
      return;
    }
    // Width trim handle drag
    const wh = hitTestWidthHandle(cx, cy);
    if (wh) {
      editDraggingWidth = wh.side;
      editWidthWall     = wh.wall;
      canvas.style.cursor = 'ew-resize';
      return;
    }
    // Depth handle drag takes priority — don't forward to map
    const handle = hitTestDepthHandle(cx, cy);
    if (handle) {
      editDraggingDepth = true;
      editDragWallObj   = handle;
      canvas.style.cursor = 'row-resize';
      return;
    }
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) {
      const editOverlay = document.getElementById('edit-overlay');
      if (editOverlay && editOverlay.contains(el)) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        el.dispatchEvent(new MouseEvent('mousedown', e));
      }
    }
    return;
  }
  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    e.stopPropagation();
  } else {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new MouseEvent('mousedown', e));
  }
});

canvas.addEventListener('click', e => {
  // Yield to interactive UI overlays above the canvas
  canvas.style.pointerEvents = 'none';
  const elUnderClick = document.elementFromPoint(e.clientX, e.clientY);
  canvas.style.pointerEvents = 'auto';
  if (elUnderClick && elUnderClick.closest(_UI_OVERLAY_SELECTOR)) return;

  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v?.terraceType === 'detached' && !_detachedDragging) {
      const ll = map.unproject([cx, cy]);
      setDetachedLocation(ll.lat, ll.lng);
      return;
    }
    const wallIdx = hitTestWall(cx, cy);
    if (wallIdx !== null && (!v?.terraceType || v.terraceType === 'street')) selectWallByIdx(wallIdx);
    return;
  }
  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    e.stopPropagation();
    selectVenue(hit.id, true);
    return;
  }
  if (selectedId !== null) {
    closeDetailPanel();
  }
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;

  if (editingVenueId) {
    tooltip.classList.remove('visible');

    if (_detachedDragging) {
      const ll = map.unproject([cx, cy]);
      setDetachedLocation(ll.lat, ll.lng);
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (editDraggingWidth && editWidthWall) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const wall = editWidthWall;
        const pa   = map.project([wall.aLng, wall.aLat]);
        const pb   = map.project([wall.bLng, wall.bLat]);
        const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
        const lenSq = wdx * wdx + wdy * wdy || 1;
        const t = ((cx - pa.x) * wdx + (cy - pa.y) * wdy) / lenSq;
        const pxPerM = pxPerMetre(v);
        const lenM   = Math.sqrt(lenSq) / pxPerM;
        if (editDraggingWidth === 'start') {
          v.terraceWallTrimStart = Math.max(0, Math.min(lenM * 0.48, t * lenM));
        } else {
          v.terraceWallTrimEnd = Math.max(0, Math.min(lenM * 0.48, (1 - t) * lenM));
        }
        draw();
        canvas.style.cursor = 'ew-resize';
      }
      return;
    }

    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
        _updateEditDepthDisplay();
      }
      return;
    }

    const vEdit = VENUES.find(x => x.id === editingVenueId);
    if (vEdit?.terraceType === 'detached') {
      canvas.style.cursor = hitTestDetachedPin(cx, cy) ? 'grab' : 'crosshair';
      return;
    }
    if (vEdit?.terraceType && vEdit.terraceType !== 'street') {
      canvas.style.cursor = 'default';
      return;
    }

    const wHandle = hitTestWidthHandle(cx, cy);
    if (wHandle) { canvas.style.cursor = 'ew-resize'; return; }

    const handle = hitTestDepthHandle(cx, cy);
    if (handle) { canvas.style.cursor = 'row-resize'; return; }

    const wallIdx = hitTestWall(cx, cy);
    canvas.style.cursor = wallIdx !== null ? 'pointer' : 'default';
    if (wallIdx !== editHoveredWallIdx) {
      editHoveredWallIdx = wallIdx;
      draw();
    }
    return;
  }

  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
    canvas.style.cursor = 'pointer';
    if (highlight.id !== hit.id || highlight.source === 'list') {
      highlight.id = hit.id;
      highlight.source = 'map';
      draw();
    }
    tooltip.innerHTML = buildTooltipContent(hit);
    if (typeof drawAllCardTimelines === 'function') drawAllCardTimelines(tooltip);
    const margin = 14;
    let tx = e.clientX + margin, ty = e.clientY - tooltip.offsetHeight - margin;
    if (tx + tooltip.offsetWidth > window.innerWidth - 20) tx = e.clientX - tooltip.offsetWidth - margin;
    if (ty < 8) ty = e.clientY + margin;
    tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    tooltip.classList.add('visible');
  } else {
    if (highlight.id !== null && !_hoverClearTimer) {
      _hoverClearTimer = setTimeout(() => {
        _hoverClearTimer = null;
        highlight.id = null;
        highlight.source = null;
        draw();
        canvas.style.cursor = 'default';
        tooltip.classList.remove('visible');
      }, 80);
    } else if (highlight.id === null) {
      canvas.style.cursor = 'default';
      tooltip.classList.remove('visible');
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
  if (highlight.id !== null && highlight.source === 'map') {
    highlight.id = null;
    highlight.source = null;
    draw();
  }
  tooltip.classList.remove('visible');
  if (!editDraggingDepth && !editDraggingWidth) canvas.style.cursor = 'default';
});

window.addEventListener('mouseup', () => {
  if (_detachedDragging) {
    _detachedDragging = false;
    canvas.style.cursor = 'default';
    draw();
  }
  if (editDraggingDepth) {
    editDraggingDepth = false;
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
      null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd);
    editDragWallObj = null;
    canvas.style.cursor = 'default';
    _updateEditDepthDisplay();
    _setEditChanged();
  }
  if (editDraggingWidth) {
    editDraggingWidth = false;
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
      null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd);
    editWidthWall = null;
    canvas.style.cursor = 'default';
    _setEditChanged();
  }
});

// wheel: pass through to map (desktop only — touch devices use native events)
canvas.addEventListener('wheel', e => {
  canvas.style.pointerEvents = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  canvas.style.pointerEvents = 'auto';
  if (el) el.dispatchEvent(new WheelEvent('wheel', e));
}, { passive: true });

// Touch pin-tap detection (touch devices only).
if (_isTouchDevice) {
  let _touchStartX = 0, _touchStartY = 0;
  let _editTouchId = null;

  document.addEventListener('touchstart', e => {
    const t = e.touches?.[0];
    if (!t) return;
    _touchStartX = t.clientX; _touchStartY = t.clientY;

    if (!editingVenueId) return;
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;

    if (hitTestDetachedPin(cx, cy)) {
      _detachedDragging = true;
      _editTouchId = t.identifier;
      e.preventDefault();
      return;
    }
    const wh = hitTestWidthHandle(cx, cy);
    if (wh) {
      editDraggingWidth = wh.side;
      editWidthWall     = wh.wall;
      _editTouchId = t.identifier;
      e.preventDefault();
      return;
    }
    const dh = hitTestDepthHandle(cx, cy);
    if (dh) {
      editDraggingDepth = true;
      editDragWallObj   = dh;
      _editTouchId = t.identifier;
      e.preventDefault();
      return;
    }
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!editingVenueId) return;
    const t = Array.from(e.touches).find(tt => tt.identifier === _editTouchId) ?? e.touches[0];
    if (!t) return;
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;

    if (_detachedDragging) {
      const ll = map.unproject([cx, cy]);
      setDetachedLocation(ll.lat, ll.lng);
      e.preventDefault(); return;
    }
    if (editDraggingWidth && editWidthWall) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const wall = editWidthWall;
        const pa   = map.project([wall.aLng, wall.aLat]);
        const pb   = map.project([wall.bLng, wall.bLat]);
        const wdx = pb.x - pa.x, wdy = pb.y - pa.y;
        const lenSq = wdx * wdx + wdy * wdy || 1;
        const t2 = ((cx - pa.x) * wdx + (cy - pa.y) * wdy) / lenSq;
        const lenM = Math.sqrt(lenSq) / pxPerMetre(v);
        if (editDraggingWidth === 'start') {
          v.terraceWallTrimStart = Math.max(0, Math.min(lenM * 0.48, t2 * lenM));
        } else {
          v.terraceWallTrimEnd = Math.max(0, Math.min(lenM * 0.48, (1 - t2) * lenM));
        }
        draw();
      }
      e.preventDefault(); return;
    }
    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
        _updateEditDepthDisplay();
      }
      e.preventDefault(); return;
    }
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (editingVenueId && (_detachedDragging || editDraggingDepth || editDraggingWidth)) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
        null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd);
      _detachedDragging = false;
      editDraggingDepth = false; editDragWallObj = null;
      editDraggingWidth = false; editWidthWall   = null;
      _editTouchId = null;
      _updateEditDepthDisplay();
      _setEditChanged();
      draw();
      return;
    }

    if (editingVenueId) {
      const t = e.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - _touchStartX, dy = t.clientY - _touchStartY;
      if (dx * dx + dy * dy >= 100) return;
      const rect = canvas.getBoundingClientRect();
      const cx = t.clientX - rect.left, cy = t.clientY - rect.top;
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v?.terraceType === 'detached') {
        const ll = map.unproject([cx, cy]);
        setDetachedLocation(ll.lat, ll.lng);
      } else {
        const wallIdx = hitTestWall(cx, cy);
        if (wallIdx !== null && (!v?.terraceType || v.terraceType === 'street')) selectWallByIdx(wallIdx);
      }
      return;
    }

    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx = t.clientX - _touchStartX, dy = t.clientY - _touchStartY;
    if (dx * dx + dy * dy >= 100) return;
    if (e.target && e.target.closest(_UI_OVERLAY_SELECTOR)) return;
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;
    const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
    if (hit) {
      selectVenue(hit.id, true);
    }
  }, { passive: true });
}
