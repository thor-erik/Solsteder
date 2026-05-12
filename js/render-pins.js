/**
 * render-pins.js — Map pins (Google-Maps-mobile style), main draw loop,
 *                  hit testing, and canvas event handling.
 *
 * Pin anatomy (cream-white pill, status capsule on the left):
 *   ┌───────────────────────┐
 *   │ ╔══╗  til 14:30        │   solo dot: category icon in coloured circle
 *   │ ╚══╝                    │   capsule: friend avatars with status border
 *   └────────▽────────────────┘
 *
 * Time-text grammar (one preposition per direction):
 *   "til HH:mm"   — sun ends (hero, in sun now)
 *   "fra HH:mm"   — sun starts (waiting / context-friend)
 *   "Åpner HH:mm" — venue opens (closed-but-opens)
 *   "Ikke mer sol" — friend pill, no actionable sun left today
 *
 * Sun status is encoded in the dot/capsule colour:
 *   --accent (honey)  — in sun now
 *   --bg (deep slate) — in shadow (waiting / context / closed-but-opens)
 *
 * Depends on: map, canvas, ctx, currentSun, selectedId, highlight,
 *             editingVenueId, editHoveredWallIdx, VENUES (app.js / data.js)
 *             computeSunWindows, sunScore (app.js / scoring.js)
 *             formatHourAsClock (render-helpers.js)
 *             drawBuildingEditor, editDraggingDepth, editDragWallObj,
 *             editDraggingWidth, editDraggingPolyVertex, editPolyVertexIdx,
 *             editDraggingPolyEdge, editPolyEdgeIdx, editDraggingPolyTranslate,
 *             editVertexMode (render-editor.js / app.js)
 *             drawSeatingAreas, drawShadowOverlay, shouldShowAtZoom
 *               (render-seating.js)
 *             drawSunCurve, drawSunCompass (render-arc.js)
 *             selectVenue, closeDetailPanel, setDetachedLocation,
 *             selectWallByIdx, saveFacingCache (app.js / ui.js)
 *             tooltip, buildTooltipContent (ui.js)
 *             getFriendCheckinsForVenue, getGoingFriendsForVenue (auth.js)
 *             auditModeActive, isVenueAudited (admin-audit.js)
 */

'use strict';

// ── Density rule (Google-Maps-style) ───────────────────────────────────────────
// Within NEAR_USER_KM of the user's geolocation we allow unlimited pills
// (only fully-overlapping pills are still demoted as a sanity guard);
// outside that "free zone" pills must keep MIN_PILL_GAP_PX between centres
// or the lower-priority one demotes to a dot. Priority order (already
// applied via priScore in draw()):
//   selected > friends > hero (sun, urgency-first) > waiting > context.
// Selected + friend pills bypass the spacing check entirely so the user
// never "loses" their context to density rules.
const NEAR_USER_KM     = 0.4;
const MIN_PILL_GAP_PX  = 80;
const ABS_OVERLAP_PX   = 14;   // sanity overlap guard inside the free zone

function _kmFromUser(lng, lat) {
  if (typeof userLocation === 'undefined' || !userLocation) return Infinity;
  const dLat = (lat - userLocation.lat) * 111;
  const dLng = (lng - userLocation.lng) * 111 * Math.cos(lat * Math.PI / 180);
  return Math.hypot(dLat, dLng);
}

// ── Pin tier classification ────────────────────────────────────────────────────
// WAITING_HORIZON_MIN: venues count as Waiting if sun arrives within this window.
// HERO_ACTIONABLE_MIN: legacy actionable cutoff — kept for compatibility with
// classifyPin's return shape; the new pill always shows the time, so the flag
// is consulted but doesn't change rendering.
const WAITING_HORIZON_MIN = 240;
const HERO_ACTIONABLE_MIN = 60;

/**
 * Classify a venue into Hero / Waiting / Context for the given hour and date.
 * Returns: { tier, actionable?, endHour?, minsLeft?,
 *            minutesUntil?, nextStart?,
 *            hasSunLaterToday?, closedOpeningIntoSun? }
 */
function classifyPin(v, dateStr, hour) {
  let windows;
  try {
    ({ windows } = computeSunWindows(v, dateStr));
  } catch (e) {
    return { tier: 'context', surfaced: false, hasSunLaterToday: false, closedOpeningIntoSun: false };
  }

  const { open: vOpen, close: vClose } = v.openingHours ?? {};
  const isOpen = vOpen != null && hour >= vOpen && hour <= vClose;

  // Soft Zebra qualifying gate — same 45-min weather-gated filter the list
  // uses. Wrapped in a typeof guard so the worker (no DOM/weather) is fine.
  let qual = null;
  if (typeof qualifyingWindows === 'function' && typeof currentSunTable !== 'undefined' && currentSunTable) {
    const sundownH = (typeof findSunCrossingFromTable === 'function')
      ? (findSunCrossingFromTable(currentSunTable, false) ?? 22) : 22;
    const wxLookup = (h) => {
      const b = (typeof wxBucket === 'function') ? wxBucket(dateStr, h) : null;
      return { rainy: b === 'regn', overcast: b === 'skyer' };
    };
    qual = qualifyingWindows(windows, wxLookup, {
      selectedHour: hour, sundownHour: sundownH,
      openHour: vOpen ?? 0, closeHour: vClose ?? 24,
    });
  }
  const surfaced = !qual || qual.surfaced;

  const nowInSun = windows.find(w => hour >= w.start && hour < w.end);
  if (nowInSun && surfaced) {
    const minsLeft = Math.round(Math.max(0, nowInSun.end - hour) * 60);
    return {
      tier:       'hero',
      actionable: minsLeft <= HERO_ACTIONABLE_MIN,
      endHour:    nowInSun.end,
      minsLeft,
      closedOpeningIntoSun: false,
    };
  }

  const next = windows.find(w => w.start > hour);
  if (next && (next.start - hour) * 60 <= WAITING_HORIZON_MIN && surfaced) {
    const mins = Math.round((next.start - hour) * 60);
    const closedOpeningIntoSun = !isOpen && vOpen != null && next.start >= vOpen;
    return { tier: 'waiting', minutesUntil: mins, nextStart: next.start, closedOpeningIntoSun };
  }

  return { tier: 'context', surfaced, hasSunLaterToday: !!next, closedOpeningIntoSun: false };
}

