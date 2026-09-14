-- Moderation audit trail: who did what to whom and when. Idempotent.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL
    CHECK (action IN ('approve','reject','classification')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_actions_target_user_id_idx
  ON moderation_actions(target_user_id);
CREATE INDEX IF NOT EXISTS moderation_actions_created_at_idx
  ON moderation_actions(created_at DESC);
