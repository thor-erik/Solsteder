# Solsteder

Solar-optimized venue finder for Oslo. Pure frontend — no build step, no tests, no bundler.
Open `index.html` directly in a browser or serve statically.

## Design system

**Read `DESIGN.md` before any UI change.** It is the source of truth for visual decisions.

Quick orientation:
- Brand: **Shades** (sun-glasses + shadows double-entendre), **Slate + Honey** palette
- Every UI surface belongs to **one of six tiers** — Tier 0 (map), Tier 1 (lens panel), Tier 2 (lens object), Tier 3 (surface control), Tier 4 (honey CTA), Tier 5 (honey badge), Tier 6 (map canvas)
- Tier determines opacity, effects, motion, and accent usage
- Never reference raw hex in components — use `:root` semantic tokens (`--accent`, `--bg`, `--text`, `--muted`, etc.)
- Run `node scripts/validate-tokens.mjs` before committing UI work
- Open `system.html` for rendered visual examples of each tier

If a UI change wants to break a rule in `DESIGN.md`, update the doc first and justify the change in the commit message.

## Workflow

Two tiers based on risk. When unsure, default to the branch flow.

### Tier 1 — Direct push to master

Use for low-risk, easily reversible changes:
- Copy/text edits, comments, config tweaks
- Single-line fixes that are obviously correct
- Color/style tweaks already verified locally

After modifying files, commit AND `git push origin master` without waiting to be asked. Cloudflare Pages auto-deploys to findshades.app within 2–5 minutes.

### Tier 2 — Branch + Cloudflare Preview, then fast-forward master

Use for anything substantial:
- Layout changes (especially mobile/iOS — see "Layout debugging protocol")
- New features, multi-file refactors
- Data-flow or state changes
- Anything not fully verifiable locally

Procedure:
1. Create a branch, commit, push the branch
2. Cloudflare auto-deploys a preview URL — share it with the user
3. Wait for user confirmation before merging
4. Fast-forward master to the branch and push, then delete the branch

No draft PR by default — pushing the branch alone gets a preview. Open a PR only if the user wants a comment thread.

**CRITICAL:** Commits alone do not deploy. Pushing to `master` deploys to production; pushing to any other branch deploys to a preview URL. If you commit without pushing, nothing goes live.

Use concise commit messages. Skip the commit/push step only if the user explicitly says not to commit yet.

## File map

### Boot + state
| File | Role |
|------|------|
| `index.html` | Entry point. Loads every JS file in dependency order with `?v=...` cache-bust strings; `init()` runs from the bottom of the body. |
| `js/init.js` | `init()` boot orchestrator — kicks off auth, map, sun timer, and notification systems in the right order. |
| `js/config.js` | API keys. Gitignored. See `config.example.js`. Exports `MAPBOX_TOKEN` as a runtime branch: `Capacitor.isNativePlatform() ? MAPBOX_TOKEN_NATIVE : MAPBOX_TOKEN_WEB`. |
| `js/app.js` | Mutable state, map setup, Mapbox GL wiring, worker glue, floating time slider, sidebar, search, intent shortcuts, intro sequence, popstate handler. Single largest file. |
| `js/tokens.js` | JS-side semantic token registry. Mirrors the `:root` CSS vars so canvas drawing code can read them without DOM queries. |
| `js/worker.js` | Web worker for off-thread solar computation (sun table, shadow polygons). |

### Map + canvas rendering
| File | Role |
|------|------|
| `js/map-style.js` | Mapbox style definition (sources, layers, paint). |
| `js/lens-effects.js` | Blue-glass "lens" overlay effects on the map canvas. Brand metaphor — see Design system. |
| `js/render-pins.js` | Sprite cache, pin tier classification, friend palette, pulse rings, pill drawing, floating name placement, audit pins, density rules, main `draw()` loop, hit testing, canvas events. |
| `js/render-arc.js` | Sun compass + day-arc canvas. |
| `js/render-seating.js` | Seating-area footprints, shadow overlay, zoom-density filter. |
| `js/render-editor.js` | Building editor overlay — wall selection, depth drag. |
| `js/render-wind.js` | Wind direction overlay. |
| `js/render-helpers.js` | Shared geometry / drawing utilities: `shortName`, wall helpers, `fillRoundRect`, `convexHull`, terrace polygons. |

### UI panels
| File | Role |
|------|------|
| `js/ui-list.js` | Venue cards, list rendering, infinite scroll, hover tooltip. |
| `js/ui-detail.js` | Detail panel HTML, sun dial, timeline, busyness chart, parallel-action carousel, instant check-in toggle, invite-sheet half-screen overlay. |
| `js/ui-plan-preview.js` | Plan-preview overlay — accept page, post-accept confirm, FTS scrubber, timeline event glyphs, later-strip, weather samples, sun-window debug. Overlay lifecycle manages an `_cleanup` chain — see anti-patterns. |
| `js/ui-shelter.js` | Isometric wind-shelter diagram. |
| `js/ui-shared.js` | Cross-panel helpers: venue state model (Task 2), card pill builder, v2 anchor / pill builders, fill-bar geometry, opening-hours helpers, city-wide sun outlook, weather-aware arc color (`wxColor` / `wxArcPaths`), SVG icons, shared timeline renderer. |
| `js/login-carousel.js` | Login-screen rotating-feature carousel. |

