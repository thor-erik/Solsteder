// Lens effects — opt-in via ?fx=N or ?fx=lab in the URL.
//
//   ?fx=1   — preset: polarized panel + clean card
//   ?fx=2   — preset: vignette panel + polarized card
//   ?fx=lab — interactive lab: floating control panel lets you swap
//             panel + card static effects live on the real app.
//             URL persists state: ?fx=lab&panel=...&card=...
//
// All modes share the same motion stack: tilt + parallax + spotlight follows
// + rim light + click-flash. Motion is suspended during scroll (200ms
// debounced) and disabled when the user prefers reduced motion. Click-flash
// still fires; it doesn't move pixels.

(function () {
  const params = new URLSearchParams(location.search);
  // Default to '2' (locked combo: mirror-sky panel + chromatic card +
  // motion stack) when no flag present. Explicit overrides:
  //   ?fx=1   — alternate preset (polarized panel + clean card)
  //   ?fx=lab — interactive lab to swap effects live
  const fx = params.get('fx') || '2';
  if (fx !== '1' && fx !== '2' && fx !== 'lab') return;

  document.body.setAttribute('data-fx', fx);

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Effect catalog ──────────────────────────────────────────────────────
  // Each entry: { fx: gradient string, blend: mix-blend-mode value, label: UI text }
  const PANEL_FX = {
    'solid':         { fx: 'transparent', blend: 'normal', label: 'Solid (no effect)' },
    'vgrad':         { fx: 'linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 70%)', blend: 'normal', label: 'V-gradient (top darker)' },
    'hgrad':         { fx: 'linear-gradient(90deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0) 60%)', blend: 'normal', label: 'H-gradient' },
    'vignette':      { fx: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 30%, rgba(0,0,0,0.40) 100%)', blend: 'normal', label: 'Vignette (denser edges)' },
    'mirror-sky':    { fx: 'linear-gradient(135deg, rgba(230,245,255,0.32) 0%, rgba(230,245,255,0.14) 18%, transparent 38%, rgba(20,40,66,0.08) 62%, rgba(15,30,55,0.26) 100%)', blend: 'normal', label: 'Mirror · sky' },
    'mirror-pearl':  { fx: 'linear-gradient(135deg, rgba(255,242,225,0.22) 0%, rgba(255,242,225,0.08) 18%, transparent 38%, rgba(40,60,90,0.06) 62%, rgba(20,40,66,0.20) 100%)', blend: 'normal', label: 'Mirror · pearl' },
    'mirror-soft':   { fx: 'linear-gradient(135deg, rgba(255,255,255,0.13) 0%, rgba(255,255,255,0.03) 22%, transparent 42% 58%, rgba(0,0,0,0.06) 78%, rgba(0,0,0,0.16) 100%)', blend: 'normal', label: 'Mirror · soft' },
    'mirror-refract':{ fx: 'radial-gradient(circle 240px at 25% 15%, rgba(230,245,255,0.30) 0%, rgba(230,245,255,0.10) 28%, transparent 60%), radial-gradient(circle 220px at 75% 85%, rgba(15,30,55,0.22) 0%, transparent 55%)', blend: 'normal', label: 'Mirror · refract (curved)' },
    /* Polarized off-center for asymmetric "lens at angle" feel; see CARD_FX. */
    'polarized':     { fx: 'conic-gradient(from 200deg at 100% 0%, rgba(255,100,180,0.05) 0%, rgba(100,200,255,0.06) 25%, rgba(180,255,200,0.05) 50%, rgba(255,200,100,0.05) 75%, rgba(255,100,180,0.05) 100%)', blend: 'normal', label: 'Polarized (corner sweep)' },
    'chromatic':     { fx: 'linear-gradient(135deg, rgba(255,150,100,0.12) 0%, rgba(0,0,0,0) 25%, rgba(0,0,0,0) 75%, rgba(100,150,255,0.12) 100%)', blend: 'screen', label: 'Chromatic (warm/cool corners)' },
  };
  // Cards use slightly stronger alphas (smaller surfaces, blur eats less).
  const CARD_FX = {
    'solid':         { fx: 'transparent', blend: 'normal', label: 'Solid (no effect)' },
    'vgrad':         { fx: 'linear-gradient(180deg, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0) 70%)', blend: 'normal', label: 'V-gradient' },
    'vignette':      { fx: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 30%, rgba(0,0,0,0.30) 100%)', blend: 'normal', label: 'Vignette' },
    'mirror-sky':    { fx: 'linear-gradient(135deg, rgba(230,245,255,0.22) 0%, rgba(230,245,255,0.08) 18%, transparent 38%, rgba(20,40,66,0.05) 62%, rgba(15,30,55,0.18) 100%)', blend: 'normal', label: 'Mirror · sky' },
    'mirror-pearl':  { fx: 'linear-gradient(135deg, rgba(255,242,225,0.20) 0%, rgba(255,242,225,0.06) 18%, transparent 38%, rgba(40,60,90,0.05) 62%, rgba(20,40,66,0.16) 100%)', blend: 'normal', label: 'Mirror · pearl' },
    'mirror-soft':   { fx: 'linear-gradient(135deg, rgba(255,255,255,0.12) 0%, transparent 42% 58%, rgba(0,0,0,0.12) 100%)', blend: 'normal', label: 'Mirror · soft' },
    /* Polarized off-center (was 50% 50% pinwheel — too symmetric / "decorative").
       Origin at top-right corner so colors sweep diagonally across the card,
       reading as "light catching the lens at a specific angle" rather than
       a centered pinwheel. */
    'polarized':     { fx: 'conic-gradient(from 200deg at 100% 0%, rgba(255,100,180,0.05) 0%, rgba(100,200,255,0.07) 25%, rgba(180,255,200,0.05) 50%, rgba(255,200,100,0.05) 75%, rgba(255,100,180,0.05) 100%)', blend: 'normal', label: 'Polarized (corner sweep)' },
    'chromatic':     { fx: 'linear-gradient(135deg, rgba(255,150,100,0.16) 0%, rgba(0,0,0,0) 25%, rgba(0,0,0,0) 75%, rgba(100,150,255,0.16) 100%)', blend: 'normal', label: 'Chromatic (warm/cool corners)' },
  };

  // ── Apply panel + card effects ──────────────────────────────────────────
  function applyPanelFx(key) {
    const def = PANEL_FX[key] || PANEL_FX.solid;
    document.body.style.setProperty('--panel-fx-bg', def.fx);
    document.body.style.setProperty('--panel-fx-blend', def.blend);
  }
  function applyCardFx(key) {
    const def = CARD_FX[key] || CARD_FX.solid;
    document.body.style.setProperty('--card-fx-bg', def.fx);
    // Note: card's background-image stack uses --card-fx-bg, blend mode is
    // applied via the layer order rather than mix-blend-mode (cleaner since
    // .venue-card itself doesn't have a separate pseudo for the static FX).
  }

  // ── Resolve initial effect choices from URL ─────────────────────────────
  let panelKey, cardKey;
  if (fx === '1') {
    panelKey = 'polarized'; cardKey = 'solid';
  } else if (fx === '2') {
    panelKey = 'mirror-sky';  cardKey = 'chromatic';
  } else { // lab
    panelKey = params.get('panel') || 'mirror-sky';
    cardKey  = params.get('card')  || 'chromatic';
    if (!PANEL_FX[panelKey]) panelKey = 'mirror-sky';
    if (!CARD_FX[cardKey])   cardKey  = 'chromatic';
  }
  applyPanelFx(panelKey);
  applyCardFx(cardKey);

  // ── Lab UI: floating control panel ──────────────────────────────────────
  function buildLabUi() {
    const panelButtons = Object.keys(PANEL_FX)
      .map(k => `<button data-fx-key="${k}" type="button">${PANEL_FX[k].label}</button>`)
      .join('');
    const cardButtons = Object.keys(CARD_FX)
      .map(k => `<button data-fx-key="${k}" type="button">${CARD_FX[k].label}</button>`)
      .join('');

    const root = document.createElement('div');
    root.className = 'lens-fx-lab collapsed';
    root.innerHTML = `
      <div class="lens-fx-lab-toggle" title="Lens FX Lab">FX</div>
      <div class="lens-fx-lab-body">
        <div class="lens-fx-lab-row">
          <div class="lens-fx-lab-label">Panel effect</div>
          <div class="lens-fx-lab-options" data-fx-target="panel">${panelButtons}</div>
        </div>
        <div class="lens-fx-lab-row">
          <div class="lens-fx-lab-label">Card effect</div>
          <div class="lens-fx-lab-options" data-fx-target="card">${cardButtons}</div>
        </div>
        <div class="lens-fx-lab-hint">
          Motion (tilt + parallax + spotlight + rim) is always on.<br>
          URL state shareable: <code>?fx=lab&panel=…&card=…</code>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const toggle = root.querySelector('.lens-fx-lab-toggle');
    toggle.addEventListener('click', () => {
      root.classList.toggle('collapsed');
      root.classList.toggle('expanded');
    });
    // Open by default
    root.classList.remove('collapsed');
    root.classList.add('expanded');

    function markActive(target, key) {
      root.querySelectorAll(`[data-fx-target="${target}"] button`).forEach(b => {
        b.classList.toggle('active', b.dataset.fxKey === key);
      });
    }
    markActive('panel', panelKey);
    markActive('card',  cardKey);

    function syncUrl() {
      const u = new URL(location.href);
      u.searchParams.set('fx', 'lab');
      u.searchParams.set('panel', panelKey);
      u.searchParams.set('card',  cardKey);
      history.replaceState(null, '', u);
    }

    root.querySelectorAll('button[data-fx-key]').forEach(btn => {
      btn.addEventListener('click', handleClick, { capture: true });
      btn.addEventListener('pointerdown', handleClick, { capture: true });
      function handleClick(e) {
        e.stopPropagation();
        e.preventDefault();
        if (e.type === 'click' && btn.dataset.fxLastTrigger === 'pointer') {
          btn.dataset.fxLastTrigger = '';
          return;
        }
        if (e.type === 'pointerdown') btn.dataset.fxLastTrigger = 'pointer';
        const target = btn.parentElement.dataset.fxTarget;
        const key = btn.dataset.fxKey;
        console.log('[lens-fx]', e.type, 'target=' + target, 'key=' + key);
        if (target === 'panel') {
          panelKey = key;
          applyPanelFx(panelKey);
        } else if (target === 'card') {
          cardKey = key;
          applyCardFx(cardKey);
        }
        markActive(target, key);
        syncUrl();
      }
    });
  }

  // ── Scroll-aware gate ────────────────────────────────────────────────────
  const SCROLL_DEBOUNCE_MS = 200;
  const scrollingTargets = new WeakSet();
  let windowScrolling = false;
  function attachScrollGate(scrollContainer) {
    let timer;
    const isWindow = scrollContainer === window;
    scrollContainer.addEventListener('scroll', () => {
      if (isWindow) windowScrolling = true;
      else scrollingTargets.add(scrollContainer);
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (isWindow) windowScrolling = false;
        else scrollingTargets.delete(scrollContainer);
      }, SCROLL_DEBOUNCE_MS);
    }, { passive: true });
  }
  attachScrollGate(window);
  function isScrolling(el) {
    if (windowScrolling) return true;
    let cur = el;
    while (cur && cur !== document) {
      if (scrollingTargets.has(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // ── Card wiring ──────────────────────────────────────────────────────────
  function wireCard(card) {
    if (card.dataset.lensFx === '1') return;
    card.dataset.lensFx = '1';

    // Smaller controls (filter pills, sort buttons) get half-magnitude tilt —
    // 12° on a 32px pill looks cartoonish.
    const isPill = card.matches('.panel-filter-pill, .sort-btn');
    const tiltMax = isPill ? 6 : 12;

    let raf = null, mx = 50, my = 50, rx = 0, ry = 0;
    const update = () => {
      card.style.setProperty('--mx', mx + '%');
      card.style.setProperty('--my', my + '%');
      if (!reduce && !isScrolling(card)) {
        card.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      }
      if (!reduce) {
        const rxN = rx / tiltMax, ryN = ry / tiltMax;
        card.style.setProperty('--rim-top',    Math.max(0,  rxN).toFixed(2));
        card.style.setProperty('--rim-bottom', Math.max(0, -rxN).toFixed(2));
        card.style.setProperty('--rim-left',   Math.max(0, -ryN).toFixed(2));
        card.style.setProperty('--rim-right',  Math.max(0,  ryN).toFixed(2));
      }
      raf = null;
    };

    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top)  / r.height;
      mx = px * 100; my = py * 100;
      if (!reduce) {
        ry = (px - 0.5) * tiltMax;
        rx = (0.5 - py) * tiltMax;
        if (isScrolling(card)) {
          card.classList.remove('lens-fx-tilting');
          card.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg)';
        } else {
          card.classList.add('lens-fx-tilting');
        }
      }
      if (!raf) raf = requestAnimationFrame(update);
    });

    card.addEventListener('pointerleave', () => {
      card.classList.remove('lens-fx-tilting');
      if (!reduce) {
        card.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg)';
        card.style.setProperty('--rim-top',    '0');
        card.style.setProperty('--rim-bottom', '0');
        card.style.setProperty('--rim-left',   '0');
        card.style.setProperty('--rim-right',  '0');
      }
      card.style.setProperty('--mx', '50%');
      card.style.setProperty('--my', '50%');
    });

    card.addEventListener('pointerdown', (e) => {
      const r = card.getBoundingClientRect();
      const xPct = ((e.clientX - r.left) / r.width  * 100) + '%';
      const yPct = ((e.clientY - r.top)  / r.height * 100) + '%';
      card.style.setProperty('--ripple-x', xPct);
      card.style.setProperty('--ripple-y', yPct);
      // Also propagate to documentElement so when the list re-renders post-
      // selectVenue, the freshly-mounted .selected card inherits the click
      // position and the .selected::before emanate animation runs from the
      // place the user actually touched.
      document.documentElement.style.setProperty('--ripple-x', xPct);
      document.documentElement.style.setProperty('--ripple-y', yPct);
      card.classList.remove('lens-fx-rippling');
      void card.offsetWidth;
      card.classList.add('lens-fx-rippling');
    });
  }

  // All Tier-2 lens objects get the motion stack. Selector matches the CSS
  // rule for body[data-fx] in index.html. Filter / sort pills opt in too —
  // smaller magnitude is handled per-element in wireCard.
  const TIER2_SELECTOR =
    '.venue-card, .dp-card, .dp-action-card, .dpacc-action-card, .panel-filter-pill, .sort-btn';

  function wireAll() {
    document.querySelectorAll(TIER2_SELECTOR).forEach(wireCard);
  }

  function attachListObserver() {
    const list = document.getElementById('venue-list');
    if (!list) return;
    attachScrollGate(list);
    const panel = document.getElementById('panel');
    if (panel) attachScrollGate(panel);
    const detailPanel = document.getElementById('detail-panel');
    if (detailPanel) attachScrollGate(detailPanel);

    // Watch list, panel (filter pills live here), and detail panel.
    const obs = new MutationObserver(() => wireAll());
    obs.observe(list, { childList: true, subtree: false });
    if (panel) obs.observe(panel, { childList: true, subtree: true });
    if (detailPanel) obs.observe(detailPanel, { childList: true, subtree: true });
    wireAll();

    if (fx === 'lab') buildLabUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachListObserver, { once: true });
  } else {
    attachListObserver();
  }
})();
