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
// Pill demote/promote HYSTERESIS: a pill stays a pill until it's clearly too
// close (< DEMOTE), a dot promotes only with clear room (> PROMOTE). The dead
// zone between them stops the pill↔dot decision flickering at the threshold
// when pins are dense (the morph can't settle if the decision keeps flipping).
const PILL_DEMOTE_GAP  = 70;
const PILL_PROMOTE_GAP = 94;

// ── Dot clustering (merge / explode) ────────────────────────────────────────
// Pills are great as-is; the problem is too many DOTS on screen. So dots
// (never pills) near each other collapse onto a shared ANCHOR — they target
// the same point, so they read as ONE dot. Zoom in and they "explode": each
// glides out to its own position. SAME dot size/type throughout — no bubbles.
//
// The merge is a CONTINUOUS RAMP, not a binary decision with a hysteresis gap:
// a dot's "merge progress" is a smooth function of its LIVE distance to the
// anchor — fully merged (on the anchor) at ≤ DOT_MERGE_PX, fully separate (own
// position) at ≥ DOT_SPREAD_PX, interpolated between. Because progress tracks
// the live distance it's symmetric (same at a given separation regardless of
// zoom direction), needs no temporal smoothing (so panning has zero lag and
// the explode glides with the zoom itself), and there's nothing to flicker.
const DOT_MERGE_PX  = 16;   // ≤ this real-px separation: dots fully merged onto the anchor
const DOT_SPREAD_PX = 34;   // ≥ this: dots fully separate (own position)
let   _frameDots = [];          // collected each draw: { x, y, inSun, alpha, vid }
// Shared per-venue presence envelope — the single "is this marker on the map"
// fade, used by BOTH pills and dots so a pill→dot demote doesn't re-fade in.
// { vis, lastA, px, py, inSun, wasDot }. vis = presence 0..1; lastA = last
// rendered dot alpha (so a departing dot fades from where it actually was).
const _markerVis = new Map();
// Committed anchor per venue (vid → anchorVid). Carried frame-to-frame so a
// cluster's anchor identity is STICKY: new dots join the existing anchor rather
// than a new "nearest" one being picked each frame, so the merged dot doesn't
// jump around (which was itself triggering further merges).
const _dotAnchor = new Map();

// Cached per-venue distance from the user location. The cache is keyed by
// venue.id; we detect userLocation moves by comparing the live ref against
// the one captured at fill time and rebuild on miss. Venue coordinates are
// effectively immutable (only newly-pushed suggested venues add entries),
// so an id-keyed cache stays correct across pan/zoom.
const _kmFromUserCache = new Map();
let _kmFromUserRef = null;
function _kmFromUser(v) {
  if (typeof userLocation === 'undefined' || !userLocation) return Infinity;
  if (userLocation !== _kmFromUserRef) {
    _kmFromUserCache.clear();
    _kmFromUserRef = userLocation;
  }
  const cached = _kmFromUserCache.get(v.id);
  if (cached !== undefined) return cached;
  const dLat = (v.lat - userLocation.lat) * 111;
  const dLng = (v.lng - userLocation.lng) * 111 * Math.cos(v.lat * Math.PI / 180);
  const km = Math.hypot(dLat, dLng);
  _kmFromUserCache.set(v.id, km);
  return km;
}

// ── Pin tier classification ────────────────────────────────────────────────────
// WAITING_HORIZON_MIN: venues count as Waiting if sun arrives within this window.
// HERO_ACTIONABLE_MIN: legacy actionable cutoff — kept for compatibility with
// classifyPin's return shape; the new pill always shows the time, so the flag
// is consulted but doesn't change rendering.
const WAITING_HORIZON_MIN = 240;
const HERO_ACTIONABLE_MIN = 60;

// Memoized classification cache. Keyed by venue.id + dateStr + 5-min hour
// bucket — fine for tier accuracy since a venue's tier only changes at sun
// window boundaries, and a 5-min bucket means the worst-case staleness is
// 5 min around a transition. minsLeft / minutesUntil are recomputed
// post-cache from the continuous-hour value so the badges stay live.
//
// Invalidation: dateStr change, weather/sun-table refresh, or explicit
// clear. The cache is cleared from app.js via window.invalidateClassifyPin.
const _classifyPinCache = new Map();
function _classifyPinKey(vid, dateStr, hour) {
  return `${vid}|${dateStr}|${Math.floor(hour * 12)}`;
}
function invalidateClassifyPin() { _classifyPinCache.clear(); }
if (typeof window !== 'undefined') window.invalidateClassifyPin = invalidateClassifyPin;

/**
 * Classify a venue into Hero / Waiting / Context for the given hour and date.
 * Returns: { tier, actionable?, endHour?, minsLeft?,
 *            minutesUntil?, nextStart?,
 *            hasSunLaterToday?, closedOpeningIntoSun? }
 */
function classifyPin(v, dateStr, hour) {
  // Cache lookup. The hour-dependent fields (minsLeft / minutesUntil) are
  // recomputed on cache hit from the actual hour, since the bucket has up
  // to 5 min of resolution and we don't want the badge text to stall.
  const key = _classifyPinKey(v.id, dateStr, hour);
  const cached = _classifyPinCache.get(key);
  if (cached) {
    if (cached.tier === 'hero' && cached.endHour != null) {
      return { ...cached, minsLeft: Math.round(Math.max(0, cached.endHour - hour) * 60) };
    }
    if (cached.tier === 'waiting' && cached.nextStart != null) {
      return { ...cached, minutesUntil: Math.round((cached.nextStart - hour) * 60) };
    }
    return cached;
  }

  const result = _classifyPinUncached(v, dateStr, hour);
  _classifyPinCache.set(key, result);
  return result;
}