// ── Token-derived rgba helper ──────────────────────────────────────────────────
function _rgba(color, a) {
  if (!color) return `rgba(0,0,0,${a})`;
  if (color[0] === '#') {
    const h    = color.slice(1);
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  const m = color.match(/^rgba?\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  return color;
}

// ── Friend palette ─────────────────────────────────────────────────────────────
// Pale pastels — designed to pop against a saturated capsule. A 1px cream
// halo around every avatar (drawn in _drawFriendModule) guarantees separation
// from the status ring, regardless of capsule colour.
const _FRIEND_COLORS = ['#E8C0BA', '#C0D0B5', '#E8DAB8', '#C8C0DA', '#B8D5D8', '#ECCEB5'];
function _friendColor(userId) {
  const s = String(userId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return _FRIEND_COLORS[h % _FRIEND_COLORS.length];
}
function _friendInitial(u) {
  const src = (u && (u.name || u.email)) || '';
  return (src[0] || '?').toUpperCase();
}

// ── Pin geometry constants ─────────────────────────────────────────────────────
const PILL_H            = 26;     // pill body height
const PILL_R            = 13;     // pill corner radius (= h/2 → fully rounded)
const TAIL_H            = 4;      // chevron tail tip height below pill body
const TAIL_HALF_W       = 4;      // chevron half-width
const CIRCLE_R          = 10;     // status-dot radius (20px diameter; same as 1-friend module)
const PAD_L             = 3;      // gap between pill left edge and dot/friend module
const PAD_R             = 9;      // gap between time text and pill right edge
const CIRCLE_TIME_GAP   = 5;      // gap between dot right edge and time text
const COMPAT_STEM_H     = 14;     // padding baked into spr.cssH so hitTestVenue maths works

// Friend module geometry (capsule of stacked avatars)
const AVATAR_R          = 8;      // each avatar is 16px diameter
const AVATAR_OVERLAP    = 6;      // adjacent avatars overlap by this many px
const BORDER_W          = 2;      // status ring around the friend module
const MAX_AVATARS       = 2;      // stack up to 2 avatars; 3+ adds inline "+N" text
const PLUS_FONT         = 'bold 10px "Inter", system-ui, sans-serif';
const PLUS_GAP_INNER    = 2;      // gap between last avatar and "+N" text inside the capsule
const PLUS_PAD_RIGHT    = 5;      // inner padding on the right edge of the capsule

// ── Status colour for the dot / friend capsule ────────────────────────────────
// Two semantic states, with transparent variants for "opening soon":
//   IN SUN (hero)                  → solid honey
//   IN SHADE (waiting / context)   → solid dark slate (TOKENS.surface) —
//                                    same colour the pill uses on select,
//                                    so the system reads as one palette.
// Closed-but-opens-into-sun gets a transparent variant of the destination
// state. Previously waiting/context used --rain (mid-blue) which felt
// washy against the warm map; the deeper surface slate gives the dots
// real presence.
function _dotColors(tier, closed, hasSunLaterToday) {
  const SUN_RING   = _rgba(TOKENS.accentOn, 0.40);
  const SHADE      = TOKENS.surface || '#284463';
  const SHADE_RING = _rgba('#ffffff', 0.18);

  // Sun NOW
  if (tier === 'hero') {
    return closed
      ? { fill: _rgba(TOKENS.accent, 0.55), ring: _rgba(TOKENS.accentOn, 0.25) } // opening soon, into sun
      : { fill: TOKENS.accent,              ring: SUN_RING };                    // in sun
  }
  // Sun LATER (waiting) — currently shaded but sun is coming
  if (tier === 'waiting') {
    return closed
      ? { fill: _rgba(SHADE, 0.55), ring: _rgba('#ffffff', 0.12) }              // opening soon, into shade-then-sun
      : { fill: SHADE,              ring: SHADE_RING };                          // in shade, sun later
  }
  // Context — no near-term sun. Fade further when no more sun today at all.
  const a = hasSunLaterToday ? 0.85 : 0.55;
  return { fill: _rgba(SHADE, a), ring: _rgba('#ffffff', 0.10) };
}

// ── Vector category icons ─────────────────────────────────────────────────────
// Filled silhouettes sized to fill the 20px dot (extents up to ±4.5). Colour
// is tier-aware: dark warm brown on honey for hero (high contrast on light
// background), white on the slate shadow capsules.
function _drawCafeIcon(c, cx, cy, col) {
  c.fillStyle   = col;
  c.strokeStyle = col;
  c.lineWidth   = 1.6;
  c.lineCap     = 'round';
  c.lineJoin    = 'round';
  // Filled mug body — closed-top, slightly tapered
  c.beginPath();
  c.moveTo(cx - 3.6, cy - 3.0);
  c.lineTo(cx + 1.8, cy - 3.0);
  c.lineTo(cx + 1.8, cy + 2.8);
  c.quadraticCurveTo(cx + 1.8, cy + 3.8, cx + 0.6, cy + 3.8);
  c.lineTo(cx - 2.4, cy + 3.8);
  c.quadraticCurveTo(cx - 3.6, cy + 3.8, cx - 3.6, cy + 2.8);
  c.closePath();
  c.fill();
  // Handle (stroke arc)
  c.beginPath();
  c.arc(cx + 2.0, cy - 0.2, 1.9, -Math.PI / 2, Math.PI / 2);
  c.lineWidth = 1.5;
  c.stroke();
  // Steam dot
  c.beginPath();
  c.arc(cx - 0.6, cy - 4.6, 0.7, 0, Math.PI * 2);
  c.fill();
}

function _drawBarIcon(c, cx, cy, col) {
  c.fillStyle = col;
  // Bowl V (filled triangle, wide)
  c.beginPath();
  c.moveTo(cx - 4.2, cy - 3.6);
  c.lineTo(cx + 4.2, cy - 3.6);
  c.lineTo(cx,        cy + 0.8);
  c.closePath();
  c.fill();
  // Stem
  c.fillRect(cx - 0.6, cy + 0.7, 1.2, 2.6);
  // Base
  c.fillRect(cx - 2.6, cy + 3.0, 5.2, 1.2);
  // Olive (small dot inside the bowl)
  c.beginPath();
  c.arc(cx + 1.4, cy - 2.2, 0.7, 0, Math.PI * 2);
  c.fillStyle = col;
  c.fill();
}

function _drawRestaurantIcon(c, cx, cy, col) {
  c.fillStyle   = col;
  c.strokeStyle = col;
  c.lineCap     = 'round';
  c.lineJoin    = 'round';
  // Fork — shaft + 3 prongs, all filled
  c.fillRect(cx - 3.4, cy - 1.0, 1.4, 5.6);          // shaft
  c.fillRect(cx - 4.4, cy - 4.4, 0.9, 3.6);          // outer-left prong
  c.fillRect(cx - 3.15, cy - 4.4, 0.9, 3.6);         // middle prong
  c.fillRect(cx - 1.9,  cy - 4.4, 0.9, 3.6);         // outer-right prong
  // Knife — tapered blade + filled handle
  c.beginPath();
  c.moveTo(cx + 1.8, cy - 4.4);
  c.lineTo(cx + 3.8, cy - 4.4);
  c.lineTo(cx + 3.4, cy - 0.6);
  c.lineTo(cx + 2.4, cy - 0.6);
  c.closePath();
  c.fill();
  c.fillRect(cx + 2.5, cy - 0.6, 1.2, 5.0);
}

function _drawDefaultIcon(c, cx, cy, col) {
  c.fillStyle = col;
  c.beginPath();
  c.arc(cx, cy, 3.2, 0, Math.PI * 2);
  c.fill();
}

function _drawCategoryIcon(ctx, cx, cy, category, color) {
  const col = color || '#fff';
  if (category === 'cafe')       return _drawCafeIcon(ctx, cx, cy, col);
  if (category === 'bar')        return _drawBarIcon(ctx, cx, cy, col);
  if (category === 'restaurant') return _drawRestaurantIcon(ctx, cx, cy, col);
  return _drawDefaultIcon(ctx, cx, cy, col);
}

// ── Time formatting ────────────────────────────────────────────────────────────
function _fmtTime(h) {
  if (typeof formatHourAsClock === 'function') return formatHourAsClock(h);
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}

// ── Friend module helpers ──────────────────────────────────────────────────────
// The friend module is a "pill within the pill": a coloured capsule that
// contains stacked avatars AND (when N > MAX_AVATARS) inline "+N" text in
// white. Width grows to accommodate the overflow.
function _friendModuleW(ctx, friendCount) {
  if (friendCount <= 0) return CIRCLE_R * 2;
  const slots = Math.min(friendCount, MAX_AVATARS);
  const span  = 2 * AVATAR_R + (slots - 1) * (2 * AVATAR_R - AVATAR_OVERLAP);
  let w = span + 2 * BORDER_W;
  if (friendCount > MAX_AVATARS) {
    const prev = ctx.font;
    ctx.font = PLUS_FONT;
    const plusW = Math.ceil(ctx.measureText('+' + (friendCount - MAX_AVATARS)).width);
    ctx.font = prev;
    w += PLUS_GAP_INNER + plusW + PLUS_PAD_RIGHT - BORDER_W;
  }
  return w;
}

function _drawFriendModule(ctx, cx, cy, friends, statusFill) {
  const N        = friends.length;
  const slots    = Math.min(N, MAX_AVATARS);
  const overflow = N > MAX_AVATARS ? N - MAX_AVATARS : 0;
  const w        = _friendModuleW(ctx, N);
  const h        = CIRCLE_R * 2;
  const x        = cx - w / 2;
  const y        = cy - h / 2;

  // Capsule status background
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = statusFill;
  ctx.fill();

  // Avatars right-to-left so the first friend sits on top of the stack
  const startX = x + BORDER_W + AVATAR_R;
  for (let i = slots - 1; i >= 0; i--) {
    const acx = startX + i * (2 * AVATAR_R - AVATAR_OVERLAP);

    // 1px cream halo
    ctx.beginPath();
    ctx.arc(acx, cy, AVATAR_R, 0, Math.PI * 2);
    ctx.fillStyle = '#FAF1DD';
    ctx.fill();

    // Avatar interior
    ctx.beginPath();
    ctx.arc(acx, cy, AVATAR_R - 1, 0, Math.PI * 2);
    ctx.fillStyle = _friendColor(friends[i] && friends[i].user && friends[i].user.id);
    ctx.fill();

    // Dark slate initial (on pale avatar)
    ctx.fillStyle    = _rgba(TOKENS.bg, 0.92);
    ctx.font         = 'bold 10px "Inter", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'center';
    ctx.fillText(_friendInitial(friends[i] && friends[i].user), acx, cy + 0.5);
  }

  // "+N" inside the capsule, after the avatars
  if (overflow > 0) {
    const lastAvatarRight = startX + (slots - 1) * (2 * AVATAR_R - AVATAR_OVERLAP) + AVATAR_R;
    const plusX = lastAvatarRight + PLUS_GAP_INNER;
    ctx.font         = PLUS_FONT;
    ctx.fillStyle    = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    ctx.fillText('+' + overflow, plusX, cy + 0.5);
  }
  return { x, y, w, h };
}

// ── Pulse rings (privileged ambient on friend pills) ──────────────────────────
// Two stroke-only capsule rings emanating from the friend module. Each ring
// expands for ACTIVE_MS, then rests for the remainder of PERIOD_MS. The 1s
// rest gives the pulse a "heartbeat" rhythm rather than a continuous ripple.
const _pulseStart       = new Map();   // venue id → start timestamp ms
const PULSE_PERIOD_MS   = 2500;
const PULSE_ACTIVE_MS   = 1500;
const PULSE_STAGGER_MS  = 900;
const PULSE_RING_COUNT  = 2;
const PULSE_MAX_SCALE   = 2.4;

function _drawPulseRings(ctx, modBounds, now, id) {
  let start = _pulseStart.get(id);
  if (start === undefined) { start = now; _pulseStart.set(id, start); }
  const cx = modBounds.x + modBounds.w / 2;
  const cy = modBounds.y + modBounds.h / 2;
  const ringCol = TOKENS.accent || '#F5C25E';
  for (let r = 0; r < PULSE_RING_COUNT; r++) {
    const elapsed = (now - start - r * PULSE_STAGGER_MS);
    if (elapsed < 0) continue;
    const phase = elapsed % PULSE_PERIOD_MS;
    if (phase >= PULSE_ACTIVE_MS) continue;
    const t = phase / PULSE_ACTIVE_MS;
    const scale = 1 + t * (PULSE_MAX_SCALE - 1);
    const alpha = (1 - t) * 0.55;
    if (alpha < 0.03) continue;
    const w = modBounds.w * scale;
    const h = modBounds.h * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ringCol;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.stroke();
    ctx.restore();
  }
  _animDirty = true;
}

// ── Pill width ─────────────────────────────────────────────────────────────────
// Layout left → right: PAD_L | dot/module | [GAP time] | PAD_R
function _pillWidth(ctx, time, friendCount) {
  const dotW = friendCount > 0 ? _friendModuleW(ctx, friendCount) : CIRCLE_R * 2;
  ctx.font = '600 11px "Inter", system-ui, sans-serif';
  const tw = time ? Math.ceil(ctx.measureText(time).width) : 0;
  let w = PAD_L + dotW;
  if (tw) w += CIRCLE_TIME_GAP + tw;
  w += PAD_R;
  return w;
}

// ── Pill drawing ───────────────────────────────────────────────────────────────
// Pill is positioned with its tail tip at pt. Body sits ABOVE the venue point.
function _drawPill(ctx, pt, w, time, tier, opts) {
  const x  = pt.x - w / 2;
  const y  = pt.y - PILL_H - TAIL_H;
  const cx = pt.x;

  function pillPath() {
    ctx.beginPath();
    ctx.moveTo(x + PILL_R, y);
    ctx.lineTo(x + w - PILL_R, y);
    ctx.arcTo(x + w, y, x + w, y + PILL_R, PILL_R);
    ctx.lineTo(x + w, y + PILL_H - PILL_R);
    ctx.arcTo(x + w, y + PILL_H, x + w - PILL_R, y + PILL_H, PILL_R);
    ctx.lineTo(cx + TAIL_HALF_W, y + PILL_H);
    ctx.lineTo(cx, y + PILL_H + TAIL_H);
    ctx.lineTo(cx - TAIL_HALF_W, y + PILL_H);
    ctx.lineTo(x + PILL_R, y + PILL_H);
    ctx.arcTo(x, y + PILL_H, x, y + PILL_H - PILL_R, PILL_R);
    ctx.lineTo(x, y + PILL_R);
    ctx.arcTo(x, y, x + PILL_R, y, PILL_R);
    ctx.closePath();
  }

  // Drop shadow + body fill. Selected pills lift off the map (deeper shadow,
  // larger offset) and switch the body fill to slate. Hover gets a smaller
  // lift via opts.scale (set by the per-pin scale animation).
  const scale = opts.scale || 1.0;
  const shAlpha   = 0.28 + Math.max(0, scale - 1) * 0.7;
  const shBlur    = 6 + Math.max(0, scale - 1) * 18;
  const shOffsetY = 2 + Math.max(0, scale - 1) * 6;

  ctx.save();
  ctx.shadowColor   = `rgba(20,30,50,${shAlpha.toFixed(2)})`;
  ctx.shadowBlur    = shBlur;
  ctx.shadowOffsetY = shOffsetY;
  pillPath();
  ctx.fillStyle = opts.selected ? (TOKENS.surface || '#284463') : '#FAF1DD';
  ctx.fill();
  ctx.restore();

  // Hairline border for definition
  pillPath();
  ctx.strokeStyle = opts.selected ? _rgba(TOKENS.text, 0.18) : _rgba(TOKENS.bg, 0.18);
  ctx.lineWidth   = 1;
  ctx.stroke();

  // Hover outline — full --rain blue ring just outside the pill body. Skipped
  // when selected (selected has its own treatment via slate body + lift).
  if (opts.hovered && !opts.selected) {
    ctx.beginPath();
    ctx.roundRect(x - 2.5, y - 2.5, w + 5, PILL_H + 5, PILL_R + 2);
    ctx.strokeStyle = TOKENS.rain || '#6F8AA8';
    ctx.lineWidth   = 2.5;
    ctx.stroke();
  }

  // Status module — solo dot OR friend capsule
  const friends    = opts.friends || [];
  const hasFriends = friends.length > 0;
  const dot        = _dotColors(tier, opts.closedNow);
  const moduleW    = hasFriends ? _friendModuleW(ctx, friends.length) : CIRCLE_R * 2;
  const moduleCx   = x + PAD_L + moduleW / 2;
  const moduleCy   = y + PILL_H / 2;

  ctx.save();
  ctx.shadowColor = 'transparent';
  if (hasFriends) {
    _drawFriendModule(ctx, moduleCx, moduleCy, friends, dot.fill);
  } else {
    ctx.beginPath();
    ctx.arc(moduleCx, moduleCy, CIRCLE_R, 0, Math.PI * 2);
    ctx.fillStyle = dot.fill;
    ctx.fill();
    // Icon colour is tier-aware: dark warm brown on the honey hero dot
    // (high contrast on the light yellow), white on the slate shadow dot.
    const iconCol = (tier === 'hero')
      ? (TOKENS.accentOn || '#2C1F02')
      : '#fff';
    _drawCategoryIcon(ctx, moduleCx, moduleCy, opts.category, iconCol);
  }
  ctx.restore();

  // Time text — cream on slate selected pill, slate on cream default pill.
  if (time) {
    ctx.font         = '600 11px "Inter", system-ui, sans-serif';
    ctx.fillStyle    = opts.selected ? (TOKENS.text || '#FFF4E0') : _rgba(TOKENS.bg, 0.92);
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    ctx.fillText(time, moduleCx + moduleW / 2 + CIRCLE_TIME_GAP, moduleCy + 0.5);
  }
}

// ── AABB overlap & density score (for floating name placement) ────────────────
function _overlaps(a, b, m) {
  return !(a.x + a.w + m < b.x || b.x + b.w + m < a.x ||
           a.y + a.h + m < b.y || b.y + b.h + m < a.y);
}
function _scoreAnchor(rect, pills, names, viewport) {
  let s = 100;
  const acx = rect.x + rect.w / 2;
  const acy = rect.y + rect.h / 2;
  for (const p of pills) {
    if (_overlaps(rect, p, 0)) return -Infinity;
    const px = p.x + p.w / 2, py = p.y + p.h / 2;
    const d  = Math.hypot(acx - px, acy - py);
    if (d < 70) s -= (70 - d) * 0.6;
  }
  for (const n of names) {
    if (_overlaps(rect, n, 1)) return -Infinity;
    const nx = n.x + n.w / 2, ny = n.y + n.h / 2;
    const d  = Math.hypot(acx - nx, acy - ny);
    if (d < 70) s -= (70 - d) * 0.9;
  }
  if (viewport) {
    if (rect.x < 0)                       s -= 100;
    if (rect.y < 0)                       s -= 100;
    if (rect.x + rect.w > viewport.w)     s -= 100;
    if (rect.y + rect.h > viewport.h)     s -= 100;
  }
  return s;
}

// ── Floating name with cream halo + density-aware anchor ──────────────────────
// Strict: if best candidate's score ≤ 0 (collisions), hidden unless forced.
function _drawName(ctx, pt, pillRect, name, secondary, placedPills, placedNames, viewport, opts) {
  const lineH = 13;
  ctx.font = '600 12px "Inter", system-ui, sans-serif';
  const nw = Math.ceil(ctx.measureText(name).width);
  let sw = 0;
  if (secondary) {
    ctx.font = '500 11px "Inter", system-ui, sans-serif';
    sw = Math.ceil(ctx.measureText(secondary).width);
  }
  const labelW = Math.max(nw, sw) + 2;
  const labelH = (secondary ? 2 : 1) * lineH;
  const gap    = 2;

  const cx              = pt.x;
  const pillBodyCenterY = pt.y - PILL_H / 2 - TAIL_H;
  const pillBodyTop     = pillRect.y;
  const pillTipY        = pillRect.y + pillRect.h;

  const candidates = [
    { side: 'right',  x: pillRect.x + pillRect.w + gap, cy: pillBodyCenterY },
    { side: 'left',   x: pillRect.x - labelW - gap,     cy: pillBodyCenterY },
    { side: 'top',    x: cx - labelW / 2,               cy: pillBodyTop - gap - labelH / 2 },
    { side: 'bottom', x: cx - labelW / 2,               cy: pillTipY    + gap + labelH / 2 },
  ];

  // Hysteresis: once a label chose a side, give that side a bonus on
  // subsequent frames so panning doesn't reshuffle sides as pills enter
  // / leave the viewport and shift the collision landscape. Big enough
  // to absorb small collision deltas (~25 pts), small enough that an
  // actually off-viewport side still loses to a valid one (-100 pts).
  const stickySide = opts.venueId != null ? _lastNameAnchor.get(opts.venueId) : null;
  const NAME_ANCHOR_HYSTERESIS = 25;

  let best = null, bestScore = opts.force ? -Infinity : 0;
  for (const c of candidates) {
    const rect = { x: c.x, y: c.cy - labelH / 2, w: labelW, h: labelH };
    let s = _scoreAnchor(rect, placedPills, placedNames, viewport);
    if (stickySide === c.side && s > -Infinity) s += NAME_ANCHOR_HYSTERESIS;
    if (s > bestScore) { bestScore = s; best = { ...c, ...rect }; }
  }
  if (!best) return null;
  placedNames.push(best);
  if (opts.venueId != null) _lastNameAnchor.set(opts.venueId, best.side);

  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'left';
  ctx.lineJoin     = 'round';
  ctx.miterLimit   = 2;

  const tx     = best.x + 1;
  const nameY  = secondary ? best.cy - lineH / 2 : best.cy;
  const secY   = best.cy + lineH / 2;

  // Google-Maps-style label treatment: white text with a SOFT BLURRED
  // halo (not a hard stroke). The halo is near-black to avoid the
  // light-blue tint the previous slate halo created at the blurred
  // edges (where opacity falls off, slate read as pale blue against
  // warm map tiles). Three passes: two with shadow to intensify the
  // blur, one crisp on top. Anchor alpha (opts.alpha) lets the label
  // fade in/out with the pill morph.
  const LIGHT_FILL  = '#FFFFFF';
  const HALO_COLOR  = 'rgba(0, 0, 0, 1)';
  const labelAlpha  = opts.alpha != null ? opts.alpha : 1;

  ctx.save();
  ctx.globalAlpha = labelAlpha;

  // Stack 4 shadow passes so the halo compounds into a solid dark
  // glow. Two passes weren't dark enough — blurred edges read as
  // pale gray against warm map tiles. Four at full opacity gives
  // Google Maps-grade legibility on any background.
  ctx.shadowColor   = HALO_COLOR;
  ctx.shadowBlur    = 4;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle     = LIGHT_FILL;
  ctx.font          = '600 12px "Inter", system-ui, sans-serif';
  for (let i = 0; i < 4; i++) ctx.fillText(name, tx, nameY);
  if (secondary) {
    ctx.font = '500 11px "Inter", system-ui, sans-serif';
    for (let i = 0; i < 4; i++) ctx.fillText(secondary, tx, secY);
  }

  // Final pass: crisp text on top, shadow disabled.
  ctx.shadowBlur    = 0;
  ctx.shadowColor   = 'transparent';
  ctx.font          = '600 12px "Inter", system-ui, sans-serif';
  ctx.fillStyle     = LIGHT_FILL;
  ctx.fillText(name, tx, nameY);
  if (secondary) {
    ctx.font      = '500 11px "Inter", system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    ctx.fillText(secondary, tx, secY);
  }
  ctx.restore();

  return best;
}

// ── Sun-hours summary line (used as secondary line at zoom ≥ 16) ──────────────
// v1 hardcoded Norwegian ("5,3 t sol" / "45 min sol") and a comma decimal,
// which surfaced as a mixed-locale bug when the rest of the UI ran in
// English. v2 pulls the suffix from i18n and chooses the decimal
// separator by language.
function _sunHoursLine(v, dateStr) {
  if (typeof computeSunWindows !== 'function') return '';
  try {
    const { windows } = computeSunWindows(v, dateStr);
    if (!windows.length) return '';
    const total = windows.reduce((s, w) => s + (w.end - w.start), 0);
    if (total <= 0.05) return '';
    const lang = (typeof prefLang === 'function') ? prefLang() : 'no';
    if (total >= 1) {
      const raw = total.toFixed(1);
      const display = (lang === 'en') ? raw : raw.replace('.', ',');
      return (typeof t === 'function') ? t('map_pin_sun_hours', { h: display })
                                       : (display + ' t sol');
    }
    const mins = String(Math.round(total * 60));
    return (typeof t === 'function') ? t('map_pin_sun_minutes', { n: mins })
                                     : (mins + ' min sol');
  } catch { return ''; }
}

// ── Pin animation framework (alpha + scale + morph, smooth lerp) ─────────────
// Per-pin state:
//   alpha / scale       — pill body (existing fade/scale)
//   morph / morphTarget — pill↔dot morph: 1.0 = full pill, 0.0 = full dot.
//                          Drawn pill width / radius interpolates between
//                          dot radius (4.5px) and full pill width.
// _lastPilledIds: ids of pins that finished the previous frame as pills,
// used as hysteresis input (priScore bonus to reduce flicker on zoom).
// _lastNameAnchor: id → 'right' | 'left' | 'top' | 'bottom'. Used by
// _drawName to keep a label on the same side of its pill across pans —
// otherwise the per-frame scoring would flip sides as pills enter / leave
// the viewport and shift the collision landscape.
const _pinState  = new Map();   // id → { alpha, scale, morph, target_alpha, target_scale, morphTarget, snapshot }
const _lastPilledIds = new Set();
const _lastNameAnchor = new Map();
let   _animDirty = false;
let   _animScheduled = false;

function _stepLerp(s, key, target, rate) {
  const cur = s[key];
  const d   = target - cur;
  if (Math.abs(d) < 0.005) { s[key] = target; return false; }
  s[key] = cur + d * rate;
  return true;
}

function _scheduleAnim() {
  if (!_animDirty || _animScheduled) return;
  _animScheduled = true;
  _animDirty     = false;
  requestAnimationFrame(() => {
    _animScheduled = false;
    if (typeof draw === 'function') draw();
  });
}

function _ensureState(id) {
  let s = _pinState.get(id);
  if (!s) {
    s = {
      alpha: 0, scale: 1.0, morph: 0,
      target_alpha: 0, target_scale: 1.0, morphTarget: 0,
      snapshot: null,
    };
    _pinState.set(id, s);
  }
  return s;
}

// ── Zoom-stability cache ──────────────────────────────────────────────────────
// Snapshot the visible venue set on `zoomstart`; reuse it for every zoom
// frame; recompute on `zoomend`. Mirrors Google Maps' behaviour where pins
// don't pop in/out during a pinch.
const _zoomCache = { active: false, frozenIds: null, _wired: false };
function _wireZoomGate() {
  if (_zoomCache._wired) return;
  _zoomCache._wired = true;
  if (typeof map === 'undefined' || !map) return;
  map.on('zoomstart', () => { _zoomCache.active = true; });
  map.on('zoomend',   () => {
    _zoomCache.active    = false;
    _zoomCache.frozenIds = null;
  });
}

// ── Audit pins (admin) ──────────────────────────────────────────────────────
// Reviewed venues short-circuit to a green dot; archived to a red dot. Both
// skip the pill/dot priority pipeline. Unreviewed venues render normally
// — no extra badge — so the absence of a coloured dot signals "still to do."
// Colors come from TOKENS so the canvas tracks the design system.
const _AUDIT_DOT_RING_R = 7;
const _AUDIT_DOT_FILL_R = 5.5;
function _drawAuditReviewedPin(pt) {
  const fill = (TOKENS && TOKENS.success)     || '#64FFB4';
  const ring = (TOKENS && TOKENS.surfaceDeep) || '#0F1B2A';
  ctx.save();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, _AUDIT_DOT_RING_R, 0, Math.PI * 2);
  ctx.fillStyle = ring; ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, _AUDIT_DOT_FILL_R, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth   = 1.3;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(pt.x - 2.4, pt.y + 0.2);
  ctx.lineTo(pt.x - 0.6, pt.y + 2.0);
  ctx.lineTo(pt.x + 2.4, pt.y - 1.8);
  ctx.stroke();
  ctx.restore();
}
function _drawAuditArchivedPin(pt) {
  const fill = (TOKENS && TOKENS.error)       || '#FF6B6B';
  const ring = (TOKENS && TOKENS.surfaceDeep) || '#0F1B2A';
  ctx.save();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, _AUDIT_DOT_RING_R, 0, Math.PI * 2);
  ctx.fillStyle = ring; ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, _AUDIT_DOT_FILL_R, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth   = 1.4;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  ctx.moveTo(pt.x - 2.0, pt.y - 2.0);
  ctx.lineTo(pt.x + 2.0, pt.y + 2.0);
  ctx.moveTo(pt.x + 2.0, pt.y - 2.0);
  ctx.lineTo(pt.x - 2.0, pt.y + 2.0);
  ctx.stroke();
  ctx.restore();
}

// ── Layout state (consumed by hit testing + external code) ────────────────────
let _lastLayout      = [];     // [{v, pt, classResult, isDot, spr, _pillRect}] per frame
let _hoverClearTimer = null;   // debounce timer for clearing map hover
let _friendVenueIds  = new Set();  // venues with checked-in friends, refreshed each draw

// Backwards-compatible no-ops for the old API. The new renderer doesn't
// cache sprites or maintain a separate layout-stale flag — every frame
// re-derives the pipeline. These exports are kept so app.js / osm.js calls
// don't blow up.
function clearSpriteCache() { /* no-op (sprite cache removed) */ }
window.markPinLayoutStale = () => { /* no-op */ };

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

map.on('move',     draw);
map.on('moveend',  draw);
map.on('zoomend',  draw);

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

// ── Friend / going accessors ──────────────────────────────────────────────────
function _getCheckins(v) {
  return (typeof getFriendCheckinsForVenue === 'function')
    ? getFriendCheckinsForVenue(v.id) || []
    : [];
}
function _getGoing(v, dateStr) {
  return (typeof getGoingFriendsForVenue === 'function')
    ? getGoingFriendsForVenue(v.id, dateStr) || []
    : [];
}

// ── Main draw ─────────────────────────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  if (!currentSun) { ctx.restore(); return; }
  _wireZoomGate();

  // Building-editor mode: keep all pins dimmed while the user is shaping a
  // terrace. Pre-existing behaviour preserved.
  if (editingVenueId) {
    const editHour    = parseFloat(timeFromEl.value);
    const editDateStr = datePicker.value;
    ctx.globalAlpha = 0.18;
    VENUES.forEach(v => {
      const cls = classifyPin(v, editDateStr, editHour);
      const pt  = map.project([v.lng, v.lat]);
      const friends = _getCheckins(v);
      if (cls.tier === 'context' && friends.length === 0) {
        // tiny dot so editor mode still shows location
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = _rgba(TOKENS.bg, 0.6);
        ctx.fill();
        return;
      }
      // Build pill text exactly as the main pipeline would
      const closedOpens = !!cls.closedOpeningIntoSun;
      const openHour    = closedOpens ? (v.openingHours && v.openingHours.open) : null;
      let time = '';
      if (closedOpens && openHour != null) time = 'Åpner ' + _fmtTime(openHour);
      else if (cls.tier === 'hero' && cls.endHour) time = 'til ' + _fmtTime(cls.endHour);
      else if (cls.tier === 'waiting' && cls.nextStart != null) time = 'fra ' + _fmtTime(cls.nextStart);
      const w = _pillWidth(ctx, time, friends.length);
      _drawPill(ctx, pt, w, time, cls.tier, {
        selected: false, hovered: false, closedNow: closedOpens,
        category: v.category, friends, scale: 1,
      });
    });
    ctx.globalAlpha = 1;
    drawBuildingEditor();
    ctx.restore();
    return;
  }

  const bounds      = map.getBounds();
  const zoom        = map.getZoom();
  const currentHour = parseFloat(timeFromEl.value);
  const dateStr     = datePicker.value;
  const viewport    = {
    w: canvas.width  / dpr,
    h: canvas.height / dpr,
  };

  drawSeatingAreas();
  // Show-all sub-mode hides the shadow overlay — admin is auditing polygon
  // *shape*, not sun behaviour. Shadows return as soon as they flip back.
  const _hideShadows = (typeof auditModeActive !== 'undefined' && auditModeActive &&
                        typeof auditSubMode    !== 'undefined' && auditSubMode === 'all');
  if (selectedId && !_hideShadows) {
    const sel = VENUES.find(v => v.id === selectedId);
    if (sel) drawShadowOverlay(sel);
  }

  const isAuditMode = (typeof auditModeActive !== 'undefined' && auditModeActive);

  // ── 1. Project + classify visible venues. Friend venues bypass the
  //      shouldShowAtZoom density filter — they're always relevant.
  //      Audit mode bypasses the density filter for every venue and
  //      lifts the selection-focus restriction (the admin is walking
  //      the catalog, not zooming on one venue).
  //      Reviewed + archived venues skip the pill pipeline entirely and
  //      render as simple status dots (drawn after the main loop).
  //      Outside audit mode, when a venue is selected (detail panel
  //      open) the surrounding pins are suppressed — the panel
  //      commands focus and stray pins clutter the shadow context.
  let projVenues = [];
  const auditOverridePins = []; // [{ v, pt, kind: 'reviewed'|'archived' }]
  _friendVenueIds = new Set();
  // Plan-preview lock: on the accept page only the invited venue's pin
  // should render — other pins compete with the hero card's framing
  // and add noise to the dive view. selectedId is forced to the invited
  // venue by openPlanPreview, so we use it as the lock id.
  const _planLockId = (typeof document !== 'undefined'
    && document.body.classList.contains('plan-preview-active')
    && typeof selectedId !== 'undefined') ? selectedId : null;
  VENUES.forEach(v => {
    if (_planLockId != null && v.id !== _planLockId) return;
    if (!bounds.contains([v.lng, v.lat])) return;
    // Outside audit mode, archived venues are completely invisible.
    if (!isAuditMode && v.auditArchived) return;
    // Detail-panel focus mode (non-audit only).
    if (!isAuditMode && selectedId && v.id !== selectedId) return;
    // Inside audit mode, reviewed and archived venues short-circuit to
    // simple-dot rendering — they don't compete for pill space.
    if (isAuditMode) {
      if (v.auditArchived) {
        auditOverridePins.push({ v, pt: map.project([v.lng, v.lat]), kind: 'archived' });
        return;
      }
      if (typeof isVenueAudited === 'function' && isVenueAudited(v)) {
        auditOverridePins.push({ v, pt: map.project([v.lng, v.lat]), kind: 'reviewed' });
        return;
      }
    }
    const friends = _getCheckins(v);
    if (!isAuditMode
        && friends.length === 0
        && typeof shouldShowAtZoom === 'function'
        && !shouldShowAtZoom(v, zoom)) return;
    let cls;
    try { cls = classifyPin(v, dateStr, currentHour); } catch { cls = { tier: 'context' }; }
    if (friends.length > 0) _friendVenueIds.add(v.id);
    projVenues.push({ v, cls, pt: map.project([v.lng, v.lat]), friends });
  });

  // ── 2. Priority sort ───────────────────────────────────────────────────────
  // Strict tiers (lower score = higher priority):
  //   selected → friends → free zone (within NEAR_USER_KM) → outside zone.
  // Within each tier the active list rank (Best Match / Most Sun / Distance)
  // decides who wins a spacing conflict. The free-zone tier bonus ensures
  // outside pills demote against any free-zone pill near them — without it,
  // a high-rank outside pill could place before a low-rank free-zone pill
  // and the free-zone one would then "always show" right on top of it.
  // Hysteresis: pins that rendered as pills last frame get a large bonus
  // so they keep their pill status across zoom changes. Google-Maps-style
  // initial-placement stickiness — once a venue earns a label it holds it
  // unless something privileged (selected / friend / free-zone) crowds in.
  // Strong enough to beat any list-rank challenger, weak enough to fold
  // to selected (−100k), friends (−50k), and free zone (−25k).
  const _listRank = new Map();
  if (typeof _listFiltered !== 'undefined' && Array.isArray(_listFiltered)) {
    for (let i = 0; i < _listFiltered.length; i++) {
      _listRank.set(_listFiltered[i].id, i);
    }
  }
  const _FREE_ZONE_BONUS = -25000;
  const _HYSTERESIS_BONUS = -5000;
  function priScore(e) {
    if (e.v.id === selectedId) return -100000;
    const rank = _listRank.get(e.v.id);
    // Off-list venues get a tier fallback so placement stays deterministic.
    const baseRank = rank != null
      ? rank
      : (e.cls.tier === 'hero')    ? 20000 + (e.cls.minsLeft     ?? 9999) / 100
      : (e.cls.tier === 'waiting' && e.cls.closedOpeningIntoSun) ? 22000 + (e.cls.minutesUntil ?? 9999) / 100
      : (e.cls.tier === 'waiting') ? 21000 + (e.cls.minutesUntil ?? 9999) / 100
      : 30000;
    let s = baseRank;
    if (_friendVenueIds.has(e.v.id)) s -= 50000;
    if (_kmFromUser(e.v.lng, e.v.lat) < NEAR_USER_KM) s += _FREE_ZONE_BONUS;
    if (_lastPilledIds.has(e.v.id)) s += _HYSTERESIS_BONUS;
    return s;
  }
  projVenues.sort((a, b) => priScore(a) - priScore(b));

  // ── 3. Zoom-stability ─────────────────────────────────────────────────────
  // Previously froze the visible set during pinch to prevent pop-in.
  // Removed: the hysteresis bonus + morph animation handle smooth
  // transitions DURING the gesture now, not just on release. Pills
  // shrink into dots / dots grow into pills as the zoom changes.

  // ── 4. Draw pills (overlap allowed; only fully-shadowed pills demote) ────
  // Reset every state's target_alpha to 0 — entries that aren't refreshed by
  // this frame's loop will fade out automatically.
  for (const s of _pinState.values()) s.target_alpha = 0;

  const placedPills = [];
  const layout      = [];
  const hoverId     = (typeof highlight !== 'undefined' && highlight) ? highlight.id : null;
  // Track which venues end up rendering as pills THIS frame. After the
  // loop, this set replaces _lastPilledIds so hysteresis bonuses apply
  // on the next frame (keeps pins from flickering during zoom).
  const _thisFramePilledIds = new Set();

  for (const { v, cls, pt, friends } of projVenues) {
    const tier       = cls.tier;
    const hasFriends = friends.length > 0;

    // Context tier without friends → tiny dot using the shared sun/shade
    // palette. Stays rain-blue for "in shade" so the user reads the whole
    // map as two colour states (yellow = sun, blue = shade) instead of
    // three (yellow / mid-slate / dark-slate).
    //
    // Filter parity with the list: venues that would never qualify for the
    // surfaced list (no sun today, or all windows rain-killed) get no dot.
    // A dot the list would never promote is just noise on the map.
    if (tier === 'context' && !hasFriends) {
      if (cls.surfaced === false) continue;
      // Slightly larger dots to match Google Maps (~12px diameter at
      // zoom ≥ 16, ~10px lower). Suppress when the dot would overlap
      // a placed pill body — dots stuck inside pills read as artefacts.
      const r = (zoom >= 16 ? 6 : 5);
      let dotOverlaps = false;
      for (const p of placedPills) {
        if (pt.x >= p.x - r && pt.x <= p.x + p.w + r &&
            pt.y >= p.y - r && pt.y <= p.y + p.h + r) { dotOverlaps = true; break; }
      }
      if (!dotOverlaps) {
        const dot = _dotColors('context', false, !!cls.hasSunLaterToday);
        ctx.save();
        ctx.beginPath(); ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fillStyle   = dot.fill;
        ctx.strokeStyle = dot.ring;
        ctx.lineWidth   = 1;
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      layout.push({
        v, pt, classResult: cls, isDot: true, extraStem: 0,
        spr: { anchorX: 0, anchorY: 0, cssW: r * 2, cssH: r * 2 + COMPAT_STEM_H, pillW: 0, pillH: 0, pillR: 0 },
      });
      continue;
    }

    // Closed-but-opens: pill body fades to ~70%; right text shows OPENING
    // hour ("Åpner HH:mm"); secondary line below name shows sun start.
    const closedOpens = !!cls.closedOpeningIntoSun;
    const openHour    = closedOpens ? (v.openingHours && v.openingHours.open) : null;

    let time = '';
    if (closedOpens && openHour != null) {
      time = 'Åpner ' + _fmtTime(openHour);
    } else if (tier === 'hero' && cls.endHour) {
      time = 'til ' + _fmtTime(cls.endHour);
    } else if (tier === 'waiting' && cls.nextStart != null) {
      time = 'fra ' + _fmtTime(cls.nextStart);
    } else if (hasFriends && typeof computeSunWindows === 'function') {
      try {
        const { windows } = computeSunWindows(v, dateStr);
        const next = windows.find(w => w.start > currentHour);
        time = next ? 'fra ' + _fmtTime(next.start) : 'Ikke mer sol';
      } catch { time = 'Ikke mer sol'; }
    }

    const w = _pillWidth(ctx, time, friends.length);
    const pillRect = {
      x: pt.x - w / 2,
      y: pt.y - PILL_H - TAIL_H,
      w,
      h: PILL_H + TAIL_H,
    };

    // Density rule (Google-Maps style):
    //  - Selected + friend pills bypass the spacing check entirely.
    //  - Within NEAR_USER_KM of the user's geolocation, unlimited pills
    //    (only absolute-overlap is guarded against, ~14 px).
    //  - Outside that free zone, pills must keep MIN_PILL_GAP_PX between
    //    centres; lower-priority pin (later in the sort) demotes to dot.
    let demote = false;
    if (v.id !== selectedId && !_friendVenueIds.has(v.id)) {
      const inFreeZone = _kmFromUser(v.lng, v.lat) < NEAR_USER_KM;
      const minGap = inFreeZone ? ABS_OVERLAP_PX : MIN_PILL_GAP_PX;
      for (const p of placedPills) {
        const dx = (pillRect.x + pillRect.w / 2) - (p.x + p.w / 2);
        const dy = (pillRect.y + pillRect.h / 2) - (p.y + p.h / 2);
        if (Math.hypot(dx, dy) < minGap) { demote = true; break; }
      }
    }
    if (demote) {
      // Suppress the dot if it would land on or near a placed pill body
      // — dots stuck against pills read as artefacts. Pin still goes
      // into _lastLayout so hit testing works.
      let dotOverlaps = false;
      for (const p of placedPills) {
        if (pt.x >= p.x - 6 && pt.x <= p.x + p.w + 6 &&
            pt.y >= p.y - 6 && pt.y <= p.y + p.h + 6) { dotOverlaps = true; break; }
      }
      // Drive the morph target toward 0 (dot). The pill scales down as
      // it fades; the dot grows in at (1 - morph) so the two cross-fade
      // smoothly across the transition.
      const stDot = _ensureState(v.id);
      stDot.target_alpha = 0;
      stDot.morphTarget  = 0;
      const aMovingD = _stepLerp(stDot, 'alpha', stDot.target_alpha, 0.14);
      const mMovingD = _stepLerp(stDot, 'morph', stDot.morphTarget, 0.12);
      if (aMovingD || mMovingD) _animDirty = true;
      const dotAlpha = 1 - stDot.morph;       // fades in as pill fades out

      // Shrinking pill — interpolate scale from 1.0 down to 0.4 as morph
      // crosses to 0, alongside the fading alpha. Reads as "the pill
      // collapses back into the dot."
      if (stDot.alpha > 0.04 && stDot.snapshot) {
        ctx.save();
        const shrinkScale = 0.4 + 0.6 * stDot.morph;
        ctx.globalAlpha = stDot.alpha;
        ctx.translate(pt.x, pt.y);
        ctx.scale(shrinkScale, shrinkScale);
        ctx.translate(-pt.x, -pt.y);
        const snap = stDot.snapshot;
        _drawPill(ctx, pt, snap.w, snap.time, snap.tier, {
          selected: false, hovered: false, closedNow: !!snap.closedNow,
          category: snap.category, friends: snap.friends || [], scale: 1,
        });
        ctx.restore();
      }

      if (!dotOverlaps && dotAlpha > 0.04) {
        const dot = _dotColors(tier, closedOpens, !!cls.hasSunLaterToday);
        ctx.save();
        ctx.globalAlpha = dotAlpha;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = dot.fill;
        ctx.fill();
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 5.5, 0, Math.PI * 2);
        ctx.strokeStyle = dot.ring;
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.restore();
      }
      layout.push({
        v, pt, classResult: cls, isDot: true, extraStem: 0,
        spr: { anchorX: 0, anchorY: 0, cssW: 8, cssH: 8 + COMPAT_STEM_H, pillW: 0, pillH: 0, pillR: 0 },
      });
      continue;
    }

    placedPills.push(pillRect);
    _thisFramePilledIds.add(v.id);     // hysteresis input for next frame

    const sel       = v.id === selectedId;
    const hovered   = !sel && v.id === hoverId;
    const baseAlphaTarget = closedOpens ? 0.70 : 1.0;

    // Animation state — drive both alpha and morph toward the pill state.
    const st = _ensureState(v.id);
    st.target_alpha = baseAlphaTarget;
    st.target_scale = sel ? 1.14 : (hovered ? 1.07 : 1.0);
    st.morphTarget  = 1;
    st.snapshot     = { tier, w, time, category: v.category, closedNow: closedOpens, friends };
    const aMoving = _stepLerp(st, 'alpha', st.target_alpha, 0.20);
    const sMoving = _stepLerp(st, 'scale', st.target_scale, 0.22);
    const mMoving = _stepLerp(st, 'morph', st.morphTarget, 0.12);
    if (aMoving || sMoving || mMoving) _animDirty = true;

    // When promoting from dot → pill, bleed off a residual dot
    // underneath so the swap reads as a smooth cross-fade rather
    // than a snap.
    const promoDotAlpha = 1 - st.morph;
    if (promoDotAlpha > 0.04) {
      const dot = _dotColors(tier, closedOpens, !!cls.hasSunLaterToday);
      ctx.save();
      ctx.globalAlpha = promoDotAlpha;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = dot.fill;
      ctx.fill();
      ctx.restore();
    }

    // Pulse rings BEFORE the pill so they sit behind it. Only friend pills
    // pulse — the privileged ambient marks the social signal.
    if (hasFriends && st.alpha > 0.1) {
      const moduleW = _friendModuleW(ctx, friends.length);
      const moduleH = CIRCLE_R * 2;
      const moduleX = pt.x - w / 2 + PAD_L;
      const moduleY = pt.y - PILL_H - TAIL_H + (PILL_H - moduleH) / 2;
      ctx.save();
      ctx.globalAlpha = st.alpha;
      if (st.scale !== 1.0) {
        ctx.translate(pt.x, pt.y);
        ctx.scale(st.scale, st.scale);
        ctx.translate(-pt.x, -pt.y);
      }
      _drawPulseRings(ctx, { x: moduleX, y: moduleY, w: moduleW, h: moduleH },
                      performance.now(), v.id);
      ctx.restore();
    }

    // The pill itself. During morph (st.morph 0→1) the pill scales up
    // from the dot's footprint (0.4×) to full size (1.0×), AND its
    // alpha grows in step. Combined with the residual dot fading out
    // below, this reads as the dot "growing into" the pill.
    ctx.save();
    const morphScale = 0.4 + 0.6 * st.morph;       // 0.4 → 1.0 during morph
    const morphAlpha = st.alpha * Math.min(1, st.morph * 1.4);
    ctx.globalAlpha = morphAlpha;
    const effScale = st.scale * morphScale;
    if (effScale !== 1.0) {
      ctx.translate(pt.x, pt.y);
      ctx.scale(effScale, effScale);
      ctx.translate(-pt.x, -pt.y);
    }
    _drawPill(ctx, pt, w, time, tier, {
      selected:  sel,
      hovered,
      closedNow: closedOpens,
      category:  v.category,
      friends,
      scale:     st.scale,
    });
    ctx.restore();

    layout.push({
      v, pt, classResult: cls, isDot: false, extraStem: 0,
      spr: {
        anchorX: w / 2,
        anchorY: PILL_H + TAIL_H + COMPAT_STEM_H,
        cssW:    w,
        cssH:    PILL_H + TAIL_H + COMPAT_STEM_H,
        pillW:   w,
        pillH:   PILL_H + TAIL_H,
        pillR:   PILL_R,
      },
      _pillRect: pillRect,
      _closedOpens: closedOpens,
      _nextStart:   cls.nextStart,
      _friends:     friends,
    });
  }

  // ── 5. Fade-out pass: persistent state entries whose target_alpha is still
  //      0 (not refreshed this frame) lerp down and render one last time. ─
  for (const [id, st] of [..._pinState]) {
    if (st.target_alpha === 1 || st.target_alpha === 0.7) continue;  // still live
    const moving = _stepLerp(st, 'alpha', 0, 0.20);
    if (moving) _animDirty = true;
    if (st.alpha < 0.04 || !st.snapshot) {
      _pinState.delete(id);
      continue;
    }
    const v = VENUES.find(vx => vx.id === id);
    if (!v) { _pinState.delete(id); continue; }
    const pt = map.project([v.lng, v.lat]);
    ctx.save();
    ctx.globalAlpha = st.alpha;
    _drawPill(ctx, pt, st.snapshot.w, st.snapshot.time, st.snapshot.tier, {
      selected:  false,
      hovered:   false,
      closedNow: st.snapshot.closedNow,
      category:  st.snapshot.category,
      friends:   st.snapshot.friends || [],
      scale:     1.0,
    });
    ctx.restore();
  }

  // ── 6. Floating names (with collision detection) ─────────────────────────
  // Secondary line priority (one line max, by importance):
  //   1. closed-but-opens  → "Sol fra HH:mm"  (the *reason* the pill is here)
  //   2. friends going     → "Anna +N planlegger"
  //   3. zoom ≥ 16         → "X t sol"        (informational)
  const placedNames = [];
  for (const entry of layout) {
    if (entry.isDot) continue;
    if (entry.classResult.tier === 'context' && zoom < 16 && !(entry._friends && entry._friends.length)) continue;
    const v        = entry.v;
    const sel      = v.id === selectedId;
    const isFriend = entry._friends && entry._friends.length > 0;
    const going    = _getGoing(v, dateStr);

    let sec = '';
    if (entry._closedOpens && entry._nextStart != null) {
      sec = 'Sol fra ' + _fmtTime(entry._nextStart);
    } else if (going.length > 0) {
      const firstName = (going[0].user && going[0].user.name || '?').split(' ')[0];
      sec = going.length === 1
        ? `${firstName} planlegger`
        : `${firstName} +${going.length - 1} planlegger`;
    } else if (zoom >= 16) {
      sec = _sunHoursLine(v, dateStr);
    }

    // Label alpha follows the pill's morph — fades in only when the
    // pill is mostly visible (morph > 0.5), then full from ~0.8 onward.
    // Avoids labels appearing alongside half-grown pills.
    const stEntry = _pinState.get(v.id);
    const labelAlpha = stEntry
      ? Math.max(0, Math.min(1, (stEntry.morph - 0.5) / 0.3))
      : 1;
    if (labelAlpha <= 0.02) continue;
    _drawName(
      ctx, entry.pt, entry._pillRect,
      shortName(v.name), sec,
      placedPills, placedNames, viewport,
      { selected: sel, force: sel || isFriend, alpha: labelAlpha, venueId: v.id },
    );
  }

  // ── Audit override pins (reviewed + archived) ─────────────────────────────
  // Drawn after pills/labels so they sit on top of overlapping pill bodies
  // when a pill lands close to an already-reviewed venue.
  if (isAuditMode && auditOverridePins.length) {
    for (const { v, pt, kind } of auditOverridePins) {
      if (kind === 'reviewed') _drawAuditReviewedPin(pt);
      else                     _drawAuditArchivedPin(pt);
      layout.push({
        v, pt, classResult: { tier: 'context' }, isDot: true, extraStem: 0,
        spr: { anchorX: 0, anchorY: 0, cssW: 14, cssH: 14 + COMPAT_STEM_H, pillW: 0, pillH: 0, pillR: 0 },
      });
    }
  }

  _lastLayout = layout;
  // Swap this frame's pilled-set into _lastPilledIds so the next
  // frame's priScore can apply the hysteresis bonus (keeps pins as
  // pills across zoom changes; reduces flicker).
  _lastPilledIds.clear();
  for (const id of _thisFramePilledIds) _lastPilledIds.add(id);
  _scheduleAnim();
  ctx.restore();
}

