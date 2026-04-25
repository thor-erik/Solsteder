# Prompt for Claude Code — venue list + detail panel redesign

Paste everything below into Claude Code on your working branch. This is a standalone redesign workstream for the venue list cards and the detail panel — surfaces not yet touched by the rounds-based refinement work on the docked group, time bar, calendar picker, and pins. Every task updates behavior plus `DESIGN.md` where noted. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

The prototype at `design/prototype-redesign.html` is the visual ground truth. Open it in a browser and match its right-column (redesign) appearance. Where the prototype and this document disagree, the prototype wins — but flag the disagreement in your report so DESIGN.md can be reconciled.

---

## Context

Users open Solsteder to answer one of two questions: "can I sit in the sun right now, and for how long?" or "when can I sit in the sun later?" The current list card and detail panel bury those answers behind abstractions (`Score 93`, `Komfortnivå 100%`) and duplicate data (ring + `3H 10M` + `LYS TIL 20:25` all saying the same thing). This redesign replaces abstractions with concrete, state-aware answers.

The scope is: venue list card markup and CSS, detail panel markup and CSS, a small shared state helper, and the data wiring needed for the new fields. No map, docked group, or calendar changes — those are handled in the round sequence.

---

## Task 1 — Compact two-column venue card

**Problem.** The current card is ~140px tall per venue, duplicates sun-window information in three places, and shows per-venue weather when weather is already global. Density is bad, hierarchy is flat, and the score badge is an abstraction that forces the user to decode a number.

**Do:**

1. Replace the card with a two-column layout, ~85–90px tall on mobile.
2. **Left column** (`flex: 1, min-width: 0`):
   1. Venue name — `15pt / 700 / --text`, single-line with ellipsis.
   2. Meta — `{område} · {type}` in `12pt / 500 / --muted`. Drop distance from this row.
   3. Mini sun-timeline sparkline (see Task 3) — `14px` tall, spans the left column's full width.
3. **Right column** (fixed `~96px` wide, right-aligned, stretches to match left-column height):
   1. Distance — `221 m`, `12pt / 500 / --muted`, top-aligned.
   2. Hero block — state-dependent content per Task 2.
