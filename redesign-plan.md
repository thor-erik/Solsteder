# Solsteder · Redesign Audit & Plan

Generated against the new design system (`DESIGN.md` · `system.html`). Each surface is scored against:

- **Tier** — its assigned tier per `DESIGN.md`
- **Status** — ✓ done · ⚠ partial · ✗ needs work
- **Issues** — what's actually wrong
- **Priority** — P0 (frequent + broken) · P1 (frequent OR substantial issues) · P2 (less frequent) · P3 (edge / admin)

The work order at the bottom is by priority. Surfaces marked ✓ are confirmed-good; revisit only if user feedback exposes a regression.

---

## 0 · Information architecture (P0 · concurrent with Phase A)

### Screen / feature inventory
**Status:** ✗ · **Priority:** **P0** · **Effort:** 2 hours

Strategic review — separate from visual polish. Output: `ia-review.md` with current-state map, observations, and proposed restructures (if any). Polishes done downstream of an IA decision are wasted if that surface gets cut/restructured.

**Scope:**
- Catalog every screen/flow currently in the app (map, list, detail, search, sort, filter, time picker, profile, login, invite, plans, edit, admin, onboarding, etc.)
- For each: who uses it, how often, what it costs to maintain, what removing it would cost
- Identify candidates for: removal · merging · splitting · promotion to top-level · demotion to overflow
- Identify gaps: features that should exist but don't (e.g. saved venues list, group plan management surface)
- Phase B/C polish work is **gated on IA decisions** for surfaces that might be restructured

**Out of scope for IA review:**
- New feature design — IA review surfaces gaps, doesn't fill them
- Complete redesigns of confirmed-keep flows (those happen in Phase B/C)

### Feature shipping prioritization
**Status:** ⚠ · **Priority:** P1 · **Effort:** included in IA review
Decisions about which planned/in-progress features ship vs. defer (e.g. push notifications per `project_app_store.md`, app store release timing, etc.) feed into the IA map.

---

## 1 · Map & primary navigation (always visible)

### Map base
**Tier:** 0 · **Status:** ✓ · **Priority:** —
Slate water + warm beige base done. Buildings/roads in warm-grey ramp work cleanly through the lens. No action.

### Sun arc / weather strip (top-of-screen)
**Tier:** 0 · **Status:** ⚠ · **Priority:** **P1**
- Compass canvas uses `TOKENS.accent` so honey is correct
- Weather glyph + temp text needs verify against new palette
- Visual hierarchy: compass + date chip + weather chip + sort all compete in the top zone
**Acceptance:** top strip reads as one calm row; no element shouts; compass dot honey, halo subtle

### Search bar (`#floating-search`)
**Tier:** 1 · **Status:** ⚠ · **Priority:** **P0**
- Currently glass-action style; text input
- Profile button at right edge — fine
- Clear button shows when query present
- Issues: focus state needs honey-border treatment per DESIGN.md; placeholder text contrast against slate translucent backdrop is marginal
**Acceptance:** focus → honey 1px border + subtle inset highlight; placeholder readable; no map content bleeds through to confuse
**Effort:** 30 min

### Pin pills on map (canvas)
**Tier:** 6 · **Status:** ⚠ · **Priority:** **P0**
- `js/render-pins.js` uses `TOKENS.accent` ✓ — honey
- Verify "in sun" hero pin reads as honey; verify shaded/cool pins render appropriately
- Selected pin: confirm ring uses honey accent
- Friend badges, going badges, review badges — all using TOKENS, but visual review needed
- The single live "in sun now" pin should be the privileged ambient — verify
**Acceptance:** pins clearly read as honey when sunny, slate-grey when shaded; selection state distinct; one live drift element
**Effort:** 1 hour (canvas drawing tweaks)

### Locate button (`#locate-btn`)
**Tier:** 3 · **Status:** ⚠ · **Priority:** P2
Simple icon button at bottom-right. Should match Tier 3 spec exactly: `var(--glass-action-bg)` + Tier 3 shadow + hover spotlight.

