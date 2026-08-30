/**
 * Fetches prices from both data.gov.in APIs and stores in Supabase.
 * Handles upserts (insert or update) and deletes old data.
 */
const { supabase } = require('./supabase');

const API_KEY = process.env.DATA_GOV_API_KEY;
const API1_ID = '9ef84268-d588-465a-a308-a864a43d0070';
const API2_ID = '35985678-0d79-46b4-9ed6-6f13308a1d24';

function formatDate(d) {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getFullYear()}`;
}

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

// ─── API 1: Current Daily Price ───────────────────────────────────
async function fetchApi1() {
  const all = [];
  for (let page = 0; page < 5; page++) {
    const offset = page * 500;
    const url =
      `https://api.data.gov.in/resource/${API1_ID}` +
      `?api-key=${API_KEY}&format=json&limit=500&offset=${offset}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) break;
      const body = await resp.json();
      if (body.error) break;

      const records = body.records || [];
      if (records.length === 0) break;

      for (const r of records) {
        const commodity = r.commodity || '';
        if (!commodity) continue;

        const minPrice = parsePrice(r.min_price);
        const maxPrice = parsePrice(r.max_price);
        const modalPrice = parsePrice(r.modal_price);
        if (modalPrice <= 0 && minPrice <= 0 && maxPrice <= 0) continue;

        const arrivalDate = parseDate(r.arrival_date);
        if (!arrivalDate) continue;

        const effectiveModal = modalPrice > 0 ? modalPrice : (minPrice + maxPrice) / 2;

        all.push({
          commodity,
          market: r.market || '',
          state: r.state || '',
          district: r.district || '',
          variety: r.variety || '',
          min_price: minPrice > 0 ? minPrice : effectiveModal,
          max_price: maxPrice > 0 ? maxPrice : effectiveModal,
          modal_price: effectiveModal,
          arrival_date: arrivalDate,
          api_source: 'api1',
        });
      }

      if (records.length < 500) break;
      await sleep(400);
    } catch (e) {
      console.error(`  API1 page ${page} failed:`, e.message);
      break;
    }
  }
  return all;
}

// ─── API 2: Variety-wise Daily Market Prices ──────────────────────
async function fetchApi2() {
  const all = [];
  const today = formatDate(new Date());

  // 5 general pages for today
  for (let page = 0; page < 5; page++) {
    const offset = page * 500;
    const url =
      `https://api.data.gov.in/resource/${API2_ID}` +
      `?api-key=${API_KEY}&format=json&limit=500&offset=${offset}` +
      `&filters[Arrival_Date]=${today}`;

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

  // Also fetch yesterday (some markets update with delay)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatDate(yesterday);

  for (let page = 0; page < 3; page++) {
    const offset = page * 500;
    const url =
      `https://api.data.gov.in/resource/${API2_ID}` +
      `?api-key=${API_KEY}&format=json&limit=500&offset=${offset}` +
      `&filters[Arrival_Date]=${yesterdayStr}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) break;
      const body = await resp.json();
      if (body.error) break;

      const records = body.records || [];
      for (const r of records) {
        addApi2Record(r, all);
      }

      if (records.length < 500) break;
      await sleep(400);
    } catch (e) {
      break;
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

// ─── Store in Supabase ────────────────────────────────────────────
async function storePrices(prices) {
  if (prices.length === 0) {
    console.log('  No prices to store.');
    return { inserted: 0, updated: 0 };
  }

  // Upsert in batches of 500
  let inserted = 0;
  const batchSize = 500;

  for (let i = 0; i < prices.length; i += batchSize) {
    const batch = prices.slice(i, i + batchSize);
    const { error } = await supabase
      .from('mandi_prices')
      .upsert(batch, {
        onConflict: 'commodity,market,arrival_date',
        ignoreDuplicates: false,
      });

    if (error) {
      console.error(`  Upsert batch ${i} failed:`, error.message);
    } else {
      inserted += batch.length;
    }
  }

  return { inserted };
}

// ─── Delete old data (keep last 7 days) ──────────────────────────
async function deleteOldData() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const { error, count } = await supabase
    .from('mandi_prices')
    .delete()
    .lt('arrival_date', cutoffStr);

  if (error) {
    console.error('  Delete old data failed:', error.message);
  } else {
    console.log(`  Deleted data older than ${cutoffStr}`);
  }
}

// ─── Main fetch function ──────────────────────────────────────────
async function fetchAndStore() {
  console.log(`\n🕐 [${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Starting price fetch...`);

  // Fetch from both APIs sequentially
  console.log('  📡 Fetching API 1 (Current Daily Price)...');
  const api1 = await fetchApi1();
  console.log(`  ✅ API 1: ${api1.length} records`);

  console.log('  📡 Fetching API 2 (Variety-wise)...');
  const api2 = await fetchApi2();
  console.log(`  ✅ API 2: ${api2.length} records`);

  // Merge and dedup
  const seen = new Set();
  const all = [];
  for (const p of [...api1, ...api2]) {
    const key = `${p.commodity}|${p.market}|${p.arrival_date}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(p);
    }
  }
  console.log(`  📦 Merged: ${all.length} unique records`);

  // Store in Supabase
  console.log('  💾 Storing in Supabase...');
  const result = await storePrices(all);
  console.log(`  ✅ Stored: ${result.inserted} records`);

  // Delete old data
  console.log('  🗑️  Cleaning old data (>7 days)...');
  await deleteOldData();

  console.log('  ✅ Done!\n');
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
