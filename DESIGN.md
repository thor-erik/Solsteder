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
2. **Honey is the sun signal — and the one CTA per screen.** Honey = sun (data) and *may* repeat freely: sun should be visible everywhere (in-sun pills, sun-hours, the time slider). The single primary CTA per screen also uses honey but stays distinct by being **solid + elevated + on a dark surface** — it reads as *action*, not data. No second accent — a fifth hue is drift. If a CTA ever gets lost among in-sun honey, the fallback is a **Delft Blue** (dark) CTA, never a new colour.
3. **Cohesive secondary text.** Secondary text = primary text at lower opacity, NOT a different hue. Use `rgba(255, 244, 224, 0.78)` over cool grey `#9BA9BC`. Same hue family as the title.
4. **Flat surfaces, no optical overlays.** Surfaces are solid tints (blur is fine; gradient fills and the old mirror-sky / chromatic overlays are not). The lens metaphor is carried by colour and translucency, not by simulated optics.
5. **Reactive motion.** Tilt + spotlight + rim + click ripple fire on hover/click only. Silent at rest. The single privileged ambient motion is the live "in sun now" pin pill.
6. **Elevation via solid shadow, not sheen.** A flat drop shadow lifts a raised surface (1px tight contact + soft lift). The glossy inset sheen / bottom-shade is retired — flat surfaces don't fake depth with gradients.
7. **Warm-on-cool does the work.** Honey accents pop against Delft Blue. No need to multiply colors. A second accent is design drift.

---

## Color tokens

### Primitive layer

Defined in `:root` in `index.html`. Components must NOT reference primitives directly — go through the semantic layer.

```
--coral-50..900    /* legacy primitive (semantic now points at honey) */
--cream-50/100
--blue-200..950    /* legacy primitive (semantic now points at Delft Blue) */
--green/orange/red status scales
--space-1..12   --radius-xs..xl   --text-xs..3xl
--ease-standard   --dur-fast/base/slow
--z-pins/canvas/controls/panel/modal/toast/...
```

### Semantic layer (Delft Blue + Honey brand)

What components consume. Updating these is how brand work happens.

| Token | Value | Role |
|---|---|---|
| `--bg`, `--panel` | `#111E38` | Delft Blue base for surfaces and app backdrop (was `#1A2C42` Slate) |
| `--accent` | `#F5C25E` | Honey "Sunny" gold — the discovery signal, "the sun" |
| `--accent-on` | `#2C1F02` | Warm dark — text/icon ON `--accent` |
| `--accent-dim` | `rgba(245,194,94,0.16)` | Honey-tinted background for badges |
| `--accent-border` | `rgba(245,194,94,0.42)` | Honey border on dim backgrounds |
| `--text` | `#FFF4E0` | Warm cream — primary text |
| `--muted` | `#9BA9BC` | Cool grey — secondary cool text (use sparingly; cream-at-opacity is preferred) |
| `--cool` | `#B5BCC8` | Brighter cool grey — for cool weather chips |
| `--rain` | `#6F8AA8` | Cool blue — rain pills, water on map |