### Data + math
| File | Role |
|------|------|
| `js/data.js` | Venue data loading and filtering. |
| `js/solar.js` | Sun position math (azimuth / altitude), sun table, shadow logic. |
| `js/scoring.js` | Venue scoring from solar exposure windows. |
| `js/weather.js` | yr.no / met.no weather fetch and icon mapping. |
| `js/busyness.js` | Crowd / busyness estimates. |
| `js/osm.js` | Overpass queries, OSM building-geometry parsing. |
| `js/places.js` | Google Places photo URL fetch helper (server-side proxy via Cloudflare Pages Function). |

### Auth, notifications, social
| File | Role |
|------|------|
| `js/auth.js` | Supabase auth, settings view, activity sub-view, per-friend visibility, notification-types sub-view, admin sub-views, debug reveal, bell dropdown + realtime, friends modal, pending count, suggestions, favorites, sun alerts, user preferences, cross-device UI state, friends graph, check-ins, periodic social poll, plans CRUD. Second largest file. |
| `js/push.js` | Web push subscribe / unsubscribe / dismiss-tag. `pushIsAvailable()` returns false inside Capacitor (no APN/FCM entitlement yet). |
| `js/notifications.js` | Smart toast / notification queue. Constants, mutable state, localStorage helpers, queue ops, toast UI, suspend/resume around search, evaluators (P0 sun alerts, P0 weather, P0/P1 social), evaluator registry, settings toggle. |
| `js/i18n.js` | Translation strings + render helpers (en / no). Largest mostly-data file. |
| `js/analytics.js` | Analytics event emitter — POSTs into the `events` table. Per-row size caps enforced by `sql/035`. |
| `js/admin-audit.js` | Admin audit panel — render audit pins, surface issues. |
| `js/admin-review.js` | Admin review panel — approve/reject suggested venues. |

### Data files
| File | Role |
|------|------|
| `data/venues.json` | Source of truth for venue records. |
| `data/geometry.json` | Pre-computed building geometry, auto-generated by `update-geometry.mjs`. **Never edit directly.** |

## Data pipeline

Scripts in `scripts/` are run manually or via GitHub Actions:

```
node scripts/fetch-venues-places.mjs   # Pull venues from Google Places
node scripts/update-geometry.mjs       # Recompute geometry.json from venues.json
node scripts/fetch-photos.mjs          # Fetch venue photo URLs
```

`geometry.json` is derived from `venues.json` — never edit it directly.

## Backend (Supabase)

The app talks to a single Supabase project. Anon key + URL are
checked-in (domain-restricted; safe). All persistence + auth + realtime
+ push fan-out lives here.

### Tables (in `public`)
| Table | What |
|-------|------|
| `profiles` | One row per auth user. `id` (= auth.users.id), `email`, `name`, `role`, `avatar_url`, `locale`, `created_at`, `last_seen_at`. Auto-created via the `on_auth_user_created` trigger on signup. `name`/`avatar_url` set once at signup from `user_metadata`. |
| `events` | Analytics event sink. Anon-insert allowed; `events_event_length` + `events_properties_size` CHECK constraints cap per-row size. |
| `suggested_venues` | User-submitted venue suggestions, admin-reviewed. |
| `favorites` | Per-user favorited venues. |
| `sun_alerts` | Per-user sun-window notification rules. |
| `user_preferences` | Per-user lang / temp unit / default area. Also a `state` JSONB bag for cross-device UI state (dismissed prompts, hidden friend visibility, bell-opened timestamp). |
| `friendships` | Bidirectional friend graph. `status ∈ pending/accepted/blocked`. Row direction = `user_id` requested friendship with `friend_id`. Recipient-side INSERT is restricted to `status='pending'` (sql/036) so a recipient can't claim an accepted friendship without the inviter's consent. |
| `checkins` | Friend check-ins (expire after 3h). |
| `plans` | Created plans. Creator only. `venue_name` denormalized so the push trigger can include it. `cancelled_at` is the soft-cancel flag. `reminder_sent_at` stamps when the 30-min cron reminder fired. A BEFORE UPDATE trigger (sql/040) blocks writes to `id`/`creator_id`/`venue_id`/`venue_name`/`planned_at`/`created_at` so the creator can't mutate set-once fields after invitees accept. |
| `plan_invites` | Per-invitee status on a plan. `status ∈ pending/accepted/declined`, optional `arrival_time` for off-plan arrivals. |
| `push_subscriptions` | Web push endpoints + keys. One row per device the user enabled push on. |
| `notifications` | Per-user notification inbox backing the bell dropdown. `body` is server-rendered HTML containing only `<strong>...</strong>` markup; the client renders via `_escAllowStrong` (auth.js) to preserve emphasis while neutralizing any other tag. |
| `_app_settings` | Internal key/value config (RLS deny-all). Holds `send_push_url`, `send_push_bearer`, `send_push_secret`. Read by `_do_send_push` (SECURITY DEFINER) from every push-firing trigger. Rotation goes through `UPDATE _app_settings SET value = ... WHERE key = ...`. |

