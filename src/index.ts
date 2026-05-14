import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

import air4thaiRouter from './routes/air4thai.js';
import firmsRouter from './routes/firms.js';
import cuSense from './routes/cuSense.js';
import airGradient from './routes/airGradient.js';
import aqi, { startBackgroundPoller } from './routes/aqi.js';
import { dbReady, closePool } from './db/database.js';
import { requireApiKey } from './lib/apiKey.js';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

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

