// ── Supabase auth ──────────────────────────────────────────────────────────────

const SUPABASE_URL      = 'https://wxalqodaeqgzahwlovnw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let _currentUser = null;
let _currentRole = null; // 'user' | 'editor' | 'admin' | null

// Social tables may not exist yet — probe once and skip all social queries if missing.
let _socialTablesReady = null; // null = unchecked, true/false after probe
async function _checkSocialTables() {
  if (_socialTablesReady !== null) return _socialTablesReady;
  const { error } = await _supabase.from('favorites').select('venue_id', { head: true, count: 'exact' }).limit(0);
  _socialTablesReady = !error;
  if (!_socialTablesReady) console.debug('[auth] Social tables not set up yet — skipping social features');
  return _socialTablesReady;
}

function authCurrentUser()   { return _currentUser; }
function authIsAdmin()       { return _currentRole === 'admin'; }
function authIsEditor()      { return _currentRole === 'editor' || _currentRole === 'admin'; }
function authCanDirectEdit() { return _currentRole === 'admin'; }
function authRole()          { return _currentRole; }

async function authLoadRole() {
  if (!_currentUser) { _currentRole = null; return; }
  const { data, error } = await _supabase
    .from('profiles')
    .select('role')
    .eq('id', _currentUser.id)
    .single();
  if (error) {
    console.warn('[auth] authLoadRole failed — profiles table may not exist yet.', error.message);
    _currentRole = 'user';
  } else {
    _currentRole = data?.role ?? 'user';
  }
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
  // Persist current app state so it can be restored after the OAuth redirect returns
  try {
    sessionStorage.setItem('solsteder_auth_restore', JSON.stringify({
      date:    typeof datePicker !== 'undefined' ? datePicker.value           : null,
      time:    typeof timeFromEl !== 'undefined' ? parseFloat(timeFromEl.value) : null,
      nowMode: typeof nowMode    !== 'undefined' ? nowMode                    : false,
      venueId: typeof selectedId !== 'undefined' ? selectedId                 : null,
    }));
  } catch (_) {}
  await _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
}

async function authSignInWithApple() {
  try {
    sessionStorage.setItem('solsteder_auth_restore', JSON.stringify({
      date:    typeof datePicker !== 'undefined' ? datePicker.value           : null,
      time:    typeof timeFromEl !== 'undefined' ? parseFloat(timeFromEl.value) : null,
      nowMode: typeof nowMode    !== 'undefined' ? nowMode                    : false,
      venueId: typeof selectedId !== 'undefined' ? selectedId                 : null,
    }));
  } catch (_) {}
  await _supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: window.location.origin }
  });
}

async function authSignInWithMagicLink(email) {
  const { error } = await _supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin }
  });
  return { error };
}

async function authSignOut() {
  await _supabase.auth.signOut();
}

function renderLoginGate(v) {
  return `
    <div class="login-gate">
      <div class="login-gate-title">${v.name}</div>
      <div class="login-gate-subtitle">
        Logg inn for å se sol-tidslinje, score og vær.
      </div>
      <div class="login-gate-buttons">
        <button class="auth-btn auth-btn-google" onclick="authSignInWithGoogle()">
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 13.952 17.64 11.644 17.64 9.2z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
          </svg>
          ${t('signin_google')}
        </button>
        <button class="auth-btn auth-btn-apple" onclick="authSignInWithApple()">
          <svg width="18" height="18" viewBox="0 0 256 315" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor" d="M213.8 167.1c-.4-39.6 32.3-58.6 33.7-59.5-18.3-26.8-46.9-30.5-57.1-30.9-24.3-2.5-47.5 14.3-59.8 14.3-12.4 0-31.5-14-51.8-13.6-26.7.4-51.3 15.5-65 39.4-27.7 48.1-7.1 119.4 19.9 158.5 13.2 19.1 29 40.6 49.7 39.8 19.9-.8 27.5-12.9 51.6-12.9 24.1 0 31 12.9 51.6 12.5 21.5-.4 35.2-19.5 48.3-38.7 15.2-22.2 21.5-43.7 21.8-44.8-.5-.2-41.9-16.1-42.3-63.8zM173.8 49.5C184.6 36.5 192 18.6 190.1 0 174.8.6 155.8 10.1 144.6 23 134.7 34.2 125.6 52.8 127.8 70.3c17 1.3 34.4-8.5 46-20.8"/>
          </svg>
          ${t('signin_apple')}
        </button>
        <div class="auth-divider"><span>or</span></div>
        <form class="auth-magic-link-form" onsubmit="handleMagicLinkSubmit(event, this)">
          <input type="email" class="auth-magic-link-input" placeholder="${t('magic_link_placeholder')}" required>
          <button type="submit" class="auth-btn auth-btn-email">${t('magic_link_send')}</button>
          <div class="auth-magic-link-status"></div>
        </form>
      </div>
    </div>
  `;
}

