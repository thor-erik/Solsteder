/**
 * render-pins.js — Map pins (sprites, layout, animation), main draw loop,
 *                  hit testing, and canvas event handling.
 * Depends on: map, canvas, ctx, currentSun, selectedId, hoveredId, hoverFromList, raisedId,
 *             editingVenueId, editHoveredWallIdx, VENUES (app.js / data.js)
 *             venueSunState (solar.js)
 *             computeSunWindows, sunScore, formatHour (app.js / scoring.js)
 *             shortName, fillRoundRect (render-helpers.js)
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
// Pill-shaped pins keyed by (id, state, selected, time-bucket).
// buildSprite returns { canvas, anchorX, anchorY } — anchor is the bottom of
// the stem, placed at the venue's map coordinate; the pill floats above it.
const PILL_H  = 26;   // pill body height px
const PILL_R  = 13;   // pill corner radius (= height/2 → fully rounded)
const STEM_H  = 14;   // thin vertical stem below pill
const spriteCache = new Map();

function buildSprite(v, state, selected, hour, dateStr) {
  // Closed: tiny faded dot — no pill
  if (state === 'closed') {
    const oc = document.createElement('canvas');
    oc.width = oc.height = 10;
    const c = oc.getContext('2d');
    c.globalAlpha = 0.22;
    c.beginPath(); c.arc(5, 5, 3, 0, Math.PI * 2);
    c.fillStyle = 'rgba(81,69,50,0.6)'; c.fill();
    return { canvas: oc, anchorX: 5, anchorY: 5 };
  }

  // ── Label + visual style per state ─────────────────────────────────────────
  let label = '', fillColor, strokeColor, textColor, stemColor, isDashed = false, alpha = 1;

  if (state === 'soon') {
    const { open } = v.openingHours ?? {};
    label       = open != null ? formatHour(open) : '—';
    fillColor   = 'rgba(8,14,25,0.88)';
    strokeColor = 'rgba(255,184,0,0.55)';
    stemColor   = 'rgba(255,184,0,0.70)';
    textColor   = 'rgba(255,200,80,0.95)';
    isDashed    = true;
    alpha       = 0.9;

  } else if (state === 'sunny') {
    const ss = (hour !== undefined && dateStr && typeof sunScore === 'function')
      ? Math.round(sunScore(v, dateStr, hour))
      : null;
    label       = ss != null ? `${shortName(v.name)} · ${ss}` : shortName(v.name);
    fillColor   = '#FFB800';
    strokeColor = 'rgba(255,230,120,0.4)';
    stemColor   = '#FFB800';
    textColor   = '#1a1200';

  } else { // shaded
    if (hour !== undefined && dateStr) {
      try {
        const { windows } = computeSunWindows(v, dateStr);
        const next = windows.find(w => w.start > hour);
        if (next) { label = formatHour(next.start); alpha = 0.85; }
        else       { label = '';  alpha = 0.32; }
      } catch (e) { label = ''; }
    }
    fillColor   = 'rgba(22,28,39,0.92)';
    strokeColor = 'rgba(81,69,50,0.28)';
    stemColor   = 'rgba(150,132,110,0.78)';
    textColor   = 'rgba(213,196,171,0.75)';
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────
  const tmpCtx = document.createElement('canvas').getContext('2d');
  tmpCtx.font  = 'bold 11px "Inter", sans-serif';
  const tw     = label ? tmpCtx.measureText(label).width : 0;
  const pillW  = Math.max(36, tw + 22);

  const rp  = selected ? 4 : 2;              // padding for selection ring
  const cW  = Math.ceil(pillW + rp * 2 + 2);
  const cH  = Math.ceil(PILL_H + STEM_H + rp + 2);
  const cxA = cW / 2;                        // anchor x = stem center
  const cyA = cH - 1;                        // anchor y = bottom of stem

  const oc = document.createElement('canvas');
  oc.width = cW; oc.height = cH;
  const c  = oc.getContext('2d');
  c.globalAlpha = alpha;

  const ox = rp + 1;   // pill left edge
  const oy = rp;       // pill top edge

  // ── Glow (sunny only) — pill-shaped halo behind the label ─────────────────
  if (state === 'sunny') {
    const gCx = cxA, gCy = oy + PILL_H / 2;
    // Use scale trick so the radial gradient follows the pill's aspect ratio
    const scaleX = (pillW * 0.72) / PILL_H;
    c.save();
    c.translate(gCx, gCy);
    c.scale(scaleX, 1);
    const glow = c.createRadialGradient(0, 0, 0, 0, 0, PILL_H);
    glow.addColorStop(0, 'rgba(255,184,0,0.18)');
    glow.addColorStop(1, 'rgba(255,184,0,0)');
    c.beginPath(); c.arc(0, 0, PILL_H, 0, Math.PI * 2);
    c.fillStyle = glow; c.fill();
    c.restore();
  }

  // ── Selection ring ─────────────────────────────────────────────────────────
  if (selected) {
    c.beginPath();
    c.roundRect(ox - 3, oy - 3, pillW + 6, PILL_H + 6, PILL_R + 3);
    c.strokeStyle = 'rgba(255,184,0,0.9)';
    c.lineWidth   = 2;
    c.stroke();
  }

  // ── Stem ───────────────────────────────────────────────────────────────────
  const stemX  = cxA;
  const stemY0 = oy + PILL_H;
  const stemY1 = cyA;
  c.beginPath();
  c.moveTo(stemX, stemY0);
  c.lineTo(stemX, stemY1);
  if (isDashed) c.setLineDash([3, 3]);
  c.strokeStyle = stemColor;
  c.lineWidth   = 2;
  c.stroke();
  c.setLineDash([]);
  // Anchor dot at stem tip (map point)
  c.beginPath(); c.arc(stemX, stemY1, 2, 0, Math.PI * 2);
  c.fillStyle = stemColor; c.fill();

  // ── Pill fill ──────────────────────────────────────────────────────────────
  c.beginPath();
  c.roundRect(ox, oy, pillW, PILL_H, PILL_R);
  c.fillStyle = fillColor;
  c.fill();

  // ── Pill stroke ────────────────────────────────────────────────────────────
  if (isDashed) c.setLineDash([4, 3]);
  c.strokeStyle = strokeColor;
  c.lineWidth   = 1;
  c.stroke();
  c.setLineDash([]);

  // ── Label ──────────────────────────────────────────────────────────────────
  if (label) {
    c.font         = 'bold 11px "Inter", sans-serif';
    c.fillStyle    = textColor;
    c.textAlign    = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, cxA, oy + PILL_H / 2);
  }

  return { canvas: oc, anchorX: cxA, anchorY: cyA };
}

function getSprite(v, state, selected, hour, dateStr) {
  if (spriteCache.size > 600) spriteCache.clear(); // prevent unbounded growth
  const tk  = (hour !== undefined) ? Math.round(hour * 4) : 0; // 15-min buckets
  const key = `${v.id}-${state}-${selected ? 1 : 0}-${tk}`;
  if (!spriteCache.has(key)) spriteCache.set(key, buildSprite(v, state, selected, hour, dateStr));
  return spriteCache.get(key);
}

function clearSpriteCache() { spriteCache.clear(); }

// ── Pin state transition animations ───────────────────────────────────────────
const _pinPrevState = new Map();   // id → last rendered state string
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
map.on('zoomend', draw);

// ── Pin layout: anti-overlap via variable stem, dot fallback ──────────────────
// Each pin tries increasing stem heights until it clears all higher-priority
// pills. If no stem works it degrades to a small dot. Sorting by relevance
// (sunny > soon > shaded, then by sun score) means important venues always
// keep their preferred position.
const MAX_STEM_H = 80;    // max extended stem before pin becomes a dot
const STEM_STEP  = 14;    // stem extension increment (px)
const DOT_R      = 4.5;   // dot radius (px)
const PILL_GAP   = 8;     // min gap between pill bounding boxes (px)
const DOT_FADE_MS = 240;  // pill↔dot morph duration

let _lastLayout = [];             // [{v, pt, state, stemH, isDot, spr, drawStemH}] per frame
let _hoverClearTimer = null;     // debounce timer for clearing hover state
const _pinWasDot    = new Map();  // id → bool — was this pin a dot last frame
const _pinDotFade   = new Map();  // id → {fromDot, start} — active morph animations
const _pinAnimStemH = new Map();  // id → animated stem height (px, float) for smooth transitions

/**
 * Assigns each venue a stem height (or isDot flag). Greedy by priority:
 * high-relevance venues get the preferred height, lower ones get bumped up
 * or collapsed to a dot when no stem height avoids overlap.
 */
