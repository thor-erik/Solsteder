# Prompt for Claude Code — Liquid Glass pass across all surfaces, round 10

Paste everything below into Claude Code on the same branch as rounds 1–9. Rounds 1–9 must already be applied. Every task updates behavior plus `DESIGN.md` where noted. Where an instruction below conflicts with a current rule in `DESIGN.md`, the instruction wins and the doc must be updated to match.

---

## Context

Shades — the product's in-app name for the Solsteder design language — leans on a sunglasses metaphor: a lens that filters light, darkens harsh sun, and shows the world in deep blue. The existing design system already uses three glass levels tinted with Delft Blue (`rgba(20,46,82,...)`) and has a "sunglass" thumb on the time bar. The rest of the surfaces are glass-*adjacent* but stop short of the Liquid Glass–inspired aesthetic we want: clear lens edges, a bright top-rim sheen, tight specular highlights, and a consistent tinted body.

This round is a refinement pass, not a rebuild. We formalise the Liquid Glass–inspired treatment, apply it uniformly across every surface (panels, cards, controls, chips, pins, toasts), and migrate legacy stragglers onto the current palette.

### Non-goals — important

These were evaluated and rejected after investigating dashersw/liquid-glass-js and nikdelvin/liquid-glass-style implementations:

- **No `html2canvas`-based background sampling.** Our canvas overlay and Mapbox GL redraw continuously; sampling the page per panel would jank mobile.
- **No additional WebGL context.** Mapbox already owns one; a second is wasteful and fragile on older Safari.
- **No `backdrop-filter: url(#svg-filter)` refraction.** It only works in Chromium. Safari/iOS — our primary target — silently degrades to plain blur, which means the "refraction" is invisible to most users while we pay the complexity cost in code. Ship what works everywhere.
- **No `feDisplacementMap` edge distortion.** Same Safari issue; also produces muddy results on a map background.

What we **do** use:
- Native `backdrop-filter: blur() saturate()` (already in place).
- Layered linear-gradient tints for depth.
- Inset box-shadows for rim-light and spec highlights.
- Canvas-drawn equivalents (gradient fills + 1px highlight stroke) for pins, where CSS can't reach.

---

## Task 1 — Formalise the Shades Glass recipe and name the design language

**Problem.** DESIGN.md documents three glass *levels* (panel, card, action) but doesn't capture the finishing touches that make them read as "glass" rather than "translucent card": top-edge sheen, inset rim-light, and the Delft Blue diagonal tint gradient. The thumb already has these touches but they aren't documented at the system level. We also want to name the language so future work has a vocabulary.

**Do:**

1. At the top of DESIGN.md, immediately under the `# Solsteder Design System` heading, add a one-paragraph preamble:

   > **Shades is the in-app name for the design language.** Shades is a deliberate double-entendre: *shadows* (the product's subject matter) and *sunglasses* (the visual metaphor). Surfaces behave like polarised lenses — deep Delft Blue tint, clean rim, bright spec along the top edge. Pins, panels, and controls all belong to the same optical family.

2. Extend the **Glass surfaces** section. Keep the existing three-level table. Add immediately below it the **Glass finish** — a required recipe applied on top of every glass level:

   ```
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

   The gradient stops are tuned so the diagonal reads as "light entering from the upper-left." Do not flip the angle per component. This is the signature of the language.

3. Add a **Spec highlight** sub-section describing the 1px top-edge horizontal sheen that panels and the largest controls carry:

   > Panels (level = panel) carry a `::before` pseudo-element painting a 1px horizontal highlight at the top edge: `top: 0; left: 8%; right: 8%; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,242,235,0.35), transparent);`. Cards and actions skip this — too much highlight at small sizes reads as visual clutter.

4. Implement the recipe in the CSS of `index.html`. Three CSS classes (or a single `.glass` class plus modifiers) that can be applied anywhere. Every existing glass surface is migrated to these classes in this round: readout panel, detail panel, list peek, calendar picker sheet, venue cards, all action pills/circles, all chips, sort chip, date pill, tooltip.

5. Legacy values to delete on sight: `rgba(14,26,52,...)`, `rgba(10,20,42,...)`, plain flat `#142E52` fills on glass surfaces. Grep for these and migrate.

**Accept criterion.** Zero glass surfaces in the app bypass these tokens. The readout panel, detail panel, venue cards, and sort chip are visibly in the same optical family — same tint direction, same top sheen, same rim.

**Update DESIGN.md:** per the blocks above.

---

## Task 2 — Migrate pins off the legacy Solaris Oslo palette

