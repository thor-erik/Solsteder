# Solsteder · Information Architecture Review

A strategic look at what screens/features exist, their value, and what should change before the polish pass. Companion to `redesign-plan.md`. Polish work for any surface flagged here is gated on the IA decisions below.

---

## Executive summary

Solsteder is a **utility-first sun-finder for Oslo** with secondary social/contribution layers grafted on. The core flow (open app → see sun pins on map → read list → tap venue → directions) is solid and covers the use case. The grafted layers — invitations, plans, edit/contributor mode, admin review — vary in fit.

**The IA is mostly right; complexity is concentrated in three places:**
1. **Top-of-screen real estate** is over-loaded (search bar, date chip, weather chip, sort dropdown, profile button, intent pills, time slider, sun arc, weather strip — all competing).
2. **Social features are half-built**: invite-a-friend exists, group plans partly exist, no clear "list of my plans" surface, notifications fire but feel disconnected.
3. **Edit / admin / contributor flows are present but discoverable only by URL or by being granted a role** — they're "in the codebase" more than "in the product."

**Recommended IA changes** (detail below):
- ✂ **Cut** the `#review-mode-indicator` UI from the default app shell (move behind a flag) — admin tooling shouldn't ship in the user-facing chrome.
- 🔀 **Consolidate** the top-of-screen toolbar (search · date · weather · sort · profile · time slider) into a clearer two-row hierarchy.
- 📦 **Promote** "saved venues" as a real feature (currently absent; users have no way to revisit).
- 📦 **Promote** "my plans" as a real surface (invitations exist but users can't see their plan list).
- 🪞 **Consolidate** edit/suggest/admin flows into a single "Contributor mode" with a clear entry point (long-press or settings gear → "Bidra med data").
- ⏸ **Defer** wind-shelter visualization promotion until usage data justifies the screen real estate (currently in `ui-shelter.js` + `render-wind.js`; visible but feels niche).
- ✅ **Keep** the core map + list + detail + time-picker flow as the spine. Don't reshape it.

---

## Current screen / feature inventory

### Top-level navigation surfaces

| Surface | Entry | Notes | Tier |
|---|---|---|---|
| **Map** | Default view | The world. Sun pins drawn on top via canvas overlay. | 0 |
| **Venue list panel** (`#panel`) | Always-visible peek; tap/swipe to expand | Slide-up sheet with venue cards. Primary content surface. | 1 |
| **Detail panel** (`#detail-panel`) | Tap pin or list card | Full venue info, action CTAs. | 1 |
| **Search** (`#floating-search` + `#search-dropdown`) | Top of screen always visible | Searches venues + areas. | 1 |
| **Profile / account** (`#profile-panel`) | Profile button (top-right) | Avatar, settings, login state, signout. Doubles as login when logged out. | 1 |
| **Time picker / FTS** (`#fts`) | Always visible at bottom | Scrub through the day. Canvas-drawn weather bar + thumb. | mixed |
| **Date calendar** (`#date-calendar`) | Tap date chip | Pick another day; updates time picker context. | 1 |
| **Sort menu** (`#sort-panel`) | Tap "Mest sol" sort label | Switch between sort orders (best match / distance / sun). | 1 |
| **Sun compass** (`#sun-compass`) | Always-visible top | Ambient sun-position indicator. | 0 |
| **Weather strip / chip** | Always-visible top | Current weather. | 0 |

### Secondary flows

| Surface | Entry | Notes | Tier |
|---|---|---|---|
| **Invite sheet** (`.dpinvite-*`) | "Invite friends" CTA on detail panel | Friend grid, recent search, send invitation. | 1 |
| **Plan preview** (`ui-plan-preview.js`) | Following an invite link | Confirms a planned hangout. | 1 |
| **Plan-conflict modal** | When inviting near another plan time | Three-CTA decision (merge / send separate / cancel). | 1 |
| **Notification toast** (`#notif-toast`) | Friend events / social / login / sun-state changes | Slide-in transient. | 1 |
| **Wind shelter diagram** (`ui-shelter.js` + `render-wind.js`) | Detail panel section (when applicable) | Isometric building diagram showing wind protection. Niche. | 2 |

### Edit / contributor / admin (currently visible to all logged-in users)

| Surface | Entry | Notes |
|---|---|---|
| **Edit overlay** (`#edit-overlay`) | URL `?edit=…` or "Rediger informasjon" link in detail | Wall-selection + polygon editor for terrace location. |
| **Edit type dropdown** (`#edit-type-dropdown`) | Inside edit overlay | Switch terrace type (street/courtyard/detached). |
| **Suggestion review** (`admin-review.js`) | URL `?review=1` | Approve/reject venue suggestions. |
| **Review mode indicator** (`#review-mode-indicator`) | Always visible when in review mode | Admin chrome that ships in user code. |

### Onboarding / first-time

| Surface | Entry | Notes |
|---|---|---|
| **Login splash** (`#profile-panel.logged-out`) | First open or profile-tap when logged out | Hero + carousel + auth buttons. |
| **Login carousel** (`login-carousel.js`) | Inside splash | Marketing slides explaining sun-finding. |
| **Onboarding overlay** | Probably present somewhere | Need to verify first-time tooltips actually work. |

### Map-overlaid UI

| Surface | Notes |
|---|---|
| `#hover-tooltip` | Hover info on pins (desktop only). |
| `#map-toast` | Brief map-level feedback messages. |
| `#splash` | Initial app loading. |
| `#user-location-dot` | Standard "you are here" dot. |
| `#locate-btn` | Recenter to user. |
| `#zoom-jog` | Zoom/heading reset. |
| `#floating-brand` | Logo. |
| `#floating-bottom` | Container for bottom UI (date, time, intent pills) — currently `display: none` suggests it was a previous design that's now hidden. |
| `#floating-date` | Bottom date controls. |
| `#panel-reveal-btn` | "›" button to re-show panel after dismiss. |
| `#no-sun-banner` | Banner shown when no sun anywhere. |

### Found in code but unclear status

| Item | Status | Question |
|---|---|---|
| `#floating-bottom` | `display: none` | Dead code or feature-flag-disabled? |
| `#wx-now` | `display: none !important` | Removed feature; should clean up. |
| `.social-btns` | `display: none` | Removed feature; should clean up. |
| `time-range-wrap` | `display: none` | Time-range selection — never finished? |

---

## Per-area assessment

### ✅ Core: solid as-is

**Map + Pin pills + Venue list + Detail panel + Time picker** — these are the spine. They work. Polish is what they need (Phase A/B/C of `redesign-plan.md`), not restructure. Keep.

The **time picker (FTS)** specifically is well-designed: the slider IS the temporal cursor, scrubbing it updates the map and list in real-time. This is the differentiating UX of the product. Don't touch the structural design; only polish (Phase A item #8).

### ⚠ Top-of-screen real estate is overloaded

Currently visible at the top:
1. Search bar (`#floating-search`)
2. Profile button (right edge of search bar)
3. Floating brand logo (`#floating-brand`)
4. Sun compass (`#sun-compass`)
5. Weather chip / date chip (`#date-display-btn` + `#date-wx-strip` + `#wx-now`)
6. Sort dropdown (`#sort-toggle-btn`)
7. Intent shortcuts / area filter (in panel header)
8. Time picker at bottom (`#fts`)

Plus on a tap-to-detail: detail panel slides up, occluding lower part.

**Issue:** "Best match" sort / "Sun at HH:MM — N places in the sun" / date / weather / search all visually compete in the upper portion. Users have to scan multiple elements to orient.

**Proposal:**
- **Row 1 (search row):** search bar + profile button. Already what we have. Keep.
- **Row 2 (context row):** date · weather · sort. Tightly coupled. Currently split between top of map (date+weather chips) and top of list (sort).
- **Time slider** stays at bottom (it's a primary input, not chrome).
- **Sun compass** could be smaller / moved into the date+weather row as a single "sun position" glyph.
- **Floating brand logo** could only show on first-time / map-only states; hide when panel is expanded.

**Concrete IA change:** consolidate `#date-display-btn` + `#date-wx-strip` + `#wx-now` + `#sun-compass` + sort into ONE "context strip" component. Picks up Phase A items #4 (list header) and the broader top-strip cohesion.

### ⚠ Social features are half-built

What exists:
- `#invite-friends` button on detail panel
- `dpinvite-*` sheet for selecting friends + sending
- Plan preview when receiving an invite (`ui-plan-preview.js`)
- Plan conflict modal

What's missing:
- **No "my plans" list.** A user invited to plan A and plan B can't see them in one place.
- **No plan history.** Past plans vanish.
- **No group plan management.** Once an invite is sent, organizers can't track who responded except via notifications.

**Decision needed:** Is the social/plans system a real shipping feature, or experimental?

If shipping: needs at minimum a "My plans" surface (entry point likely from profile panel) — proposed as new Phase 0.5 item.
If experimental: gate behind a flag, don't polish it.

### ⚠ Edit / contributor / admin flows have wrong default exposure

Currently:
- `#edit-overlay` is in the live DOM, hidden by `display: none` until activated by URL param or specific user role
- `admin-review.js` is loaded for everyone but only activates with `?review=1`
- `#review-mode-indicator` is in the user-facing app chrome

**Issue:** these are contributor-tier features cluttering the production codebase + shipping with the user app. They add weight (~hundreds of lines of CSS), increase footprint, and introduce a risk surface (a wrong code path could expose admin actions).

**Proposal:**
- **Move `#review-mode-indicator` and `#edit-overlay` into a separate JS module** that's lazy-loaded only when the URL flag or role is present. Keeps the default user experience cleaner.
- **Single contributor entry point:** if a contributor wants to edit data, they enter via Settings → "Bidra med data" → unlocks edit mode. Removes the "URL hack" entry.
- **Don't polish these as part of the redesign work** unless we decide the contributor flow is a first-class feature. P3 in the redesign plan.

### ⚠ Wind shelter feature is niche

`ui-shelter.js` + `render-wind.js` provide an isometric building visualization showing wind protection at a venue. Smart engineering. But:
- Most users don't think "is this terrace wind-protected" before going there
- Real-time wind data is shown anyway in the weather chip
- The visualization takes meaningful screen real estate in the detail panel when active

**Decision needed:** does this earn its space? Two paths:
- **A. Demote** to a small inline badge ("Le for vind ✓" or "Vindutsatt") — lose the diagram, keep the signal
- **B. Promote** to a more prominent treatment — make wind-protection a hero filter ("only show sheltered terraces")
- **C. Cut** — remove the feature entirely if usage is low

I'd lean A unless analytics show users opening the diagram. Worth checking.

### ⚠ Onboarding is unclear

The login splash is the "introduction" for new users. Beyond that — is there a first-time tutorial? Hover hints? Empty-state guidance? I don't see one explicitly defined.

**Proposal:** Define a 2-3 step onboarding overlay that fires on first map view (after auth):
1. "Tap a pin to see venue details"
2. "Drag the slider to scrub through the day"
3. "Sort or filter to find your spot"

Currently P3 in the redesign plan; might warrant promoting to P2 if the current state is genuinely missing.

### ✂ Dead code to remove

`display: none` is used as soft-deletion in several places. Cleanup candidates:
- `#wx-now` — `display: none !important`. Was a "current weather card" that's been superseded.
- `.social-btns` — `display: none`. Comment says "no longer renders them. Safe to remove if nothing else references."
- `#floating-bottom` — `display: none` in default state. Either remove or bring back.
- `time-range-wrap` — `display: none`. Time-range selection — abandoned?

Action: do a sweep, confirm none-of-them are referenced from JS, delete with prejudice. ~30 min cleanup that reduces footprint.

---

## Identified gaps (features that don't exist but probably should)

### 1. Saved / favorited venues
Current: no way for a user to mark a venue as "interested" and revisit it.
Cost: medium — needs a new surface (saved list), a toggle UI in detail panel, persistence.
Value: high — core utility for repeat users ("I'll come back to that café tomorrow when it's sunny").
**Recommendation:** include in IA scope. Surface = "Lagrede steder" tab in profile or as a list toggle.

### 2. My plans (list view)
Current: invites/plans exist but there's no collected view of "plans I'm in."
Cost: low-medium — new section in profile panel listing all plans (past/present).
Value: high if social is a shipping feature.
**Recommendation:** required if social ships, not needed if social is experimental.

### 3. Sun-state notifications
Current: `notifications.js` exists, fires for friend events. No notifications for "your saved venue is sunny right now."
Cost: medium — needs background scheduling + push (per `project_app_store` memory, push is planned).
Value: very high for engagement post-app-store-launch.
**Recommendation:** scope into the app store launch plan, not this redesign.

### 4. Map filter chips visible at all times
Current: filters live in the panel header. Filtering requires opening the panel.
Cost: low-medium — promote intent shortcuts to map-overlaid chips.
Value: medium — enables faster filter tweaks while staying on map view.
**Recommendation:** consider during Phase A item #4 (list header consolidation).

---

## Recommended IA changes (prioritized)

### Must (block redesign polish until decided)

1. **Decide on social/plans status: shipping vs experimental.** If shipping, "My plans" must exist before polish work on the invite sheet starts. Else gate it behind a flag.
2. **Decide on wind-shelter feature: keep diagram / demote to badge / cut.** Drives whether we polish it or not.
3. **Decide on contributor/admin flows: keep visible / lazy-load / hide.** Drives whether we polish them.

### Should (do during redesign window)

4. **Consolidate top-of-screen real estate** — picks up Phase A item #4 with broader scope.
5. **Add "saved venues" feature** — small new surface, high utility value.
6. **Sweep dead `display: none` code** — 30 min cleanup, reduces footprint.

### Could (post-redesign)

7. **Add "my plans" list view** if social is shipping.
8. **Promote map-overlaid filter chips** for faster filtering.
9. **Tighten onboarding** — define a 2-3 step first-run guide.
10. **Plan sun-state notifications for the app-store launch** — separate workstream.

---

## App store readiness considerations

Per `project_app_store.md` memory, app store release (Google Play + Apple App Store) is planned. Implications for IA:

- **Push notifications** — coming. Needs design slot for notification settings in profile panel.
- **iOS-specific UI patterns** — swipe-down to dismiss, large titles, bottom-sheet modals. Detail panel already aligns. Verify each of: sort menu, profile panel, invite sheet aligns with iOS patterns.
- **Account creation friction** — magic-link email auth is friction-light; Apple sign-in is required by Apple if Google sign-in is offered. Verify all three present and styled consistently.
- **Empty/no-permission states** — location-permission-denied is the most common; design now.
- **Offline state** — map still works offline (Mapbox cached); venue data needs handling.

These are NOT IA changes per se but inform priority — surfaces visible during app-store demo (login splash, first-screen, profile, detail panel) get bumped up in polish priority.

---

## Decisions needed from user

Three blocking questions before Phase B/C:

1. **Social/plans:** ship or experiment?
2. **Wind shelter:** keep diagram, demote, or cut?
3. **Contributor/admin flows:** lazy-load + single entry point, or status quo?

Two non-blocking but useful:

4. **Saved venues:** add now or defer?
5. **App-store launch timing** — affects polish-priority weighting.

Once these are answered, the redesign-plan.md priorities lock in and Phase B/C can proceed without rework.

---

## What this IA review does NOT change

The **core map + list + detail + time-picker spine is correct**. Phase A polish work (weather palette, card timeline, search bar, list header, pin pills, detail panel header, time picker) is safe to proceed concurrently with this IA review. None of those surfaces are flagged for restructuring above.
