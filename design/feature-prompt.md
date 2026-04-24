# Feature Implementation Prompt

This prompt is for a separate Claude Code session. Copy everything below the line.

---

I need you to build four interconnected features for Shades (findshades.app), a solar-optimized venue finder for Oslo. Read CLAUDE.md first for the full file map and workflow.

## Context

The app uses Supabase for auth (Google, Apple, magic link) — see `js/auth.js`. Auth state is managed via `_currentUser`, `authCurrentUser()`, etc. The app is pure frontend with no build step. All data goes through Supabase (Postgres + realtime).

Login is now optional on web — users can browse freely. These features should prompt login only when the user tries to use them (lazy auth). On native (Capacitor), login happens at app launch.

Use `Capacitor.isNativePlatform()` (from `@capacitor/core`) to detect native vs web context. The Capacitor JS bridge is already available via the npm setup.

## Feature 1: Favorites

**Goal:** Users can save venues and quickly access them.

**Database:**
```sql
CREATE TABLE favorites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  venue_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, venue_id)
);
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own favorites" ON favorites
  FOR ALL USING (auth.uid() = user_id);
```

**UI:**
- Heart icon on venue cards in the list (top-right corner)
- Heart icon in the detail panel header, next to the share button
- Filled heart = favorited, outline = not favorited
- Tapping heart when not logged in → open profile panel with login options
- Filter pill in the filter bar: "Favoritter" — shows only favorited venues
- Favorites should be loaded on auth state change and cached in memory (a `Set` of venue IDs)

**Files to modify:** `js/ui-list.js` (cards), `js/ui-detail.js` (detail panel), `js/app.js` (filter logic), `js/auth.js` (new Supabase queries + favorites cache), `index.html` (filter pill + heart icon CSS)

## Feature 2: Sun Alerts (Sol-varsler)

**Goal:** Notify users when sun is about to hit their favorite venues.

**Database:**
```sql
CREATE TABLE sun_alerts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  venue_id text NOT NULL,
  notify_minutes_before int DEFAULT 30,
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, venue_id)
);
ALTER TABLE sun_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own alerts" ON sun_alerts
  FOR ALL USING (auth.uid() = user_id);
```

**UI:**
- Bell icon next to the heart in the detail panel
- Tapping bell opens a small popover: "Varsle meg 30 min før sol" with a toggle
- Bell is filled/highlighted when alert is active
- Tapping bell when not logged in → open profile panel with login options

**Push notifications (native only):**
- Use `@capacitor/push-notifications` plugin
- Register for push on login, store FCM/APNs token in a `push_tokens` table in Supabase
- Actual push delivery will need a Supabase Edge Function (or cron) that checks sun times against alerts — this can be a follow-up. For now, build the UI and data layer.

**Web fallback:**
- Use the Notification API (`Notification.requestPermission()`) if available
- If not available, show a note: "Push-varsler er kun tilgjengelig i appen"

**i18n keys needed:** `sun_alert_on`, `sun_alert_off`, `sun_alert_label`, `sun_alert_minutes` — all four languages (en, no, se, dk)

**Files to modify:** `js/ui-detail.js` (bell icon + popover), `js/auth.js` (Supabase queries), `js/i18n.js` (translations), `index.html` (CSS for bell + popover)

## Feature 3: Friends — See Where Friends Are + Share Plans

**Goal:** See which friends are at sunny spots, and share plans to meet up.

### 3a: Friend system

**Database:**
```sql
CREATE TABLE friendships (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  friend_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  status text CHECK (status IN ('pending', 'accepted', 'blocked')) DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, friend_id)
);
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own friendships" ON friendships
  FOR SELECT USING (auth.uid() = user_id OR auth.uid() = friend_id);
CREATE POLICY "Users create friend requests" ON friendships
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own friendships" ON friendships
  FOR UPDATE USING (auth.uid() = user_id OR auth.uid() = friend_id);
```

### 3b: Location sharing (check-ins)

**Database:**
```sql
CREATE TABLE checkins (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  venue_id text NOT NULL,
  message text DEFAULT '',
  expires_at timestamptz DEFAULT (now() + interval '3 hours'),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Friends see active checkins" ON checkins
  FOR SELECT USING (
    expires_at > now() AND (
      auth.uid() = user_id OR
      EXISTS (
        SELECT 1 FROM friendships
        WHERE status = 'accepted'
        AND ((user_id = auth.uid() AND friend_id = checkins.user_id)
          OR (friend_id = auth.uid() AND user_id = checkins.user_id))
      )
    )
  );
CREATE POLICY "Users manage own checkins" ON checkins
  FOR ALL USING (auth.uid() = user_id);
```

