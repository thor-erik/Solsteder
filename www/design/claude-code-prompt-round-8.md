# Prompt for Claude Code — calendar picker polish, round 8

Paste everything below into Claude Code on the same branch as round 7. Rounds 1–7 must already be applied. Every task updates behavior plus `DESIGN.md` where noted. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

The docked control group is landing well. The calendar picker has drifted from the rest of the visual system and needs a polish pass covering: sticky month-header behavior (currently half-implemented and rendering duplicates), oversized full-calendar tiles, off-system button styling on the mode toggles, dashed borders that don't exist elsewhere in the system, inconsistent today-dot placement, and a week-number column that doesn't earn its keep.

---

## Task 1 — Fix the sticky month-header (Apple Calendar pattern)

**Problem.** The full-calendar view currently renders `APRIL 2026` twice — once as a section header above the weekday row and once inline above the month grid. This isn't two separate elements; it's a half-implemented sticky header.

**Intended behavior** (Apple Calendar / iOS Calendar scroll pattern):

1. A single weekday row (`M T W T F S S`) sits pinned at the very top of the scroll area. It never moves.
2. Each month has one inline month-label header (`APRIL 2026`, `MAY 2026`, `JUNE 2026`) sitting directly above its grid.
3. As the user scrolls down, the current month's label pins just below the weekday row (`position: sticky; top: [weekday-row-height]`).
4. The pinned label stays put while the user scrolls through that month's grid.
5. When the next month's label scrolls up and reaches the same pin position, the two sticky elements naturally displace — the new month's label pushes the previous one up and off-screen. This is the "month rolls over" effect.

**Do:**

1. Restructure the calendar DOM so there is **one** month-label element per month, not two. Remove whatever duplicate rendering exists — whether it's a top-level "current month" label separate from the inline section headers, or inline labels being duplicated.
2. Render order inside the scroll container:
   ```
   [weekday row — sticky, top: 0]
   [month 1 label — sticky, top: <weekday-row-height>]
   [month 1 grid]
   [month 2 label — sticky, top: <weekday-row-height>]
   [month 2 grid]
   ...
   ```
3. CSS pattern:
   - Weekday row: `position: sticky; top: 0; z-index: 2;`
   - Each month label: `position: sticky; top: <weekday-row-height>px; z-index: 1;`
   - Background for both: `rgba(20,46,82,0.85)` with `backdrop-filter: blur(12px)`. This is critical — without a backdrop, grid tiles scrolling underneath will show through the pinned header and the pattern looks broken. The `0.85` opacity is a touch more opaque than the standard glass-panel so the stacking reads cleanly.
   - Bottom hairline on weekday row: `1px solid rgba(156,189,231,0.12)` so it reads as a section divider against scrolling content below.
4. Verify the push transition works — when two month labels approach the pin position simultaneously during a scroll, they should visibly "hand off" rather than flicker or overlap. If there's jitter, check that both elements have the same `top` value and that neither has a transform/translate that breaks sticky behavior.
5. The 10-day view is not affected by this task — it has no sticky headers to worry about.

**Update DESIGN.md → Calendar picker → Full calendar:**

Add a short subsection titled "Scroll behavior" describing: single weekday row pinned at top, each month label sticky below the weekday row, label push-up on month rollover. No need to re-explain the CSS — the rule is about behavior, not implementation.

---

## Task 2 — Shrink full-calendar day tiles to spec

**Problem.** Day tiles in the full calendar render at roughly `90px+` height, which makes the picker absurdly long and forces the user to scroll even to see April + May. Round 6 spec was `48–56px` square.

**Do:**

1. Day tile dimensions: `48px` tall on mobile, `width = (100% - 6*4px) / 7` (column fills). Gap: `4px` horizontal and vertical.
2. Content inside the tile, top-to-bottom:
   - Day number: `15pt / 600 / --text`, centered horizontally, `4px` top padding.
   - Weather glyph: `14px`, centered below number, `2px` gap. Only rendered for days inside the 10-day forecast horizon.
   - Today-dot: `3px` below glyph (or below day number if no glyph). See Task 5 for placement rule.
3. Selection ring: implemented as `box-shadow: inset 0 0 0 2px var(--accent)` so it doesn't cause layout shift. `--accent-dim` inset glow via a pseudo-element if needed.
4. Tap target: the visible tile is `48px`, but the hit region should be enlarged by `2px` on each side (via padding in an invisible wrapper) so effective touch area is ~`52px`. This keeps the grid tight visually without sacrificing touch ergonomics.
5. Verify at mobile width (`375px` viewport): 7 columns at `48px` + 6 gaps at `4px` = `360px`, leaves `8px` horizontal padding on each side of the grid. Tight but workable.

**Update DESIGN.md → Calendar picker → Full calendar:**

Update any tile-dimension language to `48px` explicitly. Remove ambiguity of `48–56px`.

---

## Task 3 — Convert mode toggle buttons to glass-action

**Problem.** `Show full calendar` and `Collapse calendar` currently render with an accent-orange outline and accent-orange text. This violates the DESIGN.md rule that `--accent` is reserved for interactive selected state (selected time, selected day, primary CTA affordance). These two buttons are mode toggles, not primary CTAs — they're secondary chrome.

**Do:**

1. Restyle both buttons to **glass-action** flavor per DESIGN.md:
   - Background: `rgba(20,46,82,0.45)` with `backdrop-filter: blur(10px)`
   - Border: `1px solid rgba(156,189,231,0.18)`
   - Height: `44px`
   - Radius: `12px`
   - Label typography: `13pt / 600 / --text`
   - Trailing chevron (`▾` when collapsed, `▴` when expanded): `10×6px` SVG triangle, `--muted` color, matching the round 6 readout chevron spec
