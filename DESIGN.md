# Solsteder Design System

**Shades is the in-app name for the design language.** Shades is a deliberate double-entendre: *shadows* (the product's subject matter) and *sunglasses* (the visual metaphor). Surfaces behave like polarised lenses — deep Delft Blue tint, clean rim, bright spec along the top edge. Pins, panels, and controls all belong to the same optical family.

One source of truth for visual language. Before making UI changes — manually or with AI tools — start here. If a change wants to break a rule in this doc, update the doc first and justify the change in the commit message.

## Principles

1. **Subtraction beats addition.** When hierarchy feels off, remove elements before adding them. Most "it doesn't pop" problems are noise problems, not emphasis problems.
2. **Color carries meaning; don't waste it on decoration.** Every color token has one job. Using `--accent` for "this looks nice here" is how design drift starts.
3. **Weather data and UI chrome use separate palettes.** Never overlap them. Orange accent is never a weather color; amber sun is never a UI color.
4. **No more than three type scales visible in one composition.** If a panel shows five different text sizes, it's cluttered regardless of the content.
5. **Pickers and secondary inputs must preserve the context their selection affects.** If changing value X updates display Y, Y must remain visible while the picker is open. This is why the date picker does not cover the time bar or readout — the user needs to see the effect while choosing.

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

### Glass finish (required on every level)

The Shades Glass recipe is applied on top of every glass surface. Use the CSS classes `.glass-panel`, `.glass-card`, or `.glass-action` — or replicate these properties exactly.

```css
/* Applied to every .glass-panel, .glass-card, .glass-action */
background:
  linear-gradient(135deg, rgba(20,46,82,<level-A>) 0%, rgba(32,73,131,<level-B>) 100%),
  rgba(20,46,82,<level-base>);   /* legacy single-color fallback */
backdrop-filter: blur(<level-blur>) saturate(160%);
-webkit-backdrop-filter: blur(<level-blur>) saturate(160%);
border: 1px solid rgba(156,189,231,0.18);
box-shadow:
  inset 0 1px 0 rgba(255,242,235,0.14),    /* top inner sheen */
  inset 0 -1px 0 rgba(20,46,82,0.35),       /* bottom inner shade */
  <elevation-shadow>;                        /* from elevation scale */
```

Level values:

| Level | A | B | base | blur |
|-------|---|---|------|------|
| panel | 0.48 | 0.30 | 0.55 | 16px |
| card | 0.42 | 0.26 | 0.50 | 12px |
| action | 0.36 | 0.22 | 0.45 | 10px |

The gradient stops are tuned so the diagonal reads as "light entering from the upper-left." Do not flip the angle per component — this 135° direction is the signature of the language.

### Spec highlight

Panels (level = panel) carry a `::before` pseudo-element painting a 1px horizontal highlight at the top edge: `top: 0; left: 8%; right: 8%; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,242,235,0.35), transparent)`. Cards and actions skip this — too much highlight at small sizes reads as visual clutter.

### Tooltip / transient surface

`#hover-tooltip`, `#map-toast`, and similar ephemeral floating elements use **action-level** glass: gradient A=0.36 B=0.22 over base 0.45, blur 10px, saturate 160%, rim + top-sheen inset shadows, 1px Jordy border, elevation `low`. No spec-highlight `::before` — too small to benefit.

### Weather data ramp (USE ONLY for forecast visualizations)

A single perceptual axis from full sun to no light. Do not split into categorical hues. Partly-sunny is a *position on this ramp*, not a third color.

| State | Value | Meaning |
|-------|-------|---------|
| full sun | `#FFD488` | 80–100% sun availability |
| partly sunny | `#E6C08A` | 40–80% sun availability |
| overcast | `#8EA0B8` | 0–40%, no precipitation |
| rain | `#5E7CA8` | precipitation |
| night | `#2A3B5E` | before sunrise / after sunset (bumped from `#1C2B4A` for JND contrast vs panel background) |

**Scope:** use these colors only for direct forecast data visualization — the time bar segments, temperature curves, precipitation overlays, and similar data-ink. Venue-level sun status (score badges, availability labels, "steder i solen" count) uses `--accent`, not this ramp — those indicate a UI state, not a weather measurement.

Rule: weather colors never touch UI chrome and `--accent` never touches forecast data. If you need to indicate "this weather segment is currently selected," don't recolor the segment — use the thumb.

**Collision rule:** when an element could simultaneously show weather data and a selected/focused state, weather goes in a sub-element (glyph, inline color, small ramp chip) and the outer container stays neutral. Selected state uses `--accent` on the outer container (ring, border, or text). Never paint weather-ramp color on a container that also needs to signal selection. This rule generalises the time bar thumb principle to all components (including calendar day tiles).

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
- Padding: `0 12–14px`, height `36px` for compact controls (date button); `56px` for standalone CTAs
- Radius: `16px`
- Text: 13pt / 600 / `--text`
- Icon (optional): 16px, `--muted`

**Action circle** (icon-only)
- Size: `44×44px`, circular (not 34px — that fails touch targets)
- Background: glass-action level
- Icon: 20px, `--accent` for primary actions (Locate Me) or `--muted` for chrome

Selected state for either: background `--accent`, text `--accent-on` (`#2a1a0c`), border transparent.

### Time bar (primary input)

- Height: `36–40px`. Do not go below `36px` — segments get cramped and weather-ramp perceptibility degrades.
- Container (`#qc-arc-track`): `overflow: hidden; border-radius: 12px; padding: 0`. This wrapper is the sole source of corner clipping — the canvas itself draws no rounded corners (TRACK_R = 0). Segments fill the full canvas width with no internal horizontal padding; the container clips them to the correct radius.
- Container inner-edge: `inset 0 0 0 1px rgba(156,189,231,0.10)` — ensures the track extent is readable regardless of which segment color sits at the edge.
- Canvas height: ~38px. Top 8px reserved for the "NÅ" label; remaining ~26px is the colored track; bottom 4px clearance for the thumb.
- Segments: **hour granularity only.** No sub-hour ticks. Default: no dividers. If two adjacent segments are perceptually indistinct, an optional `1px rgba(0,0,0,0.08)` seam is the maximum allowed.
- Container inset shadow: `inset 0 1px 2px rgba(0,0,0,0.15)` — makes the bar feel recessed, not pasted on.
- Segment fill: from weather ramp above. Night background: `#2A3B5E` (bumped from `#1C2B4A` for JND contrast vs panel background).
- Optional weather glyph: centered in segment, 10–12px, `--muted`. Drop the glyphs if segments are narrower than 24px.
- Scrub is continuous; snap the **display text only** to 15-minute increments. The underlying `timeFromEl.value` and thumb position remain continuous — do not snap the thumb.
- Hour labels live in `#qc-arc-labels`, a sibling div **outside** `#qc-arc-track` (and therefore outside `overflow: hidden`). They are absolutely positioned within that div using the same `timeToX` formula as the canvas. A minimum 4px inset from either edge prevents edge clipping. Do not draw labels inside the canvas — they would be clipped by the container's border-radius at extreme hours.

### Thumb (time bar)

> **The thumb is called the "sunglass"** — a glass disc that lenses the weather color at the current time. The name is deliberate and worth preserving; it reinforces the product's mental model.

Circular frosted-glass disc — not a pill, not a tick mark.

- **Shape:** circular. Not a pill.
- **Diameter:** `28px`. Center aligns with the bar's vertical midpoint; extends ~4–6px above and below the track edges, giving a generous touch target without needing a taller bar.
- **Fill:** frosted glass. Background: `rgba(255, 242, 235, 0.18)` (`--text` at 18% opacity). Backdrop saturate (in canvas: approximated by translucent fill over ramp color): `saturate(120%)` intent — the weather-ramp color behind shows through, so the disc reads as a lens.
- **Border:** `1.5px solid rgba(255, 242, 235, 0.75)`. High-opacity `--text`-tinted ring ensures visibility on any ramp color.
- **Inner highlight:** `inset 0 1px 0 rgba(255, 255, 255, 0.30)` — 1px top-inner arc sheen, the classic glass-surface cue.
- **Drop shadow:** `0 2px 6px rgba(0, 0, 0, 0.35)` lifts it off the bar.
- **Accent glow at rest:** `0 0 12px rgba(255, 175, 133, 0.35)` — same accent-orange halo, wrapped around the circle.
- **On active drag:** scale to `1.08×` (centered on disc center); glow intensifies to `rgba(255, 175, 133, 0.55)`. Revert on release with `--transition-fast` (120ms).
- **No text inside the thumb.** Selected time lives in the row-2 time label, left of the slider.
- **Do not use `--accent` as the fill or border** — it collides with full-sun segments. The accent lives in the glow only.
- **NÅ tick collision:** when the thumb is within ~30 minutes of the NÅ tick, suppress the `NÅ` text label and dim the dashed line to 50% opacity. Fade back when thumb moves away, over `--transition-fast`.

> The thumb is the seed example of Shades Glass. Every other glass surface in the app — panels, cards, actions, pins — inherits the same optical treatment (diagonal Delft tint, top-rim sheen, bright 1px edge, subtle saturate). When a new surface is added, the thumb is the reference.

### "NÅ" tick

Thin dashed vertical line (`1px dashed --muted`), full height of bar. Tiny `NÅ` label drawn at the top of the canvas (within the 8px PAD_T space above the colored track), 8px / 700 / `--muted`, `textBaseline='top'`.

**Label collision hide:** when the thumb is within ~30 minutes of the NÅ position, suppress the `NÅ` label and dim the dashed line to 50% opacity. Fade the label back when the thumb moves away, over `--transition-fast`.

### Readout panel (answers "what did I pick?")

> **The date button and the selected-time label sit in separate rows; do not recombine them into an inline phrase.**

The readout and the time bar are one docked control group, sharing glass-panel level (`rgba(20,46,82,0.55)` / `blur(16px)`), radius `14px`, `overflow: hidden`. Vertical padding: `12px` top and bottom. Horizontal padding: `16px`.

**Three-row compact layout:**

- **Row 1 — Controls** (height: `36px`, items center-aligned):
  - **Left:** calendar button — action-pill flavor, `36px` height. Contains: calendar icon (`16px`, `--muted`), date label (`13pt / 600 / --text`), SVG filled-triangle chevron (`--muted` at rest, rotates 180° when picker open, `--accent` when active). Width follows content. This is the calendar picker trigger (`aria-expanded` state).
  - **Right:** weather inline row: `[icon, 18px, --muted] [temp, 13pt/600/--text] · [wind arrow+speed, 13pt/500/--muted]`. Middle-dot separator in `--muted`. Temp is the only element in `--text`; everything else `--muted`.
  - Gap between row 1 and row 2: `10px`.

- **Row 2 — Time + slider:**
  - **Left:** selected-time label, fixed width `~64px`. Typography: `24pt / 700 / --accent`. Baseline-aligned with the slider's vertical center.
  - **Right:** slider fills remaining width (see Time bar spec). Gap between label and slider: `12px`.
  - Gap between row 2 and axis: `4px`.

- **Row 3 — Axis labels:**
  - Plain hour labels only: `6  8  10  12  14  16  18  20`. No sunrise/sunset precise timestamps — the color ramp transition IS the sunrise/sunset signal.
  - Typography: `11pt / 600 / --muted`, letter-spacing 0.5.
  - Labels sit `4px` below the slider, left-indented to align with the slider's start (not the time label's start).

