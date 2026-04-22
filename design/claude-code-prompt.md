# Prompt for Claude Code — Time picker and readout refinement

Paste the entire prompt below into Claude Code on your working branch. It references `/DESIGN.md` (repo root), which was created alongside this prompt — make sure it's present on your branch before starting.

---

## Context

We're refining the time picker on the main map screen (the primary input for the whole app). A recent design review uncovered several issues; this document captures the agreed fixes. **Before making any changes, read `DESIGN.md` at the repo root** — it's the authoritative style reference and supersedes prior visual choices. If a rule in `DESIGN.md` conflicts with an instruction below, the instruction wins and `DESIGN.md` should be updated.

Do the three tasks in order. Commit after each one.

---

## Task 1 — Fix the time bar

**Problem.** The bar currently uses 15-minute tick segments. At ~6px per segment on mobile, per-hour weather color can't be perceived — "sunny" and "partly sunny" look identical and the bar reads as visual noise. The white thumb is also off-brand.

**Do:**

1. Remove all sub-hour dividers. Segment the bar into **hourly blocks only**.
2. Scrubbing remains continuous (user can land on any minute); the readout snaps display to 15-minute increments.
3. Each hour segment fills with a color from the **weather ramp in DESIGN.md** (single perceptual axis: full sun → partly → overcast → rain → night). Do not use categorical hues or `--accent` for weather.
4. Increase bar height to 44–56px.
5. Add a small weather glyph (10–12px, `--muted` color) centered in each hour segment. Skip glyphs if segment width drops below 24px.
6. Replace the white thumb with: a 2px vertical line in `--text` (`#FFF2EB`) extending 4px above/below the bar, capped with a 10px circle in `--text` at the top edge. **No text inside the thumb.**
7. Restyle the "NÅ" tick to a thin dashed vertical line in `--muted` with a 9pt `NÅ` label above.

**Don't:**

- Don't print the selected time inside the thumb (spacing collisions at bar edges; finger occlusion during drag).
- Don't use `--accent` for the thumb — it collides with full-sun segments on good-weather days, exactly when users scrub most.
- Don't add more than three weather color states. The ramp has five positions but they belong to one axis.

---

## Task 2 — Rebuild the readout panel

**Problem.** The current readout shows date, time, weather, temp, and wind at equal typographic weight separated by dots. It floats untethered in the middle of the screen and duplicates the date already shown on the date pill. There's no hierarchy, so the selected time — the *answer* to "what did I pick?" — is buried.

**Do:**

1. **Dock** the readout ~8px above the time bar. Match the bar's width and border radius so they read as one grouped control.
2. Rebuild the content with explicit three-tier hierarchy (see DESIGN.md → Readout panel):
   - **Tier 1**: selected time — 24pt, weight 700, `--accent`. Dominant element.
   - **Tier 2**: sun availability result — 14pt, 500, `--text`. Example: `78 steder i solen`. This is the most decision-relevant info; give it presence.
   - **Tier 3**: weather metadata — 12pt, 500, `--muted`. Right-aligned on the same line as the time. Example: `⛅ 10°  ↘ 2 m/s`.
3. **Remove the date** from the readout. It lives on the date pill three millimeters away; duplicating it dilutes the time.
4. Numeric value updates during scrub: 100ms cross-fade on changed numbers. No scale bumps, no bounce, no other motion.
5. **Hue-shift behavior**: during active scrub, the readout's glass-panel background tints subtly toward the weather ramp color at the current thumb position. Max 10–15% saturation on the surface. Ease-out 120ms. Revert to neutral on release.

**Optional enhancement (build behind a feature flag if uncertain):**

Add a 1px vertical connector line in `--accent-dim` between the thumb and the bottom edge of the readout during active scrub. Makes the spatial link visible. Fades out on release.

**Don't:**

- Don't keep the date in the readout as "just in case." The redundancy is the problem.
- Don't use the same typographic weight for time and metadata. The flat hierarchy is the current readout's main failure.
- Don't over-animate. Rapid scrubs must stay smooth; every extra animation is a frame budget you're spending on nothing.

---

## Task 3 — Assess DESIGN.md against the codebase

After Tasks 1 and 2 are committed, read `DESIGN.md` at the repo root and do a codebase assessment. Return a short report (under 400 words, no preamble) covering:

1. **Violations.** UI elements elsewhere in the app that break rules in DESIGN.md — rogue colors (pure white, off-palette values), buttons that don't match the two approved flavors, type scales outside the documented range, weather colors used on chrome or vice versa. List file paths and line numbers.
2. **Gaps.** Rules DESIGN.md is missing. Example: are shadow effects, animation durations, or icon sizes inconsistent across the app with no rule to point to? Propose concrete edits (the exact token/rule to add), not just a list of problems.
3. **Ambiguity.** Anything in the doc that sounds clear to a human but would be misinterpreted by a future agent reading it cold. Flag the passage and propose a clearer rewrite.

**Constraints for the assessment:**

- Do not unilaterally "fix" violations found elsewhere in the codebase. Surface them in the report so a human can triage priority.
- If DESIGN.md itself needs edits, make a single follow-up commit that updates only `DESIGN.md` with the proposed changes, separate from the Task 1/2 work.
- If you find zero violations or gaps, reread more carefully — a first pass on a non-trivial codebase against a new design doc almost never comes up clean.

---

## Success criteria

- The time bar at hour granularity is visibly more legible than the 15-minute version. If you can't immediately tell sunny from overcast in a quick glance, the weather ramp needs more perceptual separation (adjust the hex values and update DESIGN.md).
- The selected time dominates the readout. A user glancing for half a second knows what time they picked.
- The DESIGN.md assessment surfaces at least one real inconsistency. "Everything looks great" is a failure mode, not a success.

## Out of scope (do not touch)

- Map rendering, pin layout, list scrolling, detail panel internals.
- Date picker open/close behavior or calendar rendering.
- `data/`, `scripts/`, anything under `.github/`.
- The existing `design/prototype-time-picker.html` — that's a reference prototype, not production code.

## Reporting

After each task, post a brief status: what you changed, which files, and any deviation from the spec with justification. Keep status messages short — link to the diff rather than describing it.
