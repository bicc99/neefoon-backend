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
| `FIRMS_MAP_KEY` | Yes | NASA FIRMS API key |
| `CUSENSE_API_KEY` | Yes | CUSense API key |
| `LOCATIONIQ_API_KEY` | Yes | LocationIQ reverse geocoding key |
| `MARKER_ASSETS_DIR` | No | Path to AQI marker assets (default: `./assets/aqi-markers`) |
| `HOST` | No | Network interface to bind (default: `0.0.0.0`) |
| `PORT` | No | Port to listen on (default: `3000`) |

## Running

```bash
# Development (hot reload)
npm run dev

# Production
npm run build
npm start
```

## API Endpoints

```
GET /health

GET /api/aqi/all
GET /api/aqi/stations/:stationID
GET /api/aqi/stations/:stationID/daily
GET /api/aqi/rankings/countries
GET /api/aqi/rankings/cities
GET /api/aqi/markers/current/sprite.json
GET /api/aqi/markers/current/sprite.png
GET /api/aqi/markers/current/sprite@2x.json
GET /api/aqi/markers/current/sprite@2x.png

GET /api/aqi/air4thai/*
GET /api/aqi/cu-sense/*
GET /api/aqi/airgradient/*

GET /api/firms/fires
```

## Database

PostgreSQL is required. The app connects via `DATABASE_URL`.

```bash
# Migrate data from SQLite (if applicable)
npm run db:migrate-from-sqlite
```
