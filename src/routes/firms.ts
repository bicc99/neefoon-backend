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

export default router;
