/**
 * mercator.js — Web Mercator projection helpers for the satellite-snapshot
 * pipeline (scripts/detect-seating-areas.mjs).
 *
 * Mapbox Static Images API renders a centered tile at a given zoom level using
 * the spherical Mercator projection. To convert pixel coordinates inside the
 * returned image back to lat/lng we project the centre, offset by (px - W/2,
 * py - H/2), and unproject. Image @1x and @2x both share the same zoom-level
 * geometry — the @2x suffix only doubles raster resolution, so we always work
 * in @1x logical pixels.
 */

const TILE_SIZE = 256;

function worldSize(zoom) {
  return TILE_SIZE * Math.pow(2, zoom);
}

/** Lat/lng → world pixel at the given zoom (top-left origin). */
export function project(lng, lat, zoom) {
  const ws  = worldSize(zoom);
  const x   = (lng + 180) / 360 * ws;
  const sin = Math.sin(lat * Math.PI / 180);
  const y   = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * ws;
  return { x, y };
}

/** World pixel → lat/lng. Inverse of project(). */
export function unproject(x, y, zoom) {
  const ws  = worldSize(zoom);
  const lng = (x / ws) * 360 - 180;
  const n   = Math.PI - 2 * Math.PI * (y / ws);
  const lat = (180 / Math.PI) * Math.atan((Math.exp(n) - Math.exp(-n)) / 2);
  return { lat, lng };
}

/**
 * Convert image-pixel coords (top-left origin, @1x logical pixels) to lat/lng,
 * for a static image of width × height centred on (centerLng, centerLat) at
 * the given zoom level.
 */
export function imagePixelToLatLng(px, py, width, height, centerLng, centerLat, zoom) {
  const c = project(centerLng, centerLat, zoom);
  return unproject(c.x - width / 2 + px, c.y - height / 2 + py, zoom);
}

/** Inverse of imagePixelToLatLng — useful for overlaying known features on the snapshot. */
export function latLngToImagePixel(lng, lat, width, height, centerLng, centerLat, zoom) {
  const c = project(centerLng, centerLat, zoom);
  const p = project(lng, lat, zoom);
  return { x: p.x - c.x + width / 2, y: p.y - c.y + height / 2 };
}

/** Approximate ground resolution (m/px) for sanity checks. */
export function groundResolution(lat, zoom) {
  return Math.cos(lat * Math.PI / 180) * 2 * Math.PI * 6378137 / worldSize(zoom);
}
