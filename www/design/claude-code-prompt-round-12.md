# Prompt for Claude Code — floating compact time slider, round 12

Paste everything below into Claude Code on the same branch as rounds 1–11. All prior rounds must already be applied. Every task updates behavior plus `DESIGN.md` where noted. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

**CRITICAL:** This round introduces a reversible layout mode. All new styling and layout logic must live behind a feature flag so we can roll back to the round-7 docked-group layout without branching. See Task 1 — implement the flag first, then build everything else behind it.

---

## Context

The docked group from round 7 was a useful intermediate step, but two problems remain: the time slider disappears entirely when the detail panel opens (so users can't scrub time while evaluating a venue), and on the expanded list it consumes ~250px of vertical real estate that would be better spent on cards.

The fix: pull the time slider out of the list peek entirely and make it a floating glass pill that lives persistently above the bottom safe area. It sits above every other surface — map, list (peek or expanded), and detail panel. It is always compact. Ambient info (temp, wind) and the current scrubbed time are revealed via a popup over the thumb during interaction, and hidden at rest. Weather-ramp colors in the slider track continue to communicate ambient weather without needing numbers.

`Date`, `weather icon + temp`, `wind` chips from the round-7 docked group are retired as persistent chrome. `6 steder i solen` and the sort chip return to the list peek header as they were pre-round-7.

---

## Task 1 — Introduce reversible layout flag

**Problem.** The user wants to be able to revert to the round-7 docked-group layout without creating a branch. All new round-12 styling and behavior must be togglable from a single place.

**Do:**

1. Add a JS constant at the top of `js/app.js` (or in `js/config.js` if that's a better home):

   ```js
   const USE_FLOATING_TIME_SLIDER = true; // round 12 — set to false to revert to round-7 docked group
   ```

2. On init, apply a body class based on the flag:

   ```js
   if (USE_FLOATING_TIME_SLIDER) {
     document.body.classList.add('floating-time-slider');
   }
   ```

3. All new CSS from tasks 2–8 must be scoped under `body.floating-time-slider` selectors. Existing docked-group CSS from rounds 5–7 must remain intact and continue to work when the flag is off.

4. All JS behavior differences introduced by this round (picker hide, list padding, detail panel height) must branch on `USE_FLOATING_TIME_SLIDER`.

5. Verify: toggling the constant to `false` and reloading returns the app to the exact round-7 layout with no regressions.

**Update DESIGN.md:**

Add a short note at the top of the Calendar picker / Time bar / Docked group sections: "Round 12 introduces a floating compact time slider as the default layout. Round-7 docked-group styling remains in the codebase behind `USE_FLOATING_TIME_SLIDER = false` for rollback."

---

## Task 2 — Build the floating time slider pill

**Problem.** Construct the persistent floating element that replaces the docked group's slider row.

**Do:**

1. Create a new container element (e.g. `#floating-time-slider`) positioned above every other surface.

2. Positioning:
   - `position: fixed`
   - `left: 16px; right: 16px;` (horizontal margin creates the floating feel)
   - `bottom: calc(var(--safe-area-bottom, 0px) + 12px);`
   - `z-index` high enough to sit above the list sheet and detail panel (if current surfaces use `z-index: 10/20`, use `30`).
   - `height: 52px`

3. Visual treatment:
   - Background: `rgba(20,46,82,0.55)` with `backdrop-filter: blur(16px) saturate(120%)` — identical to `glass-panel`.
   - Border: `1px solid rgba(156,189,231,0.18)`.
   - Radius: `999px` (full pill).
   - Drop shadow: `0 8px 24px rgba(0,0,0,0.25)` so the pill reads as clearly floating, not adjacent.

4. Internal layout (flexbox, `align-items: center`, `gap: 8px`, `padding: 6px 8px`):
   - **Left:** calendar button (see Task 3 for sizing and label rules).
   - **Right:** slider track + thumb, `flex: 1 1 0`, fills remaining width. The slider itself is visually unchanged from rounds 5–7 — same weather-ramp track, same sunglass thumb, same NÅ tick rules, same past-disabled treatment. Only its container changes.

5. No axis labels (`6 8 10 12 14 16 18 20`) inside the floating pill — axis labels are retired for the floating variant. The user reads position via ramp color, thumb position, and the scrub popup. If this turns out to cause navigation confusion in testing, we'll reconsider — flag it in the PR.

6. On map-only (no list, no detail): the pill is the only bottom chrome.

**Update DESIGN.md → Time bar:**

Add a new subsection "Floating compact time slider (round 12)" describing: pill shape, glass-panel background, 52px height, 16px horizontal margin, 12px above safe-area-bottom, drop shadow for floating read, no axis labels, weather-ramp track unchanged. Clarify this replaces the round-7 docked-group slider row.

---

## Task 3 — Calendar button with dynamic compact label

**Problem.** The calendar button lives inside the floating pill and must communicate the selected date without dominating horizontal space.

**Do:**

1. Label rules based on the currently selected date relative to today:
   - **Today:** no text, calendar icon only. Button shape: round, `40×40px`.
   - **Tomorrow:** label `I morgen`. Button shape: rounded pill, `height: 40px`, `padding: 0 12px 0 10px`, calendar icon `16×16px` leading the text with `6px` gap.
   - **Within the current week (2–6 days out):** `tor 23` format — Norwegian day abbreviation (lowercase) + date number, no period. Pill shape, same padding rule.
   - **Further out:** `23. apr` format — date number + period + Norwegian month abbreviation (lowercase). Pill shape.

2. Day name abbreviations: `man`, `tir`, `ons`, `tor`, `fre`, `lør`, `søn`.

3. Month abbreviations: `jan`, `feb`, `mar`, `apr`, `mai`, `jun`, `jul`, `aug`, `sep`, `okt`, `nov`, `des`.

4. Typography: `13pt / 600 / --text`. Trailing chevron `▾` SVG triangle `10×6px` `--muted`, `6px` gap from label. The round (today-only) variant does not show the chevron — the whole button is the tap target; chevron would crowd the 40×40 circle.

5. Background: `rgba(20,46,82,0.45) + blur(10px)` (`glass-action` flavor). Border: `1px solid rgba(156,189,231,0.18)`.

6. Tap opens the calendar picker (round 5–9 behavior unchanged). See Task 8 for picker interaction.

**Update DESIGN.md → Calendar picker / Time bar:**

Add: "The calendar button in the floating time slider uses a dynamic label — today = icon only (round 40×40), tomorrow = `I morgen`, same-week = `tor 23`, further = `23. apr`. Norwegian abbreviations are lowercase, no period on day names, with period on month names."

---

## Task 4 — Scrub popup (time + weather + wind)

**Problem.** When the user scrubs the slider or taps to jump, they need to see the selected time and the weather/wind at that moment. The popup appears over the thumb, follows it during drag, and fades out after release.

**Do:**

1. Create a popup element anchored above the slider thumb. Positioning: `position: absolute` relative to the slider track; horizontal center matches the thumb's current x position; vertical position `bottom: calc(100% + 8px)` (sits 8px above the thumb's top edge).

2. Visual treatment:
   - Background: `rgba(20,46,82,0.55) + backdrop-filter: blur(16px)` (glass-panel).
   - Border: `1px solid rgba(156,189,231,0.18)`.
   - Radius: `12px`.
   - Padding: `8px 12px`.
   - Drop shadow: `0 4px 12px rgba(0,0,0,0.3)`.
   - Caret/arrow pointing down at the thumb: optional; a small 6×6 rotated square at the bottom center would be a nice polish, but if it complicates render, skip it.

3. Content layout (flex row, `gap: 10px`, `align-items: center`):
   - Time: `15pt / 700 / --text`, `tabular-nums`, e.g. `14:20`.
   - Separator dot: `·` in `--muted`.
   - Weather glyph `16×16px` + temperature `14pt / 600 / --text` (e.g. `☀ 14°`).
   - Separator dot: `·` in `--muted`.
   - Wind: `↑ 1 m/s` in `13pt / 500 / --muted`.

4. Trigger rules:
   - **On `pointerdown` / `touchstart` on the slider:** popup fades in over `120ms ease-out`, follows thumb live.
   - **On `pointerup` / `touchend`:** popup stays for `800ms`, then fades out over `200ms ease-out`.
   - **On tap-to-jump (single tap on the track, no drag):** same fade-in → 800ms hold → fade-out sequence.
   - **During continuous drag:** popup tracks thumb position in real time, no debouncing.

5. Appstart behavior:
   - On first render of the app, the popup is visible at the current NÅ position for `2000ms`, then fades out over `200ms`. This teaches the user where the ambient info lives.
   - Implement as a one-shot on init; do not show on subsequent tab focus or navigation returns.

6. Positioning edge cases:
   - If the thumb is near the left or right edge of the slider, clamp the popup horizontally so it stays inside the screen with `8px` margin from the pill's edge. The popup's pointer-offset from the thumb can shift so the popup no longer appears centered — that's acceptable.
   - If the thumb is obscured by the edge clamp, a subtle connector line from popup to thumb would help, but leave it out for now.

7. The popup must sit above the floating pill in z-stack but remain anchored to the slider geometrically.

**Update DESIGN.md → Time bar:**

Add subsection "Scrub popup": appears on scrub or tap-to-jump, shows time + weather glyph + temp + wind, positioned above thumb, fades in 120ms and out 200ms after 800ms hold. Appstart: visible 2s on first app load.

---

## Task 5 — Retire the docked group, restore list peek header

**Problem.** With the slider now floating, the docked-group container inside the list peek is redundant. The `6 steder i solen` count and sort chip return to the list peek header as they were pre-round-7.

**Do:**

1. When `USE_FLOATING_TIME_SLIDER` is on:
   - Hide the entire docked-group wrapper (calendar chip row, weather/wind row, slider row, axis row) inside the list peek. `display: none` via the body-class scope.
   - List peek header now contains only: `6 steder i solen` (left) + sort chip (right, round-9 glass-action flavor). No slider, no calendar, no weather row.

2. When `USE_FLOATING_TIME_SLIDER` is off, the docked group renders as in round 7. Do not delete the old markup or CSS — only override its visibility.

3. The calendar-button click handler, slider change handler, popup trigger — all the interactive logic — must be bound to the new floating-pill DOM. If the existing handlers reference the docked-group element IDs, either reassign handlers on init based on the flag or bind to both and let the hidden one be inert.

4. Weather-ramp color computation, time state, current NÅ tick, past-disabled treatment — all shared logic stays centralized and works the same against the new slider DOM.

**Update DESIGN.md → List peek:**

Revert the header description to pre-round-7: "List peek header contains the venue count label on the left and the sort chip on the right. No slider, no calendar, no weather chrome." Add cross-reference: "Time controls live in the floating time slider — see Time bar → Floating compact time slider."

---

## Task 6 — List sheet adjustments

**Problem.** The floating pill sits over the bottom of the screen. The list peek must not overlap it, and the expanded list must let the user scroll the last cards clear of the pill.

**Do:**

1. **Peek state:**
   - List peek's top edge must sit above the floating pill with `8px` gap.
   - Concretely: list peek's `bottom: calc(var(--safe-area-bottom, 0px) + 12px + 52px + 8px)` — i.e. safe-area + pill bottom-margin + pill height + gap = `~72px + safe-area` above the screen bottom.
   - Peek height and content are otherwise unchanged.

2. **Expanded state:**
   - List sheet can expand to its full height (top edge under the search bar, per round 9's picker/search-bar coordination).
   - The scroll container inside the expanded list must have `padding-bottom: calc(var(--safe-area-bottom, 0px) + 52px + 12px + 24px)` — so the last card can scroll up above the pill with room to breathe. This `24px` buffer ensures the last card's bottom edge stops above the pill, not flush with it.

3. **Drag handle behavior:** unchanged. User can drag peek up into expanded, expanded down into peek. The floating pill is stationary throughout — it does not move, fade, or shift when the list state changes.

4. **Sort chip menu:** when the sort menu opens, it must render below the chip as before. It must not visually collide with the floating pill; if the menu would be clipped by the pill's top edge, render it as a bottom-sheet or above-chip popover instead — but default placement (below chip) should work fine as long as the chip is high in the header.

**Update DESIGN.md → List peek:**

Add: "The list sheet always leaves `~72px + safe-area` clear at the bottom of the screen for the floating time slider. In the expanded state, the scroll container has additional bottom padding so the last card can clear the pill."

---

## Task 7 — Detail panel adjustments

**Problem.** The detail panel currently covers the full bottom of the screen, hiding the former docked group. With the floating pill in place, the detail panel must be sized so the pill sits clear of the panel's top edge.

**Do:**

1. When `USE_FLOATING_TIME_SLIDER` is on and the detail panel is open:
   - Detail panel's top edge is pushed down so the floating pill sits just above it with `8px` gap.
   - Concretely: the panel's top position (the `translateY` value or `top` offset for the open state) increases by `52px + 12px + 8px = 72px` compared to the current open-state position.
   - Panel height shrinks by the same `72px`. If the panel already uses `--vh` math in its height, subtract `72px` from that calculation.

2. The panel's internal content (`Steder` back button, photo row, venue name, primary action row, sun section, sol-retning section) is unchanged. The panel just occupies less vertical space.

3. The floating pill is always visible over the detail panel. Its z-index keeps it above the panel.

4. The pill is **interactive** while the detail panel is open. Scrubbing time must update:
   - The detail panel's own sun-bar and `Sol til XX:XX · Nt Nm igjen` headline (per the redesign-implementation-prompt, Task 6).
   - The sol-retning dial and azimuth-bucket copy (per redesign-prompt, Task 7).
   - Map pins and any visible venue list cards.

5. **Interaction edge case:** if the user scrubs while the detail panel is open, the scrub popup renders above the thumb as usual, which means it floats over the detail panel's photo row. This is acceptable and expected — the popup is ephemeral and fades 800ms after release. Do not try to reposition the popup to avoid the panel.

6. Close/dismiss animation of the detail panel is unchanged. Pill stays stationary throughout.

**Update DESIGN.md → Detail panel:**

Add: "When the floating time slider is active, the detail panel's open-state height reduces by the pill's reserved bottom space (`72px`). The pill sits above the panel and remains interactive — scrubbing time while the detail panel is open updates the panel's sun section live."

---

## Task 8 — Calendar picker integration

**Problem.** The calendar picker (rounds 5–9) slides down from the top and claims the search bar's space. The floating pill sits at the bottom. While the picker is open, the pill is the picker's trigger context but scrubbing time doesn't make sense during date selection — hide the pill for the duration.

**Do:**

1. When the calendar picker opens:
   - Floating pill translates down and out: `transform: translateY(calc(100% + var(--safe-area-bottom, 0px) + 12px));` with `opacity: 0` over `220ms ease-out`. This synchronizes with the picker's open animation (round 9 spec).
2. When the picker dismisses:
   - Floating pill translates back and fades in, same `220ms ease-out`.
3. While the picker is open:
   - Pill pointer events are disabled (`pointer-events: none`) — but since it's translated off-screen, this is mostly defensive.
4. If the user selects a date and the picker auto-dismisses (round 6 rule), the pill slides back in synchronized with the picker's close.
5. The list sheet's auto-collapse-to-peek-while-picker-open (round 9 Task 2) is unchanged. The pill's hide/show is independent of the list's state.

**Update DESIGN.md → Calendar picker (sheet):**

Add: "While the picker is open, the floating time slider slides down and out, synchronized with the picker's top-slide-down animation. It returns when the picker dismisses."

---

## Task 9 — Final DESIGN.md pass

After Tasks 1–8:

1. Time bar section now includes: Floating compact time slider subsection, scrub popup subsection, appstart popup rule, dynamic calendar button label rules, no axis labels in floating variant.
2. List peek section no longer references docked-group slider row. `6 steder i solen` + sort chip restored as the peek header description. Cross-reference to Time bar for controls.
3. Detail panel section includes the `72px` height reduction rule when floating slider is active.
4. Calendar picker section includes the floating-slider-hide rule.
5. Round-7 docked group retained in the doc but marked as "fallback layout, active when `USE_FLOATING_TIME_SLIDER = false`."
6. Flag contradictions in the PR description.

---

## Success criteria

- `USE_FLOATING_TIME_SLIDER = true` by default — app shows the floating pill. Setting to `false` and reloading returns the app to the round-7 docked-group layout with no visual regressions.
- Floating pill sits at the bottom as a glass-panel pill with `16px` horizontal margin, `12px` above safe-area-bottom, `52px` tall. Drop shadow reads as clearly floating.
- Calendar button shows icon-only for today, `I morgen` for tomorrow, `tor 23` / `23. apr` for later dates.
- Scrubbing the slider shows the popup above the thumb with time, weather glyph, temp, and wind. Popup fades in on scrub-start, fades out 800ms after release.
- On first appstart the popup is visible for 2 seconds then fades.
- List peek header now shows only `6 steder i solen` + sort chip. No time slider, no calendar chip, no weather row in the list.
- Expanded list scrolls so the last card can clear the floating pill.
- Opening the detail panel reduces its height by `72px` — the pill remains visible above the panel's top edge.
- Scrubbing time while the detail panel is open updates the panel's sun-bar, sol-retning dial, and azimuth copy live.
- Opening the calendar picker slides the floating pill down and out; dismissing it slides the pill back in.

---

## Out of scope

- Redesign of the slider track, thumb, weather-ramp, or NÅ tick. All visual rules from rounds 5–7 for the slider itself stand.
- Changes to the detail panel's internal content beyond the height adjustment. The redesign-implementation-prompt governs detail-panel interior.
- Re-evaluating whether axis labels are needed in the floating variant. We'll revisit if user feedback suggests it.
- Beyond-horizon time bar state (selected day has no forecast data) — still flagged from round 9.

---

## Reporting

Per task: short summary of file changes and any spec deviations with justification. Call out:
- How the feature flag is wired (body class + JS constant) and that toggling to `false` was verified.
- Any interaction edge cases with the popup (edge-clamp behavior, tap-vs-drag differentiation).
- Whether detail panel scrubbing updates all internal surfaces (sun bar, dial, azimuth copy) in real time without lag.

Final report ends with the DESIGN.md diff surfaced separately.
