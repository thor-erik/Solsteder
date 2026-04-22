# Prompt for Claude Code — picker fixes, chevron, bar clipping follow-up, round 6

Paste everything below into Claude Code on your working branch. Rounds 1–5 must already be applied. Every task updates behavior plus `DESIGN.md` where noted — keep the doc diff scoped. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

Round 5 landed the inline chevron, the calendar picker sheet, and the first attempt at fixing the bar edge clipping. Six things need repair:

1. The chevron after the date renders as a thin Unicode glyph (looks like `ᵥ`). It needs to be an actual filled triangle, weighted to match the `700` text beside it.
2. The time bar's weather segments still don't reach the container's rounded corners — the fix widened the container instead of extending the segments.
3. The search bar at the top of the screen overlaps the open calendar picker.
4. The 10-day forecast is implemented as a horizontally scrollable list. We want all 10 days visible without scroll, so users can see the full horizon at a glance.
5. The full-calendar day tiles are cramped; temperature labels spill outside the tile bounds.
6. Selecting a date in the picker should close the picker automatically — right now it stays open.

---

## Task 1 — Replace the chevron with a proper filled triangle SVG

**Problem.** Unicode `▾` rendered in the user's font stack came out as a thin, under-weighted glyph that reads as a typographic accident. It doesn't match the `700` weight of the surrounding text.

**Do:**

1. Replace the Unicode chevron with an inline SVG triangle. Suggested path (viewBox `0 0 10 6`):
   ```html
   <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true" fill="currentColor">
     <path d="M0 0 L10 0 L5 6 Z"/>
   </svg>
   ```
2. Color: `currentColor`, which inherits `--muted` from the button. When the button has `:hover` or `:focus-visible`, bump to `--text`.
3. Size: `10px × 6px` (wider than tall — reads as a chevron, not an arrow). On the `24pt/700` text baseline, this optically matches the x-height of the text without competing with the letterforms.
4. Vertical alignment: the triangle sits on the same baseline as the cap of the text, slightly below center — same optical position as a dropdown indicator in macOS/iOS. Adjust with a small `translateY` if needed (typically `1–2px` below text center).
5. Rotation on open: when the picker is open, rotate the SVG `180deg` via `transform` with `--transition-fast`. Flip `aria-expanded` on the button simultaneously.
6. Leave a `6px` gap between the date text and the triangle, and keep the comma immediately after the triangle (no space). Result: `Today▾, 14:15` with the triangle being an inline SVG, not a Unicode character.

**Update DESIGN.md → Readout panel (Tier 1):**

Amend the Tier 1 description: the trailing chevron is a `10×6px` filled-triangle SVG, not a Unicode glyph. It inherits `currentColor` from the button (idle `--muted`, hover/focus `--text`). Rotates 180° when the picker is open.

---

## Task 2 — Actually extend the segments to the container edges

**Problem.** The previous fix enlarged the bar container width rather than extending the segment row to fill it. The gap at the rounded corners is still visible.

**Do:**

1. Inspect the current DOM. The bar should be a container with:
   ```
   .time-bar-track {
     border-radius: 12–14px;
     overflow: hidden;
     padding: 0;            /* critical */
     position: relative;
   }
   ```
2. The segment row lives as a direct child:
   ```
   .time-bar-segments {
     display: flex;
     width: 100%;
     height: 100%;
     margin: 0;
     padding: 0;
     gap: 0;                /* no divider gaps */
   }
   ```
3. Each segment is a flex child with `flex: 1 1 0`, no individual border, no margin. The segment's background color (from the weather ramp) fills its entire bounding box.
4. Axis labels (the hour numbers `6 8 10 12 ...`) live **outside** `.time-bar-track` — as a sibling element below it. They are **not** inside the `overflow: hidden` container. This prevents labels from being clipped by the bar's radius.
5. The inset shadow (`inset 0 1px 2px rgba(0,0,0,0.15)`) stays on `.time-bar-track`, not on the segment row — it renders on top of segments at the top edge, inside the rounded corners.
6. Do **not** widen the track to make the segments "look" flush. If the track's width changed as part of the prior attempted fix, revert it and solve clipping as above.

**Verification:** take a screenshot at mobile width. The leftmost and rightmost segments should show their weather-ramp fill color all the way into the rounded corners, with no strip of track background visible.

---

## Task 3 — Don't overlap the search bar

**Problem.** The calendar picker sheet slides down from the top and overlaps the search bar.

**Do:**

1. The picker sheet opens **below** the search bar, not underneath it. Its top edge aligns with the bottom edge of the search bar's container (including any safe-area padding).
2. If the sheet uses `position: fixed; top: 0`, change to `top: calc(var(--search-bar-height, 64px) + var(--safe-area-top, 0px))`. Use whatever variable the search bar already exposes; if there isn't one, expose it now (`--search-bar-height` on `:root`, set from JS on resize).
3. The search bar stays fully interactive with the picker open. It does **not** get dimmed, blurred, or pushed.
4. The picker sheet's top-edge border radius is `0` (it joins the search bar's bottom edge cleanly); its bottom-edge border radius stays `12–14px`.

**Update DESIGN.md → Calendar picker (sheet):**

Add: "The picker opens below the app's top chrome (search bar), not over it. Top chrome remains interactive while the picker is open."

---

## Task 4 — Show all 10 days at once, not a scrollable strip

**Problem.** A horizontally scrollable strip defeats the purpose of the 10-day view, which is to see the full forecast horizon at a glance. Scrolling hides days.

**Do:**

