/* ============================================================
 * Shades Loader v3 — 4-phase launch animation
 * ============================================================
 * Phases (in order):
 *   1. INTRO        ~350ms  static logo → solid yellow (Phase 3 reversed)
 *   2. LOADING LOOP ~2s/cyc solid yellow ↔ solid blue, blinds modulating
 *   3. RESOLVE      ~700ms  solid yellow → static logo
 *   4. CROSSFADE    ~300ms  static logo + app fade swap
 *
 * Geometry (viewBox 240×280) — pixel-aligned with the static logo:
 *   Sun half-dome  cx=120 cy=200 r=95  (clipped to y<200 baseline)
 *   Shadow circle  cx=120 cy= 96 r=78
 *   Wordmark       baseline at y=252, centered
 *
 *   Solid-yellow state:  sun_cy=105 (full circle, bottom touches y=200)
 *                         shadow_cy=105 (hidden inside sun, smaller r)
 *
 * Layers (back → front):
 *   1. SHADOW  striped circle, behind sun ALWAYS.
 *   2. SUN     yellow circle clipped to baseline (y<200).
 *   3. BLINDS  inverse model (blue overlay + growing yellow gaps)
 *              clipped to sun circle, then to baseline.
 *   4. WORDMARK static text "Shades" below the mark.
 *
 * First-frame contract:
 *   The loader paints THE STATIC LOGO STATE immediately on construction.
 *   No flash; ready to compose under the native PWA splash.
 *
 * API:
 *   const loader = createShadesLoader(host, {variant, showWordmark});
 *   loader.start({
 *     isLoaded:    () => boolean,   // polled at each yellow extreme
 *     isMapReady:  () => boolean,   // polled after Phase 3
 *     onComplete:  () => {},        // fires after Phase 4
 *   });
 *
 *   // OR explicit signals (alternative):
 *   loader.signalLoaded();
 *   loader.signalMapReady();
 *
 *   // OR direct phase control (for review pages):
 *   loader.setStaticFrame(name);  // 12 named frames; see FRAMES below
 *   loader.playPhase1(done);
 *   loader.playPhase2();           // loops until stopPhase2() or signalLoaded
 *   loader.stopPhase2();
 *   loader.playPhase3(done);
 *   loader.playPhase4(done);
 *   loader.reset();                // back to static logo, ready to start again
 * ============================================================ */

