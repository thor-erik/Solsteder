# Prompt for Claude Code — calendar picker, icon weight, bar clipping, round 5

Paste everything below into Claude Code on your working branch. Rounds 1–4 must already be applied. Every task updates behavior plus `DESIGN.md` — keep the doc diff scoped to rules that actually change. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

Round 4 landed the inline `📅 Today, 12:45` readout phrase, the slim pill thumb, the dimmed past state, and the sort chip alignment. Three things now need fixing or designing:

1. The calendar icon in the readout reads as visually disconnected from the text — wrong height, thinner stroke, and nothing in the line signals "tap here to change date."
2. The time bar's weather-color segments don't reach the container's rounded corners — there's a visible gap on the left and right edges where the track background shows through.
3. The calendar picker itself is unspecified. It has two modes (10-day forecast strip, full-month calendar) and we haven't decided how it opens, where it lives, or how it coexists with the time bar.

---

## Task 1 — Fix the calendar affordance in the readout phrase

**Problem.** The leading 12px calendar glyph sits too small next to the 24pt / 700 text — cap height mismatch — and its ~1.5px stroke reads anemic against a heavy-weight font. The bigger issue: nothing in the line says "tap me." A calendar icon is an informational marker, not an affordance.

**Do:**

1. **Remove the leading calendar icon entirely.** The accessible label on the `<button>` already communicates "change date" to screen readers — the visual icon was redundant.
2. **Add a trailing down-chevron** after the date portion, before the comma. Result: `Today ▾, 12:45`, `Tomorrow ▾, 12:45`, `Man 20 Apr ▾, 12:45`.
   - Chevron glyph or 10–12px SVG. Color `--muted`. Same vertical baseline as the text.
   - Gap between date text and chevron: `4px`.
   - The chevron is inside the `<button>` hit region along with the date text.
3. **Button hit region** remains the date portion + chevron (not the comma, not the time). No visible pill background at rest, but on hover (pointer devices) and `:focus-visible`, show a subtle background: `rgba(156,189,231,0.08)`, radius `6px`, inset `2px` horizontal padding. On mobile, the hit area extends invisibly by 8px on all sides to hit the 44×44 minimum.
4. **Active/pressed state:** flash `--accent-dim` background for `--transition-fast` (120ms) on tap, then either open the picker or release back to idle.
5. **Never wrap** still applies. On width degradation, drop the weekday before dropping the chevron — the chevron is load-bearing for interactability and stays last.

**Update DESIGN.md → Readout panel (Tier 1 bullet):**

Replace the current Tier 1 description with:

> **Tier 1** — inline date + time phrase on one line: `[date portion, --muted, 24pt/700][▾ chevron, --muted, 10–12px][comma, --muted][space][time portion, --accent, 24pt/700]`. Examples: `Today ▾, 12:45` / `Man 20 Apr ▾, 12:45`. The date portion and the chevron together form the calendar trigger (a `<button>` with aria-label "Change date"). The time portion is not interactive. The line must never wrap; on narrow widths degrade by dropping the weekday abbreviation first; the chevron is the last thing to drop. No leading icon — the chevron is the sole visual affordance. No separate date pill exists.

Also remove any remaining references to a leading 12px calendar icon in the readout section.

---

## Task 2 — Fix the time bar edge clipping

**Problem.** The weather-color segments don't reach the left and right rounded corners of the bar container. A thin strip of the track background shows through at each end, breaking the "continuous weather band" illusion.

**Do:**

1. On the bar container (the element with `border-radius: 12–14px`), set `overflow: hidden`.
2. On the segment row (the direct flex/grid child holding the hour segments), set `padding: 0`, `margin: 0`, `width: 100%`. The first segment's left edge and the last segment's right edge must sit flush against the container's inner border.
3. Verify the inset shadow (`inset 0 1px 2px rgba(0,0,0,0.15)`) sits on the container, not on the segment row — it should render on top of the segments at their top edge, inside the rounded corners.
4. Do the same for the axis-label row below the bar — if labels are clipped, move them outside the `overflow: hidden` container rather than inside it. Labels should not be clipped by the bar's radius.

**No DESIGN.md change** — the existing rule already says "Clip segments inside the container so leftmost/rightmost segments inherit rounded edges naturally." The implementation drifted; this task brings it back. If you find a contributing factor that the rule doesn't cover (e.g. a required CSS property), add one clarifying sentence under the Time bar section.

