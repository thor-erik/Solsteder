# Cleanup Log

Audit / triage / fix pass covering the store-prep window. Commit range
`042c955..ef0e313` (2026-05-18). Three review tracks: 2a Store-readiness,
2b Security, 2c Engineering. Each finding lists severity, category,
decision, and either the fixing SHA or a reason for the deferral.

Legend:
- **Severity:** P0 (blocks store release / data exposure) · P1 (functional
  regression / clear bug) · P2 (hygiene / noise).
- **Decision:** ✅ fixed · ⏸ deferred · 🚫 wontfix.

---

## Review 2a — Store-readiness

| # | Severity | Category | Finding | Decision | Commit |
|---|----------|----------|---------|----------|--------|
| 2a-1 | P0 | iOS | `Info.plist` missing `NSLocationWhenInUseUsageDescription`. Apple rejects any submission that touches `navigator.geolocation` without it. | ✅ | `4a0379a` |
| 2a-2 | P0 | iOS | `Info.plist` missing `ITSAppUsesNonExemptEncryption=false` — submission stalls on the export-compliance dialog. | ✅ | `4a0379a` |
| 2a-3 | P0 | iOS | `UIRequiredDeviceCapabilities=armv7` — modern submissions require `arm64`. | ✅ | `4a0379a` |
| 2a-4 | P0 | iOS | `PrivacyInfo.xcprivacy` missing — Apple rejects via ITMS-91053 since 2024-05-01. Need declarations for `UserDefaults` / `FileTimestamp` / `SystemBootTime` (WKWebView internals) + 7 collected data types. | ✅ | `4a0379a` |
| 2a-5 | P0 | Android | `AndroidManifest.xml` missing `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` / `POST_NOTIFICATIONS` (Android 13+) — geolocation silently denied. | ✅ | `4a0379a` |
| 2a-6 | P0 | Android | `allowBackup=true` exposed Supabase auth tokens via `adb backup` and device-to-device transfer. | ✅ `allowBackup=false` + `data_extraction_rules.xml` excludes every domain. | `4a0379a` |
| 2a-7 | P0 | Mapbox | Single URL-restricted token can't serve the Capacitor WebView — referer is `capacitor://localhost` (iOS) or `https://localhost` (Android), which Mapbox dashboard rejects as a URL allowlist entry. | ✅ Two-token runtime branch: `Capacitor.isNativePlatform() ? MAPBOX_TOKEN_NATIVE : MAPBOX_TOKEN_WEB`. | `ef0e313` |
| 2a-8 | P1 | Build | `npm run build` cp list missed `sw.js`, `terms.html`, `favicon*.png`, all `apple-touch-icon-*.png`. The Capacitor WebView 404'd them on cold load. | ✅ Extended cp list + new `cap-sync-check.yml` CI to verify www/ matches root by content hash. | `4a0379a` |
| 2a-9 | P1 | SW | Service worker registration was gated behind the push opt-in path — offline support + `CACHE_VERSION` rollover only kicked in for users who'd enabled push. | ✅ `index.html` now registers `/sw.js` at boot (HTTPS-only guard). | `4a0379a` |
| 2a-10 | P1 | Push | `pushIsAvailable()` returned true inside the Capacitor WebView; `Notification` + `PushManager` symbols exist but the WebView has no push entitlement, so subscriptions succeeded silently and never delivered. | ✅ Hide push toggle on native builds until native APN/FCM is wired up. | `4a0379a` |
| 2a-11 | P1 | Privacy | `privacy.html` predated the friends graph, plans, check-ins, push, and analytics expansion. | ✅ Rewritten to itemize every Supabase table + every analytics event category + third-party services + check-in 3 h auto-expire. | `4a0379a` |
| 2a-12 | P2 | Secrets | `GOOGLE_PLACES_KEY` checked in as a real value (Places traffic actually goes through `functions/api/` Cloudflare proxies). | ✅ Replaced with a non-empty sentinel so `if (!GOOGLE_PLACES_KEY)` gates still evaluate. | `ef0e313` |
| 2a-13 | P2 | Secrets | Mapbox tokens carried unused scopes (`datasets:read`, `vision:read`). | ✅ Scopes trimmed in Mapbox dashboard. | `ef0e313` |

