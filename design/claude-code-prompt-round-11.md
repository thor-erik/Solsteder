# Prompt for Claude Code — Pin tier redesign, round 11

Paste everything below into Claude Code on the same branch as rounds 1–10. Round 10 (Shades Glass pass) must already be applied. Every task updates behavior plus `DESIGN.md` where noted. Where an instruction below conflicts with a current rule in `DESIGN.md` or in round 10, the instruction wins and the doc must be updated to match.

---

## Context

Round 10 formalised the Shades Glass visual language across all chrome surfaces and began migrating pins onto it. This round **supersedes round 10 Task 2** with a full pin redesign — not just a palette migration, but a rethink of what pins communicate and how.

**What was wrong with the previous pin system:**

1. Time-only pins (e.g. `10:00` floating over the map) had no venue identity. Users had to tap to learn which venue was becoming sunny.
2. Color was doing double duty — yellow vs white text inside an identical dark pill read as noise at map scale.
3. Four disconnected pin states with no visual language tying them together.
4. Sun-disc icons on Hero pins looked underutilised when the sun was stable for hours, and the fading-sun levels looked like chipped coins rather than "sun running out."

**The new model — two tiers, one information rule, one actionable modifier.**

- **Tier 1 — Hero.** Venues in sun at the selected time. Tangerine pill. **Default state: name only**, no icon. The tangerine pill itself is the "sunny right now" signal. When sun is **running out (≤60 min left in the window)**, the end-time is appended with a `til` prefix to disambiguate it from an arrival time. Format: `Olivia · til 15:45`. No icon on Hero — the tangerine pill plus the explicit `til` carries the semantics.
- **Tier 2a — Waiting.** Venues currently shaded, with sun arriving within 120 min. Glass pill (Shades Glass action level). **Layout: shadow-icon on the left (as a badge), name, middle-dot, arrival-time on the right.** Format: `[shadow-icon] Kaia · 15:15`. The shadow-series icon retreats from the top as the user scrubs the slider forward — visually narrating the wait. The icon stays left because on Waiting it carries real sub-state (how imminent is sun), not just decoration.
- **Tier 2b — Context.** Everything else. Small glass dot. No text. Present for spatial context, not choice.

**One information rule: absolute clock time, always.**

Planning is Shades' primary use case ("when should I head to X?"). Absolute times don't decay while the user thinks. Relative `+45m` was considered and rejected — it requires the user to remember what "now" means, breaks silently when they scrub the slider, and forces a format switch between now-mode and scrubbed-mode that they must re-learn each time. One format, always.

**Icons and visual consistency.**

- Shadow-series (Delft Blue filled discs, 4 levels: 25/50/75/100) lives on Waiting pins. Index picked from `minutesUntilSun`. This is a designed asset with real visual weight.
- Sun-series PNGs (5 levels) **do not appear on pins** in this round. They stay in `design/shades-status-icons/` and are used in the detail panel and day-arc only. The tangerine pill itself is the "in sun" signal on the map.
- **No sunset glyph or any other graphic on Hero pins.** An earlier iteration experimented with a custom sunset glyph, but a thin line-drawing next to the richly-designed shadow-series discs created a visual category-mismatch — the two looked like they came from different apps. The explicit word `til` does the disambiguation job at a fraction of the design cost, and the single icon family (shadow-series only) keeps the system coherent.

**Other rules:**

- On Waiting pins, the icon is **on the left** — a leading badge because the icon carries primary sub-state, not trailing decoration.
- Hero pills never carry an icon. The tangerine pill color *is* the state.
- Closed-but-opens-into-sun state is a small clock **badge** in the bottom-right corner of the Tier 2a shadow-icon.
- Pins currently have no drop shadow on the map. They need one (see Task 4).

---

## Task 1 — Import shadow-series, retire legacy icons

**Problem.** `design/status-icon-svg/` contains the older 5-icon set (`1.png`–`5.png`) used by `render-pins.js`'s `_sunIcons` array. The old set doesn't cover shadow states at all, and with the new tier system the sun-series PNGs are no longer drawn on pins either.

**Do:**

