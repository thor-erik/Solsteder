# Solsteder Design System

**Brand name: Shades.** A double-entendre: *shadows* (the product's subject matter — sun-vs-shade detection) and *sunglasses* (the visual metaphor — translucent panels are tinted lenses you look through to find sun).

This document is the **source of truth** for visual decisions. Before making UI changes — manually or with AI tools — start here. The companion `system.html` provides rendered visual examples of every tier; open it in a browser when in doubt.

## Visual companions

- **`system.html`** — rendered design system reference. Shows every tier with live examples and the component-to-tier audit table.
- **`brand.html`, `motion.html`, `stack.html`, `audit.html`** — exploration pages preserved for context. The decisions in this document supersede them.
- **`scripts/validate-tokens.mjs`** — automated check that flags raw color literals outside the token system.

---

## Seven principles

1. **Lens metaphor is structural.** Translucent surfaces = lens. Solid surfaces = objects in the lens. Honey accent = sun coming through. Effects exist to reinforce this metaphor, not to decorate.
2. **One accent per surface.** Honey is the "this matters" signal. Use it once per screen — primary CTA, "in sun" status, hero pin. Multiplied honey burns out.
3. **Cohesive secondary text.** Secondary text = primary text at lower opacity, NOT a different hue. Use `rgba(255, 244, 224, 0.78)` over slate-grey `#9BA9BC`. Same hue family as the title.
4. **Subtle static effects.** Mirror-sky and chromatic overlays exist to suggest lens optics — not to be seen. They should be barely perceptible at first glance.
5. **Reactive motion.** Tilt + spotlight + rim + click ripple fire on hover/click only. Silent at rest. The single privileged ambient motion is the live "in sun now" pin pill.
6. **Layered elevation.** Modern card convention: 1px tight contact shadow + 14px soft lift. Inset top sheen (warm cream at 0.16) + bottom shade (slate at 0.40). No single-layer drop shadows.
7. **Warm-on-cool does the work.** Honey accents pop against slate. No need to multiply colors. A second accent is design drift.

---

## Color tokens

### Primitive layer

Defined in `:root` in `index.html`. Components must NOT reference primitives directly — go through the semantic layer.

```
--coral-50..900    /* legacy primitive (semantic now points at honey) */
--cream-50/100
--blue-200..950    /* legacy primitive (semantic now points at slate) */
--green/orange/red status scales
--space-1..12   --radius-xs..xl   --text-xs..3xl
--ease-standard   --dur-fast/base/slow
--z-pins/canvas/controls/panel/modal/toast/...
```

### Semantic layer (Slate + Honey brand)

What components consume. Updating these is how brand work happens.

| Token | Value | Role |
|---|---|---|
| `--bg`, `--panel` | `#111E38` | Delft Blue base for surfaces and app backdrop (was `#1A2C42` Slate) |
| `--accent` | `#F5C25E` | Honey "Sunny" gold — the discovery signal, "the sun" |
| `--accent-on` | `#2C1F02` | Warm dark — text/icon ON `--accent` |
| `--accent-dim` | `rgba(245,194,94,0.16)` | Honey-tinted background for badges |
| `--accent-border` | `rgba(245,194,94,0.42)` | Honey border on dim backgrounds |
| `--text` | `#FFF4E0` | Warm cream — primary text |
| `--muted` | `#9BA9BC` | Slate-grey — secondary cool text (use sparingly; cream-at-opacity is preferred) |
| `--cool` | `#B5BCC8` | Brighter slate-grey — for cool weather chips |
| `--rain` | `#6F8AA8` | Slate-blue — rain pills, water on map |

**Two yellows, one rule.** The in-product accent is **Sunny `#F5C25E`** — every sun/discovery signal and the primary CTA. **Tangerine `#FFAF85` is mark-only** (the logo). Tangerine reads as sunset warmth rather than overhead sun and collided with selected-state pills, so it never appears in the UI; the swap to Sunny was a deliberate decision (recorded in the brand pack's `Sunny Color Study.html`). The brand-pack README still lists Tangerine as the accent — it predates this decision. **This table is canonical.**

### Glass surfaces (component layer)

```
--glass-panel-bg:  linear-gradient(135deg, rgba(26,44,66,0.36), rgba(58,92,130,0.22)), rgba(26,44,66,0.42);
--glass-card-bg:   linear-gradient(135deg, rgba(26,44,66,0.36), rgba(58,92,130,0.22)), rgba(26,44,66,0.78);
--glass-action-bg: linear-gradient(135deg, rgba(26,44,66,0.36), rgba(58,92,130,0.22)), rgba(26,44,66,0.45);
--glass-blur-panel: blur(16px) saturate(160%);
--glass-blur-card:  blur(12px) saturate(160%);
--glass-blur-action: blur(10px) saturate(160%);
--glass-border:     1px solid rgba(155,169,188,0.22);
--glass-inset:      inset 0 1px 0 rgba(255,244,224,0.14), inset 0 -1px 0 rgba(26,44,66,0.35);
```

### Status

```
--color-success/-soft/-faint    --color-warning/-soft
--color-error/-soft/-strong/-deep    --color-error-bg/-border/-on-bg
```

---

## Surface & elevation model

The Six Tiers below describe *how* a surface is treated. This model describes *which* surface a thing gets and how surfaces stack. It is the higher-level rule; the tiers are its vocabulary. When in doubt, resolve here first, then pick the tier.

### Two worlds: chrome vs content

The lens metaphor (principle 1) is also the layout rule. Every surface is one of two things:

- **Chrome — the lens you look *through*.** Light, translucent, floats over the map. Top bar, filter/sort chips, search, calendar and date sheets, login splash. Text is ink (`--panel-text` `#111E38`).
- **Content — the objects you look *at*.** Slate, opaque, sits *in* the lens. Venue cards, detail tiles, the sun timeline, invite sheets. Text is cream (`--text`).

If a surface's treatment is unclear, ask the only question that matters: **is this chrome or content?** Everything else follows.

### Controls step away from their container

A control is **never the same surface as the thing it sits on** — it steps one level away, or it disappears. This is why a light pill works over the map but turns to mush on a light panel.

| Control sits on… | Treatment |
|---|---|
| The **map** (chrome floating over it) | Light glass pill — pops against the map via scrim + shadow |
| A **light / chrome panel** (calendar, sort, login) | Step to **slate (ink fill/outline)** or **honey** (primary). A light pill here is banned — zero contrast. |
| A **slate / content surface** | **glass-action** (lighter slate) for secondary, **honey** for primary, **ghost** for tertiary |

"Lens-light button" is not a type you choose — it is simply what a control becomes when it floats over the map. Inside a panel, a control is always container-relative.

### Button roles — colour encodes role, not flow

Every button is one of four roles, and colour carries exactly one meaning each. Do **not** invent per-flow button classes — the sprawl of `dprcv-cta-primary`, `dpacc-action-primary`, `fts-popup-primary`, `inbox-btn-accept` is the drift this rule retires (one logical role, five implementations that drift apart).

| Role | Treatment | Rule |
|---|---|---|
| **Primary — "the decision"** | Tier 4 honey (`--accent` bg, `--accent-on` text) | **Exactly one per screen.** Two honey buttons = one is mislabelled. |
| **Secondary — "supporting"** | Tier 3 glass (`--glass-action-bg`, `--text`, `--glass-border`) | Repeatable. The slate-grey-*filled* variant is retired — it competed with secondaries and read as disabled. |
| **Tertiary — "low-stakes / dismiss"** | Ghost: transparent, `--muted` → `--text` on hover | Cancel, "Kommer senere", "Rediger informasjon". |
| **Destructive** | Red (`--color-error`), text or outline only | "Avslå", delete. Visually separated from primary. |

Selection chips (`+5 min`, intent filters, sort) are **not** buttons in this ladder — they share the Tier-3 selectable-chip style, never a bespoke grey fill.

### Backgrounds: steps, not new hues

Stacking is expressed by **opacity + shadow + a hairline border — never a new colour.** A third hue dilutes warm-on-cool (principle 7); adding elevation steps *is* principle 6. Each world has a short tint ladder:

- **Chrome:** chrome glass → *raised* light surface (more opaque + stronger shadow) for popovers/sheets.
- **Content:** panel (42%) → card (**opaque**) → *raised* opaque slate for menus/modals.

The only genuinely new token to add is a **scrim** (`--scrim`, dark veil) behind focus-stealing layers.

### Content tiles are opaque slate — never translucent, never cream

Venue cards and detail tiles are **fully opaque slate**. Reasons, in priority order:

1. **The honey signal needs a dark base.** Sun = honey is the whole product. `#F5C25E` on slate sings; on cream it is two warm tones at similar lightness — the sun-hours, progress bar, and badges drop from signal to barely-there.
2. **Content = objects you look at.** Cream cards would make them chrome and break the model — and the ripple wouldn't stop at the list (detail tiles, invite sheets, timeline are all slate too).
3. **Photos & figure-ground.** Dark frames recede behind venue photos and separate hard from the light map; cream would need borders just to not vanish.

Outdoor glare (a sun-app is used in bright light) argues for a light *map* and light *chrome* — which we have — with dark cards as the high-contrast results that punch through glare. If cards ever read as heavy, the lever is **opacity, spacing, and slate brightness — not switching to cream.**

> **Code follow-up:** retires the legacy `--glass-card-bg` 78% alpha — content resolves to full-opacity slate (`#111E38`).

### Overlap & dropdowns

1. **A raised layer goes opaque (or near) and casts a shadow the layer below doesn't.** Never stack two translucent layers of the same world and trust `backdrop-filter` — two blurs = mud (see the current sort dropdown, where content bleeds through). An opaque raised layer is also self-consistent regardless of what's beneath it.
2. **Elevation = opacity step + shadow + z-tier.** Bind each step to the existing z-ladder (`--z-panel` < `--z-modal` < `--z-toast`) so stacking order is deterministic. Focus-stealing layers (modals, sheets) also get the `--scrim`; lightweight popovers (sort) just need to be opaque + shadowed.

### In three sentences

Chrome is the lens (light, over the map); content is the objects (opaque slate). A control steps away from its container, never matches it. A raised layer goes opaque and casts a shadow the layer below doesn't.

---

## Six tiers

Every UI surface belongs to exactly **one** tier. The tier determines opacity, effects, motion, and accent usage. The Surface & elevation model above decides *which* tier applies where. See `system.html` for visual examples.

### Tier 0 · Map & ambient
**Role:** the world. Static. The user looks *through* it, not *at* it.
**Treatment:** none. Mapbox handles its own transitions.
**Examples:** `#map`, `#sun-compass`, `.weather-strip`.

### Tier 1 · Lens panel
**Role:** translucent container. The lens you look through.
**Treatment:**
- Background: `var(--glass-panel-bg)` (slate at 42% alpha)
- Mirror-sky overlay applied via `body[data-fx]` rules (single soft cool highlight + deep shadow, 135deg)
- Border: `var(--glass-border)`
- Shadow: `var(--glass-inset)` + `0 6px 24px rgba(0,0,0,0.50)`
- `backdrop-filter: var(--glass-blur-panel)`
- Top-edge sheen via `::before`

**Motion:** none on container. Reactive elements inside.
**Examples:** `#panel`, `#detail-panel`, `#search-dropdown`, `#sort-panel`, `#profile-panel`, modals, toasts, login splash.

#### Sheet contract — bottom-anchored Tier-1 panels

Any panel that slides up from the bottom (`#detail-panel`, `.dpinvite-sheet`, `.dprcv-bottom`, `#ptb-cal-float`, `.dpacc-panel`, future share / confirmation sheets) MUST follow this contract. It is standards-based (2026): no custom JS measurement, no per-host hacks. The contract works on iOS Safari, iOS PWA, Android Chrome, Android PWA, Dynamic Island devices, devices with home indicators, soft keyboards opening, foldables, and desktop — because each line below maps to a platform primitive that already handles those cases.

| Rule | Why |
|---|---|
| `<meta viewport ... viewport-fit=cover, interactive-widget=resizes-content>` | `viewport-fit=cover` unlocks `env(safe-area-inset-*)` on iOS. `interactive-widget=resizes-content` makes the Android soft keyboard shrink the layout viewport the same way iOS already does — so `svh` / `dvh` / `bottom: 0` all reflect the keyboard correctly. Set once in `index.html`. |
| `position: fixed; bottom: 0` | No `var(--app-bottom-inset)` lift needed. With the viewport meta above, every host puts `bottom: 0` at the correct visible bottom. |
| `max-height: 88svh` (sheets) or `92svh` (overlays) | `svh` = the **small** viewport unit = stable smallest visible area. Never clipped by Safari's address bar (regardless of scroll state), never recalculates during scroll (no jank), automatically respects the keyboard. **Do not use `vh`** — it equals `lvh` on mobile and clips. **Do not use `dvh` for layout** — its updates are throttled and animating from/to it causes jank (per spec). |
| `height: auto` + `min-height: 280px` (where applicable) | Content drives height. A half-open sheet on short content still reads as a sheet, not a chip. The calendar sheet is an explicit exception — see below. |
| `padding-bottom: var(--app-pad-b)` | `var(--app-pad-b)` = `max(env(safe-area-inset-bottom), 12px)`. Single signal correct on every host: iOS PWA ≈ 34 px home indicator, Android Chrome 135+ PWA ≈ 24–48 px gesture chin, desktop/older Android = 12 px floor. The `:has(:focus-visible)` rule in `:root` collapses this to 8 px while a form field is focused, so the sheet hugs the keyboard. |
| `overflow-y: auto` | Long content scrolls inside the sheet. |
| `overscroll-behavior: contain` + `touch-action: pan-y` | Standard isolation contract used by Vaul / Radix. Drag bubbles don't leak to the map underneath; vertical gestures only. |

**Anti-pattern (Sheet contract violation):** sizing a sheet as a fraction of `var(--app-h)` (`calc(var(--app-h) * 0.58)`, `* 0.92`). The `--app-h` JS hack predates `svh` and is no longer needed for sheets. Use `Xsvh` directly.

**Anti-pattern (legacy lifts):** `bottom: var(--app-bottom-inset, 0px)` and `bottom: env(safe-area-inset-bottom)`. Both were attempts to solve toolbar overlap; with the new viewport meta they are no-ops at best and double-apply the inset at worst.

**Calendar exception (`#ptb-cal-float`):** the calendar deliberately shows "one month + peek of the next." It keeps `max-height: 56svh` instead of content-fit. All other contract rules apply.

**Drag-to-expand (`#detail-panel.dp-fullscreen`):** the fullscreen state overrides `height` to `100svh` and `border-radius: 0`. The min/max rules above only describe the half-open state.

**JS coupling:** components positioned relative to a sheet (the FTS slider) must read the panel's live `offsetHeight` rather than assuming a percentage. `js/app.js → _syncFtsPosition()` writes `--dp-open-h` from the live height; consumers reference `var(--dp-open-h, 58svh)` with the percentage as a fallback. The `visualViewport` API is still used in JS **for drag-to-dismiss gesture math** (it's the only way to read pinch-zoom and keyboard offsets), but never for layout.

### Tier 2 · Lens object
**Role:** solid content tile. An object resting in the lens.
**Treatment:**
- Background: `var(--glass-card-bg)` — **fully opaque slate** (`#111E38`). Content tiles are never translucent and never cream; see "Surface & elevation model → Content tiles are opaque slate". (The legacy 78% alpha is being retired in code.)
- Chromatic overlay via `body[data-fx]` rule (warm/cool corner gradient — simulates lens dispersion)
- Border: `1px solid rgba(155,169,188,0.34)` (clearer than panel border)
- Shadow: layered — `inset 0 1px 0 rgba(255,250,235,0.16)`, `inset 0 -1px 0 rgba(15,30,55,0.40)`, `0 1px 2px rgba(0,0,0,0.18)`, `0 4px 14px rgba(0,0,0,0.30)`
- Padding: `12px 14px`, internal `gap: 4px`
- No `backdrop-filter` (sits inside panel which already blurs — saves GPU layers)

**Motion:** tilt + parallax + spotlight + rim + click ripple. Scroll-aware (suspends during scroll). Wired by `js/lens-effects.js`.
**Examples:** `.venue-card`, `.dp-card`, `.dp-action-card`, `.dpacc-action-card`.

### Tier 3 · Surface control
**Role:** smaller interactive surface. Glass-action style.
**Treatment:**
- Background: `var(--glass-action-bg)` (slate at 45% alpha)
- Border: `1px solid rgba(155,169,188,0.30)`
- Shadow: `var(--glass-inset)` + `0 2px 8px rgba(0,0,0,0.30)`
- Padding scales with content; pill (`var(--radius-pill)`) for buttons, `var(--radius-md)` for chips

**Motion:** hover spotlight + click ripple. No tilt (too small).
**Examples:** `.s-pill`, `.s-rnd`, `.s-sq`, `.intent-btn`, `.sort-btn`, `.area-chip`, `.edit-chip`, `.dp-action-chip`, `.notif-toast-action`, slider thumbs.

### Tier 4 · Honey CTA
**Role:** the decision. Solid honey. **Used once per screen** — burns out if multiplied.
**Treatment:**
- Background: `var(--accent)` (solid honey)
- Text: `var(--accent-on)`
- No border
- Shadow: `inset 0 1px 0 rgba(255,255,255,0.30)`, `inset 0 -1px 0 rgba(0,0,0,0.20)`, `0 4px 14px rgba(0,0,0,0.35)`
- Pill or rounded-square shape

**Motion:** brief brightness on hover. Click: diagonal shine sweep (550ms transform-only animation).
**Examples:** `.p-pill`, `.p-sq`, `.dp-action-cta`, `.dpacc-action-primary`, `.invite-confirm-btn`.

### Tier 5 · Honey badge / pill
**Role:** the signal. Honey on dim honey.
**Treatment:**
- Background: `var(--accent-dim)`
- Border: `1px solid var(--accent-border)`
- Text: `var(--accent)`
- 11.5px font, 4–10px padding, pill shape

**Motion:** static. Idle drift on the **single** live "in sun now" indicator only.
**Examples:** `.card-pill.pill-sol`, `.dp-sun-pill`, `.score-badge`, `.tier-high`.

### Tier 6 · Map canvas
**Role:** pin pills, sun arc, weather glyphs. Canvas-drawn.
**Treatment:** colors come from `window.TOKENS` (populated at boot from `:root` CSS vars by `js/tokens.js`). Brand changes propagate automatically.
**Motion:** tap pulse + select ring + idle drift on the single live in-sun pin.
**Examples:** `render-pins.js`, `render-arc.js`, `render-seating.js`.

---

## Motion vocabulary

Implementation in `js/lens-effects.js`. Activates by default (no flag needed). Override via:
- `?fx=lab` — interactive lab to swap effects
- `?fx=1` — alternate preset (polarized panel + clean card)

| Tier | Hover | Press | Idle |
|---|---|---|---|
| 1 (panels) | — | — | scroll-shimmer on hero panels only |
| 2 (cards) | spotlight + tilt + parallax + rim | click ripple | — |
| 3 (controls) | spotlight | click ripple | — |
| 4 (CTA) | brightness shift | shine sweep | — |
| 5 (badge) | — | — | drift on single "live in sun" pin only |
| 6 (canvas) | — | tap pulse + select ring | drift on single hero pin |

All motion respects `prefers-reduced-motion` and suspends during scroll (200ms debounced).

---

## Anti-patterns

- ✗ Multiple Tier-4 honey CTAs in one screen — burns out the signal.
- ✗ Tier-3 control with Tier-2 effects (chromatic, mirror) — too busy for small surfaces.
- ✗ Tier-2 card with no border or shadow — loses silhouette, blends with panel.
- ✗ Static text in slate-grey when the title is cream — breaks principle 03.
- ✗ Continuous animation on more than ONE element per screen — Tier 5 ambient is privileged.
- ✗ Raw hex colors in CSS (run `node scripts/validate-tokens.mjs` to catch).
- ✗ Pure white `#FFFFFF` for text or fills — use `var(--text)` for warmth and consistency.
- ✗ Inventing a fourth glass surface variant — only `panel`, `card`, `action` exist.
- ✗ A light control on a light panel (zero contrast) — a control must step away from its container. See "Surface & elevation model → Controls step away from their container".
- ✗ Per-flow button classes (`dprcv-cta-primary`, `dpacc-action-primary`, `fts-popup-primary`…) — buttons are one of four roles; colour encodes role, not flow.
- ✗ More than one Tier-4 honey button on a screen — honey means "the decision", once.
- ✗ Translucent or cream content tiles — venue/detail tiles are opaque slate. Honey dies on cream.
- ✗ Stacking two translucent layers of the same world (dropdown over panel) and trusting `backdrop-filter` — the raised layer goes opaque + shadow.
- ✗ Sizing a bottom sheet as a fraction of `var(--app-h)` (`calc(var(--app-h) * 0.X)`) — predates `svh` and ignores content. Use `Xsvh` for caps and `height: auto` for the half-open state. See "Tier 1 · Sheet contract".
- ✗ `bottom: var(--app-bottom-inset)` / `bottom: env(safe-area-inset-bottom)` on a bottom sheet — both are legacy lifts. With `interactive-widget=resizes-content` in the viewport meta, `bottom: 0` is correct on every host.
- ✗ Using `100vh` or `100dvh` for sheet `max-height`. `vh` includes browser chrome → clips on iOS. `dvh` reflows during scroll and animations → jank. Always use `svh` for sheet caps.

---

## How to extend

**Adding a new component?**
1. Identify its closest equivalent in the audit table in `system.html`.
2. Inherit that tier. Apply the tier's spec exactly.
3. Reference `:root` tokens — never raw hex.
4. Run `node scripts/validate-tokens.mjs` before committing.

**Disagree with a tier assignment?**
Resolve against the seven principles above, not personal taste. The principles are the constitution.

**Adding a new visual style?**
Ask: which tier? If none fits, consider whether you actually need a new style or whether the existing tier was insufficient. **Tier proliferation is the enemy.**

**Brand change?**
1. Update the semantic tokens in `:root` (`--accent`, `--bg`, `--text`, `--muted`, etc.).
2. Update `js/tokens.js` FALLBACKS if you're adding a new semantic token.
3. Run the app — semantic tokens propagate; canvas tracks via the bridge automatically.
4. Tier specs stay constant; only the colors shift.

---

## Implementation files

| File | Role |
|---|---|
| `index.html` `<style>` block | All tokens (primitive + semantic + glass + motion + z-index ladders), plus all component CSS |
| `js/tokens.js` | Bridge — reads `:root` CSS vars at boot, exposes `window.TOKENS` for canvas drawing |
| `js/lens-effects.js` | Lens FX motion stack (tilt, spotlight, rim, click ripple), scroll-aware gate, lab UI when `?fx=lab` |
| `js/render-pins.js`, `render-arc.js`, `render-seating.js`, `render-editor.js` | Canvas drawing — uses `TOKENS` for brand colors |
| `scripts/validate-tokens.mjs` | Validator — flags raw hex outside the token system |
| `system.html` | Visual reference, tier examples, audit table |
| `brand.html`, `motion.html`, `stack.html`, `audit.html` | Exploration history — reference only, not maintained |

---

## Status snapshot (2026-05-09)

- Slate + Honey palette migrated through semantic + glass + canvas-bridge layers.
- Mirror-sky panel + chromatic card lens FX wired into production (default-on; `?fx=lab` for tweaking).
- Card silhouette polish (modern border + layered shadow + spacing) applied universally to `.venue-card` and detail-panel cards.
- Modal backdrops unified to slate-tinted spec.
- Validator clean (54 documented allowlist entries).
- Component-to-tier audit complete — see `system.html`.

**Next phase:** systematic redesign of every page/panel/feature — applying the tier framework + polish standards. Each surface gets its own focused review pass.
