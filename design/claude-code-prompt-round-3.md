# Prompt for Claude Code — time picker & list-peek refinements, round 3

Paste everything below into Claude Code on your working branch. Rounds 1 and 2 must already be applied. All tasks update behavior plus `DESIGN.md` — keep the doc diff scoped to only the rules that actually change.

Where an instruction below conflicts with a rule currently in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

The time bar and readout now work well as one docked control group. Round-2 over-corrected the date pill's sizing, the wrapper container still kisses its edges, and the swipe-up reveal of the venue list isn't discoverable. Also: now that the readout displays "X places in the sun," the duplicate copy below the bar is noise, and the sort button is sitting in collapsed state where it has nothing to sort.

This round addresses all of that.

---

## Task 1 — Resize the date pill; amend the "match bar height" rule

**Problem.** The date pill is currently forced to match the time bar's height. That came from a round-2 rule I wrote ("controls adjacent to a tall primary input match that input's height"). It's wrong — it conflated visual cohesion with visual equivalence. The date is a secondary control used maybe once per session; the time bar is used constantly. Forcing them to equal height makes the pill read as chunky and over-emphasized.

**Do:**

1. Take the date pill back to a standard action-pill height (`36–40px`).
2. Vertically center it against the taller time bar (they should sit on a shared vertical axis, not share a height).
3. Keep it as a labeled pill — icon + date text. Do not reduce to icon-only.
4. If horizontal space is tight on narrow phones, allow the label to drop the weekday (`20 Apr` is fine), but never hide the date entirely.

**Update DESIGN.md:**

- Locate the rule that says controls adjacent to a tall primary input match that input's height. **Replace it** with: "Adjacent controls use harmonious proportions — share the same container rhythm, baseline grid, and visual language — but primary inputs may be visibly larger than secondary controls. Equal visual weight is not the same as visual cohesion."
- Under the Date pill section, set standard height to `36–40px` and note it vertically centers against the time bar row.

---

## Task 2 — Fix wrapper padding so controls don't kiss the edge

**Problem.** The date pill (and presumably any adjacent control) sits flush against the bottom edge of its wrapper panel. Reads as a layout accident.

**Do:**

1. Add `16–20px` of bottom padding inside the unified wrapper that contains the readout + bar + date pill row.
2. Match the top padding so the readout isn't kissing the top edge either.
3. Do not introduce a new inner container — this is one wrapper holding the whole docked group; just give it breathing room.

**Update DESIGN.md → Readout panel / docked group section:**

- Add: "The unified wrapper has `16–20px` vertical padding on all internal content. No child control should sit flush against the wrapper's edge."

---

## Task 3 — Make the swipe-up reveal of the venue list discoverable

**Problem.** A small grabber bar above the readout is the only affordance that the list can be pulled up. Users who don't know the pattern don't read a 40×4px muted strip as "drag me up to see more." Discoverability is poor.

**Do:**

1. **Peek the first venue card.** In collapsed state, the top ~40–50px of the first venue card must be visible above the grabber. Show its name, score, and sun duration — enough to telegraph "there's a list of venues up here." This is the single highest-leverage fix.
2. **Add an up-chevron** next to or above the grabber line. Small `∧` glyph, `--muted` color, ~10px. Makes the "up = more" relationship explicit.
3. **Make the whole readout+bar wrapper draggable**, not just the grabber strip. Users shouldn't have to target the handle; the entire surface is the drag region. The grabber stays as a visual hint.
4. **Optional first-run nudge.** On first app open only, after ~800ms idle, auto-bounce the sheet up ~20px and settle back. Do not repeat on subsequent launches.

**Update DESIGN.md:**

- Add a short "List peek" section under Components describing the collapsed-state contract: grabber + up-chevron + ~40–50px peek of first content row. The whole containing surface is the drag region.

---

## Task 4 — Remove the duplicate "X places in the sun"

**Problem.** The readout now shows "7 places in the sun" as its Tier 2 line. The same text also appears below the time bar above the list header. Two instances dilute each other.

**Do:**

1. Remove the duplicate "X places in the sun" text below the bar. The readout's version is canonical.
2. Do not replace it with anything — that vertical space is freed for the venue peek (Task 3).

**No DESIGN.md change required** — the existing rule about not duplicating info across adjacent elements already covers this; the implementation had drifted.

---

## Task 5 — Hide sort in collapsed state; show it with the list

**Problem.** The sort button sits visible in collapsed state, where there's no list to sort. It takes vertical space for zero user value. If we kept it visible, it would also eat the budget we need for the venue-peek in Task 3.

**Do:**

1. **Collapsed / peek state:** no sort button visible anywhere. The wrapper shows readout + bar + date pill only.
2. **Expanded list state:** surface sort as a compact pill at the top-right of the list area, sticky to the list's header edge as the user scrolls. Spec:
   - Action-pill flavor, `36px` height (smaller than standard 56px; this is a secondary chip).
   - Label format: `Sort: Score ▾` or equivalent.
   - Color: `--text` label, `--muted` chevron.
   - Tapping opens a sort menu (sheet or small dropdown — use whichever is already the project convention).
3. Animate the sort chip in with the list reveal — it should feel like part of the list, not a separate floating control.

**Update DESIGN.md:**

- Add a short "Progressive disclosure" note under Components or Principles: "Secondary controls (sort, filter, alternate views) appear with the content they operate on, not preemptively. They should not occupy vertical space in states where they can't act on anything."

---

## Task 6 — Final DESIGN.md pass

After Tasks 1–5 land, re-read `DESIGN.md` end to end and:

1. Make sure every rule changed above is updated in place, not duplicated, and that old looser wording is replaced.
2. Check Round-2's "match bar height" rule is fully removed or softened per Task 1, with no lingering references that would re-introduce the over-correction.
3. Flag contradictions in the PR description. Do not silently resolve them — a human triages.

---

## Success criteria

- The date pill sits as a compact secondary control next to the time bar, not a chunky block.
- No child control kisses the edge of its wrapper.
- In collapsed state, the first venue card peeks visibly above the grabber, and an up-chevron confirms the swipe direction.
- The whole readout+bar surface is draggable, not just the handle strip.
- "X places in the sun" appears exactly once on screen.
- No sort chip is visible in collapsed state; it appears in context when the list is expanded.

---

## Out of scope

- Map styling, pin layout, detail panel internals, calendar rendering.
- Redesign of the venue card itself — the peek just needs to show enough of the existing card to telegraph the list.
- Any new color tokens, glass levels, or motion durations beyond those already in DESIGN.md.

---

## Reporting

Per task: short summary of file changes and any spec deviations with justification. Final report ends with the DESIGN.md diff surfaced separately so the doc changes are easy to review.
