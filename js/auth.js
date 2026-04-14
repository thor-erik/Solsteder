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
  const el = document.getElementById('auth-user-btn');
  if (!el) return;
  if (_currentUser) {
    const avatar = _currentUser.user_metadata?.avatar_url;
    const name   = _currentUser.user_metadata?.name ?? _currentUser.email ?? '';
    el.innerHTML = avatar
      ? `<img src="${avatar}" style="width:24px;height:24px;border-radius:50%;display:block;" title="${name}" alt="${name}">`
      : `<div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#000;">${name[0].toUpperCase()}</div>`;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
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
