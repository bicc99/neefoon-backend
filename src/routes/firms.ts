import type { Request, Response } from "express";
import { Router } from "express";
import { signUrl } from "../lib/signedUrl.js";

const router = Router();

// Path used as the HMAC input when minting signed URLs for the FIRMS PNG.
// Must match the actual request path the client will hit so the signature verifies.
const FIRMS_FIRES_PATH = "/firms/fires";

// How long a signed URL is valid for. Long enough for MapLibre to fetch and
// render the PNG (and tolerate a slow upstream from NASA on first fill),
// short enough that a leaked URL stops working quickly.
const SIGNED_URL_TTL_SEC = 600; // 10 minutes

const MAP_KEY = process.env.FIRMS_MAP_KEY;

// Covers Myanmar, Thailand, Laos, Vietnam, Cambodia, Malaysia, Indonesia, Philippines, Singapore, Brunei.
//
// Using EPSG:3857 (Web Mercator) so the image projection matches MapLibre's Mercator rendering.
// EPSG:4326 produces misalignment because its pixels have equal lat/lon spacing (equirectangular)
// while MapLibre stretches latitudes non-linearly — a projection mismatch ImageSource cannot correct.
//
// EPSG:3857 BBOX (minX,minY,maxX,maxY) in metres derived from lon 90–145°, lat -15°–30°:
//   x = lon * π * 6378137 / 180
//   y = ln(tan(π/4 + lat_rad/2)) * 6378137
const SEA_BBOX = '10018754,-1692124,16141326,3503550';

// Keep the image aspect ratio consistent with the Mercator bbox extents:
//   width_m  = 16141326 − 10018754 = 6122572
//   height_m = 3503550 − (−1692124) = 5195674
//   height_px = round(4096 * 5195674 / 6122572)
const WIDTH = 4096;
const HEIGHT = 3476;

// Make the layer configurable
// e.g. GET /fires?layer=fires_viirs_24
// Options: fires_viirs_24, fires_viirs_7, fires_modis_24, fires_modis_7
// Reference: https://firms.modaps.eosdis.nasa.gov/mapserver/wms-info/
const BASE_URL =
  `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${MAP_KEY}/` +
  `?SERVICE=WMS` +
  `&REQUEST=GetMap` +
  `&VERSION=1.3.0` +
  `&LAYERS=fires_viirs_24,fires_modis_24` +  
  `&STYLES=` +
  `&CRS=EPSG:3857` +
  `&BBOX=${SEA_BBOX}` +
  `&WIDTH=${WIDTH}` +
  `&HEIGHT=${HEIGHT}` +
  `&FORMAT=image/png` +
  `&TRANSPARENT=true`;
// In memory cache.
type FirmsCache = { data: Buffer; contentType: string; timestamp: number };
let cache: FirmsCache | null = null;
// Single-flight guard: holds the in-progress refresh so concurrent requests on a
// cold/stale cache await the same NASA fetch instead of each firing their own.
// This is the thundering-herd defence — N simultaneous callers collapse to 1 upstream hit.
let inflightRefresh: Promise<FirmsCache> | null = null;
// JS timing
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
// HTTP cache headers
const BROWSER_CACHE_SEC = 300; // 5 mins
const CDN_CACHE_SEC = 3600; // 1 hour

/**
 * Returns the FIRMS PNG cache, refreshing it from NASA first if it is empty or
 * older than CACHE_TTL_MS.
 *
 * Both /fires and /fires/sign read cache.timestamp through this function, so the
 * "Updated" time the client displays (from /fires/sign) always matches the PNG
 * /fires serves. Previously /fires/sign read a possibly-stale timestamp and only
 * triggered the refill afterward (via the new signed URL), so the chip lagged one
 * generation behind whenever the cache was stale at sign time.
 *
 * Single-flight: if a refresh is already running, await it rather than starting a
 * second NASA fetch. The promise is cleared in finally() so the next stale window
 * can refresh again.
 */