(function (global) {
  const SHADES = {
    ink:   '#111E38',
    cream: '#FFF2EB',
    sun:   '#F5C25E',
  };

  // ─── Geometry ────────────────────────────────────────────────
  const VB_W = 240;
  const VB_H = 280;
  const CX = 120;
  const BASELINE_Y = 200;

  const R_SUN = 95;
  const R_SHADOW = 78;

  const SUN_STATIC_CY    = 200; // half-dome center
  const SUN_YELLOW_CY    = 105; // full circle center; bottom touches baseline

  const SHADOW_STATIC_CY = 96;
  const SHADOW_YELLOW_CY = 105; // hidden behind sun

  const WORDMARK_X = CX;
  const WORDMARK_Y = 256;       // baseline of "Shades" text
  const WORDMARK_SIZE = 50;     // px
  const WORDMARK_WIDTH = R_SUN * 2;  // match the sun (yellow) circle diameter

  // Diagonal-stripe parameters for the shadow circle.
  const STRIPE_SPACING = 15;
  const STRIPE_INK_W   = 8;

  // Horizontal blinds (Phase 2). Pitched to MATCH the shadow circle's stripe
  // spacing so the loop reads at the same stripe width as the logo's striped
  // element (was 7 chunky bars at ~27px pitch — visibly wider than the logo's
  // 15px stripes). ~13 bars at ~14.6px pitch ≈ STRIPE_SPACING.
  const N_BARS = Math.round((2 * R_SUN) / STRIPE_SPACING);  // ≈ 13
  const BAR_SPACING = (2 * R_SUN) / N_BARS;                 // ≈ 14.6 ≈ STRIPE_SPACING
  // Final stripe angle in SVG rotation degrees. 135° produces the same
  // visual pattern as -45° (stripes 180°-symmetric) but reaching it
  // from 90° (horizontal, Phase 2 orientation) is a clean 45° sweep.
  const STRIPE_DIAGONAL = 135;
  const STRIPE_HORIZONTAL = 90;

  // ─── Easing ──────────────────────────────────────────────────
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  const easeInOutCubic = t =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const lerp = (a, b, t) => a + (b - a) * t;

  // ─── DOM helpers ────────────────────────────────────────────
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    const e = document.createElementNS(SVG_NS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  let _uid = 0;

  function buildSvg(variant, showWordmark) {
    const stripeColor = variant === 'dark' ? SHADES.cream : SHADES.ink;
    const textColor   = variant === 'dark' ? SHADES.cream : SHADES.ink;
    const id = `shadesv3-${++_uid}`;

    const svg = el('svg', {
      viewBox: `0 0 ${VB_W} ${VB_H}`,
      xmlns: SVG_NS,
      role: 'img',
      'aria-label': 'Shades — loading',
    });
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';
    svg.style.overflow = 'visible';

    const defs = el('defs');

    // Static baseline clip for the sun/blinds — STATIC at y=200.
    const baseClip = el('clipPath', { id: `${id}-base-clip` });
    baseClip.appendChild(el('rect', {
      x: 0, y: 0, width: VB_W, height: BASELINE_Y,
    }));
    defs.appendChild(baseClip);

    // Sun clip-circle — follows the sun's vertical position. The
    // horizontal blinds terminate cleanly on this curve.
    const sunClip = el('clipPath', { id: `${id}-sun-clip` });
    const sunClipCircle = el('circle', {
      cx: CX, cy: SUN_STATIC_CY, r: R_SUN,
    });
    sunClip.appendChild(sunClipCircle);
    defs.appendChild(sunClip);

    svg.appendChild(defs);

    // ─── Layer 1: SHADOW (back) ─────────────────────────────────
    const shadowG = el('g', { 'data-layer': 'shadow' });
    // Inner clip to shadow's circle (defined inside the translated group
    // so the clip moves with the shadow).
    const shadowClipPath = el('clipPath', { id: `${id}-shadow-clip` });
    const shadowClipCircle = el('circle', { cx: CX, cy: SHADOW_STATIC_CY, r: R_SHADOW });
    shadowClipPath.appendChild(shadowClipCircle);
    defs.appendChild(shadowClipPath);

    const shadowClipG = el('g', { 'clip-path': `url(#${id}-shadow-clip)` });
    const stripeRotG = el('g', { 'data-role': 'stripe-rot' });

    // Vertical stripe bars centered on (CX, SHADOW_STATIC_CY). Rotation
    // group orients them.
    const span = R_SHADOW * 2 + STRIPE_SPACING * 4;
    const n = Math.ceil(span / STRIPE_SPACING);
    for (let i = -n; i <= n; i++) {
      const cx = CX + i * STRIPE_SPACING;
      stripeRotG.appendChild(el('rect', {
        x: cx - STRIPE_INK_W / 2,
        y: SHADOW_STATIC_CY - span,
        width: STRIPE_INK_W,
        height: span * 2,
        fill: stripeColor,
      }));
    }
    shadowClipG.appendChild(stripeRotG);
    shadowG.appendChild(shadowClipG);
    svg.appendChild(shadowG);

    // ─── Layer 2 + 3: SUN + BLINDS (clipped to baseline) ────────
    const sunOuterG = el('g', { 'clip-path': `url(#${id}-base-clip)` });

    // Yellow base circle.
    const sunG = el('g', { 'data-layer': 'sun' });
    const sunCircle = el('circle', {
      cx: CX, cy: SUN_STATIC_CY, r: R_SUN, fill: SHADES.sun,
    });
    sunG.appendChild(sunCircle);
    sunOuterG.appendChild(sunG);

    // Inverse-model blinds:
    //   - Solid blue full-circle overlay clipped to sun
    //   - N horizontal yellow gap rects that grow 0 → max as barT 1 → 0
    const blindsG = el('g', { 'data-layer': 'blinds' });
    const blindsClipG = el('g', { 'clip-path': `url(#${id}-sun-clip)` });
    const blueOverlay = el('rect', {
      x: CX - R_SUN - 4,
      y: SUN_STATIC_CY - R_SUN - 4,
      width: R_SUN * 2 + 8,
      height: R_SUN * 2 + 8,
      fill: stripeColor,
    });
    blindsClipG.appendChild(blueOverlay);
    const gapRects = [];
    const gapCenters = [];
    for (let i = 0; i < N_BARS; i++) {
      const centerY = SUN_STATIC_CY - R_SUN + (i + 0.5) * BAR_SPACING;
      const rect = el('rect', {
        x: CX - R_SUN - 4,
        y: centerY,
        width: R_SUN * 2 + 8,
        height: 0,
        fill: SHADES.sun,
      });
      blindsClipG.appendChild(rect);
      gapRects.push(rect);
      gapCenters.push(centerY);
    }
    blindsG.appendChild(blindsClipG);
    sunOuterG.appendChild(blindsG);
    svg.appendChild(sunOuterG);

    // ─── Layer 4: WORDMARK ──────────────────────────────────────
    let wordmarkEl = null;
    if (showWordmark) {
      wordmarkEl = el('text', {
        x: WORDMARK_X,
        y: WORDMARK_Y,
        'text-anchor': 'middle',
        'font-family': 'Inter, "Inter Display", system-ui, sans-serif',
        'font-weight': '900',
        'font-size': WORDMARK_SIZE,
        'letter-spacing': '-0.03em',
        fill: textColor,
        textLength: WORDMARK_WIDTH,        // force the wordmark to the sun's diameter
        lengthAdjust: 'spacingAndGlyphs',
        opacity: 0,   // hidden through intro + loop; fades in on Phase 3 (resolve)
      });
      wordmarkEl.textContent = 'Shades';
      svg.appendChild(wordmarkEl);
    }

    return {
      svg,
      sunCircle, sunClipCircle,
      shadowClipCircle, stripeRotG,
      blueOverlay, gapRects, gapCenters,
      wordmarkEl,
    };
  }

  /**
   * Apply visual state.
   *   sunCy           y-position of sun's center (95..200)
   *   shadowCy        y-position of shadow's center (96..105)
   *   stripeAngle     SVG rotation degrees for shadow stripes
   *   barT            0..1 — bar thickness (0=yellow / 1=blue)
   *   opacity         0..1 — fades the entire SVG (used in Phase 4)
   */
  function applyState(refs, s) {
    const sunCy = s.sunCy ?? SUN_STATIC_CY;
    const shadowCy = s.shadowCy ?? SHADOW_STATIC_CY;
    const stripeAngle = s.stripeAngle ?? STRIPE_DIAGONAL;
    const barT = Math.max(0, Math.min(1, s.barT ?? 0));
    const opacity = s.opacity ?? 1;

    // Sun position
    refs.sunCircle.setAttribute('cy', sunCy);
    refs.sunClipCircle.setAttribute('cy', sunCy);

    // Reposition the blue overlay + gap rects to follow the sun
    const dy = sunCy - SUN_STATIC_CY;
    refs.blueOverlay.setAttribute('y', SUN_STATIC_CY - R_SUN - 4 + dy);

    // Blinds: yellow GAP rects grow as barT decreases.
    const PAD = 1.4;
    const padAmt = PAD * Math.pow(1 - barT, 2);
    const gapH = BAR_SPACING * (1 - barT) + padAmt;
    const gapHalf = gapH / 2;
    for (let i = 0; i < refs.gapRects.length; i++) {
      const rect = refs.gapRects[i];
      rect.setAttribute('y', refs.gapCenters[i] - gapHalf + dy);
      rect.setAttribute('height', gapH);
    }

    // Shadow position + stripe rotation
    refs.shadowClipCircle.setAttribute('cy', shadowCy);
    const sDy = shadowCy - SHADOW_STATIC_CY;
    refs.stripeRotG.setAttribute(
      'transform',
      `translate(0 ${sDy}) rotate(${stripeAngle} ${CX} ${SHADOW_STATIC_CY})`
    );

    // Opacity
    refs.svg.style.opacity = opacity;
  }

  // ─── Canonical static frames ────────────────────────────────
  // Each frame is a target state for the loader. Used both for static
  // review tiles and as the start/end anchors of animation phases.
  const FRAMES = {
    'static-logo': { // initial state, first frame
      sunCy: SUN_STATIC_CY, shadowCy: SHADOW_STATIC_CY,
      stripeAngle: STRIPE_DIAGONAL, barT: 0, opacity: 1,
    },
    'solid-yellow': {
      sunCy: SUN_YELLOW_CY, shadowCy: SHADOW_YELLOW_CY,
      stripeAngle: STRIPE_HORIZONTAL, barT: 0, opacity: 1,
    },
    'solid-blue': {
      sunCy: SUN_YELLOW_CY, shadowCy: SHADOW_YELLOW_CY,
      stripeAngle: STRIPE_HORIZONTAL, barT: 1, opacity: 1,
    },
    'striped-mid': {
      sunCy: SUN_YELLOW_CY, shadowCy: SHADOW_YELLOW_CY,
      stripeAngle: STRIPE_HORIZONTAL, barT: 0.5, opacity: 1,
    },
    'phase1-mid': null, // computed at runtime (lerp between static-logo and solid-yellow)
    'phase3-mid': null,
    'phase4-mid': { // logo at 50% opacity
      sunCy: SUN_STATIC_CY, shadowCy: SHADOW_STATIC_CY,
      stripeAngle: STRIPE_DIAGONAL, barT: 0, opacity: 0.5,
    },
    'phase4-end': { // logo fully gone
      sunCy: SUN_STATIC_CY, shadowCy: SHADOW_STATIC_CY,
      stripeAngle: STRIPE_DIAGONAL, barT: 0, opacity: 0,
    },
  };

  function interpFrames(a, b, t) {
    // Linear interpolation (no easing) — used for static review frames
    // so the midpoint shows a true visual middle, not the
    // easeOut-skewed position the animation actually hits at t=0.5.
    return {
      sunCy:       lerp(a.sunCy,       b.sunCy,       t),
      shadowCy:    lerp(a.shadowCy,    b.shadowCy,    t),
      stripeAngle: lerp(a.stripeAngle, b.stripeAngle, t),
      barT:        lerp(a.barT,        b.barT,        t),
      opacity:     lerp(a.opacity,     b.opacity,     t),
    };
  }
  FRAMES['phase1-mid'] = interpFrames(FRAMES['static-logo'], FRAMES['solid-yellow'], 0.5);
  FRAMES['phase3-mid'] = interpFrames(FRAMES['solid-yellow'], FRAMES['static-logo'], 0.5);

  // ─── Phase durations ────────────────────────────────────────
  const PHASE1_MS = 600;  // was 350 — too quick, read as a snap to the yellow circle
  const PHASE2_CYCLE_MS = 1400;  // was 2000 — snappier blinds loop (product tune)
  const PHASE2_HOLD_MS = 50;
  const PHASE2_HALF = PHASE2_CYCLE_MS / 2;
  const PHASE2_MOTION = PHASE2_HALF - PHASE2_HOLD_MS;
  const PHASE3_MS = 700;
  const PHASE4_MS = 600;  // was 300 — longer crossfade lets the map finish

  function createShadesLoader(container, options = {}) {
    const variant = options.variant === 'dark' ? 'dark' : 'light';
    const showWordmark = options.showWordmark !== false;
    // Product addition (not in the original design delivery): guarantee a
    // minimum number of full Phase-2 blinds cycles even when loading finishes
    // during the intro. The spec default is 0 (zero cycles on instant load);
    // pass 1 so the signature blinds motion is always seen.
    const minLoadingCycles = Math.max(0, options.minLoadingCycles || 0);
    const refs = buildSvg(variant, showWordmark);
    container.appendChild(refs.svg);

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let rafId = null;
    let phase = 'static-initial';        // see state-machine notes above
    let phaseStart = 0;
    let onPhaseComplete = null;
    let loadedSignaled = false;
    let mapReadySignaled = false;
    let isLoadedPoll = null;
    let isMapReadyPoll = null;
    let sequenceOnComplete = null;

    // First-frame contract: paint the static logo immediately.
    applyState(refs, FRAMES['static-logo']);

    function cancel() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    }

    function setStaticFrame(name) {
      cancel();
      const f = FRAMES[name];
      if (f) applyState(refs, f);
    }

    function reset() {
      cancel();
      phase = 'static-initial';
      onPhaseComplete = null;
      loadedSignaled = false;
      mapReadySignaled = false;
      isLoadedPoll = null;
      isMapReadyPoll = null;
      sequenceOnComplete = null;
      // Wordmark starts hidden — it fades in only when the loop resolves.
      if (refs.wordmarkEl) refs.wordmarkEl.setAttribute('opacity', 0);
      applyState(refs, FRAMES['static-logo']);
    }

    function checkLoaded() {
      if (loadedSignaled) return true;
      if (isLoadedPoll && isLoadedPoll()) {
        loadedSignaled = true;
        return true;
      }
      return false;
    }
    function checkMapReady() {
      if (mapReadySignaled) return true;
      if (isMapReadyPoll && isMapReadyPoll()) {
        mapReadySignaled = true;
        return true;
      }
      return false;
    }

    // ── Phase 1 — INTRO (static logo → solid yellow) ───────────
    function tickPhase1(now) {
      const t = Math.min(1, (now - phaseStart) / PHASE1_MS);
      const e = easeOutCubic(t);
      const a = FRAMES['static-logo']; const b = FRAMES['solid-yellow'];
      applyState(refs, {
        sunCy:       lerp(a.sunCy,       b.sunCy,       e),
        shadowCy:    lerp(a.shadowCy,    b.shadowCy,    e),
        stripeAngle: lerp(a.stripeAngle, b.stripeAngle, e),
        barT: 0, opacity: 1,
      });
      if (t < 1) {
        rafId = requestAnimationFrame(tickPhase1);
      } else {
        phase = 'between';
        const cb = onPhaseComplete; onPhaseComplete = null;
        if (cb) cb();
      }
    }
    function playPhase1(done) {
      cancel();
      phase = 'phase1';
      phaseStart = performance.now();
      onPhaseComplete = done || null;
      if (prefersReduced) {
        applyState(refs, FRAMES['static-logo']); // hold static logo
        phase = 'between';
        if (done) done();
        return;
      }
      rafId = requestAnimationFrame(tickPhase1);
    }

    // ── Phase 2 — LOADING LOOP ─────────────────────────────────
    // Cycle: solid-yellow → solid-blue → solid-yellow. 50 ms hold at
    // each extreme. At each return to solid yellow, check loading state;
    // if loaded, transition to Phase 3.
    function barTAtCyclePhase(p) {
      // p in [0, PHASE2_CYCLE_MS)
      if (p < PHASE2_HOLD_MS) return 0;                 // hold yellow
      if (p < PHASE2_HALF) {
        const m = (p - PHASE2_HOLD_MS) / PHASE2_MOTION;
        return easeInOutCubic(m);                       // → blue
      }
      const p2 = p - PHASE2_HALF;
      if (p2 < PHASE2_HOLD_MS) return 1;                // hold blue
      const m = (p2 - PHASE2_HOLD_MS) / PHASE2_MOTION;
      return 1 - easeInOutCubic(m);                     // → yellow
    }
    function tickPhase2(now) {
      const elapsed = now - phaseStart;
      const cyclePos = ((elapsed % PHASE2_CYCLE_MS) + PHASE2_CYCLE_MS) % PHASE2_CYCLE_MS;
      const barT = barTAtCyclePhase(cyclePos);
      applyState(refs, {
        sunCy: SUN_YELLOW_CY,
        shadowCy: SHADOW_YELLOW_CY,
        stripeAngle: STRIPE_HORIZONTAL,
        barT,
        opacity: 1,
      });

      // Check for loading-complete at each yellow extreme. The yellow
      // extreme is during [0, HOLD_MS) of each cycle. minLoadingCycles holds
      // the loop for at least that many full cycles before allowing an exit,
      // so the blinds are always seen even when loading is already done.
      if (cyclePos < PHASE2_HOLD_MS && elapsed >= minLoadingCycles * PHASE2_CYCLE_MS && checkLoaded()) {
        phase = 'between';
        playPhase3(_sequenceContinuation);
        return;
      }
      rafId = requestAnimationFrame(tickPhase2);
    }
    function playPhase2() {
      cancel();
      phase = 'phase2';
      phaseStart = performance.now();
      if (prefersReduced) {
        applyState(refs, FRAMES['static-logo']); // hold static logo
        // Poll for completion
        const poll = () => {
          if (checkLoaded()) {
            phase = 'between';
            playPhase3(_sequenceContinuation);
          } else {
            setTimeout(poll, 100);
          }
        };
        poll();
        return;
      }
      rafId = requestAnimationFrame(tickPhase2);
    }
    function stopPhase2() {
      cancel();
      phase = 'between';
    }

    // ── Phase 3 — RESOLVE (solid yellow → static logo) ─────────
    function tickPhase3(now) {
      const t = Math.min(1, (now - phaseStart) / PHASE3_MS);
      const e = easeOutCubic(t);
      const a = FRAMES['solid-yellow']; const b = FRAMES['static-logo'];
      applyState(refs, {
        sunCy:       lerp(a.sunCy,       b.sunCy,       e),
        shadowCy:    lerp(a.shadowCy,    b.shadowCy,    e),
        stripeAngle: lerp(a.stripeAngle, b.stripeAngle, e),
        barT: 0, opacity: 1,
      });
      // Fade the wordmark in as the mark resolves (loop complete → static logo).
      if (refs.wordmarkEl) refs.wordmarkEl.setAttribute('opacity', e.toFixed(3));
      if (t < 1) {
        rafId = requestAnimationFrame(tickPhase3);
      } else {
        phase = 'static-final';
        const cb = onPhaseComplete; onPhaseComplete = null;
        if (cb) cb();
      }
    }
    function playPhase3(done) {
      cancel();
      phase = 'phase3';
      phaseStart = performance.now();
      onPhaseComplete = done || null;
      if (prefersReduced) {
        applyState(refs, FRAMES['static-logo']);
        phase = 'static-final';
        if (done) done();
        return;
      }
      rafId = requestAnimationFrame(tickPhase3);
    }

    // ── Phase 4 — CROSSFADE ────────────────────────────────────
    function tickPhase4(now) {
      const t = Math.min(1, (now - phaseStart) / PHASE4_MS);
      const e = easeOutCubic(t);
      applyState(refs, { ...FRAMES['static-logo'], opacity: 1 - e });
      if (t < 1) {
        rafId = requestAnimationFrame(tickPhase4);
      } else {
        phase = 'done';
        const cb = onPhaseComplete; onPhaseComplete = null;
        if (cb) cb();
      }
    }
    function playPhase4(done) {
      cancel();
      phase = 'phase4';
      phaseStart = performance.now();
      onPhaseComplete = done || null;
      rafId = requestAnimationFrame(tickPhase4);
    }

    // ── Sequence orchestration ─────────────────────────────────
    // After Phase 1: if already loaded, skip Phase 2 → Phase 3.
    // After Phase 3: poll/wait for map ready, then Phase 4.
    function _sequenceContinuation() {
      // Called after Phase 3 completes. We're now in static-final state.
      const waitForMap = () => {
        if (checkMapReady()) {
          playPhase4(() => {
            phase = 'done';
            if (sequenceOnComplete) sequenceOnComplete();
          });
        } else {
          setTimeout(waitForMap, 50);
        }
      };
      waitForMap();
    }
    function _afterPhase1() {
      // minLoadingCycles forces the blinds loop even on instant loads; the
      // gate in tickPhase2 then holds Phase 2 until that many cycles elapse.
      if (checkLoaded() && minLoadingCycles <= 0) {
        playPhase3(_sequenceContinuation);
      } else {
        playPhase2();
      }
    }
    function start(opts = {}) {
      reset();
      isLoadedPoll   = opts.isLoaded   || null;
      isMapReadyPoll = opts.isMapReady || null;
      sequenceOnComplete = opts.onComplete || null;
      playPhase1(_afterPhase1);
    }
    function signalLoaded()   { loadedSignaled = true; }
    function signalMapReady() { mapReadySignaled = true; }

    function destroy() {
      cancel();
      if (refs.svg.parentNode) refs.svg.parentNode.removeChild(refs.svg);
    }

    return {
      svg: refs.svg,
      // Sequencing
      start, signalLoaded, signalMapReady,
      // Direct phase control
      playPhase1, playPhase2, stopPhase2, playPhase3, playPhase4,
      // Static frames
      reset, setStaticFrame,
      // Cleanup
      destroy,
    };
  }

  global.createShadesLoader = createShadesLoader;
  global.SHADES_LOADER_FRAMES = Object.keys(FRAMES);
})(typeof window !== 'undefined' ? window : globalThis);