- Hue-shift (optional): during scrub, the group wrapper tints toward the weather ramp color at the current thumb position, max 10–15% saturation, 120ms ease-out. Stay subtle.

### Date pill

Action-pill flavor, `36px` height. Functions as the calendar picker trigger.

- Content (left to right): calendar icon (`16px`, `--muted`), date label (`13pt / 600 / --text`), trailing SVG filled-triangle chevron (`--muted` at rest; `--accent` when picker is open; rotates 180° when open).
- Background: glass-action level (`rgba(20,46,82,0.45)` / `blur(10px)`).
- Width follows content (min-width limited to label + icon + chevron + padding).
- Label format: `I dag` / `I morgen` / `Lør 25 Apr` (Norwegian short form).
- `aria-expanded` state drives chevron rotation and active color. Focus returns to this button on picker close.

The date button sits in row 1 of the readout panel (left side). It is separate from the selected-time label in row 2. Do not recombine them.

### Calendar picker (sheet)

Opens from the date button in row 1 of the readout panel. Never covers the time bar, readout, or list peek — those must remain visible so the user sees live updates as they browse dates (Principle 5).

**Opening / closing:**
- Trigger: tap the date button (calendar icon + label + chevron). The chevron rotates 180° when open (`aria-expanded="true"`).
- On **mobile**: the search bar **slides up and out** of the viewport (`translateY(calc(-100% - 24px))` + `opacity: 0`) simultaneously with the picker sliding down. The picker sheet starts from `top: 0` (full-height) with top padding equal to `env(safe-area-inset-top) + 16px`. Both transitions use `--transition-base` (220ms ease-out). On dismiss, the search bar slides back in. Top edge border-radius `0`; bottom edge radius `14px`. Dismiss by tapping the chevron again, tapping outside, or pressing Escape.
- On **mobile**: opening the picker also **auto-collapses the list to peek**. The prior panel state is saved; closing the picker restores it. This ensures the picker has unobstructed screen space while remaining dismissible by the list's swipe-up gesture.
- On **wider viewports**: the sheet expands downward from the panel, appearing just above or beside the control group. Search bar is not hidden on desktop.
- **Auto-dismiss on selection:** tapping any selectable tile commits the date and closes the picker in a single action. The chevron returns to idle (pointing down). Focus returns to the date button. Tapping the currently-selected tile also closes the picker.
- **Session mode persistence:** the picker remembers whether the user was in 10-day or full-calendar mode. Reopening the picker restores the last-used mode within the session. `_closeQcPanel()` does not reset the expanded state.
- The sheet is a `role="dialog"` element with `aria-modal="true"`. On open, focus moves to today's tile. Escape closes.

