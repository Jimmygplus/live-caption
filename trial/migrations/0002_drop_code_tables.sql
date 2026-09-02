-- Trial codes became shared passwords held in a Worker secret, so there is no
-- per-code state left to keep: no issuing, no redeeming, no revoking. Spend is
-- bounded by the daily counter, which lives in trial_rate_limits.
DROP TABLE IF EXISTS trial_redemptions;
DROP TABLE IF EXISTS trial_codes;
