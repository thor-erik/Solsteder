# Prompt for Claude Code — compact docked group, sunglass thumb, round 7

Paste everything below into Claude Code on your working branch. Rounds 1–6 must already be applied. This round is larger than previous ones — it retires several rules and replaces the docked group's layout. Keep the DESIGN.md diff scoped to the rules that actually change, but expect structural edits.

Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

The docked control group (calendar button, readout, weather, bar, sun count) has grown too tall — it's pushing the map out and making the whole screen feel stacked rather than focused. We're collapsing it into a compact 3-row layout, splitting the sun-count into the list header where it belongs, simplifying the axis, and replacing the slim pill thumb with a larger circular glass thumb. Several earlier decisions are being retired in this round; read carefully.

---

## Task 1 — New layout for the docked group

Target layout (ASCII):

```
┌─────────────────────────────────────────────────────────┐
│  ≡                                                      │  grabber only
├─────────────────────────────────────────────────────────┤
│  [📅 I morgen ▾]                    ☀ 17° · ↗ 2 m/s   │  row 1
│                                                         │
│  14:15   ━━━━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━    │  row 2
│                                                         │
│          6   8  10  12  14  16  18  20                  │  axis
└─────────────────────────────────────────────────────────┘
```

**Retirements:**

1. Retire the inline "Tier 1" readout phrase (`📅 Today ▾, 14:15`). Round 4 introduced it; this round removes it. Date and time are no longer in one phrase.
2. Retire the "Tier 2" sun count inside the readout (`6 steder i solen`). It moves to the list header (Task 3).
3. Retire the stacked weather metadata on the right (icon+temp top, wind bottom). Weather becomes a single inline row (Task 1.3).
4. Retire the up-chevron below the grabber. The venue peek carries the swipe-up signal already.

**Do:**

1. **Row 1 — Controls.** One horizontal row.
   - **Left:** calendar button — action-pill flavor, `36px` height. Content: calendar icon (16px, `--muted`) + date label + SVG triangle chevron from round 6. Label format stays `I dag` / `I morgen` / `Lør 25 Apr` (Norwegian short form). Label color `--text`, chevron `--muted` at rest, rotates 180° when picker open.
   - **Right:** weather inline row. Format `[icon, 18px] [temp, 13pt/600/--text] · [wind arrow + speed, 13pt/500/--muted]`. Middle-dot separator in `--muted`. Temp is the only element in `--text`; everything else `--muted`.
   - Row 1 total height: `36px` (matches the calendar button).
   - Vertical alignment: all row-1 content center-aligned.

2. **Row 2 — Time + slider.**
   - **Left:** selected-time label, fixed width `~64px`. Typography: `24pt / 700 / --accent`. Baseline-aligned with the slider's vertical center.
   - **Right:** slider fills remaining width. Spec in Task 2.
   - Gap between time label and slider: `12px`.

3. **Row 3 — Axis labels.**
   - Plain hour labels only: `6  8  10  12  14  16  18  20`. No sunrise/sunset precise timestamps. The color transition in the segments IS the sunrise/sunset signal — labeling it a second time is redundant.
   - Typography stays `11pt / 600 / --muted`, letter-spacing 0.5.
   - Labels sit `4px` below the slider, left-indented to align with the slider's start (not the time label's start).
   - Every-other-hour density is fine on phones; show every hour on wider viewports.

4. **Wrapper spec:**
   - Vertical padding: `12px` (down from `16–20px`). Horizontal padding: `16px` (unchanged).
   - Gap between row 1 and row 2: `10px`. Gap between row 2 and axis: `4px`.
   - Grabber pill stays `36×4px`, sits `8px` above row 1.
   - Glass level: `glass-panel` (unchanged).

**Update DESIGN.md → Readout panel:**

Rewrite the section entirely. The readout is now a **compact 3-row docked group** with:
- Row 1: calendar button (left) + inline weather (right)
- Row 2: selected-time label (left, `24pt/700 --accent`, fixed width) + slider (right)
- Row 3: hour axis labels

Remove all references to the Tier 1 inline phrase, the Tier 2 sun count, and the stacked right-side weather block. Note explicitly: "The date button and the selected-time label sit in separate rows; do not recombine them into an inline phrase."

**Update DESIGN.md → Date pill:**

