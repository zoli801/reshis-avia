CREATE TABLE IF NOT EXISTS telegram_login_challenges (
  code_hash TEXT PRIMARY KEY NOT NULL,
  browser_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  telegram_id INTEGER,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  consumed_at INTEGER,
  verification_code TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS telegram_login_challenges_expiry ON telegram_login_challenges(expires_at);
