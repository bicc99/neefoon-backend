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

import air4thaiRouter from './routes/air4thai.js';
import firmsRouter from './routes/firms.js';
import cuSense from './routes/cuSense.js';
import airGradient from './routes/airGradient.js';
import aqi, { startBackgroundPoller } from './routes/aqi.js';
import stripeRouter from './routes/stripe.js';
import authRouter from './routes/auth.js';
import { dbReady, closePool } from './db/database.js';
import { requireApiKey } from './lib/apiKey.js';
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

// apiLimiter runs before requireApiKey so failed auth attempts also consume
// the per-minute budget, preventing API key brute-forcing.
app.use(apiLimiter);

// Attestation endpoints are public — they ARE the auth mechanism, so they
// must be reachable without an existing token. Mounted after apiLimiter so
// /auth/challenge can't be hammered to enumerate nonces, but before
// requireApiKey so they don't require the static Bearer key.
app.use('/auth', authRouter);

app.use(requireApiKey);

app.use('/aqi/air4thai', air4thaiRouter);
app.use('/aqi/cu-sense', cuSense);
app.use('/aqi/airgradient', airGradient);
app.use('/aqi', aqi);
app.use('/firms', firmsRouter);

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

