import type { Request } from "express";
import type { AllResponse, FetchAllResult, StationDetail, UnifiedStation } from "../../types/aqi.js";
import { CACHE_TTL_MS } from "../../lib/httpCache.js";
import { mapAir4ThaiData } from "./providers/air4thai.js";
import { mapAirGradientData } from "./providers/airGradient.js";
import { mapCUSenseData } from "./providers/cuSense.js";
import { pushHistory, attachHistory } from "./history.js";

const AIR4THAI_URL = 'http://air4thai.pcd.go.th/services/getNewAQI_JSON.php';
const AIRGRADIENT_URL = 'https://api.airgradient.com/public/api/v1/world/locations/measures/current';
const CUSENSE_URL = 'https://www.cusense.net:8082/api/v1/sensorData/realtime/all';

const CUSENSE_API_KEY = process.env.CUSENSE_API_KEY;

type AqiCache = {
  data: AllResponse;
  timestamp: number;
  detailsByStationID: Record<string, StationDetail>;
};

let cache: AqiCache | null = null;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${url} with status ${response.status}`);
  }
  return response.json();
}

export function buildMarkerKeys(stations: UnifiedStation[]): string[] {
  const keys = new Set<string>(['c_nodata', 'c_nodata_s']);
  for (const station of stations) {
    keys.add(station.imageKey);
    keys.add(station.imageKeySelected);
  }
  return Array.from(keys).sort();
}

export function getSpriteBaseUrl(req: Request): string {
  const forwardedProto = req.header("x-forwarded-proto");
  const protocol = forwardedProto ? forwardedProto.split(",")[0] : req.protocol;
  const host = req.get("host");

  if (!host) {
    throw new Error("Missing Host header");
  }

  return `${protocol}://${host}${req.baseUrl}/markers/current/sprite`;
}

export async function fetchAllStations(): Promise<FetchAllResult> {
  const [air4thaiResult, cuSenseResult, airGradientResult] = await Promise.allSettled([
    fetchJson(AIR4THAI_URL),
    fetchJson(CUSENSE_URL, {
      method: 'GET',
      headers: {
        'X-Gravitee-Api-Key': CUSENSE_API_KEY ?? '',
        'Accept': 'application/json',
      },
    }),
    fetchJson(AIRGRADIENT_URL),
  ]);

  const warnings: string[] = [];

  const air4thaiData = air4thaiResult.status === 'fulfilled'
    ? air4thaiResult.value
    : (warnings.push(`Air4Thai unavailable: ${air4thaiResult.reason?.message ?? air4thaiResult.reason}`), null);
  const cuSenseData = cuSenseResult.status === 'fulfilled'
    ? cuSenseResult.value
    : (warnings.push(`CUSense unavailable: ${cuSenseResult.reason?.message ?? cuSenseResult.reason}`), null);
  const airGradientData = airGradientResult.status === 'fulfilled'
    ? airGradientResult.value
    : (warnings.push(`AirGradient unavailable: ${airGradientResult.reason?.message ?? airGradientResult.reason}`), null);

  const air4thaiMapped = air4thaiData !== null && typeof air4thaiData === 'object' && Array.isArray((air4thaiData as Record<string, unknown>).stations)
    ? (air4thaiData as { stations: unknown[] }).stations.map(mapAir4ThaiData)
    : [];

  const cuSenseMapped = cuSenseData !== null && typeof cuSenseData === 'object'
    ? Object.values(cuSenseData as Record<string, unknown>).map(mapCUSenseData)
    : [];

  const airGradientMapped = Array.isArray(airGradientData)
    ? airGradientData.map(mapAirGradientData)
    : [];

  // include no aqi stations for air4thai and cusense
  const air4Thai = air4thaiMapped.filter(({ station }) => station.stationID !== null && station.lat !== null && station.lon !== null);
  const air4ThaiIDs = new Set(air4Thai.map(s => s.station.stationID));

  // CUSense stations that mirror an Air4Thai station use "PCD/<air4thaiID>" as their stationID.
  // Drop them to avoid duplicate markers at the same coordinate — prefer Air4Thai data.
  const filtered = {
    Air4Thai: air4Thai,
    CUSense: cuSenseMapped.filter(({ station }) => {
      if (station.stationID === null || station.lat === null || station.lon === null) return false;
      const underlyingID = station.stationID.startsWith('PCD/') ? station.stationID.slice(4) : null;
      return underlyingID === null || !air4ThaiIDs.has(underlyingID);
    }),
    AirGradient: airGradientMapped.filter(({ station, detail }) =>
      station.stationID !== null && station.lat !== null && station.lon !== null && detail.current.aqi !== null
    ),
  };

  const merged = [...filtered.Air4Thai, ...filtered.CUSense, ...filtered.AirGradient];
  const stations = merged.map(({ station }) => station);

  const detailsByStationID: Record<string, StationDetail> = {};
  for (const { detail } of merged) {
    if (!detail.stationID) continue;
    await pushHistory(detail);
    detailsByStationID[detail.stationID] = attachHistory(detail);
  }

  const countBySource: Record<string, number> = {
    Air4Thai: filtered.Air4Thai.length,
    CUSense: filtered.CUSense.length,
    AirGradient: filtered.AirGradient.length,
  };

  return { warnings, countBySource, stations, detailsByStationID };
}

export async function getCachedData(req: Request): Promise<{
  all: AllResponse;
  detailsByStationID: Record<string, StationDetail>;
}> {
  const now = Date.now();

  if (cache && now - cache.timestamp < CACHE_TTL_MS) {
    // refresh sprite base URL for current host during local development
    return {
      all: { ...cache.data, sprite: { baseUrl: getSpriteBaseUrl(req) } },
      detailsByStationID: cache.detailsByStationID,
    };
  }

  const { warnings, countBySource, stations, detailsByStationID } = await fetchAllStations();
  const markerKeys = buildMarkerKeys(stations);

  const result: AllResponse = {
    updateAt: new Date().toISOString(),
    count: stations.length,
    countBySource,
    markerKeyCount: markerKeys.length,
    markerKeys,
    sprite: { baseUrl: getSpriteBaseUrl(req) },
    stations,
    ...(warnings.length > 0 && { warnings }),
  };

  cache = { data: result, timestamp: now, detailsByStationID };

  console.log('station count:', stations.length);
  console.log('marker key count:', markerKeys.length);

  return { all: result, detailsByStationID };
}

export function warmCache(data: AllResponse, detailsByStationID: Record<string, StationDetail>): void {
  cache = { data, timestamp: Date.now(), detailsByStationID };
}
