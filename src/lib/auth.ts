/**
 * Attestation-based auth middleware.
 *
 * Verifies the Bearer JWT issued by POST /auth/token, sets req.installId for
 * downstream handlers, returns 401 on any failure (missing header, malformed
 * token, bad signature, expired, wrong issuer, missing sub).
 *
 * On 401 the client should re-run /auth/challenge + /auth/token to obtain a
 * fresh token, then retry the original request. See src/routes/auth.ts for
 * the full flow.
 *
 * Not yet mounted on protected routes in src/index.ts — requireApiKey still
 * gates JSON endpoints until the client side cuts over. This middleware is
 * ready for the swap whenever that happens.
 */

import type { Request, Response, NextFunction } from "express";
import { verifyAppToken } from "./jwt.js";

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
