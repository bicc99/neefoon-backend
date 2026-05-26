import type { Request, Response } from "express";
import { Router } from "express";
import { signUrl } from "../lib/apiKey.js";

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
let cache: { data: Buffer; contentType: string; timestamp: number } | null = null;
// JS timing
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
// HTTP cache headers
const BROWSER_CACHE_SEC = 300; // 5 mins
const CDN_CACHE_SEC = 3600; // 1 hour

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
router.get("/fires/sign", (req: Request, res: Response) => {
  const now = Date.now();
  const haveFreshCache = cache && now - cache.timestamp < CACHE_TTL_MS;

  if (haveFreshCache) {
    const ifModifiedSince = req.headers['if-modified-since'];
    if (ifModifiedSince) {
      const clientTimeSec = Math.floor(new Date(ifModifiedSince).getTime() / 1000);
      const cacheTimeSec = Math.floor(cache!.timestamp / 1000);
      if (!isNaN(clientTimeSec) && clientTimeSec >= cacheTimeSec) {
        res.status(304).end();
        return;
      }
    }
  }

  const { exp, sig } = signUrl(FIRMS_FIRES_PATH, SIGNED_URL_TTL_SEC);

  // If the cache is empty (cold start), lastModified is null. The client treats
  // this as "no last-modified yet" and the next /fires request will populate the
  // cache as a side-effect of serving the PNG.
  const lastModified = cache ? new Date(cache.timestamp).toUTCString() : null;

  res.json({ exp, sig, lastModified });
});

// GET
router.get("/fires", async (req: Request, res: Response) => {
  try {
    if (!MAP_KEY) {
      res.status(500).json({ error: "FIRMS_MAP_KEY not configured"});
      return;
    }

    const now = Date.now();

    if(cache && now - cache.timestamp < CACHE_TTL_MS) {
      // RFC 7232 conditional request: if the client already has this version, return 304
      // with no body. This saves bandwidth — the client skips re-downloading the PNG.
      // HTTP dates have second precision, so we compare in seconds to avoid false mismatches.
      const ifModifiedSince = req.headers['if-modified-since'];
      if (ifModifiedSince) {
        const clientTimeSec = Math.floor(new Date(ifModifiedSince).getTime() / 1000);
        const cacheTimeSec  = Math.floor(cache.timestamp / 1000);
        if (!isNaN(clientTimeSec) && clientTimeSec >= cacheTimeSec) {
          res.status(304).end();
          return;
        }
      }

      res.set("Content-Type", cache.contentType);
      // max-age = browser, s-maxage = CDN/shared cache
      res.set("Cache-Control", `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${CDN_CACHE_SEC}`);
      // Standard HTTP header: tells clients when the backend last fetched from NASA FIRMS.
      // Clients read this to display "Updated HH:MM" and use it as a stable cache-bust key —
      // the value only changes when the backend gets fresh data (every hour).
      res.set("Last-Modified", new Date(cache.timestamp).toUTCString());
      res.send(cache.data);
      return;
    }
    
    const response = await fetch(BASE_URL);

    if (!response.ok) {
      res.status(502).json({
        error: "FIRMS WMS request failed",
        status: response.status,
      });
      return;
    }

    const contentType = response.headers.get("content-type") ?? "image/png";
    const buffer = Buffer.from(await response.arrayBuffer());

    cache = { data: buffer, contentType, timestamp: now };

    res.set("Content-Type", contentType);
    res.set("Cache-Control", `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${CDN_CACHE_SEC}`);
    res.set("Last-Modified", new Date(now).toUTCString());
    res.send(buffer);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch FIRMS fires",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
  
})

export default router;
