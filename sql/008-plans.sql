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