---

## Task 3 — Design and build the calendar picker

**Problem.** Tapping the date chevron needs to open a date picker. We haven't specified what that picker looks like, where it appears, or how it coexists with the rest of the screen. It has two modes: a compact 10-day strip (default) and a full-month calendar (expansion).

### Interaction model

Opening the picker **must not cover the time bar or readout**. The value of Solsteder is "when will I find sun" — being able to preview `Tomorrow 13:30` by changing the date while the time bar updates live is the core flow. A full opaque modal severs that link.

**Pattern:** the picker is a glass-panel sheet that **slides in from the top** on mobile (or expands downward from the trigger on wider viewports), pushing the map out of the way but leaving the docked time bar + readout + list peek fully visible. Tapping a day updates the selected date in real time — the time bar's weather segments and the readout both re-render for the new date. The picker stays open until dismissed.

**Dismiss:** tap the chevron again (now rotated 180° to signal close), tap anywhere on the map outside the sheet, swipe up on the sheet, or press Escape (desktop).

### Default state: 10-day strip

1. Horizontal scrolling (or snapping) strip of ~10 days, starting at today.
2. Each day tile:
   - Width: fills 1/5 of sheet width on mobile (5 tiles visible, rest scroll), fixed `72px` on wider viewports.
   - Height: `88px`.
   - Content: weekday abbreviation (top, `11pt / 600 / --muted`, letter-spacing 0.5px), day number (`20pt / 700 / --text`), weather glyph (`16px`, `--muted`), high/low temps (`11pt / 500 / --muted`, format `18° / 8°`).
   - Background: glass-card level.
   - Radius: `10px`.
   - Gap between tiles: `8px`.
