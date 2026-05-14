import { reverseGeocodeLatLon } from "../reverseGeocode.js";
import type { AqiResult, UnifiedStation } from "../../types/aqi.js";

export type { AqiResult, UnifiedStation };

export type RankedCityItem = {
  id: string;
  country: string;
  country_code: string | null;
  city: string;
  aqi: number;
  stationCount: number;
};

type Metric = "mean" | "median";
type Sort = "asc" | "desc";

type NormalizedRankingStation = {
  stationID: string | null;
  source: string;
  country: string;
  country_code: string | null;
  city: string;
  aqiValue: number | null;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }

  return sorted[mid] ?? 0;
}

async function normalizeRankingStation(station: UnifiedStation): Promise<NormalizedRankingStation> {
  const geo = await reverseGeocodeLatLon(station.lat, station.lon);

  return {
    stationID: station.stationID,
    source: station.source,
    country: geo?.country ?? "Unknown",
    country_code: geo?.country_code ?? null,
    city: geo?.city ?? "Unknown",
    aqiValue: station.aqi?.value ?? null,
  };
}

export type RankingCountryItem = {
  name: string;
  country_code: string | null;
};

export async function getRankingCountries(stations: UnifiedStation[]): Promise<RankingCountryItem[]> {
  const normalized = await Promise.all(stations.map(normalizeRankingStation));

  const countryMap = new Map<string, string | null>();
  for (const s of normalized) {
    if (!countryMap.has(s.country)) {
      countryMap.set(s.country, s.country_code);
    }
  }

  const sorted = Array.from(countryMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, country_code]) => ({ name, country_code }));

  return [{ name: "all", country_code: null }, ...sorted];
}

export async function buildCityRankings(
  stations: UnifiedStation[],
  options?: {
    country?: string;
    sort?: Sort;
    metric?: Metric;
  }
): Promise<RankedCityItem[]> {
  const countryFilter = options?.country ?? "all";
  const sort = options?.sort ?? "desc";
  const metric = options?.metric ?? "median";

  const normalized = await Promise.all(stations.map(normalizeRankingStation));

  const filtered = normalized.filter((station) => {
    if (station.aqiValue == null) return false;
    if (station.city === "Unknown") return false; // Drop 'Unknown' cities
    if (countryFilter === "all") return true;

    return station.country.toLowerCase() === countryFilter.toLowerCase();
  });

  const grouped = new Map<string, { values: number[]; country_code: string | null }>();

  for (const station of filtered) {
    const key = `${station.country}__${station.city}`;
    if (!grouped.has(key)) grouped.set(key, { values: [], country_code: station.country_code });
    grouped.get(key)!.values.push(station.aqiValue!);
  }

  const items: RankedCityItem[] = Array.from(grouped.entries()).map(([key, { values, country_code }]) => {
    const [country = "", city = ""] = key.split("__");
    const aqi = metric === "mean" ? mean(values) : median(values);

    return {
      id: `${country_code ?? country}-${city}`,
      country,
      country_code,
      city,
      aqi,
      stationCount: values.length,
    };
  });

  items.sort((a, b) => {
    return sort === "desc" ? b.aqi - a.aqi : a.aqi - b.aqi;
  });

  return items;
}
