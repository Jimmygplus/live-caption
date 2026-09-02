CREATE TABLE IF NOT EXISTS trial_codes (
  code_hash TEXT PRIMARY KEY,
  campaign TEXT NOT NULL,
  max_redemptions INTEGER NOT NULL DEFAULT 1 CHECK (max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  expires_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_redemptions (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  campaign TEXT NOT NULL,
  client_reference_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'issued', 'upstream_failed')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (code_hash) REFERENCES trial_codes(code_hash)
);

CREATE INDEX IF NOT EXISTS trial_redemptions_code_created
  ON trial_redemptions(code_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS trial_rate_limits (
  identity_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  PRIMARY KEY (identity_hash, window_start)
);

CREATE INDEX IF NOT EXISTS trial_rate_limits_window
  ON trial_rate_limits(window_start);
