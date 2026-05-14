import type { UnifiedStation, StationDetail } from "../../../types/aqi.js";
import {
  toNumber, nullIfSentinel, sanitizeNonNegative, sanitizeTemperature, sanitizeHumidity,
  sanitizeCo2, reading, round, buildImageKeys, parseIso, splitIsoInTimezone, pm25toAQI,
} from "../aqiMath.js";

export function mapAirGradientData(item: any): { station: UnifiedStation; detail: StationDetail } {
  const pm1       = round(sanitizeNonNegative(nullIfSentinel(toNumber(item?.pm01 ?? null))), 1);
  const pm25      = round(sanitizeNonNegative(nullIfSentinel(toNumber(item?.pm02 ?? null))), 1);
  const pm10      = round(sanitizeNonNegative(nullIfSentinel(toNumber(item?.pm10 ?? null))), 1);
  const temperature = round(sanitizeTemperature(nullIfSentinel(toNumber(item?.atmp ?? null))), 1);
  const humidity  = round(sanitizeHumidity(nullIfSentinel(toNumber(item?.rhum ?? null))), 1);
  const co2       = round(sanitizeCo2(nullIfSentinel(toNumber(item?.rco2 ?? null))), 0);
  const tvoc      = round(sanitizeNonNegative(nullIfSentinel(toNumber(item?.tvoc ?? null))), 1);
  const tvocIndex = round(sanitizeNonNegative(nullIfSentinel(toNumber(item?.tvocIndex ?? null))), 0);
  const noxIndex  = round(sanitizeNonNegative(nullIfSentinel(toNumber(item?.noxIndex ?? null))), 0);
  const heatIndex = round(sanitizeTemperature(nullIfSentinel(toNumber(item?.heatIndex ?? null))), 1); // fixed: was item?.noxIndex
  const aqiResult = pm25 != null ? pm25toAQI(pm25) : null;
  const { imageKey, imageKeySelected } = buildImageKeys(aqiResult);
  const observedAtUtc = parseIso(item.timestamp ?? null);
  const timezone = item.timezone ?? 'UTC';
  const observedAt = splitIsoInTimezone(item.timestamp ?? null, timezone);
  const stationID = item.locationId != null ? `ag-${String(item.locationId)}` : null;

  const station: UnifiedStation = {
    source: 'AirGradient',
    stationID,
    nameTH: null,
    nameEN: item.locationName ?? null,
    areaTH: null,
    areaEN: null,
    lat: toNumber(item.latitude ?? null),
    lon: toNumber(item.longitude ?? null),
    pm25,
    aqi: aqiResult,
    observedAt,
    timezone,
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
        tvoc,
        tvocIndex,
        noxIndex,
        heatIndex,
      },
    },
    history24h: [],
  };

  return { station, detail };
}
