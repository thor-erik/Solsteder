# Prompt for Claude Code — time picker refinements, round 2

Paste everything below this line into Claude Code on your working branch. It references `DESIGN.md` at the repo root; make sure it's present and the round-1 changes are already on the branch before starting.

---

## Context

Round 1 produced the current time picker and readout. A visual review surfaced seven refinements. Apply all of them, then update `DESIGN.md` so the new rules become canonical — future work should not regress. Do the tasks in order. A single PR is fine; keep the DESIGN.md diff scoped to only the rules that actually change.

Where an instruction below conflicts with an existing rule in DESIGN.md, the instruction wins and the doc must be updated to match.

---

## Task 1 — Make the time bar feel modern, not prototypey

**Problem.** Segments have hard corners, visible 1px dividers between each hour, and no container treatment. The bar reads like a placeholder grid rather than a finished control.

**Do:**

1. Bar container: radius `12–14px`. Clip segments inside the container so the leftmost and rightmost segments inherit the rounded outer edges naturally.
2. Remove the 1px segment dividers. Let weather colors meet directly. If two adjacent segments are genuinely hard to distinguish (e.g. full sun next to partly sunny at the ramp's warm end), add the faintest possible seam: `1px solid rgba(0,0,0,0.08)`. No more than that.
3. Add a subtle inset shadow on the bar container: `inset 0 1px 2px rgba(0,0,0,0.15)`. The bar should feel recessed into its surface, not pasted on top.

**Update DESIGN.md → Time bar:**

- Container radius: `12–14px`.
- Dividers: default to none. Optional `1px rgba(0,0,0,0.08)` only when perceptual separation genuinely fails.
- Inset shadow: `inset 0 1px 2px rgba(0,0,0,0.15)`.

---

## Task 2 — Date control is undersized next to the bar cluster

**Problem.** The date currently lives as a 44×44 icon-only circle adjacent to a ~56px bar and ~80px readout. It's visually undersized, and reducing the date to an icon forces the user to tap to find out what day is selected.

**Do:**

1. Replace the date circle with a full **date pill** (action-pill flavor per DESIGN.md): calendar icon + label like `Lør 25 Apr`. Opens the calendar on tap.
2. Pill height matches the time bar height so the two read as one unified row.
3. Width follows content; no forced minimum beyond the existing pill spec.

**Update DESIGN.md → Date pill:**

- Clarify: the date is **always** a labeled pill, never an icon-only circle — even in tight layouts.
- Add a general rule: controls docked adjacent to a tall primary input (like the time bar) match that input's height so they read as one row, not a cluster of mismatched shapes.

---

## Task 3 — Weather icon and wind in the readout

**Problem.** The weather icon on the right side of the readout sits at roughly 16px and carries no visual weight. Wind and temperature are squeezed onto one line at the same size, so neither dominates.

**Do:**

1. Enlarge the weather icon to `22–24px`.
2. Rearrange the right side of the readout into a two-line stack:
   - **Top line:** icon + temperature as a cohesive pair. Icon `22–24px`, temp `17pt / 600 / --text`. Gap between them `8px`.
   - **Bottom line:** wind. `12pt / 500 / --muted`. Format stays as `↘ 3 m/s`.
3. The left side of the readout (time + sun count) stays as it is.

**Update DESIGN.md → Readout panel:**

- Revise the Tier 3 description so weather metadata is now a two-line stack on the right (icon+temp top, wind bottom), with exact sizes as listed above.

---

## Task 4 — Thumb looks unbalanced

**Problem.** The circle cap sits flush with the top edge of the bar while the line extends equally above and below. The asymmetric cap reads as an unbalanced hanging piece.

**Do:**

1. Remove the circle cap entirely.
2. Thumb becomes a single vertical line: `2px` wide, `--text` color, extending `6px` above AND `6px` below the bar (symmetric).
3. Add a soft accent-orange glow so the thumb still reads as "active" without the cap: `box-shadow: 0 0 8px rgba(255,175,133,0.4)`.

**Update DESIGN.md → Thumb (time bar):**

- Remove all references to the circle cap.
- Replace with: "2px vertical line, `--text` color, extending 6px above and below the bar (symmetric). Soft accent-orange glow via `box-shadow: 0 0 8px rgba(255,175,133,0.4)` signals active state."
- Keep the existing "no text in thumb" and "don't use `--accent` for the line color" rules as-is.

---

## Task 5 — Axis labels below the bar are hard to read

**Problem.** Hour labels are small and low-contrast; they vanish against the glass surface.

**Do:**

1. Bump axis labels to `11pt`, weight `600`, color `--muted`.
2. Add ~`4px` of extra vertical space between the bar and the axis labels.
3. If labels still feel crowded at mobile width, reduce density: show every third hour only (e.g. `6, 9, 12, 15, 18, 21`). Test both densities and keep the one that reads cleaner on a phone.

**Update DESIGN.md → Typography (Caption row):**

- Clarify: axis labels on primary inputs (time bar and similar) use `11pt / 600 / --muted`. Generic caption text caps at `10pt`.

---

## Task 6 — Search icon is too small

**Problem.** The magnifier in the top search bar is roughly 14px and looks weightless next to the chunkier controls below.

**Do:**

1. Scale the search icon to `18–20px`.
2. Keep it in `--muted`.
3. Verify the search bar's vertical padding still leaves comfortable optical centering around the larger icon. Adjust the bar height if needed.

**Update DESIGN.md → Components:**

- Add an "Icons" subsection (or append to existing components section) with these rules: "In-field leading icons (search bar, input fields) use `18–20px`. Icons inside action-pill components use `16px`. Icon-only action-circle buttons use `20px` inside a `44×44` touch target."

---

## Task 7 — Readout and time bar don't read as one control group

**Problem.** The readout and the bar currently use subtly different glass treatments, producing a visible seam between them. They were meant to feel like one docked control.

**Do:**

1. Use the same glass level for both surfaces (per DESIGN.md — both `glass-panel`, or both `glass-action` — pick one and apply consistently).
2. Match border radii where they meet: the bottom corners of the readout mirror the top corners of the bar so the two shapes read as one continuous outline.
3. Reduce the `8px` gap between them to `4–6px` if the shared-group illusion still doesn't land after the glass and radius are aligned.

**Update DESIGN.md → Readout panel:**

- Add rule: "The readout panel and the time bar use the same glass level and mirrored border radii when docked. They must read as one control, not two stacked surfaces."

---

## Task 8 — Final DESIGN.md pass

After the code changes above are in, re-read `DESIGN.md` end-to-end and make sure:

1. Every rule modified above is updated in place, not duplicated.
2. Where a new rule tightens an older one (e.g. "date must always be a labeled pill"), the older looser wording is replaced, not left alongside.
3. If any existing rule now contradicts a new one you've written, flag the contradiction in the PR description rather than resolving it silently — a human should make the call.

---

## Success criteria

- The bar feels recessed and cohesive, not like a grid of colored tiles.
- The date is readable at a glance without tapping.
- The weather block in the readout has clear primary-secondary hierarchy: icon+temp dominates, wind is secondary.
- The thumb is visually balanced above and below the bar.
- Axis labels are readable at arm's length on a phone.
- The search icon matches the visual weight of the rest of the UI.
- The readout and bar read as one docked control, not two stacked surfaces.

---

## Out of scope

- Map styling, pin layout, list scrolling, and detail panel internals.
- The calendar itself — only the date pill that triggers it changes.
- New color tokens or glass levels. Work within the palette already in DESIGN.md.

---

## Reporting

After each task, post a short summary: which files changed, and any deviations from the spec with justification. End the final report with the `DESIGN.md` diff broken out on its own so the doc changes are easy to review in isolation.
