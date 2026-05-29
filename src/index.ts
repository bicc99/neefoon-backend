// Imported before anything that loads jose so the Web Crypto global jose needs
// is present even on runtimes that don't expose it by default. See the module
// for the full rationale (it's why /auth/token was returning spurious 401s).
import './lib/cryptoPolyfill.js';

// Imported first so PLAY_INTEGRITY_KEY_B64 (Railway-style base64 secret) is
// decoded to a file and GOOGLE_APPLICATION_CREDENTIALS is set before any
// module that touches google-auth-library loads. No-op if the env var is
// unset (local dev can point GOOGLE_APPLICATION_CREDENTIALS at a real file).
import './lib/bootSecrets.js';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

// Origin allowed to make browser cross-origin calls. The mobile app does not
// send an Origin header (native fetch is not subject to CORS), so locking this
// down only restricts browsers. Fail fast if unset so CORS never silently
// defaults to "allow any origin".
const FRONTEND_URL = process.env.FRONTEND_URL;
if (!FRONTEND_URL) {
    console.error('FATAL: FRONTEND_URL environment variable is not set');
    process.exit(1);
}

import firmsRouter from './routes/firms.js';
import aqi, { startBackgroundPoller } from './routes/allAqi.js';
import stripeRouter from './routes/stripe.js';
import authRouter from './routes/auth.js';
import { dbReady, closePool } from './db/database.js';
import { requireAuth } from './lib/auth.js';
import { globalLimiter, apiLimiter } from './lib/rateLimiter.js';
import { httpLogger } from './lib/logger.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

// Railway (and most reverse proxies) forward the real client IP in
// X-Forwarded-For. Without this, req.ip is always the proxy's IP and every
// user shares one rate-limit bucket.
app.set('trust proxy', 1);

// httpLogger mounts first so every request (including those rejected by
// cors, rate limit, or auth) is logged with its final status code.
app.use(httpLogger);

// helmet sets baseline security headers (HSTS, X-Content-Type-Options nosniff,
// X-Frame-Options, etc.). Defaults are safe for a JSON API. Apply before any
// route so every response carries these headers.
app.use(helmet());
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());
app.use(globalLimiter);

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// Stripe route is public — the website frontend has no API key.
// Must be registered before requireApiKey.
app.use('/stripe', stripeRouter);

// apiLimiter runs before any auth so failed attempts on any route also
// consume the per-minute budget, preventing key brute-forcing.
app.use(apiLimiter);

// Attestation endpoints are public: they ARE the auth mechanism, so they
// must be reachable without an existing token. Mounted after apiLimiter so
// /auth/challenge cannot be hammered to enumerate nonces.
app.use('/auth', authRouter);

// All client-facing data routes require an attestation-derived JWT. The /firms
// router additionally accepts a signed URL on /firms/fires (see requireAuth)
// for MapLibre's header-less ImageSource fetch.
app.use('/aqi', requireAuth, aqi);
app.use('/firms', requireAuth, firmsRouter);

await dbReady;

const server = app.listen(port, process.env.HOST ?? '0.0.0.0', () => {
    console.log(`Server is running on port ${port}`);
    startBackgroundPoller();
});

const shutdown = async () => {
    server.close();
    await closePool();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

