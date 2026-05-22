# Design fix list

Running punch-list from the design-system review (started 2026-05-21). Living doc — appended as new issues surface.

Tags: `[BUG]` broken/incorrect · `[CONSISTENCY]` works but inconsistent · `[DESIGN]` judgment/opinion · `[EXTERNAL]` outside this repo · `[DOC ✓]` already fixed in DESIGN.md, code still pending.

## High priority

- [ ] `[BUG]` **Locale leaks across render paths.** Pre-login the UI is English; after sign-in the profile locale only re-renders *some* surfaces. Map pins, invite flow, and the time formatter go Norwegian while the list and detail panel stay English — the hour unit flips (`4h 10m` vs `4t 10m` vs `8t 40m`) between surfaces, sometimes in one string (`4t 10m left`). Fix: on `SIGNED_IN`, re-read locale on every render path — list (`ui-list.js`), detail (`ui-detail.js`), pins (`render-pins.js`), and the hour formatter. Confirm intended post-login default for a `no` profile.
- [ ] `[BUG]` **Login splash contrast failure (a11y).** Cream heading text ("Sign in to get more out of Shades", "Save favourites") on the light blurred-map background is effectively invisible (well below WCAG 4.5:1). It's a lens-dark component rendered over a light backdrop with no scrim. Fix per the surface model: a Tier-1 panel must guarantee its own contrast (minimum Delft Blue tint floor) regardless of backdrop — or switch this surface to lens-light ink.

## Consistency

- [ ] `[CONSISTENCY]` `[DOC ✓]` **Per-flow button classes → 4 roles.** `dprcv-cta-primary`, `dpacc-action-primary`, `fts-popup-primary`, `inbox-btn-accept`, `dp-action-cta`, `plan-preview-btn` are one logical role implemented many times. Collapse into primary / secondary / tertiary / destructive (see DESIGN.md → "Button roles"). Kill the cool grey-*filled* secondary variant.
- [ ] `[CONSISTENCY]` **Secondary text uses cool grey.** Cards show `Sentrum · Restaurant · 87 m` in `#9BA9BC` (cool grey) — DESIGN.md principle 3 wants cream-at-opacity (`rgba(255,244,224,0.78)`), same hue as the title.
- [ ] `[CONSISTENCY]` `[DOC ✓]` **Icon stroke-width sprawl.** Ten stroke widths in use (2, 1.5, 1.8, 2.4, 2.2, 3, 2.5, 1.6, 1.2, 2.6). Normalise all ~109 inline SVGs to the Lucide standard: 24×24, stroke 2, round caps, `currentColor` (see DESIGN.md → "Icons").
- [ ] `[CONSISTENCY]` `[DOC ✓]` **Emoji in the UI → SVG.** Live/fallback emoji to replace with Lucide SVGs: `💨 4 m/s` wind chip (top strip), `📍` in check-in info (`auth.js`), shelter labels `🛡`/`💨`/`◑` (`ui-shelter.js`), share-context `🌧️🌇🌅` (`ui-detail.js`), weather icon strings (`weather.js`), notification toast icons (`notifications.js` — some already map to SVG). Remove emoji fallbacks entirely (e.g. `getMapsIcon('phone') : '📞'`).

## Surface & elevation (code follow-up to the new model)