1. Confirm `design/shades-status-icons/` contains the 9 designed assets:

   ```
   sun-0-percent.png
   sun-25-percent.png
   sun-50-percent.png
   sun-75-percent.png
   sun-100-percent.png
   shadow-25-percent.png
   shadow-50-percent.png
   shadow-75-percent.png
   shadow-100-percent.png
   ```

2. In `render-pins.js`, **remove the old `_sunIcons` preloader entirely**. Replace with:

   ```js
   const _shadowIcons = ['25','50','75','100'].map(p => {
     const img = new Image();
     img.src = `design/shades-status-icons/shadow-${p}-percent.png`;
     return img;
   });
   ```

   Preserve wait-for-all-to-load-before-rebuilding behavior. Clear the sprite cache when icons finish loading.

   The sun-series PNGs must still be preloaded somewhere (detail panel / day-arc use them) but that loader should live with whichever module actually consumes them, not in `render-pins.js`. Move or leave in place as the existing code structure dictates — just don't load them in `render-pins.js`.

3. Retire `design/status-icon-svg/` from the runtime. Do not delete the folder in this commit (historical reference), but remove all references from JS and CSS. No code path should load `status-icon-svg/*.png` after this task.

4. **Shadow icon mapping helper:**

   ```js
   // Tier 2a: pick shadow icon by minutes until sun arrives.
   // Lower index = less shadow left (sun closer).
   function _shadowIconIdx(minutesUntilSun) {
     if (minutesUntilSun <= 15) return 0;   // shadow-25  — sun imminent
     if (minutesUntilSun <= 45) return 1;   // shadow-50
     if (minutesUntilSun <= 90) return 2;   // shadow-75
     return 3;                               // shadow-100 — far edge of Waiting
   }
   ```

   Thresholds are a starting point — tune after seeing it on the real map.

**Update DESIGN.md.** Under **Components → Icons**, add:
- Shadow-series (4 levels) — used only on Waiting pins; index threshold table from the helper above.
- Sun-series (5 levels) — used on detail panel and day-arc; **no longer drawn on pins**.
- Explicit note: *"Hero pins carry no icon. The tangerine pill color is the 'in sun' signal. When disambiguating the time (end vs start), the textual prefix `til` is used instead of a graphic, to avoid mixing visual languages."*

---

## Task 2 — Pin tier system: Hero (default + actionable), Waiting, Context

**Problem.** The current `buildSprite(v, state, selected, hour, dateStr)` produces four visually-unrelated variants. We're collapsing to three tiers (Hero / Waiting / Context) plus one actionable Hero sub-state. Hero carries text only. Waiting carries a leading icon plus text. Context is a dot.

**Do:**

1. Introduce a tier assignment function. For every VENUE × selectedTime, classify:

   ```js
   const WAITING_HORIZON_MIN = 120;   // pins count as Waiting if sun arrives ≤120 min
   const HERO_ACTIONABLE_MIN = 60;    // Hero appends `til HH:mm` when ≤60 min sun left

   function classifyPin(v, dateStr, hour) {
     const { windows } = computeSunWindows(v, dateStr);
     const nowInSun = windows.find(w => hour >= w.start && hour < w.end);
     if (nowInSun) {
       const minsLeft = Math.round((nowInSun.end - hour) * 60);
       return {
         tier:       'hero',
         actionable: minsLeft <= HERO_ACTIONABLE_MIN,
         endHour:    nowInSun.end,            // for absolute time display
         minsLeft,                            // for diagnostics
       };
     }
     const next = windows.find(w => w.start > hour);
     if (next && (next.start - hour) * 60 <= WAITING_HORIZON_MIN) {
       const mins = Math.round((next.start - hour) * 60);
       return {
         tier:          'waiting',
         startHour:     next.start,           // for absolute time display
         minutesUntil:  mins,                 // for icon index
       };
     }
     return { tier: 'context', hasSunLaterToday: !!next };
   }
   ```

   Surface `WAITING_HORIZON_MIN` and `HERO_ACTIONABLE_MIN` as module constants so they're tunable.

