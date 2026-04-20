# Solsteder Design System

One source of truth for visual language. Before making UI changes — manually or with AI tools — start here. If a change wants to break a rule in this doc, update the doc first and justify the change in the commit message.

## Principles

1. **Subtraction beats addition.** When hierarchy feels off, remove elements before adding them. Most "it doesn't pop" problems are noise problems, not emphasis problems.
2. **Color carries meaning; don't waste it on decoration.** Every color token has one job. Using `--accent` for "this looks nice here" is how design drift starts.
3. **Weather data and UI chrome use separate palettes.** Never overlap them. Orange accent is never a weather color; amber sun is never a UI color.
4. **No more than three type scales visible in one composition.** If a panel shows five different text sizes, it's cluttered regardless of the content.

## Color tokens

### Brand / UI chrome

| Token | Value | Used for |
|-------|-------|----------|
| `--bg` | `#111E38` | App background behind all panels |
| `--text` | `#FFF2EB` | Primary text, thumb line, scrubber handles |
| `--muted` | `#9CBDE7` | Secondary text, inactive icons, axis labels, dividers |
| `--accent` | `#FFAF85` | Interactive state ONLY: selected value, primary CTA text, focused readout time. Never decorative, never a background fill on non-interactive elements. |
| `--accent-dim` | `rgba(255,175,133,0.15)` | Subtle selected backgrounds, accent glow rings |
| `--accent-on` | `#2a1a0c` | Text color drawn ON an `--accent` background (e.g. selected button label). Not for use elsewhere. |

Never use `#FFFFFF` or `rgba(255,255,255,1)` for text or interactive fills. Use `--text` for warmth and consistency. Pure-white glows (`box-shadow … rgba(255,255,255,...)`) are also off-system — use `rgba(156,189,231,0.3)` instead.

### Glass surfaces (three levels — don't invent more)

| Level | Background | Blur | Use |
|-------|------------|------|-----|
| panel | `rgba(20,46,82,0.55)` | `16px` | List peek, detail panel, readout panel |
| card | `rgba(20,46,82,0.50)` | `12px` | Content cards inside panels |
| action | `rgba(20,46,82,0.45)` | `10px` | Buttons, pills, chips, small controls |

Border for all glass: `1px solid rgba(156,189,231,0.18)`.

No other background/blur combinations should be introduced. Map controls, overlays, and floating buttons all use one of these three levels. `rgba(14,26,52,...)` and `rgba(10,20,42,...)` are legacy values that should be migrated.

### Weather data ramp (USE ONLY for forecast visualizations)

A single perceptual axis from full sun to no light. Do not split into categorical hues. Partly-sunny is a *position on this ramp*, not a third color.

| State | Value | Meaning |
|-------|-------|---------|
| full sun | `#FFD488` | 80–100% sun availability |
| partly sunny | `#E6C08A` | 40–80% sun availability |
| overcast | `#8EA0B8` | 0–40%, no precipitation |
| rain | `#5E7CA8` | precipitation |
| night | `#1C2B4A` | before sunrise / after sunset |

**Scope:** use these colors only for direct forecast data visualization — the time bar segments, temperature curves, precipitation overlays, and similar data-ink. Venue-level sun status (score badges, availability labels, "steder i solen" count) uses `--accent`, not this ramp — those indicate a UI state, not a weather measurement.

Rule: weather colors never touch UI chrome and `--accent` never touches forecast data. If you need to indicate "this weather segment is currently selected," don't recolor the segment — use the thumb.

## Typography

Font: Inter (already loaded in `index.html`).

| Role | Size | Weight | Color | Use |
|------|------|--------|-------|-----|
| Display | 24–28pt | 700 | `--accent` (selected/focused value) or `--text` (informational numbers) | Readout time, primary numbers |
| Title | 17–18pt | 600 | `--text` | Venue names, panel headers |
| Body | 14pt | 500 | `--text` | Standard text |
| Meta | 12–13pt | 500 | `--muted` | Stats, secondary info, sub-lines |
| Caption | 10–11pt | 500–600 | `--muted` | Axis labels, tiny hints. Axis labels on primary inputs (time bar) use `11pt / 600`; generic captions cap at `10pt / 500`. |

**Display color rule:** use `--accent` when the value is the direct answer to what the user just picked (e.g. currently-selected time). Use `--text` for computed or contextual numbers (temperatures, distances, counts). Do not use `--accent` for decorative large text.

Never use sub-9pt text outside of calendar tile labels — those are a special case, not a precedent.

## Motion

No undocumented animation durations. Use these values:

| Token | Duration | Use |
|-------|----------|-----|
| `--transition-fast` | `120ms` | Hover state changes, color flips |
| `--transition-base` | `220ms` | Panel slides, dropdowns, focus rings |
| `--transition-slow` | `400ms` | Intro reveals, large layout transitions |

Cross-fade on readout numeric updates: 100ms total (50ms fade-out, text swap, 50ms fade-in). This is the ceiling — do not add more animation to a value that updates on every scrub tick.

## Elevation (box-shadow)

Three levels, matching glass surfaces. No other shadow values.

| Level | Value | Use |
|-------|-------|-----|
| low | `0 2px 8px rgba(0,0,0,0.35)` | Cards, small controls |
| mid | `0 6px 24px rgba(0,0,0,0.50)` | Floating panels, dropdowns |
| high | `0 12px 48px rgba(0,0,0,0.60)` | Modals, prominent overlays |

## Components

### Buttons — two flavors only

**Action pill** (labeled)
- Background: glass-action level
- Padding: `0 14px`, min-height `56px`
- Radius: `16px`
- Text: 13pt / 600 / `--text`
- Icon (optional): 16px, `--muted` opacity 0.85

