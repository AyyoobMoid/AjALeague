-- AJA League — Sidebet support migration
-- Adds Over/Under (totals) and Both Teams To Score (BTTS) markets.
-- Run this ONCE against the AJA database before deploying the sidebet code.

-- 1. Matches: store the sidebet odds + the totals line
ALTER TABLE matches ADD COLUMN IF NOT EXISTS total_line     NUMERIC;       -- e.g. 2.5
ALTER TABLE matches ADD COLUMN IF NOT EXISTS odds_over      NUMERIC;       -- Over the line
ALTER TABLE matches ADD COLUMN IF NOT EXISTS odds_under     NUMERIC;       -- Under the line
ALTER TABLE matches ADD COLUMN IF NOT EXISTS odds_btts_yes  NUMERIC;       -- Both teams score: Yes
ALTER TABLE matches ADD COLUMN IF NOT EXISTS odds_btts_no   NUMERIC;       -- Both teams score: No

-- 2. Predictions: tag each bet with its market type.
--    'moneyline' = existing team/draw bet (default keeps old rows working)
--    'total'     = Over/Under; selected_team holds 'OVER' or 'UNDER'
--    'btts'      = Both Teams To Score; selected_team holds 'YES' or 'NO'
ALTER TABLE predictions ADD COLUMN IF NOT EXISTS bet_type VARCHAR(20) NOT NULL DEFAULT 'moneyline';

-- 3. Allow one bet per market per match per user (instead of one bet per match).
--    Drop any old unique constraint on (user_id, match_id) if it exists, then add the new one.
--    (If your schema has no such constraint, the DROP is a harmless no-op.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'predictions_user_id_match_id_key'
  ) THEN
    ALTER TABLE predictions DROP CONSTRAINT predictions_user_id_match_id_key;
  END IF;
END $$;

-- Add the new composite uniqueness: one bet per (user, match, bet_type).
-- Wrapped in a guard so re-running is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'predictions_user_match_type_key'
  ) THEN
    ALTER TABLE predictions
      ADD CONSTRAINT predictions_user_match_type_key UNIQUE (user_id, match_id, bet_type);
  END IF;
END $$;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'matches' AND column_name LIKE 'odds_%' OR column_name = 'total_line'
ORDER BY column_name;