**Today-dot rule (both views):** The today-dot is the **last child** of the tile's flex column — after the temperature (or day number for beyond-horizon tiles). Order in DOM: weekday abbr → day number → weather glyph → temp → today-dot. `4px` diameter, `--accent`. Rendered as an inline flex element — not `position: absolute`. When a day is both today and selected, both the selection ring and the dot are shown; the dot stays `--accent`.

**Default state: 10-day mode (5 × 2 grid)**
- All 10 forecast days visible at once in a **5-column × 2-row CSS grid** — no horizontal scroll. Row 1: days 1–5 (today through +4). Row 2: days 6–10 (+5 through +9). Column gap `8px`, row gap `8px`.
- On all viewports: tiles fill `(100% − 4×8px) / 5` of sheet width. Tile height `88px`. Radius `10px`.
- Tile content (top to bottom): weekday abbreviation (11pt / 600 / `--muted`, letter-spacing 0.5px), day number (20pt / 700 / `--text`), weather glyph (18px), **high temperature only** (11pt / 500 / `--muted`, format `18°` — no low temp), today-dot (if today).
- Tile background: glass-card neutral. **Do not fill with weather-ramp color** — weather is carried by the glyph + temp text only (see collision rule).
- **Selected state:** `box-shadow: inset 0 0 0 2px var(--accent)` ring + subtle `--accent-dim` glow. Day number shifts to `--accent`. No border change (avoids layout shift). No background fill.
- **Past days:** `opacity: 0.45`, non-selectable — same rule as the time bar (see Past / disabled state section).
- **Mode toggle button:** Below the grid, a glass-action pill button labeled `Vis full kalender ▾` (Norwegian). Height `44px`, radius `12px`, `13pt / 600 / --text`. No accent treatment — this is secondary chrome. Trailing SVG triangle chevron in `--muted`.

**Expand to full calendar:**

*Scroll behavior:* A single weekday row (`M T O T F L S`) is pinned at the very top of the scroll area (`position: sticky; top: 0`). Each month has one inline label (`APRIL 2026`, `MAY 2026`, etc.) that is also sticky, pinned just below the weekday row (`top: weekday-row-height`). As the user scrolls, the current month's label stays put; when the next month's label reaches the same pin position, it naturally pushes the previous one up and off-screen. Both sticky elements use `background: rgba(20,46,82,0.85); backdrop-filter: blur(12px)` so tiles scrolling beneath don't bleed through.

