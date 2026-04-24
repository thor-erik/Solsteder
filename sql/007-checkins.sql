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