**Problem.** `js/render-pins.js` still uses the deprecated "Solaris Oslo" palette: `#0D131E` surface, `#514532` outline-variant, `#FFB800` primary, `#d5c4ab` on-surface-variant. These colors don't exist in the current design system. Pins therefore look like a different product. They are also drawn on canvas, which means CSS glass doesn't reach them — they need a canvas-level equivalent of the Shades Glass recipe.

**Do:**

1. Replace the Solaris Oslo color references in `buildSprite()` wholesale:

   | Old (Solaris Oslo) | New (Shades) |
   |--------------------|--------------|
   | `#0D131E` surface fill | Delft Blue gradient (see below) |
   | `#514532` outline-variant | `rgba(156,189,231,0.22)` |
   | `#FFB800` primary (text, stem on `soon`) | `--accent` = `#FFAF85` |
   | `#d5c4ab` warm cream on-surface-variant | `--muted` = `#9CBDE7` |
   | `rgba(81,69,50,...)` outline | `rgba(156,189,231,...)` |

2. Replace flat pill fills with a canvas-drawn gradient that matches the CSS glass recipe. For the **shaded** and **soon** states, before filling the pill path:

   ```js
   const grad = c.createLinearGradient(ox, oy, ox + pillW, oy + PILL_H);
   grad.addColorStop(0, 'rgba(20,46,82,0.88)');
   grad.addColorStop(1, 'rgba(32,73,131,0.82)');
   c.fillStyle = grad;
   c.fill();
   ```

   Keep the **sunny** state's `#FFAF85` solid fill — the accent role still owns full sun.

3. After filling, draw a 1px inner top-edge sheen on the pill (canvas equivalent of `inset 0 1px 0 rgba(255,242,235,0.14)`):

   ```js
   c.save();
   // clip to the pill path so the sheen stays inside the rounded corners
   c.clip();  // requires the pill path to be current; re-issue the path if needed
   c.strokeStyle = 'rgba(255,242,235,0.18)';
   c.lineWidth = 1;
   c.beginPath();
   c.moveTo(ox + PILL_R, oy + 0.5);
   c.lineTo(ox + pillW - PILL_R, oy + 0.5);
   c.stroke();
   c.restore();
   ```

   Apply this to all pill-shaped pins regardless of state. Skip for the tiny faded `closed`-state dot — too small to benefit.

4. Pill border: `1px solid rgba(156,189,231,0.18)` for shaded/soon. Sunny keeps the warm `rgba(255,230,120,0.4)` — it's a deliberate sun-glow cue, not a chrome border.

5. Text color on shaded/soon pins: `--muted` = `#9CBDE7`. On sunny pins: keep `#1a1200` (readable on tangerine).

6. Stem color: `rgba(156,189,231,0.55)` on shaded, `rgba(255,175,133,0.7)` on soon (accent-tinted to signal sun coming), `#FFAF85` on sunny. Dashed only on `soon`, as today.

7. Selection ring: unchanged — keep `rgba(255,175,133,0.9)` at `2px`. Accent ownership of the selected state is correct and consistent with the design system.

8. Clear the sprite cache on this change (`spriteCache.clear()` or just let `clearSpriteCache()` do it on boot). Sprites are cheap to rebuild.

**Cache/perf note.** `buildSprite` is already memoised by `(id, state, selected, time-bucket)`. The gradient computation happens once per unique sprite, not per frame. No frame-rate impact.

**Accept criterion.** Open the app. Pins, readout panel, detail panel, and venue cards share the same tint, the same rim glint, the same temperature of light. No pin uses any color value not in DESIGN.md's color tokens or glass-finish spec.

**Update DESIGN.md:**

Add a new **Pins** section under Components (between `Icons` and a suitable neighbour):

> Pins are canvas-drawn but belong to the Shades Glass family. Pill body uses a canvas-painted linear gradient matching the CSS glass recipe (`rgba(20,46,82,0.88) → rgba(32,73,131,0.82)` at 135°), a 1px top-inner sheen (`rgba(255,242,235,0.18)`), and a `rgba(156,189,231,0.18)` 1px border. Exception: the **sunny** state keeps `--accent` (`#FFAF85`) as the pill fill — the pin *is* the sun indicator, and accent ownership of "this is sunny right now" is the system's most important color contract. Stems, text, and dashed styling as documented in the Pin state table below.
>
> No pin may reference values outside the color-token section. The legacy Solaris Oslo palette (`#0D131E`, `#514532`, `#FFB800`, `#d5c4ab`) is retired — delete on sight.

Include a small Pin-state table in DESIGN.md mirroring the state mapping above (state × fill × stem × text × stroke).

---

## Task 3 — Reconcile the thumb with the system (no visual change, documentation fix)

**Problem.** The time-bar thumb is called the "sunglass" in DESIGN.md and already carries the Shades Glass finish (inner sheen, high-opacity rim, subtle saturate intent). But the doc was written before we formalised the glass recipe, so the thumb's spec reads as a special one-off. It isn't — it's the prototype the whole system is built around.

