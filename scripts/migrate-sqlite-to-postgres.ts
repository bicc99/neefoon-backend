/**
 * One-time migration: copies all data from the SQLite database into PostgreSQL.
 *
 * Usage:
 *   tsx --env-file=.env scripts/migrate-sqlite-to-postgres.ts [--sqlite-path ./data/neefoon.db]
 *
 * The script is idempotent — duplicate rows are skipped via ON CONFLICT DO NOTHING.
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import path from 'node:path';
import { parseArgs } from 'node:util';

// ─── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'sqlite-path': { type: 'string', default: path.join(process.cwd(), 'data', 'neefoon.db') },
  },
});

const sqlitePath = args['sqlite-path'] as string;

// ─── Connections ─────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  process.exit(1);
}

console.log(`Opening SQLite: ${sqlitePath}`);
const sqlite = new Database(sqlitePath, { readonly: true });

const pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 500;

async function migrateReadings(): Promise<void> {
  type ReadingRow = {
    station_id: string;
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

  const rows = sqlite
    .prepare('SELECT * FROM station_aqi_readings ORDER BY observed_at_utc ASC')
    .all() as ReadingRow[];

  console.log(`Migrating ${rows.length} rows from station_aqi_readings…`);

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Build a multi-row VALUES clause: ($1,$2,…,$10), ($11,…,$20), …
    const placeholders = batch
      .map((_, j) => {
        const base = j * 10;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
      })
      .join(',');

    const values = batch.flatMap((r) => [
      r.station_id, r.observed_at_utc, r.local_date, r.local_time,
      r.aqi, r.pm1, r.pm25, r.pm10, r.temperature, r.humidity,
    ]);

    const result = await pgPool.query(
      `INSERT INTO station_aqi_readings
         (station_id, observed_at_utc, local_date, local_time,
          aqi, pm1, pm25, pm10, temperature, humidity)
       VALUES ${placeholders}
       ON CONFLICT (station_id, observed_at_utc) DO NOTHING`,
      values
    );

    inserted += result.rowCount ?? 0;
    skipped += batch.length - (result.rowCount ?? 0);

    process.stdout.write(`\r  ${i + batch.length}/${rows.length} processed…`);
  }

  console.log(`\n  Done — inserted: ${inserted}, skipped (duplicates): ${skipped}`);
}

async function migrateDaily(): Promise<void> {
  type DailyRow = {
    station_id: string;
    date: string;
    avg_aqi: number | null;
    color_key: string | null;
    min_aqi: number | null;
    max_aqi: number | null;
    sample_count: number;
  };

  const rows = sqlite
    .prepare('SELECT * FROM station_aqi_daily ORDER BY date ASC')
    .all() as DailyRow[];

  console.log(`Migrating ${rows.length} rows from station_aqi_daily…`);

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const placeholders = batch
      .map((_, j) => {
        const base = j * 7;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
      })
      .join(',');

    const values = batch.flatMap((r) => [
      r.station_id, r.date, r.avg_aqi, r.color_key, r.min_aqi, r.max_aqi, r.sample_count,
    ]);

    const result = await pgPool.query(
      `INSERT INTO station_aqi_daily
         (station_id, date, avg_aqi, color_key, min_aqi, max_aqi, sample_count)
       VALUES ${placeholders}
       ON CONFLICT (station_id, date) DO NOTHING`,
      values
    );

    inserted += result.rowCount ?? 0;
    skipped += batch.length - (result.rowCount ?? 0);

    process.stdout.write(`\r  ${i + batch.length}/${rows.length} processed…`);
  }

  console.log(`\n  Done — inserted: ${inserted}, skipped (duplicates): ${skipped}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

try {
  await migrateReadings();
  await migrateDaily();
  console.log('\nMigration complete.');
} finally {
  sqlite.close();
  await pgPool.end();
}