function computePinLayout(projVenues, currentHour, dateStr) {
  const PRI = { sunny: 0, soon: 1, shaded: 2, closed: 3 };
  const sorted = [...projVenues].sort((a, b) => {
    // Raised pin (from sidebar) is processed last so it can claim the highest available position
    if (a.v.id === raisedId) return 1;
    if (b.v.id === raisedId) return -1;
    const pd = PRI[a.state] - PRI[b.state];
    if (pd !== 0) return pd;
    // Tie-break within same state: non-open venues by time until opening (sooner = higher priority);
    // open venues (sunny/shaded) by sun score (higher = higher priority)
    if (a.state === 'soon' || a.state === 'closed') {
      const openA = a.v.openingHours?.open ?? Infinity;
      const openB = b.v.openingHours?.open ?? Infinity;
      const waitA = openA > currentHour ? openA - currentHour : Infinity;
      const waitB = openB > currentHour ? openB - currentHour : Infinity;
      return waitA - waitB;  // less wait = lower value = sorts first
    }
    try {
      const sa = typeof sunScore === 'function' ? (sunScore(a.v, dateStr, currentHour) ?? 0) : (a.v.rating ?? 0);
      const sb = typeof sunScore === 'function' ? (sunScore(b.v, dateStr, currentHour) ?? 0) : (b.v.rating ?? 0);
      return sb - sa;
    } catch { return 0; }
  });

  const placed = [];   // committed pill rects {rx,ry,rw,rh}
  const result = [];

  for (const { v, pt, state } of sorted) {
    const selected = v.id === selectedId;
    const isHover  = v.id === raisedId;
    const spr = getSprite(v, state, selected, currentHour, dateStr);
    const rw  = spr.canvas.width;
    const rh  = spr.canvas.height - STEM_H;  // pill area (excludes baked stem)

    let resolved = false;
    // Raised pin (sidebar hover): search from tallest stem downward so it sits highest.
    // All other venues: search from shortest stem upward (normal greedy placement).
    const stemMin  = STEM_H;
    const stemMax  = MAX_STEM_H;
    const shouldLift = isHover;
    const stemDir  = shouldLift ? -STEM_STEP : STEM_STEP;
    const stemStart = shouldLift ? stemMax : stemMin;
    for (let stemH = stemStart; shouldLift ? stemH >= stemMin : stemH <= stemMax; stemH += stemDir) {
      const extraStem = stemH - STEM_H;
      const rx = pt.x - spr.anchorX;
      const ry = pt.y - spr.anchorY - extraStem;
      const clear = placed.every(p =>
        rx + rw + PILL_GAP <= p.rx || p.rx + p.rw + PILL_GAP <= rx ||
        ry + rh + PILL_GAP <= p.ry || p.ry + p.rh + PILL_GAP <= ry
      );
      if (clear) {
        placed.push({ rx, ry, rw, rh });
        result.push({ v, pt, state, stemH, isDot: false, spr });
        resolved = true;
        break;
      }
    }
    // Raised pin never degrades to dot; others do if no stem height works
    if (!resolved) result.push({ v, pt, state, stemH: STEM_H, isDot: !isHover, spr });
  }

  return result;
}