- Month grid: **7 columns only** (Mon–Sun). No week-number sidebar — week numbers are useful for work scheduling but irrelevant for leisure date picking.
- Tile dimensions: `48px` tall, `gap: 4px` (horizontal and vertical).
- Tile content: day number (`15pt / 600 / --text`) centered; weather glyph (`14px`) below if within 10-day forecast horizon; **no temperature** — month-grid density makes it unreadable; today-dot (if today) last.
- **Beyond-horizon tiles (>10 days):** `34px` tall (vs `48px` forecast tiles) — visually distinguishes them from data-rich tiles. Glass-card background at reduced opacity (`rgba(20,46,82,0.25)`), border at reduced opacity (`rgba(156,189,231,0.10)`), day number `15pt / 500 / --muted`, no glyph. Remain selectable — tapping sets the date. **No dashed borders anywhere in the calendar.** Dashed borders are not part of this design system.
- **Collapse button:** `Skjul full kalender ▴` (Norwegian). Same glass-action spec as the expand button. Trailing SVG chevron rotated 180°.
- **Forecast horizon footnote:** *"Værvarsel er tilgjengelig for de neste 10 dagene."*

**Sheet spec (mobile full-screen overlay):**
- Background: glass-panel — `rgba(20, 46, 82, 0.55)` / `backdrop-filter: blur(16px) saturate(120%)`. The map must remain faintly visible behind the sheet. **Never apply a solid or near-solid fill to the sheet base — the picker must read as an overlay, not a new screen.**
- Sticky headers (weekday row, month labels) use a denser variant — `rgba(20,46,82,0.85)` / `blur(12px)` — so tiles scrolling beneath them don't show through. Only the sticky headers need this elevated opacity; the sheet base stays translucent.
- Border: `1px solid rgba(156,189,231,0.18)` on the bottom edge only.
- Elevation: `mid` (`0 6px 24px rgba(0,0,0,0.50)`).
- Padding: `calc(env(safe-area-inset-top) + 16px) 16px 20px` on mobile (top padding adapts to device notch).

**Inner panel `#qc-panel-inner` (desktop — glass floating panel):**
- Background: `rgba(20, 46, 82, 0.55)` + `backdrop-filter: blur(16px) saturate(120%)`.
- Sticky month/weekday header rows keep `rgba(20,46,82,0.88)` + `blur(12px)` so tile content doesn't bleed through on scroll.

### Past / disabled state for data inputs

Data inputs that represent time (time bar, calendar strip, day arc, similar) dim their past portion to `opacity: 0.45` to communicate that it is not a valid selection. This applies to segments, weather glyphs, axis labels, and calendar day tiles.

For the **time bar** specifically, past hours have their weather-color fill removed entirely (the night background `#2A3B5E` shows through) — dimming an amber segment to 0.45 opacity makes it perceptually indistinguishable from overcast grey. Removing the fill avoids this ambiguity.

Interaction is soft-clamped at the present moment — the thumb cannot be released in the past and springs back to NÅ if dragged there. The spring uses `--transition-base` (220ms) ease-out. During drag the thumb is visually held at NÅ (clamped); the spring plays on release to reinforce the boundary.

If the selected time is exactly NÅ (e.g. on first load), the thumb renders cleanly on top of the NÅ tick (z-order: thumb above tick).

### Floating compact time slider (round 12)

> Round 12 introduces a floating compact time slider as the default layout. The round-7 docked-group styling remains in the codebase behind `USE_FLOATING_TIME_SLIDER = false` for rollback.

A persistent floating glass pill (`#fts`) that sits above every surface (map, list, detail panel). It replaces the docked time-bar group in the list panel, freeing the panel entirely for venue content.

**Container:**
- `position: fixed; left: 16px; right: 16px; bottom: calc(env(safe-area-inset-bottom) + 12px)`
- Height: `52px`. Border-radius: `999px` (full pill).
- Glass: action level (`rgba(20,46,82,0.45)` / `blur(10px)`).
- Shadow: `var(--glass-inset), 0 8px 24px rgba(0,0,0,0.25)`.
- z-index: `925` — above detail-panel (920), below calendar picker (850/950).
- Mobile (`<640px`): margins tighten to `12px`.

**Layout (left to right):**
1. **Date button** (`#fts-date-btn`) — action-pill, `40px` height, `999px` radius. Contains calendar icon + label + chevron. Label logic:
   - Today → icon-only (circle, no label/chevron, `width: 40px`).
   - Tomorrow → "I morgen".
   - Same week (2–6 days) → "tor 23" (Norwegian abbreviated day + date).
   - Further → "23. apr" (date + abbreviated month).
   - Active state: border `rgba(255,175,133,0.35)`, icon + label + chevron in `--accent`.
2. **Canvas track** (`#fts-track`) — flex: 1, `40px` height, `13px` radius, `overflow: hidden`, `touch-action: none`. Contains `#fts-canvas` which renders the weather-ramp segments + sunglass thumb (same rendering as the docked time bar, but with 24px diameter thumb).

**Scrub popup** (`#fts-popup`):
- Anchored above the pill, `8px` gap. Glass-panel level.
- Content: `[time, 15pt/700] · [weather label] · [wind m/s]`.
- Appears on drag start and on appstart (2s auto-hide). Follows thumb position horizontally, clamped to pill edges.
- Fade: `opacity 120ms ease-out`.

