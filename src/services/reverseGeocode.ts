import fs from "node:fs";
import path from "node:path";

export type ReverseGeocodeResult = {
  country: string | null;
  country_code: string | null;
  city: string | null;
};

const CACHE_FILE = path.join(process.cwd(), "data", "geocode-cache.json");

// 1 req/sec is LocationIQ's free-tier limit; 1100 ms gives a small buffer
const FETCH_INTERVAL_MS = 1100;

// ── Persistent file cache ────────────────────────────────────────────────────

function loadFileCache(): Map<string, ReverseGeocodeResult> {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const json = JSON.parse(raw) as Record<string, ReverseGeocodeResult>;
    return new Map(Object.entries(json));
  } catch {
    return new Map();
  }
}

const geoCache = loadFileCache();

function persistCache(): void {
  const obj: Record<string, ReverseGeocodeResult> = Object.fromEntries(geoCache);
  fs.promises
    .writeFile(CACHE_FILE, JSON.stringify(obj, null, 2), "utf-8")
    .catch((e) => console.error("Failed to write geocode cache:", e));
}

// ── Rate-limited queue ───────────────────────────────────────────────────────
// Processes one LocationIQ request at a time with FETCH_INTERVAL_MS between
// each, so a burst of 20+ uncached stations never exceeds the API rate limit.

type QueueTask = {
  lat: number;
  lon: number;
  resolve: (result: ReverseGeocodeResult | null) => void;
  reject: (error: unknown) => void;
};

const fetchQueue: QueueTask[] = [];
let queueRunning = false;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runQueue(): Promise<void> {
  queueRunning = true;
  while (fetchQueue.length > 0) {
    const task = fetchQueue.shift()!;
    try {
      task.resolve(await fetchFromLocationIQ(task.lat, task.lon));
    } catch (e) {
      task.reject(e);
    }
    if (fetchQueue.length > 0) {
      await sleep(FETCH_INTERVAL_MS);
    }
  }
  await Promise.resolve(); // flush pending .then() callbacks (e.g. "cached" logs) before finishing
  queueRunning = false;
  console.log(`Geocoding queue finished — ${geoCache.size} entries in cache`);
}

function enqueueGeocode(lat: number, lon: number): Promise<ReverseGeocodeResult | null> {
  return new Promise((resolve, reject) => {
    fetchQueue.push({ lat, lon, resolve, reject });
    if (!queueRunning) runQueue();
  });
}

// ── In-flight deduplication ──────────────────────────────────────────────────
// If the same coordinate is requested while already in the queue, callers
// share one promise instead of enqueuing redundant API calls.

const inFlight = new Map<string, Promise<ReverseGeocodeResult>>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCoordKey(lat: number, lon: number): string {
  return `${lat},${lon}`;
}

function normalizeProvince(value: string | undefined): string | undefined {
  return value?.replace(/ Province$/, "");
}

function normalizeCountry(value: string | undefined): string | undefined {
  if (value === "United States of America") return "USA";
  if (value === "United Kingdom") return "UK";
  return value;
}

function getCity(address: Record<string, string>): string | null {
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
    normalizeProvince(address.state) ??
    address.city ??
    address.town ??
    address.municipality ??
    address.county ??
    null
  );
}

async function fetchFromLocationIQ(
  lat: number,
  lon: number
): Promise<ReverseGeocodeResult | null> {
  const apiKey = process.env.LOCATIONIQ_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LOCATIONIQ_API_KEY in .env");
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

  const data = (await res.json()) as { address?: Record<string, string> };
  const address = data.address ?? {};

  // console.log(`[geocode debug] ${lat},${lon}`, JSON.stringify(address));

  return {
    country: normalizeCountry(address.country) ?? null,
    country_code: address.country_code ?? null,
    city: getCity(address),
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function reverseGeocodeLatLon(
  lat: number | null,
  lon: number | null
): Promise<ReverseGeocodeResult | null> {
  if (lat == null || lon == null) return null;

  const key = makeCoordKey(lat, lon);

  // 1. Persistent cache (file-backed, survives restarts)
  const cached = geoCache.get(key);
  if (cached) return cached;

  // 2. In-flight deduplication (same coordinate already queued)
  const existing = inFlight.get(key);
  if (existing) {
    console.log(`Geocoding ${key} — in-flight, deduped`);
    return existing;
  }

  // 3. Enqueue a rate-limited LocationIQ request
  console.log(`Geocoding ${key} — queuing fetch (queue length: ${fetchQueue.length + 1})`);
  const promise = enqueueGeocode(lat, lon).then(
    (result) => {
      const final = result ?? { country: null, country_code: null, city: null };
      geoCache.set(key, final);
      inFlight.delete(key);
      persistCache();
      console.log(`Geocoding ${key} — cached: ${final.city ?? '?'}, ${final.country_code ?? '?'}`);
      return final;
    },
    (error) => {
      console.error("Reverse geocoding failed:", error);
      // Do not cache errors — allow retry on the next request cycle
      inFlight.delete(key);
      return { country: null, country_code: null, city: null } as ReverseGeocodeResult;
    }
  );

  inFlight.set(key, promise);
  return promise;
}
