# Neefoon Backend

Node.js/TypeScript backend that aggregates air quality data from multiple public APIs and serves it to the Neefoon mobile app.

## Data Sources

| Service | Data |
|---|---|
| [Air4Thai](http://air4thai.pcd.go.th) | Thailand PCD air quality stations |
| [AirGradient](https://www.airgradient.com) | Low-cost sensor network |
| [CUSense](https://cusense.net) | Chulalongkorn University sensor network |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov) | Active fire / hotspot data |

## Setup

```bash
cp .env.example .env
# Fill in required values (see below)
npm install
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `API_KEY` | Yes | Shared secret — all API clients must send `Authorization: Bearer <key>` |
| `FIRMS_MAP_KEY` | Yes | NASA FIRMS API key |
| `CUSENSE_API_KEY` | Yes | CUSense API key |
| `LOCATIONIQ_API_KEY` | Yes | LocationIQ reverse geocoding key |
| `URL_SIGNING_SECRET` | Yes | Server-side HMAC-SHA256 secret used to mint/verify signed URLs (e.g. MapLibre fetching the FIRMS hotspot PNG). Must never be bundled into the mobile app. |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key (`sk_test_...` in dev, `sk_live_...` in prod) |
| `FRONTEND_URL` | Yes | Public URL of the website frontend. Used for CORS allow-listing and Stripe success/cancel redirects. |
| `MARKER_ASSETS_DIR` | No | Path to AQI marker assets (default: `./assets/aqi-markers`) |
| `HOST` | No | Network interface to bind (default: `0.0.0.0`) |
| `PORT` | No | Port to listen on (default: `3000`) |

Generate a key with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Running

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

## Authentication

All endpoints except `/health` and `/stripe/*` require:
```
Authorization: Bearer <API_KEY>
```

`/stripe/*` is public because the website frontend has no API key. CORS is locked to `FRONTEND_URL` for browser clients; the native mobile app does not send an `Origin` header and is unaffected.

## API Endpoints

```
GET  /health                                    # no auth required

POST /stripe/create-checkout-session            # no auth required (CORS-gated)

GET  /aqi/all
GET  /aqi/stations/:stationID
GET  /aqi/stations/:stationID/daily
GET  /aqi/rankings/countries
GET  /aqi/rankings/cities
GET  /aqi/markers/current/sprite.json
GET  /aqi/markers/current/sprite.png
GET  /aqi/markers/current/sprite@2x.json
GET  /aqi/markers/current/sprite@2x.png

GET  /aqi/air4thai/*
GET  /aqi/cu-sense/*
GET  /aqi/airgradient/*

GET  /firms/fires
```

## Database

PostgreSQL is required. The app connects via `DATABASE_URL`.

```bash
# Migrate data from SQLite (if applicable)
npm run db:migrate-from-sqlite
```