// ── Hit testing ───────────────────────────────────────────────────────────────
function hitTestVenue(cx, cy) {
  for (const entry of _lastLayout) {
    const { v, pt, isDot, spr } = entry;
    if (isDot) continue;
    const rx = pt.x - spr.anchorX - 4;
    const ry = pt.y - spr.anchorY - 4;
    const rw = spr.cssW + 8;
    const rh = spr.cssH - COMPAT_STEM_H + 8;
    if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) return v;
  }
  return null;
}

const DOT_R = 4.5;  // approximate radius for hit-testing demoted/context dots
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
  const walls  = (typeof getTerraceWalls === 'function') ? getTerraceWalls(v) : [];
  const depth  = (typeof getEffectiveDepth === 'function') ? getEffectiveDepth(v) : 0;
  const pxPerM = (typeof pxPerMetre === 'function') ? pxPerMetre(v) : 0;
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

function _pinHitAtEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  return !editingVenueId && (hitTestVenue(cx, cy) || hitTestDot(cx, cy));
}

/** Hit-test any active editor handle (corner, edge midpoint, depth handle,
 *  polygon interior). Used by pointerdown/mousedown to short-circuit Mapbox's
 *  drag-pan when the user grabs a handle or the polygon body — otherwise the
 *  map pans along with the polygon. */