4. Card background, border, and radius follow glass-card per DESIGN.md. Card gap in list: `8px`.
5. Remove from the card entirely:
   - Score badge (sort replaces it — Task 4).
   - Sun dial ring with arc.
   - Duplicate `3H 10M` duration text.
   - `LYS TIL 20:25` text (now lives in the right column's hero sub).
   - Per-venue weather icon + temperature + wind (weather is global, lives in the docked group's row 1).

**Update DESIGN.md → Components:**

Add a new section titled **Venue card** with: two-column layout, left-column content order (name / meta / timeline), right-column content order (distance / hero), card height `85–90px`, typography per row, and the explicit list of removed elements. Cross-reference Mini sun-timeline (Task 3) and Venue state model (Task 2).

---

## Task 2 — Venue state model: `sun`, `shadow`, `done`

**Problem.** Without a shared state model, the hero block has to special-case every combination of now-sunny, future-sunny, and no-more-sun. Codifying three states lets the card, detail panel, and any future surface speak the same language.

**Do:**

1. Compute a venue's state at the currently selected time from its existing sun-exposure windows (from `scoring.js` / `solar.js` / worker output). One of:

   | State | Condition |
   |---|---|
   | `sun` | Currently inside a sun window. |
   | `shadow` | Not currently in sun, but at least one sun window exists later today. |
   | `done` | No further sun windows today. |

2. Put the state helper in `js/ui-shared.js` (or a tiny dedicated module if that file is already busy). Export a single function, e.g. `venueState(venue, selectedTime) → { state, mainText, subText, className }`.

3. Hero-block content per state:

   | State | Main | Sub | Treatment |
   |---|---|---|---|
   | `sun` | `☼ {duration_remaining_in_current_window}` | `til {end_of_last_sun_window_today}` | Main in `--accent`. |
   | `shadow` | `Sol om {time_until_next_sun_window}` | `til {end_of_last_sun_window_today}` | Main in `--muted`. Card class `state-shadow`. |
   | `done` | `Ferdig` | `sist {end_of_last_sun_window_today}` | Whole card at `50%` opacity. Card class `state-done`. |

4. Duration formatting: `3t 10m`, `1t 45m`, `15 min`, `5 min`. Use `min` under one hour; `t` for hours. No zero padding.

5. Edge cases:
   - Current window ends in `< 5 min` → stays `sun`, shows `☼ 5 min`.
   - Next window starts in `< 10 min` → stays `shadow` with `Sol om 8 min`.
   - Venue closed at selected time → omit from list (existing filter behavior likely handles this; verify).

**Update DESIGN.md:**

Add a top-level section titled **Venue state model** describing the three states, their conditions, and the display conventions. This is a cross-surface concept — the list card, detail panel, and anything else that represents a venue's relationship to sun over time uses these three states.

---

## Task 3 — Mini sun-timeline sparkline

**Problem.** The card needs a compact way to show a venue's sun availability across the day — so the user can scan a list and spot "lots of sun in the afternoon" without opening the detail panel. A full time bar is too heavy; a textual summary loses shape.

**Do:**

1. Horizontal track, `6px` tall, spans the left column's full width.
2. Time range: `06:00–22:00`, mapped linearly.
3. Segments:
   - Orange (`--accent`) where the venue has direct sun.
   - Muted blue/grey (`--muted` at reduced opacity) where clouds/overcast break the sun window — use the same visual language as the weather ramp's overcast position.
   - A `2px` vertical line in `--text` marking "now" (the current wall-clock time, not the selected slider time — the "now" marker is an at-a-glance orienter).
4. Same visual vocabulary used at a larger size in the detail panel's sun section (Task 6). Extract a shared renderer if the markup supports it.

**Update DESIGN.md → Components:**

Add a **Mini sun-timeline** section with: `06:00–22:00` range, `6px` track height (`10px` in detail-panel context), segment color rules, and the rule that the "now" line represents wall-clock time, not the slider's selected time. Note the shared-vocabulary relationship with the detail panel timeline — they're the same pattern at two sizes.

---

## Task 4 — Sort chip default label

**Problem.** The sort chip currently defaults to `Sort: Score ▾`. Score is the abstraction we're removing; the default should reflect the new primary sort criterion (most remaining sun).

**Do:**

1. Change default sort label to `Sol nå ▾`.
2. Sort ranking logic:
   1. Primary: sun-remaining-duration descending (venues with more sun left come first).
   2. Secondary: distance ascending.
   3. Tertiary: `shadow` state venues after `sun` state venues.
   4. Quaternary: `done` state venues at the bottom.
3. Chip styling stays glass-action per round 8. Chevron is SVG triangle from round 6.

**Update DESIGN.md → Progressive disclosure (or Sort chip section):**

Replace any references to `Sort: Score` with `Sol nå`. Document the four-tier ranking order so a future rework doesn't regress it.

---

## Task 5 — Detail panel: header + primary action row

**Problem.** The detail panel currently leads with a generic title block and a 4-equal-button action grid that buries the primary action ("get directions") at equal weight with share, website, and phone.

**Do:**

1. Keep the photos strip at the top of the panel, unchanged.
2. **Header row** (below photos):
   - Title: `22pt / 700 / --text`, up to 2 lines, ellipsize if longer.
   - Meta: `{type} · {område} · {distance}` in `13pt / 500 / --muted`.
   - Back button `‹ Steder` top-right, action-pill flavor, `36px` height.
3. **Primary action row** — asymmetric, one wide + icon buttons:
   - `↗ Veibeskrivelse · {walk_time} min` as a filled `--accent` button, `flex: 1`, `44px` tall. Text in `--accent-on` (`#2a1a0c`).
   - `📞 Ring` — render only if `venue.phone` is truthy. `tel:` link. `48×48`, glass-card background, `--accent` icon.
   - `🌐 Nettside` — render only if `venue.website`. Opens in new tab. Same dimensions.
   - `⇪ Del` — always present. Uses Web Share API with a `navigator.clipboard` fallback.
4. Row gap between primary button and icon buttons: `8px`. Icon buttons gap: `8px`.

**Update DESIGN.md → Components:**

Add a **Detail panel header** section describing the title/meta/back-button layout, and a **Primary action row** section describing the asymmetric one-wide-plus-icons pattern. Note the conditional rendering rules for phone and website buttons.

---

## Task 6 — Detail panel: sun section

**Problem.** The current detail panel has a large central sun dial that visually dominates but answers "how much sun is left" only indirectly. Move that answer up front.

**Do:**

1. Bordered card, glass-card background. Content:
   - **Headline**: state-dependent text per Task 2's state model.
     - `sun` state: `Sol til {end} · {remaining} igjen`
     - `shadow` state: `Sol fra {next_start} · om {time_until}`
     - `done` state: `Sol ferdig i dag`
   - **Right-aligned sub** (same row as headline, optional): `Neste pause 19:00` or similar — hide if the venue's sun-window array has no intra-day breaks.
   - **Timeline bar**: same vocabulary as Task 3's sparkline, scaled to `10px` tall. Range `06:00–22:00`. Sun / overcast / now segments.
   - **Scale labels** below timeline: `6  9  12  15  18  21` in `11pt / 600 / --muted`.

**Update DESIGN.md → Components:**

Add a **Detail panel sun section** entry. Reference the Venue state model (Task 2) and Mini sun-timeline (Task 3) — this section is the larger expression of both.

---

## Task 7 — Detail panel: sol-retning section

**Problem.** The current oversized sun dial takes panel real estate but doesn't answer an actionable question. The actionable question is "which side of the terrace should I sit on?" — which requires sun direction, not sun elevation.

**Do:**

1. Bordered glass-card, sitting directly below the sun section.
2. Section label: `Sol-retning akkurat nå`, `13pt / 600 / --muted`, all caps not required.
3. Layout — two columns:
   - **Left**: compact sol-dial showing sun azimuth as an arc position. Reuse `render-arc.js` draw logic at `80px` diameter; keep N / S ticks but drop secondary ornamentation. The dial shows direction only, not elevation.
   - **Right**: short text pulled from azimuth buckets (N / NØ / Ø / SØ / S / SV / V / NV):
     - Primary: `Solen står vest-sørvest` (or equivalent bucket), `15pt / 600 / --text`.
     - Sub: `Sett deg på sørvestsiden av terrassen` (auto-generated from the bucket), `13pt / 500 / --muted`.
4. This card replaces the current oversized sun dial. Retire the old dial entirely (see Task 9).

**Update DESIGN.md → Components:**

Add a **Sol-retning section** entry. Document the azimuth-bucket-to-copy mapping so future contributors don't have to re-derive it.

---

## Task 8 — Detail panel: info list

**Problem.** The current `SOLSCORE` block shows four percentages (`Soleksponering / Komfortnivå / Støy / Nærhet`) which are abstractions of underlying data. Replace with concrete, labeled values.

**Do:**

1. Bordered glass-card with stacked rows. Each row: `[leading icon, 18px][label][right-aligned value or sub]`.
2. Rows, in order:
   - `👥 Travelt nå · {busyness_text}` — right value `~{pct}%`. Source: `js/busyness.js`. If busyness data is unavailable for this venue, hide the row.
   - `🔊 {noise_label}` — sub (same row, below label): `{nearest_street_or_context}`. Convert the existing 0–100 noise score into three buckets: `Rolig` (0–33) / `Moderat trafikkstøy` (34–66) / `Mye trafikkstøy` (67–100).
   - `🕐 Åpent til {closing_time}` — sub: `Kjøkken til {kitchen_close}` if available.
3. No weather row. Weather is global, lives in the docked group's row 1.

**Update DESIGN.md → Components:**

Add an **Info row** pattern: `[icon] [label] [value]` with optional sub-text under the label. Note the noise-score-to-label bucketing as a concrete rule; raw scores stay in the data layer, only display changes.

---

## Task 9 — Retirements from the detail panel

**Problem.** Tasks 5–8 replace large chunks of the current detail panel. Any leftover old UI will create contradiction.

**Do:**

1. Remove the large central sun dial (replaced by Task 7's compact version).
2. Remove the `SOLSCORE` block with percentages (replaced by Task 8).
3. Remove the 4-equal-buttons action grid (replaced by Task 5's asymmetric row).
4. Remove any per-venue weather row.
5. Remove the footer's current chrome if it conflicts with the new footer — keep only:
   - `Rediger informasjon`
   - `Rapporter feil`
   - Both centered, `13pt / 500 / --muted`.

**Update DESIGN.md:**

No explicit retirement rules needed — but if any prior DESIGN.md section referenced the old `SOLSCORE` block or the 4-button grid, remove those references to prevent ambiguity.

---

## Task 10 — Data support

**Problem.** The new UI needs fields and transforms that may or may not exist in the data pipeline.

**Do:**

1. **Walk time**: distance in meters ÷ 80 (≈ 4.8 km/h), rounded to nearest minute. Under 1 min show `< 1 min`. Put this calculation next to the distance helper; don't inline.
2. **Phone field**: check `data/venues.json` schema for `phone`. If missing, add it to the schema AND to the fetch script (`scripts/fetch-venues-places.mjs`). Don't block the UI work on this — render the phone button conditionally on `venue.phone` being truthy; most records being empty for now is fine.
3. **Website field**: same check and same conditional-render pattern as phone.
4. **Busyness**: hook `js/busyness.js` output into the info row. Hide the row if the venue has no busyness data.
5. **Noise bucketing**: map the existing 0–100 noise score to `Rolig / Moderat trafikkstøy / Mye trafikkstøy` at thresholds `33` and `66`. Put the bucket helper near the noise score read, not inside the render.

**No DESIGN.md change** — these are data-layer concerns. Only flag if you find a rule that belongs in DESIGN.md (e.g. the walk-time calculation constant).

---

## Task 11 — Global formatting rules

**Problem.** The redesign introduces (or reinforces) typographic rules that should be documented globally, not buried per-component.

**Do:**

1. **ALL CAPS** is reserved for small metadata labels only (the existing `LYS TIL`, `SOLSCORE` patterns — though both are now retired). Do not use CAPS on primary hero text; use sentence case. This is already partially stated in DESIGN.md — confirm and tighten.
2. **Tabular numerals**: apply `font-variant-numeric: tabular-nums` to any time or duration value (`14:15`, `3t 10m`, `Sol om 8 min`, etc.). Prevents layout shift as numbers change during scrub.
3. **Duration format**: `3t 10m`, `1t 45m`, `15 min`, `5 min`. Defined in Task 2; restating here so it lands as a global rule.

**Update DESIGN.md → Typography:**

Add three rules: CAPS reserved for small-metadata only, `tabular-nums` on all time/duration values, and the duration format convention with examples.

---

## Task 12 — Final DESIGN.md pass

After Tasks 1–11:

1. Verify the new sections exist: Venue card, Venue state model, Mini sun-timeline, Detail panel header, Primary action row, Detail panel sun section, Sol-retning section, Info row.
2. Verify the sort chip default label is updated consistently everywhere.
3. Verify the typography additions (CAPS rule, `tabular-nums`, duration format) are under Typography.
4. Verify no lingering references to the retired elements: score badge, `SOLSCORE` block, oversized sun dial, 4-button grid, per-venue weather.
5. Flag contradictions in the PR description rather than silently resolving them.

---

## Success criteria

- List cards are visibly shorter (`~85–90px` vs. previous `~140px`), readable on a `390px` viewport, and the mini-timeline makes "lots of sun later" scannable without tapping.
- At least one venue in each state (`sun`, `shadow`, `done`) renders correctly when the time slider is scrubbed to different hours.
- Detail panel leads with the sun answer (Task 6), not with a dial. Directional guidance (Task 7) replaces the old central dial cleanly.
- `Rediger informasjon` and `Rapporter feil` are the only footer items.
- A venue with no `phone` does not render a phone button. A venue with no busyness data does not render the busyness row.
- No regressions: map → detail panel still works, infinite scroll still works, sort chip still changes order.
- `node scripts/audit-layout.mjs venue-card` and `node scripts/audit-layout.mjs detail-panel` — no unexpected conflicts.

---

## Out of scope

- Map, pins, docked group, time bar, calendar picker — all handled in the round sequence.
- Venue data pipeline beyond adding the `phone` and `website` schema fields.
- Detail panel animation and open/close behavior — keep existing transitions.

---

## Reporting

This redesign is larger than a typical round. Suggested commit boundaries:

1. Venue card markup + CSS (static placeholder for state helper OK).
2. Venue state helper in `js/ui-shared.js`.
3. Wire state helper into venue cards; sort ranking updated.
4. Detail panel header + primary action row.
5. Detail panel sun section + sol-retning section.
6. Detail panel info list.
7. Remove retired elements (Task 9).
8. Data support (walk time, noise bucketing, phone/website schema if needed).
9. DESIGN.md pass.

Per commit: short summary of file changes and any spec deviations with justification. Where the prototype and this document conflict, follow the prototype and flag the conflict so DESIGN.md can be reconciled. Final report ends with the DESIGN.md diff surfaced separately so the doc changes are easy to review in isolation.

Do not commit a "maybe this works" change. If the root cause of a layout or state issue is unclear after investigation, pause and say so rather than iterating blindly — especially on the mobile-width verification pass.