**Picker integration:**
- When calendar picker opens, the pill slides down and out (`fts-hidden` class: `translateY(100% + safe-area + 24px)`, `opacity: 0`).
- When picker closes, the pill slides back up.

**Panel adjustments (mobile):**
- Peek-state panel transform adds `-72px` offset to clear the pill.
- Venue list gets `padding-bottom: 88px` to prevent last card from being hidden.
- Locate button shifts up by `72px`.
- Detail panel height reduced by `72px`; fullscreen remains `100svh`.

### List header

"X steder i solen" appears exactly once on screen — in this header, above the venue list. It is the result surface for the input surface above (the control group). Never duplicate this count in the readout or elsewhere.

- Typography: `15pt / 600 / --text`. Section header weight, but below display scale.
- Format: `6 steder i solen` (Norwegian). Empty-state format: `Ingen steder i solen akkurat nå`.
- Vertical padding: `12px` top, `8px` bottom. Horizontal padding matches venue cards' left/right content edge (aligns with card titles).
- The sort chip sits at the **right** of this header row on expanded state. Both the count text and the sort chip share the same header row. Sort chip is hidden in collapsed/peek state.
- **Sort chip styling:** glass-action flavor — `36px` height, `13pt / 600 / --text`, `--muted` trailing chevron. No accent treatment (accent is reserved for interactive-selected state only). On open: border brightens to `rgba(156,189,231,0.35)`, background to `rgba(24,52,95,0.65)` — no color change. The chevron rotates 180° (`transition: transform 180ms ease`) when the sort menu is open.
- **Default sort label:** `Sol nå ▾` (was `Score` before redesign). Ranks venues by: 1) sun-remaining-duration descending, 2) distance ascending, 3) state (`sun` before `shadow` before `done`).
- **Visibility in peek state:** the header is visible in the ~40–50px peek zone, directly below the control group. It makes the peek more informative — users see "6 steder i solen" before expanding the list.

### List peek (collapsed state)

In the mobile bottom-sheet collapsed state, two affordances together communicate "swipe up for a list":

1. **Grabber pill** — 36×4px, `rgba(156,189,231,0.25)`. Sits 8px above the control group. The up-chevron that previously appeared below the pill is retired — the venue peek below carries the swipe-up signal.
2. **List sun header + first-venue peek** — "X steder i solen" is visible directly below the control group, followed by the top ~40–50px of the first venue card. The combination communicates both result count and entry point.

The entire control-group surface (not just the grabber strip) is a drag target. The grabber is a visual hint only.

### Progressive disclosure

Secondary controls (sort, filter, alternate views) appear with the content they operate on, not preemptively. They must not occupy vertical space in states where they cannot act on anything. Sort is invisible in collapsed state; it surfaces at the top of the list header when the sheet is expanded.

### Icons

- In-field leading icons (search bar, input fields): `18–20px`.
- Icons inside action-pill components: `16px`.
- Icon-only action-circle buttons: `20px` inside a `44×44` touch target.

### Icons

Sun-series and shadow-series icons live in `design/shades-status-icons/`. Together they form one continuous state scale, played forward or backward by the slider:

```
shadow-100 → shadow-75 → shadow-50 → shadow-25 → (sun arrives) →
sun-100 → sun-75 → sun-50 → sun-25 → sun-0 → (shadow returns)
```

**Sun series** (5 icons, `_sunIcons[0–4]`): fills from bottom as remaining time in the sun window grows.

| Index | File | Threshold (hoursLeft) |
|-------|------|-----------------------|
| 4 | `sun-100-percent.png` | ≥ 2.5 h |
| 3 | `sun-75-percent.png`  | ≥ 1.5 h |
| 2 | `sun-50-percent.png`  | ≥ 1.0 h |
| 1 | `sun-25-percent.png`  | ≥ 0.5 h |
| 0 | `sun-0-percent.png`   | < 0.5 h |

**Shadow series** (4 icons, `_shadowIcons[0–3]`): retreats from the top as sun approaches.

| Index | File | Threshold (minutesUntilSun) |
|-------|------|-----------------------------|
| 0 | `shadow-25-percent.png`  | ≤ 15 min |
| 1 | `shadow-50-percent.png`  | ≤ 45 min |
| 2 | `shadow-75-percent.png`  | ≤ 90 min |
| 3 | `shadow-100-percent.png` | > 90 min  |

Thresholds are tunable constants in `render-pins.js` (`_sunIconIdx`, `_shadowIconIdx`).

### Pins

Pins are canvas-drawn and belong to the Shades Glass family. **No pin may reference values outside the color-token section.** The legacy Solaris Oslo palette (`#0D131E`, `#514532`, `#FFB800`, `#d5c4ab`) is retired — delete on sight.

No pin type shows an absolute clock time in now-mode. The icon series carries state; the relative time carries urgency; the name carries identity. The old notched-pill shape is retired — single flat-pill silhouette for both Tier 1 and Tier 2a.

#### Tier taxonomy

State is a spectrum (*how near is sun in time?*) plus a binary modifier (*open / closed at selected time*). Not four peers.

| Tier | Name | Condition | Visual |
|------|------|-----------|--------|
| 1 | **Hero** | Venue has sun at the selected time | Tangerine pill, sun icon left, venue name right, solid stem |
| 2a | **Waiting** | Sun arrives within `WAITING_HORIZON_MIN` (120 min) | Glass pill, shadow icon left, time right, dashed stem |
| 2b | **Context** | Everything else | Small glass dot, no text, no stem |

