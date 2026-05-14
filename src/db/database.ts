import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Render Postgres requires SSL; disabled locally to avoid cert issues
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err);
});

async function init(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_aqi_readings (
      station_id      TEXT        NOT NULL,
      observed_at_utc TEXT        NOT NULL,
      local_date      TEXT,
      local_time      TEXT,
      aqi             INTEGER,
      pm1             DOUBLE PRECISION,
      pm25            DOUBLE PRECISION,
      pm10            DOUBLE PRECISION,
      temperature     DOUBLE PRECISION,
      humidity        DOUBLE PRECISION,
      PRIMARY KEY (station_id, observed_at_utc)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_readings_lookup
      ON station_aqi_readings (station_id, observed_at_utc DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS station_aqi_daily (
      station_id   TEXT    NOT NULL,
      date         TEXT    NOT NULL,
      avg_aqi      DOUBLE PRECISION,
      color_key    TEXT,
      min_aqi      INTEGER,
      max_aqi      INTEGER,
      sample_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (station_id, date)
    )
  `);

  // Prune readings older than 35 days on startup
  await pool.query(
    `DELETE FROM station_aqi_readings
     WHERE observed_at_utc::timestamptz < NOW() - INTERVAL '35 days'`
  );
}

export const dbReady: Promise<void> = init().catch((err) => {
  console.error('[db] Initialization failed:', err);
  process.exit(1);
});

export async function closePool(): Promise<void> {
  await pool.end();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type HistoryReading = {
  observedAtUtc: string;
  localDate: string | null;
  localTime: string | null;
  aqi: number | null;
  pm1: number | null;
  pm25: number | null;
  pm10: number | null;
  temperature: number | null;
  humidity: number | null;
};

export type DailyReading = {
  date: string;
  avgAqi: number | null;
  colorKey: string | null;
  minAqi: number | null;
  maxAqi: number | null;
  sampleCount: number;
};

// ─── Writes ──────────────────────────────────────────────────────────────────

export async function insertReading(params: {
  stationId: string;
  observedAtUtc: string;
  localDate: string | null;
  localTime: string | null;
  aqi: number | null;
  pm1: number | null;
  pm25: number | null;
  pm10: number | null;
  temperature: number | null;
  humidity: number | null;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insert = await client.query(
      `INSERT INTO station_aqi_readings
         (station_id, observed_at_utc, local_date, local_time,
          aqi, pm1, pm25, pm10, temperature, humidity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (station_id, observed_at_utc) DO NOTHING`,
      [
        params.stationId, params.observedAtUtc, params.localDate, params.localTime,
        params.aqi, params.pm1, params.pm25, params.pm10, params.temperature, params.humidity,
      ]
    );

    if ((insert.rowCount ?? 0) > 0 && params.localDate !== null) {
      await client.query(
        `INSERT INTO station_aqi_daily
           (station_id, date, avg_aqi, color_key, min_aqi, max_aqi, sample_count)
         SELECT
           station_id,
           local_date AS date,
           ROUND(AVG(aqi::float)::numeric, 1),
           CASE
             WHEN AVG(aqi) <= 50  THEN 'c_good'
             WHEN AVG(aqi) <= 100 THEN 'c_moderate'
             WHEN AVG(aqi) <= 150 THEN 'c_usg'
             WHEN AVG(aqi) <= 200 THEN 'c_unhealthy'
             WHEN AVG(aqi) <= 300 THEN 'c_very'
             ELSE                      'c_hazardous'
           END,
           MIN(aqi),
           MAX(aqi),
           COUNT(*)
         FROM station_aqi_readings
         WHERE station_id = $1 AND local_date = $2 AND aqi IS NOT NULL
         GROUP BY station_id, local_date
         ON CONFLICT (station_id, date) DO UPDATE SET
           avg_aqi      = EXCLUDED.avg_aqi,
           color_key    = EXCLUDED.color_key,
           min_aqi      = EXCLUDED.min_aqi,
           max_aqi      = EXCLUDED.max_aqi,
           sample_count = EXCLUDED.sample_count`,
        [params.stationId, params.localDate]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

type ReadingRow = {
  observed_at_utc: string;
  local_date: string | null;
  local_time: string | null;
  aqi: number | null;
  pm1: number | null;
  pm25: number | null;
  pm10: number | null;
  temperature: number | null;
  humidity: number | null;
};

type DailyRow = {
  date: string;
  avg_aqi: number | null;
  color_key: string | null;
  min_aqi: number | null;
  max_aqi: number | null;
  sample_count: number;
};

export async function getLast24(stationId: string): Promise<HistoryReading[]> {
  const { rows } = await pool.query<ReadingRow>(
    `SELECT observed_at_utc, local_date, local_time, aqi, pm1, pm25, pm10, temperature, humidity
     FROM station_aqi_readings
     WHERE station_id = $1
     ORDER BY observed_at_utc DESC
     LIMIT 24`,
    [stationId]
  );
  return rows.map((r) => ({
    observedAtUtc: r.observed_at_utc,
    localDate: r.local_date,
    localTime: r.local_time,
    aqi: r.aqi,
    pm1: r.pm1,
    pm25: r.pm25,
    pm10: r.pm10,
    temperature: r.temperature,
    humidity: r.humidity,
  }));
}

export async function getDailyForYear(stationId: string, year: number): Promise<DailyReading[]> {
  const { rows } = await pool.query<DailyRow>(
    `SELECT date, avg_aqi, color_key, min_aqi, max_aqi, sample_count
     FROM station_aqi_daily
     WHERE station_id = $1 AND date LIKE $2
     ORDER BY date ASC`,
    [stationId, `${year}-%`]
  );
  return rows.map((r) => ({
    date: r.date,
    avgAqi: r.avg_aqi,
    colorKey: r.color_key,
    minAqi: r.min_aqi,
    maxAqi: r.max_aqi,
    sampleCount: r.sample_count,
  }));
}