function _editHandleHitAtEvent(e) {
  if (!editingVenueId) return false;
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (typeof hitTestActivePolygonVertex === 'function'
      && hitTestActivePolygonVertex(cx, cy) !== null) return true;
  if (typeof hitTestActivePolygonEdge === 'function'
      && hitTestActivePolygonEdge(cx, cy) !== null) return true;
  if (typeof hitTestActivePolygonInterior === 'function'
      && hitTestActivePolygonInterior(cx, cy)) return true;
  if (typeof hitTestDepthHandle === 'function'
      && hitTestDepthHandle(cx, cy)) return true;
  return false;
}

function _disableMapInteractions() {
  if (typeof map === 'undefined' || !map?.dragPan) return;
  try {
    map.dragPan.disable();
    map.touchZoomRotate?.disable();
    map.touchPitch?.disable();
    map.scrollZoom?.disable();
    map.doubleClickZoom?.disable();
  } catch (_) {}
}
function _enableMapInteractions() {
  if (typeof map === 'undefined' || !map?.dragPan) return;
  try {
    map.dragPan.enable();
    map.touchZoomRotate?.enable();
    map.touchPitch?.enable();
    map.scrollZoom?.enable();
    map.doubleClickZoom?.enable();
  } catch (_) {}
}

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
  if (_editHandleHitAtEvent(e)) e.stopPropagation();
});

