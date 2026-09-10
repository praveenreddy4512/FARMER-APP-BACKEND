CREATE TABLE IF NOT EXISTS farms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_profile_id UUID NOT NULL REFERENCES farmer_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_profile_id UUID NOT NULL REFERENCES farmer_profiles(id) ON DELETE CASCADE, farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL, variety TEXT, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_profile_id UUID NOT NULL REFERENCES farmer_profiles(id) ON DELETE CASCADE, farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE, crop_id UUID REFERENCES crops(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0), currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'), category TEXT NOT NULL, description TEXT, expense_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crop_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_profile_id UUID NOT NULL REFERENCES farmer_profiles(id) ON DELETE CASCADE, farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE, crop_id UUID NOT NULL REFERENCES crops(id) ON DELETE CASCADE,
  condition TEXT NOT NULL, growth_stage TEXT, pest_observation TEXT, disease_observation TEXT, notes TEXT, update_date DATE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_profile_id UUID NOT NULL REFERENCES farmer_profiles(id) ON DELETE CASCADE, farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE, crop_id UUID REFERENCES crops(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0), period TEXT NOT NULL CHECK (period IN ('total', 'season', 'crop')), start_date DATE NOT NULL, end_date DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), farmer_profile_id UUID NOT NULL REFERENCES farmer_profiles(id) ON DELETE CASCADE, farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE, crop_id UUID REFERENCES crops(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT, event_date DATE NOT NULL, reminder_date DATE, completed BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_farms_owner ON farms(farmer_profile_id);
CREATE INDEX IF NOT EXISTS idx_crops_farm ON crops(farm_id);
CREATE INDEX IF NOT EXISTS idx_expenses_owner_date ON expenses(farmer_profile_id, farm_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_updates_owner_date ON crop_updates(farmer_profile_id, farm_id, update_date);
CREATE INDEX IF NOT EXISTS idx_events_owner_date ON calendar_events(farmer_profile_id, farm_id, event_date);
CREATE INDEX IF NOT EXISTS idx_budgets_owner ON budgets(farmer_profile_id, farm_id);
DO $$ DECLARE table_name TEXT; BEGIN FOREACH table_name IN ARRAY ARRAY['farms','crops','expenses','crop_updates','budgets','calendar_events'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name); END LOOP; END $$;