2. **Tier 1 — Hero pill (default, >60 min sun left).** Rewrite the sunny branch of `buildSprite`:

   - Pill: tangerine fill (`#FFAF85`), radius = `height / 2`, height `26px`.
   - **Contents: name only.** `shortName(v.name)`, 11px bold Inter, color `#2a1a0c` (accent-on). Horizontal padding `0 12px`.
   - **No icon in this state.** The tangerine fill is the full "sunny now" signal.
   - Pill rim: `inset 0 1px 0 rgba(255,242,235,0.45)` — bright top sheen drawn in canvas via a 1px stroke along the top arc (cf. round 10 Task 2 technique).
   - Soft tangerine accent glow behind the pill: existing radial is kept, recentered on the new layout.
   - Selection ring: `rgba(255,175,133,0.9)` 2px stroke, offset 2px outside the pill.

3. **Tier 1 — Hero pill (actionable, ≤60 min sun left).** Same tangerine pill, but contents:

   - **Layout: name · "til" · end-time.** No icon, no glyph. Example: `Mocca · til 15:05`.
     - Name: `shortName(v.name)` — see Task 3 for width budgeting.
     - Separator: middle-dot `·`, color `rgba(42,26,12,0.5)`, 3px horizontal margin each side.
     - `til`: lowercase, same 11px weight but with `font-weight: 600` (one step lighter than the name's 700), color `rgba(42,26,12,0.72)`. Followed by a single 4px space before the time.
     - End-time: `formatHourAsClock(endHour)` (e.g. `15:05`), 11px bold Inter, tabular-nums, color `rgba(42,26,12,0.72)` (same lower-contrast as `til` — name is the bright foreground, the "til 15:05" cluster is the qualifier).
   - Horizontal padding: `0 12px` (symmetric, same as default Hero).
   - Pill rim, accent glow, selection ring: identical to default Hero.
   - Rationale: no graphic. The combination of tangerine pill + explicit `til` word conveys "sun ends at HH:mm" without needing a glyph that would clash with the shadow-series visual weight on Waiting.

4. **Tier 2a — Waiting pill.** New glass branch:

   - Pill: canvas-painted Shades Glass action-level. Linear gradient `rgba(20,46,82,0.42) → rgba(32,73,131,0.26)` at 135°, over base `rgba(20,46,82,0.50)`. 1px inner top sheen `rgba(255,242,235,0.18)`. 1px border `rgba(156,189,231,0.18)`. Height `24px`, radius `12px`.
   - **Layout: shadow-icon · name · separator · arrival-time.**
     - Shadow-icon: 14×14px circle drawn from `_shadowIcons[_shadowIconIdx(minutesUntil)]`, 6px from pill left edge.
     - Gap: 7px.
     - Name: `shortName(v.name)`, 11px bold Inter, color `#FFF2EB` (seashell). Width budget: see Task 3.
     - Separator: middle-dot `·`, color `rgba(255,242,235,0.4)`.
     - Arrival-time: `formatHourAsClock(startHour)`, 11px bold Inter, tabular-nums, color `#FFAF85` (tangerine, matches the sun color signal).
     - Right padding: 10px.
   - Pill stem: dashed `rgba(156,189,231,0.55)`, 2px wide, 14px tall. Jordy Blue, not amber.

5. **Tier 2b — Context dot.** Replace the existing `shaded` pill + text. New branch:

   - 10×10px circle. Gradient fill matching Shades Glass action level at slightly higher opacity. 1px Jordy border. No stem, no text.
   - If `classifyPin` returns `tier: 'context'` and `hasSunLaterToday === false`, apply the closed-day opacity modifier (dim to 0.42, desaturate slightly).

6. **Selection ring** is consistent across all three tiers: `rgba(255,175,133,0.9)` at 2px, offset 2px outside the pin's visual bounds. No second ring.

7. **Sprite cache key** must include tier, actionable flag, icon index, and modifier flags. Today's key `(id, state, selected, time-bucket)` becomes `(id, tier, actionable, iconIdx, selected, closedBadge)`. For Hero actionable, `iconIdx` is unused (there's no icon) but the end-hour rounded to 5-minute buckets should be included so the sprite updates as the time ticks. For Waiting, time-bucket is the icon-index threshold, not raw minutes — this keeps the cache hit rate high during slider scrubs.

**Accept criterion.** Open the app at 14:30 in central Oslo.
- Most Hero pills show just a name (e.g. `Vippa`).
- A few Hero pills — those where sun ends in the next hour — show `Name · til HH:mm` on the same tangerine pill. No icon on Hero.
- Waiting pills show `[shadow-icon] Name · HH:mm` with the shadow-icon as a leading badge on the left.
- Context dots have no text.
- No pin shows a relative time like `+45m` anywhere.
- No pin carries a sunset glyph or any other Hero-side icon.

