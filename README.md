# Solsteder

Solar-optimized venue finder for Oslo. Tells you which outdoor terraces have
sun *right now* (or at any hour you scrub to), filters by weather, lets you
make plans with friends, and surfaces friend check-ins on the map.

Web build runs as a pure-frontend PWA — no build step, no bundler. The same
codebase ships to iOS (App Store) via Capacitor; Android wrapping is staged
but unshipped.

## Tech stack

- **Frontend**: vanilla JS PWA (no framework, no bundler). All scripts loaded
  from `index.html` with `?v=` cache-bust query strings.
- **Map**: [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/) for the
  basemap and 3D buildings; sun arc and shadow overlay drawn on a 2D canvas
  layered above.
- **Backend**: [Supabase](https://supabase.com/) — Postgres + Auth + RLS
  + Realtime + Edge Functions + pg_cron. Auth via Google OAuth.
- **Push**: Web Push via VAPID-signed payloads, fanned out from DB triggers
  through a `send-push` edge function gated by an `X-Push-Secret` header.
- **Hosting**: [Cloudflare Pages](https://pages.cloudflare.com/) for the web
  build (git integration auto-deploys from the repo). [Cloudflare Pages
  Functions](https://developers.cloudflare.com/pages/functions/) proxy Google
  Places requests so the API key stays server-side.
- **iOS**: [Capacitor](https://capacitorjs.com/) wraps the same `index.html`
  + JS bundle in a WKWebView; the iOS-specific bits live in `ios/`.

## Local dev

```bash
# 1. Clone
git clone https://github.com/thor-erik/Solsteder.git
cd Solsteder

# 2. Set up keys
cp js/config.example.js js/config.js
# Edit js/config.js: fill MAPBOX_TOKEN_WEB, MAPBOX_TOKEN_NATIVE, GOOGLE_PLACES_KEY.
# (GOOGLE_PLACES_KEY only needs to be truthy for client gates — Places
#  traffic goes through the Cloudflare Pages Function proxy.)

# 3. Serve
open index.html               # works for most things
python3 -m http.server 8000   # recommended (avoids file:// CORS edges)
```

Open http://localhost:8000.

## Deploy

### Web (production)

Push to `master` → Cloudflare Pages auto-deploys to **findshades.app** within
2–5 min. No build step on the Cloudflare side — repo root is the document
root.

### Web (preview)

Push any other branch → Cloudflare Pages publishes a preview at
`<branch>.solsteder.pages.dev`. Note: images and Supabase auth are
domain-restricted to `findshades.app`, so previews can verify UI / layout
but **not** the logged-in flows or venue photos.

**CRITICAL**: commits alone don't deploy — only `git push` does.

### iOS

```bash
npm run cap:sync   # rm -rf www && cp -R <web assets> www/ && npx cap sync
```

`www/` is the iOS bundle root. It's a **build artifact** (gitignored) — the
web app ships from repo root, the iOS app ships from `www/`. Both run the
same source. Any iOS release must run `cap:sync` first or it'll ship stale
code. A CI workflow (`.github/workflows/cap-sync-check.yml`) verifies www/
matches root by content hash on every push to master.

After `cap:sync`:

```bash
npm run cap:ios       # opens Xcode for signing + archive
npm run cap:android   # opens Android Studio (Play Store wrap is staged)
```

## Architecture

`index.html` loads all scripts in dependency order and calls `init()` at the
bottom. There's no module system — globals are namespaced by file role.
Most files own a slice of the UI; map + sun math are split across worker +
solar.js.

See [CLAUDE.md](CLAUDE.md) for the full file map, the design system, the
backend reference, and debugging protocols.

## Database

Supabase project: single instance hosts auth, RLS-protected user data, the
notifications inbox, friend/plan graph, web-push subscriptions, and analytics
events. Migrations live in `sql/` (003–042, idempotent). See CLAUDE.md
"Backend (Supabase)" for the full table reference, RLS notes, and push-pipeline
rotation procedures.

## License

MIT