function _classifyPinUncached(v, dateStr, hour) {
  let windows;
  try {
    ({ windows } = computeSunWindows(v, dateStr));
  } catch (e) {
    console.warn('[classifyPin] computeSunWindows threw for', v && v.id, e);
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

// Friend module geometry (capsule of stacked avatars)
const AVATAR_R          = 8;      // each avatar is 16px diameter
const AVATAR_OVERLAP    = 6;      // adjacent avatars overlap by this many px
const BORDER_W          = 2;      // status ring around the friend module
const MAX_AVATARS       = 2;      // stack up to 2 avatars; 3+ adds inline "+N" text
const PLUS_FONT         = 'bold 10px "Inter", system-ui, sans-serif';
const PLUS_GAP_INNER    = 2;      // gap between last avatar and "+N" text inside the capsule
const PLUS_PAD_RIGHT    = 5;      // inner padding on the right edge of the capsule

// ── Status colour for the dot / friend capsule ────────────────────────────────
// All dots use Delft Blue (#111E38) at varying opacities — provides strong
// contrast against both Sunny golden pills (hero) and Jordy Blue shade pills.
function _dotColors(tier, closed, hasSunLaterToday) {
  const DOT = TOKENS.bg || '#111E38';  // always Delft Blue

  if (tier === 'hero') {
    return closed
      ? { fill: _rgba(DOT, 0.50), ring: _rgba(DOT, 0.20) }  // opening soon
      : { fill: DOT,              ring: _rgba(DOT, 0.30) };  // in sun
  }
  if (tier === 'waiting') {
    return closed
      ? { fill: _rgba(DOT, 0.35), ring: _rgba(DOT, 0.15) }  // opening soon
      : { fill: _rgba(DOT, 0.55), ring: _rgba(DOT, 0.20) }; // in shade, sun later
  }
  // Context — no near-term sun
  const a = hasSunLaterToday ? 0.45 : 0.30;
  return { fill: _rgba(DOT, a), ring: _rgba(DOT, 0.12) };
}

// Map dot colour — for STANDALONE dots + the dot⇄pill morph residual. Matches
// the pill body colour (gold = sun, blue = shade) so a dot reads as the same
// venue in collapsed form; opening-soon is a hollow ghost with a dark ring.
// Distinct from _dotColors above, which colours the small status dot INSIDE a
// pill (that stays dark Delft for contrast on the coloured pill body).
function _dotMapColors(tier, closed, hasSunLaterToday) {
  const INK = TOKENS.bg || '#111E38';
  if (closed) {
    return { fill: 'transparent', ring: _rgba(INK, 0.45) };  // ghost
  }
  const base = (tier === 'hero') ? '#F5C25E' : '#9CBDE7';
  const a = (tier === 'context') ? (hasSunLaterToday ? 0.75 : 0.55) : 1.0;
  return { fill: _rgba(base, a), ring: _rgba(INK, 0.20) };
}

// ── Vector category icons ─────────────────────────────────────────────────────
// Genuine Lucide path data (coffee / martini / utensils-crossed), stroked on
// canvas at pin scale via Path2D — same marks as the list + detail panel, so
// map and list read as one family. Colour is tier-aware: dark warm brown on
// honey for hero (high contrast on light), cream on the slate shadow capsules.
const _CAT_PIN_PATHS = {
  cafe:       ['M17 8h1a4 4 0 1 1 0 8h-1', 'M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z', 'M6 2v2', 'M10 2v2', 'M14 2v2'],
  bar:        ['M8 22h8', 'M12 11v11', 'm5 3 7 8 7-8z'],
  restaurant: ['M3 2v7c0 1.1.9 2 2 2a2 2 0 0 0 2-2V2', 'M5 2v20', 'M21 15V2a5 5 0 0 0-3 5v6c0 1.1.9 2 2 2h1zm0 0v7'],
};
const _catPathCache = {};
function _catPaths(category) {
  if (!(category in _catPathCache)) {
    const ds = _CAT_PIN_PATHS[category];
    _catPathCache[category] = ds ? ds.map(d => new Path2D(d)) : null;
  }
  return _catPathCache[category];
}

function _drawCategoryIcon(ctx, cx, cy, category, color) {
  const col   = color || '#fff';
  const paths = _catPaths(category);
  if (!paths) {                              // fallback: simple dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3.0, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    return;
  }
  const ICON = 13;                           // displayed icon box (px) in the ~20px dot
  const s = ICON / 24;                        // Lucide is a 24-unit grid
  ctx.save();
  ctx.translate(cx - ICON / 2, cy - ICON / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = col;
  ctx.lineWidth   = 2.6;                      // ~1.4px rendered after scale
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  for (const p of paths) ctx.stroke(p);
  ctx.restore();
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

// ── Invite avatar pin (accept page / post-accept confirm) ─────────────────────
// Renders the entire attendee list as a vertical cream card hanging above
// the venue:
//   ┌─────────────────────┐
//   │ 18:00               │  ← header (meet time)
//   ├─────────────────────┤
//   │ (A) Anna            │
//   │ (J) Jonas  +10m     │  ← honey-tinted discrepancy
//   │ (M) Marit           │
//   │ (E) Erik   +1h      │
//   └──────────┬──────────┘
//              ▼
//              ●          ← venue point
// Drawn only when body.plan-preview-active OR body.post-accept-active is set
// AND window._invitePin is populated. Receiver themselves is excluded from
// the attendee list (panel handles their own RSVP).
const INVITE_CARD_PAD_X       = 10;
const INVITE_CARD_PAD_Y       = 6;
const INVITE_CARD_ROW_H       = 22;
const INVITE_CARD_HEADER_H    = 24;
const INVITE_CARD_HEADER_GAP  = 4;   // gap between header and first row
const INVITE_AV_R             = 9;   // 18 px diameter — small enough to stack
const INVITE_AV_GAP           = 8;   // gap between avatar and name
const INVITE_DISC_GAP         = 10;  // gap between name and discrepancy
const INVITE_TIP_H            = 10;
const INVITE_TIP_W            = 14;
const INVITE_TIP_GAP          = 10;  // pin floats above the venue dot (user request)
const INVITE_MAX_ROWS         = 6;   // overflow → '+N more' as the 7th row
const INVITE_CARD_MIN_W       = 130;
const INVITE_CARD_MAX_W       = 240;
const INVITE_NAME_FONT        = '600 13px "Inter", system-ui, sans-serif';
const INVITE_DISC_FONT        = '700 11.5px "Inter", system-ui, sans-serif';
const INVITE_HEADER_FONT      = '700 14px "Inter", system-ui, sans-serif';
const INVITE_OVERFLOW_FONT    = '500 12px "Inter", system-ui, sans-serif';
const INVITE_INITIAL_FONT     = '700 11px "Inter", system-ui, sans-serif';
// Deeper amber for the discrepancy label so it has real contrast on cream
// (TOKENS.accent #F5C25E is too pale on #FAF1DD — barely legible). Stays
// in the honey family so it still reads as a 'sun' notice, not a warning.
const INVITE_DISC_COLOR       = '#A86F1A';
function _inviteOffsetLabel(offsetMin) {
  if (!Number.isFinite(offsetMin) || Math.abs(offsetMin) < 5) return '';
  const sign = offsetMin < 0 ? '-' : '+';
  const m = Math.abs(Math.round(offsetMin));
  if (m < 60) return `${sign}${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${sign}${h}h` : `${sign}${h}h ${r}m`;
}
function _drawInviteAvatarPin(ctx, pt, invitePin) {
  const attendees = Array.isArray(invitePin.attendees) ? invitePin.attendees : [];
  const declined  = Array.isArray(invitePin.declined)  ? invitePin.declined  : [];
  if (!attendees.length && !declined.length) return; // nobody responded yet

  // Entrance animation for a just-added attendee (the receiver, on confirm).
  // Any attendee carrying `_enterAt` fades + slides in while its row height
  // grows from 0, so the card expands by one row. We repaint until settled.
  const _now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ENTER_DUR = 360;
  let _needsRepaint = false;
  const _enterT = (a) => {
    if (!a || !a._enterAt || _pulseReduceMotion) return 1;
    const tt = Math.max(0, Math.min(1, (_now - a._enterAt) / ENTER_DUR));
    if (tt < 1) _needsRepaint = true;
    return 1 - Math.pow(1 - tt, 3); // ease-out cubic
  };

  // Budget rows across accepted + declined. Accepted always get rendered
  // first; declined rows stack below a hairline separator. If the total
  // would overflow INVITE_MAX_ROWS, declined are trimmed first via a
  // '+N declined' overflow line.
  const visible = attendees.slice(0, INVITE_MAX_ROWS);
  const overflow = Math.max(0, attendees.length - INVITE_MAX_ROWS);
  const remainingRows = Math.max(0, INVITE_MAX_ROWS - visible.length - (overflow > 0 ? 1 : 0));
  const visibleDeclined = declined.slice(0, remainingRows);
  const declinedOverflow = Math.max(0, declined.length - visibleDeclined.length);
  const timeStr  = (typeof _fmtTime === 'function') ? _fmtTime(invitePin.meetHour) : '';
  // headerLabel can override the default "Meeting at" prefix — used by
  // friend-presence pins to read "Sol fra 18:35" etc. Bare strings are
  // also accepted (passed via headerText, no time appended).
  const meetLabel = invitePin.headerLabel
    ?? ((typeof t === 'function') ? t('invite_pin_meeting_at') : 'Meeting at');
  const headerTime = invitePin.headerText
    ? invitePin.headerText
    : (timeStr ? `${meetLabel} ${timeStr}` : '');

  // Measure: card width = max(rows, header) + padding. Each row's width is
  // pad + avatar + gap + name + (disc ? gap + disc : 0) + pad.
  const rowDescriptors = visible.map(a => {
    const first = (a.name || '').trim().split(/\s+/)[0] || '?';
    const disc = _inviteOffsetLabel(a.offsetMin);
    return { name: first, disc, declined: false, original: a, enterT: _enterT(a) };
  });
  if (overflow > 0) {
    const moreLabel = (typeof t === 'function') ? t('pin_overflow_more', { count: overflow }) : `+${overflow} more`;
    rowDescriptors.push({ name: moreLabel, disc: '', isOverflow: true });
  }
  // Declined block — separator + rendered rows. Separator is a virtual
  // row that consumes no extra height; rendering handles it inline by
  // measuring whether we just crossed from accepted to declined.
  for (const d of visibleDeclined) {
    const first = (d.name || '').trim().split(/\s+/)[0] || '?';
    rowDescriptors.push({ name: first, disc: '', declined: true, original: d });
  }
  if (declinedOverflow > 0) {
    const declinedLabel = (typeof t === 'function') ? t('pin_overflow_declined', { count: declinedOverflow }) : `+${declinedOverflow} declined`;
    rowDescriptors.push({ name: declinedLabel, disc: '', isOverflow: true, declined: true });
  }

  let maxRowW = 0;
  for (const r of rowDescriptors) {
    ctx.font = r.isOverflow ? INVITE_OVERFLOW_FONT : INVITE_NAME_FONT;
    let w = INVITE_CARD_PAD_X * 2 + 2 * INVITE_AV_R + INVITE_AV_GAP + Math.ceil(ctx.measureText(r.name).width);
    if (r.disc) {
      ctx.font = INVITE_DISC_FONT;
      w += INVITE_DISC_GAP + Math.ceil(ctx.measureText(r.disc).width);
    }
    if (w > maxRowW) maxRowW = w;
  }
  if (headerTime) {
    ctx.font = INVITE_HEADER_FONT;
    const hW = INVITE_CARD_PAD_X * 2 + Math.ceil(ctx.measureText(headerTime).width);
    if (hW > maxRowW) maxRowW = hW;
  }
  const cardW = Math.max(INVITE_CARD_MIN_W, Math.min(INVITE_CARD_MAX_W, maxRowW));

  const headerH = headerTime ? INVITE_CARD_HEADER_H + INVITE_CARD_HEADER_GAP : 0;
  // Entering rows contribute a fraction of their height so the card grows
  // smoothly as the new attendee slides in.
  let rowsH = 0;
  for (const r of rowDescriptors) rowsH += INVITE_CARD_ROW_H * (r.enterT != null ? r.enterT : 1);
  const cardH   = INVITE_CARD_PAD_Y * 2 + headerH + rowsH;

  const cardX = Math.round(pt.x - cardW / 2);
  const cardY = Math.round(pt.y - INVITE_TIP_GAP - INVITE_TIP_H - cardH);

  // Card background
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 14);
  ctx.fillStyle = '#FAF1DD';
  ctx.fill();

  // Header (meet time)
  let cursorY = cardY + INVITE_CARD_PAD_Y;
  if (headerTime) {
    ctx.font         = INVITE_HEADER_FONT;
    ctx.fillStyle    = _rgba(TOKENS.bg, 0.92);
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    ctx.fillText(headerTime, cardX + INVITE_CARD_PAD_X, cursorY + INVITE_CARD_HEADER_H / 2);
    // Hairline divider
    ctx.beginPath();
    ctx.moveTo(cardX + INVITE_CARD_PAD_X, cursorY + INVITE_CARD_HEADER_H + 1);
    ctx.lineTo(cardX + cardW - INVITE_CARD_PAD_X, cursorY + INVITE_CARD_HEADER_H + 1);
    ctx.strokeStyle = _rgba(TOKENS.bg, 0.10);
    ctx.lineWidth = 1;
    ctx.stroke();
    cursorY += INVITE_CARD_HEADER_H + INVITE_CARD_HEADER_GAP;
  }

  // Rows
  let drewDeclineSeparator = false;
  for (let i = 0; i < rowDescriptors.length; i++) {
    const r = rowDescriptors[i];
    // Draw a hairline separator the first time we enter the declined
    // block, so the visual structure reads as 'accepted, then declined'
    // instead of one flat list.
    if (r.declined && !drewDeclineSeparator) {
      ctx.beginPath();
      ctx.moveTo(cardX + INVITE_CARD_PAD_X, cursorY + 0.5);
      ctx.lineTo(cardX + cardW - INVITE_CARD_PAD_X, cursorY + 0.5);
      ctx.strokeStyle = _rgba(TOKENS.bg, 0.10);
      ctx.lineWidth = 1;
      ctx.stroke();
      drewDeclineSeparator = true;
    }
    // Entering rows: scale the allocated height and fade + slide the content
    // (starts 8px low, eases up into place).
    const rEnterT = (r.enterT != null) ? r.enterT : 1;
    const rh = INVITE_CARD_ROW_H * rEnterT;
    const slideY = (rEnterT < 1) ? (1 - rEnterT) * 8 : 0;
    const rowCy = cursorY + rh / 2 + slideY;
    const _prevAlpha = ctx.globalAlpha;
    if (rEnterT < 1) ctx.globalAlpha = _prevAlpha * rEnterT;

    if (r.isOverflow) {
      ctx.font         = INVITE_OVERFLOW_FONT;
      ctx.fillStyle    = _rgba(TOKENS.bg, r.declined ? 0.40 : 0.55);
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      ctx.fillText(r.name, cardX + INVITE_CARD_PAD_X, rowCy);
    } else {
      // Avatar — full colour for accepted, greyed for declined.
      const avCx = cardX + INVITE_CARD_PAD_X + INVITE_AV_R;
      const original = r.original;
      ctx.beginPath();
      ctx.arc(avCx, rowCy, INVITE_AV_R, 0, Math.PI * 2);
      ctx.fillStyle = r.declined
        ? _rgba(TOKENS.bg, 0.20)
        : _friendColor(original.id || original.name);
      ctx.fill();
      // Initial
      ctx.font         = INVITE_INITIAL_FONT;
      ctx.fillStyle    = r.declined ? _rgba(TOKENS.bg, 0.45) : _rgba(TOKENS.bg, 0.92);
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'center';
      ctx.fillText(_friendInitial({ name: original.name }), avCx, rowCy + 0.5);
      // Name
      ctx.font         = INVITE_NAME_FONT;
      ctx.fillStyle    = r.declined ? _rgba(TOKENS.bg, 0.45) : _rgba(TOKENS.bg, 0.92);
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'left';
      const nameX = avCx + INVITE_AV_R + INVITE_AV_GAP;
      ctx.fillText(r.name, nameX, rowCy);
      // Strikethrough on declined rows — same color as the dimmed text.
      if (r.declined) {
        const nameW = Math.ceil(ctx.measureText(r.name).width);
        ctx.beginPath();
        ctx.moveTo(nameX, rowCy + 0.5);
        ctx.lineTo(nameX + nameW, rowCy + 0.5);
        ctx.strokeStyle = _rgba(TOKENS.bg, 0.45);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      // Discrepancy (right-aligned, deeper amber for contrast).
      if (r.disc) {
        ctx.font         = INVITE_DISC_FONT;
        ctx.fillStyle    = INVITE_DISC_COLOR;
        ctx.textAlign    = 'right';
        ctx.fillText(r.disc, cardX + cardW - INVITE_CARD_PAD_X, rowCy);
      }
    }

    ctx.globalAlpha = _prevAlpha;
    cursorY += rh;
  }

  // Tip — equilateral-ish triangle pointing from the card bottom centre to
  // the venue point. Drawn in the same cream so it merges with the card.
  const tipCx = pt.x;
  const tipTop = cardY + cardH;
  ctx.beginPath();
  ctx.moveTo(tipCx - INVITE_TIP_W / 2, tipTop);
  ctx.lineTo(tipCx + INVITE_TIP_W / 2, tipTop);
  ctx.lineTo(tipCx, tipTop + INVITE_TIP_H);
  ctx.closePath();
  ctx.fillStyle = '#FAF1DD';
  ctx.fill();

  // Keep painting while a row is still animating in. Must go through the
  // anim scheduler (sets _drawDirty) — a bare triggerRepaint() fires a
  // 'render' the handler ignores when _drawDirty is false (idle map), which
  // made the entrance update only when the camera happened to be moving.
  if (_needsRepaint) { _animDirty = true; _scheduleAnim(); }
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

// Reduced-motion: the pulse is a continuous ambient flourish — suppress it
// entirely so the friend pill renders static. Cached + live-updated.
let _pulseReduceMotion = false;
try {
  const _mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  _pulseReduceMotion = _mq.matches;
  _mq.addEventListener('change', (e) => { _pulseReduceMotion = e.matches; });
} catch {}

function _drawPulseRings(ctx, modBounds, now, id) {
  if (_pulseReduceMotion) return;
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

// Clock glyph for opening-soon ghost pills — outline face + two hands.
function _drawClockIcon(ctx, cx, cy, r, col) {
  const rr = r * 0.74;
  ctx.save();
  ctx.strokeStyle = col;
  ctx.lineWidth   = 1.4;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, rr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - rr * 0.55);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + rr * 0.42, cy + rr * 0.16);
  ctx.stroke();
  ctx.restore();
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

  // Opening-soon (closed now, opens later): de-emphasized "ghost" pill —
  // transparent body + dark hairline outline + reduced group opacity so it
  // recedes vs the solid gold (sun) / blue (shade) pills. Selected still lifts.
  const isGhost = !!opts.closedNow && !opts.selected;
  // Striped "shade" pin — cream base + Delft Blue diagonal stripes (the logo
  // motif). Applies to open non-hero pills only: hero stays solid honey,
  // selected stays solid Delft, ghost stays outline-only. See DESIGN.md.
  const isStriped = !isGhost && !opts.selected && tier !== 'hero';

  // Group alpha for the ghost state — wraps the whole pill (body, dot, text).
  ctx.save();
  if (isGhost) ctx.globalAlpha = 0.72;

  const scale = opts.scale || 1.0;
  const shAlpha   = 0.18 + Math.max(0, scale - 1) * 0.60;
  const shBlur    = 6 + Math.max(0, scale - 1) * 18;
  const shOffsetY = 2 + Math.max(0, scale - 1) * 6;

  if (isGhost) {
    // Outline-only — no fill, no drop shadow.
    pillPath();
    ctx.strokeStyle = _rgba(TOKENS.bg, 0.45);
    ctx.lineWidth   = 1.25;
    ctx.stroke();
  } else {
    // Base fill, with the scale-aware drop shadow. hero = solid honey,
    // selected = solid Delft, shade = cream base (stripes layered on next).
    ctx.save();
    ctx.shadowColor   = `rgba(17,30,56,${shAlpha.toFixed(2)})`;
    ctx.shadowBlur    = shBlur;
    ctx.shadowOffsetY = shOffsetY;
    pillPath();
    ctx.fillStyle = opts.selected ? (TOKENS.surface || '#111E38')
                  : (tier === 'hero') ? (TOKENS.accent || '#F5C25E')
                  : (TOKENS.text || '#FFF4E0');
    ctx.fill();
    ctx.restore();

    // Diagonal stripes (shade pin only) — 135°, 5.5px period, 50% ink fill.
    if (isStriped) {
      ctx.save();
      pillPath();
      ctx.clip();
      ctx.translate(cx, y + PILL_H / 2);
      ctx.rotate(135 * Math.PI / 180);
      const diag = Math.hypot(w, PILL_H) + 4;
      const period = 5.5, inkW = period * 0.5;
      ctx.fillStyle = TOKENS.jordy || '#9CBDE7';
      for (let p = -diag; p <= diag; p += period) ctx.fillRect(p, -diag, inkW, diag * 2);
      ctx.restore();
    }

    // 2.5px border — same width across every state so all pills are one size.
    // shade = solid Jordy; hero/selected = own fill colour (size-only, no line).
    pillPath();
    ctx.strokeStyle = isStriped   ? (TOKENS.jordy || '#9CBDE7')
                    : opts.selected ? (TOKENS.surface || '#111E38')
                    : (TOKENS.accent || '#F5C25E');
    ctx.lineWidth   = 2.5;
    ctx.stroke();
  }

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
  // Striped pin: dot/friend-capsule/heart read as solid Delft against the cream
  // body + Jordy stripes (the tier-opacity nuance was for the old flat fill).
  if (isStriped) dot.fill = TOKENS.bg || '#111E38';
  const moduleW    = hasFriends ? _friendModuleW(ctx, friends.length) : CIRCLE_R * 2;
  const moduleCx   = x + PAD_L + moduleW / 2;
  const moduleCy   = y + PILL_H / 2;

  ctx.save();
  ctx.shadowColor = 'transparent';
  if (isGhost && !hasFriends && !opts.favorited) {
    // Ghost: a dark clock glyph (outline) instead of a filled category dot —
    // signals "opening later", not available now.
    _drawClockIcon(ctx, moduleCx, moduleCy, CIRCLE_R, _rgba(TOKENS.bg, 0.80));
  } else if (hasFriends) {
    _drawFriendModule(ctx, moduleCx, moduleCy, friends, dot.fill);
  } else if (opts.favorited) {
    // Favourited: the circle itself becomes a heart, filled with the same
    // tier colour the dot would have used (hero=honey, waiting/shadow=
    // slate) so the sun-state read is preserved. No inner glyph — the
    // heart silhouette IS the identity, and category info on a venue
    // you've favourited is something you already know.
    _drawHeartIcon(ctx, moduleCx, moduleCy, CIRCLE_R * 2 + 1, dot.fill);
  } else {
    ctx.beginPath();
    ctx.arc(moduleCx, moduleCy, CIRCLE_R, 0, Math.PI * 2);
    ctx.fillStyle = dot.fill;
    ctx.fill();
    // Icon colour: always cream — dot is always Delft Blue so cream is the correct contrast.
    const iconCol = TOKENS.text || '#FFF4E0';
    _drawCategoryIcon(ctx, moduleCx, moduleCy, opts.category, iconCol);
  }
  ctx.restore();

  // Time text — cream on selected (dark Delft Blue) pill; dark on Sunny/ghost
  // pills. On the striped shade pill the stripes run under the text, so it's
  // 700 ink on a cream halo (keeps the motif visible while staying legible).
  if (time) {
    const tx = moduleCx + moduleW / 2 + CIRCLE_TIME_GAP;
    const ty = moduleCy + 0.5;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    if (isStriped) {
      ctx.font        = '700 11px "Inter", system-ui, sans-serif';
      ctx.lineJoin    = 'round';
      ctx.lineWidth   = 4;                         // 2px halo each side
      ctx.strokeStyle = TOKENS.text || '#FFF4E0';
      ctx.strokeText(time, tx, ty);
      ctx.fillStyle   = TOKENS.bg || '#111E38';
      ctx.fillText(time, tx, ty);
    } else {
      ctx.font      = '600 11px "Inter", system-ui, sans-serif';
      ctx.fillStyle = opts.selected ? (TOKENS.text || '#FFF4E0') : _rgba(TOKENS.bg, 0.88);
      ctx.fillText(time, tx, ty);
    }
  }

  ctx.restore();   // group alpha (ghost)
}

// Material Design heart icon — well-formed at small sizes, no hand-rolled
// Bézier guesswork. Drawn via Path2D so the same path string renders
// pixel-identically at any size. Inscribed in a 24×24 viewBox; the
// caller passes the desired output size + a fill colour. Filled, not
// stroked — the silhouette is what makes the heart read.
const _HEART_PATH_2D = (typeof Path2D !== 'undefined')
  ? new Path2D('M 12 21.35 C 6.5 16 2 12.5 2 8.5 C 2 5.5 4.5 3 7.5 3 C 9.24 3 10.91 3.81 12 5.09 C 13.09 3.81 14.76 3 16.5 3 C 19.5 3 22 5.5 22 8.5 C 22 12.5 17.5 16 12 21.35 Z')
  : null;

function _drawHeartIcon(ctx, cx, cy, size, fill) {
  if (!_HEART_PATH_2D) return;
  const s = size / 24;
  ctx.save();
  // The Material heart's optical centre sits a touch below geometric
  // centre (the bottom point pulls the mass down) — nudge the translate
  // up by ~6% of size so the heart reads as centred in the module slot.
  ctx.translate(cx - 12 * s, cy - 12 * s - size * 0.04);
  ctx.scale(s, s);
  ctx.fillStyle = fill;
  ctx.fill(_HEART_PATH_2D);
  ctx.restore();
}

// ── AABB overlap & density score (for floating name placement) ────────────────
function _overlaps(a, b, m) {
  return !(a.x + a.w + m < b.x || b.x + b.w + m < a.x ||
           a.y + a.h + m < b.y || b.y + b.h + m < a.y);
}
// Spatial hash for label anchor scoring. v1 was O(N²): every candidate
// anchor checked every placed pill AND every placed name. The decay radius
// is only 70px, so we bucket placed rects into 96px cells and only check
// the surrounding 9 cells (centre + 8 neighbours) per scoring call. With
// 50 visible labels that's ~9 vs ~50 comparisons per call — same output,
// linear cost. The bucket builder is called once per draw at the start
// of the name-placement pass.
const _ANCHOR_CELL = 96;
function _bucketRect(grid, rect) {
  const x0 = Math.floor(rect.x / _ANCHOR_CELL);
  const y0 = Math.floor(rect.y / _ANCHOR_CELL);
  const x1 = Math.floor((rect.x + rect.w) / _ANCHOR_CELL);
  const y1 = Math.floor((rect.y + rect.h) / _ANCHOR_CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const key = cx + ',' + cy;
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(rect);
    }
  }
}
function _forEachNearbyCell(grid, rect, fn) {
  // Expand the query rect by the decay radius (70px) so cells that
  // contain pills near the corner aren't missed.
  const PAD = 70;
  const x0 = Math.floor((rect.x - PAD) / _ANCHOR_CELL);
  const y0 = Math.floor((rect.y - PAD) / _ANCHOR_CELL);
  const x1 = Math.floor((rect.x + rect.w + PAD) / _ANCHOR_CELL);
  const y1 = Math.floor((rect.y + rect.h + PAD) / _ANCHOR_CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const arr = grid.get(cx + ',' + cy);
      if (!arr) continue;
      for (const r of arr) fn(r);
    }
  }
}
function _scoreAnchor(rect, pillsGrid, namesGrid, viewport) {
  let s = 100;
  const acx = rect.x + rect.w / 2;
  const acy = rect.y + rect.h / 2;
  let collided = false;
  _forEachNearbyCell(pillsGrid, rect, (p) => {
    if (collided) return;
    if (_overlaps(rect, p, 0)) { collided = true; return; }
    const px = p.x + p.w / 2, py = p.y + p.h / 2;
    const d  = Math.hypot(acx - px, acy - py);
    if (d < 70) s -= (70 - d) * 0.6;
  });
  if (collided) return -Infinity;
  _forEachNearbyCell(namesGrid, rect, (n) => {
    if (collided) return;
    if (_overlaps(rect, n, 1)) { collided = true; return; }
    const nx = n.x + n.w / 2, ny = n.y + n.h / 2;
    const d  = Math.hypot(acx - nx, acy - ny);
    if (d < 70) s -= (70 - d) * 0.9;
  });
  if (collided) return -Infinity;
  if (viewport) {
    if (rect.x < 0)                       s -= 100;
    if (rect.y < 0)                       s -= 100;
    if (rect.x + rect.w > viewport.w)     s -= 100;
    if (rect.y + rect.h > viewport.h)     s -= 100;
  }
  return s;
}

// measureText cache. Pin labels don't change between frames; v1 measured
// every name (and secondary line) per frame per visible pin — a moderate
// allocation + a moderately expensive text-shaping call. Cache keyed by
// "font|text". Cleared when a new VENUES list loads (rebuildVenuesById).
const _textWidthCache = new Map();
function _cachedTextWidth(ctx, font, text) {
  const key = font + '|' + text;
  const hit = _textWidthCache.get(key);
  if (hit !== undefined) return hit;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width);
  _textWidthCache.set(key, w);
  return w;
}

// ── Floating name with cream halo + density-aware anchor ──────────────────────
// Strict: if best candidate's score ≤ 0 (collisions), hidden unless forced.
// placedPills / placedNames are now spatial-hash grids (Map<cellKey, rects[]>).
// _scoreAnchor reads them; _drawName writes new names into placedNames.
function _drawName(ctx, pt, pillRect, name, secondary, placedPills, placedNames, viewport, opts) {
  const lineH = 13;
  const FONT_PRIMARY   = '600 12px "Inter", system-ui, sans-serif';
  const FONT_SECONDARY = '500 11px "Inter", system-ui, sans-serif';
  const nw = _cachedTextWidth(ctx, FONT_PRIMARY, name);
  let sw = 0;
  if (secondary) {
    sw = _cachedTextWidth(ctx, FONT_SECONDARY, secondary);
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
  // Bumped 25 → 45: a side flip must be clearly better before it's taken, so
  // the settle-time reprioritisation reshuffles labels less often. The flips
  // that do happen are smoothed by the cross-fade below.
  const NAME_ANCHOR_HYSTERESIS = 45;

  let best;
  // skipScoring path (map motion): re-use the cached side from a prior
  // settled frame. Skips the 4×_scoreAnchor calls per pin which were the
  // dominant per-frame cost during pan/zoom. Falls back to 'right' for
  // pins that never settled (e.g. just appeared mid-motion).
  if (opts.skipScoring) {
    const side = stickySide || 'right';
    const c = candidates.find(c => c.side === side) || candidates[0];
    best = { ...c, x: c.x, y: c.cy - labelH / 2, w: labelW, h: labelH };
  } else {
    let bestScore = opts.force ? -Infinity : 0;
    best = null;
    for (const c of candidates) {
      const rect = { x: c.x, y: c.cy - labelH / 2, w: labelW, h: labelH };
      let s = _scoreAnchor(rect, placedPills, placedNames, viewport);
      if (stickySide === c.side && s > -Infinity) s += NAME_ANCHOR_HYSTERESIS;
      if (s > bestScore) { bestScore = s; best = { ...c, ...rect }; }
    }
    // Fallback: if no candidate scored above threshold (e.g. all collide
    // with newly-shifted pills after a pan reshuffled the layout), reuse
    // the cached side rather than dropping the label entirely. The cached
    // side may itself be in collision, but the user prefers a transient
    // overlap over labels popping out of existence ("labels appear then
    // disappear as they notice colliding pins" report).
    if (!best && stickySide) {
      const c = candidates.find(c => c.side === stickySide);
      if (c) best = { ...c, x: c.x, y: c.cy - labelH / 2, w: labelW, h: labelH };
    }
    if (!best) return null;
    _bucketRect(placedNames, best);
    if (opts.venueId != null) {
      // Arm a cross-fade if this settle-time re-score moved the label to a
      // different side — so it dissolves to the new spot instead of teleporting.
      if (stickySide && stickySide !== best.side) {
        _labelSideTransition.set(opts.venueId, {
          from: stickySide, to: best.side,
          start: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
        });
      }
      _lastNameAnchor.set(opts.venueId, best.side);
    }
  }
  // Cache content for the fade-out pass in section 5 of draw() — when
  // the pin demotes and its label is no longer rendered here, that pass
  // re-renders the label with the pill's lerping alpha so label fade-out
  // matches pin fade-out (user spec).
  if (opts.venueId != null) {
    _lastLabelInfo.set(opts.venueId, { name, secondary, side: best.side });
  }

  // Google-Maps-style label treatment: white text with a SOFT BLURRED halo
  // (not a hard stroke), near-black so the blurred edges don't tint blue.
  // Anchor alpha (opts.alpha) lets the label fade with the pill morph.
  const LIGHT_FILL  = '#FFFFFF';
  const HALO_COLOR  = 'rgba(0, 0, 0, 1)';
  const labelAlpha  = opts.alpha != null ? opts.alpha : 1;

  // Paint the label at a given anchor position + alpha. Factored out so a
  // side-change cross-fade can paint the old and new positions at once.
  const _paint = (anchorX, anchorCy, a) => {
    if (a <= 0.01) return;
    const tx    = anchorX + 1;
    const nameY = secondary ? anchorCy - lineH / 2 : anchorCy;
    const secY  = anchorCy + lineH / 2;
    ctx.save();
    ctx.globalAlpha  = a;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    ctx.lineJoin     = 'round';
    ctx.miterLimit   = 2;
    // 4 stacked shadow passes compound the halo into a solid dark glow.
    ctx.shadowColor   = HALO_COLOR;
    ctx.shadowBlur    = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle     = LIGHT_FILL;
    ctx.font          = FONT_PRIMARY;
    for (let i = 0; i < 4; i++) ctx.fillText(name, tx, nameY);
    if (secondary) {
      ctx.font = FONT_SECONDARY;
      for (let i = 0; i < 4; i++) ctx.fillText(secondary, tx, secY);
    }
    // Crisp top pass, shadow off.
    ctx.shadowBlur  = 0;
    ctx.shadowColor = 'transparent';
    ctx.font        = FONT_PRIMARY;
    ctx.fillStyle   = LIGHT_FILL;
    ctx.fillText(name, tx, nameY);
    if (secondary) {
      ctx.font      = FONT_SECONDARY;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.fillText(secondary, tx, secY);
    }
    ctx.restore();
  };

  // Cross-fade an in-progress side change; otherwise paint once at `best`.
  const trans = opts.venueId != null ? _labelSideTransition.get(opts.venueId) : null;
  if (trans) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const p = (now - trans.start) / LABEL_SIDE_FADE_MS;
    if (p >= 1) {
      _labelSideTransition.delete(opts.venueId);
      _paint(best.x, best.cy, labelAlpha);
    } else {
      const fromC = candidates.find(c => c.side === trans.from) || best;
      const toC   = candidates.find(c => c.side === trans.to)   || best;
      _paint(fromC.x, fromC.cy, labelAlpha * (1 - p)); // old side fading out
      _paint(toC.x,   toC.cy,   labelAlpha * p);       // new side fading in
      _animDirty = true; // keep repainting until the dissolve finishes
    }
  } else {
    _paint(best.x, best.cy, labelAlpha);
  }

  return best;
}

// ── Sun-remaining line (secondary line at zoom ≥ 16) ──────────────────────────
// Sun still to come from the currently-displayed (slider) time — "3.2h left" /
// "40 min left". Complements the pill's window end-time ("til 18:40"); reads as
// "how much sun if I go now", not the daily total (which includes sun already
// past). Suffix + decimal separator come from i18n (no hardcoded Norwegian).
function _sunRemainingLine(v, dateStr, currentHour) {
  if (typeof computeSunWindows !== 'function') return '';
  try {
    const { windows } = computeSunWindows(v, dateStr);
    if (!windows.length) return '';
    let remaining = 0;
    for (const w of windows) {
      const start = Math.max(w.start, currentHour);
      if (w.end > start) remaining += w.end - start;
    }
    if (remaining <= 0.05) return '';
    const lang = (typeof prefLang === 'function') ? prefLang() : 'no';
    if (remaining >= 1) {
      const raw = remaining.toFixed(1);
      const display = (lang === 'en') ? raw : raw.replace('.', ',');
      return (typeof t === 'function') ? t('map_pin_sun_left_hours', { h: display })
                                       : (display + 't igjen');
    }
    const mins = String(Math.round(remaining * 60));
    return (typeof t === 'function') ? t('map_pin_sun_left_minutes', { n: mins })
                                     : (mins + ' min igjen');
  } catch { return ''; }
}

// Terse pill time text, i18n'd (was hardcoded Norwegian "Åpner/til/fra").
// Returns '' when no time label applies. Fallbacks keep NO if i18n is absent.
function _pillTimeText(closedOpens, openHour, tier, cls) {
  const T = (typeof t === 'function') ? t : null;
  if (closedOpens && openHour != null)
    return T ? T('map_pin_opens', { time: _fmtTime(openHour) }) : 'Åpner ' + _fmtTime(openHour);
  if (tier === 'hero' && cls.endHour)
    return T ? T('map_pin_until', { time: _fmtTime(cls.endHour) }) : 'til ' + _fmtTime(cls.endHour);
  if (tier === 'waiting' && cls.nextStart != null)
    return T ? T('map_pin_from', { time: _fmtTime(cls.nextStart) }) : 'fra ' + _fmtTime(cls.nextStart);
  return '';
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
// Cached label content per pin. Populated by _drawName each time a label
// successfully renders; read by the fade-out pass (section 5 of draw())
// so demoting pins fade their label out at the same rate as the pill —
// label animation = pin animation as the user requested.
// { name, secondary, side } — side is the chosen anchor ('right'|'left'|
// 'top'|'bottom'); position is recomputed from current pillRect on each
// fade-out frame so labels track the pin if the camera moves mid-fade.
const _lastLabelInfo = new Map();
// id → { from, to, start } — an in-progress anchor-side change. On settle the
// re-score can pick a new side; rather than teleporting, we cross-fade the label
// out at the old side and in at the new one over LABEL_SIDE_FADE_MS.
const _labelSideTransition = new Map();
const LABEL_SIDE_FADE_MS = 180;
let   _animDirty = false;
let   _animScheduled = false;
// Set by map move/zoom events AND by _scheduleAnim. Consumed by the
// 'render' handler at the bottom of this file. Declared here so it's in
// scope for _scheduleAnim (defined a few lines below).
let   _drawDirty = false;

// Global label alpha that fades labels out collectively during map
// motion (pan/zoom). Lerps toward _labelMotionTarget at the same rate
// as pin alpha (0.20 per frame ≈ 200ms) so motion and pin animations
// share a tempo. During motion the label SCORING is skipped — we reuse
// each pin's cached anchor side and just track the pill position. The
// motion alpha multiplies the per-pin morph alpha, so a label that was
// also animating in (low morph) doesn't snap to full opacity when the
// map starts moving.
let _labelMotionAlpha  = 1;
let _labelMotionTarget = 1;
// One-shot flag: set true on moveend/zoomend, consumed by the next draw
// to run a single re-scoring pass. The re-score happens while labels
// are still fading in (alpha near 0), so any side change lands BEFORE
// the labels become visible — preventing the "label snaps to new
// position after fade-in completes" artifact. Without this flag,
// re-scoring was deferred until alpha settled above 0.98, by which
// time the labels were fully drawn at the (potentially stale) cached
// side and any reposition was visibly abrupt.
let _needsLabelRescore = false;
// True while the map is panning/zooming. Labels stay VISIBLE during motion
// (tracking their pills at their cached anchors) instead of fading out; the
// scoring / reprioritisation pass is deferred to settle (_needsLabelRescore).
// Safer than the old fade-to-0: if this ever got stuck true, labels just stay
// put rather than disappearing.
let _mapMoving = false;
// The zoom-jog drives zoom via map.setZoom() in a RAF loop, which fires
// move/zoom start+end EVERY frame. That would clear _mapMoving and re-score
// labels each frame mid-jog (churn). The jog sets _zoomJogActive so the
// per-frame moveend handler ignores it; the jog clears the gate on release.
let _zoomJogActive = false;
if (typeof window !== 'undefined') {
  window._setZoomJogActive = (on) => {
    _zoomJogActive = !!on;
    _mapMoving = !!on;
    if (!on) _needsLabelRescore = true; // reprioritise once when the jog stops
    _animDirty = true;
    _scheduleAnim();
  };
}

function _stepLerp(s, key, target, rate) {
  const cur = s[key];
  const d   = target - cur;
  if (Math.abs(d) < 0.005) { s[key] = target; return false; }
  s[key] = cur + d * rate;
  return true;
}

// Animations (pin alpha lerps, morph, label motion) drive the next draw
// through Mapbox's repaint cycle so the canvas overlay commits in the
// SAME browser tick as Mapbox's tiles. A standalone requestAnimationFrame
// (the previous approach) ran in a separate slot and could miss the
// frame Mapbox was preparing — causing pins to visibly trail tiles by
// ~16ms during pan ("wiggle" lag). triggerRepaint puts us inside
// Mapbox's frame loop instead.
function _scheduleAnim() {
  if (!_animDirty) return;
  _animDirty = false;
  _drawDirty = true;
  if (typeof map !== 'undefined' && map && typeof map.triggerRepaint === 'function') {
    map.triggerRepaint();
  }
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
  // Motion gate: keep labels ON SCREEN during motion (cached anchors, tracking
  // their pills) and re-score ONCE on settle. _mapMoving switches the draw loop
  // to the cached-side path; _needsLabelRescore arms the single reprioritise
  // pass when motion stops. Pan uses move/moveend so it also covers
  // programmatic camera moves (flyTo, easeTo).
  const _onMoveStart = () => { _mapMoving = true; _animDirty = true; _scheduleAnim(); };
  const _onMoveEnd   = () => {
    // During a zoom-jog, setZoom() fires moveend every frame — ignore it; the
    // jog clears the gate explicitly on release (window._setZoomJogActive).
    if (_zoomJogActive) return;
    _mapMoving = false;
    _needsLabelRescore = true;
    _animDirty = true;
    _scheduleAnim();
  };
  map.on('zoomstart', () => { _zoomCache.active = true; _onMoveStart(); });
  map.on('zoomend',   () => {
    _zoomCache.active    = false;
    _zoomCache.frozenIds = null;
    _onMoveEnd();
  });
  map.on('movestart', _onMoveStart);
  map.on('moveend',   _onMoveEnd);
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
// "Unsure" — amber dot with a "?" glyph; same priority short-circuit as
// reviewed/archived so it doesn't compete for pill space. Stops the
// stoplight: green = done, amber = needs second look, red = removed.
function _drawAuditUnsurePin(pt) {
  const fill = (TOKENS && TOKENS.weatherPartly) || '#D5B068';
  const ring = (TOKENS && TOKENS.surfaceDeep)   || '#0F1B2A';
  ctx.save();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, _AUDIT_DOT_RING_R, 0, Math.PI * 2);
  ctx.fillStyle = ring; ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, _AUDIT_DOT_FILL_R, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  // "?" glyph in slate-on-amber. 8px Inter weight 700 reads cleanly at the
  // 11px dot footprint without anti-alias fuzz.
  ctx.fillStyle = ring;
  ctx.font = '700 8px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', pt.x, pt.y + 0.6);
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
});

