/**
 * ui-shelter.js — Isometric wind-shelter diagram for the detail panel.
 * Depends on: venueWindShelter, windCardinal (weather.js)
 *
 * Coordinate conventions:
 *   - world: x = east (m), y = north (m), z = up (m)
 *   - The scene is rotated so v.facing maps to bearing 45° (NE) in the diagram,
 *     which makes the terrace face the bottom of the canvas (toward the viewer).
 *   - Isometric: sx = CX + (x-y)*scale,  sy = CY + (x+y)*scale*0.5 − z*scale
 *   - Wall visibility (CCW polygon): front face if (dy > dx) for edge A→B
 *
 * Wind particles:
 *   - Speed scales with wx.wspd (m/s)
 *   - Particles are deflected by the building polygon (world-space point-in-poly)
 *   - 300ms start delay so fast venue-scrolling doesn't waste resources
 *   - Cancel token stored on canvas._shelterRafId; cleared on each new call
 */

// ── Public entry point ───────────────────────────────────────────────────────

function drawShelterDiagram(v, wx, canvas) {
  // Cancel any running animation for this canvas
  if (canvas._shelterRafId) {
    cancelAnimationFrame(canvas._shelterRafId);
    canvas._shelterRafId = null;
  }
  if (canvas._shelterDelayId) {
    clearTimeout(canvas._shelterDelayId);
    canvas._shelterDelayId = null;
  }

  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');

  // ── Coordinate helpers ──────────────────────────────────────────────────────
  const cosLat = Math.cos(v.lat * Math.PI / 180);

  // Rotate so v.facing → bearing 0° (N = local y-axis = left face in iso), terrace wall diagonal
  const θ    = v.facing * Math.PI / 180;
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ);

  function toLocal(lat, lng) {
    const ex = (lng - v.lng) * cosLat * 111320;
    const ny = (lat - v.lat) * 111320;
    return { x: ex * cosθ - ny * sinθ, y: ex * sinθ + ny * cosθ };
  }

  let ISO_SCALE = 4;
  let CY = H * 0.52;
  const CX = W * 0.56; // shifted right: terrace extends left (local +y = iso left)

  function toIso(x, y, z) {
    return { sx: CX + (x - y) * ISO_SCALE, sy: CY + (x + y) * ISO_SCALE * 0.5 - z * ISO_SCALE };
  }

  // ── Collect geometry ────────────────────────────────────────────────────────
  const VENUE_H   = 22;   // exaggerated for visible 3D effect, helps shallow buildings
  const terrDepth = v.autoTerraceDepth ?? 6;

  let venueNodes = (v.buildingGeometry || []).map(n => toLocal(n.lat, n.lon));
  if (venueNodes.length < 3) {
    // Synthetic placeholder if OSM geometry is missing
    venueNodes = [
      { x: -7, y: -5 }, { x: 7, y: -5 }, { x: 7, y: 5 }, { x: -7, y: 5 }, { x: -7, y: -5 },
    ];
  }

  const nearbyBlds = (v.nearbyBuildings || [])
    .map(b => ({
      nodes:  (b.geometry || []).map(n => toLocal(n.lat, n.lon)),
      height: b.height ?? 12,
    }))
    .filter(b => {
      if (b.nodes.length < 3) return false;
      const cx = b.nodes.reduce((s, n) => s + n.x, 0) / b.nodes.length;
      const cy = b.nodes.reduce((s, n) => s + n.y, 0) / b.nodes.length;
      return Math.hypot(cx, cy) < 55;
    });

  // ── Auto-scale: derived from venue building only ────────────────────────────
  const venueHoriz = Math.max(1, ...venueNodes.map(n => Math.abs(n.x - n.y)));
  const venueGndY  = Math.max(1, ...venueNodes.map(n => n.x + n.y));
  const vertSpan   = Math.max(venueGndY + terrDepth, 1) * 0.5 + VENUE_H;

  ISO_SCALE = Math.min(
    (W * 0.42) / venueHoriz,
    (H * 0.60) / vertSpan,
    6.0
  );
  ISO_SCALE = Math.max(ISO_SCALE, 1.5);

  CY = Math.min(VENUE_H * ISO_SCALE + 18, H * 0.56);

  // ── Wind setup ──────────────────────────────────────────────────────────────
  const shelter    = wx ? venueWindShelter(v.facing, wx.wdir) : null;
  const rotWindDir = (wx?.wdir != null)
    ? ((wx.wdir - v.facing) + 360) % 360
    : null;

  // Building polygon (open, for collision) in world/local space
  const buildingPoly = venueNodes.slice(0, -1);

  // ── Draw static scene (no particles) ────────────────────────────────────────
  function _drawStatic() {
    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#090f1c';
    ctx.fillRect(0, 0, W, H);
    const bgG = ctx.createLinearGradient(0, 0, 0, H);
    bgG.addColorStop(0, 'rgba(5,15,40,0.5)');
    bgG.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bgG;
    ctx.fillRect(0, 0, W, H);

    // Ground grid
    ctx.save();
    ctx.strokeStyle = 'rgba(81,69,50,0.07)';
    ctx.lineWidth = 0.5;
    for (let i = -80; i <= 80; i += 10) {
      const a = toIso(i, -80, 0), b = toIso(i, 80, 0);
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      const c = toIso(-80, i, 0), d = toIso(80, i, 0);
      ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.stroke();
    }
    ctx.restore();

    // Wind wake cone
    if (rotWindDir != null && wx.wspd > 0.3) {
      const wakeRad = ((rotWindDir + 180) % 360) * Math.PI / 180;
      const wL = 55;
      const wEx = Math.sin(wakeRad) * wL, wNy = Math.cos(wakeRad) * wL;
      const s1  = toIso(wEx - Math.cos(wakeRad) * 22, wNy + Math.sin(wakeRad) * 22, 0.2);
      const tip = toIso(wEx, wNy, 0.2);
      const s2  = toIso(wEx + Math.cos(wakeRad) * 22, wNy - Math.sin(wakeRad) * 22, 0.2);
      const org = toIso(0, 0, 0.2);
      const len = Math.max(1, Math.hypot(tip.sx - org.sx, tip.sy - org.sy));

      const [r, g, b_] = shelter > 0.6 ? [100, 255, 180] : shelter > 0.3 ? [240, 180, 106] : [255, 110, 80];
      const wGrad = ctx.createRadialGradient(org.sx, org.sy, 0, org.sx, org.sy, len);
      wGrad.addColorStop(0, `rgba(${r},${g},${b_},0.22)`);
      wGrad.addColorStop(1, `rgba(${r},${g},${b_},0)`);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(org.sx, org.sy);
      ctx.lineTo(s1.sx, s1.sy);
      ctx.lineTo(tip.sx, tip.sy);
      ctx.lineTo(s2.sx, s2.sy);
      ctx.closePath();
      ctx.fillStyle = wGrad;
      ctx.fill();
      ctx.restore();
    }

    // ── Isometric block drawing ─────────────────────────────────────────────
    function polySignedArea(pts) {
      let a = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
      }
      return a / 2;
    }

    function drawIsoBlock(nodes, height, colors) {
      if (nodes.length < 3) return;
      const ccw = polySignedArea(nodes) > 0;

      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < nodes.length - 1; i++) {
          const a = nodes[i], b = nodes[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y;
          const front = ccw ? (dy > dx) : (dy < dx);
          if ((pass === 0) === front) continue;

          const p0 = toIso(a.x, a.y, 0),      p1 = toIso(b.x, b.y, 0);
          const p2 = toIso(b.x, b.y, height), p3 = toIso(a.x, a.y, height);
          ctx.beginPath();
          ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy); ctx.lineTo(p3.sx, p3.sy);
          ctx.closePath();
          ctx.fillStyle = front ? colors.wallFront : colors.wallBack;
          ctx.fill();
          ctx.strokeStyle = colors.edge; ctx.lineWidth = 0.5; ctx.stroke();
        }
      }

      // Roof
      ctx.beginPath();
      const r0 = toIso(nodes[0].x, nodes[0].y, height);
      ctx.moveTo(r0.sx, r0.sy);
      for (let i = 1; i < nodes.length - 1; i++) {
        const p = toIso(nodes[i].x, nodes[i].y, height);
        ctx.lineTo(p.sx, p.sy);
      }
      ctx.closePath();
      ctx.fillStyle = colors.roof;
      ctx.fill();
      ctx.strokeStyle = colors.edge; ctx.lineWidth = 0.7; ctx.stroke();
    }

    // Sort + draw buildings (painter's order)
    const allBlds = [
      ...nearbyBlds.map(b => ({ ...b, isVenue: false })),
      { nodes: venueNodes, height: VENUE_H, isVenue: true },
    ].filter(b => b.nodes.length >= 3);

    allBlds.sort((a, b_) => {
      const ca = a.nodes.reduce((s, n) => s + n.x + n.y, 0) / a.nodes.length;
      const cb = b_.nodes.reduce((s, n) => s + n.x + n.y, 0) / b_.nodes.length;
      return ca - cb;
    });

    // Warm ground glow under venue building
    if (venueNodes.length >= 3) {
      ctx.save();
      ctx.beginPath();
      const sn = venueNodes.slice(0, -1);
      const s0 = toIso(sn[0].x, sn[0].y, 0);
      ctx.moveTo(s0.sx, s0.sy);
      for (let i = 1; i < sn.length; i++) { const p = toIso(sn[i].x, sn[i].y, 0); ctx.lineTo(p.sx, p.sy); }
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,184,0,0.07)';
      ctx.fill();
      ctx.restore();
    }

    for (const bld of allBlds) {
      drawIsoBlock(bld.nodes, bld.height, bld.isVenue ? {
        wallBack:  'rgba(30,45,95,0.97)',
        wallFront: 'rgba(68,88,165,0.97)',
        roof:      'rgba(78,100,180,0.97)',
        edge:      'rgba(255,184,0,0.55)',
      } : {
        wallBack:  'rgba(20,28,52,0.92)',
        wallFront: 'rgba(32,42,72,0.92)',
        roof:      'rgba(38,50,82,0.92)',
        edge:      'rgba(81,69,50,0.25)',
      });
    }

    // Terrace zone
    if (v.wallSegment) {
      const ws = v.wallSegment;
      const a  = toLocal(ws.aLat, ws.aLng);
      const b  = toLocal(ws.bLat, ws.bLng);
      const pA0 = toIso(a.x, a.y,              0.1);
      const pB0 = toIso(b.x, b.y,              0.1);
      const pB1 = toIso(b.x, b.y + terrDepth, 0.1);
      const pA1 = toIso(a.x, a.y + terrDepth, 0.1);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pA0.sx, pA0.sy); ctx.lineTo(pB0.sx, pB0.sy);
      ctx.lineTo(pB1.sx, pB1.sy); ctx.lineTo(pA1.sx, pA1.sy);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,184,0,0.11)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,184,0,0.42)';
      ctx.lineWidth = 1; ctx.setLineDash([3, 2]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Venue name label
    ctx.save();
    ctx.font = '600 9px Inter,sans-serif';
    ctx.fillStyle = 'rgba(255,184,0,0.78)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const label = v.name.length > 20 ? v.name.slice(0, 18) + '…' : v.name;
    const namePt = toIso(0, 0, VENUE_H + 2.5);
    ctx.fillText(label, namePt.sx, namePt.sy);
    ctx.restore();

    // Terrace label
    if (v.wallSegment) {
      const ws = v.wallSegment;
      const a  = toLocal(ws.aLat, ws.aLng);
      const b  = toLocal(ws.bLat, ws.bLng);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 + terrDepth * 0.5;
      const tPt = toIso(mx, my, 0.5);
      ctx.save();
      ctx.font = '500 8px Inter,sans-serif';
      ctx.fillStyle = 'rgba(255,184,0,0.40)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('terrace', tPt.sx, tPt.sy);
      ctx.restore();
    }

    // North indicator
    {
      const northBearing = (360 - v.facing) % 360;
      const nRad = northBearing * Math.PI / 180;
      const nDist = Math.min(32, 28 / Math.max(ISO_SCALE, 1));
      const nPt = toIso(Math.sin(nRad) * nDist, Math.cos(nRad) * nDist, 0.5);
      ctx.save();
      ctx.font = '700 8px Inter,sans-serif';
      ctx.fillStyle = 'rgba(213,196,171,0.28)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('N', nPt.sx, nPt.sy);
      ctx.restore();
    }

    // Bottom bar
    if (wx && shelter != null) {
      ctx.save();
      ctx.textBaseline = 'bottom';
      const sLabel = shelter > 0.6 ? '🛡 Sheltered' : shelter > 0.3 ? '◑ Partial' : '💨 Exposed';
      const sColor = shelter > 0.6 ? '#64ffb4' : shelter > 0.3 ? '#f0b46a' : '#ff8a8a';
      ctx.font = '700 10px Inter,sans-serif';
      ctx.fillStyle = sColor;
      ctx.textAlign = 'left';
      ctx.fillText(sLabel, 8, H - 8);
      ctx.fillStyle = 'rgba(120,180,255,0.60)';
      ctx.textAlign = 'right';
      ctx.fillText(`${windCardinal(wx.wdir)} ${wx.wspd.toFixed(1)} m/s`, W - 8, H - 8);
      ctx.restore();
    } else if (!wx) {
      ctx.save();
      ctx.font = '500 9px Inter,sans-serif';
      ctx.fillStyle = 'rgba(213,196,171,0.25)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('No wind data', W / 2, H - 8);
      ctx.restore();
    }
  }

  // Draw static frame immediately
  _drawStatic();

  // No wind → nothing to animate
  if (rotWindDir == null || wx.wspd < 0.3) return;

  // ── Particle system ──────────────────────────────────────────────────────────
  // Wind comes FROM rotWindDir (local degrees). Particles flow in the opposite direction.
  const fromRad = rotWindDir * Math.PI / 180;
  // Unit vector: wind blows FROM (fromRad), so particles move in -fromRad direction
  const windDx = -Math.sin(fromRad); // world x component of particle motion
  const windDy = -Math.cos(fromRad); // world y component

  // Speed: 1 m/s wind ≈ 0.06 world-m per frame at 60fps; clamp to visible range
  const SPEED = Math.max(0.06, Math.min(wx.wspd * 0.055, 0.55));

  // Particle count scales with wind strength
  const NUM = Math.round(Math.min(38, 5 + wx.wspd * 2.8));

  // AABB of building polygon for quick pre-rejection
  const polyXs = buildingPoly.map(n => n.x);
  const polyYs = buildingPoly.map(n => n.y);
  const bMinX = Math.min(...polyXs) - 0.5, bMaxX = Math.max(...polyXs) + 0.5;
  const bMinY = Math.min(...polyYs) - 0.5, bMaxY = Math.max(...polyYs) + 0.5;

  function ptInBuilding(px, py) {
    // Fast AABB reject
    if (px < bMinX || px > bMaxX || py < bMinY || py > bMaxY) return false;
    // Winding-number point-in-polygon
    let inside = false;
    for (let i = 0, j = buildingPoly.length - 1; i < buildingPoly.length; j = i++) {
      const xi = buildingPoly[i].x, yi = buildingPoly[i].y;
      const xj = buildingPoly[j].x, yj = buildingPoly[j].y;
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Spawn zone: upwind from building, spread perpendicular to wind
  const SPAWN_DIST = 38; // world-m upwind of origin
  const SPREAD     = 28; // world-m perpendicular half-spread
  // Perpendicular unit vector to wind direction
  const perpX = -windDy, perpY = windDx;

  function spawnParticle(phase) {
    const spread = (Math.random() - 0.5) * 2 * SPREAD;
    const jitter = Math.random() * 5;
    return {
      // Start upwind, spread laterally
      x: -windDx * (SPAWN_DIST + jitter) + perpX * spread,
      y: -windDy * (SPAWN_DIST + jitter) + perpY * spread,
      // Velocity: main wind + small turbulent cross-component
      vx: windDx * SPEED * (0.75 + Math.random() * 0.5),
      vy: windDy * SPEED * (0.75 + Math.random() * 0.5),
      // Cross-turbulence (small, for organic feel)
      cx: (Math.random() - 0.5) * SPEED * 0.15,
      cy: (Math.random() - 0.5) * SPEED * 0.15,
      life: phase,                            // start at varied points in lifecycle
      maxLife: 90 + Math.random() * 60,
      deflected: false,
      deflectAge: 0,
    };
  }

  // Stagger initial phases so particles don't all appear at once
  const particles = Array.from({ length: NUM }, (_, i) =>
    spawnParticle(Math.floor((i / NUM) * 100))
  );

  function _tickParticle(p) {
    p.life++;

    // Gentle turbulence drift
    p.cx += (Math.random() - 0.5) * 0.004;
    p.cy += (Math.random() - 0.5) * 0.004;
    p.cx *= 0.97;
    p.cy *= 0.97;

    const nx = p.x + p.vx + p.cx;
    const ny = p.y + p.vy + p.cy;

    if (ptInBuilding(nx, ny)) {
      // Deflect: reflect velocity around building surface normal (simplified: reverse wind component)
      if (!p.deflected) {
        p.deflected  = true;
        p.deflectAge = 0;
        // Add a lateral nudge to simulate airflow around the corner
        const side = Math.random() < 0.5 ? 1 : -1;
        p.vx = perpX * SPEED * (0.6 + Math.random() * 0.6) * side;
        p.vy = perpY * SPEED * (0.6 + Math.random() * 0.6) * side;
      }
      // If still stuck after deflection, reset particle
      if (ptInBuilding(p.x + p.vx, p.y + p.vy)) {
        Object.assign(p, spawnParticle(0));
        return;
      }
    } else {
      // In the wind-shadow (lee) behind building, slow and add turbulence
      const behindDist = -(p.x * windDx + p.y * windDy); // positive = downwind of origin
      if (behindDist > 0 && behindDist < 18 && p.deflected) {
        p.deflectAge++;
        // Gradually reattach to main flow
        p.vx += (windDx * SPEED - p.vx) * 0.04;
        p.vy += (windDy * SPEED - p.vy) * 0.04;
        p.cx += (Math.random() - 0.5) * 0.018;
        p.cy += (Math.random() - 0.5) * 0.018;
      } else if (!p.deflected) {
        // Unobstructed flow: blend back toward nominal speed
        p.vx += (windDx * SPEED - p.vx) * 0.06;
        p.vy += (windDy * SPEED - p.vy) * 0.06;
      }
      p.x = p.x + p.vx + p.cx;
      p.y = p.y + p.vy + p.cy;
    }

    // Recycle when life exhausted or particle drifted far offscreen
    if (p.life >= p.maxLife || Math.hypot(p.x, p.y) > 70) {
      Object.assign(p, spawnParticle(0));
    }
  }

  function _drawParticles() {
    for (const p of particles) {
      const t  = p.life / p.maxLife;
      // Fade in and out at ends of lifecycle
      const a  = Math.min(t * 6, 1) * Math.min((1 - t) * 5, 1);
      if (a < 0.02) continue;

      const pt  = toIso(p.x, p.y, 1.5);
      const pt2 = toIso(p.x - p.vx * 3, p.y - p.vy * 3, 1.5); // trail tail

      ctx.save();
      ctx.globalAlpha = a * (p.deflected ? 0.45 : 0.65);
      ctx.strokeStyle = p.deflected ? 'rgba(160,210,255,0.9)' : 'rgba(120,180,255,0.9)';
      ctx.lineWidth = p.deflected ? 0.8 : 1.1;
      ctx.beginPath();
      ctx.moveTo(pt2.sx, pt2.sy);
      ctx.lineTo(pt.sx, pt.sy);
      ctx.stroke();

      // Head dot
      ctx.fillStyle = p.deflected ? 'rgba(180,220,255,0.8)' : 'rgba(150,200,255,0.8)';
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, 0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Animation loop — started after 300ms delay to avoid waste when user scrolls quickly
  function _startLoop() {
    // Capture the cancel token slot at start-time so a new call clears it cleanly
    const loopToken = { cancelled: false };
    canvas._shelterLoopToken = loopToken;

    function _frame() {
      if (loopToken.cancelled) return;

      // Redraw static scene
      _drawStatic();

      // Tick + draw particles
      for (const p of particles) _tickParticle(p);
      _drawParticles();

      canvas._shelterRafId = requestAnimationFrame(_frame);
    }

    canvas._shelterRafId = requestAnimationFrame(_frame);
  }

  canvas._shelterDelayId = setTimeout(() => {
    canvas._shelterDelayId = null;
    // Cancel previous token if still running
    if (canvas._shelterLoopToken) canvas._shelterLoopToken.cancelled = true;
    _startLoop();
  }, 300);
}