async function getFirmsCache(): Promise<FirmsCache> {
  if (!MAP_KEY) throw new Error("FIRMS_MAP_KEY not configured");

  const now = Date.now();
  if (cache && now - cache.timestamp < CACHE_TTL_MS) return cache;

  if (!inflightRefresh) {
    inflightRefresh = (async () => {
      const response = await fetch(BASE_URL);
      if (!response.ok) {
        throw new Error(`FIRMS WMS request failed with status ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "image/png";
      const buffer = Buffer.from(await response.arrayBuffer());
      // Stamp the timestamp at fetch completion so it reflects when this data was
      // actually retrieved from NASA, which is what the client shows as "Updated".
      cache = { data: buffer, contentType, timestamp: Date.now() };
      return cache;
    })().finally(() => {
      // Clear regardless of success/failure so a failed fetch doesn't lock out retries.
      inflightRefresh = null;
    });
  }

  return inflightRefresh;
}

// ─── Tile proxy ──────────────────────────────────────────────────────────────
//
// The single SEA PNG above does not scale worldwide: a global PNG is either too
// low-res to be useful or too large to ship. Instead, clients fetch only the
// XYZ raster tiles their current viewport covers. Each tile is a small WMS
// GetMap against NASA, cached per z/x/y/layer/time-bucket and reused across
// every user looking at the same area — the same caching contract as /fires,
// applied per tile so cache hit rates stay high regardless of where users pan.

// Path the tile signature is bound to. One signed URL authorizes "may request
// FIRMS tiles"; the specific z/x/y/layer are validated per request below, not by
// the signature. MUST match TILE_SIGNED_PREFIX in lib/auth.ts.
const FIRMS_TILES_PATH = "/firms/tiles";

// One signature covers a whole browsing session's worth of tiles, so this is
// longer than the single-PNG TTL. Set above the client's max re-sign gap (the
// Hotspot screen refreshes on a 45–75 min jittered window) so the signature
// never expires mid-session and 404s freshly panned tiles. These are public
// fire-data tiles with the API key kept server-side, so a longer window is a
// freshness/UX choice, not a meaningful security exposure.
const TILE_SIGNED_URL_TTL_SEC = 2 * 60 * 60; // 2 hours

// Half the Web Mercator (EPSG:3857) world extent, in metres. Tile bboxes derive
// from this.
const MERCATOR_ORIGIN = 20037508.342789244;

// 512px tiles: fire pixels are sparse so the PNGs stay tiny, and larger tiles
// mean fewer requests per viewport than 256px.
const TILE_SIZE_PX = 512;

// VIIRS/MODIS detections are 375m–1km footprints, so past this zoom WMS adds no
// real detail. Clients set the raster source's maxzoom to TILE_MAX_ZOOM and let
// MapLibre overzoom (upscale) that tile — which also saves data. Higher zooms
// are rejected so a signed URL can't request an unbounded number of fine tiles.
const TILE_MIN_ZOOM = 0;
const TILE_MAX_ZOOM = 9;

// Layers a client may request, validated token-by-token so a leaked signature
// cannot inject arbitrary LAYERS into the upstream WMS call.
const ALLOWED_TILE_LAYERS = new Set([
  "fires_viirs_24",
  "fires_viirs_7",
  "fires_modis_24",
  "fires_modis_7",
]);
const DEFAULT_TILE_LAYERS = "fires_viirs_24,fires_modis_24";

// NASA FIRMS WMS data refreshes ~every 15 min. Bucketing the cache key to 15 min
// makes freshness explicit (a new bucket == a new data generation) and bounds
// how stale any served tile can be. All tiles in a bucket share one timestamp,
// so Last-Modified / conditional requests are consistent across a generation.
const TILE_BUCKET_MS = 15 * 60 * 1000;

// Bounded LRU so a client scanning every tile at max zoom can't grow memory
// without limit. Map preserves insertion order: we delete+reinsert on read to
// mark most-recently-used, and evict the oldest (first) key when over capacity.
const TILE_CACHE_MAX = 2000;
const tileCache = new Map<string, FirmsCache>();
// Single-flight per tile key: concurrent requests for the same cold tile await
// one NASA fetch instead of each firing their own — the same thundering-herd
// defence as inflightRefresh above, but keyed per tile.
const tileInflight = new Map<string, Promise<FirmsCache>>();

/**
 * z/x/y (XYZ scheme, origin top-left) → EPSG:3857 bbox string for a WMS 1.3.0
 * GetMap. y counts down from the top, so the northern edge uses y and the
 * southern edge y+1.
 */
function tileBBox3857(z: number, x: number, y: number): string {
  const span = (2 * MERCATOR_ORIGIN) / 2 ** z; // tile edge length in metres
  const minX = -MERCATOR_ORIGIN + x * span;
  const maxX = -MERCATOR_ORIGIN + (x + 1) * span;
  const maxY = MERCATOR_ORIGIN - y * span;
  const minY = MERCATOR_ORIGIN - (y + 1) * span;
  // EPSG:3857 axis order is easting,northing → BBOX=minX,minY,maxX,maxY,
  // matching the ordering the SEA PNG bbox already used.
  return `${minX},${minY},${maxX},${maxY}`;
}

/** Builds the NASA FIRMS WMS GetMap URL for one tile. Keeps MAP_KEY server-side. */
function buildTileWmsUrl(z: number, x: number, y: number, layers: string): string {
  return (
    `https://firms.modaps.eosdis.nasa.gov/mapserver/wms/fires/${MAP_KEY}/` +
    `?SERVICE=WMS` +
    `&REQUEST=GetMap` +
    `&VERSION=1.3.0` +
    `&LAYERS=${layers}` +
    `&STYLES=` +
    `&CRS=EPSG:3857` +
    `&BBOX=${tileBBox3857(z, x, y)}` +
    `&WIDTH=${TILE_SIZE_PX}` +
    `&HEIGHT=${TILE_SIZE_PX}` +
    `&FORMAT=image/png` +
    `&TRANSPARENT=true`
  );
}

/** Inserts a tile into the LRU, evicting the oldest entry once over capacity. */
function putTile(key: string, entry: FirmsCache): void {
  tileCache.set(key, entry);
  if (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value;
    if (oldest !== undefined) tileCache.delete(oldest);
  }
}

/**
 * Returns a tile from cache, fetching it from NASA (single-flight) on a miss.
 * Cache key includes the 15-min time bucket so a new generation is fetched
 * automatically; the entry timestamp is the bucket start, shared by every tile
 * of that generation.
 */
async function getTile(z: number, x: number, y: number, layers: string): Promise<FirmsCache> {
  if (!MAP_KEY) throw new Error("FIRMS_MAP_KEY not configured");

  const bucket = Math.floor(Date.now() / TILE_BUCKET_MS);
  const key = `${z}/${x}/${y}/${layers}/${bucket}`;

  const hit = tileCache.get(key);
  if (hit) {
    // LRU touch: move to most-recently-used position.
    tileCache.delete(key);
    tileCache.set(key, hit);
    return hit;
  }

  let flight = tileInflight.get(key);
  if (!flight) {
    flight = (async () => {
      const response = await fetch(buildTileWmsUrl(z, x, y, layers));
      if (!response.ok) {
        throw new Error(`FIRMS WMS tile request failed with status ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "image/png";
      const data = Buffer.from(await response.arrayBuffer());
      // Timestamp = bucket start so every tile in a generation reports the same
      // Last-Modified, keeping conditional requests consistent.
      const entry: FirmsCache = { data, contentType, timestamp: bucket * TILE_BUCKET_MS };
      putTile(key, entry);
      return entry;
    })().finally(() => {
      // Clear regardless of outcome so a failed fetch doesn't lock out retries.
      tileInflight.delete(key);
    });
    tileInflight.set(key, flight);
  }

  return flight;
}

/**
 * Validates and normalizes tile request params. Returns null on any invalid
 * input so the route can 400. Rejecting out-of-range z/x/y and off-allowlist
 * layers is what keeps a valid signature from being turned into an arbitrary
 * (or unboundedly expensive) upstream WMS request.
 */
function parseTileParams(
  req: Request,
): { z: number; x: number; y: number; layers: string } | null {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  if (![z, x, y].every(Number.isInteger)) return null;
  if (z < TILE_MIN_ZOOM || z > TILE_MAX_ZOOM) return null;

  // At zoom z there are 2^z tiles per axis, indexed [0, 2^z).
  const axisCount = 2 ** z;
  if (x < 0 || x >= axisCount || y < 0 || y >= axisCount) return null;

  const layerRaw =
    typeof req.query.layer === "string" ? req.query.layer : DEFAULT_TILE_LAYERS;
  const tokens = layerRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) return null;
  if (!tokens.every((t) => ALLOWED_TILE_LAYERS.has(t))) return null;

  // Preserve client order (WMS draws later layers on top) but use the
  // re-joined, validated string as the canonical cache key.
  return { z, x, y, layers: tokens.join(",") };
}

/**
 * Mints a short-lived signed URL the client can hand to MapLibre's ImageSource.
 *
 * Why a separate sign endpoint instead of letting the client embed an API key?
 *   MapLibre cannot attach an Authorization header to its internal fetches, and
 *   embedding the static API key in a query string leaks it into every server
 *   access log. A signed URL is path-bound and time-bound: even if it is logged,
 *   the leak is limited to one resource for a few minutes.
 *
 * Honors If-Modified-Since just like /fires so the client can skip a refresh when
 * the underlying PNG hasn't changed. The Last-Modified value returned here matches
 * what the actual /fires response would return.
 */
router.get("/fires/sign", async (req: Request, res: Response) => {
  try {
    // Refresh-then-read: guarantees the timestamp we report below matches the PNG
    // /fires will serve, so the client's "Updated" chip is never a generation behind.
    const current = await getFirmsCache();

    // RFC 7232 conditional request: if the client already has this version, 304.
    // HTTP dates have second precision, so compare in seconds to avoid false mismatches.
    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const clientTimeSec = Math.floor(new Date(ifModifiedSince).getTime() / 1000);
      const cacheTimeSec = Math.floor(current.timestamp / 1000);
      if (!isNaN(clientTimeSec) && clientTimeSec >= cacheTimeSec) {
        res.status(304).end();
        return;
      }
    }

    const { exp, sig } = signUrl(FIRMS_FIRES_PATH, SIGNED_URL_TTL_SEC);
    const lastModified = new Date(current.timestamp).toUTCString();

    res.json({ exp, sig, lastModified });
  } catch (error) {
    res.status(502).json({
      error: "Failed to prepare FIRMS signed URL",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// GET
router.get("/fires", async (req: Request, res: Response) => {
  try {
    // Refresh-then-read through the shared single-flight cache, so this PNG and the
    // timestamp /fires/sign reported come from the same generation.
    const current = await getFirmsCache();

    // RFC 7232 conditional request: if the client already has this version, return 304
    // with no body. This saves bandwidth — the client skips re-downloading the PNG.
    // HTTP dates have second precision, so we compare in seconds to avoid false mismatches.
    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const clientTimeSec = Math.floor(new Date(ifModifiedSince).getTime() / 1000);
      const cacheTimeSec  = Math.floor(current.timestamp / 1000);
      if (!isNaN(clientTimeSec) && clientTimeSec >= cacheTimeSec) {
        res.status(304).end();
        return;
      }
    }

    res.set("Content-Type", current.contentType);
    // max-age = browser, s-maxage = CDN/shared cache
    res.set("Cache-Control", `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${CDN_CACHE_SEC}`);
    // Standard HTTP header: tells clients when the backend last fetched from NASA FIRMS.
    // Clients read this to display "Updated HH:MM" and use it as a stable cache-bust key —
    // the value only changes when the backend gets fresh data (every hour).
    res.set("Last-Modified", new Date(current.timestamp).toUTCString());
    res.send(current.data);
  } catch (error) {
    // getFirmsCache throws on a missing MAP_KEY or an upstream NASA failure; surface
    // it as a 502 (bad upstream) rather than a generic 500.
    res.status(502).json({
      error: "Failed to fetch FIRMS fires",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
})

/**
 * Mints a signed URL the client uses to build a MapLibre raster tile source.
 *
 * Unlike /fires/sign, one signature here covers every z/x/y tile for its TTL
 * (it is bound to the /firms/tiles prefix, not a single path). The client builds
 * its source template as:
 *   `${BASE}/firms/tiles/{z}/{x}/{y}.png?exp=${exp}&sig=${sig}`
 * and sets minzoom/maxzoom from the values returned here so MapLibre overzooms
 * past TILE_MAX_ZOOM rather than requesting non-existent fine tiles.
 *
 * lastModified is the current 15-min data generation start, suitable for the
 * client's "Updated" chip and as a stable cache-bust key.
 */
router.get("/tiles/sign", (_req: Request, res: Response) => {
  if (!MAP_KEY) {
    res.status(502).json({ error: "FIRMS_MAP_KEY not configured" });
    return;
  }

  const { exp, sig } = signUrl(FIRMS_TILES_PATH, TILE_SIGNED_URL_TTL_SEC);
  const bucketStart = Math.floor(Date.now() / TILE_BUCKET_MS) * TILE_BUCKET_MS;

  res.json({
    exp,
    sig,
    lastModified: new Date(bucketStart).toUTCString(),
    minzoom: TILE_MIN_ZOOM,
    maxzoom: TILE_MAX_ZOOM,
    tileSize: TILE_SIZE_PX,
  });
});

/**
 * Serves one FIRMS raster tile. Auth (signed-URL prefix verification) already
 * happened in requireAuth; here we validate the coordinates/layer and serve from
 * the per-tile cache, honoring conditional requests just like /fires.
 */
router.get("/tiles/:z/:x/:y.png", async (req: Request, res: Response) => {
  try {
    const params = parseTileParams(req);
    if (!params) {
      res.status(400).json({ error: "Invalid tile request" });
      return;
    }

    const tile = await getTile(params.z, params.x, params.y, params.layers);

    // RFC 7232 conditional request: skip re-sending the tile if the client
    // already has this generation. Second precision to match HTTP date format.
    const ifModifiedSince = req.headers["if-modified-since"];
    if (ifModifiedSince) {
      const clientTimeSec = Math.floor(new Date(ifModifiedSince).getTime() / 1000);
      const tileTimeSec = Math.floor(tile.timestamp / 1000);
      if (!isNaN(clientTimeSec) && clientTimeSec >= tileTimeSec) {
        res.status(304).end();
        return;
      }
    }

    res.set("Content-Type", tile.contentType);
    res.set("Cache-Control", `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${CDN_CACHE_SEC}`);
    res.set("Last-Modified", new Date(tile.timestamp).toUTCString());
    res.send(tile.data);
  } catch (error) {
    res.status(502).json({
      error: "Failed to fetch FIRMS tile",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
