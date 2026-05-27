import { SignJWT, jwtVerify } from "jose";

// Same fail-fast pattern as apiKey.ts: misconfigured auth secrets must crash
// at boot, never silently degrade to no-auth.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error("FATAL: JWT_SECRET environment variable is not set");
    process.exit(1);
}

const secret = new TextEncoder().encode(JWT_SECRET);

// iss/aud claims aren't strictly necessary for a single-service app, but
// they're cheap insurance against accidentally accepting a token from another
// system that happens to share the same JWT_SECRET (or one rotated badly).
const ISSUER = "neefoon-backend";
const AUDIENCE = "neefoon-app";

/**
 * Mints a short-lived JWT carrying the attestation-derived install identity.
 *
 * HS256 (symmetric) instead of RS256 because signing and verification both
 * happen in this same backend process. Asymmetric keys only pay off when a
 * separate service verifies tokens without trusting the signer.
 */
export async function issueAppToken(opts: {
    installId: string;
    ttlSec: number;
}): Promise<{ token: string; exp: number }> {
    const exp = Math.floor(Date.now() / 1000) + opts.ttlSec;
    const token = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(opts.installId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(secret);
    return { token, exp };
}

/**
 * Verifies a token signed by issueAppToken. Throws on any failure mode:
 * bad signature, expired, wrong issuer/audience, missing sub. Callers should
 * treat any throw uniformly as "client must re-attest".
 */
export async function verifyAppToken(
    token: string,
): Promise<{ installId: string }> {
    const { payload } = await jwtVerify(token, secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("Token missing sub claim");
    }
    return { installId: payload.sub };
}
