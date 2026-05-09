// Lens effects — opt-in via ?fx=1 in the URL.
//
// Activates on the production app when the user adds ?fx=1 to the URL
// (so we can A/B compare without affecting the default experience).
// Adds a body[data-fx="1"] hook that the CSS uses to layer in:
//   • a polarized conic overlay on the venue list panel
//   • spotlight + rim-light + tilt + ripple on .venue-card
//
// Scroll-aware: tilt is suspended while any scrollable ancestor is
// scrolling, with a 200ms debounced reset (no flicker).
// Reduced-motion: tilt + spotlight + rim are all suspended when
// the user prefers reduced motion; only ripple still fires.

(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('fx') !== '1') return;

  document.body.setAttribute('data-fx', '1');

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
      // Rim values from tilt
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

    // Click ripple: anchored at the click point
    card.addEventListener('pointerdown', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--ripple-x', ((e.clientX - r.left) / r.width  * 100) + '%');
      card.style.setProperty('--ripple-y', ((e.clientY - r.top)  / r.height * 100) + '%');
      card.classList.remove('lens-fx-rippling');
      void card.offsetWidth;
      card.classList.add('lens-fx-rippling');
    });
  }

  // ── Find & wire cards ────────────────────────────────────────────────────
  function wireAll() {
    document.querySelectorAll('.venue-card').forEach(wireCard);
  }

  // The venue list is recreated on every reset (slider tick, sort, filter).
  // Use a MutationObserver on #venue-list to wire newly-added cards.
  function attachListObserver() {
    const list = document.getElementById('venue-list');
    if (!list) return;
    attachScrollGate(list);
    // Also attach to the parent panel — if the list itself doesn't scroll
    const panel = document.getElementById('panel');
    if (panel) attachScrollGate(panel);

    new MutationObserver(() => wireAll()).observe(list, {
      childList: true, subtree: false,
    });
    wireAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachListObserver, { once: true });
  } else {
    attachListObserver();
  }
})();