### Zoom controls (`#zoom-jog`)
**Tier:** 3 · **Status:** ⚠ · **Priority:** P2
Mapbox zoom + heading reset. Same Tier 3 alignment check.

---

## 2 · Venue list panel + cards (P0 — most-seen)

### List panel (`#panel`, slide-up sheet)
**Tier:** 1 · **Status:** ✓ · **Priority:** —
Mirror-sky overlay applied. Slate at 42%. Top sheen. Layered shadow. Done.

### List header (date chip, sort dropdown, "Sun at HH:MM — N places")
**Tier:** mixed · **Status:** ⚠ · **Priority:** **P0**
- Date/weather chip on the left (Tier 3) ✓ ish
- "Best match" sort dropdown trigger (Tier 3) — works
- "Sun at 13:20 — 191 places in the sun" header text — title in cream, count in muted
- Issue: layout is busy; date chip + sort dropdown + count are all competing
- "places in the sun" count text is buried (uses `--muted` slate-grey)
**Acceptance:** clear visual hierarchy; date and sort chips feel like one row; count reads as one informative line
**Effort:** 1.5 hours

### Venue cards (`.venue-card`)
**Tier:** 2 · **Status:** ✓ · **Priority:** —
Modernised silhouette + chromatic + motion stack + opacity-dimmed cream meta text. Done.

### Card pills (`.card-pill.pill-sol/.pill-skygge/.pill-skyer/.pill-regn`)
**Tier:** 5 · **Status:** ⚠ · **Priority:** P1
- Sol pill → honey accent ✓
- Skygge / Skyer / Regn → palette-specific dim/text (verify they all read coherently against the slate cards)
- Operating-hours pills (åpner / stenger): currently neutral cream; verify they don't compete with the status pills
**Acceptance:** four-way status row reads cleanly; honey only on Sol; cool family on cloudy/shade; rain blue distinct
**Effort:** 30 min

### Card timeline (canvas-drawn weather bar at card bottom)
**Tier:** 6 · **Status:** ✗ · **Priority:** **P0**
- `drawTimeline()` in `js/ui-shared.js` uses **hardcoded `#FFAF85` (old coral)** for sun segments — should track `TOKENS.accent` (honey)
- Weather cf-band palette also still in old coral/peach values (`#FFCFAA`, `#FFAF85`) — needs slate-aligned weather palette
- This is the visually loudest element on each card and currently OFF-BRAND
**Acceptance:** sun segments honey; cloud bands cool slate-grey ramp; rain bands slate-blue; subtle enough to not dominate
**Effort:** 2 hours (involves redesigning the weather palette per principle 03 + canvas update)

### List empty state (no venues match filters)
**Tier:** 1 + content · **Status:** ⚠ · **Priority:** P2
Currently text-only "Ingen steder…" message. Should have:
- Centered cream title
- Tier 5 honey badge or Tier 4 reset CTA
- Subtle slate icon
**Acceptance:** empty state feels like a designed moment, not an absence

### List loading state
**Tier:** 1 + content · **Status:** ✗ · **Priority:** P2
Currently raw spinner. Should be skeleton cards (Tier-2 base + slow honey-cream sweep) — applies the lens metaphor to the wait.
**Effort:** 1 hour

---

## 3 · Detail panel (P0)

### Detail panel container (`#detail-panel`)
**Tier:** 1 · **Status:** ✓ · **Priority:** —
Mirror-sky now applied via shared rule. Same as list panel.

### Detail panel header (venue name + photo)
**Tier:** 2 · **Status:** ✗ · **Priority:** **P0**
- Photo placeholder is solid dark blue void when image missing
- Venue name + meta hierarchy similar to list cards but should feel "more important"
- The dp-card containing this should align with Tier 2 spec
**Acceptance:** photo block has skeleton shimmer when loading, soft gradient when no photo; title clearly hierarchically primary
**Effort:** 2 hours

