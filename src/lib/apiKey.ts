import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
    console.error('FATAL: API_KEY environment variable is not set');
    process.exit(1);
}

// Use timing-safe comparison to prevent timing attacks
const isValidKey = (provided: string): boolean =>
    provided.length === API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY));

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;

    if (!token || !isValidKey(token)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    next();
}
