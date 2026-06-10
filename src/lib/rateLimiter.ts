import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * FIRMS tile PNGs are exempt from the shared limiters and use firmsTileLimiter.
 * One viewport fetches 16-36 tiles at once, far chattier than the AQI polling the
 * shared buckets are sized for. Safe to allow: read-only, signed-URL gated, and
 * served from the per-tile cache. Excludes /firms/tiles/sign (one call/refresh).
 */
const isFirmsTile = (req: Request): boolean =>
    req.path.startsWith('/firms/tiles/') && req.path.endsWith('.png');

/**
 * Broad cap applied before all other middleware.
 *
 * Why 200/15min: the app polls AQI data every ~5 minutes per user. At 10 users
 * behind one NAT IP (office, coffee shop) that's ~20 req/min — well within the
 * 13/min average this window allows, while blocking runaway scrapers.
 *
 * Swap the default MemoryStore for `rate-limit-redis` when scaling to multiple
 * server instances — the window/limit numbers stay the same.
 */
export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15-minute sliding window
    limit: 200,                  // max requests per window per IP
    standardHeaders: 'draft-7', // emit RateLimit-* headers per RFC 9110 draft
    legacyHeaders: false,        // suppress deprecated X-RateLimit-* headers
    skip: isFirmsTile,           // tiles use firmsTileLimiter instead
    message: { error: 'Too many requests. Please try again later.' },
});

/**
 * Tighter cap on all /api/* routes.
 *
 * Why 60/min: catches burst scraping that stays within the 15-min window.
 * 60/min (1/sec sustained) is enough for any normal app session — a screen
 * change triggers at most 3-4 requests simultaneously.
 *
 * This also rate-limits failed auth attempts, since it runs before requireApiKey.
 */
export const apiLimiter = rateLimit({
    windowMs: 60 * 1000,        // 1-minute window
    limit: 60,                   // max requests per minute per IP
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: isFirmsTile,           // tiles use firmsTileLimiter instead
    message: { error: 'Too many requests. Please slow down.' },
});

/**
 * Loose per-IP cap for FIRMS tile PNGs only (mounted on the tile route itself).
 *
 * Why 600/min: a heavy session panning/zooming the fire layer can pull a few
 * hundred tiles a minute, so the budget has to clear that with headroom while
 * still stopping a scraper enumerating the global tile pyramid (thousands/sec).
 */
export const firmsTileLimiter = rateLimit({
    windowMs: 60 * 1000,        // 1-minute window
    limit: 600,                  // max tile requests per minute per IP
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many tile requests. Please slow down.' },
});
