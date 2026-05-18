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
const MAPBOX_TOKEN_WEB    = 'pk.eyJ1IjoidGhvci1lcmlrIiwiYSI6ImNtbXlvbW5oNDM1Nm8ycXF0bXYycTk3aHIifQ.eA34qGH7IsPWZG5bgonY_A';
const MAPBOX_TOKEN_NATIVE = 'pk.eyJ1IjoidGhvci1lcmlrIiwiYSI6ImNtcGJpaHdnMDA2eDcyc3M4aHFnbTdiY3IifQ.fqksdHAMCZb7UJFwDZ3-qQ';
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
