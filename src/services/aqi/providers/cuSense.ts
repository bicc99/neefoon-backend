import type { UnifiedStation, StationDetail } from "../../../types/aqi.js";
import {
  toNumber, nullIfSentinel, sanitizeNonNegative, sanitizeTemperature, sanitizeHumidity,
  sanitizeCo2, reading, round, buildImageKeys, parseIso, splitIsoInTimezone, pm25toAQI,
} from "../aqiMath.js";

export function mapCUSenseData(item: any): { station: UnifiedStation; detail: StationDetail } {
  const info   = item?.info ?? {};
  const latest = Array.isArray(item?.data) ? item.data[0] : null;

  const areaTH = [info.tambol, info.amphoe, info.province]
    .filter((v) => typeof v === 'string' && v.trim() !== '')
    .join(', ');

  const pm1       = round(sanitizeNonNegative(nullIfSentinel(toNumber(latest?.pm1 ?? null))), 1);
  const pm25      = round(sanitizeNonNegative(nullIfSentinel(toNumber(latest?.pm25 ?? null))), 1);
  const pm10      = round(sanitizeNonNegative(nullIfSentinel(toNumber(latest?.pm10 ?? null))), 1);
  const temperature = round(sanitizeTemperature(nullIfSentinel(toNumber(latest?.temp ?? null))), 1);
  const humidity  = round(sanitizeHumidity(nullIfSentinel(toNumber(latest?.humid ?? null))), 1);
  const co2       = round(sanitizeCo2(nullIfSentinel(toNumber(latest?.co2 ?? null))), 0);
  const aqiResult = pm25 != null ? pm25toAQI(pm25) : null;
  const { imageKey, imageKeySelected } = buildImageKeys(aqiResult);
  const observedAtUtc = parseIso(latest?.time ?? null);
  const observedAt = splitIsoInTimezone(latest?.time ?? null, 'Asia/Bangkok');
  const stationID = info.topic ?? (info.id ? `${info.project ?? 'CUSense'}-${info.id}` : null);

  const station: UnifiedStation = {
    source: 'CUSense, Chulalongkorn University',
    stationID,
    nameTH: info.name ?? null,
    nameEN: null,
    areaTH: areaTH || null,
    areaEN: null,
    lat: toNumber(info.lat ?? null),
    lon: toNumber(info.lon ?? null),
    pm25,
    aqi: aqiResult,
    observedAt,
    timezone: "Asia/Bangkok",
    imageKey,
    imageKeySelected,
  };

  const detail: StationDetail = {
    source: station.source,
    stationID: station.stationID,
    nameTH: station.nameTH,
    nameEN: station.nameEN,
    areaTH: station.areaTH,
    areaEN: station.areaEN,
    lat: station.lat,
    lon: station.lon,
    observedAt: station.observedAt,
    timezone: station.timezone,
    imageKey: station.imageKey,
    imageKeySelected: station.imageKeySelected,
    observedAtUtc,
    current: {
      aqi: aqiResult,
      pollutants: {
        pm1:  reading(pm1, 'µg/m³'),
        pm25: reading(pm25, 'µg/m³'),
        pm10: reading(pm10, 'µg/m³'),
        o3:   reading(null, 'ppb'),
        co:   reading(null, 'ppm'),
        no2:  reading(null, 'ppb'),
        so2:  reading(null, 'ppb'),
      },
      environment: {
        temperature,
        humidity,
        co2,
        tvoc: null,
        tvocIndex: null,
        noxIndex: null,
        heatIndex: null,
      },
    },
    history24h: [],
  };

  return { station, detail };
}