3. **Selected state:** ring, not fill. `2px solid --accent` with `--accent-dim` inset glow. Day number text shifts to `--accent`. Do not fill the tile background with `--accent` — the day tile does not carry weather data color (that's a separate concern), so we don't have the collision risk the time bar thumb has, but the ring treatment is still cleaner and consistent with other "selected" states in the app.
4. **Today indicator:** thin `--accent` dot below the day number when the tile represents today, whether selected or not. Dot size: `4px`.
5. **Past days:** same dim rule as the time bar — `opacity: 0.45`, non-selectable. Soft-clamp the scroll so users can't scroll into the past.

### Expansion: full calendar

1. Below the 10-day strip, a button: `Show full calendar ▾` (chevron down). Label `13pt / 600 / --text`, centered, glass-action background, standard action-pill.
2. On tap, the 10-day strip collapses upward (or stays visible as a week row) and a full month grid appears below it. The month grid is:
   - 7 columns (Mon–Sun, Norwegian convention).
   - Day tiles sized to fit the sheet width, roughly `44–52px` square.
   - Same content structure as 10-day tiles but denser: day number (larger, `17pt / 600`), weather glyph only (no temps on phone; show temps on wider viewports if space allows).
   - Selected state: same ring treatment.
   - Past days: dim + non-selectable.
3. Month navigation: header row with `‹ April 2026 ›`, chevrons tappable to step month. Keep month-header text at `15pt / 600 / --text`, chevrons `--muted` in 44×44 tap targets.
4. Button label changes to `Hide full calendar ▴` (chevron up) while expanded. Tap collapses back to 10-day-only.
5. Do not render weather data for days beyond ~10 days out — there is no reliable forecast. Those tiles show day number + weekday only, no glyph, no temps, `--muted` color. A small `--muted` footnote under the month grid: "Værvarsel er tilgjengelig for de neste 10 dagene."

### Sheet spec

- Background: glass-panel (`rgba(20,46,82,0.55)`, blur `16px`). Same level as the readout+bar wrapper so the two surfaces feel related.
- Border: `1px solid rgba(156,189,231,0.18)` on the bottom edge (the only non-screen edge on mobile top-sheet).
- Elevation: `mid` (`0 6px 24px rgba(0,0,0,0.50)`).
- Slide-in: `--transition-base` (220ms), ease-out, translateY.
- Padding: `16px` on all sides.
- Max height on mobile: roughly 55% of viewport height when expanded to full calendar; ~30% when in 10-day-only mode. Do not force the bottom sheet (list peek) to disappear — the two can coexist in the middle-screen map area.

### Accessibility

1. The sheet is a `<dialog>` or role="dialog" with focus trap while open. On open, focus moves to today's tile.
2. Keyboard nav: arrow keys move focus between days (left/right inside a week, up/down across weeks). Enter selects. Escape closes.
3. The chevron after the date in the readout: `aria-expanded` reflects sheet state, flips between "Change date" label and "Close date picker" label.

### Update DESIGN.md

Add a new section under Components titled **Calendar picker (sheet)** with the spec above, condensed. Cover:
- Opening from the date chevron, sliding from top, glass-panel level.
- Two modes: 10-day strip (default) and full month (expanded via explicit button).
- Selected-day treatment: ring, not fill. Reason: keeps the tile-selection language distinct from data-color language elsewhere.
- Past-day treatment: same `opacity: 0.45` rule as the time bar (cross-reference the existing Past/disabled section).
- Forecast horizon: no weather glyphs/temps beyond 10 days. Explicit footnote in Norwegian.
- Never covers the time bar, readout, or list peek. The picker is contextual, not modal.

Also add a principle-level rule under **Principles** (or extend an existing one): "Pickers and secondary inputs should preserve the context their selection affects. If changing value X updates display Y, Y should remain visible while the picker is open." This codifies why the date picker doesn't take over the screen.

---

## Task 4 — Tile selection vs data color (collision rule)

**Problem.** The weather ramp is used for forecast data visualization (time bar segments, and now the day-tile weather glyph backgrounds if we're not careful). `--accent` is used for interactive state (selected, focused). If a day tile uses weather color for the fill AND we want to show selection, we re-hit the thumb/full-sun collision problem.

**Do:**

1. Day tiles in the calendar picker do not fill their background with a weather-ramp color. Weather is carried by the small glyph + temperature text inside the tile; the tile background stays glass-card neutral.
2. Selection uses a ring (`2px solid --accent` + `--accent-dim` inset), not a fill.
3. Today uses a dot indicator, not a color.

**Update DESIGN.md:**

Add a short rule under the Weather data ramp section:

> **Collision rule:** when an element could simultaneously show weather data and a selected/focused state, weather goes in a sub-element (glyph, inline color, small ramp chip) and the outer container stays neutral. Selected state uses `--accent` on the outer container (ring, border, or text). Never paint weather-ramp color on a container that also needs to signal selection.

This rule already exists implicitly for the time bar thumb; writing it down generalizes it so future components don't have to rediscover it.

---

## Task 5 — Final DESIGN.md pass

After Tasks 1–4:

1. Verify Tier 1 description in the Readout panel section reflects the chevron affordance and the removal of the leading calendar icon.
2. Verify the Calendar picker (sheet) section is present, complete, and cross-references the Past/disabled and Weather data ramp sections instead of duplicating their rules.
3. Verify the Collision rule is added under Weather data ramp.
4. Verify the new principle about preserving context is in the Principles list.
5. Flag any contradictions in the PR description rather than silently resolving them.

---

## Success criteria

- The readout phrase reads as interactable without a leading icon — the trailing chevron is sufficient signal. Hover/focus/press states are visible where appropriate.
- The time bar's weather fills reach all four rounded corners of the container. No track background visible at the edges.
- Tapping the chevron opens the calendar picker as a top-sheet that does not cover the time bar, readout, or first venue peek. Tapping a day updates the time bar + readout live.
- "Show full calendar" expands to a month view; collapse button returns to 10-day mode.
- Past days are dimmed and non-selectable in both picker modes, matching the time bar's treatment.
- Days beyond 10-day horizon show no weather data; a Norwegian footnote explains why.
- No day tile uses weather-ramp color as a background fill.

---

## Out of scope

- Map styling, pin layout, detail panel internals, venue card redesign.
- The underlying weather forecast fetching — only the UI that consumes it.
- Multi-day range selection. Picker is single-day only.
- Calendar event integration (Google Calendar, etc.) — not happening.

---

## Reporting

Per task: short summary of file changes and any spec deviations with justification. Final report ends with the DESIGN.md diff surfaced separately so the doc changes are easy to review in isolation. Pay particular attention to the new Calendar picker section — it's the largest addition to the doc and easiest to leave half-specified.