function _drawExtStem(pt, extraStem, state) {
  const col = state === 'sunny' ? '#FFB800' :
              state === 'soon'  ? 'rgba(255,184,0,0.70)' :
                                  'rgba(150,132,110,0.78)';
  ctx.beginPath();
  ctx.moveTo(pt.x, pt.y - extraStem);
  ctx.lineTo(pt.x, pt.y);
  if (state === 'soon') ctx.setLineDash([3, 3]);
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([]);
  // Anchor dot at map point
  ctx.beginPath(); ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
  ctx.fillStyle = col; ctx.fill();
}

function _drawDotHover(pt, state) {
  const isSunny = state === 'sunny', isSoon = state === 'soon';
  ctx.save();
  // Outer glow ring
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 6, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? 'rgba(255,184,0,0.22)' : isSoon ? 'rgba(255,184,0,0.16)' : 'rgba(120,150,220,0.18)';
  ctx.fill();
  // Enlarged dot
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 1.5, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? '#FFB800' : isSoon ? 'rgba(255,184,0,0.9)' : 'rgba(120,150,200,0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function _drawDot(pt, state) {
  const isSunny = state === 'sunny', isSoon = state === 'soon';
  ctx.save();
  ctx.globalAlpha = isSunny ? 0.9 : isSoon ? 0.7 : 0.4;
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R + 2.5, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? 'rgba(255,184,0,0.18)' : isSoon ? 'rgba(255,184,0,0.12)' : 'rgba(100,120,180,0.12)';
  ctx.fill();
  ctx.beginPath(); ctx.arc(pt.x, pt.y, DOT_R, 0, Math.PI * 2);
  ctx.fillStyle = isSunny ? '#FFB800' : isSoon ? 'rgba(255,184,0,0.8)' : 'rgba(100,120,170,0.65)';
  ctx.fill();
  ctx.restore();
}

