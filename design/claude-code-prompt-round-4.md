# Prompt for Claude Code — consolidation, thumb redesign, past state, round 4

Paste everything below into Claude Code on your working branch. Rounds 1–3 must already be applied. Every task updates behavior plus `DESIGN.md` — keep the doc diff scoped to rules that actually change. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

The docked time-picker control group is working, but the panel is still taller than it needs to be, the thumb reads as a measurement marker rather than a draggable handle, and the time bar gives no visual signal for what's in the past. Also, the separate date pill is now redundant — a consolidation will collapse one full row out of the layout.

This round does the consolidation, fixes the thumb, disables the past, and tidies the sort chip alignment.

---

## Task 1 — Consolidate date and time into an inline readout phrase

**Problem.** The date currently lives as a separate pill next to the time bar, and the time lives as a big number in the readout. They represent the same thing (a moment) but are split across two UI chunks, adding a full row of vertical space for no gain.

**Do:**

1. Remove the date pill entirely.
2. In the readout, replace the standalone time (`12:45`) with an inline phrase that pairs date + time:
   - `📅 Today, 12:45` when the selected date is today.
   - `📅 Tomorrow, 12:45` when the selected date is tomorrow.
   - `📅 Man 20 Apr, 12:45` for any other date (Norwegian short form: 3-letter weekday + day + short month).
