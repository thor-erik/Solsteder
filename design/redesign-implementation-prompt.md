# Implementation prompt — venue list + detail panel redesign

Copy this entire file as the prompt to Claude Code.

---

## Goal

Redesign the venue list and detail panel per the approved prototype at
`design/prototype-redesign.html`. That file is the visual ground truth —
open it in a browser and match its right-column (redesign) appearance.
If anything below conflicts with the prototype, the prototype wins.

The key insight driving the redesign: users open Solsteder to answer one
of two questions — "can I sit in the sun right now, and for how long?"
or "when can I sit in the sun later?" The current UI buries those answers
behind abstractions (Score 93, Komfortnivå 100%) and redundant data
(ring + "3H 10M" + "LYS TIL 20:25" all say the same thing). Replace
abstractions with concrete, state-aware answers.

---

## What to change

### List view (`js/ui-list.js` + associated CSS)

Each venue card becomes a **two-column compact card** (~85–90px high on
mobile, down from ~140px):

**Left column** (flex: 1, min-width: 0)
1. Venue name — bold 15px, single-line with ellipsis
2. Meta — `{area} · {type}` in 12px muted (drop distance from here)
3. Mini sun-timeline sparkline — 14px high, full width of left column

**Right column** (fixed ~96px, right-aligned, flex stretches to match left)
1. Distance — `221 m`, 12px muted, top
2. Hero block — state-dependent (see State logic below)

The mini-timeline spans 06:00–22:00 horizontally as a 6px-tall track, with:
- Orange segments where the venue has direct sun that day
- Grey/blue segments where clouds/overcast break it
- A white 2px vertical "NOW" marker at the current time
- Colors and styles match `.timeline-*` classes in the prototype

