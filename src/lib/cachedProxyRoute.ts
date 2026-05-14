import { Router } from "express";
import type { Request, Response } from "express";
import { applyJsonCacheHeaders, CACHE_TTL_MS } from "./httpCache.js";

type CachedProxyOptions = {
  url: string;
  fetchInit?: RequestInit;
  errorLabel: string;
};

export function createCachedProxyRoute(options: CachedProxyOptions): Router {
  const { url, fetchInit, errorLabel } = options;
  const router = Router();

  let cache: { data: unknown; timestamp: number } | null = null;

  router.get("/stations", async (_req: Request, res: Response) => {
    try {
      const now = Date.now();

      if (cache && now - cache.timestamp < CACHE_TTL_MS) {
        applyJsonCacheHeaders(res);
        res.json(cache.data);
        return;
      }

      const response = await fetch(url, fetchInit);

      if (!response.ok) {
        res.status(502).json({ error: `${errorLabel} request failed`, status: response.status });
        return;
      }

      const data = await response.json();
      cache = { data, timestamp: now };

      applyJsonCacheHeaders(res);
      res.json(data);
    } catch (error) {
      res.status(500).json({
        error: `Failed to fetch ${errorLabel} data`,
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return router;
}