**Do:**

1. No CSS/JS change needed.
2. In DESIGN.md, at the end of the **Thumb (time bar)** section, add:

   > The thumb is the seed example of Shades Glass. Every other glass surface in the app — panels, cards, actions, pins — inherits the same optical treatment (diagonal Delft tint, top-rim sheen, bright 1px edge, subtle saturate). When a new surface is added, the thumb is the reference.

That's the whole task. It orients the next contributor (human or AI) toward the right mental model.

---

## Task 4 — Tooltip, toasts, and any floating secondary surfaces

**Problem.** The hover tooltip (`ui-list.js` wiring, DOM element probably in `index.html`) and any toast/notification surfaces are outside the core three-panel set and may not have been touched by the glass migration. They should carry the same finish as action-level glass — they're light, ephemeral, and small.

**Do:**

1. Grep for `tooltip` and `toast` (and any `position: fixed` floating element) in `index.html`'s CSS and the `js/ui-*.js` files.
2. Any such element gets `glass-action` level finish: gradient A=0.36 B=0.22 over base 0.45, blur 10px, saturate 160%, rim + top sheen inset shadows, 1px Jordy border. Elevation `low`.
3. No spec highlight pseudo-element on these — they're too small (same rule as action pills).

**Update DESIGN.md:** Under Components, add a **Tooltip / transient surface** sub-section stating the above.

---

## Task 5 — Performance and accessibility guardrails

**Problem.** `backdrop-filter` is cheap but not free. Layering it on every nested element, or on constantly-resizing elements, produces jank on low-end mobile. We should bound its use and respect reduced motion / reduced transparency.

**Do:**

1. **Bound rule.** `backdrop-filter` is only applied to the three glass levels (`panel`, `card`, `action`) and nothing nested inside them. A card inside a panel doesn't need its own `backdrop-filter` — the panel has already painted the glass below it. Audit the current CSS and remove any redundant nested `backdrop-filter` declarations.

2. **Reduced transparency.** Add a block at the end of the CSS:

   ```css
   @media (prefers-reduced-transparency: reduce) {
     .glass-panel, .glass-card, .glass-action {
       backdrop-filter: none;
       -webkit-backdrop-filter: none;
       background: rgba(17, 30, 56, 0.97);   /* --bg at near-opaque */
     }
   }
   ```

   The spec highlight pseudo-element stays — it's cheap and preserves the visual identity without transparency.

3. **`will-change` discipline.** Only the detail panel, list peek, and calendar sheet (surfaces that slide) get `will-change: transform`. No `will-change: backdrop-filter` anywhere — it bloats GPU memory.

4. **No animation of `backdrop-filter` itself.** Cross-fades, slide-ins, and rotations animate `opacity` and `transform` only. The glass stays constant.

**Update DESIGN.md:** Add a **Performance & accessibility rules** section near the end, before **Don't**, capturing the four rules above.

---

## Task 6 — Tighten the Don't list

At the end of DESIGN.md's **Don't** section, append:

- Don't introduce `html2canvas`-based background sampling for glass effects. It jank's mobile and the cost scales with every redraw.
- Don't use `backdrop-filter: url(#svg-filter)` for refraction. Safari / iOS — our primary target — does not support it. The effect would be invisible to most users while still costing complexity.
- Don't apply `backdrop-filter` to nested elements inside an already-glass surface. Redundant GPU work.
- Don't migrate the pin **sunny** state off `--accent`. The fill is a system-level promise ("this venue has sun right now"); owning the accent role there is intentional.

---

## Workflow

- One commit per task. Message format: `round 10 task N — <short summary>`.
- If a task's changes are purely in `DESIGN.md`, still commit — doc changes are tracked separately.
- After each commit, push. No batching.
- If you find a surface that contradicts this spec *and isn't listed in a task above*, fix it in the closest-matching task's commit rather than opening a new round.

## Verification (required, before the final commit)

1. Open the app in Chrome and Safari. Confirm that the readout panel, detail panel, venue cards, and pins all carry the same diagonal tint direction and the same top-rim sheen. If one surface reads as off-palette, revisit Task 1 or Task 2.
2. Open DevTools Performance, scrub the time bar for 5 seconds. Frame rate should be ≥50fps on a mid-range laptop. If it isn't, check Task 5.1 — you almost certainly have nested `backdrop-filter`.
3. Toggle `prefers-reduced-transparency` (macOS Accessibility settings, or via devtools emulation). The app should render with solid `--bg` panels and no blur. Layout must not shift.
4. Visually compare the pins to the readout panel. A pin and the panel behind it should feel like the same material. If not, Task 2's gradient values or sheen intensity are off.