### Detail action card (Vis veibeskrivelse + secondary chips)
**Tier:** 2 + 4 + 3 · **Status:** ⚠ · **Priority:** **P0**
- Primary "Vis veibeskrivelse" CTA → Tier 4 honey ✓
- Secondary chips (share, save, bell) → Tier 3 ✓ ish
- Layout review needed — they currently sit in a row; spacing/alignment matters
**Acceptance:** one Tier 4 honey CTA; secondary chips visually subordinate; clear group separation
**Effort:** 1 hour

### Detail timeline + busyness chart
**Tier:** 0 / 6 · **Status:** ⚠ · **Priority:** P1
Canvas-drawn information visualizations. Same drawTimeline() issue as list cards. Plus busyness chart palette review.
**Acceptance:** info viz reads as data, not decoration; no honey-as-decoration; aligned with new weather palette
**Effort:** 1 hour (after weather palette decided)

### Detail "Travelt nå", "Moderat trafikkstøy", "Åpent til 23:30" rows
**Tier:** content · **Status:** ⚠ · **Priority:** P1
- Information rows with icon + text + value
- Honey "Åpent" badge at right reads well
- Spacing between rows could be more generous
**Acceptance:** clear icon + label + value structure; consistent row height; subtle separators if needed

### Detail edit links ("Rediger informasjon · Rapporter feil")
**Tier:** ghost-link · **Status:** ⚠ · **Priority:** P3
Tier-less small text-buttons at the bottom. Should be cream-at-opacity, hover → cream.

### Detail panel close affordance
**Tier:** 3 · **Status:** ⚠ · **Priority:** P2
Verify swipe-down behavior + visual close button match design system

---

## 4 · Filtering & sorting (P1)

### Sort menu (`#sort-panel`)
**Tier:** 1 · **Status:** ⚠ · **Priority:** P1
Mirror-sky now applies. Items inside are buttons — verify they're Tier 2 mini-cards on hover, with honey for selected state.
**Effort:** 30 min

### Time picker / FTS slider (`#fts-track`, `#fts-canvas`, `#fts-popup`)
**Tier:** mixed · **Status:** ⚠ · **Priority:** **P0**
- Time slider track: canvas-drawn weather bar (same drawTimeline issue)
- Slider thumb: honey-on-cream "sunglass" — verify it tracks new palette
- Popup readout (`#fts-popup` + time/temp/wx-icon/wind): currently glass-action style
- Hour/segment labels: currently in muted text
**Acceptance:** thumb honey, track segments use new weather palette, popup readable, labels crisp
**Effort:** 2 hours (depends on weather palette decision)

### Date calendar / picker (`#date-calendar`)
**Tier:** 1 · **Status:** ⚠ · **Priority:** P2
Calendar grid — past tiles dimmed, today highlighted, future tiles selectable. Verify slate alignment + honey for selected day.

### Area filter dropdown
**Tier:** 1 + 3 chips · **Status:** ⚠ · **Priority:** P2
Area chip → opens menu of area chips. Each chip Tier 3. Active chip honey-bg + accent-on text.

### Intent shortcuts (top quick-filter chips)
**Tier:** 3 · **Status:** ⚠ · **Priority:** P1
Quick-filter chips below search ("Lunsj nå", "Sol til 18", etc.). Currently glass-action; verify hover spotlight + selected honey state work.
**Effort:** 30 min

---

## 5 · Auth & account (P2)

### Login splash (`#login-splash`)
**Tier:** 1 · **Status:** ✗ · **Priority:** P2
- Currently has Google/Apple/email auth buttons + carousel
- Should get scroll-shimmer hero treatment (the polarized rotation we built for login)
- Auth buttons: Google must keep brand colors; Apple must keep brand; email-magic-link → Tier 4 honey
- Email input: Tier 3 surface + honey focus border
**Acceptance:** splash feels premium and "discovery"-themed; auth path clear
**Effort:** 2-3 hours

