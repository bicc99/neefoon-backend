import type { UnifiedStation, StationDetail } from "../../../types/aqi.js";
import {
  toNumber, nullIfSentinel, sanitizeNonNegative, reading, round,
  buildImageKeys, buildObservedAt, combineObservedAtUtc, pm25toAQI,
} from "../aqiMath.js";

export function mapAir4ThaiData(item: any): { station: UnifiedStation; detail: StationDetail } {
  const pm25 = round(sanitizeNonNegative(nullIfSentinel(toNumber(item.AQILast?.PM25?.value ?? null))), 1);
  const pm10 = round(sanitizeNonNegative(nullIfSentinel(toNumber(item.AQILast?.PM10?.value ?? null))), 1);
  const o3   = round(sanitizeNonNegative(nullIfSentinel(toNumber(item.AQILast?.O3?.value ?? null))), 1);
  const co   = round(sanitizeNonNegative(nullIfSentinel(toNumber(item.AQILast?.CO?.value ?? null))), 2);
  const no2  = round(sanitizeNonNegative(nullIfSentinel(toNumber(item.AQILast?.NO2?.value ?? null))), 1);
  const so2  = round(sanitizeNonNegative(nullIfSentinel(toNumber(item.AQILast?.SO2?.value ?? null))), 1);
  const aqiResult = pm25 != null ? pm25toAQI(pm25) : null;
  const { imageKey, imageKeySelected } = buildImageKeys(aqiResult);
  const observedAt = buildObservedAt(item.AQILast?.date, item.AQILast?.time);
  const observedAtUtc = combineObservedAtUtc(observedAt.date, observedAt.time, 'Asia/Bangkok');
  const stationID = item.stationID != null ? String(item.stationID) : null;

  const station: UnifiedStation = {
    source: 'Air4Thai, Pollution Control Department, Thailand',
    stationID,
    nameTH: item.nameTH ?? null,
    nameEN: item.nameEN ?? null,
    areaTH: item.areaTH ?? null,
    areaEN: item.areaEN ?? null,
    lat: toNumber(item.lat ?? null),
    lon: toNumber(item.long ?? null),
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
        pm1:  reading(null, 'µg/m³'),
        pm25: reading(pm25, 'µg/m³'),
        pm10: reading(pm10, 'µg/m³'),
        o3:   reading(o3, 'ppb'),
        co:   reading(co, 'ppm'),
        no2:  reading(no2, 'ppb'),
        so2:  reading(so2, 'ppb'),
      },
      environment: {
        temperature: null,
        humidity: null,
        co2: null,
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
