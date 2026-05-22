import rateLimit from 'express-rate-limit';

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
    message: { error: 'Too many requests. Please slow down.' },
});
