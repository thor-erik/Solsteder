# Deferred / skipped — design-system code pass

Running log of everything intentionally skipped or deferred during the Phase −1 → 4
surface migration. Complements `DESIGN-FIXES.md` (issue tracker) and
`REMAINING-WORK.md` (Phase 5+ sequence). Append as we go; don't delete resolved
items — strike them through with the resolution so the trail stays.

## To revisit (user-flagged)

- **Detail sheet (and maybe all sheets / content) as Delft Blue 100% opacity.**
  The user wants to try `#detail-panel` solid Delft 100% instead of the locked
  Jordy-25% sheet. Parked for now. (May also inform the content-tile 90% question
  below — same "how opaque should dark surfaces be" call.)

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

## Deferred polish / bugs

- **Venue-list `cardIn` flash on filter change** — the pre-existing card-entrance
  animation re-fires whenever the filtered set changes (`ui-list.js`). Not from the
  migration. Tame separately (suppress on filter toggles, or swap for a light
  crossfade). User to pick the approach.
- **Phase 3** — collapse per-flow button classes (`dprcv-*` / `dpacc-*` / `fts-*` /
  `dp-action-*`) into the 4 button roles + state matrix.
- **Phase 4** — locale leak, login-splash contrast, emoji→SVG (Lucide), pair every
  `backdrop-filter` with `-webkit-`.

## Resolved (recorded, kept for the trail)

- **Selected filter chip**: changed from DESIGN.md's honey-dim to **Delft-blue fill
  + cream text** (honey-dim "transparent yellow" + honey-on-honey text both tested
  poorly on device). DESIGN.md updated (component states + surface model).
- **Top-bar weather glyph**: forced to ink on the light chrome (was cream/white);
  scoped so FTS/timeline glyphs stay cream.