canvas.addEventListener('mousedown', e => {
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
    if (typeof editVertexMode !== 'undefined' && editVertexMode) return;
    const cornerIdx = (typeof hitTestActivePolygonVertex === 'function')
      ? hitTestActivePolygonVertex(cx, cy) : null;
    if (cornerIdx !== null) {
      editDraggingPolyVertex = true;
      editPolyVertexIdx      = cornerIdx;
      canvas.style.cursor    = 'grabbing';
      _disableMapInteractions();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const edgeIdx = (typeof hitTestActivePolygonEdge === 'function')
      ? hitTestActivePolygonEdge(cx, cy) : null;
    if (edgeIdx !== null) {
      editDraggingPolyEdge = true;
      editPolyEdgeIdx      = edgeIdx;
      canvas.style.cursor  = 'grabbing';
      _disableMapInteractions();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (typeof hitTestActivePolygonInterior === 'function'
        && hitTestActivePolygonInterior(cx, cy)
        && typeof startPolygonTranslate === 'function') {
      if (startPolygonTranslate(cx, cy)) {
        canvas.style.cursor = 'grabbing';
        _disableMapInteractions();
        e.stopPropagation();
        e.preventDefault();
        return;
      }
    }
    const handle = hitTestDepthHandle(cx, cy);
    if (handle) {
      editDraggingDepth = true;
      editDragWallObj   = handle;
      canvas.style.cursor = 'row-resize';
      _disableMapInteractions();
      e.stopPropagation();
      e.preventDefault();
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
  canvas.style.pointerEvents = 'none';
  const elUnderClick = document.elementFromPoint(e.clientX, e.clientY);
  canvas.style.pointerEvents = 'auto';
  if (elUnderClick && elUnderClick.closest(_UI_OVERLAY_SELECTOR)) return;

  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    const v = VENUES.find(x => x.id === editingVenueId);

    if (typeof editVertexMode !== 'undefined' && editVertexMode === 'del') {
      const idx = (typeof hitTestActivePolygonVertex === 'function')
        ? hitTestActivePolygonVertex(cx, cy) : null;
      if (idx !== null) {
        if (typeof deletePolygonVertex === 'function') deletePolygonVertex(editingVenueId, idx);
        if (typeof _setEditChanged === 'function') _setEditChanged();
        sunWindowCache.clear();
        dispatchToWorker(datePicker.value);
        if (typeof _updateEditToolButtons === 'function') _updateEditToolButtons();
        if (typeof setEditVertexMode === 'function') setEditVertexMode(null);
        draw();
        return;
      }
      if (typeof setEditVertexMode === 'function') setEditVertexMode(null);
      return;
    }
    if (typeof editVertexMode !== 'undefined' && editVertexMode === 'add') {
      const hit = (typeof hitTestActivePolygonEdgeAt === 'function')
        ? hitTestActivePolygonEdgeAt(cx, cy, 16) : null;
      if (hit) {
        if (typeof insertPolygonVertexAt === 'function')
          insertPolygonVertexAt(editingVenueId, hit.edgeIdx, hit.lat, hit.lng);
        if (typeof _setEditChanged === 'function') _setEditChanged();
        sunWindowCache.clear();
        dispatchToWorker(datePicker.value);
        if (typeof _updateEditToolButtons === 'function') _updateEditToolButtons();
        if (typeof setEditVertexMode === 'function') setEditVertexMode(null);
        draw();
        return;
      }
      if (typeof setEditVertexMode === 'function') setEditVertexMode(null);
      return;
    }

    const wallIdx = hitTestWall(cx, cy);
    if (wallIdx !== null && (!v?.terraceType || v.terraceType === 'street')
        && !v?.seatingPolygonOverride) selectWallByIdx(wallIdx);
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

    if (editDraggingPolyVertex && editPolyVertexIdx !== null) {
      const ll = map.unproject([cx, cy]);
      updatePolygonVertex(editingVenueId, editPolyVertexIdx, ll.lat, ll.lng);
      canvas.style.cursor = 'grabbing';
      draw();
      return;
    }

    if (editDraggingPolyEdge && editPolyEdgeIdx !== null) {
      shiftPolygonEdge(editingVenueId, editPolyEdgeIdx, cx, cy);
      canvas.style.cursor = 'grabbing';
      draw();
      return;
    }

    if (editDraggingPolyTranslate) {
      moveActivePolygonTo(cx, cy);
      canvas.style.cursor = 'grabbing';
      draw();
      return;
    }

    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
      }
      return;
    }

    const vEdit = VENUES.find(x => x.id === editingVenueId);

    if (typeof editVertexMode !== 'undefined' && editVertexMode) {
      canvas.style.cursor = 'crosshair';
      return;
    }

    if (typeof hitTestActivePolygonVertex === 'function'
        && hitTestActivePolygonVertex(cx, cy) !== null) {
      canvas.style.cursor = 'grab';
      return;
    }
    if (typeof hitTestActivePolygonEdge === 'function'
        && hitTestActivePolygonEdge(cx, cy) !== null) {
      canvas.style.cursor = 'move';
      return;
    }
    if (typeof hitTestActivePolygonInterior === 'function'
        && hitTestActivePolygonInterior(cx, cy)) {
      canvas.style.cursor = 'move';
      return;
    }

    if (vEdit?.terraceType && vEdit.terraceType !== 'street') {
      canvas.style.cursor = 'default';
      return;
    }

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
  if (editDraggingPolyVertex || editDraggingPolyEdge || editDraggingPolyTranslate) {
    editDraggingPolyVertex = false;
    editPolyVertexIdx      = null;
    editDraggingPolyEdge   = false;
    editPolyEdgeIdx        = null;
    if (editDraggingPolyTranslate && typeof endPolygonTranslate === 'function') {
      endPolygonTranslate();
    }
    canvas.style.cursor    = 'default';
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
      null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd,
      v.seatingPolygonOverride);
    sunWindowCache.clear();
    dispatchToWorker(datePicker.value);
    if (typeof _updateEditToolButtons === 'function') _updateEditToolButtons();
    _setEditChanged();
    _enableMapInteractions();
    draw();
  }
  if (editDraggingDepth) {
    editDraggingDepth = false;
    const v = VENUES.find(x => x.id === editingVenueId);
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
      null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd);
    editDragWallObj = null;
    canvas.style.cursor = 'default';
    _setEditChanged();
    _enableMapInteractions();
  }
});