2. Width: `100%` of the picker sheet's inner width, minus the sheet's horizontal padding. So the button stretches edge-to-edge within the padded content area.
3. At-rest state: no accent. Hover/focus (pointer devices): `background: rgba(20,46,82,0.55)`. Pressed: `background: rgba(20,46,82,0.35)`.
4. Label copy:
   - Collapsed state (10-day mode): `Vis full kalender ▾` — switch to Norwegian to match the rest of the app. Current `Show full calendar` is an English holdover.
   - Expanded state (full calendar mode): `Skjul full kalender ▴`.

**Update DESIGN.md:**

- Under the Calendar picker section, specify: mode toggle buttons use glass-action flavor, Norwegian labels, trailing SVG triangle chevron. No accent treatment.

---

## Task 4 — Replace dashed borders on beyond-horizon tiles

**Problem.** Days beyond the 10-day forecast horizon (May 1+) render with a dashed border. Dashed borders aren't used anywhere else in DESIGN.md — they read as prototype placeholders, not finished UI.

**Do:**

1. Beyond-horizon tiles: same solid glass-card background as forecast tiles, but at reduced opacity — `rgba(20,46,82,0.25)` instead of the standard `rgba(20,46,82,0.50)`. Border opacity drops proportionally: `1px solid rgba(156,189,231,0.10)`.
2. Day number inside beyond-horizon tiles: `--muted` color instead of `--text`.
3. No weather glyph, no temperature, no today-dot.
4. Tiles remain tappable — tapping sets the selected date; the picker auto-dismisses per round 6; the time bar updates for the selected date even though no forecast data is available. The time bar itself will need to handle the "no forecast for this date" case (show weather-ramp at neutral/overcast or dim the whole bar with a "Værvarsel ikke tilgjengelig" overlay — that's a separate concern, out of scope for this round but worth flagging in the PR).

**Update DESIGN.md → Calendar picker → Full calendar:**

Replace the "dashed outline" language with: "Beyond-horizon tiles use glass-card background at reduced opacity (`rgba(20,46,82,0.25)`), muted day number, no glyph. They remain selectable." Explicitly forbid dashed borders anywhere in the calendar.

---

## Task 5 — Unify today-dot placement

**Problem.** The today-dot appears in different positions in the 10-day view vs the full-calendar view. In 10-day it sits below the day number; in full-calendar it appears to float top-right. Inconsistent.

**Do:**

1. Today-dot lives **below** the day number (or below the weather glyph if one is present) in both views. Never top-right, never floating.
2. Specs:
   - Diameter: `4px`
   - Color: `--accent`
   - Centered horizontally within the tile
   - Gap above the dot: `3px`
3. When a day is both today AND selected: render both the selected ring and the dot. The dot doesn't change color when selected (it stays `--accent`; the ring is also `--accent`; they're consistent).

**Update DESIGN.md → Calendar picker:**

Add a one-line rule: "The today-dot sits centered below the day's content (number or glyph) in all picker views. 4px diameter, `--accent`."

---

## Task 6 — Drop the week-number column

**Problem.** Full-calendar view renders a week-number column (`17 18 19 20 21 22 23`) on the left. Week numbers are useful for work scheduling but Solsteder users are picking dates for leisure — weekend, after work, next sunny day. The column adds horizontal space pressure (the already-tight 7-column grid becomes 7 columns + a sidebar), increases visual noise, and doesn't earn its keep.

**Do:**

1. Remove the week-number column entirely from the full-calendar view.
2. The month grid is now a clean `7 × N` grid, no sidebar.
3. This gives back ~`20–28px` of horizontal space for the day tiles — tiles can stay at `48px` or optionally scale up slightly if the `48px` minimum was tight.

**Update DESIGN.md:**

No explicit mention of week numbers exists to remove. If any was added, remove it. No new rule needed — we're not going to add them back.

---

## Task 7 — Final DESIGN.md pass

After Tasks 1–6:

1. Verify the Calendar picker section now covers: sticky scroll behavior, tile dimensions at `48px`, glass-action mode-toggle buttons with Norwegian labels, no dashed borders, unified today-dot placement, no week-number column.
2. Verify no leftover references to the dual-APRIL-header implementation or the accent-outline button styling.
3. Flag any contradictions in the PR description.

---

## Success criteria

- The full calendar renders exactly one month label per month. Scrolling produces the Apple-style sticky-pin behavior — current month stays pinned below the weekday row, new month pushes it up on rollover.
- Day tiles are visibly compact. April + May + June fit in roughly the height of a phone screen without excessive scrolling.
- Both mode toggle buttons use glass-action styling with no accent-color chrome. Labels are in Norwegian.
- No dashed borders appear anywhere in the picker.
- Today-dot appears in the same position (centered below content) in both 10-day and full-calendar views.
- The full-calendar grid has no left sidebar — just the 7-column day grid.

---

## Out of scope

- The "no forecast data for this date" state on the time bar when a beyond-horizon day is selected. Flag in the PR for a future round.
- Changing the picker's open/close behavior.
- Docked group, venue list, map, or detail panel.

---

## Reporting

Per task: short summary of file changes and any spec deviations with justification. Task 1 is the structurally largest — include a brief note on whether the sticky behavior is working cleanly at the month-rollover transition or whether there's residual jitter worth follow-up. Final report ends with the DESIGN.md diff surfaced separately.
