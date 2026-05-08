// Design-token bridge for canvas/JS.
//
// Reads CSS custom properties from :root once at boot and exposes them as a
// plain object so canvas drawing code (render-pins, render-arc, render-seating,
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
    // Brand
    accent:    '#FFAF85',  // --coral-500
    accentOn:  '#2A1A0C',  // --coral-900
    coral200:  '#FFCBAA',
    coral300:  '#FFC49A',
    // Cream / text
    text:      '#FFF2EB',  // --cream-50
    cream100:  '#DECCC0',
    // Blue / surfaces
    bg:        '#111E38',  // --blue-900
    surface:   '#142E52',  // --blue-800
    surfaceDeep: '#0A1830', // --blue-950
    muted:     '#9CBDE7',  // --blue-300
    cool:      '#B8CFEE',
    rain:      '#7FA5D9',
    // Status
    success:   '#64FFB4',
    error:     '#FF6B6B',
  };

  const VAR_MAP = {
    accent:      '--coral-500',
    accentOn:    '--coral-900',
    coral200:    '--coral-200',
    coral300:    '--coral-300',
    text:        '--cream-50',
    cream100:    '--cream-100',
    bg:          '--blue-900',
    surface:     '--blue-800',
    surfaceDeep: '--blue-950',
    muted:       '--blue-300',
    cool:        '--blue-200',
    rain:        '--blue-400',
    success:     '--green-500',
    error:       '--red-500',
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