// Boot-time gate around draw(). The first paint over all visible venues
// runs classifyPin → computeSunWindows for each pin. If the worker has
// not yet delivered precise sun windows (the fast geometry.json path
// dispatches but the result is async), that cascades into ~22M shadow
// checks on the main thread (osm.js comment ref). On mid-tier mobile
// this lands as a 200-500ms freeze during the splash-fade and camera
// dive. The gate suppresses draw() until app.js calls
// _releaseBootDrawGate() — which intro paths do AFTER the worker has
// delivered (so the deferred draw uses the cached precise windows).
// Safety net: auto-release after 8s in case no release path fires
// (e.g. dev reload with workers disabled).
let _bootDrawGateOpen = false;
let _bootDrawDeferred = false;
function _releaseBootDrawGate() {
  if (_bootDrawGateOpen) return;
  _bootDrawGateOpen = true;
  if (_bootDrawDeferred) {
    _bootDrawDeferred = false;
    draw();
  }
}
if (typeof window !== 'undefined') {
  window._releaseBootDrawGate = _releaseBootDrawGate;
  // Kick the pin animation loop from outside render-pins (e.g. ui-plan-preview
  // adds the receiver to the invite card on confirm). Goes through the anim
  // scheduler so _drawDirty is set and the 'render' handler actually draws.
  window._kickPinAnim = () => { _animDirty = true; _scheduleAnim(); };
  // Boot orchestrators (app.js _skipIntro etc.) check this to know whether
  // they're on the initial-load path (gate closed → wait for worker) vs a
  // mid-session call (gate open → hide splash instantly).
  window._isBootDrawGateOpen = () => _bootDrawGateOpen;
}
// 12s safety net — outer backstop in case neither the intro nor the
// skip-intro nor the plan-preview path releases the gate. Has to sit
// AFTER the longest in-flight wait the boot orchestrator can use (the
// intro's 8s worker wait), or the gate could release before the intro
// finishes its own choreography on slow phones.
setTimeout(() => {
  if (!_bootDrawGateOpen) {
    console.warn('[boot] draw gate auto-released by safety timeout');
    _releaseBootDrawGate();
  }
}, 12000);

