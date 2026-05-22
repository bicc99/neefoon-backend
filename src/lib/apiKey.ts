import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const API_KEY = process.env.API_KEY;
const URL_SIGNING_SECRET = process.env.URL_SIGNING_SECRET;

if (!API_KEY) {
    console.error('FATAL: API_KEY environment variable is not set');
    process.exit(1);
}

if (!URL_SIGNING_SECRET) {
    console.error('FATAL: URL_SIGNING_SECRET environment variable is not set');
    process.exit(1);
}

// Use timing-safe comparison to prevent timing attacks
const isValidKey = (provided: string): boolean =>
    provided.length === API_KEY.length &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(API_KEY));

/**
 * Computes the HMAC signature for a signed URL.
 *
 * The signature binds the URL to a specific path and expiry, so:
 *   - Reusing the sig on a different path fails (HMAC input includes path).
 *   - Using the sig past the expiry fails (verifier rejects expired URLs).
 *   - Forging a sig requires the server-side URL_SIGNING_SECRET.
 *
 * Using SHA-256 because it is fast, well-supported, and resistant to length-extension
 * attacks when used as HMAC. The output is hex-encoded so it travels safely in URLs.
 */
function computeSignature(path: string, exp: number): string {
    return crypto
        .createHmac('sha256', URL_SIGNING_SECRET!)
        .update(`${path}|${exp}`)
        .digest('hex');
}

/**
 * Mints a signed URL fragment for the given path, valid for `expirySeconds` from now.
 * Returns just the query-param fragment so the caller can decide what base URL to attach.
 *
 * Use this for resources that need to be fetched by clients which cannot set request
 * headers — e.g. MapLibre's ImageSource fetching a backend-served PNG.
 */
export function signUrl(path: string, expirySeconds: number): { exp: number; sig: string } {
    const exp = Math.floor(Date.now() / 1000) + expirySeconds;
    const sig = computeSignature(path, exp);
    return { exp, sig };
}

/**
 * Verifies a signed URL on an incoming request. Returns true only if all of:
 *   - `exp` and `sig` query params are present and well-formed
 *   - `exp` has not passed
 *   - `sig` matches the HMAC of the current request path + exp
 */
function verifySignedUrl(req: Request): boolean {
    const expRaw = req.query.exp;
    const sigRaw = req.query.sig;
    if (typeof expRaw !== 'string' || typeof sigRaw !== 'string') return false;

    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return false;

    // Expiry is server-time so the client's clock cannot affect it.
    if (Math.floor(Date.now() / 1000) > exp) return false;

    const expected = computeSignature(req.path, exp);

    // timingSafeEqual throws on mismatched lengths, so length-check first.
    if (sigRaw.length !== expected.length) return false;

    return crypto.timingSafeEqual(
        Buffer.from(sigRaw, 'hex'),
        Buffer.from(expected, 'hex'),
    );
}

/**
 * Auth middleware accepting either of two credentials:
 *
 *   1. Authorization: Bearer <API_KEY>
 *      The normal path for JSON API calls. The mobile app's fetch() can set headers.
 *
 *   2. ?exp=<unix-seconds>&sig=<hex-hmac>
 *      Used when the client cannot set headers. Specifically: MapLibre's ImageSource
 *      fetches PNGs internally with no opportunity to attach an Authorization header.
 *      The signature is bound to the exact request path, so a leaked signed URL only
 *      grants access to that one resource until its expiry passes.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (token && isValidKey(token)) {
        next();
        return;
    }

    if (verifySignedUrl(req)) {
        next();
        return;
    }

    res.status(401).json({ error: 'Unauthorized' });
}
