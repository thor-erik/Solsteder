// ── Supabase auth ──────────────────────────────────────────────────────────────

const SUPABASE_URL      = 'https://wxalqodaeqgzahwlovnw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind4YWxxb2RhZXFnemFod2xvdm53Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxODcyNDYsImV4cCI6MjA5MTc2MzI0Nn0.RzP2Fsft1yqTt7Hg-u2t1UnGLE7FvFBoG88mKstUJgo';

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// HTML-escape any value bound for innerHTML or an HTML attribute. The five
// chars cover both text content (< > &) and attribute contexts (" '). Use
// _escAllowStrong below for fields the server has already wrapped in
// <strong>...</strong> markup that we want preserved.
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Server-rendered notification bodies (sql/030+) wrap names and venues in
// <strong>...</strong>. We can't strip those tags (they're load-bearing for
// emphasis) but we MUST escape everything else — name and venue_name flow
// in unsanitized from profiles + plans. Strategy: escape everything, then
// revive only the literal opening/closing <strong> tokens the server emits.
// Anything fancier (e.g. <strong class="…">) won't survive, which is fine.
function _escAllowStrong(s) {
  return _esc(s).replace(/&lt;strong&gt;/g, '<strong>').replace(/&lt;\/strong&gt;/g, '</strong>');
}

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
 *  Also stamps last_seen_at — the auth-load is the cheapest place to
 *  treat as a heartbeat. Runs on every auth load. Idempotent. */
async function _syncProfileFromUserMetadata() {
  if (!_currentUser) return;
  const meta = _currentUser.user_metadata || {};
  const patch = { last_seen_at: new Date().toISOString() };
  const fullName = meta.full_name || meta.name || meta.preferred_username || null;
  if (fullName) patch.name = fullName;
  if (meta.avatar_url) patch.avatar_url = meta.avatar_url;
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

/** When the app is launched as an installed PWA, redirect OAuth back
 *  to /?source=pwa so Android Chrome can route the callback to the
 *  installed app instead of opening a fresh browser tab. Otherwise
 *  the session lives in the browser's storage and the PWA window
 *  stays logged out. */
function _oauthRedirectTo() {
  const isStandalone =
    (typeof window !== 'undefined' && window.matchMedia &&
     window.matchMedia('(display-mode: standalone)').matches) ||
    (typeof navigator !== 'undefined' && navigator.standalone === true);
  return isStandalone
    ? `${window.location.origin}/?source=pwa`
    : window.location.origin;
}

async function authSignInWithGoogle() {
  try {
    sessionStorage.setItem('solsteder_auth_restore', JSON.stringify(_captureAuthRestoreState()));
  } catch (_) {}
  await _supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: _oauthRedirectTo() }
  });
}