// ── Map pan helper ────────────────────────────────────────────────────────────
/**
 * Pan so the venue pin appears centred in the visible area (accounting for
 * the detail sidebar on desktop).
 */
function panToVenueCenter(v) {
  const isMobile = window.innerWidth < 768;
  const panel    = document.getElementById('detail-panel');
  // Use layout position (unaffected by CSS transform during open animation)
  const padLeft  = (!isMobile && panel && panel.classList.contains('open'))
    ? (panel.offsetLeft + panel.offsetWidth) : 0;

  const targetBearing = (v.facing + 180) % 360;
  const curBearing    = ((map.getBearing() % 360) + 360) % 360;
  let   diff          = Math.abs(targetBearing - curBearing);
  if (diff > 180) diff = 360 - diff;

  const opts = {
    center:   [v.lng, v.lat],
    zoom:     Math.max(map.getZoom(), 15),
    pitch:    45,
    padding:  { left: padLeft, right: 0, top: 60, bottom: 0 },
    duration: 480,
  };
  if (diff > 90) opts.bearing = targetBearing;
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
      const { open, close } = v.openingHours;
      const isOpen = editHour >= open && editHour <= close;
      const state  = isOpen
        ? (venueSunState(v, currentSun.az, currentSun.alt) ? 'sunny' : 'shaded')
        : 'closed';
      const pt  = map.project([v.lng, v.lat]);
      const spr = getSprite(v, state, false, editHour, editDateStr);
      ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY);
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

  // Project + compute draw-state for all visible venues
  const projVenues = [];
  VENUES.forEach(v => {
    if (!bounds.contains([v.lng, v.lat])) return;
    if (!shouldShowAtZoom(v, zoom)) { hiddenCount++; return; }
    const { open, close } = v.openingHours;
    const isOpen        = currentHour >= open && currentHour <= close;
    const isOpeningSoon = !isOpen && (open - currentHour) > 0 && (open - currentHour) <= 0.75;
    let state;
    if (isOpen)             state = venueSunState(v, currentSun.az, currentSun.alt) ? 'sunny' : 'shaded';
    else if (isOpeningSoon) state = 'soon';
    else                    state = 'closed';
    projVenues.push({ v, state, pt: map.project([v.lng, v.lat]) });
  });

  // Compute anti-overlap layout before drawing (hover glow needs stemH too)
  _lastLayout = computePinLayout(projVenues, currentHour, dateStr);

  // Smooth stem height transitions — lerp each pin toward its target stemH
  let stemAnimDirty = false;
  for (const entry of _lastLayout) {
    if (entry.isDot) { _pinAnimStemH.delete(entry.v.id); entry.drawStemH = STEM_H; continue; }
    const target  = entry.stemH;
    const current = _pinAnimStemH.get(entry.v.id) ?? target;
    if (Math.abs(current - target) < 0.5) {
      _pinAnimStemH.set(entry.v.id, target);
      entry.drawStemH = target;
    } else {
      const next = current + (target - current) * 0.14;
      _pinAnimStemH.set(entry.v.id, next);
      entry.drawStemH = next;
      stemAnimDirty = true;
    }
  }
  if (stemAnimDirty) needsAnimFrame = true;

  // Draw pins from layout — two passes so pills always sit above all stems
  const visibleVenues = [];

  // Pre-scan: register dot↔pill transitions before any drawing
  for (const { v, isDot } of _lastLayout) {
    const wasDot = _pinWasDot.get(v.id);
    if (wasDot !== undefined && wasDot !== isDot) _pinDotFade.set(v.id, { fromDot: wasDot, start: now });
    _pinWasDot.set(v.id, isDot);
  }

  // Pass 1 — extended stems only (all stems drawn before any pill)
  for (const entry of _lastLayout) {
    const { v, pt, state, isDot } = entry;
    if (isDot || _pinDotFade.has(v.id)) continue;
    const extraStem = (entry.drawStemH ?? entry.stemH) - STEM_H;
    if (extraStem > 0) _drawExtStem(pt, extraStem, state);
  }

  // Pass 2 — morph animations, dots, pills (on top of all stems)
  for (const entry of _lastLayout) {
    const { v, pt, state, stemH, isDot, spr } = entry;
    const extraStem = (entry.drawStemH ?? stemH) - STEM_H;

    // Morph animation (handles its own ext stem so z-order is preserved within it)
    const morphFade = _pinDotFade.get(v.id);
    if (morphFade) {
      const t = Math.min(1, (now - morphFade.start) / DOT_FADE_MS);
      if (t >= 1) { _pinDotFade.delete(v.id); }
      else {
        needsAnimFrame = true;
        ctx.save();
        if (morphFade.fromDot) {
          ctx.globalAlpha = 1 - t; _drawDot(pt, state);
          ctx.globalAlpha = t;
          if (extraStem > 0) _drawExtStem(pt, extraStem, state);
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem);
        } else {
          ctx.globalAlpha = 1 - t;
          if (extraStem > 0) _drawExtStem(pt, extraStem, state);
          ctx.drawImage(spr.canvas, pt.x - spr.anchorX, pt.y - spr.anchorY - extraStem);
          ctx.globalAlpha = t; _drawDot(pt, state);
        }
        ctx.restore();
        continue;
      }
    }

    if (isDot) {
      if (state !== 'closed') {
        if (v.id === hoveredId) _drawDotHover(pt, state);
        else _drawDot(pt, state);
      }
      continue;
    }

    // State-change fade
    const prevState = _pinPrevState.get(v.id);
    if (prevState !== undefined && prevState !== state) _pinFadeStart.set(v.id, now);
    _pinPrevState.set(v.id, state);
    let pinAlpha = 1;
    const fs = _pinFadeStart.get(v.id);
    if (fs !== undefined) {
      const t = Math.min(1, (now - fs) / PIN_FADE_MS);
      pinAlpha = t;
      if (t >= 1) _pinFadeStart.delete(v.id);
      else needsAnimFrame = true;
    }

    const isHovered = v.id === hoveredId || v.id === raisedId;
    const rp = (v.id === selectedId ? 4 : 2) + 1;
    const sprLeft = pt.x - spr.anchorX;
    const sprTop  = pt.y - spr.anchorY - extraStem;

    ctx.save();
    if (pinAlpha < 1) ctx.globalAlpha = pinAlpha;

    // Hover/raised: glowing outline ring around the pill
    if (isHovered) {
      const pillW = spr.canvas.width - rp * 2 - 2;
      const glowCol = state === 'sunny' ? 'rgba(255,225,80,0.9)' :
                      state === 'soon'  ? 'rgba(255,205,70,0.8)' :
                                          'rgba(210,200,185,0.75)';
      ctx.save();
      ctx.shadowBlur = 9;
      ctx.shadowColor = glowCol;
      ctx.beginPath();
      ctx.roundRect(sprLeft + rp - 3.5, sprTop + rp - 3.5, pillW + 7, PILL_H + 7, PILL_R + 3.5);
      ctx.strokeStyle = glowCol;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }

    ctx.drawImage(spr.canvas, sprLeft, sprTop);
    ctx.restore();
    if (state !== 'closed') visibleVenues.push(entry);
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
  // Use layout for accurate pill bounds (variable stem heights)
  for (const entry of _lastLayout) {
    const { v, pt, isDot, spr, stemH } = entry;
    if (isDot) continue;
    const extraStem = (entry.drawStemH ?? stemH) - STEM_H;
    const rx = pt.x - spr.anchorX - 4;
    const ry = pt.y - spr.anchorY - extraStem - 4;
    const rw = spr.canvas.width + 8;
    const rh = spr.canvas.height - STEM_H + 8;
    if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) return v;
  }
  return null;
}

