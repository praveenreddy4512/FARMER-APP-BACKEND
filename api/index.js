/** Vercel serverless handler — exports Express app without starting it */
require('dotenv').config();

// Build the Express app (same as src/index.js but without listen/cron)
const express = require('express');
const cors = require('cors');
const { supabase } = require('../src/supabase');
const { fetchAndStore } = require('../src/fetcher');

const app = express();

app.use(cors());
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { count } = await supabase
      .from('mandi_prices')
      .select('id', { count: 'exact', head: true });

    res.json({
      status: 'ok',
      total_records: count || 0,
      last_check: new Date().toISOString(),
    });
  } catch (e) {
    res.json({ status: 'ok', total_records: 0, error: e.message });
  }
});

// ─── GET /prices ──────────────────────────────────────────────────
// Returns latest price per commodity per market (deduplicated)
// ?commodity=turmeric  — filter by crop
// ?state=Uttar Pradesh — filter by state
app.get('/prices', async (req, res) => {
  try {
    const { commodity, state } = req.query;

    // Paginate through all records (Supabase caps at 1000 per query)
    const latestMap = {};
    let offset = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      let query = supabase
        .from('mandi_prices')
        .select('*')
        .order('arrival_date', { ascending: false })
        .range(offset, offset + pageSize - 1);

      if (commodity) query = query.ilike('commodity', `%${commodity}%`);
      if (state) query = query.ilike('state', `%${state}%`);

      const { data, error } = await query;
      if (error) throw error;

      const rows = data || [];
      for (const row of rows) {
        const key = `${row.commodity}|${row.market}`;
        if (!latestMap[key] || row.arrival_date > latestMap[key].arrival_date) {
          latestMap[key] = row;
        }
      }

      hasMore = rows.length === pageSize;
      offset += pageSize;

      // Safety: don't paginate forever
      if (offset > 10000) break;
    }

    const prices = Object.values(latestMap).sort((a, b) =>
      a.commodity.localeCompare(b.commodity) || b.modal_price - a.modal_price
    );

    res.json({
      prices,
      total: prices.length,
      limit: 10000,
      offset: 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /summary ─────────────────────────────────────────────────
app.get('/summary', async (req, res) => {
  try {
    const { data: latest } = await supabase
      .from('mandi_prices')
      .select('arrival_date')
      .order('arrival_date', { ascending: false })
      .limit(1);

    if (!latest || latest.length === 0) {
      return res.json({ summary: [], latest_date: null });
    }

    const latestDate = latest[0].arrival_date;

    const { data, error } = await supabase
      .from('mandi_prices')
      .select('commodity, modal_price, min_price, max_price, market, state, arrival_date')
      .order('arrival_date', { ascending: false })
      .limit(5000);

    if (error) throw error;

    // Group by commodity, keep latest date per commodity+market
    const marketMap = {};
    for (const row of data || []) {
      const key = `${row.commodity}|${row.market}`;
      if (!marketMap[key] || row.arrival_date > marketMap[key].arrival_date) {
        marketMap[key] = row;
      }
    }

    const summaryMap = {};
    for (const row of Object.values(marketMap)) {
      const key = row.commodity;
      if (!summaryMap[key]) {
        summaryMap[key] = {
          commodity: key,
          latest_date: row.arrival_date,
          market_count: 0,
          avg_price: 0,
          min_price: Infinity,
          max_price: -Infinity,
          total_price: 0,
        };
      }
      const s = summaryMap[key];
      s.market_count++;
      s.total_price += row.modal_price;
      s.min_price = Math.min(s.min_price, row.min_price);
      s.max_price = Math.max(s.max_price, row.max_price);
      if (row.arrival_date > s.latest_date) s.latest_date = row.arrival_date;
    }

    const summary = Object.values(summaryMap).map((s) => ({
      commodity: s.commodity,
      latest_date: s.latest_date,
      market_count: s.market_count,
      avg_price: Math.round(s.total_price / s.market_count),
      min_price: s.min_price,
      max_price: s.max_price,
    }));

    summary.sort((a, b) => a.commodity.localeCompare(b.commodity));

    res.json({ summary, latest_date: latestDate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /commodities ─────────────────────────────────────────────
app.get('/commodities', async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('mandi_prices')
      .select('commodity, arrival_date, modal_price, market, state')
      .order('arrival_date', { ascending: false })
      .limit(5000);

    if (error) throw error;

    const commodityMap = {};
    for (const row of rows || []) {
      const key = row.commodity;
      if (!commodityMap[key]) {
        commodityMap[key] = {
          commodity: key,
          latest_date: row.arrival_date,
          market_count: 0,
          sample_price: row.modal_price,
        };
      }
      commodityMap[key].market_count++;
    }

    const commodities = Object.values(commodityMap).sort((a, b) =>
      a.commodity.localeCompare(b.commodity)
    );

    res.json({ commodities });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /commodity/:name ─────────────────────────────────────────
app.get('/commodity/:name', async (req, res) => {
  try {
    const { name } = req.params;

    const { data, error } = await supabase
      .from('mandi_prices')
      .select('*')
      .ilike('commodity', `%${name}%`)
      .order('arrival_date', { ascending: false })
      .limit(200);

    if (error) throw error;

    const marketMap = {};
    for (const row of data || []) {
      const key = row.market;
      if (!marketMap[key] || row.arrival_date > marketMap[key].arrival_date) {
        marketMap[key] = row;
      }
    }

    res.json({
      commodity: name,
      markets: Object.values(marketMap).sort(
        (a, b) => b.modal_price - a.modal_price
      ),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /fetch-now ──────────────────────────────────────────────
app.post('/fetch-now', async (req, res) => {
  try {
    await fetchAndStore();
    res.json({ status: 'ok', message: 'Fetch completed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/cron (Vercel cron endpoint) ─────────────────────────
app.get('/api/cron', async (req, res) => {
  try {
    console.log('⏰ Vercel cron triggered: fetching prices...');
    await fetchAndStore();
    res.json({ status: 'ok', message: 'Cron fetch completed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = app;
