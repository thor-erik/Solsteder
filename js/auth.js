// ── Supabase auth ──────────────────────────────────────────────────────────────

const SUPABASE_URL      = 'https://wxalqodaeqgzahwlovnw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let _currentUser = null;
let _currentRole = null; // 'user' | 'editor' | 'admin' | null
let _profilePanelView = 'settings';
// View states: 'settings' | 'activity' | 'visibility' | 'notif-types'
//            | 'admin-edits' | 'admin-suggestions' | 'admin-users'

// Module-level caches for admin sub-views — survive the slide-animation
// re-render that fires inside _slideProfileView at transitionend.
// Each: null = not yet loaded; {error} = fetch failed; array = loaded items.
let _adminEditsCache       = null;
let _adminSuggestionsCache = null;
let _adminUsersCache       = null;

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
  // Mirror user_metadata.{name, avatar_url} into the profiles row so
  // other users see this person's name + avatar when they show up as
  // an attendee or friend. Fire-and-forget: avatar_url column may not
  // exist yet, in which case Supabase rejects the update — that's why
  // we patch only the columns we know are there (name) and treat any
  // avatar update as best-effort. Requires the one-time SQL migration:
  //   alter table public.profiles add column if not exists avatar_url text;
  _syncProfileFromUserMetadata().catch(() => {});
}

/** Patch the current user's profile row with their auth user_metadata
 *  so friends/attendees show their proper name and avatar everywhere.
 *  Runs on every auth load. Idempotent. */
async function _syncProfileFromUserMetadata() {
  if (!_currentUser) return;
  const meta = _currentUser.user_metadata || {};
  const patch = {};
  const fullName = meta.full_name || meta.name || meta.preferred_username || null;
  if (fullName) patch.name = fullName;
  if (meta.avatar_url) patch.avatar_url = meta.avatar_url;
  if (!Object.keys(patch).length) return;
  await _supabase.from('profiles').update(patch).eq('id', _currentUser.id);
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

// Snapshot enough of the current view to land the user back where they were
// after auth completes. Read by _restorePreAuthState() in app.js.
function _captureAuthRestoreState() {
  return {
    date:    typeof datePicker   !== 'undefined' ? datePicker.value             : null,
    time:    typeof timeFromEl   !== 'undefined' ? parseFloat(timeFromEl.value) : null,
    nowMode: typeof nowMode      !== 'undefined' ? nowMode                      : false,
    venueId: typeof selectedId   !== 'undefined' ? selectedId                   : null,
    area:    typeof activeArea   !== 'undefined' ? activeArea                   : '',
    sortBy:  typeof activeSortBy !== 'undefined' ? activeSortBy                 : 'distance',
    panel:   document.getElementById('panel')?.className || '',
    // Capture the post-login intent (set by surfaces that need auth, e.g.
    // _openInviteSheet stashing 'reopen the invite sheet for this venue'
    // when an anon user tries to invite). _restorePreAuthState replays it
    // after the date/time/venue have been restored.
    intent:  (typeof window !== 'undefined') ? window._postLoginIntent : null,
    savedAt: Date.now(),
  };
}

async function authSignInWithGoogle() {
  try {
    sessionStorage.setItem('solsteder_auth_restore', JSON.stringify(_captureAuthRestoreState()));
  } catch (_) {}
  await _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin }
  });
}

async function authSignInWithApple() {
  try {
    sessionStorage.setItem('solsteder_auth_restore', JSON.stringify(_captureAuthRestoreState()));
  } catch (_) {}
  await _supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: window.location.origin }
  });
}