Migrations live in `sql/` (`003`–`042`). They were run manually against
the prod project. Re-run any time you stand up a fresh project — they
are all `CREATE ... IF NOT EXISTS` / idempotent. `sql/039-revoke-profile-email-HOLD.sql`
is suffix-named so a wildcard apply doesn't sweep it in; rename to drop
`-HOLD` only after confirming the client's friend-add path is on the
`request_friend_by_email` RPC.

| Migration | Purpose |
|-----------|---------|
| `003-favorites.sql` | Per-user favorited venues. |
| `004-sun-alerts.sql` | Per-user sun-window notification rules. |
| `005-user-preferences.sql` | Per-user lang / temp unit / default area + `state` JSONB bag for cross-device UI state. |
| `006-friendships.sql` | Bidirectional friend graph + initial RLS. |
| `007-checkins.sql` | Friend check-ins (3 h TTL). |
| `008-plans.sql` | Plans + plan_invites. |
| `009-plan-invite-arrival-time.sql` | Optional `arrival_time` on invites for off-plan arrivals. |
| `010-push-subscriptions.sql` | Web push subscription store (one row per device). |
| `011-push-triggers.sql` | First push-firing triggers (later replaced by `_do_send_push` in 037). |
| `012-notifications.sql` | Per-user notifications inbox table backing the bell dropdown. |
| `013-notification-triggers.sql` | Server-side notification fan-out for response + accept events. |
| `014-backend-audit-fixes.sql` | Security audit pass: REVOKE EXECUTE on SECURITY DEFINER from anon+auth; pin `search_path`. |
| `015-revoke-from-public.sql` | Finish 014 — Postgres grants EXECUTE to PUBLIC by default; revoke. |
| `016-consolidate-policies.sql` | Eliminate overlapping permissive RLS policies flagged by perf advisor. |
| `017-profile-state-extensions.sql` | `profiles.created_at` / `last_seen_at` / `locale`; bump `last_seen_at` on auth. |
| `018-friendship-insert-trigger.sql` | Fire friendship-accepted notification on INSERT (share-link path), not only UPDATE. |
| `019-friendship-accepted-push.sql` | Push for friendship-accepted (share-link + classic accept). |
| `020-plan-policy-recursion-fix.sql` | Break `plans ⇄ plan_invites` RLS recursion introduced by 016. |
| `021-is-plan-creator.sql` | SECURITY DEFINER helper to finish breaking the recursion (Postgres's recursion detector is structural). |
| `022-plan-invite-insert-triggers.sql` | Fire initial-invite notifications on INSERT at `status='pending'` (response triggers already existed). |
| `023-fk-creator-user-to-profiles.sql` | Repoint 3 FKs from `auth.users(id)` → `profiles(id)` so PostgREST resolves `creator:profiles!plans_creator_id_fkey` embeds. |
| `024-plan-venue-name-denorm.sql` | Denormalize `venue_name` onto `plans` so the push trigger can include it (venues live client-side in venues.json). |
| `025-plan-accepted-counts.sql` | SECURITY DEFINER helper returning accepted-invitee count per plan for the "+2" bell row wording. |
| `026-plan-cancellation.sql` | `plans.cancelled_at` soft-cancel + notify invitees on cancel. |
| `027-plan-response-push-aggregate.sql` | Push for accept/decline now aggregates via tag-based replacement (one push per plan per status). |
| `028-plan-response-bell-aggregate.sql` | Bell-inbox row for accept/decline aggregates per plan/status, shared `notif_id` format with client aggregator. |
| `029-plan-reminders.sql` | pg_cron job `plan-reminders` (`*/5 * * * *`): 30-min reminder push + inbox row for creator + each accepted invitee. |
| `030-notif-day-label-weekday.sql` | Server-rendered notif date phrasing matches client `_dayLabel` (today / tomorrow / weekday). |
| `031-notifications-ttl-cleanup.sql` | pg_cron `notifications-ttl-cleanup` (`0 1 * * *`): delete rows older than 30 days. |
| `032-push-deeplink-urls.sql` | Push payloads carry `/?nav=plan&v=...&t=...&cancelled=...` URL instead of bare `/`. |
| `033-notif-helpers-tz-arg.sql` | Make timezone a parameter on the date-phrasing helpers (currently always `Europe/Oslo`). |
| `034-block-response-on-cancelled.sql` | Reject `plan_invites` accept/decline when the parent plan is cancelled (race guard). |
| `035-events-size-caps.sql` | CHECK constraints `events_event_length` + `events_properties_size` to cap analytics row size. |
| `036-friendship-tighten-insert.sql` | Recipient-side INSERT into `friendships` restricted to `status='pending'` (closes C2 enumeration). |
| `037-app-settings-and-push-helper.sql` | `_app_settings` key/value (RLS deny-all) + `_do_send_push(target, payload)` helper. Six push triggers rewritten to use it — replaces nine inlined bearers. |
| `038-friend-by-email-rpc.sql` | `request_friend_by_email(p_email)` SECURITY DEFINER RPC: atomic email → UUID + insert pending row. |
| `039-revoke-profile-email-HOLD.sql` | REVOKE SELECT on `profiles.email` from anon+authenticated. Suffix-named to prevent wildcard apply. |
| `040-plans-immutable-columns.sql` | BEFORE UPDATE trigger blocks writes to `plans.{id, creator_id, venue_id, venue_name, planned_at, created_at}` post-acceptance. |
| `041-friend-invite-tokens.sql` | One-shot 122-bit friend-invite tokens (single-use, 30 d TTL) + cleanup cron. Restores 1-click share-link UX without re-opening C2. |
| `042-plan-reminders-skip-orphans.sql` | `process_plan_reminders()` skips plans WHERE `venue_name IS NULL` (defense in depth against future orphan regressions). |

### Realtime
`plan_invites`, `friendships`, `notifications`, and `suggested_venues`
are in the `supabase_realtime` publication. `js/auth.js` subscribes on
auth load; changes trigger `loadPlans` / `loadFriends` / bell rerender
/ admin badge refresh. The 60 s social poll remains as a fallback for
tabs that drop the channel.

### Scheduled (pg_cron)
| Job | Schedule | What |
|-----|----------|------|
| `plan-reminders` | `*/5 * * * *` | `process_plan_reminders()` — writes inbox rows + fires push for plans starting in 25–35 min |
| `notifications-ttl-cleanup` | `0 1 * * *` | Deletes `notifications` rows older than 30 days |

### Web push (live in prod)
Pipeline: receiver action → trigger row writes to `plan_invites` /
`friendships` / `plans` → DB trigger calls `_do_send_push(target, payload)`
helper → helper reads URL/bearer/secret from `_app_settings` and posts
to the `send-push` edge function with `X-Push-Secret` header → edge
function constant-time-compares the secret to `PUSH_TRIGGER_SECRET`,
validates `user_id` is a UUID and `payload.url` is a same-origin path,
reads `push_subscriptions` for the target → signs payload with VAPID
private key → POSTs to each device's push endpoint.

* Client: `js/push.js`. `VAPID_PUBLIC_KEY` constant must be set or the
  toggle stays hidden. Profile panel toggle wires `pushRequestPermission`
  / `pushDisable`. Service worker at `sw.js` (root) handles `push` and
  `notificationclick`. `notificationclick` resolves the target through
  `new URL(...)` and only navigates/openWindows when the resolved origin
  is same-origin — defense in depth against stale notification payloads
  carrying external URLs.
* Edge function: `supabase/functions/send-push/index.ts`. Reads four
  secrets — `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
  `PUSH_TRIGGER_SECRET`. Deployed with `--no-verify-jwt` (the
  `X-Push-Secret` header is the actual auth gate; JWT verify isn't
  workable because DB triggers don't carry a user JWT). Endpoint:
  `https://wxalqodaeqgzahwlovnw.supabase.co/functions/v1/send-push`.
* Triggers that fire push: `notify_friend_request`, `notify_friend_accepted`,
  `notify_plan_invite_created`, `notify_invite_response`,
  `notify_plan_cancelled`, `process_plan_reminders`. All call
  `_do_send_push` — none inline the bearer or URL anymore.
* Rotating the Supabase anon key:
  1. Update `js/auth.js` (`SUPABASE_ANON_KEY` constant).
  2. `UPDATE public._app_settings SET value = '<new key>' WHERE key = 'send_push_bearer';`
  3. Bump `js/auth.js?v=...` in `index.html` and `CACHE_VERSION` in `sw.js`.

  No SQL migration re-run, no trigger rewrites, no app redeploy needed.
  (Pre-sql/037 each trigger function inlined the bearer; rotation
  required re-running nine SQL files. The helper indirection removed
  that.)
* Rotating the trigger secret:
  1. `UPDATE public._app_settings SET value = encode(gen_random_bytes(32), 'hex') WHERE key = 'send_push_secret' RETURNING value;`
  2. `supabase secrets set PUSH_TRIGGER_SECRET=<value from step 1>`
  3. `supabase functions deploy send-push --no-verify-jwt`

  Triggers pick up the new secret on the next `_do_send_push` call. Any
  in-flight push fired between step 1 and step 3 will 401 — the secret
  rotation should be quick to avoid the gap.
* iOS caveat: web push needs iOS 16.4+ AND the site added to home
  screen as a PWA. Capability check in `pushIsAvailable()` hides the
  toggle on unsupported browsers.

### Profiles + RLS
`profiles` has a public-readable SELECT policy intact so anon invite-link
visitors can render "Anna invited you to X". Column-level SELECT grant
restricts anon/authenticated to `(id, name, avatar_url, role, locale,
created_at, last_seen_at)` (sql/039) — `email` is not readable via REST.
The only path to resolve a profile by email is the SECURITY DEFINER RPC
`request_friend_by_email(p_email)` (sql/038), which atomically looks up
the user and inserts a `pending` friendship row in one call. The
existing inviter-side `sendFriendRequest` in `js/auth.js` routes through
this RPC; the share-link recipient path in `_tryFriendInvite` inserts
its own `pending` row (also direction-flipped so the requester is
`user_id`, matching the trigger that fires `notify_friend_request`).

If a future need surfaces emails to anon or authenticated, GRANT them
explicitly — don't drop the column-level restriction.

## Reading large files efficiently

Several files are large enough that reading them in full wastes significant context. Always grep first, then read the specific line range.

**Quick section lookup:** `grep -n "^// ──" js/<file>.js`

Tables below were re-derived 2026-05-18. Old offsets in earlier CLAUDE.md revs were ~5× stale.

### app.js (7527 lines)
| Lines | Section |
|-------|---------|
| 10 | Feature flags |
| 13 | Mutable state |
| 62 | Back-button / browser history nav |
| 105 | Time animation |
| 112 | Intro sequence state |
| 125 | Floating time slider (round 12) |
| 1288 | Sun window cache |
| 1324 | Web Worker |
| 1407 | Map (Mapbox GL setup) |
| 1424 | User location dot |
| 1606 | Zoom jog slider |
| 1808 | Sun lighting (Mapbox GL v3) |
| 1849 | Canvas |
| 1853 | DOM refs (resolved post-DOMContentLoaded) |
| 1861 | Utility formatters |
| 1864 | Explore-mode post-flow helper |
| 2087 | Slider |
| 2126 | Intent shortcuts |
| 2198 | Date display button + weather strip |
| 2244 | Date calendar picker |
| 2329 | Hover from sidebar list |
| 2343 | Favorites filter |
| 2346 | Area filter |
| 2357 | Cluster proximity |
| 2381 | Sort |
| 2506 | Debounced time-change analytics |
| 2519 | Debounced list render |
| 2587 | QC notice |
| 2597 | Toast notifications |
| 2613 | Day navigation |
| 2651 | Sun curve click → set time |
| 2652 | Arc canvas time interaction |
| 2704 | Readout panel |
| 3173 | Peek height (handle + time bar + list-sun-header + venue-peek) |
| 3209 | Venue peek render |
| 3226 | Main update cycle |
| 3334 | Popup helpers |
| 3427 | Venue selection + popup |
| 3430 | Shared venue camera animation |
| 3524 | Detail panel |
| 3901 | Edit mode |
| 4089 | Edit-banner ResizeObserver (drives FTS + zoom-jog vertical positioning) |
| 4476 | Sidebar + filters |
| 5431 | Control event listeners |
| 5463 | Oslo candidate index (lazy-loaded on first search miss) |
| 5480 | Search dropdown |
| 5485 | Area index |
| 5513 | Geocoding (areas via Mapbox fallback) |
| 5607 | Search normalization & fuzzy matching |
| 5711 | Search relevance scoring |
| 5779 | Search dropdown rendering |
| 5954 | Google Places Autocomplete search |
| 6173 | Panel action-row filters |
| 6238 | Search placeholder typewriter |
| 6427 | Venue suggestion flow |
| 6624 | Intro sequence |
| 7498 | Back-button / popstate handler |

### render-pins.js (2402 lines)
| Lines | Section |
|-------|---------|
| 41 | Density rule (Google-Maps-style) |
| 61 | Pin tier classification |
| 126 | Token-derived rgba helper |
| 142 | Friend palette |
| 158 | Pin geometry constants |
| 177 | Status colour for dot / friend capsule |
| 209 | Vector category icons |
| 296 | Time formatting |
| 303 | Friend module helpers |
| 375 | Invite avatar pin (accept page / post-accept confirm) |
| 600 | Pulse rings (privileged ambient on friend pills) |
| 640 | Pill width |
| 652 | Pill drawing |
| 776 | AABB overlap & density score |
| 806 | Floating name with cream halo + density-aware anchor |
| 907 | Sun-hours summary line (zoom ≥ 16) |
| 932 | Pin animation framework (alpha + scale + morph lerp) |
| 981 | Zoom-stability cache |
| 997 | Audit pins (admin) |
| 1063 | Layout state (consumed by hit testing + external code) |
| 1075 | Canvas resize + map sync |
| 1096 | Map pan helper |
| 1131 | Friend / going accessors |
| 1143 | Main `draw()` |
| 1770 | Hit testing |
| 1832 | Canvas event handling |

### ui-detail.js (2556 lines)
| Lines | Section |
|-------|---------|
| 13 | Detail panel content |
| 865 | Accepted panel — parallel-action carousel |
| 1233 | Instant check-in toggle |
| 1250 | Invite sheet (half-screen overlay) |

### auth.js (3687 lines)
| Lines | Section |
|-------|---------|
| 1 | Supabase auth |
| 579 | Settings view (root) |
| 809 | Activity sub-view |
| 821 | Per-friend visibility sub-view |
| 848 | Notification types sub-view |
| 881 | Admin sub-views |
| 1017 | About row 5-tap → reveal debug |
| 1118 | Bell dropdown (notifications inbox) |
| 1436 | Realtime: notifications INSERTs |
| 2101 | Friends modal |
| 2231 | Pending count |
| 2258 | My suggestions |
| 2352 | Load approved suggested venues into VENUES |
| 2393 | Load current user's own suggestions |
| 2440 | Admin venue suggestions panel |
| 2489 | Admin review panel |
| 2558 | Role manager panel |
| 2591 | Favorites |
| 2632 | Sun alerts |
| 2718 | User preferences (account sync) |
| 2759 | Cross-device UI state (`user_preferences.state` JSONB) |
| 2825 | Friends |
| 2957 | Check-ins |
| 3113 | Periodic social poll |
| 3164 | Plans |
| 3553 | Init |

### ui-plan-preview.js (1818 lines)
Only one explicit section marker (`1611  Timeline event glyphs`). The bulk before that is the overlay lifecycle — `openPlanPreview`, FTS scrubber wiring, accept page render, post-accept confirm, later-strip. `closePlanPreview` must invoke `st.overlay._cleanup`; see anti-patterns.

### i18n.js (1977 lines)
Flat dictionary — `EN` and `NO` objects + render helpers. Grep for the key (e.g. `grep -n "notif_invite_received_body" js/i18n.js`) rather than reading by offset.

### notifications.js (1388 lines)
| Lines | Section |
|-------|---------|
| 1 | Smart Notification System |
| 5 | Constants |
| 25 | Mutable State |
| 38 | localStorage Helpers |
| 72 | Queue Operations |
| 179 | Toast UI |
| 435 | Suspend / resume around search |
| 457 | Evaluators: P0 Alerts (user-opted-in) |
| 619 | Evaluators: P0 Weather |
| 836 | Evaluators: P1 Social |
| 1226 | Evaluator Registry |
| 1250 | Evaluate & Schedule |
| 1285 | Notification Settings Toggle |
| 1374 | Init |

### ui-list.js (1299 lines)
| Lines | Section |
|-------|---------|
| 14 | Skeleton cards |
| 38 | Venue list |
| 1275 | Hover tooltip |

### ui-shared.js (1006 lines)
| Lines | Section |
|-------|---------|
| 8 | Venue state model (Task 2) |
| 104 | Card pill builder |
| 164 | v2 anchor + pill builders + fill-bar geometry |
| 316 | Opening hours helpers |
| 328 | Data helpers for detail panel |
| 352 | Venue list helpers |
| 363 | City-wide sun outlook |
| 472 | Weather-aware arc color (`wxColor` / `wxArcPaths`) |
| 566 | Google Maps-style SVG icons for detail panel |
| 599 | Shared timeline renderer |

### data/venues.json (109 records)
Inspect schema without reading the full file:
```
python3 -c "import json; d=json.load(open('data/venues.json')); print(list(d[0].keys()))"
```

## Layout debugging protocol

For any layout or visual bug, follow this sequence — no exceptions:

1. **Audit first.** Run `node scripts/audit-layout.mjs <element>` before reading any code.
   - Example: `node scripts/audit-layout.mjs detail-panel`
   - Example: `node scripts/audit-layout.mjs height overflow`
2. **Map the full constraint chain.** Identify every rule touching the element: CSS cascade, media queries, JS inline overrides, CSS vars. Write it out before proposing a fix.
3. **One precise change.** Fix the root cause, not the symptom. Do not make multiple small attempts. If the root cause is unclear, say so — don't guess and commit.
4. **No speculative iteration.** Do not commit a "try this" change. Only commit when the fix is well-reasoned.

Mobile-specific caveats:
- iOS Safari viewport bugs (address bar, safe areas) cannot be verified without a real device. Say so explicitly rather than iterating blindly.
- `--vh` is set by JS (`app.js:15`) from `visualViewport.height`. Any height relying on `--vh` depends on JS running.
- `#detail-panel.open` has intentionally separate transforms per media query (translateX desktop, translateY mobile) — the audit script flags these as conflicts but they are not.

## Key constraints

- No npm/node during runtime — all deps are CDN-loaded in `index.html`
- Discovery staging triad — intermediate pipeline artifacts, not loaded by the app:
  - `data/venues-fetched.json` — HIGH-confidence new venues (auto-mergeable)
  - `data/venues-review.json` — LOW-confidence single-signal hits (manual review)
  - `data/venues-osm-unresolved.json` — OSM-tagged terraces with no Google match
- Mapbox GL JS is the map renderer; solar arc and shadows are drawn on a canvas overlay

## Deployment topology

Two ship paths, one source tree.

### Web (Cloudflare Pages)
Repo root **is** the document root. Cloudflare Pages git integration auto-deploys:

| Push to | Lands at |
|---------|----------|
| `master` | https://findshades.app (2–5 min) |
| any other branch | `<branch>.solsteder.pages.dev` (preview) |

Cloudflare runs no build step. The repo's `index.html`, `js/`, `data/`, `sw.js`, etc. ARE the deployed bundle. That's why CSS/JS edits MUST bump:
- `?v=<token>` query strings in `index.html` (long-immutable Cloudflare cache on `/js/*`)
- `CACHE_VERSION` in `sw.js` (service worker pre-cache)

Skip either and existing users see stale code indefinitely.

### iOS (Capacitor)
iOS ships from `www/`, which is a **build artifact** (gitignored).

```
npm run build      # rm -rf www && mkdir -p www && cp -R index.html privacy.html
                   #                                       terms.html manifest.json
                   #                                       sw.js shades-logo.png
                   #                                       favicon* apple-touch-icon-*
                   #                                       js data design www/
npm run cap:sync   # npm run build && npx cap sync
npm run cap:ios    # cap:sync && npx cap open ios
```

**Any iOS release must run `cap:sync` first** or it ships stale code (literally the previous archive's web bundle). `.github/workflows/cap-sync-check.yml` runs cap:sync on every master push + every PR touching web assets and content-hashes www/ vs root; catches the `npm run build` cp list silently dropping a file.

The cp list is fragile. When adding a new top-level asset:
1. Add it to the cp list in `package.json` (`build` script).
2. Confirm it's referenced from a `www/`-served HTML or JS.
3. Push and wait for `cap-sync-check.yml` to go green.

### Android (Capacitor)
Same `cap:sync` pipeline. Ships from `android/app/src/main/assets/public/`. Wrap is built but unshipped to Play Store as of 2026-05-18.

## Patterns standardized during cleanup

Reuse these in new code — they encode invariants caught in the security + engineering pass.

### Escape EVERY user-controlled string in innerHTML
`auth.js` exposes two helpers:
- `_esc(s)` — escapes everything (default).
- `_escAllowStrong(s)` — preserves `<strong>...</strong>` only, neutralizes any other tag. Use for server-rendered `notifications.body` where SQL triggers wrap names in `<strong>`.

Sources that need escaping: OAuth-supplied profile name / avatar_url, venue_name, inviter name, friendship / notification / invite IDs that come from a DB row.

Pattern in practice: never write `el.innerHTML = \`<div>${userField}</div>\``. Either use `_esc(userField)` or rebuild via `document.createElement` / `textContent` (see `_updateUserIndicator`).

### Server-side push from a DB trigger → `_do_send_push` helper
Defined in `sql/037`. Every push-firing trigger calls `_do_send_push(target uuid, payload jsonb)`. The helper reads URL / bearer / secret from `_app_settings`. Never inline these in a new trigger — that recreates the nine-site rotation pain that 037 solved.

### Surface auth-lifecycle cleanup in SIGNED_OUT
Anything subscribed during auth (`_subscribeToPlanInvites`, `_subscribeToFriendships`, `_subscribeToNotifications`, `_suggestionsChannel` for admins) MUST unsubscribe in the SIGNED_OUT branch of `onAuthStateChange`. Same for in-memory caches (`_adminEditsCache`, `_adminSuggestionsCache`, `_adminUsersCache`). Otherwise a previous user's data renders to the next user, or a stale channel re-fires after token expiry.

### Overlay `_cleanup` chain (ui-plan-preview.js)
`openPlanPreview` builds up `st.overlay._cleanup = () => { ... }` across multiple wiring sites (FTS scrubber, `timeFromEl`, outside-tap, later-strip outside-click). Each new wiring must CHAIN the existing cleanup, not overwrite it:

```js
const prev = st.overlay._cleanup;
st.overlay._cleanup = () => { try { prev?.(); } catch {} myCleanup(); };
```

`closePlanPreview` invokes `st.overlay._cleanup()`. Skip the chain and listeners leak across every preview open/close — caught in the audit (finding 2c-1).

### Friendship row direction
`friendships.user_id` is the **requester**, `friend_id` is the **recipient**. `notify_friend_request` and the RLS in `sql/036` both depend on this. When inserting from a recipient-side share-link consume, the recipient is `user_id` and the original sender is `friend_id` (the recipient is requesting that the existing user accept). All happy-path inserts that aren't through the `request_friend_by_email` or `consume_friend_invite_token` RPCs must land at `status='pending'`.

### Bell row IDs ↔ OS push tags
Two namespaces, same underlying events:

| Bell `notif_id` format | OS push tag format |
|------------------------|--------------------|
| `plan_invite_pending:<invite_id>` | `social_plan_invite_<invite_id>` |
| `plan_invite_accepted:<plan_id>` | `social_plan_response_accepted_<plan_id>` |
| `plan_invite_declined:<plan_id>` | `social_plan_response_declined_<plan_id>` |
| `friend_request:<friendship_id>` | `social_friend_request_<friendship_id>` |

`pushTagForBellId` (in `push.js`) maps between them. When you add a new notif type that fires both, follow this prefix-swap pattern and extend the helper — don't invent a third id format.

### Cache-bust constants
Every JS file edit MUST bump:
1. `?v=<token>` for that file in `index.html`.
2. `CACHE_VERSION` in `sw.js` if any file in the SW pre-cache list changed (i.e. anything in `index.html`'s critical path including `index.html` itself).

Convention: `?v=20260518a` (date + per-day letter). The SW `CACHE_VERSION` follows `2026-05-18a` style. There is no automated check — forgetting either ships stale.

### Probe-once for tables that might not exist
`_checkPendingEditsTable` in `auth.js` is the template: probe once, cache the boolean, gate every caller on the probe. Users see ONE network 404 per session instead of N. Re-enabling the feature is then a CREATE TABLE migration + a page reload.

### Use `.maybeSingle()` not `.single()` for first-time-user rows
`user_preferences`, `profiles.locale`, etc. — anywhere a row may not exist for a brand-new user, `.single()` returns 406. `.maybeSingle()` returns `{ data: null, error: null }` and falls through naturally.

## Anti-patterns to avoid

Caught and fixed in the cleanup pass — don't reintroduce.

- **No more monkeypatched `_notifShow`**. Notification show/record/onShow is inline in the base function (`notifications.js`). Don't override it at module top-level.
- **No silent `.catch()` on user-visible writes**. `respondToPlanInvite`, `_bellMarkRead`, `_bellNoteOpened`, `notif.action()` — failures must `console.warn` (minimum) so RSVP / inbox desync is observable.
- **No `console.log` in production paths**. `console.warn` for real aborts is fine. Strip plain `console.log` before commit — the cleanup pass removed 13+ from `notifications.js` and several from `app.js`.
- **No copy-pasted timer / action invocation in `notifications.js`**. `_notifStartAutoDismissTimer` and `_notifInvokeAction` are the canonical helpers; reuse them.
- **No recursive `_notifAdvance`**. The queue is a bounded loop now. Recursion can blow the stack when P0 + P1 + retries pile up.
- **No eager-insert to mint a row ID**. The orphan-plans bug (`ui-detail.js` invite sheet pre-inserting placeholder `plans` rows) created drift between client and DB and fired ghost reminders. Mint the ID client-side (UUID) or defer the operation that needs it until the real insert.
- **No re-introducing `COMPAT_STEM_H` or sprite padding hacks in `render-pins.js`**. The sprite system it compensated for no longer exists; the 14 px hit-test shift it caused was the worst kind of phantom-zone bug.
- **No client-side `SELECT(email)` from `profiles`**. Use `request_friend_by_email(p_email)` (`sql/038`). Once `sql/039` ships, the column isn't readable anyway.
- **No new push trigger inlining the bearer token or URL.** Route through `_do_send_push`. (See pattern above.)
- **No floating-hour dedupe keys with `toFixed(2)`**. Use minute-resolution; the `0.005` margin at `toFixed(2)` is a real collision risk for sun-alert dedup.

## Constants worth knowing

| Constant | Location | Meaning |
|----------|----------|---------|
| `_NOTIF_GRACE_PERIOD` | `notifications.js:5+` | 4 s post-boot suppression for ambient toasts. P0 + `urgent:true` bypass. |
| `_NOTIF_EARLY_WINDOW` | `notifications.js:5+` | 30 s post-boot window allowing only 1 ambient toast. Same bypass. |
| `CACHE_VERSION` | `sw.js` | Service worker pre-cache version; bump on every CSS/HTML/JS edit landing on the SW critical path. |
| `SUPABASE_ANON_KEY` | `js/auth.js` | Anon JWT. Rotate via the 3-step procedure in "Backend (Supabase) → Rotating the Supabase anon key". |
| `VAPID_PUBLIC_KEY` | `js/push.js` | If empty, push toggle hides. Must match the private key in the `send-push` edge function's `VAPID_PRIVATE_KEY` secret. |
| `MAPBOX_TOKEN_WEB` / `MAPBOX_TOKEN_NATIVE` | `js/config.js` | Two-token branch. Web token is URL-restricted to findshades.app; native is unrestricted (Capacitor referer is `capacitor://localhost` / `https://localhost`, which Mapbox's URL allowlist rejects). |
| `PUSH_TRIGGER_SECRET` | edge function env + `_app_settings.send_push_secret` | Constant-time-compared in the edge function to gate trigger-originated push. Rotate via the 3-step procedure in "Rotating the trigger secret". |

## Invariants introduced by the cleanup

- **`plans` set-once columns are immutable post-INSERT**. `sql/040` BEFORE UPDATE trigger blocks writes to `id`, `creator_id`, `venue_id`, `venue_name`, `planned_at`, `created_at`. Mutable set: `cancelled_at`, `reminder_sent_at`, `message`. Don't try to "fix" a typo by `UPDATE`-ing planned_at — soft-cancel and create a new plan.
- **`plan_invites` accept/decline is rejected when parent plan is cancelled** (`sql/034`). Client should still send the response — the trigger will reject and return an error the UI should surface (already wired in `ui-plan-preview.js`).
- **`friendships` recipient-side INSERT is restricted to `status='pending'`** (`sql/036`). To go straight to accepted, the recipient must consume a `friend_invite_token` via the RPC (`sql/041`).
- **`profiles.email` is not selectable from the client** (once `sql/039` is un-HOLD'd). The only resolution path is `request_friend_by_email`.
- **`notifications` rows older than 30 days are deleted nightly** (`sql/031`). Don't build features that assume long-term inbox retention.
- **`process_plan_reminders` skips plans with NULL `venue_name`** (`sql/042`). Any code that inserts to `plans` without `venue_name` won't fire reminders. The denormalization is load-bearing.
- **Capacitor `pushIsAvailable()` returns false**. iOS PWA push needs a native APN bridge that isn't wired yet. Don't gate features on `Notification` / `PushManager` symbols inside the WebView — they're present but non-functional.
