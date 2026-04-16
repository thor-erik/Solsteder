/**
 * render-wind.js — Animated wind-particle overlay drawn on the Mapbox map.
 *
 * Particles live in geographic world-space (local metres east/north from the
 * selected venue's centre).  Each frame their positions are projected to screen
 * via map.project(), so they stay "grounded" on the 3D map plane and move
 * correctly as the camera pitches, bears, or zooms.
 *
 * Flow model
 * ──────────
 * Superposed potential-flow doublets (one cylinder per building) over a uniform
 * background wind field.  The doublet is the exact irrotational solution for
 * flow around a circular cylinder of radius R:
 *
 *   In wind-aligned frame (ξ along-wind, η cross-wind):
 *     Δu_ξ =  U·R²·(η²−ξ²) / (ξ²+η²)²
 *     Δu_η = −2·U·R²·ξ·η   / (ξ²+η²)²
 *
 * Stochastic wake turbulence is added per-particle in the lee of each building.
 * Buildings are from v.buildingGeometry (main) + v.nearbyBuildings (context),
 * all within 58 m of the venue centre.
 *
 * Depends on globals: map (Mapbox GL instance, app.js)
 * Public API: startWindOverlay(venue, wx)  /  stopWindOverlay()
 */

(function () {

// ── Module state ──────────────────────────────────────────────────────────────
let _raf       = null;
let _delayId   = null;
let _canvas    = null;
let _ctx       = null;
let _dpr       = 1;

let _venue     = null;
let _cosLat    = 1;
let _buildings = [];     // { cx, cy, R, poly[] }  in local metres (x=east, y=north)
let _windDx    = 0;      // unit vector: direction wind blows TO  (x=east)
let _windDy    = 0;      //                                        (y=north)
let _windSpd   = 0;      // visual speed, m/frame — pre-scaled from wx.wspd
let _particles = [];

// ── Canvas management ─────────────────────────────────────────────────────────

function _ensureCanvas() {
  if (_canvas) return;
  _canvas = document.createElement('canvas');
  // z-index 10: above Mapbox tiles, well below pin overlay (#canvas-overlay z-index 690)
  _canvas.style.cssText =
    'position:absolute;top:0;left:0;pointer-events:none;z-index:10;';
  document.getElementById('map-container').appendChild(_canvas);
  _ctx = _canvas.getContext('2d');
  _resize();
  window.addEventListener('resize', _resize);
}

function _resize() {
  if (!_canvas) return;
  _dpr = window.devicePixelRatio || 1;
  const mc = document.getElementById('map-container');
  const w = mc.offsetWidth  || window.innerWidth;
  const h = mc.offsetHeight || window.innerHeight;
  _canvas.width        = Math.round(w * _dpr);
  _canvas.height       = Math.round(h * _dpr);
  _canvas.style.width  = w + 'px';
  _canvas.style.height = h + 'px';
}

// ── Geographic helpers ────────────────────────────────────────────────────────

// Local metres (x=east, y=north from venue centre) → Mapbox screen pixel {x, y}.
// map.project() handles camera pitch/bearing/zoom so particles are grounded in the
// 3D map plane automatically.
function _toScreen(lx, ly) {
  const lng = _venue.lng + lx / (_cosLat * 111320);
  const lat = _venue.lat + ly / 111320;
  const pt  = map.project({ lng, lat });
  return { x: pt.x * _dpr, y: pt.y * _dpr };
}

function _geoToLocal(lat, lon) {
  return {
    x: (lon - _venue.lng) * _cosLat * 111320,
    y: (lat - _venue.lat) * 111320,
  };
}

// ── Building cylinders ────────────────────────────────────────────────────────

function _makeCylinder(geoNodes) {
  // Convert to local metres, drop closing-duplicate vertex if present
  let pts = geoNodes.map(n => _geoToLocal(n.lat, n.lon));
  if (pts.length > 1) {
    const last = pts[pts.length - 1];
    if (Math.hypot(pts[0].x - last.x, pts[0].y - last.y) < 0.5) pts = pts.slice(0, -1);
  }
  if (pts.length < 3) return null;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const R  = Math.max(3, Math.max(...pts.map(p => Math.hypot(p.x - cx, p.y - cy))));
  return { cx, cy, R, poly: pts };
}

// Point-in-convex/arbitrary polygon (Jordan curve theorem).
// AABB pre-rejection makes this cheap in the common case (particle far away).
function _ptInPoly(px, py, poly, cx, cy, R) {
  if (Math.hypot(px - cx, py - cy) > R * 1.15) return false; // fast reject
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function _insideAnyBuilding(px, py) {
  for (const b of _buildings) {
    if (_ptInPoly(px, py, b.poly, b.cx, b.cy, b.R)) return true;
  }
  return false;
}

// ── Potential-flow field ──────────────────────────────────────────────────────
//
// For each building cylinder (cx, cy, R) in a uniform flow (_windDx, _windDy)
// of speed _windSpd, the perturbation to the velocity at (px, py) is computed
// in the wind-aligned frame (ξ, η) and rotated back to world frame.
//
//   ξ =  (px-cx)·windDx + (py-cy)·windDy   (along-wind)
//   η = −(px-cx)·windDy + (py-cy)·windDx   (cross-wind)
//
//   Δu_ξ =  _windSpd·R²·(η²−ξ²) / (ξ²+η²)²
//   Δu_η = −2·_windSpd·R²·ξ·η   / (ξ²+η²)²
//
// World-frame inverse:   u_x = Δu_ξ·windDx − Δu_η·windDy
//                        u_y = Δu_ξ·windDy + Δu_η·windDx
//
function _flowAt(px, py) {
  let ux = _windDx * _windSpd;
  let uy = _windDy * _windSpd;

  for (const b of _buildings) {
    const dx = px - b.cx;
    const dy = py - b.cy;
    const r2 = dx * dx + dy * dy;
    if (r2 < b.R * b.R * 0.3) { return { ux: 0, uy: 0 }; } // deep inside — no valid field

    const xi  =  dx * _windDx + dy * _windDy;
    const eta = -dx * _windDy + dy * _windDx;
    const d2  = xi * xi + eta * eta;
    const c   = _windSpd * b.R * b.R / (d2 * d2);

    const dxi  = c * (eta * eta - xi * xi);
    const deta = c * (-2 * xi * eta);

    ux += dxi * _windDx - deta * _windDy;
    uy += dxi * _windDy + deta * _windDx;
  }
  return { ux, uy };
}

// ── Particle lifecycle ────────────────────────────────────────────────────────

const DOMAIN   = 62;   // simulation half-extent (metres from venue centre)
const SPAWN_D  = 55;   // upwind spawn distance (metres)
const SPREAD   = 45;   // lateral half-spread at spawn (metres)

// Perpendicular to wind direction (90° CCW)
function _px() { return -_windDy; }
function _py() { return  _windDx; }

function _spawn(phaseOffset) {
  const lat  = (Math.random() - 0.5) * 2 * SPREAD;
  const dist = SPAWN_D + Math.random() * 8;
  return {
    x:       -_windDx * dist + _px() * lat,
    y:       -_windDy * dist + _py() * lat,
    vx:      0,
    vy:      0,
    life:    phaseOffset,
    maxLife: 110 + Math.random() * 70,
  };
}

function _initParticles() {
  // Count scales with wind speed; stagger lifecycle phases so they don't all
  // appear simultaneously
  const N = Math.min(65, Math.round(14 + _windSpd * 60));
  _particles = Array.from({ length: N }, (_, i) =>
    _spawn(Math.floor((i / N) * 130))
  );
}

function _tick(p) {
  p.life++;

  // Sample potential-flow field
  const { ux, uy } = _flowAt(p.x, p.y);

  // Add stochastic turbulence in the wake of each building
  let tx = ux, ty = uy;
  for (const b of _buildings) {
    // ξ < 0 means particle is on the lee (downwind) side of this building
    const xi  = (p.x - b.cx) * _windDx + (p.y - b.cy) * _windDy;
    if (xi >= 0) continue;                                  // upwind — no wake
    const eta = -(p.x - b.cx) * _windDy + (p.y - b.cy) * _windDx;
    const wakeWidth = b.R * (1 + (-xi) * 0.10);
    if (Math.abs(eta) > wakeWidth) continue;                // outside wake cone

    // Exponential decay: strong near building face, fades downwind
    const decay = Math.exp(xi * 0.05);                      // xi<0 → decay ∈ (0,1]
    const amp   = _windSpd * decay * 0.40;
    tx += (Math.random() - 0.5) * amp * 2;
    ty += (Math.random() - 0.5) * amp * 2;
    // Also attenuate the mean flow (sheltered zone)
    tx *= 1 - 0.50 * decay;
    ty *= 1 - 0.50 * decay;
  }

  // Smooth integration: blend current velocity toward field (lag filter)
  p.vx = p.vx * 0.50 + tx * 0.50;
  p.vy = p.vy * 0.50 + ty * 0.50;

  const nx = p.x + p.vx;
  const ny = p.y + p.vy;

  if (_insideAnyBuilding(nx, ny)) {
    // Particle hit a building face — reset rather than pass through
    Object.assign(p, _spawn(0));
    return;
  }

  p.x = nx;
  p.y = ny;

  // Recycle when life ends or particle exits the domain
  if (p.life >= p.maxLife || Math.max(Math.abs(p.x), Math.abs(p.y)) > DOMAIN) {
    Object.assign(p, _spawn(0));
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _draw() {
  _ctx.clearRect(0, 0, _canvas.width, _canvas.height);

  for (const p of _particles) {
    const t = Math.min(p.life / p.maxLife, 1);
    // Fade in quickly, fade out gently near end of life
    const alpha = Math.min(t * 7, 1) * Math.min((1 - t) * 5, 1) * 0.90;
    if (alpha < 0.03) continue;

    // Head and tail positions in screen space
    const head = _toScreen(p.x, p.y);
    const tail = _toScreen(p.x - p.vx * 5, p.y - p.vy * 5);

    _ctx.save();
    _ctx.lineCap = 'round';

    // Glow pass — wider, softer halo so particles read against any map tile
    _ctx.globalAlpha = alpha * 0.35;
    _ctx.strokeStyle = 'rgba(200,235,255,1)';
    _ctx.lineWidth   = 5 * _dpr;
    _ctx.beginPath();
    _ctx.moveTo(tail.x, tail.y);
    _ctx.lineTo(head.x, head.y);
    _ctx.stroke();

    // Core stroke — bright white-blue, crisp
    _ctx.globalAlpha = alpha;
    _ctx.strokeStyle = 'rgba(220,242,255,1)';
    _ctx.lineWidth   = 1.8 * _dpr;
    _ctx.beginPath();
    _ctx.moveTo(tail.x, tail.y);
    _ctx.lineTo(head.x, head.y);
    _ctx.stroke();

    _ctx.restore();
  }
}

// ── Animation loop ────────────────────────────────────────────────────────────

function _frame() {
  if (!_venue || !_canvas) return;
  for (const p of _particles) _tick(p);
  _draw();
  _raf = requestAnimationFrame(_frame);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start (or restart) the wind overlay for the given venue and weather snapshot.
 * Safe to call repeatedly — cancels any running animation first.
 * No-ops silently when wind data is absent or calm (< 0.3 m/s).
 */
function startWindOverlay(venue, wx) {
  stopWindOverlay();
  if (!wx || wx.wdir == null || wx.wspd < 0.3) return;

  _venue  = venue;
  _cosLat = Math.cos(venue.lat * Math.PI / 180);

  // Wind-TO direction in local (x=east, y=north) frame.
  // wx.wdir is the meteorological FROM-direction (degrees true north, CW).
  // TO = FROM + 180°.  In (east, north) Cartesian: dx=sin(to), dy=cos(to).
  // Simplified: dx = −sin(wdir·π/180),  dy = −cos(wdir·π/180)
  const wRad = wx.wdir * Math.PI / 180;
  _windDx = -Math.sin(wRad);
  _windDy = -Math.cos(wRad);

  // Visual speed: exaggerated for legibility; scales with real wind strength
  _windSpd = Math.max(0.12, Math.min(wx.wspd * 0.09, 1.0));

  // Build cylinder list from main building + nearby buildings (within 58 m)
  _buildings = [];
  if ((venue.buildingGeometry?.length ?? 0) >= 3) {
    const c = _makeCylinder(venue.buildingGeometry);
    if (c) _buildings.push(c);
  }
  for (const nb of (venue.nearbyBuildings ?? [])) {
    if ((nb.geometry?.length ?? 0) >= 3) {
      const c = _makeCylinder(nb.geometry);
      // Only include buildings whose centroid is within 58 m of venue centre
      if (c && Math.hypot(c.cx, c.cy) < 58) _buildings.push(c);
    }
  }

  // 350 ms delay: avoids wasting work when quickly browsing the venue list
  _delayId = setTimeout(() => {
    _delayId = null;
    _ensureCanvas();
    _resize();
    _initParticles();
    _raf = requestAnimationFrame(_frame);
  }, 350);
}

/**
 * Stop the overlay and clear the canvas.  Called on panel close, venue
 * deselect, edit-mode entry, etc.
 */
function stopWindOverlay() {
  if (_raf)     { cancelAnimationFrame(_raf); _raf = null; }
  if (_delayId) { clearTimeout(_delayId);     _delayId = null; }
  if (_canvas && _ctx) _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  _particles = [];
  _venue     = null;
}

// Expose on window — matches the project's no-module pattern
window.startWindOverlay = startWindOverlay;
window.stopWindOverlay  = stopWindOverlay;

})();