function hitTestDot(cx, cy) {
  for (const { v, pt, isDot, state } of _lastLayout) {
    if (!isDot || state === 'closed') continue;
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
canvas.style.pointerEvents = 'auto';

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
  if (editingVenueId) {
    // Detached pin drag
    if (hitTestDetachedPin(cx, cy)) {
      _detachedDragging = true;
      canvas.style.cursor = 'grabbing';
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
  if (!hit) {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new MouseEvent('mousedown', e));
  }
});

canvas.addEventListener('click', e => {
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
    selectVenue(hit.id, false);
    panToVenueCenter(hit);
    return;
  }
  // Clicked empty map — close detail panel / deselect
  if (selectedId !== null) {
    closeDetailPanel();
  }
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left, cy = e.clientY - rect.top;

  if (editingVenueId) {
    tooltip.classList.remove('visible');

    // Detached pin drag in progress
    if (_detachedDragging) {
      const ll = map.unproject([cx, cy]);
      setDetachedLocation(ll.lat, ll.lng);
      canvas.style.cursor = 'grabbing';
      return;
    }

    // Depth drag in progress
    if (editDraggingDepth && editDragWallObj) {
      const v = VENUES.find(x => x.id === editingVenueId);
      if (v) {
        const { normX, normY, mx, my } = wallOutwardNormal(v, editDragWallObj);
        const pixelDist = (cx - mx) * normX + (cy - my) * normY;
        v.terraceDepth = Math.max(1, Math.min(30, pixelDist / pxPerMetre(v)));
        draw();
        const walls = getTerraceWalls(v);
        const wallsLabel = walls.length > 1 ? ` · ${walls.length} walls` : '';
        document.getElementById('edit-facing-display').innerHTML =
          `${v.facing}° ${bearingToCardinal(v.facing)}${wallsLabel} · <span style="color:#64ffb4">${Math.round(getEffectiveDepth(v))}m depth</span>`;
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

    const handle = hitTestDepthHandle(cx, cy);
    if (handle) { canvas.style.cursor = 'row-resize'; return; }

    const wallIdx = hitTestWall(cx, cy);
    canvas.style.cursor = wallIdx !== null ? 'pointer' : 'default';
    if (wallIdx !== editHoveredWallIdx) {
      editHoveredWallIdx = wallIdx;
      draw();
      const v  = VENUES.find(x => x.id === editingVenueId);
      const el = document.getElementById('edit-facing-display');
      if (wallIdx !== null && v?.wallNormals) {
        const wall = v.wallNormals[wallIdx];
        const sel  = v.terraceWallIndices?.includes(wallIdx) ? ' ✓' : '';
        el.innerHTML = `<span class="preview">${Math.round(wall.bearing)}° ${bearingToCardinal(wall.bearing)}${sel}</span>`;
      } else if (v) {
        const walls = getTerraceWalls(v);
        const wallsLabel = walls.length > 1 ? ` · ${walls.length} walls` : '';
        el.innerHTML = `${v.facing}° ${bearingToCardinal(v.facing)}${wallsLabel}`;
      }
    }
    return;
  }

  const hit = hitTestVenue(cx, cy) || hitTestDot(cx, cy);
  if (hit) {
    // Cancel any pending clear — we're over a venue
    if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
    canvas.style.cursor = 'pointer';
    if (hoveredId !== hit.id || hoverFromList) { hoveredId = hit.id; hoverFromList = false; draw(); }
    tooltip.innerHTML = buildTooltipContent(hit);
    const margin = 14;
    let tx = e.clientX + margin, ty = e.clientY - tooltip.offsetHeight - margin;
    if (tx + tooltip.offsetWidth > window.innerWidth - 20) tx = e.clientX - tooltip.offsetWidth - margin;
    if (ty < 8) ty = e.clientY + margin;
    tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    tooltip.classList.add('visible');
  } else {
    // Debounce clearing so adjacent pins don't jitter when cursor moves between them
    if (hoveredId !== null && !_hoverClearTimer) {
      _hoverClearTimer = setTimeout(() => {
        _hoverClearTimer = null;
        hoveredId = null;
        draw();
        canvas.style.cursor = 'default';
        tooltip.classList.remove('visible');
      }, 80);
    } else if (hoveredId === null) {
      canvas.style.cursor = 'default';
      tooltip.classList.remove('visible');
    }
  }
});

canvas.addEventListener('mouseleave', () => {
  if (_hoverClearTimer) { clearTimeout(_hoverClearTimer); _hoverClearTimer = null; }
  // Only clear map-canvas hover; raisedId (from sidebar) stays raised
  if (hoveredId !== null && !hoverFromList) { hoveredId = null; draw(); }
  tooltip.classList.remove('visible');
  if (!editDraggingDepth) canvas.style.cursor = 'default';
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
    if (v) saveFacingCache(v.id, v.facing, v.facingSource, v.terraceWallIndices ?? [], v.terraceDepth);
    editDragWallObj = null;
    canvas.style.cursor = 'default';
  }
});

['wheel', 'touchstart', 'touchmove', 'touchend'].forEach(type => {
  canvas.addEventListener(type, e => {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX || e.touches?.[0]?.clientX, e.clientY || e.touches?.[0]?.clientY);
    canvas.style.pointerEvents = 'auto';
    if (el) el.dispatchEvent(new (e.constructor)(type, e));
  }, { passive: true });
});
