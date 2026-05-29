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
import { verifySignedUrl } from "./signedUrl.js";

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
    // Header-less clients (MapLibre's ImageSource fetching the FIRMS PNG)
    // authenticate via a signed URL instead of a Bearer token. Checked first
    // because these requests carry no Authorization header at all.
    if (verifySignedUrl(req)) {
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
