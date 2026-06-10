/**
 * Attestation-based auth middleware.
 *
 * Accepts either of two credentials:
 *
 *   1. Authorization: Bearer <JWT>
 *      The normal path. The JWT is issued by POST /auth/token after platform
 *      attestation. Verified here, with req.installId set for downstream
 *      handlers.
 *
 *   2. ?exp=<unix-seconds>&sig=<hex-hmac>
 *      Used when the client cannot set headers. Specifically: MapLibre's
 *      ImageSource fetches the FIRMS PNG internally with no opportunity to
 *      attach an Authorization header. The signature is bound to the exact
 *      request path and expires in minutes, and the signed URL itself is only
 *      ever minted by an authenticated /sign endpoint — so this does not widen
 *      access beyond attested installs.
 *
 * Returns 401 on any failure (missing header, malformed/expired/forged token,
 * wrong issuer, missing sub, invalid signature). On 401 the client should
 * re-run /auth/challenge + /auth/token for a fresh token, then retry. See
 * src/routes/auth.ts for the full flow.
 */

import type { Request, Response, NextFunction } from "express";
import { verifyAppToken } from "./jwt.js";
import { verifySignedUrl, verifySignedUrlForPath } from "./signedUrl.js";

// Tile requests (/firms/tiles/:z/:x/:y.png) are header-less MapLibre raster
// fetches that all share ONE signature, minted against this fixed prefix. The
// signature authorizes "may request FIRMS tiles"; the specific z/x/y and layer
// are validated by the route handler, so a leaked sig can't be turned into an
// arbitrary upstream WMS request.
const TILE_SIGNED_PREFIX = "/firms/tiles";

// Augment Express's Request type so handlers can read req.installId without
// casting. Declared in the file that owns the middleware so the augmentation
// lives next to the code that sets the property.
declare module "express-serve-static-core" {
    interface Request {
        installId?: string;
    }
}

export async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    // Header-less clients (MapLibre fetching FIRMS imagery) authenticate via a
    // signed URL instead of a Bearer token. Checked first because these requests
    // carry no Authorization header at all.
    //
    // Two shapes:
    //   - The legacy single PNG (/firms/fires): signature bound to its exact path.
    //   - Raster tiles (/firms/tiles/:z/:x/:y.png): one signature covers every
    //     tile, verified against the fixed prefix; coordinates/layer are validated
    //     in the route handler.
    const absolutePath = req.baseUrl + req.path;
    const isTileRequest = absolutePath.startsWith(`${TILE_SIGNED_PREFIX}/`);
    const signedOk = isTileRequest
        ? verifySignedUrlForPath(req, TILE_SIGNED_PREFIX)
        : verifySignedUrl(req);
    if (signedOk) {
        next();
        return;
    }

    const header = req.headers["authorization"];
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }

    try {
        const { installId } = await verifyAppToken(token);
        req.installId = installId;
        next();
    } catch {
        // All failure modes (bad signature, expired, wrong issuer, missing
        // sub) return the same response so a malicious caller can't
        // distinguish them.
        res.status(401).json({ error: "Unauthorized" });
    }
}