// Sync the canvas overlay to Mapbox's frame loop. v1 used a standalone
// requestAnimationFrame coalesce; that decoupled the canvas draw from
// Mapbox's tile commit and produced ~16ms of pin-lag-behind-tiles during
// fast pans. Hooking 'render' instead puts the draw() inside Mapbox's
// own frame cycle — canvas + tiles commit together, no visible drift.
// _drawDirty is set by move/zoom events (and by _scheduleAnim for
// non-map animations); the 'render' handler consumes the flag.
function _markDrawDirty() { _drawDirty = true; }
map.on('move',     _markDrawDirty);
map.on('moveend',  _markDrawDirty);
map.on('zoomend',  _markDrawDirty);
map.on('render',   () => {
  if (!_drawDirty) return;
  _drawDirty = false;
  draw();
});

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

// ── Dot merge / explode pass ────────────────────────────────────────────────
// Greedy-merge the collected dots onto anchors (first dot in a neighbourhood
// wins; later dots within DOT_SPREAD_PX target that anchor). Every dot still
// renders, but its drawn position = own real pos pulled toward the anchor by a
// CONTINUOUS merge progress (a smooth function of the live separation: 1 at
// ≤ DOT_MERGE_PX, 0 at ≥ DOT_SPREAD_PX). Merged dots fade by separation, so a
// stacked group reads as ONE dot; zoom in and they glide+fade apart (explode).
// Newly-visible dots fade IN; dots that disappear fade OUT at their last spot.
function _drawOneDot(px, py, r, inSun, a) {
  const col = _dotMapColors(inSun ? 'hero' : 'context', false, false);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  // Cream rim — keeps the dot legible on the dark 3D buildings (light-on-dark);
  // on the cream map it blends away and the coloured core + edge carry it.
  // Cheap: one extra fill, no shadowBlur.
  ctx.beginPath(); ctx.arc(px, py, r + 1.2, 0, Math.PI * 2);
  ctx.fillStyle = _rgba(TOKENS.text || '#FFF4E0', 0.9); ctx.fill();
  // Coloured core (sun status) + its own edge ring (definition on the light map).
  ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
  ctx.fillStyle = col.fill; ctx.fill();
  ctx.beginPath(); ctx.arc(px, py, r - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = col.ring; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function _drawDots(placedPills, placedNamesGrid, zoom, presentVids) {
  const dots = _frameDots;
  const byVid = new Map();
  for (const d of dots) byVid.set(d.vid, d);
  const anchors = [];   // { vid, x, y }  (x,y = live real positions this frame)

  // Anchor assignment with COMMITTED-anchor hysteresis: a cluster's anchor is
  // sticky (carried in _dotAnchor), so new dots join the EXISTING anchor rather
  // than the merged dot jumping to whichever dot is greedily nearest each frame.
  const anchorPos = new Map();   // anchorVid → { x, y } live pos of an anchor dot
  const addAnchor = (d) => {
    d.anchorVid = d.vid; d.aDist = 0;
    anchorPos.set(d.vid, { x: d.x, y: d.y });
    anchors.push({ vid: d.vid, x: d.x, y: d.y });
  };
  // Pass A — former anchors keep anchoring (stable identity). Two former anchors
  // collapse into one only when now clearly overlapping (< DOT_MERGE_PX).
  for (const d of dots) {
    if (_dotAnchor.get(d.vid) !== d.vid) continue;     // was a member → Pass B
    let abs = null, bd = Infinity;
    for (const a of anchors) { const dd = Math.hypot(d.x - a.x, d.y - a.y); if (dd < DOT_MERGE_PX && dd < bd) { abs = a; bd = dd; } }
    if (abs) { d.anchorVid = abs.vid; d.aDist = bd; }
    else addAnchor(d);
  }
  // Pass B — former members + brand-new dots. Keep the committed anchor if it's
  // still present and in range (no churn); else nearest in range; else a new anchor.
  for (const d of dots) {
    if (d.anchorVid != null) continue;                 // already resolved in Pass A
    const prev = _dotAnchor.get(d.vid);
    if (prev != null && prev !== d.vid && anchorPos.has(prev)) {
      const a = anchorPos.get(prev);
      const dd = Math.hypot(d.x - a.x, d.y - a.y);
      if (dd < DOT_SPREAD_PX) { d.anchorVid = prev; d.aDist = dd; continue; }
    }
    let best = null, bd = Infinity;
    for (const a of anchors) { const dd = Math.hypot(d.x - a.x, d.y - a.y); if (dd < DOT_SPREAD_PX && dd < bd) { best = a; bd = dd; } }
    if (best) { d.anchorVid = best.vid; d.aDist = bd; }
    else addAnchor(d);
  }
  // Commit anchors for next frame; prune venues no longer present as dots.
  for (const d of dots) _dotAnchor.set(d.vid, d.anchorVid);
  { const present = new Set(dots.map((d) => d.vid)); for (const k of _dotAnchor.keys()) if (!present.has(k)) _dotAnchor.delete(k); }

  // Two sizes: a lone / exploded dot is one venue (SMALL); a dot that's still
  // hiding venues (a merged anchor) is the larger size (≈ today's dot). The
  // anchor grows/shrinks smoothly with how absorbed its members are.
  const R_SINGLE = zoom >= 16 ? 4.5 : 3.8;
  const R_MERGED = zoom >= 16 ? 6   : 5;
  const RAMP  = Math.max(1, DOT_SPREAD_PX - DOT_MERGE_PX);
  const CLEAR = R_MERGED + R_SINGLE;     // a member must clear the (large) anchor

  // 1) Position + per-member MERGE visibility (continuous from the LIVE
  //    separation → zero pan lag; the explode glides with the zoom).
  for (const d of dots) {
    d._merged = d.anchorVid !== d.vid;
    const prog = d._merged ? Math.max(0, Math.min(1, (DOT_SPREAD_PX - d.aDist) / RAMP)) : 0;
    const anchor = byVid.get(d.anchorVid);
    const ax = anchor ? anchor.x : d.x, ay = anchor ? anchor.y : d.y;
    d._px = d.x + (ax - d.x) * prog;
    d._py = d.y + (ay - d.y) * prog;
    // Shown only once it has CLEARED the anchor (centres past R_MERGED+R_SINGLE
    // = circles just touching) → two dots never show overlapping, and a merging
    // dot just stays absorbed (no standalone grow-in then stack).
    d._merge = d._merged ? Math.max(0, Math.min(1, (Math.hypot(d._px - ax, d._py - ay) - CLEAR) / (1.2 * R_SINGLE))) : 1;
  }

  // 2) Per-anchor "mergedness" — how absorbed its members still are (1 = fully
  //    stacked, 0 = all exploded). Drives the anchor's SIZE so a dot hiding
  //    venues reads larger and shrinks as the cluster explodes.
  const anchorMerged = new Map();
  for (const d of dots) {
    if (!d._merged) continue;
    anchorMerged.set(d.anchorVid, Math.max(anchorMerged.get(d.anchorVid) || 0, 1 - d._merge));
  }

  // 3) Draw — alpha = PRESENCE (vis) × FORM (d.alpha = 1−morph) × MERGE (d._merge).
  //    Three orthogonal factors, each owning one transition; they compose and
  //    never double-count, so pill↔dot, merge, and enter/leave move as one.
  for (const d of dots) {
    const dr = d._merged ? R_SINGLE
             : (R_SINGLE + (R_MERGED - R_SINGLE) * (anchorMerged.get(d.vid) || 0));
    // PRESENCE: shared per-venue envelope (kept ≈1 while the venue is a pill OR
    // dot — see the pill pass below — so a demote does NOT re-fade in; only a
    // genuinely-new dot fades up here).
    const prev = _markerVis.get(d.vid);
    let vis = prev ? prev.vis : 0;
    if (vis < 1) { vis = Math.min(1, vis + 0.12); _animDirty = true; }

    let a = vis * d.alpha * d._merge;     // PRESENCE × FORM × MERGE
    // A dot must never sit on a pill body OR a floating name label.
    const dotRect = { x: d._px - dr, y: d._py - dr, w: 2 * dr, h: 2 * dr };
    let overlaps = false;
    for (const pl of placedPills) { if (_overlaps(dotRect, pl, 2)) { overlaps = true; break; } }
    if (!overlaps && placedNamesGrid) {
      _forEachNearbyCell(placedNamesGrid, dotRect, (n) => { if (_overlaps(dotRect, n, 2)) overlaps = true; });
    }
    if (overlaps) a = 0;
    _markerVis.set(d.vid, { vis, lastA: a, px: d._px, py: d._py, inSun: d.inSun, wasDot: true, r: dr });
    if (a >= 0.03) _drawOneDot(d._px, d._py, dr, d.inSun, a);
  }

  // Present PILLS — keep their presence envelope warm so a later demote to a
  // dot inherits vis≈1 and cross-fades via the morph instead of re-fading in.
  // (Pills render via their own path + _pinState; vis here is just tracked.)
  if (presentVids) {
    for (const vid of presentVids) {
      if (byVid.has(vid)) continue;   // already handled as a dot above
      const prev = _markerVis.get(vid);
      const vis = Math.min(1, (prev ? prev.vis : 0) + 0.12);
      _markerVis.set(vid, { vis, lastA: 0,
        px: prev ? prev.px : 0, py: prev ? prev.py : 0,
        inSun: prev ? prev.inSun : false, wasDot: false });
    }
  }

  // Departing markers — fade OUT. Only DOTS draw here (pills fade via _pinState),
  // and a departing dot fades from its LAST rendered alpha, so a merged-invisible
  // dot (lastA≈0) simply drops without a flash.
  for (const [vid, m] of _markerVis) {
    if (presentVids && presentVids.has(vid)) continue;
    if (!m.wasDot) { _markerVis.delete(vid); continue; }
    m.lastA -= 0.12;
    if (m.lastA < 0.03) { _markerVis.delete(vid); continue; }
    _animDirty = true;
    _drawOneDot(m.px, m.py, m.r || 5, m.inSun, m.lastA);
  }
}

// ── Main draw ─────────────────────────────────────────────────────────────────
function draw() {
  // Boot gate — return without painting if the splash is still up. The
  // deferred-draw flag is set so _releaseBootDrawGate fires one paint at
  // the moment the splash starts dismissing.
  if (!_bootDrawGateOpen) { _bootDrawDeferred = true; return; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  _frameDots = [];      // dots collected this frame, merged/exploded after the loop
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
      let time = _pillTimeText(closedOpens, openHour, cls.tier, cls);
      const w = _pillWidth(ctx, time, friends.length);
      _drawPill(ctx, pt, w, time, cls.tier, {
        selected: false, hovered: false, closedNow: closedOpens,
        category: v.category, friends, scale: 1,
        favorited: (typeof isFavorite === 'function' && isFavorite(v.id)),
      });
    });
    ctx.globalAlpha = 1;
    drawBuildingEditor();
    ctx.restore();
    return;
  }

  // Cull bounds = the FULL canvas, from corner unprojection — NOT
  // map.getBounds(). getBounds() shrinks by the camera `padding`; a stale
  // bottom padding left by a prior camera move (opening a venue, the intro fit,
  // locate-me) parked the cull line at the old expanded-panel top, so venues
  // below it animated out and only reappeared after a padding-resetting move.
  // Corner unprojection is padding-independent, so pins render across the whole
  // canvas — including behind the translucent list panel.
  let _bW, _bE, _bS, _bN;
  try {
    const _cw = canvas.clientWidth, _ch = canvas.clientHeight;
    const _corners = [map.unproject([0, 0]), map.unproject([_cw, 0]),
                      map.unproject([_cw, _ch]), map.unproject([0, _ch])];
    _bW = Math.min(..._corners.map(c => c.lng));
    _bE = Math.max(..._corners.map(c => c.lng));
    _bS = Math.min(..._corners.map(c => c.lat));
    _bN = Math.max(..._corners.map(c => c.lat));
  } catch (e) {
    const _b = map.getBounds();
    _bW = _b.getWest(); _bE = _b.getEast(); _bS = _b.getSouth(); _bN = _b.getNorth();
  }
  const bounds = { contains: ([lng, lat]) => lng >= _bW && lng <= _bE && lat >= _bS && lat <= _bN };
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
    const sel = venueById(selectedId);
    if (sel) drawShadowOverlay(sel);
  }

  // Invite-flow avatar pin: while the accept page or post-accept confirm
  // is on screen, the only pin shown is the INVITER's avatar with a
  // honey time bubble. Replaces the standard pill pipeline so the moment
  // feels personal ('meeting [face]') rather than abstract. Bypasses the
  // forEach below entirely — no other pins, no density logic.
  const _inInviteFlow = typeof document !== 'undefined'
    && (document.body.classList.contains('plan-preview-active')
        || document.body.classList.contains('post-accept-active'));
  const _invitePin = (_inInviteFlow && typeof window !== 'undefined') ? window._invitePin : null;
  if (_invitePin) {
    const inviteV = venueById(_invitePin.venueId);
    if (inviteV) {
      // Target the probe-dot location (2 m in front of the terrace wall)
      // rather than the venue's lng/lat. The probe is the visible yellow/
      // blue 'sun status' dot drawn by drawShadowOverlay; the venue lng/
      // lat is the building centre, which puts the tip well above the
      // dot in the screenshot. Falls back to venue centre when no
      // wallSegment is available.
      let pt;
      if (inviteV.wallSegment) {
        const RAD = Math.PI / 180;
        const br = inviteV.wallSegment.bearing * RAD;
        const wy = inviteV.wallSegment.my;
        const wx = inviteV.wallSegment.mx;
        const tLat = wy + Math.cos(br) * 2 / 111320;
        const tLng = wx + Math.sin(br) * 2 / (111320 * Math.cos(wy * RAD));
        pt = map.project([tLng, tLat]);
      } else {
        pt = map.project([inviteV.lng, inviteV.lat]);
      }
      _drawInviteAvatarPin(ctx, pt, _invitePin);
    }
    ctx.restore();
    return;
  }

  // Friends-going pin on the venue detail page — same canvas card as the
  // invite-flow pin, but ADDS itself rather than replacing the rest of
  // the pin pipeline. Populated by _updateFriendsCanvasPin (app.js) when
  // the detail panel is open and at least one friend has accepted a
  // plan at this venue+date. Render is deferred until AFTER the main
  // pin loop so it stacks above other pins; see the bottom of draw().
  // (We just capture the flag here; the actual draw call sits below.)

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
    // Panel action-row filter pills — hide non-matching pins (non-audit).
    if (!isAuditMode && typeof window._passesActiveFilters === 'function'
        && !window._passesActiveFilters(v)) return;
    // Detail-panel focus mode (non-audit only).
    if (!isAuditMode && selectedId && v.id !== selectedId) return;
    // Inside audit mode, reviewed / archived / unsure venues short-circuit
    // to simple-dot rendering — they don't compete for pill space.
    if (isAuditMode) {
      if (v.auditArchived) {
        auditOverridePins.push({ v, pt: map.project([v.lng, v.lat]), kind: 'archived' });
        return;
      }
      if (typeof isVenueAudited === 'function' && isVenueAudited(v)) {
        auditOverridePins.push({ v, pt: map.project([v.lng, v.lat]), kind: 'reviewed' });
        return;
      }
      if (typeof isVenueUnsure === 'function' && isVenueUnsure(v)) {
        auditOverridePins.push({ v, pt: map.project([v.lng, v.lat]), kind: 'unsure' });
        return;
      }
    }
    const friends = _getCheckins(v);
    if (!isAuditMode
        && friends.length === 0
        && typeof shouldShowAtZoom === 'function'
        && !shouldShowAtZoom(v, zoom)) return;
    let cls;
    try { cls = classifyPin(v, dateStr, currentHour); }
    catch (e) {
      console.warn('[draw] classifyPin threw for', v && v.id, e);
      cls = { tier: 'context' };
    }
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
    if (_kmFromUser(e.v) < NEAR_USER_KM) s += _FREE_ZONE_BONUS;
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
      // Collect for the post-loop clustering pass — drawn there as a single
      // dot (overlap-suppressed against pills) or merged into a count bubble.
      // Context dots are never "in sun".
      _frameDots.push({ x: pt.x, y: pt.y, inSun: false, alpha: 1, vid: v.id });
      layout.push({
        v, pt, classResult: cls, isDot: true,
        spr: { anchorX: 0, anchorY: 0, cssW: r * 2, cssH: r * 2, pillW: 0, pillH: 0, pillR: 0 },
      });
      continue;
    }

    // Closed-but-opens: pill body fades to ~70%; right text shows OPENING
    // hour ("Åpner HH:mm"); secondary line below name shows sun start.
    const closedOpens = !!cls.closedOpeningIntoSun;
    const openHour    = closedOpens ? (v.openingHours && v.openingHours.open) : null;

    let time = _pillTimeText(closedOpens, openHour, tier, cls);
    if (!time && hasFriends && typeof computeSunWindows === 'function') {
      const noSun = (typeof t === 'function') ? t('map_pin_no_sun') : 'Ikke mer sol';
      try {
        const { windows } = computeSunWindows(v, dateStr);
        const next = windows.find(w => w.start > currentHour);
        time = next
          ? ((typeof t === 'function') ? t('map_pin_from', { time: _fmtTime(next.start) }) : 'fra ' + _fmtTime(next.start))
          : noSun;
      } catch { time = noSun; }
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
      const inFreeZone = _kmFromUser(v) < NEAR_USER_KM;
      // Hysteresis: a venue that was a pill last frame tolerates a SMALLER gap
      // before demoting; a fresh candidate needs a LARGER clear gap to promote.
      // The dead zone between stops pill↔dot flicker when pins are dense.
      const minGap = inFreeZone ? ABS_OVERLAP_PX
                   : (_lastPilledIds.has(v.id) ? PILL_DEMOTE_GAP : PILL_PROMOTE_GAP);
      for (const p of placedPills) {
        const dx = (pillRect.x + pillRect.w / 2) - (p.x + p.w / 2);
        const dy = (pillRect.y + pillRect.h / 2) - (p.y + p.h / 2);
        if (Math.hypot(dx, dy) < minGap) { demote = true; break; }
      }
    }
    if (demote) {
      // The demoted dot is collected for the clustering pass below (which
      // handles pill-overlap suppression for single dots). Pin still goes
      // into _lastLayout so hit testing works.
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
          favorited: !!snap.favorited,
        });
        ctx.restore();
      }

      // Collect the demoted dot for the clustering pass (drawn there once the
      // pill has mostly shrunk away). "In sun" = currently-sunny hero tier.
      if (dotAlpha > 0.04) {
        _frameDots.push({ x: pt.x, y: pt.y, inSun: (tier === 'hero' && !closedOpens), alpha: dotAlpha, vid: v.id });
      }
      layout.push({
        v, pt, classResult: cls, isDot: true,
        spr: { anchorX: 0, anchorY: 0, cssW: 8, cssH: 8, pillW: 0, pillH: 0, pillR: 0 },
      });
      continue;
    }

    placedPills.push(pillRect);
    _thisFramePilledIds.add(v.id);     // hysteresis input for next frame

    const sel       = v.id === selectedId;
    const hovered   = !sel && v.id === hoverId;
    const baseAlphaTarget = closedOpens ? 0.70 : 1.0;

    // Friend-presence pin: when the venue is selected (detail panel open)
    // AND has friend check-ins, swap the standard pill for the invite-style
    // avatar card so the pin reads the same visual language as the active-
    // invite floating card. On the map (no panel), keep the standard pill
    // with the friend module — less screen real estate, more glance-able.
    if (hasFriends && sel) {
      const friendCardData = {
        headerText: time || '',
        attendees: friends.map(f => ({
          id:        f.user?.id ?? f.id ?? null,
          name:      f.user?.name || f.user?.email || f.name || '?',
          offsetMin: 0,
        })),
        declined: [],
      };
      ctx.save();
      const stF = _ensureState(v.id);
      stF.target_alpha = baseAlphaTarget;
      stF.morphTarget  = 1;
      _stepLerp(stF, 'alpha', stF.target_alpha, 0.20);
      _stepLerp(stF, 'morph', stF.morphTarget, 0.12);
      ctx.globalAlpha = stF.alpha;
      _drawInviteAvatarPin(ctx, pt, friendCardData);
      ctx.restore();

      // Layout entry — bbox covers the card body + tip so hit-test picks
      // up clicks anywhere on the card.
      const _attendees = friendCardData.attendees;
      const _rows = Math.min(_attendees.length, INVITE_MAX_ROWS)
                  + (_attendees.length > INVITE_MAX_ROWS ? 1 : 0);
      const _headerH = friendCardData.headerText
        ? INVITE_CARD_HEADER_H + INVITE_CARD_HEADER_GAP : 0;
      const _cardH = INVITE_CARD_PAD_Y * 2 + _headerH + _rows * INVITE_CARD_ROW_H;
      // Card width is dynamic; clamp to a safe upper bound for hit-test.
      const _cardW = INVITE_CARD_MAX_W;
      layout.push({
        v, pt, classResult: cls, isDot: false,
        spr: {
          anchorX: _cardW / 2,
          anchorY: _cardH + INVITE_TIP_GAP + INVITE_TIP_H,
          cssW:    _cardW,
          cssH:    _cardH + INVITE_TIP_GAP + INVITE_TIP_H,
          pillW:   _cardW,
          pillH:   _cardH + INVITE_TIP_GAP + INVITE_TIP_H,
          pillR:   14,
        },
        _pillRect: pillRect,
        _closedOpens: closedOpens,
        _nextStart:   cls.nextStart,
        _friends:     friends,
      });
      continue;
    }

    // Animation state — drive both alpha and morph toward the pill state.
    const st = _ensureState(v.id);
    st.target_alpha = baseAlphaTarget;
    st.target_scale = sel ? 1.14 : (hovered ? 1.07 : 1.0);
    st.morphTarget  = 1;
    const _fav = (typeof isFavorite === 'function' && isFavorite(v.id));
    st.snapshot     = { tier, w, time, category: v.category, closedNow: closedOpens, friends, favorited: _fav };
    const aMoving = _stepLerp(st, 'alpha', st.target_alpha, 0.20);
    const sMoving = _stepLerp(st, 'scale', st.target_scale, 0.22);
    const mMoving = _stepLerp(st, 'morph', st.morphTarget, 0.12);
    if (aMoving || sMoving || mMoving) _animDirty = true;

    // When promoting from dot → pill, bleed off a residual dot
    // underneath so the swap reads as a smooth cross-fade rather
    // than a snap.
    const promoDotAlpha = 1 - st.morph;
    if (promoDotAlpha > 0.04) {
      const dot = _dotMapColors(tier, closedOpens, !!cls.hasSunLaterToday);
      ctx.save();
      ctx.globalAlpha = promoDotAlpha;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = dot.fill;
      ctx.fill();
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
      favorited: _fav,
    });
    ctx.restore();

    layout.push({
      v, pt, classResult: cls, isDot: false,
      spr: {
        anchorX: w / 2,
        anchorY: PILL_H + TAIL_H,
        cssW:    w,
        cssH:    PILL_H + TAIL_H,
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
      // Drop the label info too so a future re-promotion doesn't render
      // stale text on the first frame before _drawName rebuilds it.
      _lastLabelInfo.delete(id);
      continue;
    }
    const v = venueById(id);
    if (!v) { _pinState.delete(id); _lastLabelInfo.delete(id); continue; }
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
      favorited: !!st.snapshot.favorited,
    });
    ctx.restore();
    // Label fade-out: if this venue had a label on its last live frame,
    // redraw it here at the pill's current lerped alpha so the label
    // fades out at the same rate as the pill. Without this, the label
    // would vanish instantly while the pill keeps fading — exactly the
    // mismatch the user flagged.
    const labelInfo = _lastLabelInfo.get(id);
    if (labelInfo) {
      const pillRect = {
        x: pt.x - st.snapshot.w / 2,
        y: pt.y - PILL_H - TAIL_H,
        w: st.snapshot.w,
        h: PILL_H + TAIL_H,
      };
      // Use the cached side, skip scoring (consistent with motion path).
      // Multiplied by motion alpha so a pin demoting mid-pan also fades
      // its label with the rest.
      _drawName(
        ctx, pt, pillRect,
        labelInfo.name, labelInfo.secondary,
        null, null, null,
        {
          selected: false,
          force: true,
          alpha: st.alpha * _labelMotionAlpha,
          venueId: id,
          skipScoring: true,
        },
      );
    }
  }

  // ── 6. Floating names (with collision detection) ─────────────────────────
  // Secondary line priority (one line max, by importance):
  //   1. closed-but-opens  → "Sol fra HH:mm"  (the *reason* the pill is here)
  //   2. friends going     → "Anna +N planlegger"
  //   3. zoom ≥ 16         → "X t sol"        (informational)
  //
  // Motion fade: when the map is moving (pan/zoom), all labels fade out
  // collectively at the pin-alpha rate (0.20). When the map settles,
  // they fade back in. During motion the per-pin anchor scoring is
  // skipped — we reuse the cached side from _lastNameAnchor and just
  // track the pill position. That keeps the expensive _scoreAnchor
  // calls out of the hot path while still drawing labels that follow
  // their pins smoothly.
  {
    const d = _labelMotionTarget - _labelMotionAlpha;
    if (Math.abs(d) < 0.005) {
      _labelMotionAlpha = _labelMotionTarget;
    } else {
      // Asymmetric lerp: fade-out at 0.20/frame (~80 ms to mostly invisible),
      // fade-in at 0.08/frame (~250 ms to mostly full). The user reported
      // labels "only fading out, never fading in" — same 0.20 rate in both
      // directions made the fade-in snap back too fast to perceive as an
      // animation (especially when motion was brief and alpha didn't drop
      // far). Slower fade-in makes the return read as an actual reveal.
      const rate = d > 0 ? 0.08 : 0.20;
      _labelMotionAlpha += d * rate;
      _animDirty = true;
    }
  }
  // Spatial-hash placedPills (read by _scoreAnchor) and create the empty
  // names grid. Scoring runs:
  //   - ONCE at moveend/zoomend (via _needsLabelRescore) — labels are
  //     still fading in, so any side change is invisible
  //   - When labels are fully settled (alpha ~1, target=1) AND there's
  //     no pending rescore — keeps labels live to data changes that
  //     happen post-settle (e.g. time-slider drag updating tiers)
  // skipScoring is the fast cached-side path used during motion and
  // during fade-in BETWEEN the moveend rescore and full settle.
  const placedPillsGrid = new Map();
  const placedNamesGrid = new Map();
  // Score (and reprioritise) only when settled: every frame the map isn't
  // moving, plus the one-shot pass armed on settle. During motion we keep each
  // label at its cached anchor (skipScoring) so it tracks its pill and stays
  // visible — no collective fade-out. _labelMotionAlpha now stays at 1
  // (nothing drives it to 0), so labelAlpha follows the pill morph only.
  const _doScoring = _needsLabelRescore || !_mapMoving;
  if (_doScoring) for (const p of placedPills) _bucketRect(placedPillsGrid, p);
  // Skip the whole loop only when labels are fully invisible AND we're
  // not re-scoring on settle. Even at low motion alpha we still draw
  // (so the fade-out reads as continuous), unless alpha is below the
  // pin-fade-out threshold.
  if (_labelMotionAlpha > 0.04 || _labelMotionTarget === 1) for (const entry of layout) {
    if (entry.isDot) continue;
    if (entry.classResult.tier === 'context' && zoom < 16 && !(entry._friends && entry._friends.length)) continue;
    const v        = entry.v;
    const sel      = v.id === selectedId;
    // The detail panel already shows the venue name (huge header). The
    // floating label on top of the pin would just duplicate it and crash
    // into the friend-pin card body when it's drawn.
    if (sel) continue;
    const isFriend = entry._friends && entry._friends.length > 0;
    const going    = _getGoing(v, dateStr);

    // Second row is a zoom>=16 (street-level) detail only — keeps the city
    // view to name-only. All three variants share the one gate.
    let sec = '';
    if (zoom >= 16) {
      if (entry._closedOpens && entry._nextStart != null) {
        sec = (typeof t === 'function')
          ? t('map_pin_sun_from', { time: _fmtTime(entry._nextStart) })
          : 'Sol fra ' + _fmtTime(entry._nextStart);
      } else if (going.length > 0) {
        const firstName = (going[0].user && going[0].user.name || '?').split(' ')[0];
        const extra = going.length - 1;
        sec = (typeof t === 'function')
          ? (going.length === 1
              ? t('map_pin_planning_one', { name: firstName })
              : t('map_pin_planning_many', { name: firstName, n: extra }))
          : (going.length === 1 ? `${firstName} planlegger` : `${firstName} +${extra} planlegger`);
      } else {
        sec = _sunRemainingLine(v, dateStr, currentHour);
      }
    }

    // Label alpha follows the pill's morph — fades in only when the
    // pill is mostly visible (morph > 0.5), then full from ~0.8 onward.
    // Multiplied by the global motion alpha so pan/zoom dims everything.
    const stEntry = _pinState.get(v.id);
    const morphAlpha = stEntry
      ? Math.max(0, Math.min(1, (stEntry.morph - 0.5) / 0.3))
      : 1;
    const labelAlpha = morphAlpha * _labelMotionAlpha;
    // Skip the call when invisible AND we're not currently re-scoring
    // (the moveend one-shot). When _doScoring is true we run _drawName
    // even at alpha=0 so the scoring pass updates _lastNameAnchor /
    // _lastLabelInfo — that way the fade-in lands at the freshly chosen
    // side, no visible reposition.
    if (labelAlpha <= 0.02 && !_doScoring) continue;
    _drawName(
      ctx, entry.pt, entry._pillRect,
      shortName(v.name), sec,
      placedPillsGrid, placedNamesGrid, viewport,
      {
        selected: sel,
        force: sel || isFriend,
        alpha: labelAlpha,
        venueId: v.id,
        // During motion we use the cached side and skip the per-candidate
        // scoring entirely. _drawName branches on this and goes straight
        // to the cached anchor or falls back to 'right' for venues with
        // no prior anchor.
        skipScoring: !_doScoring,
      },
    );
  }
  // Consume the one-shot rescore flag — next frame uses skipScoring
  // again unless another moveend / zoomend re-arms it.
  if (_needsLabelRescore) _needsLabelRescore = false;

  // ── Audit override pins (reviewed + archived + unsure) ────────────────────
  // Drawn after pills/labels so they sit on top of overlapping pill bodies
  // when a pill lands close to an already-classified venue.
  if (isAuditMode && auditOverridePins.length) {
    for (const { v, pt, kind } of auditOverridePins) {
      if      (kind === 'reviewed') _drawAuditReviewedPin(pt);
      else if (kind === 'unsure')   _drawAuditUnsurePin(pt);
      else                          _drawAuditArchivedPin(pt);
      layout.push({
        v, pt, classResult: { tier: 'context' }, isDot: true,
        spr: { anchorX: 0, anchorY: 0, cssW: 14, cssH: 14, pillW: 0, pillH: 0, pillR: 0 },
      });
    }
  }

  // Merge / explode the dots collected during the loop (pills untouched).
  // Skipped in audit mode — audit pins are their own representation.
  // presentVids = every venue currently rendered (pill OR dot) — the shared
  // presence set that keeps a venue's vis warm across a pill↔dot transition.
  if (!isAuditMode) {
    const presentVids = new Set();
    for (const e of layout) if (e && e.v) presentVids.add(e.v.id);
    _drawDots(placedPills, placedNamesGrid, zoom, presentVids);
  }

  _lastLayout = layout;
  // Swap this frame's pilled-set into _lastPilledIds so the next
  // frame's priScore can apply the hysteresis bonus (keeps pins as
  // pills across zoom changes; reduces flicker).
  _lastPilledIds.clear();
  for (const id of _thisFramePilledIds) _lastPilledIds.add(id);
  _scheduleAnim();

  // Friends-going pin: drawn last so it stacks ABOVE other pins.
  // Active when the detail panel is open and _updateFriendsCanvasPin
  // (app.js) has populated window._friendsPin. Reuses the same canvas
  // card the invite-flow uses for visual consistency.
  const _friendsPin = (typeof window !== 'undefined') ? window._friendsPin : null;
  if (_friendsPin) {
    const fv = venueById(_friendsPin.venueId);
    if (fv) {
      let pt;
      if (fv.wallSegment) {
        const RAD = Math.PI / 180;
        const br = fv.wallSegment.bearing * RAD;
        const wy = fv.wallSegment.my;
        const wx = fv.wallSegment.mx;
        const tLat = wy + Math.cos(br) * 2 / 111320;
        const tLng = wx + Math.sin(br) * 2 / (111320 * Math.cos(wy * RAD));
        pt = map.project([tLng, tLat]);
      } else {
        pt = map.project([fv.lng, fv.lat]);
      }
      _drawInviteAvatarPin(ctx, pt, _friendsPin);
    }
  }

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
    const rh = spr.cssH + 8;
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
  const v = venueById(editingVenueId);
  if (!v || v.terraceType !== 'detached') return false;
  const loc = v.terraceDetachedLocation ?? { lat: v.lat, lng: v.lng };
  const pt  = map.project([loc.lng, loc.lat]);
  return Math.hypot(cx - pt.x, cy - pt.y) <= 18;
}