---

## Review 2b — Security

| # | Severity | Category | Finding | Decision | Commit |
|---|----------|----------|---------|----------|--------|
| 2b-C1 | P0 | Edge fn | `send-push` edge function had no real auth gate — was relying on the anon JWT bearer in trigger calls. Anyone who knew the URL + had the anon key could fire arbitrary pushes to any `user_id`. | ✅ Edge function rewritten: constant-time `X-Push-Secret` check, UUID validation on `user_id`, same-origin URL validation, payload size cap. | `a2392b6` |
| 2b-C2 | P0 | RLS | Friendship enumeration — recipient-side INSERT at `status='accepted'` let anyone with a victim's UUID force a friendship without consent. | ✅ `sql/036` tightened: recipient-side INSERT restricted to `status='pending'` (auth.uid()=friend_id implies pending). Re-enabled 1-click share-link UX with `sql/041` token RPC (single-use, 30 d TTL). | `a2392b6`, `47667f2` |
| 2b-C3 | P0 | XSS | Client-side innerHTML interpolations of OAuth-supplied name / avatar_url / venue_name / inviter name / friendship IDs. Self-XSS via attacker-controlled OAuth display name. | ✅ Added `_esc` + `_escAllowStrong` helpers in `auth.js`; rewrote `_updateUserIndicator` avatar build to use DOM APIs; applied across every interpolation site. | `616d763` |
| 2b-C4 | P0 | XSS | Server-rendered notification `body` was injected via `innerHTML`. SQL triggers wrap names in `<strong>` — needed to preserve emphasis without admitting `<script>` or `<img onerror>`. | ✅ `_escAllowStrong` keeps `<strong>...</strong>` and neutralises everything else. | `616d763` |
| 2b-C5 | P1 | Profile leak | `profiles.email` was SELECT-able by anon + authenticated — anyone could enumerate emails by UID. | ✅ `sql/038` `request_friend_by_email` SECURITY DEFINER RPC + client switched to it. `sql/039` REVOKE shipped as `-HOLD` suffix (see deferred below). | `a2392b6`, `616d763` |
| 2b-S1 | P1 | DoS | `events` table had no per-row size cap → analytics insert can be weaponised to bloat the table. | ✅ `sql/035` CHECK constraints `events_event_length` + `events_properties_size` (NOT VALID, then validated). | `a2392b6` |
| 2b-S2 | P1 | Auth lifecycle | Admin realtime channel (`_suggestionsChannel`) stayed live across sign-out / re-auth as a non-admin. Admin caches (`_adminEditsCache`, `_adminSuggestionsCache`, `_adminUsersCache`) persisted to the next user. | ✅ Unsubscribe + cache wipe in SIGNED_OUT branch of `onAuthStateChange`. | `9ee3ce9`, `616d763` |
| 2b-S3 | P1 | SW | `notificationclick` opened/navigated to whatever `targetUrl` the push payload carried — stale or attacker-crafted pushes could redirect to an off-origin URL. | ✅ Resolve through `new URL(...)` and only `openWindow` / `navigate` when same-origin. Defense in depth — edge function already validates URLs at delivery, but the SW can outlive that gate via cached/queued notifications. | `616d763` |
| 2b-S5 | P1 | Ops | Rotating the anon JWT required re-running nine SQL files (each push trigger inlined the bearer). | ✅ `sql/037` centralizes bearer + URL + secret in `_app_settings` (RLS deny-all); all six push triggers now call `_do_send_push(target, payload)` helper. Rotation is now: edit `js/auth.js`, one `UPDATE _app_settings`, bump cache-bust. | `a2392b6` |
| 2b-S6 | P1 | RLS | `plans` row was fully mutable by the creator after invitees accepted — could swap venue, time, or even creator_id post-acceptance. | ✅ `sql/040` BEFORE UPDATE trigger blocks writes to `id` / `creator_id` / `venue_id` / `venue_name` / `planned_at` / `created_at`. Mutable set: `cancelled_at`, `reminder_sent_at`, `message`. | `616d763` |
| 2b-S7 | P1 | RLS | Share-link recipient inserted at `status='accepted'` with row direction `user_id=sender, friend_id=me`. Misaligned with sql/036 (recipient side must be pending) and `notify_friend_request` trigger (which fires on inserts with `user_id=requester`). | ✅ Flip direction so `user_id=me, friend_id=sender, status='pending'`. Two sites fixed: share-link path in `auth.js` `_autoFriendInviter`, and the live path in `app.js` `_tryFriendInvite`. | `616d763`, `f9914bb` |
| 2b-S8 | P2 | Repo hygiene | `www/` (Capacitor build output) was checked in and ~3 weeks stale; size inversions vs root confirmed it as a dead fork. `supabase/.temp/` (CLI state) also tracked. | ✅ Both gitignored; 74 k lines of dead files removed. | `042c955` |
| 2b-S9 | ⏸ | Profile leak | `sql/039` (REVOKE SELECT(email) on profiles for anon/authenticated). | ⏸ Deferred — file shipped with `-HOLD` suffix so a wildcard apply skips it. Rename to drop `-HOLD` only after confirming every client path uses the `request_friend_by_email` RPC in production. The client switch shipped in `616d763`; the rename is gated on a confidence window. | — |

