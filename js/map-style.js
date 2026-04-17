'use strict';

// ── Shades visual overrides for Mapbox Standard style ────────────────────────
// Called from style.load in app.js after the Standard style has loaded.
// Iterates the live layer list and overrides paint properties to match the
// Shades design system. Wrapped in try/catch per layer so a single bad call
// never breaks the rest.

function applyShadeStyle(map) {
  map.getStyle().layers.forEach(layer => {
    const { id, type } = layer;
    const sl = (layer['source-layer'] || '').toLowerCase();
    const lc = id.toLowerCase();

    try {

      // ── Land / background ───────────────────────────────────────────────
      if (type === 'background') {
        map.setPaintProperty(id, 'background-color', '#B8AFA3');
        return;
      }

      // ── Water ───────────────────────────────────────────────────────────
      if (type === 'fill' && (sl === 'water' || lc.includes('water'))) {
        map.setPaintProperty(id, 'fill-color',   '#9CBDE7');
        map.setPaintProperty(id, 'fill-opacity', 0.55);
        return;
      }
      if (type === 'line' && (sl === 'waterway' || lc.includes('waterway'))) {
        map.setPaintProperty(id, 'line-color',   '#9CBDE7');
        map.setPaintProperty(id, 'line-opacity', 0.45);
        return;
      }

      // ── Buildings ───────────────────────────────────────────────────────
      // Color only — opacity and AO are handled by existing app.js loop
      if (type === 'fill-extrusion') {
        map.setPaintProperty(id, 'fill-extrusion-color', '#F0E8DA');
        return;
      }

      // ── Landuse / green areas ───────────────────────────────────────────
      if (type === 'fill' && (sl === 'landuse' || lc.includes('landuse') || lc.includes('land-use'))) {
        const color =
          /park|wood|forest|nature/i.test(lc) ? '#9EA890' :
          /grass|meadow/i.test(lc)            ? '#A2A894' :
          /residential/i.test(lc)             ? '#BDB4A8' :
          /commercial|retail/i.test(lc)       ? '#B4ABA0' :
          /industrial/i.test(lc)              ? '#A8A09A' :
          /cemetery/i.test(lc)                ? '#A8AD9E' :
          /hospital/i.test(lc)                ? '#BDB4A8' :
          /school|education/i.test(lc)        ? '#B8B0A5' :
          /parking/i.test(lc)                 ? '#AEA69C' : null;
        if (color) map.setPaintProperty(id, 'fill-color', color);
        return;
      }

      // ── Roads ───────────────────────────────────────────────────────────
      if (type === 'line' && (sl === 'road' || lc.includes('road') || lc.includes('street'))) {
        const color =
          /motorway|trunk/i.test(lc)   ? '#7A726A' :
          /primary/i.test(lc)          ? '#82796E' :
          /secondary/i.test(lc)        ? '#8A8278' :
          /tertiary/i.test(lc)         ? '#928A80' :
          /pedestrian/i.test(lc)       ? '#C8BFB3' :
          /path|footway|step/i.test(lc)? '#C0B8AC' :
          /cycle/i.test(lc)            ? '#9A9490' :
          /rail/i.test(lc)             ? '#8A8278' : '#9A9288';
        map.setPaintProperty(id, 'line-color', color);
        return;
      }

      // ── Labels — hide road, POI, water, transit ─────────────────────────
      if (type === 'symbol') {
        if (/road.label|road-label|street.label|poi.label|poi-label|natural.label|natural-label|transit|waterway.label|water.label/i.test(sl) ||
            /road.label|road-label|poi.label|poi-label|transit.label|natural.label/i.test(lc)) {
          map.setLayoutProperty(id, 'visibility', 'none');
        }
        return;
      }

    } catch (_) { /* ignore per-layer errors */ }
  });
}