3. Styling inside the phrase:
   - Calendar icon: 12px SVG (not emoji — use an inline SVG matching the existing icon set), color `--muted`.
   - Date portion (`Today,` / `Man 20 Apr,`) + the comma: `--muted`, same size as the time.
   - Time portion (`12:45`): `--accent`, 24pt / 700 (current size).
   - Everything on one line. The icon and date click-target opens the calendar; the time is not a click target (it's set by the bar).
4. Never wrap. If the string is too long on narrow phones, degrade in this order: drop the weekday (`20 Apr, 12:45`), then drop the relative word if one is active (fall through to the date form).
5. Preserve accessibility: the date portion is a real `<button>` with proper ARIA label ("Change date"), even though it's styled as inline text with an icon.

**Update DESIGN.md → Readout panel:**

- Replace the "Tier 1: selected time" bullet with a description of the new inline phrase, including the icon size, the color split (`--muted` for date and comma, `--accent` for time), and the line-never-wraps rule.
- Add a note: the date-part of the phrase is the calendar trigger. No separate date pill exists.

**Update DESIGN.md → Date pill:**

- Retire the section. Replace it with a short redirect: "Date selection lives inline in the readout phrase — see Readout panel. A separate date pill is no longer part of the system." Do not delete the section header until other docs that might reference it are checked.

---

## Task 2 — Redesign the thumb as a slim pill

**Problem.** The 2px line thumb reads as a measurement tick, not a draggable handle. It's too thin to invite touch. We went too minimal in round 2.

**Do:**

1. Replace the line thumb with a slim vertical pill:
   - Width: `4–5px`.
   - Height: `~120%` of the bar's height, so it extends ~3px above and ~3px below the bar's top and bottom edges (symmetric).
   - Fill: `--text` (`#FFF2EB`).
   - Radius: `3px` (rounded ends).
   - Shadow/glow: keep the soft accent-orange glow already spec'd — `box-shadow: 0 0 8px rgba(255,175,133,0.4)`.
2. On active drag, scale the thumb to `1.05` via transform (very subtle) and increase glow opacity to `0.6`. Revert on release with `--transition-fast` (`120ms`).
3. Keep the "no text inside thumb" and "do not use `--accent` as the fill" rules — the fill stays `--text`, the accent lives in the glow only.
4. When the thumb and the NÅ tick sit within ~30 minutes of each other, hide the `NÅ` label to avoid collision. The dashed line can remain (dimmed to 50% opacity). When the thumb moves away, the label fades back in over `--transition-fast`.

**Update DESIGN.md → Thumb (time bar):**

- Replace the whole section with the new spec: slim pill, `4–5px × 120% bar height`, `--text` fill, radius `3px`, accent-orange glow. Note the active-drag scale and glow-opacity change. Keep the two negative rules (no text, no `--accent` fill).
- Add a short note under the NÅ tick section describing the label-hide behavior when the thumb is within ~30 minutes.

---

## Task 3 — Visually disable past time in the bar

**Problem.** The portion of the bar to the left of the NÅ tick represents the past. It's not a valid selection, but it looks identical to the future, so nothing tells the user it's off-limits. They may try to scrub into it and be confused.

**Do:**

1. Apply `opacity: 0.45` to all hour segments left of the NÅ tick. This includes any weather glyphs inside those segments.
2. Apply the same `opacity: 0.5` to axis labels for past hours.
3. Prevent the thumb from entering the past:
   - During drag, if the pointer crosses to the past side of the NÅ tick, clamp the thumb's position to the NÅ tick.
   - Use a soft spring back: if the user releases while dragging in the past region, the thumb animates back to NÅ with `--transition-base` and a gentle ease-out.
4. If the selected time *happens* to land exactly at NÅ (e.g. first load with "now" as default), render the thumb cleanly on top of the NÅ tick (z-index above the tick).

**Update DESIGN.md:**

- Add a new section under Components, titled "Past / disabled state for data inputs":
  - "Data inputs that represent time (time bar, day arc, similar) dim their past portion to 40–50% opacity to communicate that it's not a valid selection. Interaction is soft-clamped at the present moment — the thumb cannot be released in the past and springs back to NÅ if dragged there."

---

## Task 4 — Fix sort chip alignment

**Problem.** The "Sort: Score" chip floats without a clear anchor in the expanded list state. It doesn't line up with the venue cards' content edges, which makes the list header feel disconnected from the list itself.

**Do:**

1. Align the sort chip's right edge with the right content edge of the venue list (same padding the venue cards use).
2. Vertically: the chip sits on a shared baseline with the list's header area, not in its own empty row above it. If there's currently empty vertical space between the time-picker wrapper and the chip, tighten it.
3. Verify the fix with a populated list (mock venues if needed) — the empty "No venues match your filters" state may be hiding the real layout. If alignment looks right in empty state but drifts in populated state, the populated layout is the one to trust.

**No DESIGN.md change** unless you discover a general list-header alignment rule worth codifying. In that case, add it under a "Lists" component section; don't silently change existing unrelated rules.

---

## Task 5 — Final DESIGN.md pass

After Tasks 1–4, re-read `DESIGN.md` end to end and:

1. Verify the Date pill section is properly retired and the Readout panel section describes the new inline phrase correctly.
2. Verify the Thumb section has been fully rewritten, with no lingering references to the old line-only design.
3. Verify the new "Past / disabled state" section has been added and is consistent with the existing prose style.
4. Flag any contradictions in the PR description rather than silently resolving them.

---

## Success criteria

- The docked control group is shorter than before — the inline phrase replaces the separate date pill and the row it occupied.
- The readout phrase never wraps, even with the longest formatting (`📅 Man 20 Apr, 23:45`), on the narrowest supported phone width.
- The thumb reads as a grabbable handle at rest, not a tick mark. On touch, the slight scale and glow increase confirm the grab.
- The past portion of the bar is visibly dimmer than the future; attempting to drag the thumb into the past results in a soft spring back to NÅ.
- The sort chip aligns cleanly to the list's right content edge in the populated state.

---

## Out of scope

- Map styling, pin layout, detail panel internals, calendar rendering itself (only the trigger changes).
- New color tokens, glass levels, or motion durations beyond those already in DESIGN.md.
- Redesign of the venue card itself.
- The Locate Me button and its position.

---

## Reporting

Per task, short summary of file changes and any spec deviations with justification. Final report ends with the DESIGN.md diff surfaced separately so the doc changes are easy to review in isolation. Pay particular attention to the retired Date pill section — that's the largest structural change to the doc and the easiest to leave half-done.
