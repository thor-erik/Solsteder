// Design-token bridge for canvas/JS.
//
// Reads CSS custom properties from :root once at boot and exposes them as a
// plain object so canvas drawing code (render-pins, render-seating,
// render-editor, ui-shared, ui-detail) doesn't have to duplicate the palette.
//
// When a CSS token changes, the canvas tracks. When the JS-readable name needs
// changing, this file is the one place to do it.
//
// Defaults below mirror the values in index.html :root and act as fallback
// before the document is parsed (extremely unlikely given defer load order,
// but cheap to guard).

(function () {
  const FALLBACKS = {
    // Brand (Slate + Honey)
    accent:    '#F5C25E',  // honey gold (--accent)
    accentOn:  '#2C1F02',  // --accent-on
    coral200:  '#FFCBAA',  // legacy primitive (canvas pin special-cases)
    coral300:  '#FFC49A',
    // Cream / text
    text:      '#FFF4E0',  // warm cream (--text)
    cream100:  '#DECCC0',
    // Delft Blue / surfaces
    bg:        '#111E38',  // Delft Blue (--bg)
    surface:   '#111E38',  // deep blue-800 (canvas card-surface)
    surfaceDeep: '#0A1830',
    muted:     '#9BA9BC',  // cool grey (--muted)
    cool:      '#B5BCC8',  // (--cool)
    rain:      '#6F8AA8',  // (--rain)
    // Status
    success:   '#64FFB4',
    error:     '#FF6B6B',
    // Weather palette: 3 sun bands (yellow gradient) + 1 overcast (cool grey) + rain + night
    weatherClear:     '#F5C25E',
    weatherClearSoft: '#E8B870',
    weatherPartly:    '#D5B068',
    weatherOvercast:  '#9A8E7E',
    weatherRain:      '#4A5E82',
    weatherNight:     '#0F1B2A',
  };

  // Brand entries point at SEMANTIC tokens so the canvas tracks the active
  // brand. Primitive layer keeps legacy coral/blue values for direct
  // consumers; semantic tokens are the source of truth for brand colors.
  const VAR_MAP = {
    accent:      '--accent',
    accentOn:    '--accent-on',
    coral200:    '--coral-200',     // legacy primitive (still used directly)
    coral300:    '--coral-300',
    text:        '--text',
    cream100:    '--cream-100',
    bg:          '--bg',
    surface:     '--blue-800',      // no slate-mid semantic yet
    surfaceDeep: '--blue-950',
    muted:       '--muted',
    cool:        '--cool',
    rain:        '--rain',
    success:     '--green-500',
    error:       '--red-500',
    weatherClear:     '--weather-clear',
    weatherClearSoft: '--weather-clear-soft',
    weatherPartly:    '--weather-partly',
    weatherOvercast:  '--weather-overcast',
    weatherRain:      '--weather-rain',
    weatherNight:     '--weather-night',
  };

  function readTokens() {
    const out = Object.assign({}, FALLBACKS);
    if (typeof document === 'undefined' || !document.documentElement) return out;
    const cs = getComputedStyle(document.documentElement);
    for (const key in VAR_MAP) {
      const v = cs.getPropertyValue(VAR_MAP[key]).trim();
      if (v) out[key] = v;
    }
    return out;
  }

  window.TOKENS = readTokens();

  // Re-read when fonts/styles finish loading, in case a sheet was injected
  // after the deferred-script run (theme switch, dynamic <style>, etc.).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { window.TOKENS = readTokens(); }, { once: true });
  }
})();