**Update DESIGN.md.** Create a **Pins** section after **Icons** in the Components list. Include:
- The three-tier taxonomy with one-line descriptions, including the Hero default / actionable split.
- A table mapping tier × contents × pill style × icon source × time source.
- The `WAITING_HORIZON_MIN = 120` and `HERO_ACTIONABLE_MIN = 60` constants with rationale (actionable ≤60 min is when the user needs to decide whether to head there; 120 min Waiting horizon is the edge of "soon enough to wait for").
- Explicit statement: *"Pins carry one of three information payloads: name only (Hero default), `name · til HH:mm` with no icon (Hero actionable), or `[shadow-icon] name · HH:mm` with leading shadow-icon badge (Waiting). Context dots carry presence only."*
- Rationale for the asymmetry (Hero text-only, Waiting icon + text): *"Waiting's shadow-icon carries sub-state — how imminent the sun is — that the arrival time alone doesn't show at a glance. Hero's only sub-state is 'how much sun time left', which is literally the end-time number. An icon would be redundant there, and a thin custom glyph next to the richly-filled shadow discs looked like two visual languages. The `til` prefix does the disambiguation job cheaply."*
- Note that the old notched-pill shape is retired — single flat-pill silhouette.

---

## Task 3 — Time display, separators, and width budgeting

**Problem.** Name + time on a pill increases pill width. We accept this cost only when the time is actionable; we limit the damage with naming and styling rules.

**Do:**

1. **Time format helper.** Add to `render-helpers.js`:

   ```js
   // Converts an hour-as-float (e.g. 15.75) to a clock string ("15:45").
   function formatHourAsClock(hourFloat) {
     const h = Math.floor(hourFloat);
     const m = Math.round((hourFloat - h) * 60);
     if (m === 60) return `${String(h + 1).padStart(2, '0')}:00`;
     return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
   }
   ```

   Do **not** round to nearest 5 or 15 — showing `15:47` honestly is better than showing a slightly-wrong `15:45`. (The sprite cache buckets to 5 min anyway, so rendering cost is bounded regardless.)

2. **Dynamic name budget.** Extend `shortName(name, maxLen)` (or add an overload) so the caller can request tighter truncation when a time suffix is present.

   - Hero default (name only): `shortName(v.name, 14)` — room for up to ~14 chars.
   - Hero actionable (`Name · til HH:mm`): `shortName(v.name, 9)` — `til HH:mm` adds ~50px including separator and padding, so name gets a tighter budget than Waiting.
   - Waiting (`[icon] Name · HH:mm`): `shortName(v.name, 10)`.

   These budgets keep the combined pill under ~145px for typical Oslo names. Test with the longest venue names in `data/venues.json` — if any overflow, tighten further or add ellipsis-aware measurement using `ctx.measureText`.

3. **Typography details.**
   - Name and time both use 11px Inter. Name is bold (700); `til` and the time both use 600 on Hero to create a readable two-weight hierarchy. On Waiting, time is 700 (tangerine draws the eye).
   - Time uses `font-variant-numeric: tabular-nums` so scrubbing the slider doesn't cause horizontal jitter as minute digits change.
   - Separator is middle-dot `·` (U+00B7), not `, ` or ` - `. Middle-dot saves ~6px vs. other options and reads as a soft disambiguator.
   - Separator color: `rgba(42,26,12,0.5)` on tangerine (Hero), `rgba(255,242,235,0.4)` on glass (Waiting).
   - Hero actionable `til` keyword: same color as the time (`rgba(42,26,12,0.72)`), weight 600. `til` + one 4px space + time reads as a single qualifier phrase.
   - Time color on Hero: `rgba(42,26,12,0.72)` — intentionally below the name's full contrast, so the eye reads *name first, "til 15:05" second*.
   - Time color on Waiting: `#FFAF85` (tangerine) — matches the sun theme. 11px bold, tabular-nums.

4. **Localization note.** `til` is Norwegian for "until". The current app is Norwegian-only; if/when an English/other-language mode ships, this string becomes `til` → `until` (or locale equivalent). Wrap it in whatever i18n helper the project uses, or leave a `// i18n TODO` comment at the literal.

