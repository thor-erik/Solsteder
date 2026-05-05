// Copy this file to js/config.js and fill in your tokens.

// Mapbox access token — get it at https://account.mapbox.com
const MAPBOX_TOKEN = 'YOUR_MAPBOX_TOKEN_HERE';

// Google Places API key — needed for venue suggestions (text search lookup).
// Get it at https://console.cloud.google.com (create/enable Places API).
const GOOGLE_PLACES_KEY = 'YOUR_GOOGLE_PLACES_KEY_HERE';

// Anthropic API key — script-only, never shipped to the browser.
// Used by scripts/detect-seating-areas.mjs to ask Claude vision to outline
// outdoor-seating polygons from satellite snapshots. Set this in .env (NOT in
// js/config.js) so it stays out of the bundle:
//   ANTHROPIC_API_KEY=sk-ant-...
