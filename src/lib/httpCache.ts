import type { Response } from "express";

export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const BROWSER_CACHE_SEC = 300;        // 5 mins
export const CDN_CACHE_SEC = 3600;           // 1 hour

export function applyJsonCacheHeaders(res: Response): void {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Cache-Control", `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${CDN_CACHE_SEC}`);
}

export function applyBinaryCacheHeaders(res: Response, contentType: string): void {
  res.set("Content-Type", contentType);
  res.set("Cache-Control", `public, max-age=${BROWSER_CACHE_SEC}, s-maxage=${CDN_CACHE_SEC}`);
}
