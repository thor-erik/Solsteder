# Deferred / skipped — design-system code pass

Running log of everything intentionally skipped or deferred during the Phase −1 → 4
surface migration. Complements `DESIGN-FIXES.md` (issue tracker) and
`REMAINING-WORK.md` (the Phase 5+ forward sequence).

> **Reconciled 2026-05-24.** Completed items are struck through with their resolution
> (trail kept, per this file's own rule). Everything still open has been **moved to
> `REMAINING-WORK.md`** — so this file is now a historical log, not a live backlog.
> For the forward plan, read `REMAINING-WORK.md`.

## Resolved (trail)

- ~~**Sheet treatments** — detail panel / invite / share → solid dark Delft (`--blue-950`
  shell so the `#111E38` cards read as lighter raised tiles; shell text → cream via the
  `--panel-text` / `--ink-muted` cascade; controls = Jordy outlines; toggle-active = cool
  Jordy fill, NOT honey). Accept (`Du er invitert til`) + post-accept kept lighter
  (first-impression).~~ **DONE — shipped (Phase 2.5 / 3).** *Open thread moved:* the
  DESIGN.md surface-model section still needs updating to document this → REMAINING-WORK Phase 5.
- ~~`--radius-lg` 16 → 20, and all raw radii snapped to the 5-step scale.~~ **DONE** (radius pass).
- ~~**Type pass** — wire `--text-*` / `--fw-*` / `--tracking-*` role tokens; migrate raw
  font-sizes onto the roles.~~ **DONE (2026-05-24):** *semantic* on-scale aliasing —
  11/13/15/18/22px → `var(--text-caption/label/body/subtitle/title)`, **size only** (weight /
  tracking left as authored → zero visual change). Off-scale micro-text (9/10/12/14/16…) left
  raw by design (component-specific, not one of the six roles). rawFontSize 325 → 165.
  Type-token *names* finalized by use.
- ~~`--glass-inset` (no-op `0 0 0 0 transparent`) retired~~ **DONE (2026-05-24)** — 27 sites
  (inline prefixes dropped, standalone → `box-shadow: none`, token removed). Zero visual.
- ~~Modals (sign-in, friends) → `--surface-modal` + `--scrim` + `--shadow-3`.~~ DONE.
- ~~Raised / dropdown (sort/search/bell) → opaque `--surface-raised` + `--shadow-2`.~~ DONE
  (bleed-through fixed; content recoloured to ink).
- ~~`.dp-action-btn` / `.dp-gm-chip` / `.dp-gm-actions` dead CSS deleted; detail-action-row
  mapped to roles — Invite (`.dp-invite-cta`) → `.p-pill`, Directions → `.s-rnd`,
  Share/Favorite/Alert kept as the stacked icon-over-label toggle grid (a distinct component,
  not forced into `.g-rnd`).~~ **DONE** (Phase 3, this session). The invite CTA also steps back
  to a secondary outline when an RSVP is present (one honey per screen).
- ~~**Phase 4** — locale leak, login-splash contrast, emoji→SVG (Lucide), `-webkit-` pairing.~~
  DONE. (Plus map-pin canvas locale leaks — `Åpner/til/fra/Sol fra/planlegger/Ikke mer sol` —
  fixed 2026-05-24.)
- ~~Selected filter chip → Delft-blue fill + cream text (not DESIGN.md's honey-dim).~~ DONE;
  DESIGN.md updated.
- ~~Top-bar weather glyph → ink on the light chrome (scoped so FTS/timeline glyphs stay cream).~~
  DONE.

## Moved to REMAINING-WORK.md (still open)

Detail now lives in `REMAINING-WORK.md`; pointers only here so the trail stays:

- **Spacing pass** — its own careful 2-step phase (on-scale tokenize → off-scale per-surface;
  10px×93 → 8/12 *by context*; never blanket-snap) → **Phase 5**.
- **Remaining button-role flows** — accepted carousel (`.dpacc-action-primary`), FTS popup
  (`.fts-popup-primary/secondary`), RSVP decline link (`.dprcv-cta-link`) → **Phase 5**.
- **Surface stragglers** — `.settings-group`, `.intent-btn`, date-calendar sheet, login-gated
  sheet surfaces, and the "Delft 90% vs fully-opaque" decision (+ DESIGN.md surface-model
  write-up) → **Phase 5**.
- **Venue photo gallery — uniform tile sizing** → **Phase 5**.
- **`cardIn` flash on filter change** → **Phase 7**.
- **Invite-friends as an in-panel page** (push-from-right + back button; kills the duplicated
  `.dpinvite-sheet`) → **Phase 7** (interaction).
- *(Optional control pass: `#locate-btn` / `.ts-btn` icon controls + the sort-button "darker"
  perception — only if a control-styling pass is wanted.)* → **Phase 5** (optional).

## Skips that remain intentional (no action needed)

- `.glass-card` — class statically unused (only a JS comment references it); left as-is.
- `.area-chip` — `display:none` (dead); skipped.