async function authSignInWithMagicLink(email) {
  // Magic-link clicks usually land in a fresh tab where sessionStorage is
  // empty, so persist to localStorage. _restorePreAuthState() enforces a TTL.
  try {
    localStorage.setItem('solsteder_auth_restore', JSON.stringify(_captureAuthRestoreState()));
  } catch (_) {}
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
  const tsBtn = document.getElementById('ts-avatar-btn');
  if (!btn && !tsBtn) return;
  let html;
  if (_currentUser) {
    const avatar = _currentUser.user_metadata?.avatar_url;
    const name   = _currentUser.user_metadata?.name ?? _currentUser.email ?? '';
    const initial = (name[0] || '?').toUpperCase();
    // referrerpolicy=no-referrer: Google avatar CDN blocks requests with
    // a different-origin referrer header. onerror: swap to initials if
    // the image fails to load (CORS, 404, network drop).
    html = avatar
      ? `<img src="${avatar}" alt="${name}" referrerpolicy="no-referrer"
              onerror="this.outerHTML='&lt;div class=&quot;profile-initials&quot;&gt;${initial}&lt;/div&gt;'">`
      : `<div class="profile-initials">${initial}</div>`;
  } else {
    html = `<div class="profile-anon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
    </div>`;
  }
  if (btn) btn.innerHTML = html;
  if (tsBtn) tsBtn.innerHTML = html;
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
  const friendReqs = (typeof _pendingRequests !== 'undefined' && Array.isArray(_pendingRequests))
    ? _pendingRequests : [];
  if (!pending.length && !ownUpcoming.length && !friendReqs.length) return '';

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

  // Friend requests at the top — same affordances as the Friends modal
  // (Accept + reject ✕), but inline so the user can resolve everything
  // from one screen.
  let friendReqHtml = '';
  if (friendReqs.length) {
    friendReqHtml = `
      <div class="profile-section-label">${t('friend_requests')} (${friendReqs.length})</div>
      ${friendReqs.map(r => {
        const label = (r.name || r.email || '').toString().replace(/'/g, "\\'");
        return `<div class="inbox-row">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${r.name || r.email}</div>
          </div>
          <div class="inbox-row-actions">
            <button class="inbox-btn inbox-btn-accept"
                    onclick="_handleAcceptFriendRequest('${r.friendshipId}');_renderProfilePanel?.();">
              ${t('plan_accept')}
            </button>
            <button class="inbox-btn inbox-btn-decline"
                    onclick="_handleRejectFriendRequest('${r.friendshipId}');_renderProfilePanel?.();">
              ${t('plan_decline')}
            </button>
          </div>
        </div>`;
      }).join('')}`;
  }

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
                    onclick="_handleInboxResponse('${inv.id}','accepted', this)">
              ${t('plan_accept')}
            </button>
            <button class="inbox-btn inbox-btn-decline"
                    onclick="_handleInboxResponse('${inv.id}','declined', this)">
              ${t('plan_decline')}
            </button>
          </div>
        </div>`;
      }).join('')}`;
  }

  let yoursHtml = '';
  if (ownUpcoming.length) {
    // Compact "off-plan-time" summary for the host: who's coming at a different
    // hour, or how many are. Read off plan_invites.arrival_time which we now
    // load via SELECT * in loadPlans.
    const fmtH = (iso) => {
      try {
        const d = new Date(iso);
        const h = d.getHours() + d.getMinutes() / 60;
        return (typeof formatHour === 'function')
          ? formatHour(h)
          : `${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      } catch { return ''; }
    };
    yoursHtml = `
      <div class="profile-section-label profile-section-label-sub">${t('your_plans_label')}</div>
      ${ownUpcoming.map(p => {
        const vName = venueName(p.venue_id);
        const accepted = (p._invitees || []).filter(i => i.status === 'accepted').length;
        const total    = (p._invitees || []).length;
        const ratio = total ? `${accepted}/${total}` : '';
        // Spread of off-plan arrivals: "Maja 14:00 · Olav 14:30"
        const planMs = p.planned_at ? new Date(p.planned_at).getTime() : null;
        const offPlan = (p._invitees || [])
          .filter(i => i.status === 'accepted' && i.arrival_time && planMs &&
                       Math.abs(new Date(i.arrival_time).getTime() - planMs) >= 5 * 60 * 1000)
          .map(i => {
            const n = (i.user && (i.user.name || i.user.email)) || '';
            const first = n.split(' ')[0].split('@')[0];
            return first ? `${first} ${fmtH(i.arrival_time)}` : fmtH(i.arrival_time);
          });
        const offPlanLine = offPlan.length
          ? `<div class="inbox-row-arrivals">${offPlan.slice(0, 3).join(' · ')}${offPlan.length > 3 ? ` +${offPlan.length - 3}` : ''}</div>`
          : '';
        return `<div class="inbox-row">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${vName}</div>
            <div class="inbox-row-meta">${fmt(p.planned_at)}${ratio ? ` · ${ratio} ✓` : ''}</div>
            ${offPlanLine}
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

  // Recent responses on the user's own plans — flatten every accepted /
  // declined invitee into a single sorted list so the host doesn't need
  // to drill into each plan to see who's said what. Sort key is the
  // plan's planned_at descending (upcoming first; near-past last) since
  // plan_invites has no per-row updated_at to use as a recency anchor.
  let responsesHtml = '';
  const responses = [];
  for (const p of ownUpcoming) {
    if (!Array.isArray(p._invitees)) continue;
    for (const inv of p._invitees) {
      if (inv.status !== 'accepted' && inv.status !== 'declined') continue;
      const u = inv.user || {};
      const displayName = (u.name || u.email || '').split('@')[0]
        || (typeof t === 'function' ? t('attendee_someone') : 'Someone');
      responses.push({ plan: p, invitee: inv, name: displayName });
    }
  }
  if (responses.length) {
    responses.sort((a, b) => new Date(b.plan.planned_at) - new Date(a.plan.planned_at));
    const top = responses.slice(0, 6);
    responsesHtml = `
      <div class="profile-section-label profile-section-label-sub">${t('recent_responses_label')}</div>
      ${top.map(r => {
        const vName = venueName(r.plan.venue_id);
        const statusKey = r.invitee.status === 'accepted' ? 'response_said_yes' : 'response_said_no';
        const statusLabel = t(statusKey, { name: r.name, venue: vName });
        return `<div class="inbox-row inbox-row-compact">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${statusLabel}</div>
            <div class="inbox-row-meta">${fmt(r.plan.planned_at)}</div>
          </div>
        </div>`;
      }).join('')}`;
  }

  return `
    <div class="profile-panel-section invitations-section">
      ${friendReqHtml}
      ${pendingHtml}
      ${yoursHtml}
      ${responsesHtml}
    </div>`;
}

function _setProfilePanelView(view) {
  const panel = document.getElementById('profile-panel');
  if (!panel) return;
  const prev = _profilePanelView;
  if (prev === view) return;

  _profilePanelView = view;

  // iOS-Settings-style slide: drilling INTO a sub-view from 'settings'
  // slides left; going back FROM a sub-view to 'settings' slides right.
  // Sibling-to-sibling sub-view moves are rare; we just swap.
  const ROOT = 'settings';
  const drillingIn = (prev === ROOT && view !== ROOT);
  const goingBack  = (view === ROOT && prev !== ROOT);

  if (!drillingIn && !goingBack) {
    _renderProfilePanel();
    return;
  }
  _slideProfileView(prev, view, drillingIn);
}

function _renderProfileViewByName(view) {
  switch (view) {
    case 'activity':           return _renderActivityView();
    case 'visibility':         return _renderVisibilityView();
    case 'notif-types':        return _renderNotifTypesView();
    case 'admin-edits':        return _renderAdminEditsView();
    case 'admin-suggestions':  return _renderAdminSuggestionsView();
    case 'admin-users':        return _renderAdminUsersView();
    case 'settings':
    default:                   return _renderSettingsView();
  }
}

function _slideProfileView(fromView, toView, drillingIn) {
  const panel = document.getElementById('profile-panel');
  if (!panel) { _renderProfilePanel(); return; }

  const fromHtml = _renderProfileViewByName(fromView);
  const toHtml   = _renderProfileViewByName(toView);

  // Lay out both pages in a 2-page horizontal track. For drillingIn: from
  // is left, to is right — animate translateX 0 → -50%. For goingBack:
  // to is left, from is right — animate -50% → 0.
  const leftHtml  = drillingIn ? fromHtml : toHtml;
  const rightHtml = drillingIn ? toHtml   : fromHtml;

  panel.innerHTML = `
    <div class="profile-pages">
      <div class="profile-page">${leftHtml}</div>
      <div class="profile-page">${rightHtml}</div>
    </div>
  `;

  const pages = panel.querySelector('.profile-pages');
  if (!pages) { _renderProfilePanel(); return; }

  // Initial transform (no transition yet)
  pages.style.transition = 'none';
  pages.style.transform  = drillingIn ? 'translateX(0)' : 'translateX(-50%)';
  // Force layout so the next frame's transform actually animates
  // eslint-disable-next-line no-unused-expressions
  pages.offsetWidth;

  // Animate to final transform
  pages.style.transition = 'transform 280ms cubic-bezier(0.25, 0.9, 0.4, 1)';
  pages.style.transform  = drillingIn ? 'translateX(-50%)' : 'translateX(0)';

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    pages.removeEventListener('transitionend', cleanup);
    // Re-render in the canonical un-wrapped layout
    _renderProfilePanel();
  };
  pages.addEventListener('transitionend', cleanup);
  // Safety net in case transitionend doesn't fire (interrupted, hidden, etc.)
  setTimeout(cleanup, 360);
}

// ── Settings view (root) ─────────────────────────────────────────────────────

const _SETTINGS_ICON = {
  back:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  external:'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  inbox:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  edit:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  plus:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
  users:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  eye:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  bell:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  search:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
  help:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  shield:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  info:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  signout: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  review:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

function _activityCount() {
  const reqs   = (typeof _pendingRequests !== 'undefined') ? _pendingRequests.length : 0;
  const invs   = (typeof _planInvites !== 'undefined')
    ? _planInvites.filter(i => i.status === 'pending' && i.plan).length
    : 0;
  const plans  = (typeof _plans !== 'undefined')
    ? _plans.filter(p => p && p.creator_id === (_currentUser && _currentUser.id)).length
    : 0;
  // Plans don't carry a "needs attention" semantic; only count requests + invites.
  return reqs + invs + plans;
}

function _renderSettingsMobileBar(title, backHandler) {
  return `<div class="profile-panel-mobile-bar">
    <button class="profile-panel-mobile-back" onclick="${backHandler}" aria-label="${t('back')}">
      ${_SETTINGS_ICON.back}
    </button>
    <span class="profile-panel-mobile-title">${title}</span>
  </div>`;
}

function _renderSettingsView() {
  const avatar   = _currentUser.user_metadata?.avatar_url;
  const name     = _currentUser.user_metadata?.name ?? '';
  const email    = _currentUser.email ?? '';
  // Apple ID's private email relay generates @privaterelay.appleid.com
  // addresses that are opaque tokens — surfacing them as 'your email'
  // confuses users who don't recognise the format. Show a 'Signed in
  // with Apple' label in its place. User-reported: 'her email is
  // *@privaterelay.appleid.com, should we not just say signed in with
  // Apple?'.
  const isAppleRelay = /@privaterelay\.appleid\.com$/i.test(email);
  const emailLabel = isAppleRelay ? t('signed_in_with_apple') : email;
  const lang     = typeof prefLang     === 'function' ? prefLang()     : 'no';
  const tempUnit = typeof prefTempUnit === 'function' ? prefTempUnit() : 'C';

  const initial = ((name || email)[0] || '?').toUpperCase();
  // referrerpolicy + onerror — same reasoning as _updateUserIndicator.
  // Without these, a CORS-blocked Google OAuth avatar URL renders a blank
  // 72px circle with the halo glow but nothing inside — looks like "the
  // avatar disappeared" even though the hero itself is on screen.
  const avatarHtml = avatar
    ? `<img class="settings-identity__avatar" src="${avatar}" alt="${name}"
            referrerpolicy="no-referrer"
            onerror="this.outerHTML='&lt;div class=&quot;settings-identity__avatar-initials&quot;&gt;${initial}&lt;/div&gt;'">`
    : `<div class="settings-identity__avatar-initials">${initial}</div>`;

  const roleBadge = _currentRole === 'admin'
    ? `<span class="profile-role-badge admin">Admin</span>`
    : _currentRole === 'editor'
    ? `<span class="profile-role-badge editor">Editor</span>`
    : '';

  const activityCount = _activityCount();
  const activityEntry = activityCount > 0
    ? `<button class="settings-row" onclick="_setProfilePanelView('activity')">
         <span class="settings-row__icon">${_SETTINGS_ICON.inbox}</span>
         <span class="settings-row__label">${t('activity')}</span>
         <span class="pending-badge">${activityCount}</span>
         <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
       </button>`
    : '';

  const friendsCount = _friends.length;
  const friendsLabel = friendsCount > 0 ? `${t('friends')} (${friendsCount})` : t('friends');

  const adminGroup = authIsAdmin() ? `
    <div>
      <div class="settings-group-label">${t('settings_section_admin')}</div>
      <div class="settings-group">
        <button class="settings-row" onclick="openAdminReviewPanel()">
          <span class="settings-row__icon">${_SETTINGS_ICON.edit}</span>
          <span class="settings-row__label">${t('pending_edits')}</span>
          <span id="pending-count-badge" class="pending-badge" style="display:none">…</span>
          <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
        </button>
        <button class="settings-row" onclick="openAdminVenueSuggestionsPanel()">
          <span class="settings-row__icon">${_SETTINGS_ICON.plus}</span>
          <span class="settings-row__label">${t('admin_venue_suggestions')}</span>
          <span id="venue-suggestions-count-badge" class="pending-badge" style="display:none">…</span>
          <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
        </button>
        <button class="settings-row" onclick="openRoleManagerPanel()">
          <span class="settings-row__icon">${_SETTINGS_ICON.users}</span>
          <span class="settings-row__label">${t('manage_users')}</span>
          <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
        </button>
        <button class="settings-row" onclick="toggleAuditMode();closeProfilePanel()">
          <span class="settings-row__icon">${_SETTINGS_ICON.eye}</span>
          <span class="settings-row__label">Audit polygons</span>
          <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
        </button>
        <button class="settings-row" id="debug-row" onclick="toggleZoomDebugHelper()">
          <span class="settings-row__icon">${_SETTINGS_ICON.search}</span>
          <span id="zoom-debug-toggle-label" class="settings-row__label">Show Debug</span>
        </button>
      </div>
    </div>` : '';

  // ── "Din aktivitet" section — activity events + social state ──────────
  let aktivitetRows = '';
  if (activityCount > 0) {
    aktivitetRows += `<button class="settings-row" onclick="_setProfilePanelView('activity')">
      <span class="settings-row__icon">${_SETTINGS_ICON.inbox}</span>
      <span class="settings-row__label">${t('activity')}</span>
      <span class="pending-badge">${activityCount}</span>
      <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
    </button>`;
  }
  aktivitetRows += `<button class="settings-row" onclick="openFriendsModal()">
    <span class="settings-row__icon">${_SETTINGS_ICON.users}</span>
    <span class="settings-row__label">${friendsLabel}</span>
    ${_pendingRequests.length ? `<span class="pending-badge">${_pendingRequests.length}</span>` : ''}
    <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
  </button>`;
  if (_friends.length) {
    aktivitetRows += `<button class="settings-row" onclick="_setProfilePanelView('visibility')">
      <span class="settings-row__icon">${_SETTINGS_ICON.eye}</span>
      <span class="settings-row__label">${t('visibility_drill')}</span>
      <span class="settings-row__chevron">${_SETTINGS_ICON.chevron}</span>
    </button>`;
  }

  return `
    ${_renderSettingsMobileBar(t('settings'), 'closeProfilePanel()')}
    <div class="settings-root">

      <div class="settings-group settings-identity-group">
        <div class="settings-identity" style="cursor:default">
          ${avatarHtml}
          <div class="settings-identity__info">
            <div class="settings-identity__name">${name || emailLabel} ${roleBadge}</div>
            ${name ? `<div class="settings-identity__email">${emailLabel}</div>` : ''}
          </div>
        </div>
      </div>

      <div>
        <div class="settings-group-label">Din aktivitet</div>
        <div class="settings-group">${aktivitetRows}</div>
      </div>

      <div>
        <div class="settings-group-label">Innstillinger</div>
        <div class="settings-group">
          <div class="settings-row pref-row">
            <span class="settings-row__label">${t('language')}</span>
            <div class="profile-pref-pills">
              <button class="pref-pill${lang === 'en' ? ' active' : ''}" onclick="setPrefLang('en')">EN</button>
              <button class="pref-pill${lang === 'no' ? ' active' : ''}" onclick="setPrefLang('no')">NO</button>
              <button class="pref-pill${lang === 'se' ? ' active' : ''}" onclick="setPrefLang('se')">SE</button>
              <button class="pref-pill${lang === 'dk' ? ' active' : ''}" onclick="setPrefLang('dk')">DK</button>
            </div>
          </div>
          <div class="settings-row pref-row">
            <span class="settings-row__label">${t('temperature')}</span>
            <div class="profile-pref-pills">
              <button class="pref-pill${tempUnit === 'C' ? ' active' : ''}" onclick="setPrefTempUnit('C')">°C</button>
              <button class="pref-pill${tempUnit === 'F' ? ' active' : ''}" onclick="setPrefTempUnit('F')">°F</button>
            </div>
          </div>
        </div>
      </div>

      ${typeof _notifSettingsHtml === 'function' ? _notifSettingsHtml() : ''}

      ${adminGroup}

      <div id="my-suggestions-section" style="display:none">
        <div class="settings-group-label">${t('my_suggestions')}</div>
        <div class="settings-group">
          <div id="my-suggestions-list" style="color:var(--muted);font-size:12px;padding:12px 14px">${t('no_suggestions_yet')}</div>
        </div>
      </div>

      <div>
        <div class="settings-group-label">${t('settings_section_about')}</div>
        <div class="settings-group">
          <a class="settings-row" href="mailto:hello@findshades.app?subject=Solsteder%20feedback" style="text-decoration:none">
            <span class="settings-row__icon">${_SETTINGS_ICON.help}</span>
            <span class="settings-row__label">${t('help_feedback')}</span>
            <span class="settings-row__chevron">${_SETTINGS_ICON.external}</span>
          </a>
          <a class="settings-row" href="privacy.html" target="_blank" rel="noopener" style="text-decoration:none">
            <span class="settings-row__icon">${_SETTINGS_ICON.shield}</span>
            <span class="settings-row__label">${t('privacy_policy')}</span>
            <span class="settings-row__chevron">${_SETTINGS_ICON.external}</span>
          </a>
          <button class="settings-row" id="about-row" onclick="_handleAboutTap()">
            <span class="settings-row__icon">${_SETTINGS_ICON.info}</span>
            <span class="settings-row__label">${t('about_app')}</span>
            <span class="settings-row__value" id="about-version">v1.0.0</span>
          </button>
        </div>
      </div>

      <div>
        <div class="settings-group-label">${t('settings_section_account')}</div>
        <div class="settings-group">
          <button class="settings-row destructive" onclick="authSignOut();closeProfilePanel()">
            <span class="settings-row__icon">${_SETTINGS_ICON.signout}</span>
            <span class="settings-row__label">${t('signout')}</span>
          </button>
        </div>
      </div>

    </div>
  `;
}

// ── Activity sub-view ────────────────────────────────────────────────────────

function _renderActivityView() {
  const body = _renderInvitationsSection()
    || `<div class="settings-subview__empty">${t('activity_empty')}</div>`;

  return `
    ${_renderSettingsMobileBar(t('activity'), "_setProfilePanelView('settings')")}
    <div class="settings-subview">${body}</div>
  `;
}

// ── Per-friend visibility sub-view ───────────────────────────────────────────

function _renderVisibilityView() {
  const rows = _friends.map(f => {
    const visible = !_hiddenCheckinFriends.has(f.id);
    return `<div class="settings-row pref-row">
      <span class="settings-row__label">${f.name || f.email}</span>
      <button class="toggle-switch${visible ? ' is-on' : ''}"
              role="switch" aria-checked="${visible}"
              aria-label="${f.name || f.email}"
              onclick="toggleCheckinVisibility('${f.id}')"></button>
    </div>`;
  }).join('');

  const body = _friends.length
    ? `<div>
         <div class="settings-group-label">${t('checkin_visibility_desc')}</div>
         <div class="settings-group">${rows}</div>
       </div>`
    : `<div class="settings-subview__empty">${t('no_suggestions_yet')}</div>`;

  return `
    ${_renderSettingsMobileBar(t('visibility_drill'), "_setProfilePanelView('settings')")}
    <div class="settings-subview">${body}</div>
  `;
}

// ── Notification types sub-view (Stage 4b-3) ─────────────────────────────────
// Reached via the Varslingstyper drill-in row in the Innstillinger section.
// Hosts the per-category toggles that used to live flat on the main view —
// scales for future categories without bloating the main sheet.

function _renderNotifTypesView() {
  const settings = (typeof _notifGetSettings === 'function') ? _notifGetSettings() : {};
  const categories = [
    { key: 'weather',    labelKey: 'notif_cat_weather' },
    { key: 'social',     labelKey: 'notif_cat_social' },
    { key: 'suggestion', labelKey: 'notif_cat_suggestion' },
  ];
  const rows = categories.map(cat => {
    const on = settings[cat.key] !== false;
    return `<div class="settings-row pref-row">
      <span class="settings-row__label">${t(cat.labelKey)}</span>
      <button class="toggle-switch${on ? ' is-on' : ''}"
              role="switch" aria-checked="${on}"
              aria-label="${t(cat.labelKey)}"
              onclick="_notifToggle('${cat.key}')"></button>
    </div>`;
  }).join('');

  return `
    ${_renderSettingsMobileBar('Varslingstyper', "_setProfilePanelView('settings')")}
    <div class="settings-subview">
      <div class="settings-group">${rows}</div>
    </div>
  `;
}

// ── Admin sub-views — render the same content the old modals used, but
//    wrapped in the sheet sub-view shell. Body IDs match the originals so
//    the existing approve/reject/loaded-list code keeps working unchanged.
//    Data is cached at module scope so the slide-animation re-render
//    (which fires after transitionend) doesn't wipe the loaded items.

function _renderAdminEditsView() {
  let body;
  if (_adminEditsCache === null) {
    body = `<div class="settings-subview__loading" style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center">Laster…</div>`;
  } else if (_adminEditsCache.error) {
    const msg = _adminEditsCache.error.code === '42P01'
      ? 'pending_edits table not set up yet.'
      : 'Feil ved lasting.';
    body = `<div class="settings-subview__empty">${msg}</div>`;
  } else if (!_adminEditsCache.length) {
    body = `<div class="settings-subview__empty">Ingen ventende endringer.</div>`;
  } else {
    body = _adminEditsCache.map(e => {
      const before = e.before_state ?? {};
      const after  = e.after_state  ?? {};
      const changes = Object.keys(after).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      const diffHtml = changes.map(k =>
        `<div class="admin-diff-row"><span class="admin-diff-key">${k}</span>
         <span class="admin-diff-before">${JSON.stringify(before[k])}</span>
         <span class="admin-diff-arrow">→</span>
         <span class="admin-diff-after">${JSON.stringify(after[k])}</span></div>`
      ).join('');
      return `<div class="admin-edit-card" id="admin-edit-${e.id}">
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

  return `
    ${_renderSettingsMobileBar('Ventende forslag', "_setProfilePanelView('settings')")}
    <div class="settings-subview admin-subview">
      <div id="admin-review-body">${body}</div>
    </div>
  `;
}

function _renderAdminSuggestionsView() {
  let body;
  if (_adminSuggestionsCache === null) {
    body = `<div class="settings-subview__loading" style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center">Laster…</div>`;
  } else if (_adminSuggestionsCache.error) {
    body = `<div class="settings-subview__empty">Feil ved lasting.</div>`;
  } else if (!_adminSuggestionsCache.length) {
    body = `<div class="settings-subview__empty">Ingen ventende stedforslag.</div>`;
  } else {
    body = _adminSuggestionsCache.map(s => `
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

  return `
    ${_renderSettingsMobileBar(t('admin_venue_suggestions'), "_setProfilePanelView('settings')")}
    <div class="settings-subview admin-subview">
      <div id="venue-suggestions-body">${body}</div>
    </div>
  `;
}

function _renderAdminUsersView() {
  let listHtml;
  if (_adminUsersCache === null) {
    listHtml = 'Laster…';
  } else if (_adminUsersCache.error) {
    listHtml = '<div style="font-size:12px;color:#ff6b6b">Feil ved lasting.</div>';
  } else if (!_adminUsersCache.length) {
    listHtml = '<div style="font-size:12px;color:var(--muted)">Ingen forhøyede brukere ennå.</div>';
  } else {
    listHtml = _adminUsersCache.map(u => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <div><div style="font-size:13px;color:var(--text)">${u.name ?? u.email}</div><div style="font-size:11px;color:var(--muted)">${u.email}</div></div>
      <span class="profile-role-badge ${u.role}">${u.role}</span>
    </div>`).join('');
  }

  return `
    ${_renderSettingsMobileBar('Administrer brukere', "_setProfilePanelView('settings')")}
    <div class="settings-subview admin-subview">
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
          background:var(--accent-dim);border:1px solid var(--accent-border, rgba(245,194,94,0.42));
          border-radius:8px;color:var(--accent);font-family:'Inter',sans-serif;
          font-size:13px;font-weight:600;padding:10px;cursor:pointer;">
          Oppdater rolle
        </button>
        <div id="role-manager-result" style="margin-top:10px;font-size:12px;min-height:18px;text-align:center"></div>
      </div>
      <div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Alle brukere med forhøyet tilgang</div>
        <div id="role-manager-list">${listHtml}</div>
      </div>
    </div>
  `;
}

// ── About row tap handler — 5 taps reveals Show Debug ────────────────────────

let _aboutTapCount = 0;
let _aboutTapTimer = null;
function _handleAboutTap() {
  _aboutTapCount++;
  if (_aboutTapTimer) clearTimeout(_aboutTapTimer);
  _aboutTapTimer = setTimeout(() => { _aboutTapCount = 0; }, 1500);
  if (_aboutTapCount >= 5) {
    _aboutTapCount = 0;
    const row = document.getElementById('debug-row');
    if (row) row.style.display = '';
  }
}

function _renderProfilePanel() {
  const panel = document.getElementById('profile-panel');
  if (!panel) return;

  if (_currentUser) {
    panel.classList.remove('logged-out');
    if (typeof loginCarouselUnmount === 'function') loginCarouselUnmount();

    if (_profilePanelView === 'activity') {
      panel.innerHTML = _renderActivityView();
    } else if (_profilePanelView === 'visibility') {
      panel.innerHTML = _renderVisibilityView();
    } else if (_profilePanelView === 'notif-types') {
      panel.innerHTML = _renderNotifTypesView();
    } else if (_profilePanelView === 'admin-edits') {
      panel.innerHTML = _renderAdminEditsView();
    } else if (_profilePanelView === 'admin-suggestions') {
      panel.innerHTML = _renderAdminSuggestionsView();
    } else if (_profilePanelView === 'admin-users') {
      panel.innerHTML = _renderAdminUsersView();
    } else {
      panel.innerHTML = _renderSettingsView();
      if (authIsAdmin()) { _loadPendingCount(); _loadVenueSuggestionsCount(); }
      _loadMySuggestions();
    }
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

// ── Bell dropdown — top-strip notifications inbox (Stage 5) ─────────────────
// Social events only (friend requests + plan invites). Tap a row → handle
// inline. Tap outside → close. Bell dot mirrors badge state from
// _updateAvatarBadge so opening either surface dismisses both.

function toggleBellDropdown(e) {
  if (e) e.stopPropagation();
  const dropdown = document.getElementById('bell-dropdown');
  if (!dropdown) return;
  if (dropdown.classList.contains('open')) {
    _closeBellDropdown();
    return;
  }
  _renderBellDropdown();
  dropdown.classList.add('open');
  document.getElementById('ts-bell-btn')?.classList.add('active');
  setTimeout(() => {
    document.addEventListener('click', _bellDropdownOutsideClick, { once: true });
  }, 0);
}

function _closeBellDropdown() {
  document.getElementById('bell-dropdown')?.classList.remove('open');
  document.getElementById('ts-bell-btn')?.classList.remove('active');
}

function _bellDropdownOutsideClick(e) {
  const dropdown = document.getElementById('bell-dropdown');
  const btn      = document.getElementById('ts-bell-btn');
  const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
  const inside = (dropdown && (dropdown.contains(e.target) || path.includes(dropdown)))
              || (btn && btn.contains(e.target));
  if (dropdown && !inside) {
    _closeBellDropdown();
  } else if (dropdown && dropdown.classList.contains('open')) {
    document.addEventListener('click', _bellDropdownOutsideClick, { once: true });
  }
}

function _formatTimeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'nå';
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' min';
  if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + ' t';
  return Math.floor(ms / 86_400_000) + ' d';
}

function _renderBellDropdown() {
  const dropdown = document.getElementById('bell-dropdown');
  if (!dropdown) return;

  const reqs = (typeof _pendingRequests !== 'undefined' && Array.isArray(_pendingRequests))
    ? _pendingRequests : [];
  const invs = (typeof _planInvites !== 'undefined' && Array.isArray(_planInvites))
    ? _planInvites.filter(i => i.status === 'pending' && i.plan) : [];

  let html = '';

  // ── Forespørsler — real data, actionable inline ─────────────────────
  if (reqs.length || invs.length) {
    html += `<div class="bd-section">Forespørsler</div>`;
    html += reqs.map(r => {
      const name = r.name || r.email || 'Ukjent';
      return `
        <div class="bd-row" id="bd-req-${r.friendshipId}">
          <span class="bd-row__icon">👤</span>
          <div class="bd-row__body">
            <div class="bd-row__msg"><strong>${name}</strong> vil bli venn.</div>
            <div class="bd-row__actions">
              <button class="bd-action primary" onclick="_handleAcceptFriendRequest('${r.friendshipId}')">Godta</button>
              <button class="bd-action secondary" onclick="_handleRejectFriendRequest('${r.friendshipId}')">Avslå</button>
            </div>
          </div>
        </div>`;
    }).join('');
    html += invs.map(i => {
      const p = i.plan || {};
      const creator = p.creator_name || p.creator_email || 'Noen';
      const venue   = p.venue_name || 'et sted';
      const time    = p.time ? new Date(p.time).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' }) : '';
      const meta    = [_formatTimeAgo(i.created_at), time].filter(Boolean).join(' · ');
      return `
        <div class="bd-row" id="bd-inv-${i.id}">
          <span class="bd-row__icon">📅</span>
          <div class="bd-row__body">
            <div class="bd-row__msg"><strong>${creator}</strong> inviterer deg til <strong>${venue}</strong>.</div>
            ${meta ? `<div class="bd-row__meta">${meta}</div>` : ''}
            <div class="bd-row__actions">
              <button class="bd-action primary" onclick="_handleInboxResponse('${i.id}', 'accepted', this)">Godta</button>
              <button class="bd-action secondary" onclick="_handleInboxResponse('${i.id}', 'declined', this)">Avslå</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ── Vær — currently sample only; wire to live weather rules later. ─
  html += `<div class="bd-section">Vær</div>`;
  html += `
    <div class="bd-row bd-row--sample">
      <span class="bd-row__icon">☀</span>
      <div class="bd-row__body">
        <div class="bd-row__msg">Sol åpner på <strong>Hummus &amp; Wine</strong> kl 17:00.</div>
        <div class="bd-row__meta">i dag · 1t 12min sol</div>
      </div>
    </div>
    <div class="bd-row bd-row--sample">
      <span class="bd-row__icon">🌧</span>
      <div class="bd-row__body">
        <div class="bd-row__msg">Regn forventet kl 14:00.</div>
        <div class="bd-row__meta">i dag · 2 mm over 1t</div>
      </div>
    </div>`;

  // ── Sosialt (ikke-handlingsbart) — friends activity ─────────────────
  html += `<div class="bd-section">Sosialt</div>`;
  html += `
    <div class="bd-row bd-row--sample">
      <span class="bd-row__icon">📍</span>
      <div class="bd-row__body">
        <div class="bd-row__msg"><strong>Anna</strong> sjekket inn på <strong>Mathallen</strong>.</div>
        <div class="bd-row__meta">12 min</div>
      </div>
    </div>`;

  // ── Forslag — suggestions for the user ──────────────────────────────
  html += `<div class="bd-section">Forslag</div>`;
  html += `
    <div class="bd-row bd-row--sample">
      <span class="bd-row__icon">💡</span>
      <div class="bd-row__body">
        <div class="bd-row__msg">Prøv <strong>Mathallen</strong> til lunsj — sol fra 12:00.</div>
        <div class="bd-row__meta">3 venner anbefaler</div>
      </div>
    </div>
    <div class="bd-row bd-row--sample">
      <span class="bd-row__icon">💨</span>
      <div class="bd-row__body">
        <div class="bd-row__msg">Vind i dag — prøv <strong>Lekteren</strong> for ly.</div>
        <div class="bd-row__meta">Skjermet · 2t sol</div>
      </div>
    </div>`;

  dropdown.innerHTML = html;
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
    document.body.classList.add('profile-panel-open');
    window._navPush?.('profile');
    if (!_currentUser) {
      if (typeof loginCarouselMount === 'function') loginCarouselMount();
      if (typeof notifFreezeAutoDismiss === 'function') notifFreezeAutoDismiss();
    }
    // Close on outside click (desktop: tap outside the floating panel; mobile:
    // the full-screen panel covers the whole viewport so this rarely fires)
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
  document.body.classList.remove('profile-panel-open');
  _profilePanelView = 'settings';
}

function _profilePanelOutsideClick(e) {
  const panel = document.getElementById('profile-panel');
  const btn   = document.getElementById('search-profile-btn');
  const tsBtn = document.getElementById('ts-avatar-btn');
  // Drill-in handlers replace panel.innerHTML synchronously, which detaches
  // the original target before this bubble-phase handler runs. composedPath()
  // captures the ancestor chain at dispatch time, so it still sees #profile-panel
  // even after the click target was removed from the DOM.
  const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
  const inPanel = panel && (panel.contains(e.target) || path.includes(panel));
  const onAnchor = (btn && btn.contains(e.target)) || (tsBtn && tsBtn.contains(e.target));
  if (panel && !inPanel && !onAnchor) {
    closeProfilePanel();
  } else if (panel && panel.classList.contains('open')) {
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
        // Confirm before remove — accidental ✕ taps in a small list
        // shouldn't quietly tear down a friendship. The modal re-render
        // is awaited inside _confirmRemoveFriend so we don't race the
        // async delete.
        return `<div class="friend-item">
          <div class="friend-item-left">${avatar}<div class="friend-item-info"><div class="friend-item-name">${f.name || f.email}</div>${checkinInfo}</div></div>
          <button class="btn-icon-sm friend-remove" onclick="_confirmRemoveFriend('${f.friendshipId}', ${JSON.stringify(f.name || f.email)})" title="${t('friend_remove_title')}">✕</button>
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
          <div class="friend-item-actions">
            <button class="btn-accept" onclick="_handleAcceptFriendRequest('${r.friendshipId}')">${t('plan_accept')}</button>
            <button class="btn-icon-sm friend-remove" onclick="_handleRejectFriendRequest('${r.friendshipId}')" title="${t('friend_reject_title')}">✕</button>
          </div>
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
  // Reset cache to loading state and navigate to the sub-view (slides in).
  _adminSuggestionsCache = null;
  _setProfilePanelView('admin-suggestions');

  const { data: suggestions, error } = await _supabase
    .from('suggested_venues')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  _adminSuggestionsCache = error ? { error } : (suggestions || []);
  // Re-render if user is still on this view (didn't navigate away mid-fetch).
  if (_profilePanelView === 'admin-suggestions') _renderProfilePanel();
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
  _adminEditsCache = null;
  _setProfilePanelView('admin-edits');

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

  _adminEditsCache = error ? { error } : (edits || []);
  if (_profilePanelView === 'admin-edits') _renderProfilePanel();
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
  _adminUsersCache = null;
  _setProfilePanelView('admin-users');

  const { data, error } = await _supabase
    .from('profiles')
    .select('email, name, role')
    .in('role', ['admin', 'editor'])
    .order('role');

  _adminUsersCache = error ? { error } : (data || []);
  if (_profilePanelView === 'admin-users') _renderProfilePanel();
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
  // Route every legacy toast through the smart notification system so
  // ALL user-facing toasts appear in one consistent place — the top
  // notification slot — instead of a second bottom #app-toast surface
  // that competes with the same role.
  //
  // The v1 comment here said "Always use the simple fixed-position toast
  // for user-triggered feedback (check-in, etc.) — not the smart
  // notification system." That intentional separation has aged poorly:
  // it splits ~10 confirmation messages (link copied, friend request
  // sent, plan created/updated, sun-alert on/off, check-in/out, "Du er
  // med!") off into a second visual layer for no real benefit. Users
  // learn one location for system messages, not two.
  //
  // Falls back to the legacy bottom toast only during early boot before
  // notifications.js has set _notifInitDone — at that point the priority
  // queue silently drops anything, so the fallback keeps early
  // confirmations visible.
  if (typeof _notifShowImmediate === 'function' &&
      typeof _notifInitDone !== 'undefined' && _notifInitDone) {
    _notifShowImmediate({
      id: '_legacy_toast_' + Date.now(),
      priority: 1,
      category: 'system',
      _rawText: msg,
      _legacyDismiss: 3500,
    });
    return;
  }
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
  // Surface the pending-request dot on the search-bar avatar so the user
  // sees there's something waiting without having to open the popover.
  if (typeof _updateAvatarBadge === 'function') _updateAvatarBadge();
  if (typeof _updateFriendsPill === 'function') _updateFriendsPill();
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

/** UI handler for the ✕ on a friend row. Confirms before deleting so an
 *  accidental tap in a small list doesn't silently unfriend somebody. */
async function _confirmRemoveFriend(friendshipId, friendName) {
  const label = friendName || t('attendee_someone');
  if (!confirm(t('friend_remove_confirm', { name: label }))) return;
  await removeFriend(friendshipId);
  _renderFriendsModal();
}
async function _handleAcceptFriendRequest(friendshipId) {
  await acceptFriendRequest(friendshipId);
  _renderFriendsModal();
}
async function _handleRejectFriendRequest(friendshipId) {
  if (typeof _aTrack === 'function') _aTrack('friend_request_rejected', {});
  await _supabase.from('friendships').delete().eq('id', friendshipId);
  await loadFriends();
  _renderFriendsModal();
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

async function checkIn(venueId, message, opts = {}) {
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
  // opts.silent suppresses the success toast — used by callers that
  // already showed their own notification leading up to this check-in
  // (e.g. the invite-flow "Don't check in" countdown).
  if (!opts.silent) _showToast(t('check_in_success'));
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

// Realtime channels for the social tables. The eval-loop (every 60 s in
// notifications.js) still runs the dedup logic against fresh data, so a
// realtime refresh just brings the data forward and lets the toast fire
// within seconds of the receiver's action instead of after a minute.
// Requires the tables to be in the supabase_realtime publication; if
// they're not, the subscription is a no-op and the 60 s poll remains
// the fallback. SQL to enable (run once per project, in SQL editor):
//   alter publication supabase_realtime add table public.plan_invites;
//   alter publication supabase_realtime add table public.friendships;
let _planInvitesSubscription = null;
let _friendshipsSubscription = null;
function _subscribeToPlanInvites() {
  if (_planInvitesSubscription) _planInvitesSubscription.unsubscribe();
  if (!_currentUser) return;
  _planInvitesSubscription = _supabase
    .channel('plan-invites-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'plan_invites' }, () => {
      loadPlans().catch(() => {});
    })
    .subscribe();
}
function _subscribeToFriendships() {
  if (_friendshipsSubscription) _friendshipsSubscription.unsubscribe();
  if (!_currentUser) return;
  _friendshipsSubscription = _supabase
    .channel('friendships-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, () => {
      loadFriends().catch(() => {});
    })
    .subscribe();
}

// ── Periodic social poll ─────────────────────────────────────────────────────
//
// Without realtime subscriptions, the inviter has no way to learn that a
// recipient accepted/declined until they reload or re-auth. Poll plans
// and friends every 60 s while the app is in the foreground so the
// '{name} said yes to {venue}' toast, friends pin, and pending-request
// dot all update within a minute of the receiver's action. Foreground
// gate via document.visibilityState avoids churn while the user is in
// another app.
let _socialPollTimer = null;
const _SOCIAL_POLL_MS = 60000;
function _socialPollTick() {
  if (!_currentUser) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  loadPlans().catch(() => {});
  loadFriends().catch(() => {});
}
function _startSocialPoll() {
  if (_socialPollTimer) return;
  _socialPollTimer = setInterval(_socialPollTick, _SOCIAL_POLL_MS);
  // Also trigger an immediate refresh when the tab regains focus so the
  // user isn't waiting up to 60 s after coming back to the app.
  if (typeof document !== 'undefined' && !_socialVisibilityWired) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _socialPollTick();
    });
    _socialVisibilityWired = true;
  }
}
function _stopSocialPoll() {
  if (_socialPollTimer) { clearInterval(_socialPollTimer); _socialPollTimer = null; }
}
let _socialVisibilityWired = false;

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
  // Refresh the friends-going pill — _plans / _planInvites just changed
  // and the visible pill should reflect new accept/decline data. Same
  // for the avatar badge, which lights up on pending plan invites.
  if (typeof _updateFriendsPill === 'function') _updateFriendsPill();
  if (typeof _updateAvatarBadge === 'function') _updateAvatarBadge();
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
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

/** Merge new invitees into an existing plan instead of creating a parallel
 *  one. Driven by the conflict prompt in _sendInvite — used when the user
 *  already invited people to this venue within ±3h and chooses "Update".
 *  Existing invitees keep their status; duplicates are ignored via the
 *  UNIQUE(plan_id, user_id) constraint on plan_invites. */
async function addInviteesToExistingPlan(planId, friendIds) {
  if (!_currentUser || !planId || !friendIds?.length) return { error: 'invalid' };
  if (typeof _aTrack === 'function') _aTrack('plan_updated', { plan_id: planId, invites: friendIds.length });
  const invites = friendIds.map(fid => ({ plan_id: planId, user_id: fid, status: 'pending' }));
  const { error } = await _supabase
    .from('plan_invites')
    .upsert(invites, { onConflict: 'plan_id,user_id', ignoreDuplicates: true });
  if (error) return { error: error.message };
  await loadPlans();
  _showToast(t('plan_updated'));
  return { success: true };
}

/** Handle accept/decline taps inside the profile-panel inbox.
 *  The previous fire-and-forget `respondToPlanInvite + _renderProfilePanel`
 *  rendered before the DB round-trip + loadPlans completed, so the row stayed
 *  pending in the UI until the user opened the panel again. We now disable the
 *  buttons immediately, await the response, then re-render with fresh state.
 */
async function _handleInboxResponse(inviteId, status, btn) {
  if (btn) {
    const row = btn.closest('.inbox-row');
    if (row) row.querySelectorAll('button').forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
  }
  try { await respondToPlanInvite(inviteId, status); } catch (e) { /* surfaced via toast in respondToPlanInvite */ }
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
}

/**
 * Update a plan_invite's status, optionally setting a per-invitee arrival_time.
 * @param {string} inviteId
 * @param {'accepted'|'declined'|'pending'} status
 * @param {string|null} [arrivalTime] - ISO datetime; null/undefined keeps existing value
 *                                       (for accepts, default = same as plan time)
 */
async function respondToPlanInvite(inviteId, status, arrivalTime) {
  if (typeof _aTrack === 'function') {
    _aTrack('plan_invite_response', { status, has_arrival_time: !!arrivalTime });
  }
  const patch = { status };
  if (arrivalTime !== undefined) patch.arrival_time = arrivalTime;
  // Try the update with arrival_time. If the column doesn't exist yet (migration
  // not applied), retry without it so accept/decline still works.
  const { error } = await _supabase.from('plan_invites').update(patch).eq('id', inviteId);
  if (error && /arrival_time/.test(error.message || '')) {
    await _supabase.from('plan_invites').update({ status }).eq('id', inviteId);
  }
  // Auto-friend on accept removed: invite-link senders may not want to
  // auto-friend everyone who accepts. Friendship is now an explicit
  // user action via the 'Add friend' card on the post-accept panel.
  await loadPlans();
}

/** Auto-friend on accept: when a user accepts a plan invite, also create
 *  (or upgrade-to-accepted) the friendship between them and the plan's
 *  creator. Removes the previous two-step flow where the receiver had
 *  to separately tap a friend-add banner in the detail panel.
 *
 *  Idempotent + symmetric-aware: checks both row directions before
 *  inserting, so we never produce duplicate friendship rows. Pending
 *  rows in either direction get flipped to 'accepted'.
 */
async function _autoFriendInviter(inviteId) {
  const me = _currentUser;
  if (!me) return;
  let inviterId = null;
  try {
    const { data: inv } = await _supabase
      .from('plan_invites')
      .select('plan:plans!plan_invites_plan_id_fkey(created_by)')
      .eq('id', inviteId)
      .maybeSingle();
    inviterId = inv?.plan?.created_by || null;
  } catch (e) { return; }
  if (!inviterId || inviterId === me.id) return;

  try {
    const { data: existing } = await _supabase
      .from('friendships')
      .select('id, status, user_id, friend_id')
      .or(`and(user_id.eq.${inviterId},friend_id.eq.${me.id}),and(user_id.eq.${me.id},friend_id.eq.${inviterId})`);
    if (existing && existing.length > 0) {
      for (const row of existing) {
        if (row.status !== 'accepted') {
          await _supabase.from('friendships').update({ status: 'accepted' }).eq('id', row.id);
        }
      }
    } else {
      await _supabase.from('friendships').insert({
        user_id: inviterId,
        friend_id: me.id,
        status: 'accepted',
      });
    }
  } catch (e) { return; }

  // Clear the now-redundant friend-add banner — the friendship is done.
  if (typeof window !== 'undefined') window._pendingFriendPrompt = null;
  const banner = (typeof document !== 'undefined') ? document.getElementById('friend-prompt-banner') : null;
  if (banner) banner.remove();
  if (typeof loadFriends === 'function') await loadFriends();
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
/**
 * Everyone who DECLINED a plan at this venue on this date. Includes both
 * known friends and non-friend invitees (the profiles join surfaces names
 * for any authenticated decliner). Rows without a joined user object are
 * surfaced too with `user: null` — callers should render those with the
 * 'attendee_someone' fallback string. Self is excluded.
 * Returns: [{ user: {id, name, email, avatar_url} | null, status: 'declined' }]
 */
function getDeclinedFriendsForVenue(venueId, dateStr) {
  if (!_currentUser || !Array.isArray(_plans)) return [];
  const vid = String(venueId);
  const sameDate = (iso) => typeof iso === 'string' && iso.slice(0, 10) === dateStr;
  const result = new Map();
  let anonCount = 0;
  for (const p of _plans) {
    if (String(p.venue_id) !== vid) continue;
    if (!sameDate(p.planned_at)) continue;
    if (!Array.isArray(p._invitees)) continue;
    for (const inv of p._invitees) {
      if (inv.status !== 'declined') continue;
      if (inv.user && inv.user.id === _currentUser.id) continue;
      if (inv.user && inv.user.id) {
        result.set(inv.user.id, { user: inv.user, status: 'declined' });
      } else {
        // Anonymous decline (no profile join hit) — bucket under a
        // synthetic key so multiple anon declines coexist in the map.
        result.set(`__anon_${anonCount++}`, { user: null, status: 'declined' });
      }
    }
  }
  return Array.from(result.values());
}

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
  // Strip the OAuth callback hash from the URL after Supabase has processed
  // the access_token / refresh_token. Supabase reads them on page load
  // (detectSessionInUrl: true by default) and leaves them dangling in the
  // address bar — long bearer tokens visible to anyone glancing at the URL,
  // and they get copied to clipboard when the user shares the link. Replace
  // history with the clean path the moment the SIGNED_IN event lands.
  if (event === 'SIGNED_IN' && /^#(access_token|provider_token|refresh_token)=/.test(location.hash)) {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* ignore — non-fatal */ }
  }
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
    _subscribeToPlanInvites();
    _subscribeToFriendships();
    _startSocialPoll();
  } else {
    _currentRole = null;
    _favoritesSet.clear();
    _alertsMap.clear();
    _friends = []; _pendingRequests = [];
    _friendCheckins.clear(); _myCheckin = null;
    _plans = []; _planInvites = [];
    if (_checkinSubscription)     { _checkinSubscription.unsubscribe();     _checkinSubscription = null; }
    if (_planInvitesSubscription) { _planInvitesSubscription.unsubscribe(); _planInvitesSubscription = null; }
    if (_friendshipsSubscription) { _friendshipsSubscription.unsubscribe(); _friendshipsSubscription = null; }
    _stopSocialPoll();
  }

  // Stash the currently-selected venue BEFORE the closeDetailPanel call below
  // resets selectedId. The post-login reopen path picks this up so the user
  // lands back on the same venue's detail panel after auth.
  let _stashedVenueId = null;
  if (wasLoggedIn && !_currentUser && typeof selectedId !== 'undefined' && selectedId) {
    _stashedVenueId = selectedId;
    if (typeof window !== 'undefined') window._postLoginVenueId = _stashedVenueId;
  }

  // After login: re-open the detail panel for the selected venue. Tries
  // selectedId first (set when login is triggered from the detail panel
  // directly), then falls back to the stashed id from a prior logout cycle.
  if (!wasLoggedIn && _currentUser) {
    const id = (typeof selectedId !== 'undefined' && selectedId) ? selectedId
            : (typeof window !== 'undefined' ? window._postLoginVenueId : null);
    if (id) {
      const v = typeof VENUES !== 'undefined' && VENUES.find(x => x.id === id);
      if (v && typeof openDetailPanel === 'function') openDetailPanel(v);
      if (typeof window !== 'undefined') window._postLoginVenueId = null;
    }
  }

  // After login: resume any pending invite-link that landed before auth completed.
  // _tryPendingInvite is exposed from app.js's _introCheckReady; it's a no-op
  // when window._pendingInvite is null (already consumed).
  if (!wasLoggedIn && _currentUser && typeof window._tryPendingInvite === 'function' && window._pendingInvite) {
    setTimeout(() => window._tryPendingInvite(), 200);
  }
  // Same pattern for cold-link friend invites — the welcome card is up
  // when the user lands without auth; this resumes the friendship insert
  // after they sign in.
  if (!wasLoggedIn && _currentUser && typeof window._tryFriendInvite === 'function' && window._pendingFriendInvite) {
    setTimeout(() => window._tryFriendInvite(), 200);
  }

  // After sign-out: close the detail panel
  if (wasLoggedIn && !_currentUser && typeof closeDetailPanel === 'function') {
    closeDetailPanel();
  }

  // Re-evaluate notifications on auth change (login unlocks social, logout unlocks login prompts)
  if (typeof _notifEvaluate === 'function') setTimeout(_notifEvaluate, 1000);
});
