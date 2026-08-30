/**
 * Run once to create the Supabase table.
 * node src/setup.js
 */
require('dotenv').config();
const { supabase } = require('./supabase');

const SQL = `
-- Prices table: one row per commodity + market + date
CREATE TABLE IF NOT EXISTS mandi_prices (
  id            BIGSERIAL PRIMARY KEY,
  commodity     TEXT NOT NULL,
  market        TEXT NOT NULL,
  state         TEXT DEFAULT '',
  district      TEXT DEFAULT '',
  variety       TEXT DEFAULT '',
  min_price     DOUBLE PRECISION DEFAULT 0,
  max_price     DOUBLE PRECISION DEFAULT 0,
  modal_price   DOUBLE PRECISION DEFAULT 0,
  arrival_date  DATE NOT NULL,
  api_source    TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),

  UNIQUE (commodity, market, arrival_date)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_mandi_commodity ON mandi_prices (commodity);
CREATE INDEX IF NOT EXISTS idx_mandi_date      ON mandi_prices (arrival_date DESC);
CREATE INDEX IF NOT EXISTS idx_mandi_state     ON mandi_prices (state);
`;

async function setup() {
  const { error } = await supabase.rpc('exec_sql', { sql: SQL });

  if (error) {
    // If RPC doesn't exist, print the SQL for manual execution
    if (error.message?.includes('function') || error.message?.includes('does not exist')) {
      console.log('⚠️  exec_sql RPC not found. Run this SQL in Supabase SQL Editor:');
      console.log('');
      console.log(SQL);
      console.log('');
      console.log('Go to: https://supabase.com/dashboard → SQL Editor → Paste & Run');
    } else {
      console.error('❌ Error:', error.message);
    }
  } else {
    console.log('✅ Table created successfully!');
  }

  // Verify table exists
  const { data, error: checkErr } = await supabase
    .from('mandi_prices')
    .select('id')
    .limit(1);

  if (checkErr) {
    console.error('❌ Table verification failed:', checkErr.message);
    console.log('Run the SQL above in your Supabase dashboard.');
  } else {
    console.log('✅ Table verified — mandi_prices is ready.');
  }
}

setup();