### Profile panel (`#profile-panel`)
**Tier:** 1 · **Status:** ⚠ · **Priority:** P2
Mirror-sky now applies. Inside: avatar, name, email, settings rows, signout link.
- Avatar handling — verify slate border on glass
- Settings rows: title + chevron pattern; verify Tier 3 hover states
- Destructive (signout, delete account) — currently uses `--color-error` 
**Effort:** 1 hour

### Onboarding overlays
**Tier:** 1 ephemeral · **Status:** ⚠ · **Priority:** P3
First-time tooltip overlays. Probably needs review for Slate + Honey alignment.

---

## 6 · Social (P2)

### Invite sheet (`.dpinvite-*`)
**Tier:** 1 · **Status:** ⚠ · **Priority:** P2
- Backdrop now slate-tinted ✓
- Sheet content: friend avatar grid, recent search, top header chip
- Friend avatars use independent identity palette (intentional)
- "Invite friends" CTA → Tier 4 honey ✓
**Effort:** 1.5 hours

### Plan-conflict modal
**Tier:** 1 · **Status:** ⚠ · **Priority:** P3
Backdrop slate-tinted ✓. Three CTA pattern (merge / send separate / cancel) — verify ONE Tier 4 + two Tier 3.

### Notification toasts (`#notif-toast`)
**Tier:** 1 · **Status:** ⚠ · **Priority:** P2
Slide-in toast for friend events, social, login, etc.
- Animation polish (slide-in/out timing)
- Tap area for action
- Auto-dismiss timing
**Effort:** 1 hour

### Friend-add result, friend list views
**Tier:** content · **Status:** ⚠ · **Priority:** P3

---

## 7 · Edit / admin (P3)

Lower priority since users rarely see these:

- Building editor overlay (`render-editor.js`) — already partly migrated to TOKENS
- Admin review flows
- Suggestion / report flows
- Edit chips, edit type trigger

These need Tier alignment but are not user-facing-prio.

---

## 8 · Cross-cutting items

### Weather palette redesign (P0 prerequisite)
**Status:** ✗ · **Priority:** **P0**
The current weather cf-band palette (in `js/ui-shared.js` and `js/render-arc.js`) uses old coral/peach values that don't align with Slate + Honey. This is a coordinated 6-step palette and needs redesign as a unit:
- full sun (clear) → honey (`var(--accent)`)
- partly sunny → softer honey
- overcast → cool slate-grey
- rain → slate-blue (`var(--rain)`)
- night → deep slate
**Affects:** card timeline, FTS slider, sun-curve, detail timeline, weather chip
**Effort:** 2 hours (decide palette + apply across canvas drawings)

### Operating hours / "stenger snart" / "åpner snart" messaging
**Status:** ⚠ · **Priority:** P1
Cross-cuts cards, detail panel, search results. Visual treatment should be neutral (not honey, not red) — just informational.

### Loading skeletons (cross-cutting)
**Status:** ✗ · **Priority:** P2
Slow honey-cream shimmer on slate base. Apply consistently across list, detail, search, profile loading states.

### Empty states (cross-cutting)
**Status:** ✗ · **Priority:** P2
Establish a single empty-state pattern (centered icon + title + description + CTA) and apply across list, search, profile, plans.

### Form input pattern
**Status:** ✗ · **Priority:** P2
Establish the canonical input style (Tier 3 surface + honey focus border) and apply across search, email-magic-link, profile fields, edit forms.

### Copy / microcopy review (cross-cutting)
**Status:** ⚠ · **Priority:** P1
Wording across every surface — titles, CTAs, empty states, error messages, tooltips, status pills, time/sun phrasing. Norwegian-first; English fallback via `js/i18n.js`.

**Approach:**
- **Interleaved**: when polishing a surface in Phase A/B/C, also review its copy (5-10 min per surface). Surfaces it as we go.
- **Final consistency pass** at end of Phase D: read every string in the app top-to-bottom, fix tone drift, terminology inconsistencies, length issues. ~3 hours.

