-- Friends list tiers: untrusted -> nontechnical (default), trusted -> technical.
-- Invites carry the tier a friend gets on first login. Idempotent.
-- NOTE: the old tier CHECK must go first, or the remap UPDATEs violate it.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;
UPDATE users SET tier = 'nontechnical' WHERE tier = 'untrusted';
UPDATE users SET tier = 'technical' WHERE tier = 'trusted';
ALTER TABLE users ADD CONSTRAINT users_tier_check
  CHECK (tier IN ('nontechnical','technical'));
ALTER TABLE invites ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'nontechnical'
  CHECK (tier IN ('nontechnical','technical'));
-- Refresh seeded showcase personas to the new tiers (stable ids; OAuth users untouched).
UPDATE users SET tier = 'nontechnical' WHERE id = 'alice';
UPDATE users SET tier = 'technical' WHERE id IN ('bob', 'operator');
