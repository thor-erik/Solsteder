/* global React */
// ============================================================
// Shades Mark — production version of 48·A
// ============================================================
// Geometry: square 240×240 viewBox. Sun (back) is a full circle, striped.
// Half-lens (front) is a solid Tangerine half-disc on a baseline. Composition
// is centered horizontally; vertically positioned slightly above geometric
// center for optical balance (lens reads heavier at the bottom).
//
// Fixes applied vs the canvas-tier P48a:
//   1) Stripe pattern is now SYMMETRIC about the circle's center — one stripe
//      is centered on cx. Eliminates the asymmetric "straight edge" on the NE.
//   2) Stripe ANGLE is tuned to the same -45° but pattern is centered.
//   3) Stroke (ink) thickness adapts to the variant — light-on-dark gets a
//      fatter fill ratio to compensate for perceptual irradiation.
//   4) Variants: light / dark / transparent / mono — explicit colors, never
//      currentColor. Each variant is a self-contained, deterministic icon.
// ============================================================

const SHADES = {
  ink:       '#111E38',  // Delft Blue
  cream:     '#FFF2EB',  // Cream
  sun:       '#F5C25E',  // Sunny — goldenrod yellow, the sun
};

// Returns {bg, stripe, sun, gapFill}. gapFill === bg for opaque variants,
// 'transparent' for transparent variants — so when bg is transparent, gaps
// punch through to whatever sits behind the SVG.
function paletteFor(variant) {
  switch (variant) {
    case 'light':
      return { bg: SHADES.cream, stripe: SHADES.ink,   sun: SHADES.sun, gapVisible: true };
    case 'dark':
      return { bg: SHADES.ink,   stripe: SHADES.cream, sun: SHADES.sun, gapVisible: true };
    case 'transparent-light':
      return { bg: 'transparent', stripe: SHADES.ink,   sun: SHADES.sun, gapVisible: false };
    case 'transparent-dark':
      return { bg: 'transparent', stripe: SHADES.cream, sun: SHADES.sun, gapVisible: false };
    case 'mono-ink':
      return { bg: 'transparent', stripe: SHADES.ink,   sun: SHADES.ink,   gapVisible: false };
    case 'mono-cream':
      return { bg: 'transparent', stripe: SHADES.cream, sun: SHADES.cream, gapVisible: false };
    default:
      return paletteFor('light');
  }
}

/**
 * The canonical Shades mark.
 *
 * @param {number} size           Pixel size (square)
 * @param {string} variant        'light' | 'dark' | 'transparent-light' | 'transparent-dark' | 'mono-ink' | 'mono-cream'
 * @param {number} cornerRadius   Rounded-corner radius IN VIEWBOX UNITS (0..120). Default 0.
 *                                Use 54 (≈22.5%) for iOS-style super-ellipse rounding,
 *                                or 120 (50%) for a circular badge.
 * @param {boolean} bleed         If true, the composition fills the canvas with minimal padding.
 *                                Default = false (24 px padding inside 240×240).
 */