---

## Review 2c — Engineering

| # | Severity | Category | Finding | Decision | Commit |
|---|----------|----------|---------|----------|--------|
| 2c-1 | P1 | Leak | `ui-plan-preview.js` — `st.overlay._cleanup` was assigned in two places but never invoked. FTS / `timeFromEl` / outside-tap listeners leaked across every preview open/close. | ✅ `closePlanPreview` now calls `_cleanup`. Cleanup overwrite bug at line ~1318 fixed by chaining instead of clobbering. `laterStrip` outside-click chained in. | `9ee3ce9` |
| 2c-2 | P1 | Silent failure | `ui-plan-preview.js` `respondToPlanInvite` swallowed errors → silent RSVP desync was a real risk. | ✅ Surfaced via `console.warn` + toast. | `9ee3ce9` |
| 2c-3 | P1 | UX hit-test | `render-pins.js` `COMPAT_STEM_H = 14` was added to sprite cssH/anchorY for a sprite system that no longer exists. Hit-test rect math shifted the entire hit zone UP by 14 px → tail tip unclickable, phantom 14 px hit zone above the pill. | ✅ Removed `COMPAT_STEM_H` entirely; stripped unused `extraStem:0` from all five `layout.push` sites. | `9ee3ce9` |
| 2c-4 | P1 | Silent failure | `render-pins.js` `classifyPin` / `draw()` catches silently demoted to context tier on error — hid real bugs in `computeSunWindows`. | ✅ Log before fallback. | `9ee3ce9` |
| 2c-5 | P1 | Dedup | `notifications.js` sun-alert dedupe key used `toFixed(2)` on hour — collisions possible at minute boundaries. | ✅ Minute-resolution. | `9ee3ce9` |
| 2c-6 | P1 | Stack risk | `notifications.js` `_notifAdvance` was recursive — unbounded if the queue ever grew (P0 + P1 + retries). | ✅ Bounded loop. | `9ee3ce9` |
| 2c-7 | P2 | Dup code | `notifications.js` — `_notifStartAutoDismissTimer` and `_notifInvokeAction` were copy-pasted 3×. | ✅ Extracted. | `9ee3ce9` |
| 2c-8 | P2 | Architecture | `notifications.js` `_notifShow` was monkeypatched to call `_onShow` + `_bellRecord`. | ✅ Inlined into the base function — no more runtime override. | `9ee3ce9` |
| 2c-9 | P2 | Silent failure | `notifications.js` — `notif.action()` invocations and `_onShow` errors silently ignored. | ✅ try/catch + log. | `9ee3ce9` |
| 2c-10 | P2 | Noise | `notifications.js` shipped with 13+ production `console.log` lines. `app.js` shipped with `[exitToExplore]` and `[suggestVenueFlow]` debug logs. | ✅ Stripped (kept `console.warn` where it signals a real abort). | `9ee3ce9` |
| 2c-11 | P2 | Silent failure | `auth.js` `_bellNoteOpened` silent catch on mark-as-read failure. | ✅ `console.warn`. | `9ee3ce9` |
| 2c-12 | P1 | Bell render | `_renderBellDropdown` built entries with `{ t, html }` — no `id` field. The downstream DOM-diff used `entry.id` → all rows collapsed to one `undefined` bucket → only the **oldest** row was shown. Pre-existing since `9a839e1`. | ✅ Both `entries.push` sites now include `id` (synthetic for friend-requests, server `notif_id` for notif rows). | `a225fee` |
| 2c-13 | P1 | UX | Push toast for incoming plan-invite never fired — no eval rule existed. Toast for accept/decline never fired again after a localStorage seen-cache from earlier test cycles silently suppressed. | ✅ New `_evalIncomingPlanInvite` (P0). Accept/decline evaluators rewritten to read dedupe from `_bellHistory.get(notif_id).readAt`; localStorage seen-map dropped. | `eccc798` |
| 2c-14 | P1 | UX | Event-driven social toasts (incoming invite, accept, decline, friend request) were P1 alongside ambient observations — queued behind whichever ambient toast fired first. | ✅ Bumped to P0; preemption logic in `_notifEvaluate` swaps current toast on P0 arrival. | `40a4ce2` |
| 2c-15 | P1 | UX | After P0 bump, toasts still took several seconds to appear: rate-limit gates (`_NOTIF_GRACE_PERIOD=4s`, `_NOTIF_EARLY_WINDOW=30s` allowing 1 toast) suppressed push-tap event-driven socials. The evaluator only ran on 8 s setTimeout / 60 s interval / Realtime events — cold-open path via `onAuthStateChange` didn't trigger eval. | ✅ Added `urgent: true` flag to the four P0 social evals; `_notifCanShow` bypasses time-based gates when urgent (visual-conflict gates still apply). `onAuthStateChange` now calls `_notifEvaluate` after `loadPlans` on cold-open. | `c3e8a94` |
| 2c-16 | P2 | UX | OS push remained in the notification center after the user dealt with it in-app. | ✅ `pushDismissTag` + `pushTagForBellId` map bell row IDs to OS push tags; `_bellMarkRead` and `_bellNoteOpened` close the OS push via SW `registration.getNotifications`. | `c3e8a94` |
| 2c-17 | P1 | UX latency | Realtime subscription handlers and the 60 s social poll only refreshed data (`loadPlans` / `loadFriends`) but never triggered the notif evaluator — so fresh invites lagged by up to 60 s. | ✅ Eval-after-load wired into both Realtime handlers and `_socialPollTick` (Promise.all + single eval). | `3c491f6` |
| 2c-18 | P1 | Console noise | First-time users with no `user_preferences` row saw `.single()` 406 on every load. `pending_edits` table doesn't exist → admin paths 404'd repeatedly. | ✅ `.single()` → `.maybeSingle()` on user prefs. New `_checkPendingEditsTable` probe caches result so users see ONE 404 per session instead of many; admin paths gated on the probe. | `f4a51e5` |
| 2c-19 | P1 | Data integrity | The invite-sheet eagerly INSERTed a placeholder plan to get a `plan_id` for the share-link token. `createPlan()` then INSERTed a second real plan. Test runs accumulated ~10 orphan rows. The cron reminder fired "Planen din på et sted starter om 30 min" for orphans (et sted = COALESCE fallback). | ✅ Drop eager-insert; `_planId` stays null until createPlan runs (share-link token handles null gracefully). Defense in depth: `sql/042` makes `process_plan_reminders` skip plans WHERE `venue_name IS NULL`. | `ff8cc62` |
| 2c-20 | P2 | UX | Toast wrapper overlapped #top-strip when `#detail-panel.open`. | ✅ Removed `detail-panel.open` from the `top:12px` CSS rule — default mobile position keeps it below the strip. | `ff8cc62` |
| 2c-21 | 🚫 | — | Most `ui-detail.js` findings | 🚫 wontfix — didn't pan out on second look (false positives from the static audit). | — |
| 2c-22 | 🚫 | — | `app.js` `nowInterval` / `FTS-appstart` re-entry concerns | 🚫 wontfix — didn't pan out; init runs once. | — |
| 2c-23 | 🚫 | — | Window-resize re-entry concern | 🚫 wontfix — init runs once. | — |