Un-retire this section. The date button is back. Rewrite:
- Action-pill flavor, `36px` height
- Content: calendar icon (`16px`, `--muted`), date label (`13pt / 600 / --text`), trailing SVG triangle chevron (round 6 spec) in `--muted`
- Width follows content
- Functions as the calendar picker trigger (aria-expanded state, chevron rotation on open)

Delete the redirect text that pointed to the retired inline phrase.

---

## Task 2 — Sunglass thumb (replaces the slim pill)

**Problem.** The slim pill thumb reads as a handle but is still narrow. On a slimmer bar, we want a more forgiving, visually distinct grabber. Apple's recent liquid-glass thumbs (large circular glass discs) are a good visual reference. We're building our version — the "sunglass thumb" — a circular glass disc that lenses the weather color behind it.

**Retirement:** round 4's slim-pill thumb spec is retired entirely. Replace it, don't augment it.

**Do:**

1. **Shape:** circular. Not a pill.
2. **Diameter:** `28px`. The thumb extends above and below a `36–40px` bar — its center aligns with the bar's vertical center, so about `~4–6px` above and below the track edges.
3. **Fill:** frosted glass.
   - Background: `rgba(255, 242, 235, 0.18)` (`--text` at 18% opacity).
   - Backdrop filter: `blur(10px) saturate(120%)`. The saturation bump is intentional — it lets the weather-ramp color behind the thumb show through with slight enhancement, so the "sunglass" reads as a lens.
4. **Border:** `1.5px solid rgba(255, 242, 235, 0.75)`. High-opacity `--text`-tinted ring. This is what ensures visibility on any ramp color behind the thumb.
5. **Inner highlight:** `inset 0 1px 0 rgba(255, 255, 255, 0.30)` — a 1px top-inner highlight, the classic glass-surface sheen.
6. **Drop shadow:** `0 2px 6px rgba(0, 0, 0, 0.35)` to lift it off the bar.
7. **Accent glow (at rest):** `0 0 12px rgba(255, 175, 133, 0.35)`. Same accent-orange halo we've had since round 2, just wrapped around a circle now.
8. **On active drag:**
   - Scale to `1.08` (very subtle) via transform.
   - Glow intensifies to `rgba(255, 175, 133, 0.55)`.
   - Backdrop saturate bumps to `140%` so the lensed color pops a bit more.
   - Revert on release with `--transition-fast` (120ms).
9. **No text inside the thumb.** Selected time lives in row 2's time label, left of the slider.
10. **Do not use `--accent` as the fill or border.** The accent lives in the glow only. This rule survives from earlier rounds; don't regress it.
11. **NÅ tick collision:** keep the round-4 label-hide rule. When the thumb is within ~30 minutes of the NÅ tick, hide the `NÅ` text label and dim the dashed line to 50% opacity.

**Update DESIGN.md → Thumb (time bar):**

Rewrite the whole section. Replace with the sunglass spec above. Include:
- Circular, `28px` diameter
- Frosted glass: fill, blur, saturate values
- Border and inner highlight
- Shadow + accent glow at rest
- Active-drag scale, glow, saturation bump
- Negative rules: no text inside, no `--accent` fill, no `--accent` border

Add a short note at the top of the section: "The thumb is called the 'sunglass' — a glass disc that lenses the weather color at the current time. The name is deliberate and worth preserving; it reinforces the product's mental model."

---

## Task 3 — Move "X steder i solen" to the list header

**Problem.** The sun count has been sitting inside the readout as Tier 2 since round 2. It's actually a summary of the list below, not of the input above. Moving it to the list header separates input surface from result surface.

**Do:**

1. Remove "X steder i solen" from the docked group entirely.
2. Add it as a header above the venue list, replacing (or sitting above) the existing list header area.
3. Styling:
   - Typography: `15pt / 600 / --text`. Slightly larger than body because it's a section header, but not as large as a display value.
   - Format: `6 steder i solen` (Norwegian). When the list is empty, `Ingen steder i solen akkurat nå`.
   - Vertical padding: `12px` top, `8px` bottom. Horizontal padding matches the venue cards' left/right content edge (so it aligns with card titles).
