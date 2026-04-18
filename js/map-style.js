'use strict';

// ── Shades visual overrides for Mapbox Standard style ────────────────────────
// Called from style.load in app.js, after updateLightPreset(), so our
// overrides are applied last and not clobbered by config changes.
//
// KEY INSIGHT: map.getStyle().layers returns 0 for Standard style (layers
// live inside the basemap import fragment). map.getLayer(id) does reach
// imported layers. Every override is guarded with map.getLayer(id) so
// missing layers are skipped silently.
//
// DO NOT touch fill-extrusion-height / fill-extrusion-base — those drive
// the native building grow animation and must stay as-is.

function applyShadeStyle(map) {

  // ── 0. Discover accessible layer IDs ─────────────────────────────────────
  // map.getStyle().layers returns 0 for Standard style (import fragment).
  // Probe a comprehensive list of known Standard style IDs so the console
  // log tells us exactly what's reachable via map.getLayer().
  const _probe = [
    'background', 'land', 'land-1', 'land-2',
    'water', 'water-depth', 'water-shadow', 'water-line', 'waterway',
    'landuse', 'national-park', 'park', 'grass', 'scrub', 'farmland',
    'cemetery', 'pitch', 'wood', 'rock', 'sand', 'snow',
    'building', 'building-extrusion', '3d-buildings',
    'road-motorway-trunk', 'road-motorway', 'road-trunk',
    'road-primary', 'road-secondary', 'road-secondary-tertiary',
    'road-tertiary', 'road-minor', 'road-street', 'road-service',
    'road-pedestrian', 'road-pedestrian-polygon', 'road-path',
    'road-steps', 'road-cycleway', 'bridge-case', 'bridge',
    'rail', 'rail-label',
    'road-label', 'road-number-shield', 'road-exit-shield',
    'waterway-label', 'natural-line-label', 'natural-point-label',
    'water-line-label', 'water-point-label',
    'poi-label', 'transit-label', 'airport-label', 'park-label',
    'settlement-subdivision-label', 'settlement-label',
    'settlement-major-label', 'settlement-minor-label',
    'country-label', 'state-label',
    'pedestrian-polygon', 'pedestrian-area', 'plaza', 'square',
  ];
  const _found = _probe.filter(id => !!map.getLayer(id));
  console.log('[Shades] map.getStyle().layers count:', map.getStyle().layers.length);
  console.log('[Shades] accessible Standard layers:', _found.join(', '));

  // Helper — apply only when layer exists, swallow per-property errors
  function set(id, method, ...args) {
    if (!map.getLayer(id)) return;
    try { map[method](id, ...args); } catch (_) {}
  }

  // ── 1. Buildings ─────────────────────────────────────────────────────────
  // Find building extrusion layers (Standard may use different name).
  // Do NOT touch fill-extrusion-height or fill-extrusion-base.
  ['building', 'building-extrusion', '3d-buildings'].forEach(id => {
    set(id, 'setPaintProperty', 'fill-extrusion-color', '#F0E8DA');
    set(id, 'setPaintProperty', 'fill-extrusion-opacity', 1.0);
  });

  // ── 2. Water ─────────────────────────────────────────────────────────────
  ['water', 'water-depth', 'water-shadow', 'water-line'].forEach(id => {
    set(id, 'setPaintProperty', 'fill-color',   '#9CBDE7');
    set(id, 'setPaintProperty', 'fill-opacity', 0.55);
  });
  ['waterway'].forEach(id => {
    set(id, 'setPaintProperty', 'line-color',   '#9CBDE7');
    set(id, 'setPaintProperty', 'line-opacity', 0.45);
  });

  // ── 3. Land / background ─────────────────────────────────────────────────
  ['background', 'land', 'land-1', 'land-2'].forEach(id => {
    const layer = map.getLayer(id);
    if (!layer) return;
    try {
      if (layer.type === 'background') {
        map.setPaintProperty(id, 'background-color', '#B8AFA3');
      } else {
        map.setPaintProperty(id, 'fill-color', '#B8AFA3');
      }
    } catch (_) {}
  });

  // ── 4. Roads — colors only, no width changes ──────────────────────────────
  const _roads = {
    'road-motorway-trunk':       '#7A726A',
    'road-motorway':             '#7A726A',
    'road-trunk':                '#7A726A',
    'road-primary':              '#82796E',
    'road-secondary':            '#8A8278',
    'road-secondary-tertiary':   '#8A8278',
    'road-tertiary':             '#928A80',
    'road-minor':                '#9A9288',
    'road-street':               '#9A9288',
    'road-service':              '#9A9288',
    'road-pedestrian':           '#C8BFB3',
    'road-pedestrian-polygon':   '#C8BFB3',
    'road-path':                 '#C0B8AC',
    'road-steps':                '#B8B0A4',
    'road-cycleway':             '#9A9490',
  };
  Object.entries(_roads).forEach(([id, color]) => {
    set(id, 'setPaintProperty', 'line-color', color);
  });

  // ── 5. Parks and green areas ─────────────────────────────────────────────
  const _green = {
    'national-park':  '#98A08A',
    'park':           '#9EA890',
    'landuse':        '#9EA890',
    'wood':           '#96A088',
    'grass':          '#A2A894',
    'scrub':          '#AEA79C',
    'farmland':       '#B0AA9E',
    'cemetery':       '#A8AD9E',
    'pitch':          '#9AA090',
    'rock':           '#AEA79C',
    'sand':           '#AEA79C',
    'snow':           '#E8E4E0',
  };
  Object.entries(_green).forEach(([id, color]) => {
    set(id, 'setPaintProperty', 'fill-color', color);
  });

  // ── 6. Pedestrian areas and plazas ────────────────────────────────────────
  ['pedestrian-polygon', 'pedestrian-area', 'pedestrian'].forEach(id => {
    set(id, 'setPaintProperty', 'fill-color', '#C8BFB3');
  });
  ['plaza', 'square'].forEach(id => {
    set(id, 'setPaintProperty', 'fill-color', '#CCB8A8');
  });

  // ── 7. Labels — hide road, water, POI, transit, park ─────────────────────
  [
    'road-label', 'road-number-shield', 'road-exit-shield',
    'waterway-label', 'natural-line-label', 'natural-point-label',
    'water-line-label', 'water-point-label',
    'poi-label', 'transit-label', 'airport-label', 'park-label',
    'settlement-subdivision-label',
  ].forEach(id => {
    set(id, 'setLayoutProperty', 'visibility', 'none');
  });

  // ── 8. Place labels — keep but subdue ────────────────────────────────────
  ['settlement-label', 'settlement-major-label', 'settlement-minor-label',
   'country-label', 'state-label'].forEach(id => {
    set(id, 'setPaintProperty', 'text-color',       '#7A7268');
    set(id, 'setPaintProperty', 'text-opacity',     0.55);
    set(id, 'setPaintProperty', 'text-halo-width',  0);
  });

  // ── 9. POI icons — hide all (labels already hidden via setConfigProperty) ─
  // Fallback: any remaining symbol layer with an icon gets opacity 0
  map.getStyle().layers                    // returns user layers only, so likely 0
    .filter(l => l.type === 'symbol')
    .forEach(l => {
      if (map.getLayer(l.id)) {
        try { map.setLayoutProperty(l.id, 'icon-opacity', 0); } catch (_) {}
      }
    });

}