5. **Now-mode is no longer a factor.** The old now-mode-vs-scrubbed branching is removed. Always use `formatHourAsClock`.

**Update DESIGN.md.** Under **Pins**, add a **Time display** subsection:
- Format: `HH:mm` absolute, always, both tiers.
- Hero shows time **only when `actionable === true`** (≤60 min left).
- Waiting shows time **always** within the 120-min horizon.
- Separator, color, numeric styling rules above.
- State the design principle: *"One format, always. The user's mental anchor (slider readout) and the pin speak the same clock."*

---

## Task 4 — Drop shadows under pins (currently missing)

**Problem.** Pins today have no drop shadow on the map. They rely on color contrast alone, which makes them float ambiguously — harder to tell *which* pin is a pin vs. a map label. Add soft shadows that match the Shades Glass elevation scale.

**Do:**

1. In `buildSprite`, before filling the pill path, draw a drop shadow using canvas' built-in shadow state:

   ```js
   c.save();
   c.shadowColor   = 'rgba(0, 0, 0, 0.35)';
   c.shadowBlur   = 6;
   c.shadowOffsetX = 0;
   c.shadowOffsetY = 2;
   // re-issue the pill path so the shadow is cast from it
   c.beginPath();
   c.roundRect(ox, oy, pillW, PILL_H, PILL_R);
   c.fillStyle = fillColor;
   c.fill();
   c.restore();
   ```

   Per tier:
   - Tier 1 Hero (default + actionable): `shadowBlur: 8, offsetY: 3, rgba(0,0,0,0.40)` + keeps its accent glow separate.
   - Tier 2a Waiting: `shadowBlur: 6, offsetY: 2, rgba(0,0,0,0.35)`.
   - Tier 2b Context: `shadowBlur: 3, offsetY: 1, rgba(0,0,0,0.30)` — micro-shadow, just enough to lift the dot.

2. The sprite canvas must be sized large enough for the shadow to render without clipping. Audit `cW` / `cH` calculations — add `SHADOW_PAD = 6` on all sides before computing canvas dimensions. Adjust `cxA` / `cyA` (anchor positions) to account for the padding.

3. **Performance note.** Canvas `shadowBlur` is expensive per fill, but `buildSprite` runs once per unique cache key, not per frame. Drop shadows go into the sprite image and are then drawn with `drawImage` at full speed. No per-frame cost. Do not apply `shadowBlur` in the main `draw()` loop — only inside `buildSprite`.

**Update DESIGN.md.** Under **Pins**, add an **Elevation** subsection mapping each tier to one of the three documented elevation levels (`low` / `mid` / `high`). Hero → low + accent glow. Waiting → low. Context → micro (document as a new level only if necessary; prefer to reuse `low` with reduced blur via the canvas values above).

---

## Task 5 — Closed modifier as icon badge

**Problem.** The "closed but opens into sun window" case was previously a separate pin state. In the new model it's a modifier on Tier 2a — a small clock badge in the shadow-icon's bottom-right corner.

**Do:**

