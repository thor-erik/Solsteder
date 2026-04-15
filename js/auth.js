// ── Supabase auth ──────────────────────────────────────────────────────────────

const SUPABASE_URL      = 'https://wxalqodaeqgzahwlovnw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let _currentUser = null;

function authCurrentUser() { return _currentUser; }

async function authSignInWithGoogle() {
  await _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
}

async function authSignOut() {
  await _supabase.auth.signOut();
}

function renderLoginGate(v) {
  return `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 24px 48px;text-align:center;gap:14px;">
      <div style="font-family:'Newsreader',serif;font-size:22px;color:var(--text);font-weight:400;">${v.name}</div>
      <div style="color:var(--muted);font-size:13px;line-height:1.6;max-width:240px;">
        Logg inn for å se sol-tidslinje, score og vær.
      </div>
      <button onclick="authSignInWithGoogle()" style="
        display:flex;align-items:center;gap:10px;
        background:#fff;color:#1f1f1f;
        border:none;border-radius:8px;
        padding:11px 22px;margin-top:8px;
        font-family:'Inter',sans-serif;font-size:14px;font-weight:500;
        cursor:pointer;
      ">
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 13.952 17.64 11.644 17.64 9.2z"/>
          <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
          <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
          <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
        </svg>
        Fortsett med Google
      </button>
    </div>
  `;
}

function _updateUserIndicator() {
  const btn = document.getElementById('search-profile-btn');
  if (!btn) return;
  if (_currentUser) {
    const avatar = _currentUser.user_metadata?.avatar_url;
    const name   = _currentUser.user_metadata?.name ?? _currentUser.email ?? '';
    btn.innerHTML = avatar
      ? `<img src="${avatar}" alt="${name}">`
      : `<div class="profile-initials">${name[0].toUpperCase()}</div>`;
  } else {
    btn.innerHTML = `<div class="profile-anon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
    </div>`;
  }
  _renderProfilePanel();
}

function _renderProfilePanel() {
  const panel = document.getElementById('profile-panel');
  if (!panel) return;

  if (_currentUser) {
    const avatar = _currentUser.user_metadata?.avatar_url;
    const name   = _currentUser.user_metadata?.name ?? '';
    const email  = _currentUser.email ?? '';
    const avatarHtml = avatar
      ? `<img class="profile-panel-avatar" src="${avatar}" alt="${name}">`
      : `<div class="profile-panel-avatar-initials">${(name || email)[0].toUpperCase()}</div>`;

    panel.innerHTML = `
      <div class="profile-panel-header">
        ${avatarHtml}
        <div class="profile-panel-info">
          ${name ? `<div class="profile-panel-name">${name}</div>` : ''}
          <div class="profile-panel-email">${email}</div>
        </div>
      </div>
      <div class="profile-panel-body">
        <!-- Future features go here -->
      </div>
      <div class="profile-panel-footer">
        <button class="profile-panel-signout" onclick="authSignOut();closeProfilePanel()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Logg ut
        </button>
      </div>
    `;
  } else {
    panel.innerHTML = `
      <div class="profile-panel-body">
        <button class="profile-panel-row" style="background:none;border:none;width:100%;font-family:'Inter',sans-serif;text-align:left;" onclick="authSignInWithGoogle();closeProfilePanel()">
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 13.952 17.64 11.644 17.64 9.2z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
          </svg>
          Logg inn med Google
        </button>
      </div>
    `;
  }
}

function toggleProfilePanel(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('profile-panel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (isOpen) {
    closeProfilePanel();
  } else {
    panel.classList.add('open');
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', _profilePanelOutsideClick, { once: true });
    }, 0);
  }
}

function closeProfilePanel() {
  const panel = document.getElementById('profile-panel');
  if (panel) panel.classList.remove('open');
}

function _profilePanelOutsideClick(e) {
  const panel = document.getElementById('profile-panel');
  const btn   = document.getElementById('search-profile-btn');
  if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
    closeProfilePanel();
  } else if (panel && panel.classList.contains('open')) {
    // Re-attach if click was inside panel
    document.addEventListener('click', _profilePanelOutsideClick, { once: true });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

_supabase.auth.getSession().then(({ data: { session } }) => {
  _currentUser = session?.user ?? null;
  _updateUserIndicator();
});

_supabase.auth.onAuthStateChange((event, session) => {
  const wasLoggedIn = !!_currentUser;
  _currentUser = session?.user ?? null;
  _updateUserIndicator();

  // After login: re-open the detail panel for the selected venue
  if (!wasLoggedIn && _currentUser && typeof selectedId !== 'undefined' && selectedId) {
    const v = typeof VENUES !== 'undefined' && VENUES.find(x => x.id === selectedId);
    if (v && typeof openDetailPanel === 'function') openDetailPanel(v);
  }

  // After sign-out: close the detail panel
  if (wasLoggedIn && !_currentUser && typeof closeDetailPanel === 'function') {
    closeDetailPanel();
  }
});
