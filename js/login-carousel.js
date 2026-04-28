// Auto-rotating benefits carousel for the logged-out profile panel.
// Mounted by auth.js after rendering; unmounted on close or login.

let _track = null;
let _dots  = null;
let _idx   = 0;
let _count = 0;
let _timer = null;
let _resumeTimer = null;
let _touchStartX = null;
let _root  = null;

const INTERVAL_MS = 4000;
const RESUME_MS   = 6000;
const SWIPE_PX    = 40;

function _goTo(idx) {
  if (!_track || _count === 0) return;
  _idx = ((idx % _count) + _count) % _count;
  _track.style.transform = `translateX(${-100 * _idx}%)`;
  if (_dots) {
    for (let i = 0; i < _dots.length; i++) {
      _dots[i].classList.toggle('active', i === _idx);
    }
  }
}

function _advance() { _goTo(_idx + 1); }

function _startTimer() {
  if (_timer) clearInterval(_timer);
  _timer = setInterval(_advance, INTERVAL_MS);
}

function _stopTimer() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
}

function _scheduleResume() {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  _resumeTimer = setTimeout(_startTimer, RESUME_MS);
}

function _onPointerDown(e) {
  _stopTimer();
  _touchStartX = e.touches ? e.touches[0].clientX : e.clientX;
}

function _onPointerUp(e) {
  if (_touchStartX == null) { _scheduleResume(); return; }
  const endX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
  const dx = endX - _touchStartX;
  _touchStartX = null;
  if (Math.abs(dx) > SWIPE_PX) _goTo(_idx + (dx < 0 ? 1 : -1));
  _scheduleResume();
}

function _onDotClick(e) {
  const idx = Number(e.currentTarget.dataset.idx);
  if (Number.isFinite(idx)) {
    _stopTimer();
    _goTo(idx);
    _scheduleResume();
  }
}

function loginCarouselMount() {
  loginCarouselUnmount();
  _root = document.getElementById('login-carousel');
  if (!_root) return;
  _track = _root.querySelector('.login-carousel-track');
  _dots  = Array.from(_root.querySelectorAll('.login-dot'));
  _count = _track ? _track.children.length : 0;
  if (_count <= 1) return;

  _idx = 0;
  _goTo(0);

  _root.addEventListener('touchstart', _onPointerDown, { passive: true });
  _root.addEventListener('touchend',   _onPointerUp,   { passive: true });
  _root.addEventListener('mousedown',  _onPointerDown);
  _root.addEventListener('mouseup',    _onPointerUp);
  _dots.forEach(d => d.addEventListener('click', _onDotClick));

  _startTimer();
}

function loginCarouselUnmount() {
  _stopTimer();
  if (_root) {
    _root.removeEventListener('touchstart', _onPointerDown);
    _root.removeEventListener('touchend',   _onPointerUp);
    _root.removeEventListener('mousedown',  _onPointerDown);
    _root.removeEventListener('mouseup',    _onPointerUp);
  }
  if (_dots) _dots.forEach(d => d.removeEventListener('click', _onDotClick));
  _track = null; _dots = null; _root = null;
  _idx = 0; _count = 0; _touchStartX = null;
}

window.loginCarouselMount   = loginCarouselMount;
window.loginCarouselUnmount = loginCarouselUnmount;