`WAITING_HORIZON_MIN = 240` — covers the common case where sun arrives 3–4 h from now (typical Oslo afternoon). Delta format (`+Xm`/`+Xh`) is shown only for pins within 60 min; beyond that the pill shows the absolute arrival time, matching how the user thinks in clock time.

#### Tier × icon series × layout table

| Tier | Icon series | Icon size | Icon position | Text | Text color |
|------|-------------|-----------|---------------|------|------------|
| Hero | Sun (0–4) | 22×22 px | Left inset 2 px | `shortName(v.name)` | `#1a1200` |
| Waiting | Shadow (0–3) | 14×14 px | Left inset 6 px | Delta or clock (see Time display) | `#FFAF85` |
| Context | — | — | — | None | — |

Icon is **always on the left** in both Hero and Waiting pills. Consistent scan anchor across tiers.

#### Pill specifications

| Property | Hero | Waiting |
|----------|------|---------|
| Height | 26 px | 24 px |
| Radius | 13 px | 12 px |
| Fill | `#FFAF85` (--accent) | Delft gradient `rgba(20,46,82,0.42)→rgba(32,73,131,0.26)` at 135° |
| Inner top sheen | `rgba(255,242,235,0.45)` | `rgba(255,242,235,0.18)` |
| Border | `rgba(255,230,120,0.4)` | `rgba(156,189,231,0.18)` |
| Stem | Solid `rgba(255,175,133,0.70)` | Dashed `rgba(156,189,231,0.55)` |
| Stem dash | — | `[3, 3]` |

Context dot: 10×10 px, gradient fill `rgba(20,46,82,0.55)→rgba(32,73,131,0.38)`, 1 px `rgba(156,189,231,0.18)` border. No stem, no text.

#### Modifiers

**Closed-opens-into-sun badge** (Tier 2a only): when a venue is closed at the selected hour but its next sun window starts at or after its opening time, a 6 px clock badge appears in the bottom-right corner of the Tier 2a icon.

- Fill: `#142E52` (Delft Blue — dark, sits on glass pill)
- Border: 1.5 px stroke, `#9CBDE7` (--muted)
- Clock hands: two 1 px strokes in `#9CBDE7`; the *shape* carries more signal than the hands at 6 px

Badge is included in the sprite cache key (`closedOpeningIntoSun` boolean). Context dots don't distinguish open vs. closed via badge; they use the opacity modifier (0.42 when no sun at all today).

#### Time display on pins

No pin shows an absolute clock time in now-mode. In now-mode, Tier 2a shows a relative delta (`+15m`, `+1h 20m`). When the slider is scrubbed (not in now-mode), Tier 2a shows the absolute arrival time (`16:45`).

Rule: **match the user's mental anchor.** If they're thinking `now + X`, show `+X`. If they're thinking in clock time because they scrubbed, show clock time. Hero pins never show time — the sun icon is the full state signal.

`formatDelta(minutesUntil, isNowMode)` returns a delta string or `null`. When `null`, callers use `formatHour(nextStart)` for the absolute time.

#### Elevation

| Tier | Level | Shadow |
|------|-------|--------|
| Hero | low + accent glow | `shadowBlur: 8, offsetY: 3, rgba(0,0,0,0.40)` |
| Waiting | low | `shadowBlur: 6, offsetY: 2, rgba(0,0,0,0.35)` |
| Context | micro | `shadowBlur: 3, offsetY: 1, rgba(0,0,0,0.30)` |

Drop shadows are baked into the sprite canvas (`buildSprite`), not applied in the draw loop. Zero per-frame cost.

#### Selection ring

Consistent across all three tiers: `rgba(255,175,133,0.9)`, 2 px stroke, offset 2 px outside the pin's visual bounds. No second ring. No notched-icon ring.

#### Density rules

Every venue has a claim to attention, but not every venue has a claim to the user's attention simultaneously. The viewport's top candidates get names; the rest signal presence.

| Zoom | Hero cap | Waiting cap |
|------|----------|-------------|
| < 14 | 6 | 8 |
| 14–15 | 10 (`HERO_CAP`) | 15 (`WAITING_CAP`) |
| 16 | 15 | 20 |
| ≥ 17 | unlimited | unlimited |

Ranking: Hero candidates sorted by `sunScore` desc; Waiting candidates by `minutesUntil` asc (closest to sun first). Excess candidates are demoted to Context for that render; demotion is per-render only and does not persist.

### Venue card (redesigned)

Two-column layout optimized for scanning. Height: `85–90px` on mobile.