async function handleMagicLinkSubmit(e, form) {
  e.preventDefault();
  const input  = form.querySelector('.auth-magic-link-input');
  const btn    = form.querySelector('.auth-btn-email');
  const status = form.querySelector('.auth-magic-link-status');
  const email  = input.value.trim();
  if (!email) return;
  btn.disabled = true;
  btn.textContent = '…';
  const { error } = await authSignInWithMagicLink(email);
  if (error) {
    status.textContent = t('magic_link_error');
    status.className = 'auth-magic-link-status error';
  } else {
    status.textContent = t('magic_link_sent');
    status.className = 'auth-magic-link-status success';
    input.disabled = true;
  }
  btn.disabled = false;
  btn.textContent = t('magic_link_send');
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

/** Render the invitations inbox section: pending invites + own upcoming plans. */
function _renderInvitationsSection() {
  const pending = (typeof _planInvites !== 'undefined')
    ? _planInvites.filter(i => i.status === 'pending' && i.plan)
    : [];
  const ownUpcoming = (typeof _plans !== 'undefined')
    ? _plans.filter(p => p && p.creator_id === (_currentUser && _currentUser.id))
    : [];
  if (!pending.length && !ownUpcoming.length) return '';

  const fmt = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };
  const venueName = (vid) => {
    if (typeof VENUES === 'undefined' || !VENUES) return '';
    const v = VENUES.find(x => String(x.id) === String(vid));
    return v ? v.name : '';
  };

  let pendingHtml = '';
  if (pending.length) {
    pendingHtml = `
      <div class="profile-section-label">${t('invitations_label')} (${pending.length})</div>
      ${pending.map(inv => {
        const p = inv.plan;
        const creator = p.creator?.name || p.creator?.email || '';
        const vName = venueName(p.venue_id);
        return `<div class="inbox-row">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${vName}</div>
            <div class="inbox-row-meta">${creator} · ${fmt(p.planned_at)}</div>
          </div>
          <div class="inbox-row-actions">
            <button class="inbox-btn inbox-btn-preview"
                    onclick="closeProfilePanel();openPlanPreview({venueId:${JSON.stringify(p.venue_id)}, plannedAt:'${p.planned_at}', inviteId:'${inv.id}', inviterName:'${(creator||'').replace(/'/g, "\\'")}', mode:'invite'})">
              ${t('preview_plan')}
            </button>
            <button class="inbox-btn inbox-btn-accept"
                    onclick="respondToPlanInvite('${inv.id}','accepted');_renderProfilePanel()">
              ${t('plan_accept')}
            </button>
            <button class="inbox-btn inbox-btn-decline"
                    onclick="respondToPlanInvite('${inv.id}','declined');_renderProfilePanel()">
              ${t('plan_decline')}
            </button>
          </div>
        </div>`;
      }).join('')}`;
  }

  let yoursHtml = '';
  if (ownUpcoming.length) {
    yoursHtml = `
      <div class="profile-section-label profile-section-label-sub">${t('your_plans_label')}</div>
      ${ownUpcoming.map(p => {
        const vName = venueName(p.venue_id);
        const accepted = (p._invitees || []).filter(i => i.status === 'accepted').length;
        const total    = (p._invitees || []).length;
        const ratio = total ? `${accepted}/${total}` : '';
        return `<div class="inbox-row">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${vName}</div>
            <div class="inbox-row-meta">${fmt(p.planned_at)}${ratio ? ` · ${ratio} ✓` : ''}</div>
          </div>
          <div class="inbox-row-actions">
            <button class="inbox-btn inbox-btn-preview"
                    onclick="closeProfilePanel();openPlanPreview({venueId:${JSON.stringify(p.venue_id)}, plannedAt:'${p.planned_at}', mode:'preview'})">
              ${t('preview_plan')}
            </button>
          </div>
        </div>`;
      }).join('')}`;
  }

  return `
    <div class="profile-panel-section invitations-section">
      ${pendingHtml}
      ${yoursHtml}
    </div>`;
}

