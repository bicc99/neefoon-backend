import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

import air4thaiRouter from './routes/air4thai.js';
import firmsRouter from './routes/firms.js';
import cuSense from './routes/cuSense.js';
import airGradient from './routes/airGradient.js';
import aqi, { startBackgroundPoller } from './routes/aqi.js';
import stripeRouter from './routes/stripe.js';
import { dbReady, closePool } from './db/database.js';
import { requireApiKey } from './lib/apiKey.js';
import { globalLimiter, apiLimiter } from './lib/rateLimiter.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

// Railway (and most reverse proxies) forward the real client IP in
// X-Forwarded-For. Without this, req.ip is always the proxy's IP and every
// user shares one rate-limit bucket.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(globalLimiter);

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// Stripe route is public — the website frontend has no API key.
// Must be registered before requireApiKey.
app.use('/api/stripe', stripeRouter);

// apiLimiter runs before requireApiKey so failed auth attempts also consume
// the per-minute budget, preventing API key brute-forcing.
app.use('/api', apiLimiter);
app.use(requireApiKey);

app.use('/api/aqi/air4thai', air4thaiRouter);
app.use('/api/aqi/cu-sense', cuSense);
app.use('/api/aqi/airgradient', airGradient);
app.use('/api/aqi', aqi);
app.use('/api/firms', firmsRouter);

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

