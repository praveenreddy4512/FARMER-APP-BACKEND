/**
 * FarmVoice Price Backend
 * - Express API server
 * - Cron job: fetch every 30 minutes
 * - Endpoints for Flutter app
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { supabase } = require('./supabase');
const { fetchAndStore } = require('./fetcher');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const { count } = await supabase
    .from('mandi_prices')
    .select('id', { count: 'exact', head: true });

  res.json({
    status: 'ok',
    total_records: count || 0,
    last_check: new Date().toISOString(),
  });
});

// ─── GET /prices ──────────────────────────────────────────────────
// Query params: commodity, state, date, limit, offset
app.get('/prices', async (req, res) => {
  try {
    const {
      commodity,
      state,
      date,
      limit = 500,
      offset = 0,
    } = req.query;

    let query = supabase
      .from('mandi_prices')
      .select('*', { count: 'exact' })
      .order('arrival_date', { ascending: false })
      .order('modal_price', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    if (commodity) {
      // Case-insensitive contains match
      query = query.ilike('commodity', `%${commodity}%`);
    }
    if (state) {
      query = query.ilike('state', `%${state}%`);
    }
    if (date) {
      query = query.eq('arrival_date', date);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    res.json({
      prices: data || [],
      total: count || 0,
      limit: Number(limit),
      offset: Number(offset),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /commodities ─────────────────────────────────────────────
// List all available commodities with latest date per commodity
app.get('/commodities', async (req, res) => {
  try {
    const { data, error } = await supabase
      .rpc('get_commodities_with_latest_date');

    if (error) {
      // Fallback: manual query
      const { data: rows, error: err2 } = await supabase
        .from('mandi_prices')
        .select('commodity, arrival_date, modal_price, market, state')
        .order('arrival_date', { ascending: false });

      if (err2) throw err2;

      // Group by commodity, get latest date
      const commodityMap = {};
      for (const row of rows || []) {
        const key = row.commodity;
        if (!commodityMap[key]) {
          commodityMap[key] = {
            commodity: key,
            latest_date: row.arrival_date,
            market_count: 0,
            sample_price: row.modal_price,
            sample_market: row.market,
            sample_state: row.state,
          };
        }
        commodityMap[key].market_count++;
      }

      const commodities = Object.values(commodityMap).sort((a, b) =>
        a.commodity.localeCompare(b.commodity)
      );

      return res.json({ commodities });
    }

    res.json({ commodities: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /commodity/:name ─────────────────────────────────────────
// Get latest prices for a specific commodity across all markets
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

    // Group by latest date per market
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

// ─── GET /summary ─────────────────────────────────────────────────
// Summary: one row per commodity with avg/min/max price, market count, latest date
app.get('/summary', async (req, res) => {
  try {
    // Get latest arrival_date first
    const { data: latest } = await supabase
      .from('mandi_prices')
      .select('arrival_date')
      .order('arrival_date', { ascending: false })
      .limit(1);

    if (!latest || latest.length === 0) {
      return res.json({ summary: [] });
    }

    const latestDate = latest[0].arrival_date;

    // Get all data for latest date
    const { data, error } = await supabase
      .from('mandi_prices')
      .select('commodity, modal_price, min_price, max_price, market, state')
      .eq('arrival_date', latestDate);

    if (error) throw error;

    // Group by commodity
    const summaryMap = {};
    for (const row of data || []) {
      const key = row.commodity;
      if (!summaryMap[key]) {
        summaryMap[key] = {
          commodity: key,
          latest_date: latestDate,
          market_count: 0,
          avg_price: 0,
          min_price: Infinity,
          max_price: -Infinity,
          total_price: 0,
          markets: [],
        };
      }
      const s = summaryMap[key];
      s.market_count++;
      s.total_price += row.modal_price;
      s.min_price = Math.min(s.min_price, row.min_price);
      s.max_price = Math.max(s.max_price, row.max_price);
      s.markets.push(row.market);
    }

    const summary = Object.values(summaryMap).map((s) => ({
      commodity: s.commodity,
      latest_date: s.latest_date,
      market_count: s.market_count,
      avg_price: Math.round(s.total_price / s.market_count),
      min_price: s.min_price,
      max_price: s.max_price,
      markets: s.markets.slice(0, 5),
    }));

    summary.sort((a, b) => a.commodity.localeCompare(b.commodity));

    res.json({ summary, latest_date: latestDate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /fetch-now ──────────────────────────────────────────────
// Manually trigger a fetch
app.post('/fetch-now', async (req, res) => {
  try {
    await fetchAndStore();
    res.json({ status: 'ok', message: 'Fetch completed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────
// Only run cron + listen when NOT on Vercel (serverless)
if (!process.env.VERCEL) {
  cron.schedule('*/30 * * * *', () => {
    console.log('⏰ Cron triggered: fetching prices...');
    fetchAndStore().catch((e) => console.error('Cron fetch failed:', e));
  });

  app.listen(PORT, () => {
    console.log(`\n🚀 FarmVoice Price Server running on port ${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/health`);
    console.log(`   Prices:  http://localhost:${PORT}/prices`);
    console.log(`   Summary: http://localhost:${PORT}/summary`);
    console.log(`   Commodities: http://localhost:${PORT}/commodities`);
    console.log(`   Cron: every 30 minutes\n`);

    console.log('🔄 Running initial fetch...');
    fetchAndStore().catch((e) => console.error('Initial fetch failed:', e));
  });
} else {
  console.log('🚀 Running on Vercel — cron handled by Vercel cron jobs');
}

module.exports = app;
