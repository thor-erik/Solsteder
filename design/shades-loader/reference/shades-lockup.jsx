/* global React, ShadesMark, SHADES */
// ============================================================
// Shades Wordmark + Lockups
// ============================================================
// The Shades wordmark uses Inter at weight 900 (Black) with tight tracking
// (-0.03em) for a logotype feel. Inter is the design-system font, so this
// keeps the lockup native to the rest of the product. Lockups come in two
// shapes: horizontal (mark left, wordmark right) and stacked (mark top).
//
// Casing follows the design-system rule (Sentence case): "Shades" not "SHADES".
// ============================================================

function ShadesWordmark({
  text = 'Shades',
  fontSize = 64,                  // in px
  color = SHADES.ink,
  className,
  style,
}) {
  return (
    <span
      className={className}
      style={{
        fontFamily: '"Inter", "Inter Display", system-ui, sans-serif',
        fontWeight: 900,
        fontSize: `${fontSize}px`,
        letterSpacing: '-0.03em',
        lineHeight: 1,
        color,
        // Improves rendering of heavy weights
        fontFeatureSettings: '"ss01" on, "cv11" on',
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
        ...style,
      }}
    >{text}</span>
  );
}

function ShadesLockupHorizontal({
  height = 96,                   // total lockup height in px
  variant = 'light',             // matches ShadesMark variants
  wordmarkColor,                 // override
  gap,                           // override gap between mark and wordmark
  bleed = false,
}) {
  const inkColor = (variant === 'dark' || variant === 'transparent-dark' || variant === 'mono-cream')
    ? SHADES.cream : SHADES.ink;
  const fillColor = wordmarkColor || inkColor;
  // Wordmark cap-height ≈ 0.72 × font-size. Match mark size to cap-height × ~1.4.
  const markSize = height;
  const fontSize = Math.round(height * 0.78);
  const realGap = gap ?? Math.round(height * 0.18);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: realGap,
      height,
    }}>
      <ShadesMark size={markSize} variant={variant} bleed={bleed} />
      <ShadesWordmark fontSize={fontSize} color={fillColor} />
    </div>
  );
}

function ShadesLockupStacked({
  height = 200,                 // total lockup height
  variant = 'light',
  wordmarkColor,
  gap,
  bleed = false,
}) {
  const inkColor = (variant === 'dark' || variant === 'transparent-dark' || variant === 'mono-cream')
    ? SHADES.cream : SHADES.ink;
  const fillColor = wordmarkColor || inkColor;
  // Mark gets ~62% of height; wordmark fills ~30%.
  const markSize = Math.round(height * 0.62);
  const fontSize = Math.round(height * 0.26);
  const realGap = gap ?? Math.round(height * 0.06);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: realGap,
      height,
    }}>
      <ShadesMark size={markSize} variant={variant} bleed={bleed} />
      <ShadesWordmark fontSize={fontSize} color={fillColor} />
    </div>
  );
}

Object.assign(window, { ShadesWordmark, ShadesLockupHorizontal, ShadesLockupStacked });