1. Switch from single-row horizontal scroll to a **2-row grid of 5 columns × 2 rows** showing all 10 days.
   - Row 1: days 1–5 (today through +4 days).
   - Row 2: days 6–10 (+5 through +9 days).
   - Column gap `8px`, row gap `8px`.
2. Each tile fills `(100% - 4*8px) / 5` of sheet width. Height stays `88px`. No overflow scroll.
3. Tile content fits comfortably at this width (~60–72px on typical mobile):
   - Weekday abbreviation (`11pt / 600 / --muted`, letter-spacing 0.5px).
   - Day number (`20pt / 700 / --text`).
   - Weather glyph (`18px`).
   - Temperature: **only the high**, not `high / low`. Format: `18°`. 10-day tiles at mobile width don't have room for both.
4. Selected-state ring (`2px solid --accent` + `--accent-dim` inset) stays as specced in round 5.
5. Today-dot indicator stays as specced.
6. Past days dim treatment stays as specced.

**Update DESIGN.md → Calendar picker → 10-day mode:**

Replace the "horizontal scrolling strip" description with the 5×2 grid spec above. Explicitly note: "All 10 days are visible at once without scrolling. The grid is the source of truth for the forecast horizon."

---

## Task 5 — Un-cram the full-calendar tiles

**Problem.** Full-calendar day tiles render the day number, weather glyph, and a temperature label stacked, but the label spills outside the tile bounds. This is a density problem — too much content for the available tile size.

**Do:**

1. Drop the temperature label from full-calendar tiles entirely on all viewports. Month-grid density is already high with 35–42 visible tiles; temperature at that scale is unreadable anyway.
2. Full-calendar tile content:
   - Day number (`17pt / 600 / --text`), centered horizontally, top-aligned with `6px` top padding.
   - Weather glyph (`16px`) below the number, centered horizontally, `4px` gap. Only shown for days inside the 10-day forecast horizon.
   - Today-dot (if applicable) below the glyph, `3px` gap.
3. Tile height: `52–56px` on mobile. Tile width: fills its column in a 7-column grid (`(100% - 6*4px) / 7`). Gap between tiles: `4px` horizontal, `4px` vertical.
4. Past days: same `opacity: 0.45` + non-selectable.
5. Beyond-horizon days (11+ days out): day number only, no glyph. `--muted` color on the number to signal "no forecast."
6. Selected ring: `2px solid --accent` with `--accent-dim` inset. Ring doesn't cause layout shift — use `box-shadow: inset 0 0 0 2px var(--accent)` or a pseudo-element so the tile's actual box stays the same size selected or not.
7. Today (not selected): `--accent` dot only. Today (selected): `--accent` ring **and** dot.

**Update DESIGN.md → Calendar picker → Full calendar:**

Specify: temperature is not rendered in full-calendar tiles on any viewport. Glyph-only for forecast days, number-only for beyond-horizon days. Tile dimensions `~48–56px` square, 7-column grid with `4px` gaps.

---

## Task 6 — Close the picker on day selection

**Problem.** After tapping a day, the picker stays open. This is wrong — the tap is a commit, and the user's next action (scrubbing the time bar for the newly selected day) is blocked by the picker.

**Do:**

1. On tap of any selectable day tile (not past, not beyond-horizon):
   1. Update the selected date state.
   2. Play the selected-ring animation on the tapped tile for `--transition-fast` (120ms), so the user sees confirmation.
   3. Close the picker sheet with the same slide-out animation as manual dismiss (`--transition-base`, 220ms, ease-out, translateY).
   4. Rotate the readout chevron back to its idle (pointing-down) state.
2. The `aria-expanded` on the date button flips to `false`.
3. Focus returns to the date button in the readout.
4. If the user taps the **currently selected** day tile, the picker still closes (treat as "dismiss, I'm good"). Do not treat it as a no-op with the picker staying open.
5. **Expanded → collapsed transition:** if the user was in full-calendar mode when they selected, the picker closes directly without first collapsing back to the 10-day view. On reopen, the picker returns to whatever mode was last active (remember the user's preference for the session).

**Update DESIGN.md → Calendar picker:**

Add: "Selecting a day commits the selection and dismisses the picker in one action. The picker's open/close state is independent of its mode (10-day vs full calendar); reopening restores the last-used mode within the session."

---

## Task 7 — Final DESIGN.md pass

After Tasks 1–6:

1. Verify the Tier 1 readout description reflects the SVG-triangle chevron (not Unicode).
2. Verify the Time bar section still reads correctly after the clipping fix and has no stale references to the widen-the-track misstep.
3. Verify the Calendar picker section covers: opens below search bar, 5×2 grid for 10-day mode (no horizontal scroll), temperature-free full-calendar tiles, auto-dismiss on day select, last-mode-remembered-in-session.
4. Flag any contradictions in the PR description.

---

## Success criteria

- The trailing chevron in the readout reads as a solid, appropriately weighted triangle that clearly signals a dropdown. It rotates 180° when the picker is open.
- The time bar's weather segments fill the full width of the track, reaching all four rounded corners. No track background visible at the edges.
- Opening the picker does not overlap or obscure the search bar.
- All 10 forecast days are visible at once in 10-day mode — no horizontal scroll.
- Full-calendar tiles are not cramped; content stays inside tile bounds at all viewport widths.
- Tapping a day commits the selection and closes the picker in one action; the time bar and readout reflect the new date.

---

## Out of scope

- Map styling, pin layout, venue cards, detail panel.
- Multi-day selection or range pickers.
- Visual redesign of the search bar.
- Different calendar styles for desktop vs mobile — one responsive layout covers both.

---

## Reporting

Per task: short summary of file changes and any spec deviations with justification. Final report ends with the DESIGN.md diff surfaced separately.