- [ ] `[DOC ✓]` **Dropdown bleed-through.** The sort dropdown is translucent and the navy cards show through it. Raised layers go opaque + shadow (see DESIGN.md → "Overlap & dropdowns").
- [ ] `[DOC ✓]` **Add elevation tokens.** `--scrim` (dark veil for focus-stealing layers) + the per-world opacity/shadow step tokens. Tag panels as chrome vs content.
- [ ] `[ARCHITECTURE]` **No opacity system — 40+ ad-hoc alphas.** Zero opacity/alpha tokens in `:root`; 40+ distinct rgba alphas, with near-dupes (`0.2`/`0.20`, `0.4`/`0.40`, `0.5`/`0.50`) proving hand-authoring. The surface model says "elevation = opacity step" but never defines the steps. **Fix:** define opacity tokens by role — (1) surface tint ladder (`--surface-chrome 0`, `--surface-action 0.55`, `--surface-content 1.0`, `--surface-raised ~0.96`), (2) line/fill alpha (`--line-faint 0.08`/`--line 0.12`/`--line-strong 0.22`; `--fill-faint 0.06`/`--fill-soft 0.12`/`--fill 0.16`), (3) element-opacity states (`--o-disabled 0.40`, `--o-muted 0.55`, `--o-secondary-text 0.78`, `--o-scrim 0.55`). Keep shadow alphas inside the shadow tokens. Rules: opacity is a token not a literal; snap to nearest stop; extend `validate-tokens.mjs` to flag raw alphas. **DECIDED & locked in DESIGN.md (2026-05-21) — see "Surface system tokens".**
- [ ] `[DESIGN]` **Chrome tint: drop 0-opacity, add a Jordy-blue wash.** Chrome panel is currently `rgba(17,30,56,0.00)` (pure blur, no tint) → tone/contrast ride on the map + zero brand presence. Add a subtle **Jordy Blue `#9CBDE7`** wash (brand's "muted chrome" colour; reads as a tinted sunglasses lens; keeps ink text legible). Dial ~0.08–0.16 over the blur in the lab; cream is the warm alternative. **Two surface tints, one per world:** Delft Blue (dark content) vs Jordy (light chrome) — corrects the earlier "chrome = Delft Blue" note.
- [ ] `[ARCHITECTURE]` **Implement the surface system in `:root` (the code pass).** DESIGN.md "Surface system tokens" is now the locked spec (fills, blur, shadow, borders). Add the `--surface-*` / `--blur-*` / `--shadow-*` / `--line-*` tokens to `:root`; repoint components off the old `--glass-panel-bg` / `--glass-card-bg` / `--glass-action-bg` / `--glass-blur-*`; convert surface controls to outline chips (`--surface-control` ≈1% + `--line-l-strong`, selected → honey-dim); pair every `backdrop-filter` with `-webkit-`; extend `validate-tokens.mjs` to flag raw alphas, `blur()`, and border rgba. Borders are also ad-hoc today (`rgba(155,169,188,0.34)`, `rgba(156,189,231,0.28)`…) — fold them into `--line-*`.
- [ ] `[DESIGN]` **Subordinate actions look disabled.** In the accepted-plan carousel, "Legg til / Veibeskrivelse / Detaljer" are so faint next to the honey CTA they read as disabled. Give the secondary tier more presence (Tier-3 glass).

## Deeper review (2026-05-21, pass 2)

- [ ] `[ARCHITECTURE]` **Per-flow component duplication is the root cause.** Buttons, locale handling, and likely the sun/phase bar + sheets are cloned-and-restyled per flow (`dprcv-*`, `dpacc-*`, `fts-*`), which *guarantees* the drift seen in the button, locale, and surface findings. Highest-leverage fix: extract the real shared components — CTA, sun-bar, venue tile, sheet, info-row — so drift becomes impossible. The DESIGN.md ladder/model is only spec until the code stops forking per flow.
- [x] `[DECIDED]` **Social action IS the intended primary CTA** (share-loop is the deliberate growth wedge). Keep "Invite/Share" as the honey CTA on venue detail + carousel. **One carve-out to revisit:** on the *accepted-plan* screen the user is confirmed-and-going, so "Veibeskrivelse" (directions) is likely the truer primary there — social-primary everywhere else.
- [ ] `[DESIGN]` **Accepted-plan screen: reconsider primary = directions** (see decided item above), not "Del videre".
- [ ] `[DESIGN]` **Flat surfaces vs glass motion are incoherent.** Flattening removed the lens *surface* cues (gradients, mirror-sky, chromatic, sheen) but kept the lens *motion* cues (tilt, spotlight, rim). A flat card that tilts/glints tells two stories. **Resolution direction:** the lens FX is hover-driven = invisible on phones (the real audience). Redirect that polish budget to mobile-native motion (below) rather than keeping desktop-only glass FX.

## Premium mobile polish (priority order — "billion-dollar feel")

The goal is touch-native craft + consistency + restraint, not added decoration. Spend the budget where phone users actually are.

- [ ] `[POLISH]` **Haptics — highest ROI.** `@capacitor/haptics` (already on Capacitor). Light selection tick per step while dragging the time scrubber (signature moment); soft impact on pin-select; success haptic on RSVP. Ticks + confirmations only, never decorative.
- [ ] `[POLISH]` **Gesture-tracking + spring physics.** Sheets follow the thumb 1:1 with momentum and rubber-band at edges; detail drag-to-expand feels weighted; animations are interruptible mid-flight. Swap linear/ease for spring curves on sheets/transitions.
- [ ] `[POLISH]` **Shared-element continuity.** Pin tap → card grows from the pin's location; list card → expands into detail (not a new screen sliding over). Spatial continuity = strong premium signal, perfect for a map app.
- [ ] `[POLISH]` **Relight the map as you scrub** (the unforgeable one). 3D building shadows sweep in real time as the time slider moves — polish + core value prop + the one thing only this app can do. Sets up the stripe-shade idea.
- [ ] `[POLISH]` **The unglamorous 80%:** tabular figures (no twitching numbers), skeleton shimmers not spinners (incl. the blank 1/6 photo card), flawless cold-start (wire the existing Shades Loader → smooth handoff into the map), pixel-aligned icons on text baselines, one accent + generous whitespace.
- **This week, if picking two:** scrubber haptics + spring-physics thumb-following sheets.
- [ ] `[DESIGN]` **Stripe motif = "shade", as data not decoration.** Core principle: **honey means sun, the stripe means shade — both are information, never ornament.** Placements, best first:
  - **Map building-shadow polygons** get a subtle diagonal-stripe fill instead of flat grey → the map reads in the brand language; striped shade sweeps in real time when scrubbing (converges with map-relight polish). Best idea on the list.
  - Sun bars / timelines: make the existing hatched shade rigorous — the *only* texture for shade, logo's angle + stripe ratio, everywhere it appears.
  - In-shade pins: faint striped treatment vs the honey "in sun" pill.
  - Loading / empty states: slow diagonal barber-pole shimmer (use the Shades Loader work); striped field for the empty photo card.
  - **Avoid:** striped dividers/backgrounds/"brand sticker" use — cheapens it; also moiré + reduced-motion hazards. Tokenise angle/width/ratio/colour once (dark variant needs a fatter ratio for perceptual parity per the brand pack) and use only for shade.
- [ ] `[DESIGN]` **Login is a wasted brand moment** (beyond the contrast bug). It's a blurred map with illegible text; the excellent mark is absent. Use a solid Cream/Delft background + the stacked lockup + real Delft-blue text — legible *and* on-brand.
- [ ] `[DESIGN]` **Sun/phase bar is overloaded + likely per-flow.** It carries time selection + sun/shade + weather; the share-screen variant (six tiny glyphs) is near overload. Unify into one canonical component with a legend/affordance.
- [ ] `[DESIGN]` **Invite nudge-grid coupling.** The +5min…+2t grid of eight floats beneath "Jeg blir med" but logically belongs to "Kommer senere". Re-couple it under the later-arrival path.
- [ ] `[CONSISTENCY]` **"Travelt nå ~71%" reads as false precision.** Busyness should be a word/level, not a percent of an unclear base.
- [ ] `[CONSISTENCY]` **Use tabular figures** for times, sun-hours, and temps so layout doesn't twitch as digits change (`font-variant-numeric: tabular-nums`).

## Blur

- [ ] `[ARCHITECTURE]` **Blur system is half-built, mostly bypassed.** 4 tokens exist (`--glass-blur-panel/card/action/pill`) but only 48 of ~95 `backdrop-filter`s use them; 47 use raw `blur()`. 10 distinct radii in use (1/3/4/6/8/10/12/16/20/22px); the most-used value `blur(3px)` (20×) isn't even a token. **Fix:** 4 role-based stops snapped to the surface tiers — `--blur-sm 3px` (chips/pills), `--blur-md 6px` (panels/chrome), `--blur-lg 12px` (overlays/modals), `--blur-xl 20px` (full-screen scrim). Rules: token not literal; snap to nearest; `validate-tokens.mjs` flags raw `blur()`. **DECIDED & locked: `--blur-control 2px`, `--blur-surface 4px` (subtle frost). See DESIGN.md "Surface system tokens".**
- [ ] `[BUG?]` **`-webkit-backdrop-filter` likely missing on most blurs (iOS).** ~95 `backdrop-filter` declarations but only 24 `-webkit-backdrop-filter`. On iOS WebView (primary platform) + older iOS Safari, blur doesn't render without the `-webkit-` prefix → frosted-glass silently missing on those devices. **Verify per-declaration pairing on a real iPhone.** If unpaired, add the prefix (ideally fold both into the blur token usage so they can't drift apart).

