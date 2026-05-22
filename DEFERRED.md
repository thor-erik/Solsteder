# Deferred / skipped — design-system code pass

Running log of everything intentionally skipped or deferred during the Phase −1 → 4
surface migration. Complements `DESIGN-FIXES.md` (issue tracker) and
`REMAINING-WORK.md` (Phase 5+ sequence). Append as we go; don't delete resolved
items — strike them through with the resolution so the trail stays.

## Sheet treatments (user-decided, 2026-05-22)

DESIGN.md locked sheets as Jordy-25% (light), but on device the detail sheet's
light-on-busy-map hurt button/text visibility. New direction:

- **Detail panel → solid Delft Blue (dark).** Decided: good continuity since the
  venue cards are the same family. Sheet is `--blue-950` (darker) so the cards
  (`#111E38`) read as lighter, crisply-bordered raised tiles (the card is a key
  element — must not blend). Shell text flips to cream via a `--panel-text` /
  `--ink-muted` cascade override on `#detail-panel`. Controls use Jordy outlines;
  toggle "active" is a cool Jordy fill + filled icon (NOT honey — honey stays the
  one Invite CTA). **DESIGN.md surface-model update pending** once confirmed.
- **Invite / Share panels → same dark Delft** as the detail panel (continuity).
- **Accept panel (RSVP "Du er invitert til") → NOT the dark treatment.** It's a
  first impression for many users — keep it distinct/lighter.
- **Post-accept confirmation panel → continuity with the ACCEPT panel** (match
  whatever the accept page gets, not the detail/invite dark treatment).

## Deferred within Phase 2 (surfaces)

- **`--radius-lg` 16 → 20.** Left at 16 in Phase 0 to stay zero-visual; the 16→20
  change lands in the Phase 2 **radius** pass.
- **Type token names provisional.** `--text-{display,title,subtitle,body,label,caption,input}`
  + `--fw-*` + `--tracking-*` are a Phase-0 proposal (DESIGN.md specs role values,
  not names). Finalize in the Phase 2 **type** pass.
- **Content fill 90% vs DESIGN.md "fully opaque" prose.** Using the locked
  `--surface-content` = `rgba(17,30,56,0.90)`. Revisit alongside the Delft-100%
  experiment above.
- **`.settings-group`** (settings tiles) — login-gated; not migrated to
  `--surface-content` yet. Do in a settings pass.
- **`.glass-card` class** — unused statically (only a JS comment references it);
  left as-is.
- **`.intent-btn`** (intent-shortcuts segmented control with sliding `#intent-pill`)
  — not an outline chip; left alone. Tokenize its raw colours / handle form in
  Phase 3.
- **`.area-chip`** — `display:none` (dead); skipped.
- **Detail-panel action buttons** (`.dp-action-btn`, `.dp-gm-chip`) and
  accepted-plan action cards (`.dpacc-action-card`, `.dp-action-card`) — action
  fills, not content/chips → **Phase 3** (button roles).
- **Sort-button "darker" perception** — `#panel-actions-sort` is token-identical
  to `.panel-filter-pill` (`--surface-control` + `--blur-control` + `--line-l-strong`);
  no change made. Perception = circular icon-button + the mask-faded right edge of
  the pill row. Revisit only if the user wants the sort visibly lighter.
- **`#locate-btn`, top-strip icon buttons (`.ts-btn`)** — icon controls, not
  selection chips; not given the outline-chip treatment. Revisit if a control pass
  is wanted.

## Deferred sheets → 2.4b

- **Date calendar** (`#ptb-cal-float` / `#date-calendar`, "Velg dato") — complex;
  not yet on `--surface-sheet`.
- **Login-gated sheets**: RSVP (`.dprcv-*`), Share (`.dpinvite-sheet`), Accepted
  (`.dpacc-panel`) — mixed surfaces (dark cards inside), overlap Phase 3, and not
  preview-verifiable without login.

## Remaining surface sub-phases

- ~~Modals (sign-in, friends) → `--surface-modal` + `--scrim` + `--shadow-3`.~~ DONE.
- ~~Raised / dropdown (sort/search/bell) → opaque `--surface-raised` + `--shadow-2`.~~ DONE
  (bleed-through fixed; content recoloured to ink).
- ~~Radius pass — `--radius-lg`→20 + all 207 raw radii snapped to the 5-step scale.~~ DONE.
- **Type pass** — wire `--text-*`/`--fw-*`/`--tracking-*` role tokens; migrate raw
  font-sizes onto the six roles. (Lower layout risk than spacing.)