**Action circle** (icon-only)
- Size: `44×44px`, circular (not 34px — that fails touch targets)
- Background: glass-action level
- Icon: 20px, `--accent` for primary actions (Locate Me) or `--muted` for chrome

Selected state for either: background `--accent`, text `--accent-on` (`#2a1a0c`), border transparent.

### Time bar (primary input)

- Height: `44–56px`
- Container: radius `12–14px`. Clip segments inside the container so leftmost/rightmost segments inherit rounded edges naturally.
- Segments: **hour granularity only.** No sub-hour ticks. Default: no dividers. If two adjacent segments are perceptually indistinct, an optional `1px rgba(0,0,0,0.08)` seam is the maximum allowed.
- Container inset shadow: `inset 0 1px 2px rgba(0,0,0,0.15)` — makes the bar feel recessed, not pasted on.
- Segment fill: from weather ramp above.
- Optional weather glyph: centered in segment, 10–12px, `--muted`. Drop the glyphs if segments are narrower than 24px.
- Scrub is continuous; snap the **display text only** to 15-minute increments. The underlying `timeFromEl.value` and thumb position remain continuous — do not snap the thumb.

### Thumb (time bar)

- Single vertical line: 2px wide, `--text` color, extending 6px above AND 6px below the bar (symmetric).
- Soft accent-orange glow: `box-shadow: 0 0 8px rgba(255,175,133,0.4)` signals active state.
- **No circle cap.** The symmetric line is the complete thumb.
- **No text inside the thumb.** Selected time lives in the readout.
- **Do not use `--accent`** on the line color — it collides with full-sun segments.

### "NÅ" tick

Thin dashed vertical line (`1px dashed --muted`), full height of bar. Tiny `NÅ` label above, 9pt / 700 / `--muted`, letter-spacing 0.5px.

### Readout panel (answers "what did I pick?")

The readout and the time bar are one docked control group, not two stacked surfaces:
- They share the same glass level (glass-panel: `rgba(20,46,82,0.55)` / `blur(16px)`).
- They live inside a single wrapper with matching border, radius `12–14px`, and `overflow: hidden`. No visible seam where they meet.
- Reduce the separator between readout and bar to a hairline: `1px solid rgba(156,189,231,0.08)`.
- **The unified wrapper has `16–20px` vertical padding on all internal content. No child control should sit flush against the wrapper's edge.**

Three-tier hierarchy inside the readout:
- **Tier 1** — selected time: 24pt, 700, `--accent`. Dominant.
- **Tier 2** — sun result ("78 steder i solen"): 14pt, 500, `--text`. Secondary line below the time. Shown once — in the readout only. Never duplicated in adjacent list headers.
- **Tier 3** — weather metadata: two-line stack on the right, same baseline as Tier 1:
  - Top: weather icon (22–24px) + temperature (17pt, 600, `--text`). Gap 6–8px between icon and number.
  - Bottom: wind direction + speed (12pt, 500, `--muted`). Format: `↘ 3 m/s`. Arrow wrapped in fixed-width span to prevent layout shift.
- Do not show the date here — it lives on the date pill.
- Hue-shift (optional): during scrub, the group wrapper tints toward the weather ramp color at the current thumb position, max 10–15% saturation, 120ms ease-out. Easy to overdo; stay subtle.

### Date pill

- Always a labeled pill (action-pill flavor): calendar icon + readable label (e.g. `Lør 25 Apr`). **Never icon-only** — the date must be readable at a glance without tapping.
- Standard height: `36–40px`. Vertically centered against the taller time bar row (they share a container rhythm, not a height).
- Adjacent controls use harmonious proportions — share the same container rhythm, baseline grid, and visual language — but primary inputs may be visibly larger than secondary controls. Equal visual weight is not the same as visual cohesion.
- Width follows content; no forced minimum beyond the standard pill spec.
- On narrow screens, the weekday abbreviation may be omitted (`20 Apr` instead of `Lør 20 Apr`). Never hide the date entirely.

### List peek (collapsed state)

In the mobile bottom-sheet collapsed state, three affordances together communicate "swipe up for a list":

1. **Grabber pill** — 36×4px, `rgba(156,189,231,0.25)`.
2. **Up-chevron** — small `∧` glyph below the pill, `--muted` at reduced opacity. Makes the swipe direction explicit.
3. **First-venue peek** — the top ~40–50px of the first venue card is visible below the control group. Shows name and score. Fades at the bottom edge.

The entire readout+bar surface (not just the grabber strip) is a drag target. The grabber is a visual hint only.

### Progressive disclosure

Secondary controls (sort, filter, alternate views) appear with the content they operate on, not preemptively. They must not occupy vertical space in states where they cannot act on anything. Sort is invisible in collapsed state; it surfaces at the top of the list header when the sheet is expanded.

### Icons

- In-field leading icons (search bar, input fields): `18–20px`.
- Icons inside action-pill components: `16px`.
- Icon-only action-circle buttons: `20px` inside a `44×44` touch target.

## Don't

- Don't use pure white (`#FFFFFF`) or pure-white glows for interactive elements or text. Use `--text` (`#FFF2EB`).
- Don't add new color tokens without documenting them here first.
- Don't encode weather with brand colors or vice versa.
- Don't use more than three type scales in one composition.
- Don't use sub-hour segmentation on the time bar. Scrub continuously, paint discretely.
- Don't duplicate information across adjacent elements (e.g., date in both the readout and the date pill).
- Don't animate on every value change. Rapid scrubs turn into visual noise. A 100ms cross-fade on numeric updates is the ceiling.
- Don't introduce glass surface variants outside the three documented levels. If the existing levels don't fit, update this document.
- Don't create shadow values ad hoc. Use the three documented elevation levels.