## Skeletons (loading state)

- [ ] `[BUG]` **Skeleton ≠ real card height → CLS jump.** `renderSkeletonCards` (ui-list.js) emits a *fixed* row1 + meta + one timeline block, but real cards have **variable** height: an optional pills row (the "+1h 35m" badge, present on some cards), the timeline block, and a self-line-heighted `card-name` that can wrap. Badge-bearing cards are taller than any skeleton. **Fix:** give `.venue-card` a deterministic `min-height` the skeleton inherits, so footprint is identical regardless of content — don't pixel-tune block heights (the real heights vary).
- [ ] `[DESIGN]` **Skeleton blocks should be glass/translucent, not blue.** Current `.skel` blocks are Jordy-blue `rgba(156,189,231,0.22)` → reads as *blue content*. Switch to cream-at-low-opacity `rgba(255,244,224,0.08–0.10)` (principle 3 cohesion; opacity step, not a new hue; reads as *absence of content*). Keep the skeleton **card** the same opaque Delft Blue box (footprint match). Replace the whole-card opacity pulse with a **sweeping translucent sheen** (reduced-motion → static blocks). Keep the diagonal stripe OUT of the loader — stripe means shade, not loading.
- [ ] `[CONSISTENCY]` **`.venue-card` box-shadow still has glossy inset sheens** (`inset 0 1px 0 rgba(255,250,235,0.16)`, `inset 0 -1px 0 …`) — the flat pass retired these via `--glass-inset`, but the card hardcodes them directly, bypassing the token. Flatten to drop-shadow only.