1. In `buildSprite`, after drawing the Tier 2a shadow-icon, if `v` is closed at the selected time AND the `startHour` from `classifyPin` is ≥ `v.openingHours.open`, draw a small clock badge:

   - Size: `6px` diameter, centered at `(iconRight - 1, iconBottom - 1)`.
   - Fill: `#142E52` (Delft Blue) — sits on a glass pill so needs to be dark, not light.
   - Border: `1.5px` stroke, `#FFF2EB` (seashell) for punch against the Delft fill.
   - Clock hands: two 1px strokes in seashell, one at 30° and one at -60° from vertical (12+2 o'clock indication). Very small — readability at 6px is limited; the *shape* carries more signal than the hands.

2. Badge applies only to Tier 2a. Hero pins are by definition open (the venue is in sun at the selected time, so if its openingHours exclude that hour, it isn't a Hero — it's a Tier 2a with the badge). Context dots don't distinguish open from closed beyond the dim modifier.

3. Badge must be part of the sprite cache key (boolean flag `closedOpeningIntoSun`).

**Update DESIGN.md.** Under **Pins** → **Modifiers**, document the badge placement, colors, and the rule that only Tier 2a carries it.

---

## Task 6 — Tier selection and viewport density

**Problem.** "Name always" is too expensive visually in dense city views. The design must limit how many Hero pins and Waiting pins appear simultaneously, deferring the rest to Context dots.

**Do:**

1. After `classifyPin` runs for every venue in the current viewport, apply a **density filter**:

   ```js
   const HERO_CAP    = 8;   // max Hero pins in a viewport
   const WAITING_CAP = 10;  // max Waiting pins in a viewport
   ```

   - Rank Hero candidates by `sunScore` (existing, from scoring.js) desc. Keep the top `HERO_CAP`; demote the rest to Context.
     - When demoting a Hero candidate that was `actionable`, it becomes a Context dot — the actionable signal is lost. That's the trade we're making: if the viewport is that packed, the user should zoom in to get actionable detail.
   - Rank Waiting candidates by `minutesUntil` asc (closest to sun first). Keep the top `WAITING_CAP`; demote the rest to Context.

2. The demotion applies per-render — when the viewport changes, reclassify. Do not persist a demoted state.

3. At zoom levels below 14, reduce `HERO_CAP` to 5 and `WAITING_CAP` to 5. At zoom 16+, raise to 12 / 15. Above zoom 17 (street-scale), caps become unlimited — the user has chosen to look at a small area and wants everything.

4. Expose the caps as module constants so they're tunable after real-world testing.

**Update DESIGN.md.** Under **Pins**, add a **Density rules** subsection with the caps and the zoom-dependent schedule. State: *"Every venue has a claim to attention, but not every venue has a claim to the user's attention simultaneously. The viewport's top candidates get names; the rest signal presence."*

---

## Task 7 — Verification (required)

1. Open the app at a desktop viewport zoomed into central Oslo at zoom 15. Confirm: ≤ 8 Hero pills, ≤ 10 Waiting pills, dozens of Context dots. On Waiting pills, the shadow-icon sits at the left as a leading badge.
2. At 14:30, look for a venue whose sun window ends before 15:30. Its Hero pill should show `Name · til HH:mm` (no icon, tangerine pill). All other Hero pills should show the name only.
3. Scrub the slider forward by 30 min. A Hero pill that was "default" and has 45 min of sun left should become "actionable" (`· til HH:mm` appears after the name). Scrub backward: it should revert to name-only.
4. On a Waiting pill, scrub forward slowly. The shadow-icon should walk through `shadow-100 → shadow-75 → shadow-50 → shadow-25`, then the pin should reclassify to Hero (default or actionable depending on remaining window) when the sun arrives.
5. Confirm no pin anywhere shows a relative time like `+45m` or `+1h 20m`. All pin times are absolute `HH:mm`.
6. Confirm no pin shows a sunset glyph, a half-sun-over-horizon symbol, or any Hero-side graphic. Hero pills are text-only.
7. In DevTools Performance, record 5 seconds of scrubbing. Frame rate ≥ 50fps on mid-range laptop. `buildSprite` should be called only when an icon-index bucket boundary or 5-min end-hour bucket is crossed, not on every scrub tick.
8. Visually confirm every pin has a drop shadow. Compare to DESIGN.md → Elevation scale: Hero should sit noticeably more elevated than Context.
9. Close a random venue's opening hours at the test hour, leave its sun window open — its Tier 2a pin should show the clock badge on the shadow-icon. Re-open the hours; badge disappears.
10. Find the venue in `data/venues.json` with the longest name. Confirm its Hero default pill fits without overflow, its Hero actionable pill (`ShortName · til HH:mm`) stays under ~150px wide, and its Waiting pill (`[icon] ShortName · HH:mm`) stays under ~150px wide.
11. Run `node scripts/audit-layout.mjs pin` if that audit exists for pins; otherwise skip.

---

## Workflow

- One commit per task, message format: `round 11 task N — <short summary>`.
- Push after each commit.
- `pin-tier-sketch.html` and `liquid-glass-demo.html` in the repo root are design scratch files from the discussion that produced this prompt. Leave them in place as reference; do not reference them from app code.
- If a task's changes conflict with existing behavior that is worth preserving (e.g. a specific pin-layout quirk a user depends on), surface the conflict in the commit message rather than silently breaking it.