function hitTestDepthHandle(cx, cy) {
  if (!editingVenueId) return null;
  const v = venueById(editingVenueId);
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
  const v = venueById(editingVenueId);
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

const _UI_OVERLAY_SELECTOR = '#qc-wrap, #panel, #floating-search, #top-strip, #search-dropdown, #bell-dropdown, #ptb-cal-float, ' +
  '#profile-panel, #search-wrap, #floating-date, #detail-panel, .mapboxgl-ctrl, .mapboxgl-popup, ' +
  '#locate-btn, #notif-toast, #fts, ' +
  '.dprcv-overlay, .dpinvite-sheet, #post-accept-overlay, #post-accept-panel';

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
    const v = venueById(editingVenueId);

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
      const v = venueById(editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
      }
      return;
    }

    const vEdit = venueById(editingVenueId);

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
    const v = venueById(editingVenueId);
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
    const v = venueById(editingVenueId);
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
      const v = venueById(editingVenueId);
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
      const v = venueById(editingVenueId);
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
      const v = venueById(editingVenueId);

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
      e.stopPropagation();
      // map.stop() previously fired here for "parity" with the desktop
      // path, but it raced with Mapbox's own tap-handling on iOS and the
      // selectVenue → _flyToVenue easeTo never landed (zoom didn't
      // happen). Card-click goes straight to selectVenue without ever
      // touching the canvas; mirror that path here — let Mapbox finish
      // its tap state, then easeTo on the next frame so it isn't fighting
      // the touch handler.
      requestAnimationFrame(() => selectVenue(hit.id, true));
    }
  }, { passive: true });
}
