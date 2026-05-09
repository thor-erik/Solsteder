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
  const fx = params.get('fx');
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
    'polarized':     { fx: 'conic-gradient(from 0deg at 50% 50%, rgba(255,100,180,0.05) 0%, rgba(100,200,255,0.06) 25%, rgba(180,255,200,0.05) 50%, rgba(255,200,100,0.05) 75%, rgba(255,100,180,0.05) 100%)', blend: 'normal', label: 'Polarized (conic shimmer)' },
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
    'polarized':     { fx: 'conic-gradient(from 0deg at 50% 50%, rgba(255,100,180,0.10) 0%, rgba(100,200,255,0.13) 25%, rgba(180,255,200,0.11) 50%, rgba(255,200,100,0.10) 75%, rgba(255,100,180,0.10) 100%)', blend: 'normal', label: 'Polarized (conic shimmer)' },
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
    panelKey = 'vignette';  cardKey = 'polarized';
  } else { // lab
    panelKey = params.get('panel') || 'vignette';
    cardKey  = params.get('card')  || 'polarized';
    if (!PANEL_FX[panelKey]) panelKey = 'vignette';
    if (!CARD_FX[cardKey])   cardKey  = 'polarized';
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

    let raf = null, mx = 50, my = 50, rx = 0, ry = 0;
    const update = () => {
      card.style.setProperty('--mx', mx + '%');
      card.style.setProperty('--my', my + '%');
      if (!reduce && !isScrolling(card)) {
        card.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg)`;
      }
      if (!reduce) {
        const rxN = rx / 12, ryN = ry / 12;
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
        ry = (px - 0.5) * 12;
        rx = (0.5 - py) * 12;
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
      card.style.setProperty('--ripple-x', ((e.clientX - r.left) / r.width  * 100) + '%');
      card.style.setProperty('--ripple-y', ((e.clientY - r.top)  / r.height * 100) + '%');
      card.classList.remove('lens-fx-rippling');
      void card.offsetWidth;
      card.classList.add('lens-fx-rippling');
    });
  }

  function wireAll() {
    document.querySelectorAll('.venue-card').forEach(wireCard);
  }

  function attachListObserver() {
    const list = document.getElementById('venue-list');
    if (!list) return;
    attachScrollGate(list);
    const panel = document.getElementById('panel');
    if (panel) attachScrollGate(panel);

    new MutationObserver(() => wireAll()).observe(list, {
      childList: true, subtree: false,
    });
    wireAll();

    if (fx === 'lab') buildLabUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachListObserver, { once: true });
  } else {
    attachListObserver();
  }
})();