canvas.addEventListener('wheel', e => {
  canvas.style.pointerEvents = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  canvas.style.pointerEvents = 'auto';
  if (el) el.dispatchEvent(new WheelEvent('wheel', e));
}, { passive: true });

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

    if (typeof editVertexMode !== 'undefined' && editVertexMode) {
      _editTouchId = t.identifier;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (typeof hitTestActivePolygonVertex === 'function') {
      const cornerIdx = hitTestActivePolygonVertex(cx, cy);
      if (cornerIdx !== null) {
        editDraggingPolyVertex = true;
        editPolyVertexIdx      = cornerIdx;
        _editTouchId = t.identifier;
        _disableMapInteractions();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (typeof hitTestActivePolygonEdge === 'function') {
      const edgeIdx = hitTestActivePolygonEdge(cx, cy);
      if (edgeIdx !== null) {
        editDraggingPolyEdge = true;
        editPolyEdgeIdx      = edgeIdx;
        _editTouchId = t.identifier;
        _disableMapInteractions();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (typeof hitTestActivePolygonInterior === 'function'
        && hitTestActivePolygonInterior(cx, cy)
        && typeof startPolygonTranslate === 'function') {
      if (startPolygonTranslate(cx, cy)) {
        _editTouchId = t.identifier;
        _disableMapInteractions();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    const dh = hitTestDepthHandle(cx, cy);
    if (dh) {
      editDraggingDepth = true;
      editDragWallObj   = dh;
      _editTouchId = t.identifier;
      _disableMapInteractions();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!editingVenueId) return;
    const t = Array.from(e.touches).find(tt => tt.identifier === _editTouchId) ?? e.touches[0];
    if (!t) return;
    const rect = canvas.getBoundingClientRect();
    const cx = t.clientX - rect.left, cy = t.clientY - rect.top;

    if (editDraggingPolyVertex && editPolyVertexIdx !== null) {
      const ll = map.unproject([cx, cy]);
      updatePolygonVertex(editingVenueId, editPolyVertexIdx, ll.lat, ll.lng);
      draw();
      e.preventDefault(); return;
    }
    if (editDraggingPolyEdge && editPolyEdgeIdx !== null) {
      shiftPolygonEdge(editingVenueId, editPolyEdgeIdx, cx, cy);
      draw();
      e.preventDefault(); return;
    }
    if (editDraggingPolyTranslate) {
      moveActivePolygonTo(cx, cy);
      draw();
      e.preventDefault(); return;
    }
    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
      }
      e.preventDefault(); return;
    }
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (editingVenueId && (editDraggingDepth || editDraggingPolyVertex
                        || editDraggingPolyEdge || editDraggingPolyTranslate)) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth,
        null, v.terraceType, v.terraceDetachedLocation, v.terraceWallTrimStart, v.terraceWallTrimEnd,
        v.seatingPolygonOverride);
      const wasPoly = editDraggingPolyVertex || editDraggingPolyEdge || editDraggingPolyTranslate;
      editDraggingDepth = false; editDragWallObj = null;
      editDraggingPolyVertex = false; editPolyVertexIdx = null;
      editDraggingPolyEdge = false; editPolyEdgeIdx = null;
      if (editDraggingPolyTranslate && typeof endPolygonTranslate === 'function') {
        endPolygonTranslate();
      }
      _editTouchId = null;
      _enableMapInteractions();
      _setEditChanged();
      if (wasPoly) {
        sunWindowCache.clear();
        dispatchToWorker(datePicker.value);
        if (typeof _updateEditToolButtons === 'function') _updateEditToolButtons();
      }
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

      if (typeof editVertexMode !== 'undefined' && editVertexMode === 'del') {
        const idx = (typeof hitTestActivePolygonVertex === 'function')
          ? hitTestActivePolygonVertex(cx, cy) : null;
        if (idx !== null) {
          deletePolygonVertex(editingVenueId, idx);
          _setEditChanged();
          sunWindowCache.clear();
          dispatchToWorker(datePicker.value);
          if (typeof _updateEditToolButtons === 'function') _updateEditToolButtons();
        }
        if (typeof setEditVertexMode === 'function') setEditVertexMode(null);
        draw();
        return;
      }
      if (typeof editVertexMode !== 'undefined' && editVertexMode === 'add') {
        const hit = (typeof hitTestActivePolygonEdgeAt === 'function')
          ? hitTestActivePolygonEdgeAt(cx, cy, 18) : null;
        if (hit) {
          insertPolygonVertexAt(editingVenueId, hit.edgeIdx, hit.lat, hit.lng);
          _setEditChanged();
          sunWindowCache.clear();
          dispatchToWorker(datePicker.value);
          if (typeof _updateEditToolButtons === 'function') _updateEditToolButtons();
        }
        if (typeof setEditVertexMode === 'function') setEditVertexMode(null);
        draw();
        return;
      }

      const wallIdx = hitTestWall(cx, cy);
      if (wallIdx !== null && (!v?.terraceType || v.terraceType === 'street')
          && !v?.seatingPolygonOverride) selectWallByIdx(wallIdx);
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
