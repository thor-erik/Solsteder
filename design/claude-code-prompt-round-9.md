# Prompt for Claude Code — calendar picker layout and priority, round 9

Paste everything below into Claude Code on the same branch as rounds 7 and 8. Rounds 1–8 must already be applied. Every task updates behavior plus `DESIGN.md` where noted. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

The calendar picker now has correct structure (sticky headers, tile sizing, glass-action mode toggles, unified today-dot spec on paper, no dashed borders, no week-number column). Six refinements remain — mostly around how the picker claims space on the screen and how it coexists with the other surfaces. The search bar shouldn't stay half-visible while the picker is open; the picker shouldn't fight the expanded list for vertical space; the sheet drifted from its intended glass treatment; and two specific elements (today-dot placement, sort chip styling) regressed or never landed.

---

## Task 1 — Picker claims the search bar's space

**Problem.** When the calendar picker is open, the search bar stays visible at the top of the screen but is non-functional (inputs are blocked by the picker above it). The result: wasted vertical real estate and a misleading chrome element that looks tappable but isn't.

**Do:**

1. When the picker opens, the search bar **slides up and out of view** with `--transition-base` (220ms, ease-out). The picker sheet's top edge takes over the search bar's former space, flush to the top of the safe area.
2. When the picker dismisses, the search bar **slides back in** from the top with the same transition. The picker slides down/out in the same motion.
3. Implementation: translate the search bar's container by `-100%` of its own height (plus any top safe-area inset). No opacity animation, no fade — a clean translate keeps the motion readable.
4. Inside the picker, the top edge of the picker sheet now sits at `top: var(--safe-area-top, 0px)` (no longer offset by the search bar's height). Update the CSS from round 6 that was offsetting the sheet below the search bar.

**Update DESIGN.md → Calendar picker (sheet):**

Replace the earlier rule ("The picker opens below the app's top chrome — search bar — not over it. Top chrome remains interactive while the picker is open.") with:

> The picker claims the full top of the screen when open. The search bar slides up and out of view during the open transition and slides back in on dismiss — synchronized with the picker's own slide animation. Chrome that cannot be acted on while the picker is active should not occupy screen space.

Also, in the Principles section, add or extend: "Chrome that is unusable during a modal task should not remain visible — hide it rather than disable it."

---

## Task 2 — Opening the picker auto-collapses the list to peek

**Problem.** When the venue list is expanded and the user opens the calendar picker, the two surfaces fight for vertical space. The full calendar becomes unusable (April barely visible, May cut off) because the expanded list occupies the bottom half of the screen.

**Do:**

1. When the picker opens, if the list sheet is expanded, **auto-collapse it to its peek state** with `--transition-base` (220ms, ease-out). The list's expanded position is saved in memory for the duration of the picker's open state.
2. When the picker dismisses, the list sheet **restores** to whatever state it was in before (expanded or peek). Same `--transition-base` animation.
3. While the picker is open, the user cannot manually expand the list. The list's drag handle responds to swipe-up gestures only after the picker is dismissed. (Alternative: a swipe-up on the list while picker is open dismisses the picker first, then expands the list — this is the smoother interaction and what I'd suggest, but only if it's cheap to implement.)
4. The docked group (calendar button, weather, time, slider) stays in its fixed position throughout. Picker above it, list peek below it.

**Update DESIGN.md → Calendar picker (sheet):**

Add: "Opening the picker auto-collapses the venue list sheet to its peek state for the duration of the picker's open state. The list returns to its prior expansion state when the picker dismisses."

**Update DESIGN.md → List peek:**

Add a cross-reference: "The venue list's expansion state is overridden temporarily when the calendar picker opens. See Calendar picker → open-state behavior."

---

## Task 3 — Restore glass-panel transparency on the picker sheet

**Problem.** Round 5 specified the picker sheet background as `glass-panel` (`rgba(20,46,82,0.55)` + `blur(16px)`), matching the venue list and docked group. The implementation drifted to a near-solid fill, so the picker feels like a separate page rather than an overlay. The map behind the picker should remain faintly visible, the same way it does behind the venue list sheet.

**Do:**

1. Picker sheet base background: `rgba(20,46,82,0.55)` with `backdrop-filter: blur(16px) saturate(120%)`. Exactly matches `glass-panel` elsewhere in DESIGN.md.
2. Border (bottom edge of the sheet): `1px solid rgba(156,189,231,0.18)`.
3. Sticky headers inside the picker (weekday row, month labels) **retain** the higher-opacity treatment from round 8: `rgba(20,46,82,0.85)` + `blur(12px)`. This is necessary so grid tiles scrolling underneath don't show through the pinned headers. Only the sticky headers need this — the sheet base must stay translucent.
4. Day tiles continue to use `glass-card` background (already correct).
5. Verify at runtime: the map should be visibly (if faintly) readable behind the picker when nothing is scrolling. The picker should feel like an overlay, not a new page.

**Update DESIGN.md → Calendar picker (sheet):**

Clarify: "Sheet base uses `glass-panel`. Only sticky headers use a denser variant for legibility during scroll. Never apply a solid or near-solid fill to the sheet base — the picker must read as an overlay, not a new screen."

---

## Task 4 — Fix today-dot placement

**Problem.** Round 8 spec'd the today-dot "centered below the day's content (number or glyph)." In the current implementation on the 10-day view, it renders between the weekday abbreviation (`MON`) and the day number (`20`) — above the number, not below. The dot landed in the wrong slot.

**Do:**

1. Today-dot lives **below** all content in the tile. Order top-to-bottom in every tile type:
   - 10-day tile: weekday abbr → day number → weather glyph → today-dot (if applicable) → temp
   - Wait, that puts the dot above the temp. Revise:
   - **Correct order** — weekday abbr → day number → weather glyph → temp → today-dot
2. Full-calendar forecast tile: day number → weather glyph → today-dot
3. Full-calendar beyond-horizon tile: day number → today-dot (no glyph, no temp). Today-dot is unlikely to apply here since "today" is always inside the forecast horizon, but keep the positioning rule consistent.
4. Dot specs unchanged from round 8: `4px` diameter, `--accent`, centered horizontally, `3px` gap above.

**Update DESIGN.md → Calendar picker:**

Replace the current today-dot rule with the explicit tile-content order above. Make clear the dot is the **last** element vertically, not positioned near the number.

---

## Task 5 — Fix the sort chip styling

**Problem.** The sort chip (`Sort: Score ▾`) in the expanded list view appears to have an accent-orange border. If that's `--accent`, it violates the rule that `--accent` is reserved for interactive selected state — the sort chip is not a "selected" element, it's a trigger for a menu.

**Do:**

1. Verify current sort chip styling. If it uses `--accent` for border, text, or chevron, replace with glass-action flavor:
   - Background: `rgba(20,46,82,0.45)` + `blur(10px)`
   - Border: `1px solid rgba(156,189,231,0.18)`
   - Height: `36px`
   - Label: `Sort: Score` in `13pt / 600 / --text`
   - Chevron: `▾` SVG triangle from round 6, `10×6px`, `--muted`
2. When the sort menu is open (dropdown/sheet showing), the chip's chevron rotates 180° (`▴`). Do not add an accent background to signal "open" — the chevron rotation is enough.
3. Confirm alignment with the list's right content edge (round 3 rule still applies).

**Update DESIGN.md → Progressive disclosure (or Sort chip if a dedicated section exists):**

Add: "The sort chip uses glass-action flavor. It is never styled with `--accent` at rest or when its menu is open. State changes are signaled via chevron rotation, not color."

---

## Task 6 — Shrink beyond-horizon tiles in full calendar

**Problem.** May and June tiles take the same vertical space as forecast tiles despite carrying no content (no weather glyph, no temp). This inflates the full calendar's total height for no reason.

**Do:**

1. Beyond-horizon tiles use a shorter height: `34px` (roughly 70% of the forecast tile's `48px`). Width stays in the 7-column grid layout.
2. Content inside: day number only, centered vertically, `15pt / 500 / --muted` (slightly lighter weight than forecast-tile numbers because these aren't active forecast data).
3. Row gap between two beyond-horizon rows stays `4px`; no special treatment for the transition from forecast rows to beyond-horizon rows.
4. The full calendar remains continuously scrollable — no month cap. Users can scroll indefinitely into the future; tile heights stay at `34px` past the forecast horizon.
5. Footnote "Værvarsel er tilgjengelig for de neste 10 dagene." stays as is, positioned between the forecast section and the first beyond-horizon section.

**Update DESIGN.md → Calendar picker → Full calendar:**

Add a line: "Beyond-horizon tiles use a reduced height (`34px`) and day-number-only content in `--muted`. Forecast-horizon tiles remain at `48px`." Remove any ambiguity about beyond-horizon tile dimensions.

---

## Task 7 — Final DESIGN.md pass

After Tasks 1–6:

1. Verify the Calendar picker section now describes: search-bar-hide-on-open behavior, list-auto-collapse behavior, glass-panel sheet base (with denser sticky headers), explicit today-dot vertical ordering per tile type, beyond-horizon tile reduced height.
2. Verify no stale references remain to the old "picker opens below search bar" rule from round 6.
3. Verify the sort chip rule is added under the relevant section.
4. Flag any contradictions in the PR description.

---

## Success criteria

- Opening the picker hides the search bar via a synchronized slide; dismissing the picker reveals it again.
- Opening the picker when the list is expanded auto-collapses the list to peek; dismissing the picker restores the list's prior state.
- The picker sheet is translucent — the map is faintly readable behind it, matching the venue list sheet's feel. Sticky headers remain legible during scroll.
- Today-dot appears below all tile content (last vertically), not between the weekday abbreviation and day number.
- Sort chip uses glass-action flavor, no accent color. Chevron rotates on open.
- Beyond-horizon tiles are visibly shorter than forecast tiles; the full calendar is less bloated through May and June.
- Full calendar continues to scroll indefinitely — no month cap.

---

## Out of scope

- Docked group adjustments (round 7 stands).
- Time bar behavior when a beyond-horizon day is selected — still flagged as a future round.
- Detail panel, map, venue cards.

---

## Reporting

Per task: short summary of file changes and any spec deviations with justification. Tasks 1 and 2 together represent the largest behavior change — note any interaction edge cases encountered (e.g. what happens if the user triple-taps rapidly between picker and list states). Final report ends with the DESIGN.md diff surfaced separately.
