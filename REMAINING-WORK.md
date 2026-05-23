# Solsteder · Remaining Work Plan (Phase 5 onward)

The design-system **foundation** is Phases −1 → 4 in `DESIGN-FIXES.md`: split the CSS,
land tokens in `css/tokens.css`, build `scripts/validate-tokens.mjs`, migrate literals →
tokens, collapse per-flow components into the 4 button roles + state matrix + surface
recipe, and clear the core bugs (locale leak, login contrast, emoji→SVG, `-webkit-`
pairing). **This document sequences everything after that** — the parts of the punch-list
the foundation phases were never scoped to fix.

The user chose: one phased master plan covering all remaining work; Claude Code produces
the per-phase detail.

## Canonical docs (read order for a fresh session)

1. `CLAUDE.md` — project + workflow + deployment.
2. `DESIGN.md` — visual source of truth. **Current.**
3. `DESIGN-FIXES.md` — issue tracker / punch-list. **Current.** The phases below cite its sections.
4. **This file** — execution sequence for Phase 5+.

**Ignore for any visual or feature decision:** `redesign-plan.md` and `ia-review.md`.
They are **SUPERSEDED** (both carry a banner saying so). `redesign-plan.md` is written
against the *old* visual language — Slate-42%, mirror-sky, chromatic, sheen, coral/peach
weather palette `#FFAF85` — all retired in the flat-modern pass. `ia-review.md`'s feature
decisions (saved venues, inbox, plan management, wind-shelter row) are largely **already
shipped** (`favorites` / `notifications` / `plans` / `plan_invites` exist per CLAUDE.md).
Their only lasting value is the surface inventory, de-staled into the appendix below.

## Workflow (carried from CLAUDE.md Tier 2)

- Each phase = its own branch + Cloudflare preview, **landed and verified before the next.**
- Run `node scripts/validate-tokens.mjs` before merging. The baseline counts the literals
  the foundation migration must still drive down (at last check: 934 raw spacing, 615 raw
  alpha, 339 font-size, 207 border-radius, 129 hex-outside-root, 44 blur). A phase that
  touches CSS should not raise these.
- Bump the `?v=` cache-bust string + `sw.js` `CACHE_VERSION` on any web-asset edit.
- `npm run cap:sync` (Node 22) before any native release; `cap-sync-check.yml` guards the cp-list.
- CSS now lives in five files (`tokens` / `base` / `components-chrome` / `components-content`
  / `components-overlays`). Shared rules are still **single-writer / sequential** — only
  genuinely separate-file work (a JS render file, the a11y audit script) can run concurrently.
  Ask before parallelizing.

## Two natures of work — keep them apart

- **Mechanical cleanup** (Phase 5, parts of 6): finishes the system, builds directly on the
  new token/component layer, low risk, verifiable locally.
- **Product design** (Phases 7–9): new judgment calls that can't be derived from existing
  tokens. **SPEC GATE applies** — see below.

---

## Phase 5 — Design-system point fixes  ·  *mechanical, low risk*

Finishes the cleanup the foundation didn't cover. One or two previews.

- **Icon stroke normalization.** Phase 4 only swaps emoji→SVG; it does *not* touch stroke
  widths. ~109 inline SVGs use 10 different widths (2 / 1.5 / 1.8 / 2.4 / 2.2 / 3 / 2.5 /
  1.6 / 1.2 / 2.6). Normalize all to the Lucide standard: 24×24, stroke 2, round caps,
  `currentColor` (DESIGN.md → "Icons"). *(DESIGN-FIXES → Consistency)*
- **Secondary meta text → cream-at-opacity.** Cards render `Sentrum · Restaurant · 87 m`
  in cool grey `#9BA9BC`; principle 3 wants `rgba(255,244,224,0.78)`, same hue as the title.
  *(DESIGN-FIXES → Consistency)*
- **`.venue-card` glossy inset → flat.** The card hardcodes `inset 0 1px 0 rgba(255,250,235,0.16)`
  etc., bypassing `--glass-inset` which the flat pass zeroed. Drop to drop-shadow only.
  *(DESIGN-FIXES → Skeletons)*
- **Tabular figures.** `font-variant-numeric: tabular-nums` on times, sun-hours, temps,
  distances so layout stops twitching as digits change. *(DESIGN-FIXES → mobile polish + backlog)*