function _renderProfilePanel() {
  const panel = document.getElementById('profile-panel');
  if (!panel) return;

  if (_currentUser) {
    panel.classList.remove('logged-out');
    if (typeof loginCarouselUnmount === 'function') loginCarouselUnmount();

    const avatar   = _currentUser.user_metadata?.avatar_url;
    const name     = _currentUser.user_metadata?.name ?? '';
    const email    = _currentUser.email ?? '';
    const lang     = typeof prefLang     === 'function' ? prefLang()     : 'no';
    const tempUnit = typeof prefTempUnit === 'function' ? prefTempUnit() : 'C';

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
          <span>${t('pending_edits')}</span>
          <span id="pending-count-badge" class="pending-badge" style="display:none">…</span>
        </button>
        <button class="profile-panel-row profile-admin-row" onclick="openAdminVenueSuggestionsPanel();closeProfilePanel()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="16"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
          <span>${t('admin_venue_suggestions')}</span>
          <span id="venue-suggestions-count-badge" class="pending-badge" style="display:none">…</span>
        </button>
        <button class="profile-panel-row profile-admin-row" onclick="openRoleManagerPanel();closeProfilePanel()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span>${t('manage_users')}</span>
        </button>
        <button class="profile-panel-row profile-admin-row" onclick="toggleZoomDebugHelper()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <span id="zoom-debug-toggle-label">Show Debug</span>
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
      ${_renderInvitationsSection()}
      <div class="profile-panel-section profile-settings-section">
        <div class="profile-section-label">${t('settings')}</div>
        <div class="profile-pref-row">
          <span class="profile-pref-label">${t('language')}</span>
          <div class="profile-pref-pills">
            <button class="pref-pill${lang === 'en' ? ' active' : ''}" onclick="setPrefLang('en')">EN</button>
            <button class="pref-pill${lang === 'no' ? ' active' : ''}" onclick="setPrefLang('no')">NO</button>
            <button class="pref-pill${lang === 'se' ? ' active' : ''}" onclick="setPrefLang('se')">SE</button>
            <button class="pref-pill${lang === 'dk' ? ' active' : ''}" onclick="setPrefLang('dk')">DK</button>
          </div>
        </div>
        <div class="profile-pref-row">
          <span class="profile-pref-label">${t('temperature')}</span>
          <div class="profile-pref-pills">
            <button class="pref-pill${tempUnit === 'C' ? ' active' : ''}" onclick="setPrefTempUnit('C')">°C</button>
            <button class="pref-pill${tempUnit === 'F' ? ' active' : ''}" onclick="setPrefTempUnit('F')">°F</button>
          </div>
        </div>
      </div>
      ${_friends.length ? `
      <div class="profile-panel-section profile-settings-section">
        <div class="profile-section-label">${t('checkin_visibility')}</div>
        <div class="profile-pref-desc">${t('checkin_visibility_desc')}</div>
        ${_friends.map(f => {
          const hidden = _hiddenCheckinFriends.has(f.id);
          return `<div class="profile-pref-row checkin-vis-row">
            <span class="profile-pref-label">${f.name || f.email}</span>
            <button class="pref-pill checkin-vis-toggle${hidden ? '' : ' active'}" onclick="toggleCheckinVisibility('${f.id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                ${hidden
                  ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
                  : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'}
              </svg>
            </button>
          </div>`;
        }).join('')}
      </div>` : ''}
      <div class="profile-panel-section" id="my-suggestions-section" style="display:none">
        <div class="profile-section-label">${t('my_suggestions')}</div>
        <div id="my-suggestions-list" style="color:var(--muted);font-size:12px;padding:4px 16px 8px">${t('no_suggestions_yet')}</div>
      </div>
      ${typeof _notifSettingsHtml === 'function' ? _notifSettingsHtml() : ''}
      <div class="profile-panel-section">
        <button class="profile-panel-row" onclick="openFriendsModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          <span>${t('friends')}${_friends.length ? ` (${_friends.length})` : ''}</span>
          ${_pendingRequests.length ? `<span class="pending-badge">${_pendingRequests.length}</span>` : ''}
        </button>
      </div>
      <div class="profile-panel-footer">
        <a href="privacy.html" target="_blank" rel="noopener" class="profile-privacy-link">${t('privacy_policy')}</a>
        <button class="profile-panel-signout" onclick="authSignOut();closeProfilePanel()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
            <polyline points="16 17 21 12 16 7"/>
            <line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          ${t('signout')}
        </button>
      </div>
    `;

    if (authIsAdmin()) { _loadPendingCount(); _loadVenueSuggestionsCount(); }
    _loadMySuggestions();
  } else {
    panel.classList.add('logged-out');
    const slides = [1, 2, 3, 4].map(i => `
      <div class="login-slide">
        <div class="login-slide-icon">${_loginSlideIcon(i)}</div>
        <div class="login-slide-title">${t('login_slide' + i + '_title')}</div>
        <div class="login-slide-body">${t('login_slide' + i + '_body')}</div>
      </div>
    `).join('');
    const dots = [0, 1, 2, 3].map(i => `
      <button class="login-dot${i === 0 ? ' active' : ''}" data-idx="${i}" aria-label="Slide ${i + 1}"></button>
    `).join('');
    panel.innerHTML = `
      <button class="login-close-btn" aria-label="${t('login_close')}" onclick="closeProfilePanel()">×</button>
      <div class="login-hero">
        <h2 class="login-hero-title">${t('login_hero_title')}</h2>
        <div class="login-carousel" id="login-carousel">
          <div class="login-carousel-track">${slides}</div>
          <div class="login-carousel-dots">${dots}</div>
        </div>
      </div>
      <div class="login-auth-section">
        <div class="login-gate-buttons">
          <button class="auth-btn auth-btn-google" onclick="authSignInWithGoogle();closeProfilePanel()">
            <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
              <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908C16.658 13.952 17.64 11.644 17.64 9.2z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
              <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
              <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"/>
            </svg>
            ${t('signin_google')}
          </button>
          <button class="auth-btn auth-btn-apple" onclick="authSignInWithApple();closeProfilePanel()">
            <svg width="18" height="18" viewBox="0 0 256 315" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M213.8 167.1c-.4-39.6 32.3-58.6 33.7-59.5-18.3-26.8-46.9-30.5-57.1-30.9-24.3-2.5-47.5 14.3-59.8 14.3-12.4 0-31.5-14-51.8-13.6-26.7.4-51.3 15.5-65 39.4-27.7 48.1-7.1 119.4 19.9 158.5 13.2 19.1 29 40.6 49.7 39.8 19.9-.8 27.5-12.9 51.6-12.9 24.1 0 31 12.9 51.6 12.5 21.5-.4 35.2-19.5 48.3-38.7 15.2-22.2 21.5-43.7 21.8-44.8-.5-.2-41.9-16.1-42.3-63.8zM173.8 49.5C184.6 36.5 192 18.6 190.1 0 174.8.6 155.8 10.1 144.6 23 134.7 34.2 125.6 52.8 127.8 70.3c17 1.3 34.4-8.5 46-20.8"/>
            </svg>
            ${t('signin_apple')}
          </button>
          <div class="auth-divider"><span>${t('login_or')}</span></div>
          <form class="auth-magic-link-form" onsubmit="handleMagicLinkSubmit(event, this)">
            <input type="email" class="auth-magic-link-input" placeholder="${t('magic_link_placeholder')}" required>
            <button type="submit" class="auth-btn auth-btn-email">${t('magic_link_send')}</button>
            <div class="auth-magic-link-status"></div>
          </form>
        </div>
        <div class="login-footer">
          <a href="privacy.html" target="_blank" rel="noopener" class="profile-privacy-link">${t('privacy_policy')}</a>
        </div>
      </div>
    `;
  }
}

function _loginSlideIcon(i) {
  const stroke = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (i === 1) return `<svg viewBox="0 0 24 24" ${stroke}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  if (i === 2) return `<svg viewBox="0 0 24 24" ${stroke}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
  if (i === 3) return `<svg viewBox="0 0 24 24" ${stroke}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  return `<svg viewBox="0 0 24 24" ${stroke}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
}

function toggleProfilePanel(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('profile-panel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');
  if (!isOpen && typeof _aTrack === 'function') _aTrack('profile_open', {});
  if (isOpen) {
    closeProfilePanel();
  } else {
    panel.classList.add('open');
    window._navPush?.('profile');
    if (!_currentUser) {
      if (typeof loginCarouselMount === 'function') loginCarouselMount();
      if (typeof notifFreezeAutoDismiss === 'function') notifFreezeAutoDismiss();
    }
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', _profilePanelOutsideClick, { once: true });
    }, 0);
  }
}

function closeProfilePanel() {
  if (typeof loginCarouselUnmount === 'function') loginCarouselUnmount();
  if (typeof notifResumeAutoDismiss === 'function') notifResumeAutoDismiss();
  window._navDropLayer?.('profile');
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

// ── Friends modal ────────────────────────────────────────────────────────────

function openFriendsModal() {
  closeProfilePanel();
  let modal = document.getElementById('friends-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'friends-modal';
    modal.className = 'friends-modal-overlay';
    document.body.appendChild(modal);
  }
  _renderFriendsModal(modal);
  modal.classList.add('open');
  window._navPush?.('friends');
}

function closeFriendsModal() {
  window._navDropLayer?.('friends');
  const modal = document.getElementById('friends-modal');
  if (modal) modal.classList.remove('open');
}

function _renderFriendsModal(modal) {
  if (!modal) modal = document.getElementById('friends-modal');
  if (!modal) return;

  const friendsHtml = _friends.length
    ? _friends.map(f => {
        const avatar = f.avatar_url
          ? `<img class="friend-avatar" src="${f.avatar_url}" alt="${f.name || f.email}">`
          : `<div class="friend-avatar friend-avatar-initials">${(f.name || f.email)[0].toUpperCase()}</div>`;
        // Check if friend is checked in somewhere
        let checkinInfo = '';
        for (const [vid, list] of _friendCheckins) {
          const match = list.find(c => c.user.id === f.id);
          if (match) {
            const vName = typeof VENUES !== 'undefined' ? (VENUES.find(v => String(v.id) === vid)?.name || vid) : vid;
            const until = new Date(match.checkin.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            checkinInfo = `<div class="friend-checkin-info">📍 ${vName} · ${t('checked_in_until', { time: until })}</div>`;
            break;
          }
        }
        return `<div class="friend-item">
          <div class="friend-item-left">${avatar}<div class="friend-item-info"><div class="friend-item-name">${f.name || f.email}</div>${checkinInfo}</div></div>
          <button class="btn-icon-sm friend-remove" onclick="removeFriend('${f.friendshipId}');_renderFriendsModal()" title="${t('friend_removed')}">✕</button>
        </div>`;
      }).join('')
    : `<div class="friends-empty">${t('no_friends_yet')}</div>`;

  const pendingHtml = _pendingRequests.length
    ? `<div class="friends-section-label">${t('friend_requests')} (${_pendingRequests.length})</div>` +
      _pendingRequests.map(r => {
        const avatar = r.avatar_url
          ? `<img class="friend-avatar" src="${r.avatar_url}" alt="${r.name || r.email}">`
          : `<div class="friend-avatar friend-avatar-initials">${(r.name || r.email)[0].toUpperCase()}</div>`;
        return `<div class="friend-item friend-request">
          ${avatar}
          <div class="friend-item-info"><div class="friend-item-name">${r.name || r.email}</div></div>
          <button class="btn-accept" onclick="acceptFriendRequest('${r.friendshipId}');_renderFriendsModal()">${t('plan_accept')}</button>
        </div>`;
      }).join('')
    : '';

  modal.innerHTML = `
    <div class="friends-modal-card glass-panel">
      <div class="friends-modal-header">
        <h3>${t('friends')}</h3>
        <button class="friends-modal-close" onclick="closeFriendsModal()">✕</button>
      </div>
      ${pendingHtml}
      <div class="friends-section-label">${t('friends')}${_friends.length ? ` (${_friends.length})` : ''}</div>
      ${friendsHtml}
      <div class="friends-add-section">
        <div class="friends-section-label">${t('add_friend')}</div>
        <button class="social-form-btn" onclick="_copyFriendInviteLink()" style="width:100%">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          ${t('copy_invite_link')}
        </button>
        <div id="friend-add-result" class="friend-add-result"></div>
      </div>
    </div>`;
}

function _copyFriendInviteLink() {
  if (!_currentUser) return;
  const url = `${location.origin}${location.pathname}#friend/${_currentUser.id}`;
  const result = document.getElementById('friend-add-result');
  if (navigator.share) {
    navigator.share({ title: t('add_friend'), url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url);
  }
  if (result) {
    result.textContent = t('invite_link_copied');
    result.className = 'friend-add-result success';
  }
}

// ── Pending count ─────────────────────────────────────────────────────────────

async function _loadPendingCount() {
  const badge = document.getElementById('pending-count-badge');
  if (!badge) return;
  if (!await _checkSocialTables()) { badge.style.display = 'none'; return; }
  try {
    const { count, error } = await _supabase
      .from('pending_edits')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (error) {
      badge.style.display = 'none';
      return;
    }
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  } catch (err) {
    badge.style.display = 'none';
  }
}

// ── My suggestions ────────────────────────────────────────────────────────────

async function _loadMySuggestions() {
  if (!_currentUser) return;
  const section = document.getElementById('my-suggestions-section');
  const listEl  = document.getElementById('my-suggestions-list');
  if (!section || !listEl) return;

  const { data, error } = await _supabase
    .from('suggested_venues')
    .select('id, name, status, created_at')
    .eq('user_id', _currentUser.id)
    .neq('status', 'withdrawn')
    .order('created_at', { ascending: false });

  if (error || !data?.length) { section.style.display = 'none'; return; }

  section.style.display = '';
  const statusKey = { pending: 'status_pending', approved: 'status_approved', rejected: 'status_rejected' };
  listEl.innerHTML = data.map(s => `
    <div class="my-suggestion-row">
      <div class="my-suggestion-info">
        <span class="my-suggestion-name">${s.name}</span>
        <span class="suggestion-status-badge ${s.status}">${t(statusKey[s.status] ?? s.status)}</span>
      </div>
      ${s.status === 'pending'
        ? `<button class="suggestion-withdraw-btn" onclick="withdrawSuggestion('${s.id}')">${t('withdraw')}</button>`
        : ''}
    </div>`).join('');
}

async function withdrawSuggestion(id) {
  if (!confirm(t('withdraw_confirm'))) return;
  const { error } = await _supabase
    .from('suggested_venues')
    .update({ status: 'withdrawn' })
    .eq('id', id)
    .eq('user_id', _currentUser.id);
  if (!error) _loadMySuggestions();
}

async function submitVenueSuggestion({ name, lat, lng, address, osmId, googlePlaceId, notes }) {
  if (!_currentUser) return { error: 'not_logged_in' };
  if (typeof _aTrack === 'function') _aTrack('venue_suggestion', { name, address: address ?? null });

  // Build notes with source information
  let finalNotes = notes ?? '';
  if (googlePlaceId) {
    finalNotes = (finalNotes ? finalNotes + '\n' : '') + `[Google Place ID: ${googlePlaceId}]`;
  }

  return _supabase.from('suggested_venues').insert({
    user_id:    _currentUser.id,
    user_email: _currentUser.email,
    user_name:  _currentUser.user_metadata?.name ?? '',
    name, lat, lng,
    address: address ?? '',
    osm_id:  osmId   ?? null,
    notes:   finalNotes,
    status: 'pending',
  });
}

async function _loadVenueSuggestionsCount() {
  const badge = document.getElementById('venue-suggestions-count-badge');
  if (!badge) return;
  const { count } = await _supabase
    .from('suggested_venues')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// ── Load approved suggested venues into VENUES ────────────────────────────────
// Called after VENUES is populated. Merges in admin-approved user submissions
// so they appear on the map and list for all users.

async function loadApprovedSuggestions() {
  try {
    const { data, error } = await _supabase
      .from('suggested_venues')
      .select('id, name, lat, lng, address')
      .eq('status', 'approved');
    if (error || !data?.length) return;

    if (typeof VENUES === 'undefined') return;
    const existingIds = new Set(VENUES.map(v => String(v.id)));
    let added = 0;
    for (const s of data) {
      const synId = `sv_${s.id.replace(/-/g, '').slice(0, 10)}`;
      if (existingIds.has(synId)) continue;
      VENUES.push({
        id:            synId,
        name:          s.name,
        coords:        [s.lat, s.lng],
        lat:           s.lat,
        lng:           s.lng,
        address:       s.address ?? '',
        area:          '',
        category:      'restaurant',
        facing:        null,
        openingHours:  { open: 11, close: 23 },
        buildingOsmId: null,
        rating:        null,
        _source:       'suggested',
      });
      added++;
    }
    if (added > 0 && typeof renderList === 'function') renderList();
  } catch (e) {
    console.warn('[auth] loadApprovedSuggestions:', e.message);
  }
}

// ── Load current user's own suggestions (pending + approved) ────────────────
// Shows the user's own suggested venues on their map, even before admin approval.

async function loadOwnSuggestions() {
  if (!_currentUser) return;
  if (!await _checkSocialTables()) return;
  try {
    const { data, error } = await _supabase
      .from('suggested_venues')
      .select('id, name, lat, lng, address, status')
      .eq('user_id', _currentUser.id)
      .in('status', ['pending', 'approved']);
    if (error || !data?.length) return;

    if (typeof VENUES === 'undefined') return;
    const existingIds = new Set(VENUES.map(v => String(v.id)));
    let added = 0;
    for (const s of data) {
      const synId = `sv_${s.id.replace(/-/g, '').slice(0, 10)}`;
      if (existingIds.has(synId)) continue;
      VENUES.push({
        id:            synId,
        name:          s.name,
        coords:        [s.lat, s.lng],
        lat:           s.lat,
        lng:           s.lng,
        address:       s.address ?? '',
        area:          '',
        category:      'restaurant',
        facing:        null,
        openingHours:  { open: 11, close: 23 },
        buildingOsmId: null,
        rating:        null,
        _source:       'suggested',
        _ownSuggestion: true,
      });
      added++;
    }
    if (added > 0) {
      if (typeof renderList === 'function') renderList();
      if (typeof draw === 'function') draw();
    }
  } catch (e) {
    console.warn('[auth] loadOwnSuggestions:', e.message);
  }
}

// ── Admin venue suggestions panel ─────────────────────────────────────────────

async function openAdminVenueSuggestionsPanel() {
  let modal = document.getElementById('venue-suggestions-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'venue-suggestions-modal';
    modal.className = 'admin-modal';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="admin-modal-inner">
    <div class="admin-modal-header">
      <div class="admin-modal-title">${t('admin_venue_suggestions')}</div>
      <button class="admin-modal-close" onclick="document.getElementById('venue-suggestions-modal').remove()">✕</button>
    </div>
    <div class="admin-modal-body" id="venue-suggestions-body">
      <div style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center">Laster…</div>
    </div>
  </div>`;
  modal.style.display = 'flex';

  const { data: suggestions, error } = await _supabase
    .from('suggested_venues')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  const body = document.getElementById('venue-suggestions-body');
  if (!body) return;
  if (error || !suggestions?.length) {
    body.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center">${error ? 'Feil ved lasting.' : 'Ingen ventende stedforslag.'}</div>`;
    return;
  }

  body.innerHTML = suggestions.map(s => `
    <div class="admin-edit-card" id="vsug-${s.id}">
      <div class="admin-edit-header">
        <div class="admin-edit-venue">${s.name}</div>
        <div class="admin-edit-meta">${s.user_name ?? s.user_email ?? 'Ukjent'} · ${new Date(s.created_at).toLocaleDateString('no-NO')}</div>
      </div>
      <div class="admin-diff-row" style="font-size:12px;color:var(--muted)">
        ${s.address ? `${s.address} · ` : ''}${s.lat?.toFixed(5)}, ${s.lng?.toFixed(5)}
        ${s.notes ? `<br><em>${s.notes}</em>` : ''}
      </div>
      <div class="admin-edit-actions">
        <button class="admin-approve-btn" onclick="adminApproveVenueSuggestion('${s.id}')">Godkjenn</button>
        <button class="admin-reject-btn"  onclick="adminRejectVenueSuggestion('${s.id}')">Avvis</button>
      </div>
    </div>`).join('');
}

async function adminApproveVenueSuggestion(id) {
  await _supabase.from('suggested_venues').update({
    status: 'approved',
    reviewed_at: new Date().toISOString(),
    reviewed_by: _currentUser.id,
  }).eq('id', id);
  const card = document.getElementById(`vsug-${id}`);
  if (card) {
    card.style.opacity = '0.4';
    card.querySelector('.admin-edit-actions').innerHTML = '<span style="color:#64ffb4;font-size:12px">✓ Godkjent</span>';
  }
  _loadVenueSuggestionsCount();
  loadApprovedSuggestions();
}

async function adminRejectVenueSuggestion(id) {
  await _supabase.from('suggested_venues').update({
    status: 'rejected',
    reviewed_at: new Date().toISOString(),
    reviewed_by: _currentUser.id,
  }).eq('id', id);
  const card = document.getElementById(`vsug-${id}`);
  if (card) {
    card.style.opacity = '0.4';
    card.querySelector('.admin-edit-actions').innerHTML = '<span style="color:#ff6b6b;font-size:12px">✗ Avvist</span>';
  }
  _loadVenueSuggestionsCount();
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

  let edits = null;
  let error = null;
  try {
    const result = await _supabase
      .from('pending_edits')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    edits = result.data;
    error = result.error;
  } catch (err) {
    error = { code: '42P01', message: 'pending_edits table not set up yet.' };
  }

  const body = document.getElementById('admin-review-body');
  if (!body) return;
  if (error || !edits?.length) {
    const msg = error?.code === '42P01'
      ? 'pending_edits table not set up yet.'
      : error ? 'Feil ved lasting.' : 'Ingen ventende endringer.';
    body.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center">${msg}</div>`;
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
  try {
    await _supabase.from('pending_edits').update({
      status: 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: _currentUser.id,
    }).eq('id', editId);
  } catch (err) {
    console.warn('Failed to approve edit:', err.message);
  }
  const card = document.getElementById(`admin-edit-${editId}`);
  if (card) {
    card.style.opacity = '0.4';
    card.querySelector('.admin-edit-actions').innerHTML = '<span style="color:#64ffb4;font-size:12px">✓ Godkjent</span>';
  }
  _loadPendingCount();
}

async function adminRejectEdit(editId) {
  try {
    await _supabase.from('pending_edits').update({
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
      reviewed_by: _currentUser.id,
    }).eq('id', editId);
  } catch (err) {
    console.warn('Failed to reject edit:', err.message);
  }
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

// ── Favorites ────────────────────────────────────────────────────────────────

let _favoritesSet = new Set();

function isFavorite(venueId) { return _favoritesSet.has(String(venueId)); }

async function loadFavorites() {
  if (!_currentUser) { _favoritesSet.clear(); return; }
  if (!await _checkSocialTables()) return;
  const { data, error } = await _supabase
    .from('favorites')
    .select('venue_id')
    .eq('user_id', _currentUser.id);
  if (error) { console.warn('[auth] loadFavorites failed:', error.message); return; }
  _favoritesSet = new Set((data || []).map(r => r.venue_id));
}

async function toggleFavorite(venueId, evt) {
  if (evt) evt.stopPropagation();
  if (!_currentUser) { toggleProfilePanel(); return; }
  const vid = String(venueId);
  const wasFav = _favoritesSet.has(vid);
  if (typeof _aTrack === 'function') _aTrack('favorite', { venue_id: venueId, action: wasFav ? 'remove' : 'add' });
  if (wasFav) {
    _favoritesSet.delete(vid);
    await _supabase.from('favorites').delete()
      .eq('user_id', _currentUser.id).eq('venue_id', vid);
  } else {
    _favoritesSet.add(vid);
    await _supabase.from('favorites').insert({
      user_id: _currentUser.id, venue_id: vid
    });
  }
  // Re-render UI
  if (typeof renderList === 'function') renderList();
  if (typeof selectedId !== 'undefined' && selectedId != null) {
    const v = typeof VENUES !== 'undefined' && VENUES.find(x => x.id === selectedId);
    if (v && typeof openDetailPanel === 'function') openDetailPanel(v);
  }
}

// ── Sun Alerts ───────────────────────────────────────────────────────────────

let _alertsMap = new Map(); // venueId → alert object

function hasSunAlert(venueId) { return _alertsMap.has(String(venueId)); }

async function loadSunAlerts() {
  if (!_currentUser) { _alertsMap.clear(); return; }
  if (!await _checkSocialTables()) return;
  const { data, error } = await _supabase
    .from('sun_alerts')
    .select('*')
    .eq('user_id', _currentUser.id);
  if (error) { console.warn('[auth] loadSunAlerts failed:', error.message); return; }
  _alertsMap.clear();
  for (const r of (data || [])) _alertsMap.set(r.venue_id, r);
}

async function toggleSunAlert(venueId, evt) {
  if (evt) evt.stopPropagation();
  if (!_currentUser) { toggleProfilePanel(); return; }
  const vid = String(venueId);
  if (typeof _aTrack === 'function') _aTrack('sun_alert', { venue_id: venueId, action: _alertsMap.has(vid) ? 'remove' : 'add' });
  if (_alertsMap.has(vid)) {
    const alert = _alertsMap.get(vid);
    _alertsMap.delete(vid);
    await _supabase.from('sun_alerts').delete().eq('id', alert.id);
    _showToast(t('sun_alert_off'));
  } else {
    // Request notification permission on web
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    const { data, error } = await _supabase.from('sun_alerts').insert({
      user_id: _currentUser.id, venue_id: vid
    }).select().single();
    if (!error && data) _alertsMap.set(vid, data);
    _showToast(t('sun_alert_on'));
  }
  // Re-render detail panel
  if (typeof selectedId !== 'undefined' && selectedId != null) {
    const v = typeof VENUES !== 'undefined' && VENUES.find(x => x.id === selectedId);
    if (v && typeof openDetailPanel === 'function') openDetailPanel(v);
  }
}

function _showToast(msg) {
  // Always use the simple fixed-position toast for user-triggered feedback
  // (check-in, check-out, etc.) — not the smart notification system.
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2200);
}

// ── User Preferences (Account Sync) ─────────────────────────────────────────

async function loadUserPreferences() {
  if (!_currentUser) return;
  if (!await _checkSocialTables()) return;
  const { data, error } = await _supabase
    .from('user_preferences')
    .select('*')
    .eq('user_id', _currentUser.id)
    .single();
  if (error || !data) return;
  // Cloud overrides local
  if (data.lang && typeof setPrefLang === 'function') {
    localStorage.setItem('pref_lang', data.lang);
    // Don't call setPrefLang to avoid recursive save — just apply
    const inp = document.getElementById('venue-search');
    if (inp) inp.placeholder = typeof t === 'function' ? t('search_placeholder') : '';
  }
  if (data.temp_unit) {
    localStorage.setItem('pref_temp', data.temp_unit);
  }
  if (data.default_area && typeof setAreaFilter === 'function') {
    setAreaFilter(data.default_area);
  }
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
  if (typeof update === 'function') update();
}

async function saveUserPreference(key, value) {
  if (!_currentUser) return;
  const row = { user_id: _currentUser.id, updated_at: new Date().toISOString() };
  row[key] = value;
  await _supabase.from('user_preferences').upsert(row, { onConflict: 'user_id' });
}

function toggleCheckinVisibility(friendId) {
  if (_hiddenCheckinFriends.has(friendId)) {
    _hiddenCheckinFriends.delete(friendId);
  } else {
    _hiddenCheckinFriends.add(friendId);
  }
  localStorage.setItem('hidden_checkin_friends', JSON.stringify([..._hiddenCheckinFriends]));
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
  if (typeof renderList === 'function') renderList();
  if (typeof draw === 'function') draw();
}

// ── Friends ──────────────────────────────────────────────────────────────────

let _friends = [];
let _pendingRequests = [];
let _friendCheckins = new Map(); // venueId → [{ user, checkin }]
let _myCheckin = null; // current user's active checkin
let _hiddenCheckinFriends = new Set(JSON.parse(localStorage.getItem('hidden_checkin_friends') || '[]'));
let _plans = [];
let _planInvites = [];
let _checkinSubscription = null;

async function loadFriends() {
  if (!_currentUser) { _friends = []; _pendingRequests = []; return; }
  if (!await _checkSocialTables()) { _injectDummyFriends(); return; }
  const { data, error } = await _supabase
    .from('friendships')
    .select('*, user:profiles!friendships_user_id_fkey(id, name, email, avatar_url), friend:profiles!friendships_friend_id_fkey(id, name, email, avatar_url)')
    .or(`user_id.eq.${_currentUser.id},friend_id.eq.${_currentUser.id}`);
  if (!error) {
    _friends = [];
    _pendingRequests = [];
    for (const r of (data || [])) {
      if (r.status === 'accepted') {
        const other = r.user_id === _currentUser.id ? r.friend : r.user;
        _friends.push({ ...other, friendshipId: r.id });
      } else if (r.status === 'pending' && r.friend_id === _currentUser.id) {
        _pendingRequests.push({ ...r.user, friendshipId: r.id });
      }
    }
  } else {
    console.warn('[auth] loadFriends failed:', error.message);
  }
  // Always inject dummy friends for test accounts (even if table missing)
  _injectDummyFriends();
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
}

const _DUMMY_FRIENDS = [
  { id: 'dummy-1', name: 'Ingrid Solberg',  email: 'ingrid@example.com',  avatar_url: null, friendshipId: 'df-1' },
  { id: 'dummy-2', name: 'Erik Nordmann',   email: 'erik@example.com',    avatar_url: null, friendshipId: 'df-2' },
  { id: 'dummy-3', name: 'Maja Lindqvist',  email: 'maja@example.com',    avatar_url: null, friendshipId: 'df-3' },
  { id: 'dummy-4', name: 'Olav Henriksen',  email: 'olav@example.com',    avatar_url: null, friendshipId: 'df-4' },
];
const _TEST_EMAILS = ['thogegik@gmail.com', 'thoreriknorbom@gmail.com'];

function _injectDummyFriends() {
  if (!_currentUser || !_TEST_EMAILS.includes(_currentUser.email)) return;
  const existingIds = new Set(_friends.map(f => f.id));
  for (const df of _DUMMY_FRIENDS) {
    if (!existingIds.has(df.id)) _friends.push(df);
  }
}

async function sendFriendRequest(email) {
  if (!_currentUser) { toggleProfilePanel(); return; }
  if (typeof _aTrack === 'function') _aTrack('friend_request_sent', {});
  // Look up user by email
  const { data: profiles, error: lookupErr } = await _supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();
  if (lookupErr || !profiles) return { error: 'User not found' };
  if (profiles.id === _currentUser.id) return { error: 'Cannot add yourself' };
  const { error } = await _supabase.from('friendships').insert({
    user_id: _currentUser.id,
    friend_id: profiles.id
  });
  if (error) return { error: error.message };
  await loadFriends();
  return { success: true };
}

async function acceptFriendRequest(friendshipId) {
  if (typeof _aTrack === 'function') _aTrack('friend_request_accepted', {});
  await _supabase.from('friendships').update({ status: 'accepted' }).eq('id', friendshipId);
  await loadFriends();
}

async function removeFriend(friendshipId) {
  if (typeof _aTrack === 'function') _aTrack('friend_removed', {});
  await _supabase.from('friendships').delete().eq('id', friendshipId);
  await loadFriends();
}

// ── Check-ins ────────────────────────────────────────────────────────────────

async function loadFriendCheckins() {
  if (!_currentUser) { _friendCheckins.clear(); _myCheckin = null; return; }
  _friendCheckins.clear();
  _myCheckin = null;
  if (await _checkSocialTables()) {
    const { data, error } = await _supabase
      .from('checkins')
      .select('*, user:profiles!checkins_user_id_fkey(id, name, email, avatar_url)')
      .gt('expires_at', new Date().toISOString());
    if (!error) {
      for (const c of (data || [])) {
        if (c.user_id === _currentUser.id) { _myCheckin = c; continue; }
        const list = _friendCheckins.get(c.venue_id) || [];
        list.push({ user: c.user, checkin: c });
        _friendCheckins.set(c.venue_id, list);
      }
    } else {
      console.warn('[auth] loadFriendCheckins failed:', error.message);
    }
  }
  // Always inject dummy checkins for test accounts (even if table missing)
  _injectDummyCheckins();
}

function _injectDummyCheckins() {
  if (!_currentUser || !_TEST_EMAILS.includes(_currentUser.email)) return;
  const dummyCheckins = [
    { venueId: '1', friendIdx: 0 }, // Ingrid at Nedre Foss Gård
    { venueId: '2', friendIdx: 1 }, // Erik at Grünerhaven
    { venueId: '2', friendIdx: 2 }, // Maja at Grünerhaven
    { venueId: '5', friendIdx: 3 }, // Olav at Olivia
    { venueId: '8', friendIdx: 0 }, // Ingrid at Prindsen Hage
  ];
  const expires = new Date(Date.now() + 3600_000).toISOString();
  for (const dc of dummyCheckins) {
    const f = _DUMMY_FRIENDS[dc.friendIdx];
    const list = _friendCheckins.get(dc.venueId) || [];
    if (list.some(x => x.user.id === f.id)) continue;
    list.push({
      user: { id: f.id, name: f.name, email: f.email, avatar_url: f.avatar_url },
      checkin: { id: `dc-${dc.venueId}-${f.id}`, venue_id: dc.venueId, user_id: f.id, expires_at: expires }
    });
    _friendCheckins.set(dc.venueId, list);
  }
}

function getFriendCheckinsForVenue(venueId) {
  const all = _friendCheckins.get(String(venueId)) || [];
  if (!_hiddenCheckinFriends.size) return all;
  return all.filter(x => !_hiddenCheckinFriends.has(x.user.id));
}

function getMyCheckin() { return _myCheckin; }

async function checkIn(venueId, message) {
  if (!_currentUser) { toggleProfilePanel(); return; }
  const vid = String(venueId);
  // Remove existing checkin first
  if (_myCheckin) {
    await _supabase.from('checkins').delete().eq('id', _myCheckin.id);
  }
  const { data, error } = await _supabase.from('checkins').insert({
    user_id: _currentUser.id,
    venue_id: vid,
    message: message || ''
  }).select().single();
  if (!error && data) _myCheckin = data;
  await loadFriendCheckins();
  _showToast(t('check_in_success'));
  // Re-render
  if (typeof renderList === 'function') renderList();
  if (typeof draw === 'function') draw();
  if (typeof selectedId !== 'undefined' && selectedId != null) {
    const v = typeof VENUES !== 'undefined' && VENUES.find(x => x.id === selectedId);
    if (v && typeof openDetailPanel === 'function') openDetailPanel(v);
  }
}

async function checkOut() {
  if (!_currentUser || !_myCheckin) return;
  await _supabase.from('checkins').delete().eq('id', _myCheckin.id);
  _myCheckin = null;
  await loadFriendCheckins();
  _showToast(t('check_out_success'));
  if (typeof renderList === 'function') renderList();
  if (typeof draw === 'function') draw();
  if (typeof selectedId !== 'undefined' && selectedId != null) {
    const v = typeof VENUES !== 'undefined' && VENUES.find(x => x.id === selectedId);
    if (v && typeof openDetailPanel === 'function') openDetailPanel(v);
  }
}

function _subscribeToCheckins() {
  if (_checkinSubscription) _checkinSubscription.unsubscribe();
  if (!_currentUser) return;
  _checkinSubscription = _supabase
    .channel('checkins-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checkins' }, () => {
      loadFriendCheckins().then(() => {
        if (typeof renderList === 'function') renderList();
        if (typeof draw === 'function') draw();
      });
    })
    .subscribe();
}

// ── Plans ────────────────────────────────────────────────────────────────────

async function loadPlans() {
  if (!_currentUser) { _plans = []; _planInvites = []; return; }
  if (!await _checkSocialTables()) return;
  const { data: plans, error: pe } = await _supabase
    .from('plans')
    .select('*, creator:profiles!plans_creator_id_fkey(id, name, email, avatar_url)')
    .or(`creator_id.eq.${_currentUser.id}`)
    .gt('planned_at', new Date().toISOString())
    .order('planned_at', { ascending: true });
  if (!pe) _plans = plans || [];

  // For plans the user created, also pull invitee statuses (for status pips +
  // the "your invite was accepted" notification evaluator).
  if (_plans.length) {
    const ownPlanIds = _plans.filter(p => p.creator_id === _currentUser.id).map(p => p.id);
    if (ownPlanIds.length) {
      const { data: ownInvites } = await _supabase
        .from('plan_invites')
        .select('*, user:profiles!plan_invites_user_id_fkey(id, name, email, avatar_url)')
        .in('plan_id', ownPlanIds);
      if (ownInvites) {
        const byPlan = new Map();
        for (const inv of ownInvites) {
          if (!byPlan.has(inv.plan_id)) byPlan.set(inv.plan_id, []);
          byPlan.get(inv.plan_id).push(inv);
        }
        for (const p of _plans) {
          p._invitees = byPlan.get(p.id) || [];
        }
      }
    }
  }

  const { data: invites, error: ie } = await _supabase
    .from('plan_invites')
    .select('*, plan:plans(*, creator:profiles!plans_creator_id_fkey(id, name, email, avatar_url))')
    .eq('user_id', _currentUser.id);
  if (!ie) _planInvites = (invites || []).filter(i => i.plan && new Date(i.plan.planned_at) > new Date());
}

async function createPlan(venueId, plannedAt, message, friendIds) {
  if (!_currentUser) { toggleProfilePanel(); return; }
  if (typeof _aTrack === 'function') _aTrack('plan_created', { venue_id: venueId, invites: friendIds?.length ?? 0 });
  const { data: plan, error } = await _supabase.from('plans').insert({
    creator_id: _currentUser.id,
    venue_id: String(venueId),
    planned_at: plannedAt,
    message: message || ''
  }).select().single();
  if (error || !plan) return { error: error?.message || 'Failed to create plan' };
  // Create invites
  if (friendIds && friendIds.length) {
    const invites = friendIds.map(fid => ({ plan_id: plan.id, user_id: fid }));
    await _supabase.from('plan_invites').insert(invites);
  }
  await loadPlans();
  _showToast(t('plan_created'));
  return { success: true, plan };
}

async function respondToPlanInvite(inviteId, status) {
  if (typeof _aTrack === 'function') _aTrack('plan_invite_response', { status });
  await _supabase.from('plan_invites').update({ status }).eq('id', inviteId);
  await loadPlans();
}

function getPlansForVenue(venueId) {
  const vid = String(venueId);
  const fromPlans = _plans.filter(p => p.venue_id === vid);
  const fromInvites = _planInvites.filter(i => i.plan?.venue_id === vid).map(i => ({ ...i.plan, _invite: i }));
  // Deduplicate
  const seen = new Set(fromPlans.map(p => p.id));
  for (const p of fromInvites) { if (!seen.has(p.id)) { fromPlans.push(p); seen.add(p.id); } }
  return fromPlans;
}

/**
 * Friends going to this venue on the given date — derived from plans the user
 * can already see (own plans where friends accepted, or plans the user was
 * invited to where the creator is a friend). RLS limits visibility to plans
 * the user is involved in, so this is an under-count, not a complete picture.
 *
 * Returns: [{ user: {id, name, email, avatar_url}, status: 'accepted'|'creator' }]
 */
function getGoingFriendsForVenue(venueId, dateStr) {
  if (!_currentUser) return [];
  const vid = String(venueId);
  const sameDate = (iso) => typeof iso === 'string' && iso.slice(0, 10) === dateStr;
  const result = new Map();

  // Plans I created — include accepted invitees (these are by definition friends I invited)
  if (Array.isArray(_plans)) {
    for (const p of _plans) {
      if (String(p.venue_id) !== vid) continue;
      if (!sameDate(p.planned_at)) continue;
      if (!Array.isArray(p._invitees)) continue;
      for (const inv of p._invitees) {
        if (inv.status !== 'accepted' || !inv.user) continue;
        if (inv.user.id === _currentUser.id) continue;
        result.set(inv.user.id, { user: inv.user, status: 'accepted' });
      }
    }
  }
  // Plans I'm invited to — surface the creator (likely a friend, since they invited me)
  if (Array.isArray(_planInvites)) {
    for (const i of _planInvites) {
      const p = i.plan;
      if (!p || String(p.venue_id) !== vid) continue;
      if (!sameDate(p.planned_at)) continue;
      if (!p.creator || p.creator.id === _currentUser.id) continue;
      if (!result.has(p.creator.id)) {
        result.set(p.creator.id, { user: p.creator, status: 'creator' });
      }
    }
  }
  return Array.from(result.values());
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
  if (!wasLoggedIn && _currentUser && typeof _aTrack === 'function') {
    const provider = _currentUser.app_metadata?.provider ?? 'unknown';
    _aTrack(event === 'SIGNED_IN' ? 'login' : 'signup', {
      provider,
      method: provider === 'email' ? 'magic_link' : 'oauth',
    });
  }
  if (_currentUser) {
    authLoadRole();
    loadFavorites().then(() => { if (typeof renderList === 'function') renderList(); });
    loadSunAlerts();
    loadUserPreferences();
    loadFriends();
    loadFriendCheckins().then(() => {
      if (typeof renderList === 'function') renderList();
      if (typeof draw === 'function') draw();
    });
    loadPlans();
    loadOwnSuggestions();
    _subscribeToCheckins();
  } else {
    _currentRole = null;
    _favoritesSet.clear();
    _alertsMap.clear();
    _friends = []; _pendingRequests = [];
    _friendCheckins.clear(); _myCheckin = null;
    _plans = []; _planInvites = [];
    if (_checkinSubscription) { _checkinSubscription.unsubscribe(); _checkinSubscription = null; }
  }

  // After login: re-open the detail panel for the selected venue
  if (!wasLoggedIn && _currentUser && typeof selectedId !== 'undefined' && selectedId) {
    const v = typeof VENUES !== 'undefined' && VENUES.find(x => x.id === selectedId);
    if (v && typeof openDetailPanel === 'function') openDetailPanel(v);
  }

  // After sign-out: close the detail panel
  if (wasLoggedIn && !_currentUser && typeof closeDetailPanel === 'function') {
    closeDetailPanel();
  }

  // Re-evaluate notifications on auth change (login unlocks social, logout unlocks login prompts)
  if (typeof _notifEvaluate === 'function') setTimeout(_notifEvaluate, 1000);
});