async function authSignInWithApple() {
  try {
    sessionStorage.setItem('solsteder_auth_restore', JSON.stringify(_captureAuthRestoreState()));
  } catch (_) {}
  await _supabase.auth.signInWithOAuth({
    provider: 'apple',
    options: { redirectTo: _oauthRedirectTo() }
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
  // All cleanup now lives in the SIGNED_OUT branch of onAuthStateChange so
  // it runs whether sign-out was initiated here, by token expiry, or by
  // another tab. This wrapper is just the user-action entry point.
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
  // Build nodes rather than strings so OAuth-supplied name/avatar can't
  // break out of attribute context. The previous template-string version
  // interpolated raw user_metadata into `<img src="${avatar}" alt="${name}"
  // onerror="…${initial}…">` — a name with a `"` would have escaped the
  // attribute. With Apple Sign-In letting the user pick any display name at
  // consent, that was a real (self-only) XSS path.
  const buildAvatarNode = () => {
    if (!_currentUser) {
      const wrap = document.createElement('div');
      wrap.className = 'profile-anon';
      wrap.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;
      return wrap;
    }
    const avatar  = _currentUser.user_metadata?.avatar_url;
    const name    = _currentUser.user_metadata?.name ?? _currentUser.email ?? '';
    const initial = (name[0] || '?').toUpperCase();
    const initialsNode = () => {
      const d = document.createElement('div');
      d.className = 'profile-initials';
      d.textContent = initial;
      return d;
    };
    if (!avatar) return initialsNode();
    const img = document.createElement('img');
    img.src              = avatar;
    img.alt              = name;
    img.referrerPolicy   = 'no-referrer';
    img.addEventListener('error', () => {
      const replacement = initialsNode();
      if (img.parentNode) img.parentNode.replaceChild(replacement, img);
    });
    return img;
  };
  const fill = (host) => {
    if (!host) return;
    host.replaceChildren(buildAvatarNode());
  };
  fill(btn);
  fill(tsBtn);
  _renderProfilePanel();
  // Pull recent notifications into the bell on auth-ready. Internally
  // gated by _bellHydrated so this is a no-op after the first run.
  if (_currentUser && typeof _bellHydrate === 'function') _bellHydrate();
  // Subscribe to Realtime inserts so events fired on another device (or
  // by a server trigger) reach the bell without a page reload.
  if (_currentUser && typeof _bellSubscribeRealtime === 'function') {
    _bellSubscribeRealtime();
  }
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
      <div class="profile-section-label">${_esc(t('friend_requests'))} (${friendReqs.length})</div>
      ${friendReqs.map(r => {
        return `<div class="inbox-row">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${_esc(r.name || r.email)}</div>
          </div>
          <div class="inbox-row-actions">
            <button class="inbox-btn inbox-btn-accept"
                    onclick="_handleAcceptFriendRequest('${_esc(r.friendshipId)}');_renderProfilePanel?.();">
              ${_esc(t('plan_accept'))}
            </button>
            <button class="inbox-btn inbox-btn-decline"
                    onclick="_handleRejectFriendRequest('${_esc(r.friendshipId)}');_renderProfilePanel?.();">
              ${_esc(t('plan_decline'))}
            </button>
          </div>
        </div>`;
      }).join('')}`;
  }

  let pendingHtml = '';
  if (pending.length) {
    pendingHtml = `
      <div class="profile-section-label">${_esc(t('invitations_label'))} (${pending.length})</div>
      ${pending.map(inv => {
        const p = inv.plan;
        const creator = p.creator?.name || p.creator?.email || '';
        const vName = venueName(p.venue_id);
        // inviterName is interpolated into an onclick attribute (HTML-attribute
        // context) AND a JS string literal inside it. JSON.stringify gives us a
        // valid JS string; _esc then makes it attribute-safe by escaping the "
        // chars JSON.stringify produces.
        const inviterArg = _esc(JSON.stringify(creator || ''));
        const venueArg   = _esc(JSON.stringify(p.venue_id));
        return `<div class="inbox-row">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${_esc(vName)}</div>
            <div class="inbox-row-meta">${_esc(creator)} · ${_esc(fmt(p.planned_at))}</div>
          </div>
          <div class="inbox-row-actions">
            <button class="inbox-btn inbox-btn-preview"
                    onclick="closeProfilePanel();openPlanPreview({venueId:${venueArg}, plannedAt:'${_esc(p.planned_at)}', inviteId:'${_esc(inv.id)}', inviterName:${inviterArg}, mode:'invite'})">
              ${_esc(t('preview_plan'))}
            </button>
            <button class="inbox-btn inbox-btn-accept"
                    onclick="_handleInboxResponse('${_esc(inv.id)}','accepted', this)">
              ${_esc(t('plan_accept'))}
            </button>
            <button class="inbox-btn inbox-btn-decline"
                    onclick="_handleInboxResponse('${_esc(inv.id)}','declined', this)">
              ${_esc(t('plan_decline'))}
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
      <div class="profile-section-label profile-section-label-sub">${_esc(t('your_plans_label'))}</div>
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
          ? `<div class="inbox-row-arrivals">${_esc(offPlan.slice(0, 3).join(' · '))}${offPlan.length > 3 ? ` +${offPlan.length - 3}` : ''}</div>`
          : '';
        const venueArg = _esc(JSON.stringify(p.venue_id));
        return `<div class="inbox-row">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${_esc(vName)}</div>
            <div class="inbox-row-meta">${_esc(fmt(p.planned_at))}${ratio ? ` · ${_esc(ratio)} ✓` : ''}</div>
            ${offPlanLine}
          </div>
          <div class="inbox-row-actions">
            <button class="inbox-btn inbox-btn-preview"
                    onclick="closeProfilePanel();openPlanPreview({venueId:${venueArg}, plannedAt:'${_esc(p.planned_at)}', mode:'preview'})">
              ${_esc(t('preview_plan'))}
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
      <div class="profile-section-label profile-section-label-sub">${_esc(t('recent_responses_label'))}</div>
      ${top.map(r => {
        const vName = venueName(r.plan.venue_id);
        const statusKey = r.invitee.status === 'accepted' ? 'response_said_yes' : 'response_said_no';
        // i18n t() does raw string substitution with no HTML escape — the
        // {name}/{venue} placeholders carry user-controlled values, so the
        // whole rendered label gets HTML-escaped before going into innerHTML.
        const statusLabel = t(statusKey, { name: r.name, venue: vName });
        return `<div class="inbox-row inbox-row-compact">
          <div class="inbox-row-info">
            <div class="inbox-row-title">${_esc(statusLabel)}</div>
            <div class="inbox-row-meta">${_esc(fmt(r.plan.planned_at))}</div>
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
  const _disabled = (typeof _NOTIF_DISABLED_CATEGORIES !== 'undefined') ? _NOTIF_DISABLED_CATEGORIES : new Set();
  const categories = [
    { key: 'alert',      labelKey: 'notif_cat_alert' },
    { key: 'weather',    labelKey: 'notif_cat_weather' },
    { key: 'social',     labelKey: 'notif_cat_social' },
    { key: 'suggestion', labelKey: 'notif_cat_suggestion' },
  ].filter(c => !_disabled.has(c.key));
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
      if (authIsAdmin()) { _loadPendingCount(); _loadVenueSuggestionsCount(); _subscribeSuggestionsRealtime(); }
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
// Real-time inbox: pending friend requests + plan invites + every
// notification captured from _notifShow. Tap a row → invoke its action
// (or open the plan preview for plan-related events). Tap outside →
// close. Bell dot mirrors aggregate "has new" state.

// In-memory store of notifications fired this session. Each entry keeps
// the rendered body + lead + action ref so the bell row can replay the
// click. Map by notif.id so a re-firing notification dedupes/updates.
const _bellHistory = new Map();
// Rows currently rendered in the open bell dropdown, keyed by id.
// Used by _renderBellDropdown to diff against the next render so:
//   - existing rows keep stable DOM nodes (no innerHTML rebuild flash)
//   - removed rows disappear cleanly
//   - new rows insert with a max-height animation that pushes
//     existing siblings down via natural layout reflow
// Cleared when the dropdown closes so the next open re-establishes
// the baseline without animating everything.
let _bellRenderedRows = new Map();
const _BELL_HISTORY_MAX = 30;          // hard upper bound (anti-runaway)
const _BELL_HISTORY_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Unread state lives on the notifications row (read_at column). Bell
// open marks every visible entry read; per-row click also marks the
// row read via _bellMarkRead. No localStorage cutoff anymore — works
// across devices because the read state is server-side.
async function _bellNoteOpened() {
  const now = new Date().toISOString();
  let changed = false;
  const markedIds = [];
  for (const entry of _bellHistory.values()) {
    if (entry.readAt) continue;
    // Action-required rows stay unread until the user actually
    // responds. Pending plan invites need an Accept/Decline tap —
    // collapsing the unread dot on bell-open would let an invite
    // disappear from attention before the user has done anything.
    // We check the LIVE plan_invite status: only mark read once
    // status is no longer 'pending'. Friend requests follow the
    // same rule (must be acted on).
    if (typeof entry.id === 'string' && entry.id.startsWith('plan_invite_pending:')) {
      const inviteId = entry.id.substring('plan_invite_pending:'.length);
      const inv = (typeof _planInvites !== 'undefined' && Array.isArray(_planInvites))
        ? _planInvites.find(i => i && i.id === inviteId) : null;
      if (!inv || inv.status === 'pending') continue;
    }
    if (typeof entry.id === 'string' && entry.id === 'social_friend_request') {
      const stillPending = (typeof _pendingRequests !== 'undefined'
        && Array.isArray(_pendingRequests) && _pendingRequests.length > 0);
      if (stillPending) continue;
    }
    entry.readAt = now;
    markedIds.push(entry.id);
    changed = true;
  }
  if (!changed) return;
  if (!_currentUser || typeof _supabase === 'undefined') return;
  try {
    // Only update the rows we actually just marked — leaves
    // pending-invite rows with read_at = NULL in the DB so they
    // re-render as unread on next session too.
    await _supabase.from('notifications')
      .update({ read_at: now })
      .eq('user_id', _currentUser.id)
      .is('read_at', null)
      .in('notif_id', markedIds);
  } catch (e) { console.warn('[bell] mark-as-read failed', e); }
}

/** Render body with bodyVars bolded. _notifShow's wrapper renders the
 *  template via t() with var substitution; we do the same here but wrap
 *  each value in <strong> so names + venues stand out. */
function _bellRenderBody(notif) {
  if (!notif || !notif.bodyKey) return '';
  let body = (typeof t === 'function') ? t(notif.bodyKey) : notif.bodyKey;
  if (notif.bodyVars) {
    for (const [k, v] of Object.entries(notif.bodyVars)) {
      body = body.replaceAll(`{${k}}`, `<strong>${v}</strong>`);
    }
  }
  return body;
}

/** Build a serializable descriptor for the row's leading element so we
 *  can re-render it after a page reload (hydrating from Supabase). */
function _bellLeadDescriptor(notif) {
  const vars = notif.bodyVars || {};
  const name = vars.name;
  if (notif.category === 'social' && name) {
    const count = vars.count || (vars.extra ? vars.extra + 1 : 1);
    return { type: 'avatar', name, count: Math.max(0, count - 1) };
  }
  if (notif.category === 'weather') {
    const id = String(notif.id || '');
    if (id.includes('rain'))  return { type: 'sys', icon: 'rain' };
    if (id.includes('cloud')) return { type: 'sys', icon: 'rain' };
    return { type: 'sys', icon: 'sun' };
  }
  if (notif.category === 'suggestion') {
    return notif.id?.includes('sheltered')
      ? { type: 'sys', icon: 'wind' }
      : { type: 'sys', icon: 'bulb' };
  }
  return { type: 'sys', icon: 'bulb' };
}

/** Render the row's leading HTML from a descriptor. */
function _bellLeadFromDescriptor(d) {
  if (!d || !d.type) return _bellSysLead('bulb');
  if (d.type === 'avatar') return _bellAvatar(d.name || '?', d.count || 0);
  if (d.type === 'sys')    return _bellSysLead(d.icon || 'bulb');
  return _bellSysLead('bulb');
}

/** Choose lead element from a notification (capture-time entry point). */
function _bellLeadForNotif(notif) {
  return _bellLeadFromDescriptor(_bellLeadDescriptor(notif));
}

/** Serializable click descriptor. Used after page reload when the
 *  original action function is no longer in memory. Each notification
 *  rule can set its own `notif.nav` explicitly; otherwise we best-effort
 *  extract a venue from bodyVars.venue. */
function _bellExtractNav(notif) {
  if (notif?.nav) return notif.nav;
  const vars = notif?.bodyVars || {};
  if (vars.venue && typeof VENUES !== 'undefined' && Array.isArray(VENUES)) {
    const target = String(vars.venue).toLowerCase();
    const v = VENUES.find(x => x.name && x.name.toLowerCase() === target);
    if (v) return { kind: 'venue', venueId: v.id };
  }
  return { kind: 'none' };
}

/** Route from a nav descriptor (works post-reload without action ref). */
function _bellNavigate(nav) {
  if (!nav || !nav.kind || nav.kind === 'none') return;
  if (nav.kind === 'venue' && nav.venueId != null) {
    if (typeof selectVenue === 'function') selectVenue(Number(nav.venueId), true);
    return;
  }
  if (nav.kind === 'plan') {
    if (typeof openPlanPreview === 'function') {
      openPlanPreview({
        venueId: nav.venueId,
        plannedAt: nav.plannedAt,
        // Forward the cancelled flag from the notification's nav
        // payload so the plan-preview can render the cancelled state
        // even when the plan is no longer in _plans/_planInvites
        // (cancelled plans are filtered out of those active lists).
        cancelled: !!nav.cancelled,
      });
    } else if (typeof selectVenue === 'function' && nav.venueId != null) {
      selectVenue(Number(nav.venueId), true);
    }
    return;
  }
  if (nav.kind === 'friends' || nav.kind === 'friend-request') {
    if (typeof openFriendsModal === 'function') openFriendsModal();
    return;
  }
}

/** True if a notif id is handled by a server-side trigger. Those events
 *  are written to the notifications table by Postgres and delivered to
 *  the client via Realtime, so we skip the client-side write to avoid
 *  duplicate rows. The toast still fires (in-session UX); only the
 *  bell-history write is skipped. */
function _isServerHandledNotif(id) {
  return id.startsWith('social_invite_accepted_')
      || id.startsWith('social_invite_declined_');
}

/** Public: capture a notification into the bell history when it fires.
 *  Called from notifications.js's _notifShow wrapper. Persists to
 *  Supabase fire-and-forget so the entry survives page reload + syncs
 *  across devices. */
function _bellRecord(notif) {
  if (!notif || !notif.bodyKey) return;
  // Server triggers write these — Realtime delivers the canonical row,
  // so a client-side write would produce a duplicate with a different id.
  if (_isServerHandledNotif(notif.id)) return;
  const leadDescriptor = _bellLeadDescriptor(notif);
  const nav = _bellExtractNav(notif);
  const entry = {
    id: notif.id,
    category: notif.category,
    ts: Date.now(),
    body: _bellRenderBody(notif),
    lead: _bellLeadFromDescriptor(leadDescriptor),
    leadDescriptor,
    nav,
    // bellAction overrides action when present — plan-related notifs
    // use it to open the plan-preview sheet instead of the venue detail.
    action: notif.bellAction || notif.action,
  };
  _bellHistory.set(notif.id, entry);
  // Time-based eviction — drop anything older than 14 days. Keeps the
  // inbox "active" without infinite scroll-back. Hard cap stays as a
  // belt-and-braces guard against pathological burst (60+ rows in a
  // single day still trips the cap).
  const cutoff = Date.now() - _BELL_HISTORY_TTL_MS;
  for (const [k, v] of _bellHistory) {
    if (v.ts < cutoff) _bellHistory.delete(k);
  }
  if (_bellHistory.size > _BELL_HISTORY_MAX) {
    let oldestId = null, oldestTs = Infinity;
    _bellHistory.forEach((v, k) => { if (v.ts < oldestTs) { oldestTs = v.ts; oldestId = k; } });
    if (oldestId) _bellHistory.delete(oldestId);
  }
  if (typeof _updateAvatarBadge === 'function') _updateAvatarBadge();
  _bellPersist(entry);
}

/** Fire-and-forget upsert to the notifications table. Dedupes via the
 *  UNIQUE (user_id, notif_id) index — re-firing updates the row. */
async function _bellPersist(entry) {
  if (!_currentUser || typeof _supabase === 'undefined') return;
  try {
    await _supabase.from('notifications').upsert({
      user_id:  _currentUser.id,
      notif_id: entry.id,
      category: entry.category,
      body:     entry.body,
      lead:     entry.leadDescriptor,
      nav:      entry.nav,
    }, { onConflict: 'user_id,notif_id' });
  } catch (e) {
    console.warn('[bell] persist failed:', e);
  }
}

/** Pull the last 30 days of notifications for the current user into
 *  _bellHistory on auth-ready. Session captures take priority — we
 *  don't overwrite an in-memory entry with the row from Supabase. */
let _bellHydrated = false;
async function _bellHydrate() {
  if (_bellHydrated) return;
  if (!_currentUser || typeof _supabase === 'undefined') return;
  _bellHydrated = true;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await _supabase
      .from('notifications')
      .select('*')
      .eq('user_id', _currentUser.id)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(_BELL_HISTORY_MAX);
    if (error) { console.warn('[bell] hydrate failed:', error.message); return; }
    for (const row of (data || [])) {
      if (_bellHistory.has(row.notif_id)) continue;  // in-session capture wins
      _bellHistory.set(row.notif_id, {
        id:       row.notif_id,
        category: row.category,
        ts:       new Date(row.created_at).getTime(),
        body:     row.body,
        lead:     _bellLeadFromDescriptor(row.lead),
        leadDescriptor: row.lead,
        nav:      row.nav,
        readAt:   row.read_at,
        // No action() — function refs don't survive reload. _bellInvokeAction
        // falls back to nav-based routing for these.
      });
    }
    if (typeof _updateAvatarBadge === 'function') _updateAvatarBadge();
  } catch (e) {
    console.warn('[bell] hydrate exception:', e);
  }
}

/** Click handler for bell rows. Prefers the in-memory action function
 *  when available (most expressive); falls back to nav-based routing
 *  for entries restored from Supabase across a reload. */
function _bellInvokeAction(id) {
  const entry = _bellHistory.get(id);
  _closeBellDropdown();
  if (!entry) return;
  // Mark this row read server-side (fire-and-forget).
  _bellMarkRead(id);
  if (typeof entry.action === 'function') {
    try { entry.action(); } catch (e) { console.warn('[bell] action failed:', e); }
    return;
  }
  _bellNavigate(entry.nav);
}

async function _bellMarkRead(notifId) {
  if (!_currentUser || typeof _supabase === 'undefined') return;
  try {
    await _supabase.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id',  _currentUser.id)
      .eq('notif_id', notifId);
  } catch { /* ignore */ }
}

// ── Realtime: subscribe to INSERTs on notifications for the current user.
// Server-side triggers fan out events into this table; this subscription
// is how they reach the client in real time (and across devices). ────────
let _bellChannel = null;

function _bellSubscribeRealtime() {
  if (!_currentUser || typeof _supabase === 'undefined') return;
  if (_bellChannel) return;  // already subscribed
  _bellChannel = _supabase
    .channel(`notifications:${_currentUser.id}`)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'notifications',
      filter: `user_id=eq.${_currentUser.id}`,
    }, (payload) => {
      const row = payload.new;
      if (!row) return;
      _bellHistory.set(row.notif_id, {
        id:       row.notif_id,
        category: row.category,
        ts:       new Date(row.created_at).getTime(),
        body:     row.body,
        lead:     _bellLeadFromDescriptor(row.lead),
        leadDescriptor: row.lead,
        nav:      row.nav,
        readAt:   row.read_at,
        // No action() for server-delivered rows — fall through to nav.
      });
      if (typeof _updateAvatarBadge === 'function') _updateAvatarBadge();
      const dropdown = document.getElementById('bell-dropdown');
      if (dropdown && dropdown.classList.contains('open')) {
        _renderBellDropdown();
      }
    })
    .subscribe();
}

function _bellUnsubscribeRealtime() {
  if (!_bellChannel) return;
  try { _bellChannel.unsubscribe(); } catch { /* ignore */ }
  _bellChannel = null;
}

/** True if any current inbox item is newer than the last bell-open. */
function _bellHasUnread() {
  const reqs = (typeof _pendingRequests !== 'undefined' && Array.isArray(_pendingRequests))
    ? _pendingRequests : [];
  const invs = (typeof _planInvites !== 'undefined' && Array.isArray(_planInvites))
    ? _planInvites.filter(i => i.status === 'pending' && i.plan) : [];
  // Pending requests / invites are always "new" until acted on.
  if (reqs.length > 0 || invs.length > 0) return true;
  for (const e of _bellHistory.values()) {
    if (!e.readAt) return true;
  }
  return false;
}

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
  // body.bell-open is the suppress signal for toast notifications
  // (notifications.js _notifCanShow checks this class). Keeps incoming
  // toasts from overlapping the user reading their inbox.
  document.body.classList.add('bell-open');
  document.getElementById('ts-bell-btn')?.classList.add('active');
  setTimeout(() => {
    document.addEventListener('click', _bellDropdownOutsideClick, { once: true });
  }, 0);
}

function _closeBellDropdown() {
  document.getElementById('bell-dropdown')?.classList.remove('open');
  document.body.classList.remove('bell-open');
  document.getElementById('ts-bell-btn')?.classList.remove('active');
  // Reset diff tracking — next open re-establishes the baseline so
  // existing rows don't animate in as "fresh."
  _bellRenderedRows.clear();
  // Mark everything currently visible as seen — next open won't dot it.
  _bellNoteOpened();
  if (typeof _updateAvatarBadge === 'function') _updateAvatarBadge();
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

// Monochrome line icons for system notifications (weather, suggestion).
// Feather-style stroke icons, no background tint, no circle — same visual
// language Linear / Slack / Notion use for system events.
const _BELL_SYS_ICON = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="19" x2="8" y2="21"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="16" y1="19" x2="16" y2="21"/><line x1="16" y1="13" x2="16" y2="15"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="12" y1="15" x2="12" y2="17"/><path d="M20 16.58A5 5 0 0018 7h-1.26A8 8 0 104 15.25"/></svg>',
  bulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c0-1 .8-2.43 1.91-3.59A5 5 0 1010 6.69V11"/></svg>',
  wind: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9.59 4.59A2 2 0 1111 8H2m10.59 11.41A2 2 0 1014 16H2m15.73-8.27A2.5 2.5 0 1119.5 12H2"/></svg>',
};

function _bellInitial(name) {
  return ((name || '?').trim()[0] || '?').toUpperCase();
}

function _bellAvatar(name, extraCount) {
  // `name` flows from the server `notifications.lead` jsonb (profile name,
  // unsanitized). Escape the initial so a malicious display name can't break
  // out of the avatar span. extraCount is numeric — Number() coerces safely.
  const init = _esc(_bellInitial(name));
  const plus = extraCount > 0
    ? `<span class="bd-row__avatar-plus">+${Number(extraCount) || 0}</span>` : '';
  return `<span class="bd-row__lead">
    <span class="bd-row__avatar">${init}${plus}</span>
  </span>`;
}

function _bellSysLead(iconKey) {
  return `<span class="bd-row__lead">
    <span class="bd-row__sys-icon">${_BELL_SYS_ICON[iconKey] || ''}</span>
  </span>`;
}

function _renderBellDropdown() {
  const dropdown = document.getElementById('bell-dropdown');
  if (!dropdown) return;

  const reqs = (typeof _pendingRequests !== 'undefined' && Array.isArray(_pendingRequests))
    ? _pendingRequests : [];
  const invs = (typeof _planInvites !== 'undefined' && Array.isArray(_planInvites))
    ? _planInvites.filter(i => i.status === 'pending' && i.plan) : [];

  const NOW = Date.now();
  const entries = [];

  // ── Real data: pending friend requests + plan invites ───────────────
  // These are always "new" until the user acts on them — the bd-row--new
  // dot stays until accept/decline removes the row.
  reqs.forEach(r => {
    const name = r.name || r.email || 'Ukjent';
    const fid  = _esc(r.friendshipId);
    entries.push({
      t: new Date(r.requestedAt || r.created_at || NOW).getTime(),
      html: `
        <div class="bd-row bd-row--new" id="bd-req-${fid}">
          ${_bellAvatar(name)}
          <div class="bd-row__body">
            <div class="bd-row__msg"><strong>${_esc(name)}</strong> ønsker å bli venn.</div>
            <div class="bd-row__meta">${_esc(_formatTimeAgo(r.requestedAt || r.created_at))}</div>
            <div class="bd-row__actions">
              <button class="bd-action primary" onclick="_handleAcceptFriendRequest('${fid}')">Godta</button>
              <button class="bd-action secondary" onclick="_handleRejectFriendRequest('${fid}')">Avslå</button>
            </div>
          </div>
        </div>`,
    });
  });

  // Pending plan_invites are NOT rendered as their own bell rows —
  // the SQL trigger (sql/022) writes a row into the notifications table
  // when the invite is created, which arrives via _bellHistory below.
  // Rendering both produced two visible rows for the same invite with
  // inconsistent wording. Now there's one row, one CTA (open the
  // accept panel), and the inline Godta/Avslå have moved to the
  // accept panel itself where they belong.

  // ── Captured notifications — every notification that fired this
  //    session gets surfaced here. Real data, real click actions. ──────
  _bellHistory.forEach(entry => {
    const isNew = entry.readAt ? '' : ' bd-row--new';
    const enriched = _enrichPlanNotificationBody(entry);
    const body       = enriched ? enriched.body       : entry.body;
    const pastClass  = enriched ? enriched.pastClass  : '';
    const metaSuffix = enriched ? enriched.metaSuffix : '';
    // Host-side quick-cancel button — surfaces an Avlys-plan shortcut
    // directly on the inbox row for plans the user created (accept/
    // decline response rows and creator reminders). Saves the
    // bell-row → plan-preview → Avlys nav for hosts who decide to
    // bail before the meet time.
    const cancelPlanId = enriched && enriched.cancelPlanId;
    const cancelIdEsc  = cancelPlanId ? _esc(cancelPlanId) : '';
    const cancelBtnHtml = cancelPlanId
      ? `<button class="bd-row__quick-cancel" type="button" data-plan-id="${cancelIdEsc}" aria-label="Avlys plan" onclick="event.stopPropagation(); _bellQuickCancel(event, '${cancelIdEsc}')">×</button>`
      : '';
    // `body` is server-rendered HTML from public.notifications.body, e.g.
    // '<strong>Anna</strong> har invitert deg til <strong>Starbucks</strong>'.
    // The <strong> wraps are load-bearing markup we want preserved; the
    // names and venue inside them flow in unsanitized from profiles +
    // plans. _escAllowStrong escapes everything else and revives just the
    // <strong>/</strong> pair, blocking the stored XSS path.
    // entry.id is a notif_id (server-generated string like
    // 'plan_invite_pending:<uuid>' or 'friend_accepted:<uuid>') so a
    // colon is the only structural char — still _esc as defense in depth.
    const idEsc = _esc(entry.id);
    entries.push({
      t: entry.ts,
      html: `
        <div class="bd-row bd-row--clickable${isNew}${pastClass}" onclick="_bellInvokeAction('${idEsc}')">
          ${entry.lead}
          <div class="bd-row__body">
            <div class="bd-row__msg">${_escAllowStrong(body)}</div>
            <div class="bd-row__meta">${_esc(_formatTimeAgo(new Date(entry.ts).toISOString()))}${_esc(metaSuffix)}</div>
          </div>
          ${cancelBtnHtml}
        </div>`,
    });
  });

  entries.sort((a, b) => b.t - a.t);

  if (!entries.length) {
    dropdown.innerHTML = `
      <div class="bd-empty">
        <svg class="bd-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
        </svg>
        <div class="bd-empty-text">Innboksen er tom.</div>
      </div>`;
    _bellRenderedRows.clear();
    return;
  }

  // DOM-diff render: keep stable node identity per id so existing rows
  // don't re-mount (no flash on +N updates), and new rows animate in
  // with a max-height transition that naturally pushes existing
  // siblings down via reflow.
  const seedRender = _bellRenderedRows.size === 0;
  const targetIds = new Set(entries.map(e => e.id));

  // 1. Remove DOM nodes whose ids are no longer in the target set.
  for (const [id, row] of _bellRenderedRows) {
    if (!targetIds.has(id)) { row.remove(); _bellRenderedRows.delete(id); }
  }
  // Clean up any leftover non-bd-row children (e.g. the empty-state
  // svg from a prior empty render) so the diff has a clean canvas.
  for (const child of [...dropdown.children]) {
    if (!child.classList || !child.classList.contains('bd-row')) child.remove();
  }

  // 2. Walk target entries in order; ensure each is in DOM at the
  //    correct position. Existing rows get their inner content updated
  //    in place; new rows are created and slid in.
  let prevNode = null;
  for (const entry of entries) {
    let row = _bellRenderedRows.get(entry.id);
    if (row) {
      // Existing — refresh inner content (handles +N changes, body
      // rewrites, read-state class flips). Outer attrs stay so we
      // don't lose the node identity.
      const tmp = document.createElement('div');
      tmp.innerHTML = entry.html.trim();
      const fresh = tmp.firstElementChild;
      if (fresh) {
        row.className = fresh.className;
        // Re-bind onclick (rendered inline in entry.html) so the
        // captured-id stays current after refresh.
        const onclickAttr = fresh.getAttribute('onclick');
        if (onclickAttr) row.setAttribute('onclick', onclickAttr); else row.removeAttribute('onclick');
        row.innerHTML = fresh.innerHTML;
      }
      // Move to correct position if needed
      const expectedPrev = prevNode;
      if (expectedPrev ? expectedPrev.nextSibling !== row : dropdown.firstChild !== row) {
        if (expectedPrev) expectedPrev.after(row);
        else dropdown.prepend(row);
      }
    } else {
      // New — create + insert + animate in (skipped on seed render so
      // opening the inbox doesn't animate every row).
      const tmp = document.createElement('div');
      tmp.innerHTML = entry.html.trim();
      row = tmp.firstElementChild;
      if (!row) continue;
      if (prevNode) prevNode.after(row); else dropdown.prepend(row);
      _bellRenderedRows.set(entry.id, row);
      if (!seedRender) _bellAnimateRowIn(row);
    }
    prevNode = row;
  }
}

/** Slide a freshly-inserted row in via max-height + opacity. Existing
 *  siblings reflow down naturally as the row's height grows from 0 to
 *  its natural scrollHeight. */
function _bellAnimateRowIn(row) {
  if (!row) return;
  // Skip animation when the user has reduced-motion enabled.
  if (typeof matchMedia !== 'undefined'
      && matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  const target = row.scrollHeight;
  if (!target) return; // off-screen / display:none — bail
  row.style.maxHeight = '0px';
  row.style.opacity = '0';
  row.style.overflow = 'hidden';
  // Force a reflow so the starting state is committed before we
  // apply the transition target.
  void row.offsetHeight;
  row.style.transition = 'max-height 0.42s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.32s ease 0.10s';
  row.style.maxHeight = target + 'px';
  row.style.opacity = '1';
  const cleanup = () => {
    row.style.maxHeight = '';
    row.style.opacity = '';
    row.style.overflow = '';
    row.style.transition = '';
  };
  row.addEventListener('transitionend', cleanup, { once: true });
  // Belt-and-braces in case transitionend doesn't fire (display: none,
  // forced reflow, etc.) — clean up after the animation duration.
  setTimeout(cleanup, 600);
}

/** Produce the state-dependent body for plan-related bell rows.
 *
 *  Receiver perspective (the user was invited):
 *    - pending:  "X har invitert deg til Y i morgen kl 12"
 *    - accepted: "Du skal til Y i morgen kl 12 med X +N"
 *    - declined: "Du avslo Xs invitasjon til Y i morgen kl 12"
 *    - past:     "X inviterte deg til Y …" + dim row + "Utgått" meta
 *
 *  Inviter perspective (someone responded to the user's invite):
 *    Detected by notif.id prefix social_invite_accepted_* / _declined_*.
 *    - accepted: "Anna har godtatt invitasjonen til Y i morgen kl 12"
 *    - declined: "Anna har avslått invitasjonen til Y i morgen kl 12"
 *
 *  Returns null when the entry isn't a plan notification — caller
 *  uses the original entry.body as-is.
 */
function _enrichPlanNotificationBody(entry) {
  if (!entry || !entry.nav || entry.nav.kind !== 'plan' || entry.nav.venueId == null) {
    return null;
  }
  // Reminder rows (sql/029 trigger) come pre-rendered with timing-
  // sensitive copy ("Du skal til X om 30 min."). Skip the enrichment
  // so we don't overwrite that with the standard "accepted state"
  // wording from the receiver-perspective branch below.
  if (typeof entry.id === 'string'
      && (entry.id.startsWith('plan_reminder_creator:')
          || entry.id.startsWith('plan_reminder_invitee:'))) {
    return null;
  }

  const venueObj = (typeof VENUES !== 'undefined' && Array.isArray(VENUES))
    ? VENUES.find(v => String(v.id) === String(entry.nav.venueId)) : null;
  const venueName = (venueObj && venueObj.name) || '';
  const venuePart = venueName ? `<strong>${venueName}</strong>` : 'et sted';

  const plannedAt = entry.nav.plannedAt || null;
  const plannedMs = plannedAt ? new Date(plannedAt).getTime() : NaN;
  const dateStr = plannedAt ? plannedAt.slice(0, 10) : '';
  const dayPart = (dateStr && typeof _dayLabel === 'function') ? _dayLabel(dateStr) : '';
  const timePart = !isNaN(plannedMs)
    ? new Date(plannedMs).toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' })
    : '';
  const whenStr = [dayPart, timePart].filter(Boolean).join(' kl ');
  const isPast = !isNaN(plannedMs) && plannedMs < Date.now() - 30 * 60 * 1000;
  const pastClass = isPast ? ' bd-row--past' : '';
  const metaSuffix = isPast ? ' · Utgått' : '';

  // Pull the actor's display name from the existing body. Server-
  // rendered bodies (SQL trigger 022/024) wrap the name in <strong>;
  // client-rendered toast bodies (i18n templates like "{name} sa ja
  // til {venue}") have it as the first whitespace-bounded token. Try
  // both, fall back to "Noen" if neither matches.
  const mStrong = entry.body && entry.body.match(/<strong>([^<]+)<\/strong>/);
  const firstToken = entry.body ? entry.body.split(/\s+/)[0].replace(/^<\w+>/, '').replace(/<\/\w+>$/, '') : '';
  const actorRaw = (mStrong && mStrong[1]) || firstToken || 'Noen';
  const actor = actorRaw.split('@')[0].split(' ')[0];

  // Cancelled plan — written by sql/026 trigger when the creator
  // sets plans.cancelled_at. Render with the actor (creator) as a
  // dimmed past-style row since the plan is no longer happening.
  // CTA still opens the plan-preview in its cancelled state so the
  // invitee can see context.
  if (typeof entry.id === 'string' && entry.id.startsWith('plan_cancelled:')) {
    return {
      body: `<strong>${actor}</strong> kansellerte planen til ${venuePart}${whenStr ? ' ' + whenStr : ''}.`,
      // Always dim — cancelled plans are dead state, regardless of
      // whether the plan time has passed.
      pastClass: ' bd-row--past',
      metaSuffix: ' · Kansellert',
    };
  }

  // Inviter-side notifications — fired by _evalInviteAccepted /
  // _evalInviteDeclined. ID prefix carries the plan_id; look up the
  // live plan to compute the +N tail. User-requested wording:
  //   "Anna +2 har godtatt invitasjonen din til Starbucks i morgen kl 12"
  //   "Anna +1 har avslått invitasjonen din til Starbucks ..."
  // +N excludes the head being named (always the most recent
  // responder), so the total = head + N others. Live because _plans
  // gets refreshed by realtime → loadPlans → bell re-render.
  if (typeof entry.id === 'string' && entry.id.startsWith('social_invite_accepted_')) {
    const planId = entry.id.substring('social_invite_accepted_'.length);
    const plan = (typeof _plans !== 'undefined' && Array.isArray(_plans))
      ? _plans.find(p => p && p.id === planId) : null;
    const total = plan ? (plan._invitees || []).filter(i => i.status === 'accepted').length : 1;
    const extra = Math.max(0, total - 1);
    const tail = extra > 0 ? ` +${extra}` : '';
    return {
      body: `<strong>${actor}</strong>${tail} har godtatt invitasjonen din til ${venuePart}${whenStr ? ' ' + whenStr : ''}.`,
      pastClass,
      metaSuffix,
      // Host quick-cancel — plan still active (not in _plans means
      // already cancelled, so no button needed).
      cancelPlanId: plan ? planId : null,
    };
  }
  if (typeof entry.id === 'string' && entry.id.startsWith('social_invite_declined_')) {
    const planId = entry.id.substring('social_invite_declined_'.length);
    const plan = (typeof _plans !== 'undefined' && Array.isArray(_plans))
      ? _plans.find(p => p && p.id === planId) : null;
    const total = plan ? (plan._invitees || []).filter(i => i.status === 'declined').length : 1;
    const extra = Math.max(0, total - 1);
    const tail = extra > 0 ? ` +${extra}` : '';
    return {
      body: `<strong>${actor}</strong>${tail} har avslått invitasjonen din til ${venuePart}${whenStr ? ' ' + whenStr : ''}.`,
      pastClass,
      metaSuffix,
      cancelPlanId: plan ? planId : null,
    };
  }
  // Creator-side reminder — host gets a quick-cancel here too.
  if (typeof entry.id === 'string' && entry.id.startsWith('plan_reminder_creator:')) {
    const planId = entry.id.substring('plan_reminder_creator:'.length);
    const plan = (typeof _plans !== 'undefined' && Array.isArray(_plans))
      ? _plans.find(p => p && p.id === planId) : null;
    if (plan) {
      return { body: entry.body, pastClass: '', metaSuffix: '', cancelPlanId: planId };
    }
    return null;
  }

  // Receiver perspective — find the user's invite row to read its status.
  // _planInvites is filtered to FUTURE plans only, so past invites fall
  // through to the generic past-tense wording below.
  const myInvite = (typeof _planInvites !== 'undefined' && Array.isArray(_planInvites))
    ? _planInvites.find(inv =>
        inv && inv.plan
        && String(inv.plan.venue_id) === String(entry.nav.venueId)
        && !isNaN(new Date(inv.plan.planned_at).getTime())
        && Math.abs(new Date(inv.plan.planned_at).getTime() - plannedMs) < 60 * 1000)
    : null;

  // Creator name preference: from the embedded plan.creator (live data),
  // else from the actorRaw extracted above (server-rendered text).
  const creatorFromInvite = myInvite && myInvite.plan && myInvite.plan.creator
    && (myInvite.plan.creator.name || myInvite.plan.creator.email) || '';
  const creator = (creatorFromInvite ? creatorFromInvite : actorRaw).split('@')[0].split(' ')[0];

  if (myInvite && myInvite.status === 'accepted') {
    // "+N" = OTHER accepted invitees beyond the inviter implicitly named
    // ("med Malene"). Total accepted (server-counted) includes the user;
    // we exclude self + creator from the "+N" tail. Creator isn't in
    // plan_invites (they're the creator), so total_accepted is invitees
    // who accepted including self.
    const acceptedTotal = myInvite.plan._acceptedCount ?? 0;
    const othersAccepted = Math.max(0, acceptedTotal - 1); // minus self
    const tail = othersAccepted > 0 ? ` +${othersAccepted}` : '';
    // Self-creator guard — if the current user IS the creator of this
    // plan, the "med X" tail would read "med deg selv" (with yourself),
    // which is awkward. Drop the tail entirely; the row just says
    // "Du skal til Y i morgen kl 12" + the +N counter if others are
    // also coming.
    const creatorId = myInvite.plan && myInvite.plan.creator && myInvite.plan.creator.id;
    const isSelfCreator = creatorId && _currentUser && String(creatorId) === String(_currentUser.id);
    const withClause = isSelfCreator ? tail : ` med <strong>${creator}</strong>${tail}`;
    return {
      body: `Du skal til ${venuePart}${whenStr ? ' ' + whenStr : ''}${withClause}.`,
      pastClass,
      metaSuffix,
    };
  }
  if (myInvite && myInvite.status === 'declined') {
    return {
      body: `Du avslo <strong>${creator}</strong>s invitasjon til ${venuePart}${whenStr ? ' ' + whenStr : ''}.`,
      pastClass,
      metaSuffix,
    };
  }

  // Default: pending invite (or past, since past invites are filtered
  // out of _planInvites and we fall through to here).
  const verb = isPast ? 'inviterte' : 'har invitert';
  return {
    body: `<strong>${creator}</strong> ${verb} deg til ${venuePart}${whenStr ? ' ' + whenStr : ''}.`,
    pastClass,
    metaSuffix,
  };
}

/** Push-click deeplink handler. Fired once after the first loadPlans
 *  on auth-ready. Reads URL params written by the SQL triggers'
 *  push payloads ('?nav=plan&v=<id>&t=<iso>&cancelled=<0|1>') and
 *  opens the matching plan-preview. Cleans the URL afterwards so a
 *  refresh doesn't re-open the panel.
 *
 *  Why here and not init.js: openPlanPreview's auto-detect needs
 *  _planInvites populated to resolve mode='invite' for receivers.
 *  Firing after loadPlans guarantees the data is there. */
let _deeplinkHandled = false;
function _maybeHandlePushDeeplink() {
  if (_deeplinkHandled) return;
  _deeplinkHandled = true;
  try {
    const u = new URL(window.location.href);
    const nav = u.searchParams.get('nav');
    if (nav !== 'plan') return;
    const venueId   = u.searchParams.get('v');
    const plannedAt = u.searchParams.get('t');
    const cancelled = u.searchParams.get('cancelled') === '1';
    if (!venueId || !plannedAt) return;
    // Clear the URL params before navigating so a refresh / bookmark
    // doesn't keep re-firing the panel open.
    u.searchParams.delete('nav');
    u.searchParams.delete('v');
    u.searchParams.delete('t');
    u.searchParams.delete('cancelled');
    history.replaceState({}, '', u.toString());
    if (typeof openPlanPreview === 'function') {
      openPlanPreview({ venueId, plannedAt, cancelled });
    }
  } catch (e) { /* malformed URL — fail open */ }
}

/** Host quick-cancel from the inbox row. Two-tap confirm pattern —
 *  matches the Avlys-plan button inside the plan-preview footer. The
 *  first tap turns the × into "Avlys?"; second tap commits via the
 *  existing cancelPlan(). Inline events.stopPropagation is on the
 *  button itself so the row's onclick (which opens the plan-preview)
 *  doesn't fire underneath. */
async function _bellQuickCancel(event, planId) {
  if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  if (!planId) return;
  const btn = event && event.currentTarget;
  if (!btn) return;
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    const original = btn.textContent;
    btn.textContent = 'Avlys?';
    btn.classList.add('bd-row__quick-cancel--armed');
    setTimeout(() => {
      if (btn.dataset.armed === '1') {
        delete btn.dataset.armed;
        btn.textContent = original;
        btn.classList.remove('bd-row__quick-cancel--armed');
      }
    }, 4000);
    return;
  }
  delete btn.dataset.armed;
  btn.disabled = true;
  if (typeof cancelPlan === 'function') {
    await cancelPlan(planId);
    if (typeof _renderBellDropdown === 'function') _renderBellDropdown();
  }
}

/** Bell row → venue detail. Looks up the venue by name in the global
 *  VENUES array and routes through the existing selectVenue handler. */
function _bellOpenVenueByName(name) {
  _closeBellDropdown();
  if (!name || typeof VENUES === 'undefined' || !Array.isArray(VENUES)) return;
  // Decode HTML entities the sample HTML uses (Hummus &amp; Wine → ...)
  const decoded = name.replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  const target = decoded.trim().toLowerCase();
  const v = VENUES.find(v => v.name && v.name.toLowerCase() === target);
  if (v && typeof selectVenue === 'function') {
    selectVenue(Number(v.id), true);
  }
}

/** Bell row → friends list. */
function _bellOpenFriendsModal() {
  _closeBellDropdown();
  if (typeof openFriendsModal === 'function') openFriendsModal();
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

  // Friend name/email/avatar_url all flow in from another user's profile,
  // so every interpolation into innerHTML or an attribute is escaped.
  const friendsHtml = _friends.length
    ? _friends.map(f => {
        const label = f.name || f.email;
        const avatar = f.avatar_url
          ? `<img class="friend-avatar" src="${_esc(f.avatar_url)}" alt="${_esc(label)}">`
          : `<div class="friend-avatar friend-avatar-initials">${_esc((label || '?')[0].toUpperCase())}</div>`;
        // Check if friend is checked in somewhere
        let checkinInfo = '';
        for (const [vid, list] of _friendCheckins) {
          const match = list.find(c => c.user.id === f.id);
          if (match) {
            const vName = typeof VENUES !== 'undefined' ? (VENUES.find(v => String(v.id) === vid)?.name || vid) : vid;
            const until = new Date(match.checkin.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            checkinInfo = `<div class="friend-checkin-info">📍 ${_esc(vName)} · ${_esc(t('checked_in_until', { time: until }))}</div>`;
            break;
          }
        }
        // Confirm before remove — accidental ✕ taps in a small list
        // shouldn't quietly tear down a friendship. The modal re-render
        // is awaited inside _confirmRemoveFriend so we don't race the
        // async delete.
        // Second arg to _confirmRemoveFriend goes through JSON.stringify (a
        // valid JS string literal) then _esc to make the resulting `"` chars
        // attribute-safe inside the outer onclick="…".
        const labelArg = _esc(JSON.stringify(label || ''));
        return `<div class="friend-item">
          <div class="friend-item-left">${avatar}<div class="friend-item-info"><div class="friend-item-name">${_esc(label)}</div>${checkinInfo}</div></div>
          <button class="btn-icon-sm friend-remove" onclick="_confirmRemoveFriend('${_esc(f.friendshipId)}', ${labelArg})" title="${_esc(t('friend_remove_title'))}">✕</button>
        </div>`;
      }).join('')
    : `<div class="friends-empty">${_esc(t('no_friends_yet'))}</div>`;

  const pendingHtml = _pendingRequests.length
    ? `<div class="friends-section-label">${_esc(t('friend_requests'))} (${_pendingRequests.length})</div>` +
      _pendingRequests.map(r => {
        const label = r.name || r.email;
        const avatar = r.avatar_url
          ? `<img class="friend-avatar" src="${_esc(r.avatar_url)}" alt="${_esc(label)}">`
          : `<div class="friend-avatar friend-avatar-initials">${_esc((label || '?')[0].toUpperCase())}</div>`;
        return `<div class="friend-item friend-request">
          ${avatar}
          <div class="friend-item-info"><div class="friend-item-name">${_esc(label)}</div></div>
          <div class="friend-item-actions">
            <button class="btn-accept" onclick="_handleAcceptFriendRequest('${_esc(r.friendshipId)}')">${_esc(t('plan_accept'))}</button>
            <button class="btn-icon-sm friend-remove" onclick="_handleRejectFriendRequest('${_esc(r.friendshipId)}')" title="${_esc(t('friend_reject_title'))}">✕</button>
          </div>
        </div>`;
      }).join('')
    : '';

  modal.innerHTML = `
    <div class="friends-modal-card glass-panel">
      <div class="friends-modal-header">
        <h3>${_esc(t('friends'))}</h3>
        <button class="friends-modal-close" onclick="closeFriendsModal()">✕</button>
      </div>
      ${pendingHtml}
      <div class="friends-section-label">${_esc(t('friends'))}${_friends.length ? ` (${_friends.length})` : ''}</div>
      ${friendsHtml}
      <div class="friends-add-section">
        <div class="friends-section-label">${_esc(t('add_friend'))}</div>
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

// Realtime: keep the admin-suggestions badge fresh without re-polling on
// every profile-panel open. Subscribe once per admin session.
let _suggestionsChannel = null;
function _subscribeSuggestionsRealtime() {
  if (_suggestionsChannel) return;
  if (typeof _supabase === 'undefined' || !authIsAdmin()) return;
  _suggestionsChannel = _supabase
    .channel('admin-suggestions')
    .on('postgres_changes', {
      event:  '*',
      schema: 'public',
      table:  'suggested_venues',
    }, () => _loadVenueSuggestionsCount())
    .subscribe();
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
  if (typeof _aTrack === 'function') _aTrack('admin_suggestion_review', { id, action: 'approved' });
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
  if (typeof _aTrack === 'function') _aTrack('admin_suggestion_review', { id, action: 'rejected' });
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
  _userStateMerge(data.state || {});
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
  if (typeof update === 'function') update();
}

async function saveUserPreference(key, value) {
  if (!_currentUser) return;
  const row = { user_id: _currentUser.id, updated_at: new Date().toISOString() };
  row[key] = value;
  await _supabase.from('user_preferences').upsert(row, { onConflict: 'user_id' });
  if (typeof _aTrack === 'function') _aTrack('preference_change', { key, value });
}

// ── Cross-device UI state (user_preferences.state JSONB) ────────────────────
// Holds dismissed UI prompts + per-friend visibility toggles + anything
// else we want to survive across devices without its own column.
// localStorage stays as the fast local cache; we merge on auth load.
let _userState = {};

function _userStateMerge(remote) {
  const localHidden = (() => {
    try { return JSON.parse(localStorage.getItem('hidden_checkin_friends') || '[]'); }
    catch { return []; }
  })();
  const localDismissed = (() => {
    try { return JSON.parse(localStorage.getItem('solsteder_dismissed_friend_prompts') || '[]'); }
    catch { return []; }
  })();
  const remoteHidden = Array.isArray(remote.hiddenCheckinFriends) ? remote.hiddenCheckinFriends : [];
  const remoteDismissed = Array.isArray(remote.dismissedFriendPrompts) ? remote.dismissedFriendPrompts : [];
  const mergedHidden = [...new Set([...remoteHidden, ...localHidden])];
  const mergedDismissed = [...new Set([...remoteDismissed, ...localDismissed])];

  _userState = { ...remote, hiddenCheckinFriends: mergedHidden, dismissedFriendPrompts: mergedDismissed };

  _hiddenCheckinFriends = new Set(mergedHidden);
  localStorage.setItem('hidden_checkin_friends', JSON.stringify(mergedHidden));
  localStorage.setItem('solsteder_dismissed_friend_prompts', JSON.stringify(mergedDismissed));

  // If the merge added local values the server didn't have, push back.
  if (mergedHidden.length !== remoteHidden.length || mergedDismissed.length !== remoteDismissed.length) {
    _persistUserState();
  }
}

async function _persistUserState() {
  if (!_currentUser || typeof _supabase === 'undefined') return;
  try {
    await _supabase.from('user_preferences').upsert({
      user_id: _currentUser.id,
      state: _userState,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  } catch { /* fire-and-forget */ }
}

function userStateAddDismissedPrompt(inviterId) {
  if (!Array.isArray(_userState.dismissedFriendPrompts)) _userState.dismissedFriendPrompts = [];
  if (!_userState.dismissedFriendPrompts.includes(inviterId)) {
    _userState.dismissedFriendPrompts.push(inviterId);
    _persistUserState();
  }
}

function toggleCheckinVisibility(friendId) {
  if (_hiddenCheckinFriends.has(friendId)) {
    _hiddenCheckinFriends.delete(friendId);
  } else {
    _hiddenCheckinFriends.add(friendId);
  }
  const arr = [..._hiddenCheckinFriends];
  localStorage.setItem('hidden_checkin_friends', JSON.stringify(arr));
  _userState.hiddenCheckinFriends = arr;
  _persistUserState();
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
  // Two-step fetch: friendships first, then resolve profiles for the
  // "other side" of each row. The previous embed via
  // profiles!friendships_user_id_fkey was returning null silently
  // because the FK on friendships points at auth.users, not profiles.
  const { data: rows, error } = await _supabase
    .from('friendships')
    .select('id, user_id, friend_id, status, created_at')
    .or(`user_id.eq.${_currentUser.id},friend_id.eq.${_currentUser.id}`);
  if (error) {
    console.warn('[auth] loadFriends failed:', error.message);
  } else {
    const otherIds = new Set();
    for (const r of (rows || [])) {
      otherIds.add(r.user_id === _currentUser.id ? r.friend_id : r.user_id);
    }
    let profilesById = new Map();
    if (otherIds.size > 0) {
      const { data: profs, error: profErr } = await _supabase
        .from('profiles')
        .select('id, name, email, avatar_url')
        .in('id', [...otherIds]);
      if (profErr) {
        console.warn('[auth] loadFriends profile fetch failed:', profErr.message);
      } else {
        for (const p of (profs || [])) profilesById.set(p.id, p);
      }
    }
    _friends = [];
    _pendingRequests = [];
    for (const r of (rows || [])) {
      const otherId = r.user_id === _currentUser.id ? r.friend_id : r.user_id;
      const other = profilesById.get(otherId)
                 || { id: otherId, name: null, email: null, avatar_url: null };
      if (r.status === 'accepted') {
        _friends.push({ ...other, friendshipId: r.id });
      } else if (r.status === 'pending' && r.friend_id === _currentUser.id) {
        _pendingRequests.push({ ...other, friendshipId: r.id });
      }
    }
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
  // Route through the SECURITY DEFINER RPC instead of SELECTing profiles
  // directly. Lets sql/039 revoke SELECT(email) without breaking add-friend
  // by email — the RPC is the only path that resolves the lookup.
  const { data, error } = await _supabase.rpc('request_friend_by_email', { p_email: email });
  if (error) return { error: error.message };
  if (!data || !data.ok) {
    const errMap = {
      not_found:         'User not found',
      self:              'Cannot add yourself',
      already_exists:    'Already friends or pending request',
      invalid_email:     'Invalid email',
      not_authenticated: 'Not signed in',
    };
    return { error: errMap[data?.error] || 'Cannot send friend request' };
  }
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
  if (typeof _aTrack === 'function') _aTrack('checkin', { venueId: vid, hasMessage: !!message });
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
  const vid = _myCheckin.venue_id;
  await _supabase.from('checkins').delete().eq('id', _myCheckin.id);
  if (typeof _aTrack === 'function') _aTrack('checkout', { venueId: vid });
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
  // user isn't waiting up to 60 s after coming back to the app. Plus a
  // realtime resubscribe — if the websocket dropped silently while the
  // tab was backgrounded (some browsers throttle/close inactive sockets
  // after a few minutes), the next message wouldn't arrive. Re-binding
  // the channels on resume catches that.
  if (typeof document !== 'undefined' && !_socialVisibilityWired) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      _socialPollTick();
      try {
        if (typeof _subscribeToPlanInvites === 'function') _subscribeToPlanInvites();
        if (typeof _subscribeToFriendships === 'function') _subscribeToFriendships();
      } catch { /* re-bind failures fall back to poll */ }
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
  // Filter cancelled plans out of the creator's active list — they
  // shouldn't appear in friends-going pills, plan-preview suggestions,
  // or the conflict-detection logic. The cancellation notification
  // already informs invitees; the row stays in plans for that flow.
  if (!pe) _plans = (plans || []).filter(p => !p.cancelled_at);

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
  // _planInvites holds the user's invitations for FUTURE, NON-CANCELLED
  // plans. Cancelled plans get their own bell notification (sql/026
  // trigger) and the invitee can still open the plan-preview in
  // cancelled state via that row's CTA — but they don't appear in
  // active-plan UI surfaces (avatar badge, friends-going pill, etc.).
  if (!ie) _planInvites = (invites || []).filter(i =>
    i.plan
    && new Date(i.plan.planned_at) > new Date()
    && !i.plan.cancelled_at);

  // Decorate each invite's plan with _acceptedCount so the bell-inbox
  // "Du skal til X med Y +N" wording has a live counter. Uses the
  // SECURITY DEFINER helper plan_accepted_counts (migration 025) which
  // bypasses plan_invites RLS (otherwise an invitee can only count
  // their own row, not others' accepted statuses). One RPC for all
  // invites; cheap.
  if (_planInvites.length) {
    const planIds = _planInvites.map(i => i.plan.id).filter(Boolean);
    if (planIds.length) {
      try {
        const { data: counts } = await _supabase.rpc('plan_accepted_counts', { plan_ids: planIds });
        if (Array.isArray(counts)) {
          const byPlan = new Map(counts.map(c => [c.plan_id, c.count]));
          for (const inv of _planInvites) {
            if (inv.plan) inv.plan._acceptedCount = byPlan.get(inv.plan.id) ?? 0;
          }
        }
      } catch (e) { /* RPC unavailable on first paint — bell render falls back to 0 */ }
    }
  }
  // Refresh the friends-going pill — _plans / _planInvites just changed
  // and the visible pill should reflect new accept/decline data. Same
  // for the avatar badge, which lights up on pending plan invites.
  if (typeof _updateFriendsPill === 'function') _updateFriendsPill();
  if (typeof _updateAvatarBadge === 'function') _updateAvatarBadge();
  if (typeof _renderProfilePanel === 'function') _renderProfilePanel();
  // Bell-inbox live update — if the user has the dropdown open while
  // a new accept/decline lands (realtime → loadPlans → here), repaint
  // the rows so "Anna +N" reflects the fresh count without requiring
  // a close+reopen.
  if (document.getElementById('bell-dropdown')?.classList.contains('open')
      && typeof _renderBellDropdown === 'function') {
    _renderBellDropdown();
  }
}

async function createPlan(venueId, plannedAt, message, friendIds) {
  if (!_currentUser) { toggleProfilePanel(); return; }
  if (typeof _aTrack === 'function') _aTrack('plan_created', { venue_id: venueId, invites: friendIds?.length ?? 0 });

  // Look up the venue once — used for opening-hours validation, for the
  // denormalized venue_name we now write to the row (so the push-notif
  // trigger can include it in the body), and for the closed-time
  // toast copy if validation rejects.
  const venue = (typeof VENUES !== 'undefined' && Array.isArray(VENUES))
    ? VENUES.find(v => String(v.id) === String(venueId)) : null;

  // Opening-hours validation. Reject plans for times the venue is
  // closed — both because the receiver can't actually go (so the
  // invite is misleading), AND because the plan-preview timeline's
  // closed-hours dim band reads as a confusing dark zone on the bar.
  // Skipped when we can't resolve hours (no VENUES yet, or the venue
  // has no openingHours data) — we'd rather allow the plan than block
  // it on missing data.
  if (venue && typeof getVenueHoursForDay === 'function' && plannedAt) {
    try {
      const planTime = new Date(plannedAt);
      const dateStr  = `${planTime.getFullYear()}-${String(planTime.getMonth() + 1).padStart(2, '0')}-${String(planTime.getDate()).padStart(2, '0')}`;
      const planHour = planTime.getHours() + planTime.getMinutes() / 60;
      const dayHours = getVenueHoursForDay(venue, dateStr);
      if (dayHours && Number.isFinite(dayHours.open) && Number.isFinite(dayHours.close)
          && dayHours.close > dayHours.open
          && (planHour < dayHours.open || planHour >= dayHours.close)) {
        const fmt = (h) => {
          const hh = Math.floor(h);
          const mm = Math.round((h - hh) * 60);
          return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        };
        const msg = `Stedet er stengt kl ${fmt(planHour)}. Åpent kl ${fmt(dayHours.open)}–${fmt(dayHours.close)}.`;
        console.warn('[plans] createPlan rejected: closed-hour time', { venueId, plannedAt, planHour, dayHours });
        if (typeof _showToast === 'function') _showToast(msg);
        return { error: 'closed_hours', message: msg };
      }
    } catch (e) { /* ignore — don't block creation on a validation crash */ }
  }

  const { data: plan, error } = await _supabase.from('plans').insert({
    creator_id: _currentUser.id,
    venue_id: String(venueId),
    venue_name: (venue && venue.name) || null,
    planned_at: plannedAt,
    message: message || ''
  }).select().single();
  if (error || !plan) {
    console.error('[plans] createPlan failed:', error?.message, error);
    if (typeof _showToast === 'function') _showToast('Kunne ikke lage plan: ' + (error?.message || 'ukjent feil'));
    return { error: error?.message || 'Failed to create plan' };
  }
  console.info('[plans] created', plan.id, plan);
  // Create invites
  if (friendIds && friendIds.length) {
    const invites = friendIds.map(fid => ({ plan_id: plan.id, user_id: fid, status: 'pending' }));
    const { data: invRows, error: invErr } = await _supabase
      .from('plan_invites')
      .insert(invites)
      .select();
    if (invErr) {
      console.error('[plans] plan_invites insert failed:', invErr.message, invErr);
      if (typeof _showToast === 'function') _showToast('Plan laget, men kunne ikke invitere venner: ' + invErr.message);
    } else {
      console.info('[plans] invited', invRows);
    }
  }
  await loadPlans();
  _showToast(t('plan_created'));
  return { success: true, plan };
}

/** Host cancels a plan. Soft-cancel: sets plans.cancelled_at, which
 *  fires the DB triggers (sql/026) — invitees get a notifications-row
 *  + push: "X kansellerte planen til Y …". The row stays in plans so
 *  invitees can still open the cancelled plan-preview for context;
 *  active-plan lists in the UI filter it out.
 *
 *  RLS allows UPDATE only by the creator (per migration 026), so this
 *  fails clean if a non-creator somehow calls it. */
async function cancelPlan(planId) {
  if (!_currentUser || !planId) return { error: 'invalid' };
  if (typeof _aTrack === 'function') _aTrack('plan_cancelled', { plan_id: planId });
  const { error } = await _supabase
    .from('plans')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', planId)
    .eq('creator_id', _currentUser.id);
  if (error) {
    console.error('[plans] cancelPlan failed:', error.message, error);
    if (typeof _showToast === 'function') _showToast('Kunne ikke kansellere: ' + error.message);
    return { error: error.message };
  }
  await loadPlans();
  if (typeof _showToast === 'function') _showToast('Planen er kansellert.');
  return { success: true };
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
      // Recipient-side INSERT. Two semantic changes vs. the old version:
      // 1. status='pending', not 'accepted'. The sql/036 RLS now rejects
      //    recipient-side inserts that land at 'accepted' — without inviter
      //    consent it was an enumeration / cross-user-friendship-spoof vector.
      // 2. Row direction flipped (user_id=me, friend_id=inviter) so the
      //    actor is the requester. notify_friend_request fires on inserts
      //    with status='pending' and pushes NEW.friend_id (the inviter),
      //    which is the desired "X clicked your share link" notification.
      //    The inviter accepts via the regular friend-request UI.
      await _supabase.from('friendships').insert({
        user_id: me.id,
        friend_id: inviterId,
        status: 'pending',
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
    loadPlans().then(() => _maybeHandlePushDeeplink());
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
    // Clear admin-only caches so a previous admin's reviewed-edits /
    // suggestions / users data doesn't render to a freshly-logged-in
    // non-admin (or stay visible after a role demotion).
    _adminEditsCache = null;
    _adminSuggestionsCache = null;
    _adminUsersCache = null;
    // Bell state used to be cleared only by the authSignOut() wrapper. When
    // sign-out came from token expiry or another tab the bell history stayed
    // populated and the next user signing in on this browser inherited it.
    // Centralize the cleanup here so every SIGNED_OUT path goes through it.
    if (typeof _bellUnsubscribeRealtime === 'function') _bellUnsubscribeRealtime();
    _bellHistory.clear();
    _bellHydrated = false;
    if (_bellRenderedRows && typeof _bellRenderedRows.clear === 'function') _bellRenderedRows.clear();
    // Social-tables probe is per-session not per-user, but resetting on
    // sign-out forces a re-probe under the new user's permissions — the
    // legitimate case where probe results could meaningfully differ.
    _socialTablesReady = null;
    if (_checkinSubscription)     { _checkinSubscription.unsubscribe();     _checkinSubscription = null; }
    if (_planInvitesSubscription) { _planInvitesSubscription.unsubscribe(); _planInvitesSubscription = null; }
    if (_friendshipsSubscription) { _friendshipsSubscription.unsubscribe(); _friendshipsSubscription = null; }
    if (_suggestionsChannel)      { try { _suggestionsChannel.unsubscribe(); } catch { /* idempotent */ } _suggestionsChannel = null; }
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