**What to look for:**
- Norwegian voice consistency (du-form, casual but precise)
- Sun terminology ("sol" / "skygge" / "skyer" / "regn") — already canonical, just verify
- CTA verb consistency ("Vis…" vs "Se…" vs "Åpne…")
- Empty-state wording (currently mostly "Ingen…" — could be richer)
- Truncation: meta lines, card titles — check on narrow viewports
- Number formatting: distance, time, walking minutes — already partly tabular-numeric
- Time phrasing: "Sol til 18:30" works; "Stenger 23:00" — verify across all hour states
- Error / failure copy (very rarely seen but high-stakes when it appears)

---

## Suggested work order

### Phase 0 · P0 — Information architecture review — ~2 hours
0. **IA review** (2h) — output `ia-review.md` with screen/feature inventory + restructure proposals. Runs **concurrent with Phase A**: Phase A surfaces are mostly safe-from-restructuring (cards, search, pins, palettes), so they can proceed in parallel. **Phase B/C polish work for any surface flagged in the IA review is gated on the IA decision.**

### Phase A · P0 (do first, sets the bar) — ~12 hours
1. **Weather palette redesign** (2h) — prerequisite for several others
2. **Card timeline canvas update** (2h) — applies new weather palette
3. **Search bar focus state + placeholder polish** (30 min)
4. **List header layout + count text** (1.5h)
5. **Pin pill canvas review** (1h)
6. **Detail panel header + photo placeholder** (2h)
7. **Detail action row layout** (1h)
8. **Time picker / FTS slider** (2h) — applies new weather palette

### Phase B · P1 (most-touched secondary surfaces) — ~6 hours
9. Card pills color verification (30 min)
10. Sort menu items — Tier 2 hover (30 min)
11. Intent shortcuts polish (30 min)
12. Sun arc / weather strip (1h)
13. Detail timeline + busyness chart (1h)
14. Detail info rows polish (1h)
15. Operating hours messaging treatment (1h)
16. Notification toast polish (1h)

### Phase C · P2 (dedicated user flows) — ~10 hours
17. Login splash hero treatment (2-3h)
18. Profile panel (1h)
19. Invite sheet (1.5h)
20. Loading skeletons system (2h)
21. Empty state pattern (1.5h)
22. Form input pattern (1.5h)
23. Date calendar (1h)
24. Locate button + zoom controls (30 min)

### Phase D · P3 (edge / admin) — as time allows
25-onward: Onboarding, plan conflict, friend-add result, edit/admin flows

### Phase E · Final consistency pass — ~3 hours
26. **Copy / microcopy consistency pass** (3h) — read every string in the app top-to-bottom; fix tone drift, terminology inconsistencies, length/truncation issues. Lighter copy reviews already happen interleaved with each surface's polish work; this is the final cross-cutting check.

---

## Estimated total effort
**~33 hours of focused design + IA + copy work**, split:
- Phase 0 (IA): ~2h
- Phase A (visual P0): ~12h
- Phase B (P1): ~6h
- Phase C (P2): ~10h
- Phase E (copy): ~3h
- Phase D (P3): open-ended

Plus ~5–10 minutes of inline copy review per surface during Phase A/B/C polish, included in those estimates.

## How to consume this plan

- **Phase A items can be tackled in any order**, but weather palette (#1) should land first since #2, #8 depend on it.
- Each item is small enough for one focused branch + preview + merge cycle (Tier 2 of the workflow).
- Re-evaluate after each phase — the next phase's priorities may shift based on what we learn.

---

## Out-of-scope for this audit
- Performance work (bundle size, lazy loading, etc.)
- Accessibility audit (separate concern; partial coverage already in `feedback_check_visibility_chain.md` and `aria-label` work)
- Internationalization mechanics (Norwegian/English split is already in place via `js/i18n.js`; copy review covers wording, not the i18n plumbing)