## Not yet addressed (backlog — raised 2026-05-21)

- [ ] `[ARCHITECTURE]` **Typography / spacing / radius are unsystematized — the biggest gap.** 22 distinct font-sizes and 20 distinct radii in raw px; `--text-*` and `--space-*` tokens used **0×**, `--radius-*` once (278 raw padding decls). The whole primitive layer the doc points to is bypassed. **DECIDED & locked in DESIGN.md** — type scale (6 roles, Display = Inter 900 −0.03em from the logo, body 15 / inputs 16, tabular figures), radius (8/12/20/pill), **and spacing (4px base + 2px/6px fine steps; kill 10px; old `--space-*` failed because it omitted 2/6).** Implement = wire `--text-*` / `--radius-*` / `--space-*` tokens, migrate the literals (22 sizes, 20 radii, 278 paddings), extend `validate-tokens.mjs` to flag raw `font-size` / `border-radius` / `padding`. Highest "premium feel" lever; do before/with the surface code pass.
- [ ] `[DECIDED]` **Logo font = use it.** The "cool" logo font is just **Inter 900 tight-tracked** — now the Display tier of the type scale. Free (Inter already loaded), on-brand, distinctive. Apply to detail titles, sheet headlines, sign-in.
- [x] `[DECIDED]` **Component states locked** (DESIGN.md → "Component states"). Outline-default → honey-dim-selected fixes the filters. One matrix (default/hover/pressed/selected/focus/disabled/loading), no per-flow variants.
- [x] `[DECIDED]` **Honey paradox — no new colour.** Principle 2 rewritten in DESIGN.md: honey = sun (data, repeats freely); the one CTA per screen stays distinct by being solid + elevated + on a dark surface. Fallback if ever lost = Delft Blue CTA, never a fifth hue.
- [ ] `[DESIGN]` **The map (Tier 0) is undesigned** — it's 70%+ of every screen, treated as a fixed backdrop. Brand application to map style (buildings / water / roads / label density / 3D extrusions) + day / night / sunset states (a sun app at night). Stripe-shade-on-buildings is the only map decision made.
- [ ] `[BUG?]` **Verify text contrast on the NEW surfaces** (we changed every fill, asserted but didn't measure): ink on Jordy-25%-over-map; cream + 0.78 secondary on Delft-90%; honey on Delft-90%; ink on cream dropdown — all ≥4.5:1.
- [ ] `[A11Y]` **Component state matrix + accessibility.** default / pressed / focus / disabled / loading / selected per component; focus rings; ≥44px touch targets; **Dynamic Type / text scaling** (22 hardcoded px won't scale — native apps are expected to support it); reduced-motion. (Good: honey + stripe redundantly encode sun/shade — colourblind-safe.)
- [ ] `[DESIGN]` **Empty / error / offline / location-denied / retry states**, plus content resilience (long-name truncation, missing photo/hours).
- [ ] `[DESIGN]` **Motion timing tokens** — audit duration/easing consistency; define spring curves (mobile) + reduced-motion fallbacks (beyond the philosophy already in DESIGN.md).

## Design opinions (optional)

- [ ] `[DESIGN]` **Eight time-nudge chips** (+5 min … +2t) is choice overload for a "running ~15 min late" gesture. Consider 3 presets + custom.
- [ ] `[DESIGN]` **Two yellows adjacency.** Sunny `#F5C25E` is now the sole accent and Tangerine is dead — but verify the logo mark art is updated to Sunny too (see external item below) so the icon and in-app accent don't read as "almost the same, slightly off."

## External / housekeeping (outside this repo)

- [ ] `[EXTERNAL]` **Brand-pack README + mark art are stale.** They still list Tangerine `#FFAF85` as the accent and show Tangerine in the mark. Update in the design tool to reflect Sunny `#F5C25E` as the sole accent. DESIGN.md is now canonical; the brand pack lags.
- [ ] `[BUG]` **Git state from this session.** Local commit `d87c445` contains the *older* palette note ("Tangerine is mark-only"); the corrected text ("old palette is dead") is uncommitted in the working tree. Also a stale `.git/HEAD.lock` left by the sandbox needs removing (`rm -f .git/HEAD.lock`) before the next git command.

## Resolved this session

- [x] DESIGN.md: added the Surface & elevation model (chrome vs content, controls step away from container, button roles, backgrounds-as-steps, opaque content tiles, overlap rules).
- [x] DESIGN.md: flat-modern pass — solid tints + blur, gradient fills / glossy sheen / mirror-sky + chromatic overlays marked retired; motion and solid shadows kept.
- [x] DESIGN.md: recorded one-yellow rule (Sunny sole accent; Tangerine + Slate + legacy primitives dead); fixed stale `--bg` (`#1A2C42` → `#111E38`).
- [x] DESIGN.md: added Icons section (SVG-only, Lucide, drawing standard) + no-emoji anti-pattern.
