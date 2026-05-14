import type { AqiResult, ObservedAt, PollutantReading } from "../../types/aqi.js";

interface Breakpoint {
  cLow: number;
  cHigh: number;
  iLow: number;
  iHigh: number;
  label: string;
  color: string;
  textColor: string;
  colorKey: string;
  advice: string;
}

/**
 * PM2.5 -> US AQI Conversion (EPA Piecewise Linear Formula)
 *
 * Formula:
 *   AQI = ((I_high - I_low) / (C_high - C_low)) * (C - C_low) + I_low
 *
 *   Where:
 *     C       = truncated PM2.5 concentration (1 decimal, e.g. Math.floor(pm25 * 10) / 10)
 *     C_low   = lower PM2.5 breakpoint for the range C falls in
 *     C_high  = upper PM2.5 breakpoint for the range C falls in
 *     I_low   = lower AQI value for that range
 *     I_high  = upper AQI value for that range
 *
 * PM2.5 Breakpoint Table (24-hr avg, µg/m³) — EPA 2024 revised standard:
 *
 *   AQI Category                    | AQI Range | PM2.5 (µg/m³)
 *   --------------------------------|-----------|---------------
 *   Good                            |   0–50    |   0.0–9.0
 *   Moderate                        |  51–100   |   9.1–35.4
 *   Unhealthy for Sensitive Groups  | 101–150   |  35.5–55.4
 *   Unhealthy                       | 151–200   |  55.5–125.4
 *   Very Unhealthy                  | 201–300   | 125.5–225.4
 *   Hazardous                       | 301–500   | 225.5–325.4
 *
 * Note: Always truncate (not round) PM2.5 to 1 decimal before calculating.
 */
export const PM25_BREAKPOINTS: Breakpoint[] = [
  { cLow: 0.0,   cHigh: 9.0,   iLow: 0,   iHigh: 50,  label: 'Good',                           color: '#7ED07A', textColor: 'black', colorKey: 'c_good',      advice: 'Great day to be outside' },
  { cLow: 9.1,   cHigh: 35.4,  iLow: 51,  iHigh: 100, label: 'Moderate',                       color: '#FFE15A', textColor: 'black', colorKey: 'c_moderate',  advice: 'Air quality is acceptable for most people' },
  { cLow: 35.5,  cHigh: 55.4,  iLow: 101, iHigh: 150, label: 'Unhealthy for Sensitive Groups', color: '#FF9E4A', textColor: 'white', colorKey: 'c_usg',       advice: 'Sensitive groups should reduce outdoor activity' },
  { cLow: 55.5,  cHigh: 125.4, iLow: 151, iHigh: 200, label: 'Unhealthy',                      color: '#F05A5A', textColor: 'white', colorKey: 'c_unhealthy', advice: 'Air quality is not ideal for outdoor activity' },
  { cLow: 125.5, cHigh: 225.4, iLow: 201, iHigh: 300, label: 'Very Unhealthy',                 color: '#A16BC7', textColor: 'white', colorKey: 'c_very',      advice: 'It is better to stay indoors' },
  { cLow: 225.5, cHigh: 325.4, iLow: 301, iHigh: 500, label: 'Hazardous',                      color: '#7E2A3A', textColor: 'white', colorKey: 'c_hazardous', advice: 'Avoid going outside unless necessary' },
];

export function pm25toAQI(pm25: number): AqiResult | null {
  const c = Math.floor(pm25 * 10) / 10; // truncate to 1 decimal (EPA standard)

  if (c === 0) return null;

  const bp = PM25_BREAKPOINTS.find(b => c >= b.cLow && c <= b.cHigh);
  if (!bp) return null;

  const aqi = Math.round(
    ((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (c - bp.cLow) + bp.iLow
  );

  return {
    value: aqi,
    label: bp.label,
    color: bp.color,
    textColor: bp.textColor,
    colorKey: bp.colorKey,
    advice: bp.advice,
  };
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function nullIfSentinel(value: number | null, sentinels: number[] = [-1, -999]): number | null {
  if (value === null) return null;
  return sentinels.includes(value) ? null : value;
}

export function sanitizeNonNegative(value: number | null): number | null {
  if (value === null) return null;
  return value < 0 ? null : value;
}

export function sanitizeTemperature(value: number | null): number | null {
  if (value === null) return null;
  if (value < -50 || value > 80) return null;
  return value;
}

export function sanitizeHumidity(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0 || value > 100) return null;
  return value;
}

export function sanitizeCo2(value: number | null): number | null {
  if (value === null) return null;
  if (value <= 0 || value > 10000) return null;
  return value;
}

export function reading(value: number | null, unit: string): PollutantReading {
  return { value, unit };
}

export function round(value: number | null, decimals: number): number | null {
  if (value === null) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export function buildImageKeys(aqi: AqiResult | null): { imageKey: string; imageKeySelected: string } {
  if (aqi?.value != null && aqi.colorKey) {
    return {
      imageKey: `${aqi.colorKey}_${aqi.value}`,
      imageKeySelected: `${aqi.colorKey}_s_${aqi.value}`,
    };
  }
  return {
    imageKey: 'c_nodata',
    imageKeySelected: 'c_nodata_s',
  };
}

export function buildObservedAt(date?: string, time?: string): ObservedAt {
  return {
    date: date ?? null,
    time: time ?? null,
  };
}

export function splitIsoInTimezone(value: string | null | undefined, timeZone: string): ObservedAt {
  if (!value) return { date: null, time: null };

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: null, time: null };

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? null;

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

export function combineObservedAtUtc(
  date: string | null | undefined,
  time: string | null | undefined,
  timeZone: string
): string | null {
  if (!date || !time) return null;
  // For Asia/Bangkok, external APIs publish local civil time.
  if (timeZone === 'Asia/Bangkok') {
    return `${date}T${time}:00+07:00`;
  }
  return null;
}

export function parseIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
