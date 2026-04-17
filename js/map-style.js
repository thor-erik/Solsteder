'use strict';

// ── Shades custom map style ───────────────────────────────────────────────────
// Full Mapbox GL JS style JSON — replaces mapbox://styles/mapbox/standard.
// Source: mapbox-streets-v8 vector tiles.
// Philosophy: buildings + shadows are primary. Visual hierarchy is strict:
//   buildings (lightest) → pedestrian areas → ground → roads → everything else.

// The app was written for Mapbox Standard which has a 'basemap' style import.
// Our custom style has no imports, so setConfigProperty('basemap', ...) would
// throw an uncaught error inside style.load and prevent the app from starting.
// Patch the prototype once so those calls silently become no-ops.
(function patchSetConfigProperty() {
  const _orig = mapboxgl.Map.prototype.setConfigProperty;
  mapboxgl.Map.prototype.setConfigProperty = function (importId, cfg, val) {
    try { return _orig.call(this, importId, cfg, val); } catch (_) { /* no-op for missing imports */ }
  };
}());

const MAP_STYLE = {
  version: 8,
  name: 'Shades',
  // No sprite — all symbol layers use text only, no icon-image references
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  sources: {
    streets: {
      type: 'vector',
      url:  'mapbox://mapbox.mapbox-streets-v8'
    }
  },
  layers: [

    // ── 1. Background (land) ─────────────────────────────────────────────────
    {
      id:   'background',
      type: 'background',
      paint: { 'background-color': '#B8AFA3' }
    },

    // ── 2. Water ─────────────────────────────────────────────────────────────
    {
      id:            'water',
      type:          'fill',
      source:        'streets',
      'source-layer': 'water',
      paint: {
        'fill-color':   '#9CBDE7',
        'fill-opacity': 0.55
      }
    },

    // ── 3. Landuse ───────────────────────────────────────────────────────────
    // Note: mapbox-streets-v8 has no 'landcover' source layer — all landcover
    // classes (wood, grass, scrub, etc.) are in the 'landuse' source layer.
    {
      id:            'landuse-residential',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'residential'],
      paint: { 'fill-color': '#BDB4A8' }
    },
    {
      id:            'landuse-commercial',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'commercial', 'retail'],
      paint: { 'fill-color': '#B4ABA0' }
    },
    {
      id:            'landuse-industrial',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'industrial'],
      paint: { 'fill-color': '#A8A09A' }
    },
    {
      id:            'landuse-cemetery',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'cemetery'],
      paint: { 'fill-color': '#A8AD9E' }
    },
    {
      id:            'landuse-hospital',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'hospital'],
      paint: { 'fill-color': '#BDB4A8' }
    },
    {
      id:            'landuse-school',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'school', 'education'],
      paint: { 'fill-color': '#B8B0A5' }
    },
    {
      id:            'landuse-military',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'military'],
      paint: { 'fill-color': '#A8A09A' }
    },
    {
      id:            'landuse-agriculture',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'farmland', 'agriculture', 'farm'],
      paint: { 'fill-color': '#B0AA9E' }
    },
    {
      id:            'landuse-park',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'park', 'national_park'],
      paint: { 'fill-color': '#9EA890' }
    },
    {
      id:            'landuse-wood',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'wood', 'forest'],
      paint: { 'fill-color': '#96A088' }
    },
    {
      id:            'landuse-grass',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'grass', 'meadow'],
      paint: { 'fill-color': '#A2A894' }
    },
    {
      id:            'landuse-pitch',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'pitch', 'golf_course'],
      paint: { 'fill-color': '#9AA090' }
    },
    {
      id:            'landuse-scrub',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'scrub', 'rock', 'sand'],
      paint: { 'fill-color': '#AEA79C' }
    },
    {
      id:            'landuse-parking',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'parking'],
      paint: { 'fill-color': '#AEA69C', 'fill-opacity': 0.7 }
    },
    {
      id:            'landuse-airport',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['==', 'class', 'airport'],
      paint: { 'fill-color': '#B0A89E', 'fill-opacity': 0.8 }
    },
    {
      id:            'landuse-allotment',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'allotment', 'allotments'],
      paint: { 'fill-color': '#9CA28E' }
    },
    {
      id:            'landuse-nature',
      type:          'fill',
      source:        'streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'nature_reserve', 'protected_area'],
      paint: { 'fill-color': '#98A08A' }
    },

    // ── 5. Aeroway ───────────────────────────────────────────────────────────
    {
      id:            'aeroway-fill',
      type:          'fill',
      source:        'streets',
      'source-layer': 'aeroway',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': '#9A9288', 'fill-opacity': 0.75 }
    },
    {
      id:            'aeroway-line',
      type:          'line',
      source:        'streets',
      'source-layer': 'aeroway',
      filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#9A9288', 'line-width': 1.5 }
    },

    // ── 6. Waterways ─────────────────────────────────────────────────────────
    {
      id:            'waterway',
      type:          'line',
      source:        'streets',
      'source-layer': 'waterway',
      paint: {
        'line-color':   '#9CBDE7',
        'line-opacity': 0.45,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, 0.5,
          14, 2,
          18, 5
        ]
      }
    },

    // ── 7. Pedestrian areas (fill polygons) ──────────────────────────────────
    // Pedestrian zones — slightly lighter than ground
    {
      id:            'road-pedestrian-area',
      type:          'fill',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['==', '$type', 'Polygon'], ['==', 'class', 'pedestrian']],
      paint: { 'fill-color': '#C8BFB3' }
    },
    // Town squares / plazas (pedestrian polygons with place=square in the data)
    // In Streets v8 these come through as pedestrian type; we warm them via a
    // separate layer keyed on the 'type' field where available.
    {
      id:            'road-plaza-area',
      type:          'fill',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['==', '$type', 'Polygon'], ['in', 'type', 'square', 'plaza']],
      paint: { 'fill-color': '#CCB8A8' }
    },

    // ── 8. Tunnel roads (drawn before normal roads, dashed) ──────────────────
    {
      id:            'tunnel-minor',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all',
        ['==', 'structure', 'tunnel'],
        ['in', 'class', 'street', 'street_limited', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'link']
      ],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color':       '#9A9288',
        'line-opacity':     0.4,
        'line-dasharray':   [2, 2],
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 4]
      }
    },

    // ── 9. Normal road casings ───────────────────────────────────────────────
    {
      id:            'road-motorway-trunk-casing',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['in', 'class', 'motorway', 'trunk']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#625A52',
        'line-opacity': 0.4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 16, 10]
      }
    },
    {
      id:            'road-primary-casing',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['==', 'class', 'primary']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#6A6258',
        'line-opacity': 0.4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3.5, 16, 6]
      }
    },
    {
      id:            'road-secondary-casing',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['==', 'class', 'secondary']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#726A62',
        'line-opacity': 0.4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 5]
      }
    },
    {
      id:            'road-tertiary-casing',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['==', 'class', 'tertiary']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#7A726A',
        'line-opacity': 0.4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2, 16, 4]
      }
    },
    {
      id:            'road-minor-casing',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['in', 'class', 'street', 'street_limited', 'link']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#8A8278',
        'line-opacity': 0.4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 18, 3.5]
      }
    },

    // ── 10. Normal road fills ────────────────────────────────────────────────
    {
      id:            'road-service',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['==', 'class', 'service']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#9A9288',
        'line-opacity': 0.3,
        'line-width':   0.8
      }
    },
    {
      id:            'road-minor',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['in', 'class', 'street', 'street_limited', 'link']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#9A9288',
        'line-opacity': 0.6,
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.8, 16, 1.5]
      }
    },
    {
      id:            'road-tertiary',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['==', 'class', 'tertiary']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#928A80',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 16, 2]
      }
    },
    {
      id:            'road-secondary',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['==', 'class', 'secondary']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#8A8278',
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 3]
      }
    },
    {
      id:            'road-primary',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['==', 'class', 'primary']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#82796E',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 4]
      }
    },
    {
      id:            'road-motorway-trunk',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'bridge', 'tunnel'], ['in', 'class', 'motorway', 'trunk']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#7A726A',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 6]
      }
    },

    // ── 11. Walking and cycling paths ─────────────────────────────────────────
    {
      id:            'road-pedestrian-line',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['==', '$type', 'LineString'], ['==', 'class', 'pedestrian']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#C8BFB3',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 18, 3]
      }
    },
    {
      id:            'road-path',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['==', '$type', 'LineString'], ['in', 'class', 'path', 'footway', 'track']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color':   '#C0B8AC',
        'line-opacity': 0.6,
        'line-width':   0.8
      }
    },
    {
      id:            'road-steps',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['==', 'class', 'steps'],
      layout: { 'line-cap': 'butt' },
      paint: {
        'line-color':       '#B8B0A4',
        'line-opacity':     0.5,
        'line-width':       1.2,
        'line-dasharray':   [1, 1]
      }
    },
    {
      id:            'road-cycleway',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['==', 'class', 'cycleway'],
      paint: {
        'line-color':   '#9A9490',
        'line-opacity': 0.35,
        'line-width':   0.8
      }
    },

    // ── 12. Railways ─────────────────────────────────────────────────────────
    {
      id:            'railway-major',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'tunnel'], ['==', 'class', 'major_rail']],
      paint: {
        'line-color':       '#8A8278',
        'line-opacity':     0.5,
        'line-width':       1,
        'line-dasharray':   [3, 2]
      }
    },
    {
      id:            'railway-minor',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['!in', 'structure', 'tunnel'], ['==', 'class', 'minor_rail']],
      paint: {
        'line-color':       '#928A80',
        'line-opacity':     0.4,
        'line-width':       0.8,
        'line-dasharray':   [4, 2]
      }
    },
    {
      id:            'railway-tunnel',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all', ['==', 'structure', 'tunnel'], ['in', 'class', 'major_rail', 'minor_rail']],
      paint: {
        'line-color':       '#9A9288',
        'line-opacity':     0.2,
        'line-width':       1,
        'line-dasharray':   [3, 3]
      }
    },

    // ── 13. Bridges ──────────────────────────────────────────────────────────
    // Casing drawn first (wider line behind), then fill on top
    {
      id:            'bridge-casing',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all',
        ['==', 'structure', 'bridge'],
        ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'street_limited']
      ],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color':   '#8A8278',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 7]
      }
    },
    {
      id:            'bridge-fill',
      type:          'line',
      source:        'streets',
      'source-layer': 'road',
      filter: ['all',
        ['==', 'structure', 'bridge'],
        ['in', 'class', 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'street', 'street_limited']
      ],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#C4BBB0',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1, 16, 5]
      }
    },

    // ── 14. Administrative boundaries ────────────────────────────────────────
    // County / region only — keep for orientation at city scale
    {
      id:            'admin-county',
      type:          'line',
      source:        'streets',
      'source-layer': 'admin',
      filter: ['all', ['==', 'admin_level', 4], ['==', 'maritime', 'false']],
      paint: {
        'line-color':       '#9A9288',
        'line-opacity':     0.3,
        'line-width':       0.5,
        'line-dasharray':   [3, 2]
      }
    },

    // ── 15. Building footprints (low zoom, before extrusions kick in) ─────────
    {
      id:            'building-footprint',
      type:          'fill',
      source:        'streets',
      'source-layer': 'building',
      maxzoom:       14,
      paint: {
        'fill-color':   '#F0E8DA',
        'fill-opacity': 0.7
      }
    },

    // ── 16. Building 3D extrusions ───────────────────────────────────────────
    // This is the primary visual element of the app. Keep height data intact.
    {
      id:            'building-extrusion',
      type:          'fill-extrusion',
      source:        'streets',
      'source-layer': 'building',
      filter: ['all', ['==', 'extrude', 'true'], ['>', 'height', 0]],
      minzoom: 13,
      paint: {
        'fill-extrusion-color': [
          'match', ['get', 'type'],
          // Residential
          ['residential', 'apartments', 'house', 'detached', 'terrace', 'semidetached_house'], '#F0E8DA',
          // Commercial / office
          ['commercial', 'retail', 'office', 'shop'],                                          '#EBE2D4',
          // Public / civic
          ['public', 'civic', 'government', 'town_hall', 'university', 'college'],             '#E8DFD0',
          // Religious
          ['church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple', 'religious'],    '#EDE5D7',
          // Industrial
          ['industrial', 'warehouse', 'factory', 'storage_tank'],                              '#DDD4C6',
          // Fallback
          '#F0E8DA'
        ],
        'fill-extrusion-height': [
          'interpolate', ['linear'], ['zoom'],
          15, 0,
          15.05, ['get', 'height']
        ],
        'fill-extrusion-base': [
          'interpolate', ['linear'], ['zoom'],
          15, 0,
          15.05, ['get', 'min_height']
        ],
        'fill-extrusion-opacity': 1.0
      }
    },

    // ── 17. Place labels (minimal — neighborhood + city for orientation) ──────
    {
      id:            'place-neighbourhood',
      type:          'symbol',
      source:        'streets',
      'source-layer': 'place_label',
      filter: ['==', 'type', 'neighbourhood'],
      minzoom: 13,
      maxzoom: 17,
      layout: {
        'text-field':          ['get', 'name'],
        'text-font':           ['DIN Pro Regular', 'Arial Unicode MS Regular'],
        'text-size':           10,
        'text-letter-spacing': 0.12,
        'text-transform':      'uppercase',
        'text-max-width':      8
      },
      paint: {
        'text-color':       '#8A8278',
        'text-opacity':     0.55,
        'text-halo-color':  '#B8AFA3',
        'text-halo-width':  1
      }
    },
    {
      id:            'place-suburb',
      type:          'symbol',
      source:        'streets',
      'source-layer': 'place_label',
      filter: ['in', 'type', 'suburb', 'quarter'],
      minzoom: 12,
      maxzoom: 16,
      layout: {
        'text-field':          ['get', 'name'],
        'text-font':           ['DIN Pro Regular', 'Arial Unicode MS Regular'],
        'text-size':           11,
        'text-letter-spacing': 0.1,
        'text-transform':      'uppercase',
        'text-max-width':      8
      },
      paint: {
        'text-color':       '#7A7268',
        'text-opacity':     0.5,
        'text-halo-color':  '#B8AFA3',
        'text-halo-width':  1.2
      }
    },
    {
      id:            'place-town',
      type:          'symbol',
      source:        'streets',
      'source-layer': 'place_label',
      filter: ['in', 'type', 'city', 'town'],
      minzoom: 9,
      maxzoom: 13,
      layout: {
        'text-field':     ['get', 'name'],
        'text-font':      ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 15],
        'text-max-width': 10
      },
      paint: {
        'text-color':       '#6A6258',
        'text-opacity':     0.65,
        'text-halo-color':  '#B8AFA3',
        'text-halo-width':  1.5
      }
    }

  ]
};
