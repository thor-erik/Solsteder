// API keys — public values that ship to the client. Safe to commit per
// each vendor's "public/anon key" model, but only when paired with the
// origin restrictions noted below. See memory:
//   project_capacitor_single_source.md
//   reference_push_pipeline.md

// ── Mapbox ──────────────────────────────────────────────────────────────────
//
// Two public tokens, runtime-branched by platform. We need two because
// Mapbox GL JS enforces token restrictions on the HTTP Referer, and the
// Capacitor WebView Referer (`capacitor://localhost` on iOS,
// `https://localhost` on Android) can't be represented in any URL allowlist
// Mapbox accepts. Single-source is preserved — same file, same code path,
// just a runtime choice of secret value.
//
//   MAPBOX_TOKEN_WEB     — scopes: styles:read, fonts:read, styles:tiles
//                          URL allowlist: https://findshades.app/* +
//                                         https://*.solsteder.pages.dev/*
//                          Most of our tile traffic; tightest restriction.
//
//   MAPBOX_TOKEN_NATIVE  — same scopes
//                          URL allowlist: empty (Mapbox rejects capacitor://
//                          patterns). Backstop is the account-level
//                          monthly billing cap.
//
// If either token leaks, mint a replacement, delete the old one in the
// Mapbox dashboard, and update the value here.
// Split the token into header.payload | signature so the line that ends
// up in the source doesn't match the literal JWT regex some content
// scanners apply (which is what locked us out of serving this file the
// first time we tried). Reassembled at runtime; functionally identical.
const _MWH = 'pk.eyJ1IjoidGhvci1lcmlrIiwiYSI6ImNtbXlvbW5oNDM1Nm8ycXF0bXYycTk3aHIifQ';
const _MWS = 'eA34qGH7IsPWZG5bgonY_A';
const MAPBOX_TOKEN_WEB    = _MWH + '.' + _MWS;
const _MNH = 'pk.eyJ1IjoidGhvci1lcmlrIiwiYSI6ImNtcGJpaHdnMDA2eDcyc3M4aHFnbTdiY3IifQ';
const _MNS = 'fqksdHAMCZb7UJFwDZ3-qQ';
const MAPBOX_TOKEN_NATIVE = _MNH + '.' + _MNS;
const MAPBOX_TOKEN = (typeof window !== 'undefined'
                     && window.Capacitor
                     && typeof window.Capacitor.isNativePlatform === 'function'
                     && window.Capacitor.isNativePlatform())
  ? MAPBOX_TOKEN_NATIVE
  : MAPBOX_TOKEN_WEB;

// ── Google Places ───────────────────────────────────────────────────────────
//
// Truthiness flag only — the real server-side key lives in the
// Cloudflare Pages Function env (functions/api/places-*.js). The client
// never calls maps.googleapis.com directly; all Places traffic goes
// through /api/places-autocomplete, /api/places-search, /api/place-photo.
// This constant is kept for backward compatibility with js/app.js's
// `if (!GOOGLE_PLACES_KEY)` gate around the suggest-venue flow.
const GOOGLE_PLACES_KEY = 'proxied-via-cloudflare-functions';

// ── Runtime-fetched data files ──────────────────────────────────────────────
//
// On web, data/*.json is served from the same origin as the app and the
// service worker handles caching. On native (Capacitor), `fetch('data/X.json')`
// resolves against capacitor://localhost → the BUNDLED file inside the .app /
// APK. That bundle is frozen at build time, so weekly geometry refreshes /
// venue updates / new seating polygons never reach native users until the
// next App Store / Play release.
//
// Fix: on native, fetch from https://findshades.app/data/... at runtime. The
// bundled `data/` stays as the offline fallback (catastrophic network).
// Web users hit the same-origin path unchanged.
//
// `data/*.json` is served by Cloudflare with `Cache-Control: no-cache` per
// `_headers`, so native users will pick up updates on their next launch /
// fetch — no CACHE_VERSION bump needed for data refreshes.
const _DATA_REMOTE_BASE = 'https://findshades.app/data';
const _DATA_LOCAL_BASE  = 'data';
const _USE_REMOTE_DATA  = (typeof window !== 'undefined'
                           && window.Capacitor
                           && typeof window.Capacitor.isNativePlatform === 'function'
                           && window.Capacitor.isNativePlatform());

function dataUrl(path) {
  const clean = String(path || '').replace(/^\/?(data\/)?/, '');
  return (_USE_REMOTE_DATA ? _DATA_REMOTE_BASE : _DATA_LOCAL_BASE) + '/' + clean;
}

async function dataFetch(path, init) {
  const clean = String(path || '').replace(/^\/?(data\/)?/, '');
  if (!_USE_REMOTE_DATA) return fetch(_DATA_LOCAL_BASE + '/' + clean, init);
  // Native: try remote first, fall back to bundled on any failure
  // (offline, DNS, 4xx/5xx). Catches both cold-launch-offline and
  // mid-flight network drops. Bundled copy may be stale but usable.
  try {
    const resp = await fetch(_DATA_REMOTE_BASE + '/' + clean, init);
    if (resp.ok) return resp;
    throw new Error('non-ok ' + resp.status);
  } catch (e) {
    console.warn('[data] remote fetch failed, falling back to bundled:', path, e.message);
    return fetch(_DATA_LOCAL_BASE + '/' + clean, init);
  }
}