**Left column** (`flex: 1, min-width: 0`):
- **Venue name:** `15pt / 700 / --text`, single-line ellipsis
- **Meta:** `{område} · {type}` in `12pt / 500 / --muted` (distance removed from list card)
- **Mini sun-timeline:** Horizontal track, `6px` tall, spans full left-column width. Shows sun windows (orange) and cloud/overcast periods (muted blue) from `06:00–22:00`. Includes `2px` white vertical line marking wall-clock "now" (not the slider's selected time).

**Right column** (`~96px` fixed, right-aligned, stretches to match left height):
- **Distance:** `12pt / 500 / --muted`, top-aligned. Format: `221 m` or `2.3 km`
- **Hero block:** State-dependent (see Venue state model below)

**Removed from card:**
- Score badge (sort now handles ranking)
- Sun dial ring with arc
- Duplicate duration text (`3H 10M`)
- Per-venue weather (weather is global, in docked group row 1)

**Card background, border, radius:** glass-card per Shades Glass recipe. Margin-bottom: `8px`.

### Venue state model

Three states encode a venue's relationship to sun availability at the currently selected time. All list cards, detail headers, and future sun-presentation surfaces use these states and their display conventions.

| State | Condition | Hero main | Hero sub | Card class |
|-------|-----------|-----------|----------|------------|
| `sun` | Currently inside a sun window | `☼ {remaining_time}` (e.g. `☼ 3t 10m`) | `til {end_of_last_window_today}` | `state-sun` |
| `shadow` | No sun now, but sun windows exist later | `Sol om {time_until_next}` (e.g. `Sol om 15 min`) | `til {end_of_last_window_today}` | `state-shadow` |
| `done` | No further sun windows today | `Ferdig` | `sist {end_of_last_window_today}` | `state-done` |

**Hero block typography:**
- `sun` state main: `--accent` color, `15pt / 700 / --text`
- `shadow` state main: `--text` color, `15pt / 600 / --text`
- `done` state: whole card at `50%` opacity
- Sub-text (all states): `11pt / --muted`

**Duration format:** `3t 10m`, `1t 45m`, `15 min`, `5 min`. Use `min` under one hour. No zero-padding. Minimum shown: `5 min` (rounded up).

**Edge cases:**
- Current window ends in `< 5 min`: stays `sun`, shows `☼ 5 min`
- Next window starts in `< 10 min`: shows `Sol om 8 min`
- Venue closed at selected time: omitted from list (existing filter behavior)

### Mini sun-timeline

Horizontal sparkline showing sun availability across the day without text overhead.

**Dimensions:**
- Height: `6px` (track only, full viewport height is `14px`)
- Time range: `06:00–22:00` (mapped linearly)
- Container: `flex:1` on venue card's left column, spans full width

**Segments:**
- **Orange** (`--accent` at `0.85` opacity): direct sun windows
- **Muted blue** (`--muted` at `0.35` opacity): cloud/overcast within sun windows (bridges between windows)
- **Now marker:** `2px` white vertical line at wall-clock current time (not the slider's selected hour). Includes `0 0 6px rgba(255,255,255,0.6)` glow. This line orients the user to "where are we now in the day" regardless of which hour is selected.

**Shared vocabulary with detail panel:** The detail panel's larger sun-timeline (below) uses the same visual language at `10px` track height.

### Detail panel header

Below the photos strip.

**Title row:**
- Name: `22pt / 700 / --text`, up to 2 lines with ellipsis if longer
- Meta: `{type} · {område} · {distance}` in `13pt / 500 / --muted`
- Back button: `‹ Steder`, action-pill flavor, `36px` height, top-right aligned

**Spec:** Flex layout `gap: 12px`, title and meta stack in a flex column, back button flex-shrink: 0.

### Primary action row (detail panel)

Asymmetric row: one wide button + icon buttons.

**Left button (primary CTA):**
- Label: `↗ Veibeskrivelse · {walk_time} min` (e.g. `↗ Veibeskrivelse · 3 min`)
- Background: `--accent` solid
- Text: `--accent-on` (`#2a1a0c`)
- `flex: 1`, `44px` tall, `15pt / 700`
- Includes walk time calculated as `distance_meters ÷ 80 = minutes` (4.8 km/h pace), rounded, under 1 min shows `< 1 min`

**Icon buttons** (right of primary, only if data exists):
- `📞 Ring` (if `venue.phone` truthy): `tel:` link, `48×48`, glass-card background
- `🌐 Nettside` (if `venue.website` truthy): external link, same dimensions
- `⇪ Del` (always present): Web Share API with navigator.clipboard fallback

**Row gap:** `8px` between primary and icon buttons. Icon buttons gap: `8px`.

### Detail panel sun section

Bordered glass-card with state-aware headline.

**Headline** (state-dependent per Venue state model):
- `sun` state: `Sol til {end} · {remaining} igjen` (e.g. `Sol til 20:25 · 3t 10m igjen`)
- `shadow` state: `Sol fra {next_start} · om {time_until}` (e.g. `Sol fra 17:30 · om 45 min`)
- `done` state: `Sol ferdig i dag`

**Right-aligned sub** (same row, optional): `Neste pause {time}` — hide if no intra-day breaks in sun windows.

**Timeline:** Same vocabulary as Mini sun-timeline, scaled to `10px` track height. Range `06:00–22:00`. Includes orange, blue, and white-glow now-marker.

**Scale labels below timeline:** `6  9  12  15  18  21` in `11pt / 600 / --muted`.

### Sol-retning section

Compact wind-shelter/direction indicator, replacing the oversized sun dial.

**Layout:** Two columns
- **Left:** 80px diameter dial showing sun azimuth as an arc position. North (`N`) and South (`S`) ticks only — drop secondary ornamentation. Reuses `render-arc.js` draw logic. Shows direction only, not elevation.
- **Right:** Text block with:
  - **Primary:** `Solen står {direction}` (e.g. `Solen står vest-sørvest`) — `15pt / 600 / --text`
  - **Sub:** `Sett deg på {side} av terrassen` (e.g. `Sett deg på sørvestsiden`) — `13pt / 500 / --muted`

**Azimuth-to-text mapping** (8-point compass):
| Azimuth | Bucket | Text | Seating |
|---------|--------|------|---------|
| 0–45° | N | nord | nordsiden |
| 45–90° | NØ | nordøst | nordøstsiden |
| 90–135° | Ø | øst | østsiden |
| 135–180° | SØ | sørost | sørostsiden |
| 180–225° | S | sør | sørsiden |
| 225–270° | SV | sørvest | sørvestsiden |
| 270–315° | V | vest | vestsiden |
| 315–360° | NV | nordvest | nordvestsiden |

**Spec:** Bordered glass-card, `padding: 14px`, `margin-bottom: 12px`.

### Info row (detail panel info list)

Pattern for structured key-value information rows. Replaces old `SOLSCORE` percentage blocks.

**Layout:** `[icon, 18px, --accent] [label] [optional value or sub]`
- Icon: `32×32`, centered, `18px` symbol, `--accent` color
- Label: `flex: 1`, primary text `14pt / 600 / --text`, optional sub-text `12pt / 500 / --muted` below, `margin-top: 2px`
- Value (optional): right-aligned, `13pt / 500 / --accent`, or empty for structural spacing

**Info rows shown in detail panel** (in order):
1. **Busyness** (if available): `👥 Travelt nå` sub-label, right value `~{percentage}%`
2. **Noise** (if available): `🔊 {label}` where label is bucketed from 0–100 score:
   - `0–33`: Rolig
   - `34–66`: Moderat trafikkstøy
   - `67–100`: Mye trafikkstøy
   - No sub-text (was attempting to show "nearest street" but this data is sparse; drop it for now)
3. **Hours** (always): `🕐 Åpent til {closing_time}`, sub-text `Kjøkken til {kitchen_close}` if available

**Card spec:** Bordered glass-card, `overflow: hidden`, rows separated by `border-bottom: 1px solid var(--border)`. Last row has no border. `margin-bottom: 14px`.

### Detail panel footer

Two centered button links:
- `Rediger informasjon`
- `Rapporter feil`

Both: `13pt / 500 / --muted`, `border: 1px solid var(--border)`, glass-card background, `8px 14px` padding, `border-radius: 10px`. Centered row, `gap: 10px`.

## Typography

Add these global rules to the Typography section:

### Capitalization

- **ALL CAPS** is reserved for small metadata labels only (e.g. old `LYS TIL`, `SOLSCORE` patterns — though both are retired in this redesign). Do not use CAPS on primary hero text or section headlines. Primary hero text uses sentence case.

### Tabular numerals

Apply `font-variant-numeric: tabular-nums` to all time and duration values to prevent layout shift as numbers change during scrub or time updates:
- Absolute times: `14:15`, `09:30`
- Durations: `3t 10m`, `15 min`, `1t 45m`
- Percentages in data contexts: `~70%`

### Duration format

- Format: `3t 10m`, `1t 45m`, `15 min`, `5 min`
- "t" = "timer" (hours), "min" = "minutter" (minutes)
- Use `min` alone under one hour
- No zero-padding (e.g. `3t 5m` not `03:05`)
- Minimum displayed: `5 min` (round up any window shorter than 5 minutes)

## Performance & accessibility rules

1. **`backdrop-filter` is only applied to the three glass levels** and nothing nested inside them. A card inside a panel doesn't need its own `backdrop-filter` — the panel has already painted the glass below it. Exception: calendar sticky headers inside the calendar sheet, which need their own backdrop to prevent tile content bleeding through on scroll.

2. **Reduced transparency.** The `@media (prefers-reduced-transparency: reduce)` block at the bottom of the CSS replaces all glass backgrounds with solid `rgba(17, 30, 56, 0.97)` and removes all `backdrop-filter`. The spec-highlight `::before` stays — it's cheap and preserves visual identity without transparency.

3. **`will-change: transform`** is only set on `#detail-panel`, `#ptb-cal-float` (calendar sheet), and `#panel` (mobile only, since it slides vertically). No `will-change: backdrop-filter` anywhere — it bloats GPU memory.

4. **No animation of `backdrop-filter` itself.** Cross-fades, slide-ins, and rotations animate `opacity` and `transform` only. The glass stays constant.

## Don't

- Don't use pure white (`#FFFFFF`) or pure-white glows for interactive elements or text. Use `--text` (`#FFF2EB`).
- Don't add new color tokens without documenting them here first.
- Don't encode weather with brand colors or vice versa.
- Don't use more than three type scales in one composition.
- Don't use sub-hour segmentation on the time bar. Scrub continuously, paint discretely.
- Don't duplicate information across adjacent elements. Sun count ("X steder i solen") lives in the list header only — never in the readout.
- Don't animate on every value change. Rapid scrubs turn into visual noise. A 100ms cross-fade on numeric updates is the ceiling.
- Don't introduce glass surface variants outside the three documented levels. If the existing levels don't fit, update this document.
- Don't create shadow values ad hoc. Use the three documented elevation levels.
- Don't open pickers or secondary sheets that cover the primary output they affect. The user needs to see the result while picking (see Principle 5).
- Don't fill calendar tile backgrounds with weather-ramp colors. Weather lives in sub-elements (glyph, temperature text). The tile container stays neutral so selection rings are unambiguous.
- Don't use dashed borders anywhere in the calendar or the wider UI. Dashed borders read as prototype placeholders and are not part of this design system. Use reduced-opacity solid borders to signal reduced availability.
- Don't introduce `html2canvas`-based background sampling for glass effects. It janks mobile and the cost scales with every map redraw.
- Don't use `backdrop-filter: url(#svg-filter)` for refraction. Safari / iOS — our primary target — does not support it. The effect would be invisible to most users while still costing complexity.
- Don't apply `backdrop-filter` to nested elements inside an already-glass surface. Redundant GPU work (exception: calendar sticky headers, which need it to prevent scroll bleed-through).
- Don't migrate the pin **sunny** state off `--accent`. The fill is a system-level promise ("this venue has sun right now"); owning the accent role there is intentional.
