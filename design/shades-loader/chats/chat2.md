# Weather indicator colors

_Started 2026-05-19 13:57 UTC_

---

## User

Quick question regarding the design system. I really like tangerine as a color, I find it to be a really nice combination with the blue colors that we have, and it looks very good. But found that it didnt work that will in conveying front levels of sunlight, i.e., sunny, partly sunny, or sun behind the cloud. Therefore, in the app I've been experimenting with another color, #F5C25E (sunny). What do you think about this yellow? Is it the correct type of yellow compared to the blue that we have, or does it need some more polish? Like I said, I really like tangerine, but it just didn't really work when I had it in the timeline where you're supposed to see, based on the color, how sunny it actually is.

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: view_image]_

_[tool: read_file]_

Good design instinct — and yes, I think you're right to move off Tangerine for the sun ramp. Let me explain why and give you a few flavors of yellow to choose between.

Quick verdict: **Tangerine reads as *sunset*, not *sun*.** It's a directional/temporal warmth — late-afternoon, golden hour — which is exactly wrong for "the sun is overhead and shining." Yellow is the universal mental model for "sun is up." So the swap is correct in principle.

The bigger reason it was never going to work: your design system already says Tangerine is "interactive-state color ONLY. Never decorative." Using it for sun-intensity overloads it. Sun level is *data*, not interaction. Different job → different color. Good call separating them.

Let me make a focused study so you can see #F5C25E next to a few nearby alternatives in the actual contexts.

_[tool: write_file]_

Now I have the full picture. The current `--wx-sun` token is actually `#FFAF85` (same as Tangerine) — so right now sun-intensity and interactive-accent are literally the same color in your tokens. That's the root of the conflict you're feeling. Splitting them is the right move.

Let me build the comparison.

_[tool: done]_

_[tool: fork_verifier_agent]_

**TL;DR — Yes, ship #F5C25E.** You diagnosed the real problem: Tangerine reads as *sunset*, not *sun*, and your design system already locks it to interactive state only. Using it for sun-intensity overloads it.

Some takeaways from the study:

- **It works because it does a different job.** Tangerine (hue 19°) lives in the orange/sunset arc; #F5C25E (hue 42°) lives in the gold/midday-sun arc. They're 23° apart — enough that they don't read as "two versions of the same color," which is what you want for two different meanings.
- **The blue–yellow pairing is doing real work.** Complementary contrast against Delft Blue gives the sun bar high legibility at small sizes without going neon.
- **One thing worth A/B-ing on real map screenshots:** #F5C25E vs. a slightly softer **#F3CA73** at 14px pin scale. Your pick has more weight; the softer version is calmer on a bright zoomed-in map. Both are valid — pick whichever holds up better against your busiest map tiles.
- **Worth updating while you're in there:** your current `--wx-sun` token in `colors_and_type.css` is literally `#FFAF85` (same as `--accent`), even though the guide prose mentions `#FFD488`. The new yellow resolves both inconsistencies in one stroke.

I drafted a proposed full ramp on the new yellow in section 04 — give that a look and let me know if you want to tune the middle stops (the partly-cloudy band especially is a bit of a judgment call).Page is ready for you to look through.

## User

Change from tangerine to #F5C25E

## User

Need to change from tangerine to #F5C25E

## User

Need to change from tangerine to #F5C25E. Also perhaps a tiny bit more padding around the icons? I feel like it is very close to the edges of the canvases. But youre the expert.

## Assistant

_[tool: read_file]_

_[tool: show_html]_

_[tool: grep]_

_[tool: grep]_

_[tool: grep]_

_[tool: grep]_

_[tool: list_files]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Two changes: swap `SHADES.sun` to the new yellow (this propagates everywhere the mark is rendered — favicons, iOS, Android, lockups, splash screens), and bump the AssetTile padding for breathing room.

You're right about the padding — the iOS/Android icons that bleed are *meant* to go edge-to-edge (the OS masks them at runtime), but on the other tiles the marks were sitting tight against the card. Bumping outer padding from 24→32 fixes that without breaking the bleeds.

_[tool: done]_

Done. Three changes:

- **`SHADES.sun`** in `shades-mark.jsx`: `#FFAF85` → **`#F5C25E`**. The mark re-renders everywhere — favicons, iOS/Android icons, lockups, splash screens, OG card, feature graphic — all in one swap.
- **Color section**: swatch renamed from "Tangerine" to **"Sunny"** with the new value, and the section subtitle updated to match.
- **AssetTile padding**: bumped from `24` to `36px 32px 28px` and min-height `200 → 220`, with a bit more inner gap. Bleed icons (the iOS/Android tiles meant to go edge-to-edge under the OS mask) still bleed correctly — they bleed within the content area, not the card itself.

One thing worth flagging: the static PNG/SVG files in `shades-brand-pack/` (the actual export assets in `logo/`, `ios/`, `android/`, `web/`) were generated from the old tangerine and still contain `#FFAF85`. The live brand pack you're viewing renders from JSX so it's updated, but if you want me to regenerate the static exports too, say the word and I'll re-run the asset generation.

## User

Save this design as a PDF: Shades Brand Pack.html

## Assistant

_[tool: read_file]_

_[tool: write_file]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: open_for_print]_

Print tab opened — the print dialog should pop automatically. If it didn't, [open the print view here](https://e88bcbbd-4ded-4b40-a1cc-5dbfdf06708d.claudeusercontent.com/v1/design/projects/e88bcbbd-4ded-4b40-a1cc-5dbfdf06708d/serve/Shades%20Brand%20Pack-print.html?t=150bc538b550e4e004d558b1b12dc9a3fbd0a9aec4de9523ec82b3c9ebe31d4e.14a7028b-0c94-4776-b9c3-d762bd68a831.d037f420-65af-4c41-9702-b5fcfb625637.1779205206&direct=1) and use Save as PDF (A3 landscape, "Background graphics" enabled).

