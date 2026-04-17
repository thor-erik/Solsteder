// ── Supabase auth ──────────────────────────────────────────────────────────────

const SUPABASE_URL      = 'https://wxalqodaeqgzahwlovnw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let _currentUser = null;
let _currentRole = null; // 'user' | 'editor' | 'admin' | null

function authCurrentUser()   { return _currentUser; }
function authIsAdmin()       { return _currentRole === 'admin'; }
function authIsEditor()      { return _currentRole === 'editor' || _currentRole === 'admin'; }
function authCanDirectEdit() { return _currentRole === 'admin'; }
function authRole()          { return _currentRole; }

async function authLoadRole() {
  if (!_currentUser) { _currentRole = null; return; }
  const { data } = await _supabase
    .from('profiles')
    .select('role')
    .eq('id', _currentUser.id)
    .single();
  _currentRole = data?.role ?? 'user';
  _renderProfilePanel();
}

async function authSetUserRole(email, role) {
  if (!authIsAdmin()) return { error: 'Not admin' };
  const { data, error } = await _supabase
    .from('profiles')
    .update({ role })
    .eq('email', email)
    .select('id, email, name, role');
  return { data, error };
}

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

    const roleBadge = _currentRole === 'admin'
      ? `<span class="profile-role-badge admin">Admin</span>`
      : _currentRole === 'editor'
      ? `<span class="profile-role-badge editor">Editor</span>`
      : '';

    const adminSection = authIsAdmin() ? `
      <div class="profile-panel-section">
        <button class="profile-panel-row profile-admin-row" onclick="openAdminReviewPanel();closeProfilePanel()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <span>Ventende forslag</span>
          <span id="pending-count-badge" class="pending-badge" style="display:none">…</span>
        </button>
        <button class="profile-panel-row profile-admin-row" onclick="openRoleManagerPanel();closeProfilePanel()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span>Administrer brukere</span>
        </button>
      </div>` : '';

    panel.innerHTML = `
      <div class="profile-panel-header">
        ${avatarHtml}
        <div class="profile-panel-info">
          ${name ? `<div class="profile-panel-name">${name} ${roleBadge}</div>` : roleBadge}
          <div class="profile-panel-email">${email}</div>
        </div>
      </div>
      ${adminSection}
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

    if (authIsAdmin()) _loadPendingCount();
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

// ── Pending count ─────────────────────────────────────────────────────────────

async function _loadPendingCount() {
  const badge = document.getElementById('pending-count-badge');
  if (!badge) return;
  const { count } = await _supabase
    .from('pending_edits')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// ── Admin review panel ────────────────────────────────────────────────────────

async function openAdminReviewPanel() {
  let modal = document.getElementById('admin-review-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'admin-review-modal';
    modal.className = 'admin-modal';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="admin-modal-inner">
    <div class="admin-modal-header">
      <div class="admin-modal-title">Ventende forslag</div>
      <button class="admin-modal-close" onclick="document.getElementById('admin-review-modal').remove()">✕</button>
    </div>
    <div class="admin-modal-body" id="admin-review-body">
      <div style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center">Laster…</div>
    </div>
  </div>`;
  modal.style.display = 'flex';

  const { data: edits, error } = await _supabase
    .from('pending_edits')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  const body = document.getElementById('admin-review-body');
  if (!body) return;
  if (error || !edits?.length) {
    body.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center">${error ? 'Feil ved lasting.' : 'Ingen ventende forslag.'}</div>`;
    return;
  }

  body.innerHTML = edits.map(e => {
    const before = e.before_state ?? {};
    const after  = e.after_state  ?? {};
    const changes = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const diffHtml = changes.map(k =>
      `<div class="admin-diff-row"><span class="admin-diff-key">${k}</span>
       <span class="admin-diff-before">${JSON.stringify(before[k])}</span>
       <span class="admin-diff-arrow">→</span>
       <span class="admin-diff-after">${JSON.stringify(after[k])}</span></div>`
    ).join('');
    return `
      <div class="admin-edit-card" id="admin-edit-${e.id}">
        <div class="admin-edit-header">
          <div class="admin-edit-venue">${e.venue_name ?? 'Ukjent'}</div>
          <div class="admin-edit-meta">${e.user_name ?? e.user_email ?? 'Ukjent bruker'} · ${new Date(e.created_at).toLocaleDateString('no-NO')}</div>
        </div>
        <div class="admin-edit-diff">${diffHtml || '<span style="color:var(--muted);font-size:12px">Ingen endringer registrert</span>'}</div>
        <div class="admin-edit-actions">
          <button class="admin-approve-btn" onclick="adminApproveEdit('${e.id}', ${e.venue_id}, ${JSON.stringify(JSON.stringify(e.after_state))})">Godkjenn</button>
          <button class="admin-reject-btn"  onclick="adminRejectEdit('${e.id}')">Avvis</button>
        </div>
      </div>`;
  }).join('');
}