**One yellow.** Sunny `#F5C25E` is the sole accent — every sun/discovery signal, the primary CTA, and the logo mark. **The old palette is dead and must not appear anywhere:** Tangerine `#FFAF85`, Slate `#1A2C42`, and the legacy `--coral-*` / `--blue-*` primitives are all retired. The swap from Tangerine to Sunny was deliberate (Tangerine read as sunset warmth, not overhead sun, and collided with selected-state pills — recorded in the brand pack's `Sunny Color Study.html`). The brand-pack README and its mark art still show Tangerine; both predate the swap and are **stale**. This table is canonical.

### Surface system tokens (final · 2026-05-21)

```
/* Surface fills — one per surface; colour is role-assigned, never dialed */
--surface-chrome:  rgba(156,189,231,0.25);  /* Jordy 25% — chrome panel */
--surface-sheet:   rgba(156,189,231,0.25);  /* Jordy 25% — sheet (raised by shadow) */
--surface-content: rgba(17,30,56,0.90);     /* Delft Blue 90% — content card */
--surface-modal:   rgba(17,30,56,0.90);     /* Delft Blue 90% — modal, cream text */
--surface-raised:  #FFF2EB;                  /* Cream, opaque — dropdown / popover */
--surface-control: rgba(156,189,231,0.01);  /* Jordy ~1% — outline-defined chip */
--scrim:           rgba(17,30,56,0.55);      /* Delft Blue 55% — behind modals/sheets */

/* Blur — small, subtle frost */
--blur-control: blur(2px);
--blur-surface: blur(4px);

/* Shadow — flat lift; strength tracks elevation */
--shadow-1: 0 1px 2px rgba(0,0,0,0.18), 0 4px 14px rgba(0,0,0,0.30);  /* resting: chrome panel, card */
--shadow-2: 0 8px 28px rgba(0,0,0,0.40);                              /* raised: sheet, dropdown */
--shadow-3: 0 16px 48px rgba(0,0,0,0.50);                             /* pop: modal */

/* Borders — Jordy on DARK surfaces, Delft Blue on LIGHT; 1px hairline */
--line-d-faint:  rgba(156,189,231,0.08);   /* divider on dark */
--line-d:        rgba(156,189,231,0.18);   /* edge on dark (content card, modal) */
--line-d-strong: rgba(156,189,231,0.30);
--line-l-faint:  rgba(17,30,56,0.08);      /* divider on light */
--line-l:        rgba(17,30,56,0.18);      /* edge on light (chrome, sheet, dropdown) */
--line-l-strong: rgba(17,30,56,0.30);      /* control silhouette — outline chip on chrome */

/* Element-opacity states (applied to the whole element) */
--o-disabled:       0.40;
--o-muted:          0.55;
--o-secondary-text: 0.78;   /* cream secondary text */

--glass-inset: 0 0 0 0 transparent;        /* glossy sheen retired (flat) */
```

**Flat-modern surfaces.** Solid tints + blur — never gradient fills; the glossy inset sheen, mirror-sky and chromatic overlays are retired; motion (tilt/spotlight/ripple) unchanged.

**Borders are the silhouette.** Every surface and control takes its edge from a `--line-*` token, never a raw rgba. Colour mirrors the world so the edge actually reads: **Jordy on dark surfaces, Delft Blue on light.** Strengths step faint (divider) → standard (surface edge) → strong (control silhouette). The surface control is intentionally near-fill-less (`--surface-control` ≈ 1%) and defined by `--line-l-strong` — an **outline chip**; selected/active swaps to a honey-dim fill + `--accent-border`.

**Code follow-up:** these supersede `--glass-panel-bg` / `--glass-card-bg` / `--glass-action-bg` and the `--glass-blur-*` set. Repoint components to the `--surface-*` / `--blur-*` / `--shadow-*` / `--line-*` tokens in `:root`, and teach `validate-tokens.mjs` to flag raw alphas, `blur()`, and border rgba.

### Status

```
--color-success/-soft/-faint    --color-warning/-soft
--color-error/-soft/-strong/-deep    --color-error-bg/-border/-on-bg
```

---

## Typography

One font — **Inter** — across the whole product (it's also the logo font). Voice comes from weight + tracking, not a second typeface. The **Display** tier reuses the logo treatment (Inter 900, tight `−0.03em`) so the app rhymes with the mark.

| Role | Size | Weight | Tracking | Use |
|---|---|---|---|---|
| Display | 28 | 900 | −0.03em | detail title, sheet headline, sign-in |
| Title | 22 | 700 | −0.01em | section / card titles |
| Subtitle | 18 | 600 | normal | secondary headers |
| Body | 15 | 400 | normal | primary reading text |
| Label | 13 | 500 | normal | meta lines, chips, sun-hours |
| Caption | 11 | 400 | normal | timestamps, fine print |

- Line-height ~1.5 body, ~1.25 Title/Display.
- **Inputs use 16px** (prevents iOS auto-zoom on focus).
- **Tabular figures** (`font-variant-numeric: tabular-nums`) for times, sun-hours, temps, prices — numbers must not twitch.
- Wire to the `--text-*` tokens (used 0× today) and migrate the 22 raw font-sizes onto these six roles. `validate-tokens.mjs` should flag raw `font-size`.

---

## Radius

Five steps, snapped from the 20 raw values in use:

| Token | Value | Use |
|---|---|---|
| `--radius-none` | 0 | flush edges |
| `--radius-sm` | 8px | inputs, small controls |
| `--radius-md` | 12px | cards, buttons |
| `--radius-lg` | 20px | sheets, modals |
| `--radius-pill` | 999px | chips, pills, honey CTA |

Wire to `--radius-*` (used once today); migrate raw radii. `validate-tokens.mjs` flags raw `border-radius`.

---

## Spacing

4px base with two fine sub-steps (2px, 6px) for the dense map UI. The old `--space-*` tokens went unused because they **omitted** 2px and 6px — the two most-used values (56× and 96×). Fixed by including them; everything else snaps to a step.

| Token | Value | Use |
|---|---|---|
| `--space-2xs` | 2px | icon↔label, hairline insets |
| `--space-xs` | 4px | tight intra-element |
| `--space-sm` | 6px | dense chip padding, small gaps (the dense-UI half-step) |
| `--space-md` | 8px | default gap |
| `--space-lg` | 12px | card interior, comfortable gap |
| `--space-xl` | 16px | roomy card / section padding |
| `--space-2xl` | 24px | section spacing |
| `--space-3xl` | 32px | major sections |
| `--space-4xl` | 48px | screen-level rhythm |

- **4px and 8px are the defaults; 2px / 6px are only for tight/dense contexts** (chips, glyph gaps) — don't pick between 4/6/8 arbitrarily.
- **Eliminate 10px** (worst orphan, 61×): snap to 8 (tight) or 12 (roomy) by context.
- Other orphans snap to nearest: 3→4, 5→6, 7→8, 9→8, 11/13/14→12, 18→16, 20→16 or 24, 22→24, 28→32, 30→32, 56→48.
- Replaces the old `--space-1..12` tokens (used 0×). Migrate the 278 raw paddings; `validate-tokens.mjs` flags raw `padding` / `gap` / `margin` px.

---

## Surface & elevation model

The Six Tiers below describe *how* a surface is treated. This model describes *which* surface a thing gets and how surfaces stack. It is the higher-level rule; the tiers are its vocabulary. When in doubt, resolve here first, then pick the tier.

### Surface glossary & recipe — vocabulary + final values

Plain-language terms (used throughout this doc) mapped to what they are on screen, plus the **locked** recipe. Colour is role-assigned — only opacity / blur / shadow were dialed. `--line-*` / `--shadow-*` are the tokens defined above.

| Surface | What it is in Shades | Fill (colour · opacity) | Blur | Border | Shadow · text |
|---|---|---|---|---|---|
| **Chrome panel** | Bottom list area, top bar, filter row | Jordy `#9CBDE7` · 25% | 4px | `--line-l` | `--shadow-1` · ink |
| **Sheet** (slides up, drag-handle) | Venue detail, RSVP "Du er invitert til", Share, "Velg dato" | Jordy `#9CBDE7` · 25% | 4px | `--line-l` | `--shadow-2` · ink |
| **Modal** (full-screen takeover) | Sign-in, friends popup | Delft Blue `#111E38` · 90% | 4px | — | `--shadow-3` + scrim · cream |
| **Content card / tile** | Venue cards, "Sun until 17:05" block | Delft Blue `#111E38` · 90% | none | `--line-d` | `--shadow-1` · cream |
| **Surface control** | Filter chips, +min nudges, sort + locate | Jordy · ~1% (outline) | 2px | `--line-l-strong` | — · ink · *selected → honey-dim + `--accent-border`* |
| **Raised / dropdown** | Sort menu over the list | Cream `#FFF2EB` · 100% | none | `--line-l` | `--shadow-2` · ink |
| **Scrim** | Dimming behind a modal/sheet | Delft Blue · 55% | none | — | — |
| **Honey CTA** | Jeg blir med, Invite friends here, Share link | Honey `#F5C25E` · 100% | none | — | `--shadow-1` · `--accent-on` |
| **Honey badge** | "+1h 35m" pill, score badge | Honey · 16% (`--accent-dim`) | none | `--accent-border` | — · honey |

**Colour is role-assigned, not a knob.** Only opacity / blur / shadow were dialed; colour is fixed per surface. **Three surface colours, no fourth:** Jordy Blue for light chrome (chrome panel, sheet — also reads as a tinted sunglasses lens), Delft Blue for dark focus surfaces (content card, modal — cream text), Cream for opaque popovers (dropdowns). Text is **ink on light, cream on dark** (secondary at `0.78`). Accent is honey, once per screen; the one colour *state* is **selected/active = honey-dim** (`--accent-dim` + `--accent-border` + `--accent-on` ink text — honey-on-honey-dim tested too low-contrast on device). Status colours come from the status scale.

**Shadow is the third elevation knob.** Flat-modern lifts surfaces with a solid drop shadow (principle 6), on a scale that tracks elevation: `--shadow-1` resting (chrome panel, card), `--shadow-2` raised (sheet, dropdown), `--shadow-3` pop (modal). A raised layer always casts a stronger shadow than what it covers. Bottom-anchored chrome panels cast their shadow **upward** onto the map. No inset sheens (retired).

### Two worlds: chrome vs content

The lens metaphor (principle 1) is also the layout rule. Every surface is one of two things:

- **Chrome — the lens you look *through*.** Light, translucent, floats over the map. Top bar, filter/sort chips, search, calendar and date sheets, login splash. Text is ink (`--panel-text` `#111E38`).
- **Content — the objects you look *at*.** Delft Blue, opaque, sits *in* the lens. Venue cards, detail tiles, the sun timeline, invite sheets. Text is cream (`--text`).

If a surface's treatment is unclear, ask the only question that matters: **is this chrome or content?** Everything else follows.

### Controls step away from their container

A control is **never the same surface as the thing it sits on** — it steps one level away, or it disappears. This is why a light pill works over the map but turns to mush on a light panel.

| Control sits on… | Treatment |
|---|---|
| The **map** (chrome floating over it) | Light glass pill — pops against the map via scrim + shadow |
| A **light / chrome panel** (calendar, sort, login) | Step to **Delft Blue (ink fill/outline)** or **honey** (primary). A light pill here is banned — zero contrast. |
| A **Delft Blue / content surface** | **glass-action** (lighter Delft Blue) for secondary, **honey** for primary, **ghost** for tertiary |

"Lens-light button" is not a type you choose — it is simply what a control becomes when it floats over the map. Inside a panel, a control is always container-relative.

### Button roles — colour encodes role, not flow

Every button is one of four roles, and colour carries exactly one meaning each. Do **not** invent per-flow button classes — the sprawl of `dprcv-cta-primary`, `dpacc-action-primary`, `fts-popup-primary`, `inbox-btn-accept` is the drift this rule retires (one logical role, five implementations that drift apart).

| Role | Treatment | Rule |
|---|---|---|
| **Primary — "the decision"** | Tier 4 honey (`--accent` bg, `--accent-on` text) | **Exactly one per screen.** Two honey buttons = one is mislabelled. |
| **Secondary — "supporting"** | Tier 3 glass (`--glass-action-bg`, `--text`, `--glass-border`) | Repeatable. The cool grey-*filled* variant is retired — it competed with secondaries and read as disabled. |
| **Tertiary — "low-stakes / dismiss"** | Ghost: transparent, `--muted` → `--text` on hover | Cancel, "Kommer senere", "Rediger informasjon". |
| **Destructive** | Red (`--color-error`), text or outline only | "Avslå", delete. Visually separated from primary. |

Selection chips (`+5 min`, intent filters, sort) are **not** buttons in this ladder — they share the Tier-3 selectable-chip style, never a bespoke grey fill.

Buttons inside a **sheet / detail panel** are the same four roles — no special "detail-panel button" type. On the venue detail: "Invite friends here" = Primary, "Directions" = Secondary (must read lighter than the honey CTA, not full-width-prominent), the Share / Favorites / Alert row = Tertiary. `dp-action-cta` / `dpacc-action-primary` etc. are the per-flow drift to retire.

### Component states

One state model, applied to every interactive component — no per-flow variants. (The filters look inconsistent today because they lack this.)

| State | Surface control (chip) | Button |
|---|---|---|
| Default | outline: `--surface-control` (~1%) + `--line-l-strong`, ink text | per role (honey CTA / glass secondary / ghost tertiary) |
| Hover (desktop) | border darkens + faint fill | brightness up |
| Pressed | scale 0.97 + fill flash (+ haptic on mobile) | scale 0.97 (+ haptic) |
| **Selected / active** | **honey-dim fill + `--accent-border` + `--accent-on` ink text** | — |
| Focus | 2px focus ring (keyboard / switch-control) | 2px focus ring |
| Disabled | `--o-disabled` (0.40), no pointer events | `--o-disabled`, no pointer |
| Loading | — | spinner + disabled |

The fix for the filters is the **outline-default → honey-dim-selected** pattern: every unselected chip is a clean outline (silhouette from `--line-l-strong`), every selected one fills honey-dim. Consistent silhouette, unmistakable selection.

### Backgrounds: steps, not new hues

Stacking is expressed by **opacity + shadow + a hairline border — never a new colour.** A third hue dilutes warm-on-cool (principle 7); adding elevation steps *is* principle 6. Each world has a short tint ladder:

- **Chrome:** chrome glass → *raised* light surface (more opaque + stronger shadow) for popovers/sheets.
- **Content:** panel (42%) → card (**opaque**) → *raised* opaque Delft Blue for menus/modals.

The only genuinely new token to add is a **scrim** (`--scrim`, dark veil) behind focus-stealing layers.

### Content tiles are opaque Delft Blue — never translucent, never cream

Venue cards and detail tiles are **fully opaque Delft Blue**. Reasons, in priority order:

1. **The honey signal needs a dark base.** Sun = honey is the whole product. `#F5C25E` on Delft Blue sings; on cream it is two warm tones at similar lightness — the sun-hours, progress bar, and badges drop from signal to barely-there.
2. **Content = objects you look at.** Cream cards would make them chrome and break the model — and the ripple wouldn't stop at the list (detail tiles, invite sheets, timeline are all Delft Blue too).
3. **Photos & figure-ground.** Dark frames recede behind venue photos and separate hard from the light map; cream would need borders just to not vanish.

Outdoor glare (a sun-app is used in bright light) argues for a light *map* and light *chrome* — which we have — with dark cards as the high-contrast results that punch through glare. If cards ever read as heavy, the lever is **opacity, spacing, and Delft Blue brightness — not switching to cream.**

> **Code follow-up:** retires the legacy `--glass-card-bg` 78% alpha — content resolves to full-opacity Delft Blue (`#111E38`).

### Overlap & dropdowns

1. **A raised layer goes opaque (or near) and casts a shadow the layer below doesn't.** Never stack two translucent layers of the same world and trust `backdrop-filter` — two blurs = mud (see the current sort dropdown, where content bleeds through). An opaque raised layer is also self-consistent regardless of what's beneath it.
2. **Elevation = opacity step + shadow + z-tier.** Bind each step to the existing z-ladder (`--z-panel` < `--z-modal` < `--z-toast`) so stacking order is deterministic. Focus-stealing layers (modals, sheets) also get the `--scrim`; lightweight popovers (sort) just need to be opaque + shadowed.

### In three sentences

Chrome is the lens (light, over the map); content is the objects (opaque Delft Blue). A control steps away from its container, never matches it. A raised layer goes opaque and casts a shadow the layer below doesn't.

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
- Background: `var(--glass-panel-bg)` (Delft Blue at 42% alpha)
- No optical overlay — the old mirror-sky gradient is retired. Flat solid tint + blur only.
- Border: `var(--glass-border)`
- Shadow: `var(--glass-inset)` + `0 6px 24px rgba(0,0,0,0.50)`
- `backdrop-filter: var(--glass-blur-panel)`
- (Top-edge sheen retired — flat; no `::before` highlight)

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
- Background: `var(--glass-card-bg)` — **fully opaque Delft Blue** (`#111E38`). Content tiles are never translucent and never cream; see "Surface & elevation model → Content tiles are opaque Delft Blue". (The legacy 78% alpha is being retired in code.)
- No chromatic overlay — the old warm/cool gradient is retired. Solid opaque Delft Blue.
- Border: `1px solid rgba(155,169,188,0.34)` (clearer than panel border)
- Shadow: flat drop only — `0 1px 2px rgba(0,0,0,0.18)`, `0 4px 14px rgba(0,0,0,0.30)` (the glossy inset sheens are retired)
- Padding: `12px 14px`, internal `gap: 4px`
- No `backdrop-filter` (sits inside panel which already blurs — saves GPU layers)

**Motion:** tilt + parallax + spotlight + rim + click ripple. Scroll-aware (suspends during scroll). Wired by `js/lens-effects.js`.
**Examples:** `.venue-card`, `.dp-card`, `.dp-action-card`, `.dpacc-action-card`.

### Tier 3 · Surface control
**Role:** smaller interactive surface. Glass-action style.
**Treatment:**
- Background: `var(--glass-action-bg)` (Delft Blue at 45% alpha)
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

## Icons

**SVG only — never emoji.** Every icon is an inline SVG from a single pack. Emoji are font-dependent, render differently on every OS, can't be tokenised (colour / stroke / size), and break the flat-modern look. No emoji in chrome, labels, buttons, toasts — **or as fallbacks**.

**Pack: Lucide** (ISC-licensed). One source of truth for every UI glyph. It is the maintained successor to Feather, already the style the hand-drawn icons were imitating, outline/stroke-based (the flat-modern register), and pairs naturally with Inter.

**Drawing standard** — the fix for the current ten-stroke-width sprawl (2, 1.5, 1.8, 2.4, 2.2, 3, 2.5, 1.6, 1.2, 2.6 all in use):

- 24×24 viewBox, `stroke-width: 2`, `stroke-linecap: round`, `stroke-linejoin: round`, no fill (outline).
- Size via `width`/`height` (16 / 20 / 24) — **never** by changing stroke-width.
- Colour via `currentColor` so icons inherit `--text` / `--muted` / `--accent` — never a hard-coded hex.
- Outline is the default. Don't mix filled and outline at the same hierarchy level. Encode selection/active by **colour** (→ `--accent`), not by swapping to a filled icon.

**Canvas glyphs** (map pins, weather, sun arc — `render-pins.js` / `render-arc.js`) can't import SVG directly, but must be redrawn to Lucide's metrics: same 2px-at-24 stroke ratio, round caps, outline. They read as one family even though the rendering path differs.

**Subsetting:** copy only the SVG paths you use into the codebase — no runtime icon font or library dependency (keeps the no-build, CDN-free constraint).

---

## Anti-patterns

- ✗ Multiple Tier-4 honey CTAs in one screen — burns out the signal.
- ✗ Tier-3 control with Tier-2 motion (tilt/parallax) — too heavy for small surfaces.
- ✗ Tier-2 card with no border or shadow — loses silhouette, blends with panel.
- ✗ Static text in cool grey when the title is cream — breaks principle 03.
- ✗ Continuous animation on more than ONE element per screen — Tier 5 ambient is privileged.
- ✗ Raw hex colors in CSS (run `node scripts/validate-tokens.mjs` to catch).
- ✗ Pure white `#FFFFFF` for text or fills — use `var(--text)` for warmth and consistency.
- ✗ Inventing a fourth glass surface variant — only `panel`, `card`, `action` exist.
- ✗ A light control on a light panel (zero contrast) — a control must step away from its container. See "Surface & elevation model → Controls step away from their container".
- ✗ Per-flow button classes (`dprcv-cta-primary`, `dpacc-action-primary`, `fts-popup-primary`…) — buttons are one of four roles; colour encodes role, not flow.
- ✗ More than one Tier-4 honey button on a screen — honey means "the decision", once.
- ✗ Translucent or cream content tiles — venue/detail tiles are opaque Delft Blue. Honey dies on cream.
- ✗ Gradient fills, glossy inset sheens, or mirror-sky / chromatic overlays — the look is flat: solid tints + blur. (Functional mask-fades, legibility scrims, and motion glints are not "fills" and are fine.)
- ✗ Emoji anywhere in the UI — icons, labels, toasts, or SVG fallbacks. SVG from the icon pack only. See "Icons".
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

- Delft Blue + Honey palette migrated through semantic + glass + canvas-bridge layers.
- ~~Mirror-sky panel + chromatic card lens FX wired into production.~~ **Retired** — the look is now flat (solid tints + blur). Reactive motion (tilt/spotlight/ripple) and `?fx=lab` remain.
- Card silhouette polish (modern border + layered shadow + spacing) applied universally to `.venue-card` and detail-panel cards.
- Modal backdrops unified to Delft Blue-tinted spec.
- Validator clean (54 documented allowlist entries).
- Component-to-tier audit complete — see `system.html`.

**Next phase:** systematic redesign of every page/panel/feature — applying the tier framework + polish standards. Each surface gets its own focused review pass.
