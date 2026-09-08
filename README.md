# FarmVoice Price Backend

Node.js backend that fetches Indian mandi prices from data.gov.in APIs every 3 hours and stores them in Supabase.

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

1. **Every 3 hours**: fetches from the data.gov.in variety-wise API (35985678)
2. **API 2** has 81M+ records historically, so it paginates the most recent ~7 days sorted by `Arrival_Date` DESC, plus explicit queries for deep commodities (Turmeric, Coconut, Garlic, Ginger, Coriander, Cumin, Mustard, Fennel, Fenugreek, Chillies)
3. **Dedupes to the most recent record per commodity+market** — every commodity and every market is present with its own latest `arrival_date`, even if it hasn't updated today
4. **Deletes all existing rows** from `mandi_prices`, then **inserts the fresh batch** (table always mirrors the latest fetch)
5. Flutter app hits this backend instead of calling data.gov.in directly

> **Note:** Vercel cron jobs on the **Hobby plan are limited to once per day**, so the deployed Vercel schedule is `0 0 * * *`. For true every-3-hour runs, use a Vercel plan that supports this frequency, host the Node server yourself (`npm start` uses node-cron), or trigger `/api/cron` from an external scheduler (e.g. cron-job.org, GitHub Actions). The local server schedule remains `0 */3 * * *`.

## Phone.Email authentication and onboarding

This backend does not implement OTP delivery or verification. Phone.Email owns the
phone login flow. After login, the Flutter app sends the Phone.Email access token
as `Authorization: Bearer <access-token>` to the backend. The backend verifies it
server-side by calling the official Phone.Email `POST https://eapi.phone.email/getuser`
endpoint with the server-side client ID. The verified phone and country code in
that response are the only phone values used for a profile.

### Database migration

Run [`migrations/001_farmer_profiles.sql`](migrations/001_farmer_profiles.sql) in
the Supabase SQL editor. It creates `farmer_profiles` only; the existing
`mandi_prices` table is unchanged. The migration enables RLS and creates no public
policy. The backend uses the service role and performs profile ownership checks
before every read or write.

For future farmer-owned tables (farms, crops, crop updates, expenses, budgets,
calendar events, voice records, and preferences), add a `farmer_profile_id UUID`
foreign key to `farmer_profiles(id)`, enable RLS, and enforce the same ownership
check in every backend query. This repository currently contains no such tables
or routes, so no existing farm API was changed.

### Environment variables

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-server-only-service-role-key
PHONE_EMAIL_CLIENT_ID=your-phone-email-client-id
PHONE_EMAIL_API_KEY=your-server-only-phone-email-api-key-if-required-by-your-account
DATA_GOV_API_KEY=your-data-gov-key
PORT=3000
```

`SUPABASE_SERVICE_KEY`, `PHONE_EMAIL_API_KEY`, and all other secrets must only be
configured in the backend/Vercel environment. They must never be shipped in the
Flutter app, logged, or committed. HTTPS is required in production.

### Authentication routes

All `/auth` routes require a valid Phone.Email bearer access token.

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/auth/profile` | Create the first profile or update onboarding fields |
| `GET` | `/auth/me` | Return the current farmer profile and completion status |
| `PATCH` | `/auth/profile` | Update `fullName` and/or `preferredLanguage` |

`POST /auth/profile` request:

```json
{
  "fullName": "Ravi Kumar",
  "preferredLanguage": "te"
}
```

Successful response:

```json
{
  "success": true,
  "user": {
    "id": "profile-id",
    "fullName": "Ravi Kumar",
    "phoneNumber": "******1234",
    "preferredLanguage": "te",
    "phoneVerified": true,
    "onboardingCompleted": true,
    "profileCompleted": true
  },
  "profileCompleted": true,
  "onboardingCompleted": true
}
```

An incomplete existing profile returns `profileCompleted: false` and
`missingFields: ["fullName"]`. Phone number, verification state, profile ID,
and timestamps are never accepted from the client. Names are trimmed and length
limited; language values must use a two- or three-letter language code, optionally
with an uppercase region (`te`, `en`, `en-IN`). Profile endpoints are rate
limited per source IP.

Errors use this shape:

```json
{
  "success": false,
  "error": {
    "code": "AUTHENTICATION_FAILED",
    "message": "Phone authentication could not be verified."
  }
}
```

Codes include `AUTHENTICATION_REQUIRED`, `AUTHENTICATION_FAILED`,
`AUTHENTICATION_PROVIDER_UNAVAILABLE`, `INVALID_NAME`, `INVALID_LANGUAGE`,
`PROFILE_NOT_FOUND`, `DATABASE_ERROR`, and `RATE_LIMITED`.

### Flutter integration

1. Use `phone_email_auth` and initialize it with the Phone.Email client ID.
2. Complete Phone.Email login and retain the returned `accessToken` and `jwtToken`
   in memory or secure platform storage as appropriate. Do not send either token
   to logs.
3. Call `POST /auth/profile` with `Authorization: Bearer <accessToken>` and only
   the name and selected language in the JSON body.
4. On later app launches call `GET /auth/me` with the same bearer token. If the
   response reports missing fields, show onboarding; otherwise continue directly
   to the app.
5. Use `PATCH /auth/profile` for later name or language changes. Never send a
   phone number or user ID as an ownership selector.

The JWT returned by Phone.Email is retained for Phone.Email SDK features. The
backend currently validates the access token through Phone.Email's documented
`getuser` exchange, rather than inventing JWT claims or accepting an unverified
JWT. If Phone.Email enables a JWT verification endpoint/API-key flow for the
account, configure it according to their current account documentation before
switching the verifier.

### Testing and deployment

Run syntax checks locally:

```bash
node --check src/auth.js
node --check src/index.js
node --check api/index.js
```

Apply the migration before exercising the routes. Test missing, malformed,
expired, and provider-rejected bearer tokens; a valid token for farmer A against
farmer B's profile must never return B's data. Test first login, repeat login,
incomplete onboarding, invalid language, and profile updates.

For local deployment use `npm start` with server-only `.env` values. For Vercel,
add the same required variables in Project Settings, deploy using the existing
`vercel.json`, and keep `/api/cron` unchanged. The commodity price routes remain
available without authentication; profile routes are the only new protected
surface in this change.
# FARMER-APP-BACKEND
