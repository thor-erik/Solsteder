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
 */

function drawShelterDiagram(v, wx, canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

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
  // Nearby buildings use the same scale but never shrink it — they may
  // overflow the canvas edges, which looks fine and keeps the main building legible.
  const venueHoriz = Math.max(1, ...venueNodes.map(n => Math.abs(n.x - n.y)));
  const venueGndY  = Math.max(1, ...venueNodes.map(n => n.x + n.y));
  // vertSpan = ground depth + building height + terrace (extends in +y → 0.5 factor in iso)
  const vertSpan   = Math.max(venueGndY + terrDepth, 1) * 0.5 + VENUE_H;

  ISO_SCALE = Math.min(
    (W * 0.42) / venueHoriz,
    (H * 0.60) / vertSpan,
    6.0
  );
  ISO_SCALE = Math.max(ISO_SCALE, 1.5);

  // CY: place so the roof sits ~18px from the top with room for the terrace below
  CY = Math.min(VENUE_H * ISO_SCALE + 18, H * 0.56);

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.fillStyle = '#090f1c';
  ctx.fillRect(0, 0, W, H);
  const bgG = ctx.createLinearGradient(0, 0, 0, H);
  bgG.addColorStop(0, 'rgba(5,15,40,0.5)');
  bgG.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bgG;
  ctx.fillRect(0, 0, W, H);

  // ── Ground grid ─────────────────────────────────────────────────────────────
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

  // ── Wind + shelter setup ────────────────────────────────────────────────────
  const shelter     = wx ? venueWindShelter(v.facing, wx.wdir) : null;
  const rotWindDir  = (wx?.wdir != null)
    ? ((wx.wdir - v.facing) + 360) % 360
    : null;

  // ── Wind wake cone ──────────────────────────────────────────────────────────
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

  // ── Isometric block drawing ─────────────────────────────────────────────────
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

    // Two passes: back walls first, then front walls (painter's algo within block)
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = nodes[i], b = nodes[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y;
        // Front-face rule: CCW → visible if dy > dx; CW → visible if dy < dx
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

    // Roof polygon
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

  // ── Sort + draw all buildings ───────────────────────────────────────────────
  // Painter's order: smaller centroid (x+y) = further NW in iso = draw first
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
      wallBack:  'rgba(30,45,95,0.97)',    // deep blue shadow side
      wallFront: 'rgba(68,88,165,0.97)',   // brighter lit side
      roof:      'rgba(78,100,180,0.97)',  // brightest = roof
      edge:      'rgba(255,184,0,0.55)',   // strong amber outline
    } : {
      wallBack:  'rgba(20,28,52,0.92)',
      wallFront: 'rgba(32,42,72,0.92)',
      roof:      'rgba(38,50,82,0.92)',
      edge:      'rgba(81,69,50,0.25)',
    });
  }

  // ── Terrace zone ────────────────────────────────────────────────────────────
  // Facing direction → NE (0.707, 0.707) in local frame; terrace extends toward viewer
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

  // ── Wind arrows ─────────────────────────────────────────────────────────────
  if (rotWindDir != null && wx.wspd > 0.3) {
    const fromRad = rotWindDir * Math.PI / 180;
    for (const off of [-11, 11]) {
      const perpX = -Math.cos(fromRad) * off;
      const perpY =  Math.sin(fromRad) * off;
      const start = toIso(Math.sin(fromRad) * 42 + perpX, Math.cos(fromRad) * 42 + perpY, 1.5);
      const end   = toIso(Math.sin(fromRad) * 14 + perpX, Math.cos(fromRad) * 14 + perpY, 1.5);

      ctx.save();
      ctx.beginPath(); ctx.moveTo(start.sx, start.sy); ctx.lineTo(end.sx, end.sy);
      ctx.strokeStyle = 'rgba(120,180,255,0.50)';
      ctx.lineWidth = 1.2; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);

      const ang = Math.atan2(end.sy - start.sy, end.sx - start.sx);
      ctx.beginPath();
      ctx.moveTo(end.sx, end.sy);
      ctx.lineTo(end.sx - 7 * Math.cos(ang - 0.45), end.sy - 7 * Math.sin(ang - 0.45));
      ctx.lineTo(end.sx - 7 * Math.cos(ang + 0.45), end.sy - 7 * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fillStyle = 'rgba(120,180,255,0.60)';
      ctx.fill();
      ctx.restore();
    }
  }

  // ── Labels ──────────────────────────────────────────────────────────────────
  // Venue name above roof
  ctx.save();
  ctx.font = '600 9px Inter,sans-serif';
  ctx.fillStyle = 'rgba(255,184,0,0.78)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  const label = v.name.length > 20 ? v.name.slice(0, 18) + '…' : v.name;
  const namePt = toIso(0, 0, VENUE_H + 2.5);
  ctx.fillText(label, namePt.sx, namePt.sy);
  ctx.restore();

  // "terrace" label on the terrace zone
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

  // North indicator (where north is in the rotated diagram)
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

  // Bottom bar: shelter status + wind reading
  if (wx && shelter != null) {
    ctx.save();
    ctx.textBaseline = 'bottom';
    // Canvas text can't render SVG; the colour already encodes the state, so
    // drop the emoji and keep clean labels (was 🛡/◑/💨).
    const sLabel = shelter > 0.6 ? 'Sheltered' : shelter > 0.3 ? 'Partial' : 'Exposed';
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
