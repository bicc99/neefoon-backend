import type { Request, Response } from "express";
import { Router } from "express";
import cron from "node-cron";

import { buildCityRankings, getRankingCountries } from "../services/aqi/aqiRanking.js";
import { getDailyForYear } from "../services/aqi/history.js";
import { buildCurrentSprite } from "../services/aqi/sprite.js";
import { getCachedData, fetchAllStations, buildMarkerKeys, warmCache } from "../services/aqi/aggregate.js";
import { applyJsonCacheHeaders, applyBinaryCacheHeaders } from "../lib/httpCache.js";
import type { AllResponse } from "../types/aqi.js";

export { pm25toAQI } from "../services/aqi/aqiMath.js";

const router = Router();

router.get('/all', async (req: Request, res: Response) => {
  try {
    const { all } = await getCachedData(req);
    applyJsonCacheHeaders(res);
    res.json(all);
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch AQI data",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get('/stations/:stationID', async (req: Request, res: Response) => {
  try {
    const { detailsByStationID } = await getCachedData(req);
    const rawID = (Array.isArray(req.params.stationID) ? req.params.stationID[0] : req.params.stationID) ?? '';
    const stationID = decodeURIComponent(rawID);
    const detail = detailsByStationID[stationID];

    if (!detail) {
      res.status(404).json({
        error: 'Station not found',
        message: `No detail found for stationID: ${stationID}`,
      });
      return;
    }
    applyJsonCacheHeaders(res);
    res.json(detail);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch AQI station detail',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/markers/current/sprite.json', async (req: Request, res: Response) => {
  try {
    const { all } = await getCachedData(req);
    const sprite = await buildCurrentSprite(all.markerKeys);
    applyJsonCacheHeaders(res);
    res.json(sprite.json);
  } catch (error) {
    res.status(500).json({
      error: "Failed to build sprite JSON",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get('/markers/current/sprite.png', async (req: Request, res: Response) => {
  try {
    const { all } = await getCachedData(req);
    const sprite = await buildCurrentSprite(all.markerKeys);
    applyBinaryCacheHeaders(res, "image/png");
    res.send(sprite.png);
  } catch (error) {
    res.status(500).json({
      error: "Failed to build sprite PNG",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// @2x endpoints for higher resolution sprites for devices with higher pixel density
router.get('/markers/current/sprite@2x.json', async (req: Request, res: Response) => {
  try {
    const { all } = await getCachedData(req);
    const sprite = await buildCurrentSprite(all.markerKeys);
    applyJsonCacheHeaders(res);
    res.json(sprite.json);
  } catch (error) {
    res.status(500).json({
      error: "Failed to build sprite @2x JSON",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get('/markers/current/sprite@2x.png', async (req: Request, res: Response) => {
  try {
    const { all } = await getCachedData(req);
    const sprite = await buildCurrentSprite(all.markerKeys);
    applyBinaryCacheHeaders(res, "image/png");
    res.send(sprite.png);
  } catch (error) {
    res.status(500).json({
      error: "Failed to build sprite @2x PNG",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get('/rankings/countries', async (req: Request, res: Response) => {
  try {
    const { all } = await getCachedData(req);
    const items = await getRankingCountries(all.stations);
    applyJsonCacheHeaders(res);
    res.json({ items });
  } catch (error) {
    res.status(500).json({
      error: "Failed to fetch ranking countries",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get('/rankings/cities', async (req: Request, res: Response) => {
  try {
    const country = typeof req.query.country === "string" ? req.query.country : "all";
    const sort = req.query.sort === "asc" ? "asc" : "desc";
    const metric = req.query.metric === "mean" ? "mean" : "median";

    const { all } = await getCachedData(req);
    const items = await buildCityRankings(all.stations, { country, sort, metric });

    applyJsonCacheHeaders(res);
    res.json({
      updatedAt: all.updateAt,
      filter: { country, sort, metric },
      count: items.length,
      items,
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to build city rankings",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get('/stations/:stationID/daily', async (req: Request, res: Response) => {
  try {
    const rawID = (Array.isArray(req.params.stationID) ? req.params.stationID[0] : req.params.stationID) ?? '';
    const stationID = decodeURIComponent(rawID);
    const yearParam = typeof req.query.year === 'string' ? parseInt(req.query.year, 10) : new Date().getFullYear();
    const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();

    const days = await getDailyForYear(stationID, year);

    applyJsonCacheHeaders(res);
    res.json({ stationID, year, days });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch daily AQI data',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export function startBackgroundPoller(): void {
  const poll = async () => {
    try {
      const { warnings, countBySource, stations, detailsByStationID } = await fetchAllStations();
      const markerKeys = buildMarkerKeys(stations);

      // Populate the cache directly so the next client request is served immediately
      // without triggering another fetchAllStations(). sprite.baseUrl is a placeholder —
      // getCachedData() always overwrites it with the real host from the incoming request.
      const result: AllResponse = {
        updateAt: new Date().toISOString(),
        count: stations.length,
        countBySource,
        markerKeyCount: markerKeys.length,
        markerKeys,
        sprite: { baseUrl: '' },
        stations,
        ...(warnings.length > 0 && { warnings }),
      };

      warmCache(result, detailsByStationID);
      console.log(`[background poller] cache warmed — ${stations.length} stations at ${new Date().toLocaleString()}`);
    } catch (err) {
      console.error(`[background poller] fetchAllStations failed at ${new Date().toLocaleString()}:`, err);
    }
  };

  // Fire at minute 2 of every hour (02:00, 03:00, ...) so the public APIs have a
  // 2-minute head start to publish their new hourly readings before we fetch them.
  // This is more reliable than setInterval because it always fires at a fixed clock
  // time regardless of when the server started.
  cron.schedule('2 * * * *', poll);

  // Also run immediately on startup to warm the history cache
  poll();
}

export default router;