### Spacing — its OWN dedicated phase, NOT a blanket snap (user-directed)

The spacing migration is layout-affecting, shorthand-heavy (199 multi-value), and
~300+ off-scale occurrences — too risky to blanket-sed like radius. When it comes
back, do it in two steps:

1. **Zero-risk first**: tokenize only the values ALREADY on the scale
   (2/4/6/8/12/16/24/32/48 → `--space-*`), single-value and the on-scale parts of
   shorthands. No layout change — just gets validator coverage.
2. **Off-scale orphans surface-by-surface**: the off-scale values (esp. **10px ×93**,
   which DESIGN.md says to kill → 8 or 12 *by context*; plus 14/5/20/18/etc.) get
   resolved one surface at a time using `scripts/audit-layout.mjs`, **verified per
   surface and ideally spot-checked on a device.** Never snap off-scale values
   app-wide in one pass.

## Ideas / interaction concepts (parked)

- **Invite-friends as an IN-PANEL page, not a separate sheet** (user idea, strong).
  Instead of `.dpinvite-sheet` opening over everything, slide the detail content
  left and bring the invite content in from the right (iOS-style push) with a
  **back button** (button, not swipe — the mobile detail panel is already a
  vertically-draggable sheet, so a horizontal swipe-back would fight that gesture).
  Wins: spatial continuity (invite belongs to the venue), auto-solves the
  "invite panel surface" question (it *is* the detail panel), kills the duplicated
  `.dpinvite-sheet` container (Phase-3 consolidation spirit), native feel. Watch:
  height transition (fixed panel height + internal scroll, animate X only),
  two-level back/`popstate` wiring, focus management; bonus chance to fix the
  mis-coupled invite nudge-grid. Scope: dedicated **interaction** phase (JS-heavy),
  sim-tested. Applies to invite-CREATION from detail only — the RSVP/accept entry
  stays a separate first-impression surface.

## Deferred polish / bugs

- **Venue photo gallery has variable image sizes** (detail panel) — photos render
  at inconsistent dimensions; needs a fixed aspect-ratio / uniform tile so the
  gallery reads consistently. (Noted 2026-05-22.)

- **Venue-list `cardIn` flash on filter change** — the pre-existing card-entrance
  animation re-fires whenever the filtered set changes (`ui-list.js`). Not from the
  migration. Tame separately (suppress on filter toggles, or swap for a light
  crossfade). User to pick the approach.
- **Phase 3** — collapse per-flow button classes (`dprcv-*` / `dpacc-*` / `fts-*` /
  `dp-action-*`) into the 4 button roles + state matrix. **Recon (done):**
  - **Primary `.p-pill` is surface-neutral** (honey + `--accent-on`) and already used
    in 8 places on both light and dark surfaces — no variant needed.
  - **Secondary + tertiary must be surface-aware** (decided: build light/dark variants
    first — cream text + glass fill on dark; ink text + outline on light, via an
    `.on-light` context the user endorsed). `.s-pill`/`.s-rnd`/`.g-rnd` are barely used
    today, so extending them is low-risk.
  - **Detail action row mapping:** Invite (`.dp-invite-cta`) → `.p-pill`; Directions
    (`.dp-primary-cta`, mis-named) → Secondary. BUT Share/Favorite/Alert
    (`.dp-secondary-btn`) are a **stacked icon-over-label 3-col toggle grid — a
    distinct component, NOT the generic ghost pill**; keep the component, adopt role
    tokens/states (don't force into `.g-rnd`).
  - `.dp-action-btn` / `.dp-gm-chip` / `.dp-gm-actions` are **dead CSS** (zero JS refs) —
    delete during the detail-actions flow.
  - These detail buttons still use the legacy `--glassctl-*` frosted-control fill on
    what is now a light Jordy sheet — the role migration replaces that.
- **Phase 4** — locale leak, login-splash contrast, emoji→SVG (Lucide), pair every
  `backdrop-filter` with `-webkit-`.

## Resolved (recorded, kept for the trail)

- **Selected filter chip**: changed from DESIGN.md's honey-dim to **Delft-blue fill
  + cream text** (honey-dim "transparent yellow" + honey-on-honey text both tested
  poorly on device). DESIGN.md updated (component states + surface model).
- **Top-bar weather glyph**: forced to ink on the light chrome (was cream/white);
  scoped so FTS/timeline glyphs stay cream.