async function adminApproveEdit(editId, venueId, afterStateJson) {
  const afterState = JSON.parse(afterStateJson);
  if (typeof applyVenueEditProposal === 'function') applyVenueEditProposal(venueId, afterState);
  await _supabase.from('pending_edits').update({
    status: 'approved',
    reviewed_at: new Date().toISOString(),
    reviewed_by: _currentUser.id,
  }).eq('id', editId);
  const card = document.getElementById(`admin-edit-${editId}`);
  if (card) {
    card.style.opacity = '0.4';
    card.querySelector('.admin-edit-actions').innerHTML = '<span style="color:#64ffb4;font-size:12px">✓ Godkjent</span>';
  }
  _loadPendingCount();
}

async function adminRejectEdit(editId) {
  await _supabase.from('pending_edits').update({
    status: 'rejected',
    reviewed_at: new Date().toISOString(),
    reviewed_by: _currentUser.id,
  }).eq('id', editId);
  const card = document.getElementById(`admin-edit-${editId}`);
  if (card) {
    card.style.opacity = '0.4';
    card.querySelector('.admin-edit-actions').innerHTML = '<span style="color:#ff6b6b;font-size:12px">✗ Avvist</span>';
  }
  _loadPendingCount();
}

// ── Role manager panel ────────────────────────────────────────────────────────

async function openRoleManagerPanel() {
  let modal = document.getElementById('role-manager-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'role-manager-modal';
    modal.className = 'admin-modal';
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  modal.innerHTML = `<div class="admin-modal-inner">
    <div class="admin-modal-header">
      <div class="admin-modal-title">Administrer brukere</div>
      <button class="admin-modal-close" onclick="document.getElementById('role-manager-modal').remove()">✕</button>
    </div>
    <div class="admin-modal-body">
      <div style="margin-bottom:16px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:6px">E-post</label>
        <input id="role-email-input" type="email" placeholder="bruker@example.com" style="
          width:100%;box-sizing:border-box;background:rgba(255,255,255,0.07);
          border:1px solid rgba(156,189,231,0.3);border-radius:8px;
          color:var(--text);font-family:'Inter',sans-serif;font-size:13px;
          padding:9px 12px;outline:none;">
        <label style="font-size:12px;color:var(--muted);display:block;margin-top:12px;margin-bottom:6px">Rolle</label>
        <select id="role-select" style="
          width:100%;background:rgba(255,255,255,0.07);
          border:1px solid rgba(156,189,231,0.3);border-radius:8px;
          color:var(--text);font-family:'Inter',sans-serif;font-size:13px;
          padding:9px 12px;outline:none;">
          <option value="user">user — kan foreslå endringer</option>
          <option value="editor">editor — kan redigere direkte</option>
          <option value="admin">admin — full tilgang</option>
        </select>
        <button onclick="roleManagerSubmit()" style="
          margin-top:12px;width:100%;
          background:rgba(255,175,133,0.15);border:1px solid rgba(255,175,133,0.45);
          border-radius:8px;color:var(--accent);font-family:'Inter',sans-serif;
          font-size:13px;font-weight:600;padding:10px;cursor:pointer;">
          Oppdater rolle
        </button>
        <div id="role-manager-result" style="margin-top:10px;font-size:12px;min-height:18px;text-align:center"></div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Alle brukere med forhøyet tilgang</div>
        <div id="role-manager-list">Laster…</div>
      </div>
    </div>
  </div>`;

  // Load existing elevated users
  const { data } = await _supabase
    .from('profiles')
    .select('email, name, role')
    .in('role', ['admin', 'editor'])
    .order('role');
  const listEl = document.getElementById('role-manager-list');
  if (listEl) {
    listEl.innerHTML = data?.length
      ? data.map(u => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
          <div><div style="font-size:13px;color:var(--text)">${u.name ?? u.email}</div><div style="font-size:11px;color:var(--muted)">${u.email}</div></div>
          <span class="profile-role-badge ${u.role}">${u.role}</span>
        </div>`).join('')
      : '<div style="font-size:12px;color:var(--muted)">Ingen forhøyede brukere ennå.</div>';
  }
}

async function roleManagerSubmit() {
  const email  = document.getElementById('role-email-input')?.value?.trim();
  const role   = document.getElementById('role-select')?.value;
  const result = document.getElementById('role-manager-result');
  if (!email || !role) return;
  result.textContent = 'Oppdaterer…';
  result.style.color = 'var(--muted)';
  const { data, error } = await authSetUserRole(email, role);
  if (error || !data?.length) {
    result.textContent = error?.message ?? 'Fant ikke brukeren. Har de logget inn?';
    result.style.color = '#ff6b6b';
  } else {
    result.textContent = `✓ ${email} er nå ${role}`;
    result.style.color = '#64ffb4';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Populate panel immediately (logged-out state) so it's never an empty div
_updateUserIndicator();

_supabase.auth.getSession().then(({ data: { session } }) => {
  _currentUser = session?.user ?? null;
  _updateUserIndicator();
  if (_currentUser) authLoadRole();
});

_supabase.auth.onAuthStateChange((event, session) => {
  const wasLoggedIn = !!_currentUser;
  _currentUser = session?.user ?? null;
  _updateUserIndicator();
  if (_currentUser) authLoadRole(); else { _currentRole = null; }

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
