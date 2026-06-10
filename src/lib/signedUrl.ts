/**
 * HMAC-signed URL helpers.
 *
 * Used for resources that must be fetched by clients which cannot set request
 * headers — specifically MapLibre's ImageSource fetching the FIRMS fires PNG.
 * The client mints a path-bound, time-limited signature via the normal
 * authenticated `/sign` endpoint, then assembles a URL the native fetcher can
 * hit without an Authorization header.
 *
 * Threat model:
 *   - Reusing a sig on a different path fails (signature input includes path).
 *   - Using a sig past `exp` fails (verifier rejects expired URLs).
 *   - Forging a sig requires the server-side URL_SIGNING_SECRET.
 *
 * SHA-256 HMAC: fast, well-supported, resistant to length extension. Hex
 * output so the value travels safely in URL query strings.
 */

import type { Request } from "express";
import crypto from "crypto";

const URL_SIGNING_SECRET = process.env.URL_SIGNING_SECRET;

if (!URL_SIGNING_SECRET) {
    console.error("FATAL: URL_SIGNING_SECRET environment variable is not set");
    process.exit(1);
}

function computeSignature(path: string, exp: number): string {
    return crypto
        .createHmac("sha256", URL_SIGNING_SECRET!)
        .update(`${path}|${exp}`)
        .digest("hex");
}

/**
 * Mints a signed URL fragment for the given absolute path, valid for
 * `expirySeconds` from now. Returns just the `exp` and `sig` values so the
 * caller can decide what base URL to attach.
 *
 * `path` must be the absolute path the client will request (e.g.
 * "/firms/fires"), since the verifier reconstructs the same absolute path
 * from the incoming request.
 */
export function signUrl(
    path: string,
    expirySeconds: number,
): { exp: number; sig: string } {
    const exp = Math.floor(Date.now() / 1000) + expirySeconds;
    const sig = computeSignature(path, exp);
    return { exp, sig };
}

/**
 * Verifies a request's `exp`/`sig` query params against an explicit signed path.
 * Returns true only if all of:
 *   - `exp` and `sig` query params are present and well-formed
 *   - `exp` has not passed
 *   - `sig` matches the HMAC of `signedPath` + exp
 *
 * Callers pass the path the signer used. Use this directly when one signature
 * must cover many request paths (e.g. tile URLs /firms/tiles/:z/:x/:y.png all
 * signed against the fixed prefix "/firms/tiles"): the signature authorizes the
 * prefix, and the per-tile coordinates are validated by the route handler, not
 * by the signature. For the common one-path-one-signature case use
 * verifySignedUrl, which derives the path from the request.
 */
export function verifySignedUrlForPath(req: Request, signedPath: string): boolean {
    const expRaw = req.query.exp;
    const sigRaw = req.query.sig;
    if (typeof expRaw !== "string" || typeof sigRaw !== "string") return false;

    const exp = Number(expRaw);
    if (!Number.isFinite(exp)) return false;

    // Expiry is server-time so the client's clock cannot affect it.
    if (Math.floor(Date.now() / 1000) > exp) return false;

    const expected = computeSignature(signedPath, exp);

    // timingSafeEqual throws on mismatched lengths, so length-check first.
    if (sigRaw.length !== expected.length) return false;

    return crypto.timingSafeEqual(
        Buffer.from(sigRaw, "hex"),
        Buffer.from(expected, "hex"),
    );
}

/**
 * Verifies a signed URL bound to the request's own absolute path. Returns true
 * only if the `exp`/`sig` query params match the HMAC of that path + exp.
 */
export function verifySignedUrl(req: Request): boolean {
    // Reconstruct the absolute path the signer used. When this verifier runs
    // inside middleware mounted at a prefix (e.g. app.use('/firms', ...)),
    // Express strips that prefix from req.path, but the signer uses the
    // absolute path the client sees. Combining baseUrl + path makes the HMAC
    // inputs match regardless of where the middleware is mounted.
    return verifySignedUrlForPath(req, req.baseUrl + req.path);
}
