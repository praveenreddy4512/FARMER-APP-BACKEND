# FarmVoice Price Backend

Node.js backend that fetches Indian mandi prices from data.gov.in APIs every 30 minutes and stores them in Supabase.

## Setup

### 1. Create Supabase table

Go to your Supabase dashboard → SQL Editor and run:

```sql
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

CREATE INDEX IF NOT EXISTS idx_mandi_commodity ON mandi_prices (commodity);
CREATE INDEX IF NOT EXISTS idx_mandi_date      ON mandi_prices (arrival_date DESC);
CREATE INDEX IF NOT EXISTS idx_mandi_state     ON mandi_prices (state);
```

### 2. Configure environment

Edit `.env`:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
DATA_GOV_API_KEY=your-data-gov-key
PORT=3000
```

### 3. Install and run

```bash
cd backend
npm install
npm start
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Server status + record count |
| `/prices?commodity=tomato&state=telangana` | GET | Search prices |
| `/commodities` | GET | List all commodities with latest date |
| `/commodity/:name` | GET | Latest prices for one commodity |
| `/summary` | GET | One row per commodity with avg/min/max |
| `/fetch-now` | POST | Manually trigger a fetch |

### Query Parameters for /prices

- `commodity` — filter by commodity name (partial match)
- `state` — filter by state (partial match)
- `date` — filter by date (YYYY-MM-DD)
- `limit` — max results (default 500)
- `offset` — pagination

## How It Works

1. **Every 30 minutes**: fetches from both data.gov.in APIs
2. **API 1** (9ef84268): Paddy, Tomato, Onion, Potato, etc.
3. **API 2** (35985678): Turmeric, Coconut, Garlic, Spices, etc.
4. **Upserts** into Supabase (no duplicates)
5. **Deletes** data older than 7 days
6. Flutter app hits this backend instead of calling data.gov.in directly
# FARMER-APP-BACKEND