**Remove from the card:**
- Score badge (93) — sorting replaces it
- Sun dial ring (ring with arc)
- Redundant "3H 10M" duration text
- "LYS TIL 20:25" big text (now in the right column's hero sub)
- Per-venue weather icon + temperature + wind (stays global in the top bar)

**Sort chip** stays top-right; default label should be "Sol nå ▾"
(currently "Sort: Score"). Sorting ranking logic: primary by sun-remaining
duration descending, secondary by distance ascending, shadow-state venues
after sun-state venues, done-state venues at the bottom.

### State logic for the hero block

A venue is in one of three states at the current slider time:

| State | Condition | Main text | Sub text | Treatment |
|---|---|---|---|---|
| `sun` | Currently in a sun window | `☼ {duration_remaining_in_current_window}` | `til {end_of_last_sun_window_today}` | accent color |
| `shadow` | Not currently in sun, but another sun window exists later today | `Sol om {time_until_next_sun_window}` | `til {end_of_last_sun_window_today}` | add class `state-shadow` (muted main) |
| `done` | No more sun windows today | `Ferdig` | `sist {end_of_last_sun_window_today}` | add class `state-done` (50% opacity on whole card) |

Duration formatting: `3t 10m`, `1t 45m`, `15 min`, `5 min`. Use `min` for
under 1 hour, `t` for hours. Don't pad with zeros.

Edge cases:
- Current sun window ends in < 5 min → still `sun` state, shows `☼ 5 min`
- Next sun window starts in < 10 min → still `shadow` state with `Sol om 8 min`
- Venue is closed → omit from list (existing filter behavior likely already handles this)

### Detail panel (`js/ui-detail.js`)

Keep the photos strip at top. After that, replace everything down to
the footer with this order:

1. **Header row** — title (22px, 2 lines OK), meta `{type} · {area} · {distance}`, `‹ Steder` back button top-right.

2. **Primary action row** — one filled button + 2–3 icon buttons:
   - `↗ Veibeskrivelse · {walk_time} min` as filled accent button (flex: 1)
   - `📞` phone icon button — render only if `venue.phone` is present; `tel:` link
   - `🌐` website icon button — render only if `venue.website`
   - `⇪` share icon button — always present
   - Icon buttons are 48×48, card-bg, accent-colored icons

3. **Sun section** (bordered card) — headline + big horizontal timeline:
   - Headline: `{state_main} · {state_sub}` e.g. "Sol til 20:25 · 3t 10m igjen"
     - `sun` state: "Sol til {end} · {remaining} igjen"
     - `shadow` state: "Sol fra {next_start} · om {time_until}"
     - `done` state: "Sol ferdig i dag"
   - Right-aligned sub: "Neste pause 19:00" or similar (hide if no breaks)
   - Timeline bar: 10px tall, same 06:00–22:00 range as list, with same
     sun/cloud/now segments. Scale labels below: 6, 9, 12, 15, 18, 21

4. **Sol-retning section** (bordered card, under sun section)
   - Section label: "Sol-retning akkurat nå"
   - Left: small 80px sol-dial showing sun azimuth as an arc position
     (reuse `render-arc.js` draw logic at smaller size; keep N/S ticks)
   - Right: short text e.g. "Solen står vest-sørvest" + muted sub
     "Sett deg på sørvestsiden av terrassen". Copy should be generated
     from the current azimuth — rough buckets (N, NØ, Ø, SØ, S, SV, V, NV).
   - This section replaces the current oversized sun dial. Keep it
     meaningful: it answers "which side of the terrace to sit on."

5. **Info list** (bordered card with stacked rows) — **concrete data, no percentages**:
   - `👥 Travelt nå · {busyness_text}` right value `~{pct}%` — pull from `busyness.js`
   - `🔊 {noise_label}` sub: `{nearest_street_or_context}` — from existing noise scoring; convert the current 0–100 score to a label (Rolig / Moderat trafikkstøy / Mye trafikkstøy)
   - `🕐 Åpent til {closing_time}` sub: `Kjøkken til {kitchen_close}` if available — from existing hours data
   - No weather row. Weather is global, already in the top bar.

6. **Footer** — secondary links, muted, centered:
   - "Rediger informasjon"
   - "Rapporter feil"

**Remove from the detail panel:**
- The large central sun dial (replaced by the compact one in section 4)
- The "SOLSCORE" section with `Soleksponering / Komfortnivå / Støy / Nærhet` percentages
- The 4-equal-buttons action grid (replaced by asymmetric primary+icons row)
- Any per-venue weather row

---

## Data considerations

- **Sun state**: Compute from existing sun-exposure windows in `scoring.js` / `solar.js` / the web worker output. A venue's sun-window array for today already exists; determine state from where `now` falls relative to those windows.
- **Walk time**: Distance in meters ÷ 80 (≈ 4.8 km/h) rounded to nearest minute. Under 1 min show "< 1 min".
- **Phone field**: Check if `data/venues.json` has a `phone` field on venue records. If not, add it to the schema and the fetch-places script (`scripts/fetch-venues-places.mjs`), but don't block the UI work — render the phone button conditionally on `venue.phone` being truthy. Empty for now on most records is fine.
- **Busyness**: Already lives in `js/busyness.js`. Hook its current output into the new info row.
- **Noise**: The existing noise score (0–100 or similar) should be bucketed into 3 labels for display. Raw score stays in the data, only the display changes.

---

## Design system constraints

Pull everything from the CSS custom properties in `index.html`:
- Accent: `var(--accent)` (#FFAF85)
- Text: `var(--text)` (#FFF2EB)
- Muted: `var(--muted)` (#9CBDE7)
- Card bg / glass tokens: `var(--glass-card-bg)` + existing `.glass-card` class
- Border: `var(--border)`

**Typography rules this redesign introduces/reinforces:**
- ALL CAPS is reserved for small metadata labels only (e.g. existing "LYS TIL", "SOLSCORE"). Do not use CAPS on primary hero text — use sentence case.
- `font-variant-numeric: tabular-nums` on any time/duration values.

**The prototype HTML inlines its own styles for demonstration.** Don't copy those into production — translate to the existing CSS structure. Reuse existing `.glass-card` class; add new class names scoped to list card (e.g. `.venue-card`, `.venue-card-left`, `.venue-card-right`, `.venue-card-hero`, `.venue-card-hero-main`, `.venue-card-hero-sub`, `.venue-card-timeline`).

---

## Workflow

Per `CLAUDE.md`:
- No build step. Open `index.html` in a browser to verify.
- Commit and push after each meaningful milestone (list card done, detail panel done, data wiring done).
- Follow the layout debugging protocol if anything looks off — `node scripts/audit-layout.mjs <element>` first.

Suggested commit boundaries:
1. List card markup + CSS (static placeholder data OK if state helper not yet wired)
2. State determination helper (probably in `js/ui-shared.js` or a new tiny module)
3. Wire state helper into list cards
4. Detail panel header + primary action row
5. Detail panel sun section + sun-retning section
6. Detail panel info list
7. Remove old solscore + old dial code
8. Cleanup + audit pass

---

## Reference the prototype

File: `design/prototype-redesign.html`

Open it in a browser. The right column of each `.grid` block is the
target. Annotations beneath each column explain intent. The legend at
the bottom summarizes the changes.

If the prototype shows something not spec'd above, trust the prototype.
If the spec is more detailed than the prototype, trust the spec.

---

## Verification before finishing

1. **Visual match**: Open `index.html` in a browser. Compare list cards
   and detail panel side-by-side with `design/prototype-redesign.html`.
   Typography, spacing, colors should match.
2. **State coverage**: Manually verify at least one venue in each state
   (sun / shadow / done) by scrubbing the time slider to different hours.
3. **Edge cases**: Venue with no phone → phone button absent. Venue with
   zero sun today → `done` state card shows at bottom with 50% opacity.
4. **Mobile layout**: Resize browser to ~390px wide. Cards should remain
   readable, hero column should not wrap. Detail panel should scroll cleanly.
5. **Audit**: Run `node scripts/audit-layout.mjs venue-card` and
   `node scripts/audit-layout.mjs detail-panel` — no unexpected conflicts.
6. **No regressions**: Selecting a venue on the map still opens detail
   panel. Infinite scroll still works. Sort chip still changes order.

Do not commit a "maybe this works" change. If root cause is unclear
after investigation, say so in the commit message or pause and ask.