### 3c: Share plans

**Database:**
```sql
CREATE TABLE plans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  creator_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  venue_id text NOT NULL,
  planned_at timestamptz NOT NULL,
  message text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE plan_invites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id uuid REFERENCES plans(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  status text CHECK (status IN ('pending', 'accepted', 'declined')) DEFAULT 'pending',
  UNIQUE(plan_id, user_id)
);
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Creator and invitees see plans" ON plans
  FOR SELECT USING (
    auth.uid() = creator_id OR
    EXISTS (SELECT 1 FROM plan_invites WHERE plan_id = plans.id AND user_id = auth.uid())
  );
CREATE POLICY "Users create plans" ON plans
  FOR INSERT WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "Invitees see own invites" ON plan_invites
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Plan creator manages invites" ON plan_invites
  FOR ALL USING (
    EXISTS (SELECT 1 FROM plans WHERE id = plan_id AND creator_id = auth.uid())
  );
CREATE POLICY "Invitees update own status" ON plan_invites
  FOR UPDATE USING (auth.uid() = user_id);
```

**UI:**

*Friends list (in profile panel):*
- New section in profile panel: "Venner" with count
- Tapping opens a friends modal with: friend list, pending requests, "Add friend" (search by email)
- Each friend shows avatar, name, and current venue if checked in

*Check-in:*
- "Jeg er her" button in the detail panel (next to share button)
- Tapping creates a check-in that expires in 3 hours
- Shows a small badge on the venue card/pin if friends are checked in there
- Friend avatars shown on map pins where friends are checked in (small avatar dots below the pin)

*Share plan:*
- "Planlegg" button in detail panel
- Opens a small form: pick time, add message, select friends to invite
- Friends get a notification (if push is set up) or see it in their friend list
- Plan shows as a special badge on the venue card with time

**i18n keys needed:** `friends`, `add_friend`, `friend_requests`, `pending`, `check_in`, `checked_in_until`, `plan_invite`, `plan_create`, `plan_accept`, `plan_decline`, `no_friends_yet`, `friend_search_placeholder`, `friend_request_sent`, `im_here` — all four languages

**Files to modify:** `js/auth.js` (friend queries, checkin queries, plan queries), `js/ui-detail.js` (check-in + plan buttons), `js/ui-list.js` (friend badges on cards), `js/render-pins.js` (friend avatars on pins), `js/i18n.js`, `index.html` (CSS for friend UI, modals, badges)

## Feature 4: Account Sync (Cross-Device Preferences)

**Goal:** User preferences follow them across devices.

**Database:**
```sql
CREATE TABLE user_preferences (
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  lang text DEFAULT 'no',
  temp_unit text DEFAULT 'C',
  default_area text DEFAULT '',
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own preferences" ON user_preferences
  FOR ALL USING (auth.uid() = user_id);
```

**Behavior:**
- On login: fetch preferences from Supabase → apply to app (override localStorage)
- On preference change: save to both localStorage (immediate) and Supabase (async)
- On logout: keep localStorage values (don't clear)
- Conflict resolution: Supabase wins on login (cloud is source of truth)

**What to sync:** `pref_lang`, `pref_temp`, and default area filter. Do NOT sync date/time slider state.

**Files to modify:** `js/i18n.js` (hook into `setPrefLang`, `setPrefTempUnit`), `js/auth.js` (load/save prefs on auth state change), `js/app.js` (area filter sync)

## Implementation notes

- All features require login. When a non-logged-in user taps a gated action (heart, bell, check-in, plan), open the profile panel with login options rather than showing an inline login gate.
- Use Supabase Realtime subscriptions for friend checkins — friends appearing/disappearing should update live without page refresh.
- Keep the UI consistent with the existing design system: dark theme, `var(--text)`, `var(--muted)`, `var(--accent)`, Inter font, 8px border-radius, glassmorphism panels.
- Add all SQL to `sql/` directory as migration files (e.g., `sql/003-favorites.sql`, `sql/004-sun-alerts.sql`, etc.).
- Follow the existing i18n pattern in `js/i18n.js` — add keys to all four language objects (en, no, se, dk).