- **Skeletons** *(DESIGN-FIXES → Skeletons)*:
  - Give `.venue-card` a deterministic `min-height` the skeleton inherits → kill the CLS jump
    (real cards vary in height; don't pixel-tune block heights).
  - Blocks → cream-low-opacity `rgba(255,244,224,0.08–0.10)`, not Jordy-blue (reads as
    *absence of content*, not *blue content*). Keep the skeleton **card** the same opaque
    Delft Blue box for footprint match. Replace whole-card opacity pulse with a sweeping
    translucent sheen; reduced-motion → static. No stripe in the loader (stripe = shade).
- **Small UX / false-precision fixes:**
  - Busyness as a level word, not `~71%` of an unclear base. *(DESIGN-FIXES → mobile polish)*
  - Eight nudge chips (+5 min … +2t) → 3 presets + custom. *(DESIGN-FIXES → opinions)*
  - Invite nudge-grid is coupled to "Jeg blir med" but logically belongs under
    "Kommer senere" — re-couple it. *(DESIGN-FIXES → mobile polish)*

**Acceptance:** validator clean; no CLS on list load; one preview the user signs off.

---

## Phase 6 — Accessibility & resilience  ·  *partly verification of Phases 2–5*

- **MEASURE contrast on the new surfaces — don't assert it.** We changed every fill in the
  surface migration but asserted legibility rather than measuring. Verify ≥ 4.5:1 (3:1 for
  ≥ 24px or bold) for: ink on Jordy-25%-over-map; cream + 0.78 secondary on Delft-90%; honey
  on Delft-90%; ink on the cream dropdown. Fix any miss at the **token** level, not per-component.
  Output a contrast table. *(DESIGN-FIXES → backlog)*
- **Component-state matrix completeness.** Visible focus rings (honey), ≥ 44px touch targets,
  pressed / disabled / loading states per the matrix on every interactive component.
  *(DESIGN-FIXES → A11Y)*
- **Dynamic Type / text scaling.** The hardcoded px sizes won't scale; native apps are
  expected to honor text scaling. Move type to relative units / scalable tokens — coordinate
  with the foundation type-scale migration so this isn't done twice. *(DESIGN-FIXES → A11Y)*
- **reduced-motion fallbacks.** Confirm every motion — including the Phase 7 polish — has a
  `prefers-reduced-motion` path.
- **States & resilience.** Empty / error / offline / location-denied / retry, plus content
  resilience (long-name truncation, missing photo/hours). Establish one canonical empty-state
  pattern. *(DESIGN-FIXES → backlog)*
- **Motion timing tokens.** A duration/easing scale + spring curves (mobile) + reduced-motion
  fallbacks. Spec belongs in DESIGN.md → "Motion vocabulary" before wiring. *(DESIGN-FIXES → backlog)*

**Acceptance:** documented contrast table; keyboard + screen-reader pass on the core flow;
the new states demoable.

---

## SPEC GATE — applies to Phases 7, 8, 9

These are product design, not cleanup. For each phase, **before writing code**:
1. Update `DESIGN.md` first with the new tokens / section (per CLAUDE.md's "update the doc
   first" rule).
2. Share the spec + a lab/preview mock.
3. Get the user's sign-off.
4. Then build, one phase per branch.

Do not smuggle a new visual language into a code branch. This is the rule that keeps the
flat-modern system coherent instead of drifting the way the now-superseded `redesign-plan.md` did.

---

## Phase 7 — Premium mobile polish  ·  *product craft*

The audience is on phones; spend the budget there. Touch-native craft + restraint, not
decoration. Priority order from DESIGN-FIXES → "Premium mobile polish":

- **Haptics — highest ROI.** Selection tick per step while dragging the time scrubber
  (signature moment); soft impact on pin-select; success on RSVP. Ticks/confirmations only.
  *Note:* `@capacitor/haptics` is **not yet a dependency** (only core/app/browser/push are
  installed) — add it + `cap:sync`. No-op on web.
- **Gesture-tracking + spring physics.** Sheets follow the thumb 1:1 with momentum and
  rubber-band at edges; detail drag-to-expand feels weighted; animations interruptible
  mid-flight. Replace linear/ease with spring curves on sheets/transitions.
- **Shared-element continuity.** Pin tap → card grows from the pin's location; list card →
  expands into detail (not a new screen sliding over). Strong premium signal for a map app.
- **Cold-start handoff.** Wire the existing Shades Loader (in `index.html`) → smooth handoff
  into the map. Skeleton shimmers, not spinners. Pixel-aligned icons on text baselines.
- **Login as a brand moment** (beyond the Phase-4 contrast fix): solid Cream/Delft background
  + the stacked lockup + real Delft-blue text — legible *and* on-brand. *(DESIGN-FIXES → mobile polish)*
- **Unify the sun/phase bar.** It carries time selection + sun/shade + weather and is cloned
  per flow (the six-glyph share variant is near overload). One canonical component + legend.
  *(DESIGN-FIXES → mobile polish)*

Captured ideas (2026-05-23):

- **Confirmation-page button entry — "rocks on ice."** Buttons slide in from the right; the
  leading button hits the left padding and bounces like a heavy block, and the bounce
  propagates through the adjacent buttons in sequence (a line of rocks sliding on ice into a
  wall). Spring/physics motion. **Constraints:** buttons must be tappable immediately — the
  animation decorates, never blocks input — and it collapses to a plain fade under
  `prefers-reduced-motion`. Play it once per page entry, not on every re-render.
- **Venue-list re-render without the jump.** Scrubbing time currently re-renders the whole
  list with a visible jump. Target: animate only the card *contents* (crossfade the values),
  not the layout. **Blocker:** cards have variable height (shadow-info cards are taller), so
  this depends on the Phase 5 deterministic `.venue-card` min-height, and is eased by
  compacting the shadow pills (Phase 8). Do min-height first → then the crossfade.
- **Panel drag-release feels laggy.** Recurring complaint: releasing a panel drag to snap to
  a new mode delays too much. First check if it's just a long `transition-duration`/easing on
  release — if so it's a quick win that can be pulled earlier. The proper fix is the
  interruptible spring above: release continues the gesture's velocity instead of starting a
  fresh timed animation.

> **Map relight** is *also* a polish item but lives in **Phase 9** (the map workstream) so the
> map is touched once. Don't start it here.

**Acceptance:** each item previewed on a real phone (haptics + spring need device feel);
reduced-motion verified alongside.

---

## Phase 8 — Stripe motif = "shade" as data  ·  *needs tokens first*

Core principle: **honey means sun, the stripe means shade — both are information, never
ornament.** Tokenise angle / width / ratio / colour once (the dark variant needs a fatter
ratio for perceptual parity per the brand pack). Placements, best first:

- **Map building-shadow polygons** get a subtle diagonal-stripe fill instead of flat grey —
  the map reads in the brand language; converges with relight (Phase 9). Best idea on the list.
- Sun bars / timelines: make the existing hatched shade rigorous — the *only* texture for shade.
- In-shade pins / **compact shadow pills (idea, 2026-05-23):** replace the verbose shadow pill
  with a compact form — diagonal-stripe background (= shade) + just the time, maybe the shadow
  icon. Doubles as the in-shade treatment vs the honey "in sun" pill. **Two cautions:** stripe
  at pill scale risks moiré + legibility loss — verify at real size with the stripe tokens
  (angle/width/ratio) before shipping; and this reduces card-height variance, which directly
  helps the Phase 7 list-refresh crossfade.
- Loading / empty states: slow diagonal barber-pole shimmer.

**Avoid:** striped dividers / backgrounds / "brand sticker" use (cheapens it); moiré +
reduced-motion hazards. *(DESIGN-FIXES → mobile polish)*

---

## Phase 9 — Map design (Tier 0)  ·  *biggest undesigned surface*

The map is 70%+ of every screen and is currently treated as a fixed backdrop. Brand the
style: buildings / water / roads / label density / 3D extrusions, plus day / night / sunset
states (it's a sun app — design the night). *(DESIGN-FIXES → backlog)*

**One map workstream — touch the map once.** These three converge on the same rendering and
should be tightly chained (or one branch):
1. Map style branding (this phase).
2. Stripe-shade fill on building-shadow polygons (Phase 8).
3. **Relight-on-scrub:** 3D building shadows sweep in real time as the slider moves — polish
   *and* the core value prop *and* the one thing only this app can do. Shadow geometry is
   already computed (`js/solar.js`, `js/render-seating.js`), so this is wiring, not new math.

**Suggested sequence:** style → stripe-shade fill → relight.

---

## Out of scope for the code agent (external / housekeeping)

- **Brand-pack README + mark art** still list the dead Tangerine `#FFAF85`. Update in the
  design tool — DESIGN.md is canonical; the brand pack lags. *(DESIGN-FIXES → External)*
- **Git hygiene** from the earlier sandbox session (stale lock, uncommitted palette note)
  is on the user's machine, not the agent's.

---

## Appendix — surface inventory (de-staled from `redesign-plan.md`)

Keep *which surfaces exist and their tier*; ignore that document's old-palette prescriptions.
Polish priority follows "most-seen first."

| Surface | Tier | Seen |
|---|---|---|
| Map base · sun arc / weather strip | 0 | constant |
| Pin pills (canvas) | 6 | constant |
| Search bar | 1 | constant |
| Locate / zoom controls | 3 | constant |
| Time picker / FTS (track + thumb + popup) | mixed | constant |
| List panel | 1 | very high |
| List header / context strip (date · weather · sort · count) | mixed | very high |
| Venue cards | 2 | very high |
| Card status pills | 5 | very high |
| Card timeline (canvas) | 6 | very high |
| List empty / loading | 1 + content | medium |
| Detail panel | 1 | high |
| Detail header + photo | 2 | high |
| Detail action row (CTA + secondary chips) | 2 / 4 / 3 | high |
| Detail timeline + busyness | 0 / 6 | high |
| Detail info rows | content | high |
| Sort menu · date calendar · area filter · intent chips | 1 / 3 | medium |
| Login splash · profile panel · onboarding | 1 | medium |
| Invite sheet · plan-conflict modal · notif toast | 1 | medium |
| Edit / admin flows | varies | P3 (rare) |