function ShadesMark({
  size = 240,
  variant = 'light',
  cornerRadius = 0,
  bleed = false,
  className,
  style,
}) {
  const pal = paletteFor(variant);
  // Light ink on dark bg perceives thinner; compensate.
  // Cream stripes on Delft Blue need progressively thicker fills at small
  // pixel sizes to remain legible (avoid the muddy gray at 40–60px).
  let fillRatio = pal.stripe === SHADES.cream ? 0.62 : 0.55;
  if (pal.stripe === SHADES.cream) {
    if (size <= 24)      fillRatio = 0.90;
    else if (size <= 40) fillRatio = 0.82;
    else if (size <= 60) fillRatio = 0.74;
    else if (size <= 96) fillRatio = 0.68;
  }

  // Geometry in 240×240 viewBox
  const VB = 240;
  const padding = bleed ? 0 : 24;
  // Sun radius and lens radius chosen for the symmetric composition.
  // These values map to 78 / 95 in 240, which gives a sun visible above the
  // lens dome of ~87px — enough for 4–5 stripe bands at our default gap.
  const sunR  = bleed ? 92  : 78;
  const lensR = bleed ? 112 : 95;
  // Lens flat-bottom Y. Composition centered horizontally at x=120; lens
  // bottom near y=200 (28px above bottom edge) for slight optical lift.
  const cx = VB / 2;
  const lensBaseY = bleed ? 224 : 200;
  // Sun is centered above the lens dome top by ~9px so its bottom dips into
  // the dome (back is fully hidden behind the front below the dome line).
  const sunCy = bleed ? 116 : 96;

  const stripeGap = 15;
  const stripeAngle = -45;

  // ===== Build the symmetric stripe mask =====
  // Stripe pattern: one stripe centered exactly on (cx, sunCy). To produce
  // this with a "gap rect" mask: gaps live at x = cx + sw/2 + n*stripeGap.
  const sw = stripeGap * fillRatio;
  const gw = stripeGap * (1 - fillRatio);
  const stripeCenterX = cx;
  const stripeCenterY = sunCy;
  // Coverage span: enough to fully cover the rotated bbox of the sun.
  const span = sunR * 2 + stripeGap * 4;

  const gapRects = [];
  const nMax = Math.ceil(span / stripeGap);
  for (let n = -nMax; n <= nMax; n++) {
    const gapX = stripeCenterX + sw / 2 + n * stripeGap;
    gapRects.push(
      <rect key={n}
        x={gapX} y={stripeCenterY - span}
        width={gw} height={span * 2}
        fill="black" />
    );
  }

  // Random-enough id per instance so multiple marks coexist on a page
  const uid = React.useId().replace(/:/g, '');

  // Sun and lens paths
  const sunPath  = `M ${cx - sunR} ${sunCy} a ${sunR} ${sunR} 0 1 0 ${sunR * 2} 0 a ${sunR} ${sunR} 0 1 0 ${-sunR * 2} 0 Z`;
  const lensPath = `M ${cx - lensR} ${lensBaseY} A ${lensR} ${lensR} 0 0 1 ${cx + lensR} ${lensBaseY} Z`;

  // BG path (rounded square so we can clip a single icon-style tile)
  const bgPath = (
    <rect x={0} y={0} width={VB} height={VB}
      rx={cornerRadius} ry={cornerRadius}
      fill={pal.bg} />
  );

  return (
    <svg viewBox={`0 0 ${VB} ${VB}`} width={size} height={size}
      className={className} style={style}
      xmlns="http://www.w3.org/2000/svg" shapeRendering="geometricPrecision">
      <defs>
        {/* Clip everything to the (possibly rounded) tile bounds */}
        <clipPath id={`tile-${uid}`}>
          <rect x={0} y={0} width={VB} height={VB} rx={cornerRadius} ry={cornerRadius} />
        </clipPath>
        {/* Stripe mask. Gaps are clipped to the sun's bounding circle so the
            pattern naturally ends on the curve — no rectangular "edge". */}
        <clipPath id={`sun-${uid}`}>
          <circle cx={cx} cy={sunCy} r={sunR} />
        </clipPath>
        <mask id={`smask-${uid}`} maskUnits="userSpaceOnUse" x={-1000} y={-1000} width={4000} height={4000}>
          <rect x={-1000} y={-1000} width={4000} height={4000} fill="white" />
          <g clipPath={`url(#sun-${uid})`}>
            <g transform={`rotate(${stripeAngle} ${stripeCenterX} ${stripeCenterY})`}>
              {gapRects}
            </g>
          </g>
        </mask>
      </defs>

      <g clipPath={`url(#tile-${uid})`}>
        {/* Background tile (transparent in transparent variants) */}
        {pal.bg !== 'transparent' && bgPath}
        {/* Sun: striped */}
        <path d={sunPath}  fill={pal.stripe} mask={`url(#smask-${uid})`} />
        {/* Lens: solid on top */}
        <path d={lensPath} fill={pal.sun} />
      </g>
    </svg>
  );
}

Object.assign(window, { ShadesMark, SHADES });