4. In **collapsed / peek state** of the list sheet: the header is visible in the peek — it becomes part of the ~40–50px peek zone. This makes the peek more informative (user sees "6 steder i solen" above the first venue card title).
5. The sort chip (from round 3) continues to sit at the right of the list header area, vertically aligned with this new header text. They share the header row on expanded state.
6. Keep the rule: the count appears exactly once on screen. If any other UI ever shows the same number, it's the list header's job.

**Update DESIGN.md:**

- Remove the Tier 2 sun-count language from the Readout panel section.
- Add a short "List header" component section under Components, documenting: sun-count text (`15pt / 600 / --text`), Norwegian format, empty-state format, position relative to sort chip, visibility in peek state.

---

## Task 4 — Slim the bar without losing anything

**Problem.** The bar at `44–56px` is generous, but with the larger sunglass thumb providing the touch target, the bar itself can come down.

**Do:**

1. Bar height: `36–40px`. Do not go below `36px` — segments get cramped and the weather-ramp perceptibility degrades.
2. All existing bar rules carry forward: container radius `12–14px`, `overflow: hidden`, zero padding on segment row, inset shadow on container, weather-ramp colors on segments, no sub-hour ticks, optional hairline seams at perceptual collisions, past-state dim, soft-clamp at NÅ.
3. Weather glyph rule: still drop glyphs if segment width falls below 24px. At the new slimmer bar, glyphs at `10–12px` still fit vertically; no size change needed.
4. Touch target: the thumb (28px circle) extends above and below the bar. The effective drag target is the thumb bounding box, not the bar height. This means a `36px` bar is fine — users grab the thumb, not the track.

**Update DESIGN.md → Time bar:**

Revise the "Height" line to `36–40px`. Leave everything else as-is.

---

## Task 5 — Verify night color visibility fix from round 6

**Problem.** Round 6 raised that `#1C2B4A` (night on the weather ramp) is nearly identical to the panel background, making night segments look like empty space. If this was fixed in the round-6 pass, verify. If not, fix now.

**Do:**

1. Confirm the night color on the ramp is distinguishable from the panel background. Target contrast: at least a JND (just-noticeable difference) in lightness. Bump to roughly `#2A3B5E` if needed.
2. Also apply to the bar-track inner edge: add `inset 0 0 0 1px rgba(156, 189, 231, 0.10)` on the bar container. This ensures the track's extent is readable regardless of what segment color happens to be at the edge.

**Update DESIGN.md:**

- If the night color value changes, update it in the Weather data ramp table.
- Under Time bar, add the inner-edge inset line to the container spec.

---

## Task 6 — Final DESIGN.md pass

After Tasks 1–5:

1. Verify the Readout panel section describes the 3-row compact layout and no longer references the inline phrase or the Tier 2 sun count.
2. Verify Date pill is un-retired with the new 36px spec and serves as the calendar trigger.
3. Verify Thumb section fully rewrites to sunglass spec, with no lingering references to the slim pill.
4. Verify the new List header section exists under Components and owns the sun count.
5. Verify Time bar height is updated and the inner-edge inset is documented.
6. Verify the weather ramp night color is distinguishable from the panel background.
7. Flag contradictions in the PR description. Do not silently resolve.

---

## Success criteria

- The docked group is visibly shorter than before — roughly 3 tight rows totaling ~120–140px (down from ~200px+).
- No functionality is lost: date picker still opens from the calendar button, weather is still readable, time is prominent in `--accent`, slider still shows weather ramp, thumb still has accent glow, past state still dimmed, NÅ tick still behaves.
- The sunglass thumb reads as a generous, grabbable disc. On touch, the scale and saturation bump confirm the grab. The glass effect is legible on any ramp color.
- "X steder i solen" appears exactly once on screen, in the list header above the venue cards.
- Axis shows hour labels only; no `5:41` / `20:49` precise timestamps.
- The map gains back vertical real estate proportional to the docked-group reduction.

---

## Out of scope

- Map styling, pin layout, detail panel internals.
- Calendar picker behavior (round 5/6 spec stands).
- Venue card visual redesign — only the list header above the cards changes.
- New color tokens beyond the possible night-color bump on the weather ramp.
- Animation durations beyond those already in DESIGN.md.

---

## Reporting

Per task: short summary of file changes and any spec deviations with justification. Pay particular attention to Task 1's retirements — several earlier rules are being replaced, and the DESIGN.md diff will be the largest since round 1. Final report ends with the DESIGN.md diff surfaced separately.
