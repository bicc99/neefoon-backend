import "dotenv/config";
import fs from "fs/promises";
import path from "path";

type Station = {
  stationID: string | null;
  lat: number | null;
  lon: number | null;
};

type GeocodeResult = {
  country: string | null;
  country_code: string | null;
  city: string | null;
};

const CACHE_FILE = path.join(process.cwd(), "data", "geocode-cache.json");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCoordKey(lat: number, lon: number): string {
  return `${lat},${lon}`;
}

async function loadCache(): Promise<Record<string, GeocodeResult>> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, GeocodeResult>) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function normalizeProvince(value: string | undefined): string | undefined {
  return value?.replace(/ Province$/, "");
}

function normalizeCountry(value: string | undefined): string | undefined {
  if (value === "United States of America") return "USA";
  if (value === "United Kingdom") return "UK";
  return value;
}

function getCity(address: any): string | null {
  if (address.country_code === "au" || address.country_code === "gb") {
    return (
      address.county ??
      address.city ??
      address.town ??
      address.municipality ??
      address.village ??
      normalizeProvince(address.province) ??
      address.state ??
      null
    );
  }
  return (
    normalizeProvince(address.province) ??
    address.city ??
    address.town ??
    address.municipality ??
    address.village ??
    address.county ??
    address.state ??
    null
  );
}

async function reverseGeocodeLocationIQ(
  lat: number,
  lon: number
): Promise<GeocodeResult> {
  const apiKey = process.env.LOCATIONIQ_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LOCATIONIQ_API_KEY");
  }

  const url = new URL("https://us1.locationiq.com/v1/reverse");

  url.searchParams.set("key", apiKey);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("normalizeaddress", "1");
  url.searchParams.set("accept-language", "en");

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`LocationIQ failed: ${res.status}`);
  }

  const data = await res.json() as { address?: Record<string, string> };
  const address = data.address ?? {};

  return {
    country: normalizeCountry(address.country) ?? null,
    country_code: address.country_code ?? null,
    city: getCity(address),
  };
}

async function main() {
  const stationsRaw = await fs.readFile(
    path.join(process.cwd(), "aqiTotal.json"),
    "utf-8"
  );

  const stations: Station[] = JSON.parse(stationsRaw).stations;
  const cache = await loadCache();

  let added = 0;
  let skipped = 0;

  for (const station of stations) {
    if (station.lat == null || station.lon == null) continue;

    const key = makeCoordKey(station.lat, station.lon);

    if (cache[key] && "country_code" in cache[key]) {
      skipped++;
      continue;
    }

    console.log(`Geocoding ${key}`);

    try {
      cache[key] = await reverseGeocodeLocationIQ(station.lat, station.lon);
    } catch (e) {
      console.warn(`Skipping ${key}: ${e}`);
      cache[key] = { country: null, country_code: null, city: null };
    }
    added++;

    await saveCache(cache);

    // Safe delay. Avoid hitting rate limits.
    await sleep(1200);
  }

  console.log(`Done. Added: ${added}, skipped: ${skipped}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});