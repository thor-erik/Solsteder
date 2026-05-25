# Brand Pack Splash Screens

_Started 2026-05-19 17:23 UTC_

---

## User

For the Brand Pack

ADJUSTMENT: update the static splash screens and the dark-variant
small icons.

SPLASH SCREENS
1. Mark only. No wordmark. No tagline (don't reserve space — there
   isn't one).
2. Vertically and horizontally center the mark on each screen.
3. Increase mark size significantly. The current mark floats in
   negative space — it should feel anchored and present, with real
   visual weight. Reference: Linear, Things, Arc splash marks.
4. Background unchanged: Cream (#FFF2EB) on light, Delft Blue
   (#111E38) on dark.

ICON SET (dark variants, small sizes only)
5. At small dark icon sizes (~60px and below — Notification · 40
   especially), thicken the Cream stripes on the striped circle so it
   stays legible against the Delft Blue background. Currently muddy
   at those sizes.

DELIVERABLES
- Updated splash designs for: iPhone 14 Pro Max, iPhone 14 Pro, iPad
  Pro 12.9, Android FHD/QHD, Android tablet landscape — light and
  dark for each.
- Updated apple-touch-startup-image set.
- Updated small dark icons with thicker stripes.

## Assistant

_[tool: read_file]_

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: str_replace_edit]_

I'll make these adjustments. Two changes needed:

1. **Splash screens** — strip down to mark only, center it, and pump up the size significantly (Linear/Things/Arc-style anchoring).
2. **Dark mark at small sizes** — auto-thicken Cream stripes at ≤60px so they stay readable.

_[tool: str_replace_edit]_

Now update `SplashMockup` — mark only, centered, much larger — and expand the splash deliverables to light+dark for each device.

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now add a dark-variant small-icon row to the iOS section so the stripe-thickening fix is actually visible in the pack.

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Updated. Summary of changes:

**Splash screens** — `SplashMockup` now renders mark-only, dead-center, ~46% of the canvas short edge (anchored like Linear/Things/Arc). Replaced the single lockup-based mock with **light + dark** variants for every required device: iPhone 14 Pro Max, iPhone 14 Pro, iPad Pro 12.9 (iOS / apple-touch-startup-image set) and Phone FHD, Phone QHD, Tablet landscape (Android).

**Dark mark at small sizes** — `ShadesMark` now picks a size-aware `fillRatio` when stripes are Cream: 0.62 at 96+px, 0.68 at 80–96, 0.74 at 60–80, 0.82 at 40–60, 0.90 at ≤24. Notification · 40 in particular goes from muddy → readable. Added a dedicated **Dark theme · small sizes** row to the iOS section so the fix is visible side-by-side with the light counterparts.Splash screens and the small dark icon set are updated — file is open in your tab.

