/**
 * Fetches prices from the data.gov.in variety-wise API and stores in Supabase.
 * Each run deletes all existing rows and inserts the fresh batch.
 */
const { supabase } = require('./supabase');

const API_KEY = process.env.DATA_GOV_API_KEY;
const API2_ID = '35985678-0d79-46b4-9ed6-6f13308a1d24';

function parseDate(str) {
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length === 3) {
    const [dd, mm, yyyy] = parts;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return str;
}

function parsePrice(val) {
  if (val == null) return 0;
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

// ─── API 2: Variety-wise Daily Market Prices ──────────────────────
// The full API 2 dataset has ~81 MILLION records (history back to 2009),
// so we can't paginate all of it. Instead:
//   1. Paginate the dataset sorted by Arrival_Date DESC — newest records
//      first — deep enough to cover every market that reported in the
//      last several days.
//   2. Query specific deep commodities explicitly (they're buried past
//      the recent window), also sorted DESC so we get their most recent
//      records regardless of when they last updated.
async function fetchApi2() {
  const all = [];

  // General pages: most recent records first (covers ~7 days of data)
  for (let page = 0; page < 30; page++) {
    const offset = page * 500;
    const url =
      `https://api.data.gov.in/resource/${API2_ID}` +
      `?api-key=${API_KEY}&format=json&limit=500&offset=${offset}` +
      `&sort[Arrival_Date]=desc`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) break;
      const body = await resp.json();
      if (body.error) break;

      const records = body.records || [];
      if (records.length === 0) break;

      for (const r of records) {
        addApi2Record(r, all);
      }

      if (records.length < 500) break;
      await sleep(400);
    } catch (e) {
      console.error(`  API2 page ${page} failed:`, e.message);
      break;
    }
  }

  // Specific commodity queries (deep in the dataset — won't appear in
  // the recent window if they haven't updated in a while). Sorted DESC
  // so the most recent records for each commodity come first.
  const specificCommodities = [
    'Turmeric', 'Coconut', 'Garlic', 'Ginger', 'Coriander',
    'Cumin', 'Mustard', 'Fennel', 'Fenugreek', 'Chillies',
  ];

  for (const commodity of specificCommodities) {
    const url =
      `https://api.data.gov.in/resource/${API2_ID}` +
      `?api-key=${API_KEY}&format=json&limit=500` +
      `&sort[Arrival_Date]=desc` +
      `&filters[Commodity]=${commodity}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const body = await resp.json();
      if (body.error) continue;

      const records = body.records || [];
      for (const r of records) {
        addApi2Record(r, all);
      }

      await sleep(500);
    } catch (e) {
      // Skip failed commodity
    }
  }

  return all;
}

function addApi2Record(r, all) {
  const commodity = r.Commodity || '';
  if (!commodity) return;

  const minPrice = parsePrice(r.Min_Price);
  const maxPrice = parsePrice(r.Max_Price);
  const modalPrice = parsePrice(r.Modal_Price);
  if (modalPrice <= 0 && minPrice <= 0 && maxPrice <= 0) return;

  const arrivalDate = parseDate(r.Arrival_Date);
  if (!arrivalDate) return;

  const effectiveModal = modalPrice > 0 ? modalPrice : (minPrice + maxPrice) / 2;

  all.push({
    commodity,
    market: r.Market || '',
    state: r.State || '',
    district: r.District || '',
    variety: r.Variety || '',
    min_price: minPrice > 0 ? minPrice : effectiveModal,
    max_price: maxPrice > 0 ? maxPrice : effectiveModal,
    modal_price: effectiveModal,
    arrival_date: arrivalDate,
    api_source: 'api2',
  });
}

// ─── Store in Supabase (delete old, insert new) ───────────────────
async function storePrices(prices) {
  // Delete ALL existing rows first, then insert the fresh batch.
  const { error: delErr } = await supabase
    .from('mandi_prices')
    .delete()
    .gte('id', 0); // matches every row (ids start at 1)

  if (delErr) {
    console.error('  ❌ Failed to clear old data:', delErr.message);
    return { deleted: false, inserted: 0 };
  }
  console.log('  🗑️  Cleared existing data');

  if (prices.length === 0) {
    console.log('  No prices to store.');
    return { deleted: true, inserted: 0 };
  }

  // Insert in batches of 500
  let inserted = 0;
  const batchSize = 500;

  for (let i = 0; i < prices.length; i += batchSize) {
    const batch = prices.slice(i, i + batchSize);
    const { error } = await supabase
      .from('mandi_prices')
      .insert(batch);

    if (error) {
      console.error(`  Insert batch ${i} failed:`, error.message);
    } else {
      inserted += batch.length;
    }
  }

  return { deleted: true, inserted };
}

// ─── Main fetch function ──────────────────────────────────────────
async function fetchAndStore() {
  console.log(`\n🕐 [${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Starting price fetch...`);

  // Fetch from the variety-wise API
  console.log('  📡 Fetching API 2 (Variety-wise)...');
  const records = await fetchApi2();
  console.log(`  ✅ API 2: ${records.length} records`);

  // Dedup: keep the MOST RECENT record per commodity+market,
  // so every commodity and every market is present with its latest date.
  const latestMap = new Map();
  for (const p of records) {
    const key = `${p.commodity}|${p.market}`;
    const existing = latestMap.get(key);
    if (!existing || p.arrival_date > existing.arrival_date) {
      latestMap.set(key, p);
    }
  }
  const all = [...latestMap.values()];
  console.log(`  📦 Deduped: ${all.length} unique commodity+market records`);

  // Store in Supabase (replace all existing data with fresh records).
  // Guard: if the API returned nothing, abort to avoid wiping the table.
  if (all.length === 0) {
    console.log('  ⚠️  No records fetched — skipping replace to keep existing data.');
    return { refreshed: false, fetched: 0, deleted: false, inserted: 0 };
  }

  console.log('  💾 Replacing data in Supabase...');
  const result = await storePrices(all);
  console.log(`  ✅ Stored: ${result.inserted} records`);

  console.log('  ✅ Done!\n');
  return { refreshed: result.deleted && result.inserted > 0, fetched: all.length, ...result };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Run if called directly ───────────────────────────────────────
if (require.main === module) {
  require('dotenv').config();
  fetchAndStore()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('❌ Fatal:', e);
      process.exit(1);
    });
}

module.exports = { fetchAndStore };
