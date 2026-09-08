CREATE TABLE IF NOT EXISTS farmer_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  country_code TEXT NOT NULL,
  full_name TEXT,
  preferred_language TEXT,
  phone_verified BOOLEAN NOT NULL DEFAULT TRUE,
  phone_email_user_id TEXT,
  onboarding_completed BOOLEAN NOT NULL DEFAULT FALSE,
  profile_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT farmer_profiles_phone_unique UNIQUE (phone_number, country_code),
  CONSTRAINT farmer_profiles_phone_email_unique UNIQUE (phone_email_user_id)
);

CREATE INDEX IF NOT EXISTS idx_farmer_profiles_phone_email_user_id
  ON farmer_profiles (phone_email_user_id);

ALTER TABLE farmer_profiles ENABLE ROW LEVEL SECURITY;

-- The backend uses the Supabase service role and performs ownership checks.
-- Do not add a public policy that exposes farmer_profiles to the Flutter app.