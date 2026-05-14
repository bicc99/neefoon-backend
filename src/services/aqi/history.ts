import type { StationDetail, StationSnapshot, SourceName } from "../../types/aqi.js";
import { getDailyForYear, getLast24, insertReading } from "../../db/database.js";

const HISTORY_LIMIT = 24;

export const stationHistoryCache = new Map<string, StationSnapshot[]>();

export async function pushHistory(detail: StationDetail): Promise<void> {
  const stationID = detail.stationID;
  if (!stationID) return;

  if (detail.observedAtUtc) {
    await insertReading({
      stationId: stationID,
      observedAtUtc: detail.observedAtUtc,
      localDate: detail.observedAt.date,
      localTime: detail.observedAt.time,
      aqi: detail.current.aqi?.value ?? null,
      pm1: detail.current.pollutants.pm1.value,
      pm25: detail.current.pollutants.pm25.value,
      pm10: detail.current.pollutants.pm10.value,
      temperature: detail.current.environment.temperature,
      humidity: detail.current.environment.humidity,
    });

    // Repopulate memory from DB so history survives server restarts
    const dbRows = await getLast24(stationID);
    stationHistoryCache.set(stationID, dbRows.map((r) => ({
      stationID,
      source: detail.source as SourceName,
      observedAtUtc: r.observedAtUtc,
      local: { date: r.localDate, time: r.localTime },
      aqi: r.aqi,
      pm1: r.pm1,
      pm25: r.pm25,
      pm10: r.pm10,
      temperature: r.temperature,
      humidity: r.humidity,
    })));
    return;
  }

  // Fallback for readings without a timestamp: use in-memory ring buffer only
  const nextPoint: StationSnapshot = {
    stationID,
    source: detail.source as SourceName,
    observedAtUtc: detail.observedAtUtc,
    local: detail.observedAt,
    aqi: detail.current.aqi?.value ?? null,
    pm1: detail.current.pollutants.pm1.value,
    pm25: detail.current.pollutants.pm25.value,
    pm10: detail.current.pollutants.pm10.value,
    temperature: detail.current.environment.temperature,
    humidity: detail.current.environment.humidity,
  };

  const prev = stationHistoryCache.get(stationID) ?? [];
  const deduped = prev.filter((item) => item.observedAtUtc !== nextPoint.observedAtUtc);
  deduped.unshift(nextPoint);
  stationHistoryCache.set(stationID, deduped.slice(0, HISTORY_LIMIT));
}

export function attachHistory(detail: StationDetail): StationDetail {
  if (!detail.stationID) return detail;
  const history = stationHistoryCache.get(detail.stationID) ?? [];
  return {
    ...detail,
    history24h: history.map((item) => ({
      observedAtUtc: item.observedAtUtc,
      local: item.local,
      aqi: item.aqi,
      pm1: item.pm1,
      pm25: item.pm25,
      pm10: item.pm10,
      temperature: item.temperature,
      humidity: item.humidity,
    })),
  };
}

export { getDailyForYear };
