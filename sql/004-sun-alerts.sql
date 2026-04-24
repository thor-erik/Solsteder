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
