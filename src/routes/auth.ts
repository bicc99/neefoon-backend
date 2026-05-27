/**
 * Attestation-based authentication endpoints.
 *
 * Flow:
 *   1. Client calls POST /auth/challenge to get a single-use server nonce.
 *   2. Client runs platform attestation (App Attest on iOS, Play Integrity on
 *      Android), embedding the nonce in the cryptographic output.
 *   3. Client calls POST /auth/token with the attestation result plus the
 *      nonce.
 *   4. Backend verifies the attestation, atomically consumes the nonce, and
 *      returns a short-lived JWT the client uses as the Bearer token for all
 *      other authenticated endpoints.
 *
 * On 401 from any protected endpoint, the client should re-run steps 1-3 to
 * get a fresh token. The middleware that enforces this lives in src/lib/auth.ts
 * (not part of this file — wire it into src/index.ts when ready to cut over).
 */

import type { Request, Response } from "express";
import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { pool } from "../db/database.js";
import {
    verifyAppleAttestation,
    verifyAppleAssertion,
} from "../lib/attestation/apple.js";
import { verifyPlayIntegrity } from "../lib/attestation/google.js";
import { issueAppToken } from "../lib/jwt.js";

const router = Router();

// Long enough for a slow network plus a slow cold-start attestation on a
// budget device, short enough that a leaked nonce is useless within a minute.
const CHALLENGE_TTL_SEC = 60;

// 1 hour balances client UX (re-attestation rare) with leak window (stolen
// token expires within an hour). Tune based on observed re-attestation cost.
const TOKEN_TTL_SEC = 60 * 60;

/**
 * Issues a single-use server nonce for attestation.
 *
 * Both App Attest and Play Integrity bind a server-supplied nonce into their
 * cryptographic output, so an attestation captured from another install or
 * another moment cannot be replayed against us.
 */
router.post("/challenge", async (_req: Request, res: Response) => {
    const nonce = crypto.randomBytes(32).toString("base64url");
    const exp = new Date(Date.now() + CHALLENGE_TTL_SEC * 1000);

    await pool.query(
        "INSERT INTO auth_challenges (nonce, exp) VALUES ($1, $2)",
        [nonce, exp],
    );

    res.json({ nonce, exp: Math.floor(exp.getTime() / 1000) });
});

// Discriminated union by `kind` so each platform/phase has its own type-safe
// shape. zod's discriminated union narrows the type in each branch below,
// which avoids casting and makes invalid combinations a compile error.
const TokenBody = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("ios_attest"),
        nonce: z.string(),
        keyId: z.string(),
        attestation: z.string(),
    }),
    z.object({
        kind: z.literal("ios_assert"),
        nonce: z.string(),
        keyId: z.string(),
        assertion: z.string(),
    }),
    z.object({
        kind: z.literal("android"),
        nonce: z.string(),
        integrityToken: z.string(),
    }),
]);

router.post("/token", async (req: Request, res: Response) => {
    const parsed = TokenBody.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
    }
    const body = parsed.data;

    // Atomically consume the nonce. The UPDATE...RETURNING pattern means two
    // parallel /auth/token calls with the same nonce can never both succeed:
    // exactly one sees rowCount === 1, the other gets 0 and 401. This is the
    // single-use guarantee — without it, a captured nonce could be reused.
    const consumed = await pool.query(
        `UPDATE auth_challenges
            SET consumed_at = NOW()
          WHERE nonce = $1
            AND consumed_at IS NULL
            AND exp > NOW()
      RETURNING nonce`,
        [body.nonce],
    );
    if (consumed.rowCount === 0) {
        res.status(401).json({ error: "Invalid or expired nonce" });
        return;
    }

    try {
        let installId: string;

        if (body.kind === "ios_attest") {
            // First-time registration of a fresh Secure Enclave key.
            const { publicKey } = await verifyAppleAttestation({
                keyId: body.keyId,
                attestation: body.attestation,
                challenge: body.nonce,
            });
            // ON CONFLICT DO NOTHING handles the race where two parallel
            // attestations from the same install both arrive — the second
            // simply no-ops, and we keep the first stored key/counter.
            await pool.query(
                `INSERT INTO attest_keys (key_id, public_key)
                 VALUES ($1, $2)
                 ON CONFLICT (key_id) DO NOTHING`,
                [body.keyId, publicKey],
            );
            installId = `ios:${body.keyId}`;
        } else if (body.kind === "ios_assert") {
            const row = await pool.query<{
                public_key: Buffer;
                sign_counter: string;
            }>(
                "SELECT public_key, sign_counter FROM attest_keys WHERE key_id = $1",
                [body.keyId],
            );
            const key = row.rows[0];
            if (!key) {
                // Key never registered. Return 409 (not 401) to tell the
                // client this is a "wrong auth method, switch flows" failure
                // rather than a "credentials bad, retry" failure. The client
                // should fall back to ios_attest.
                res.status(409).json({
                    error: "Unknown keyId",
                    action: "reattest",
                });
                return;
            }
            const { newCounter } = await verifyAppleAssertion({
                publicKey: key.public_key,
                previousCounter: BigInt(key.sign_counter),
                assertion: body.assertion,
                challenge: body.nonce,
            });
            await pool.query(
                "UPDATE attest_keys SET sign_counter = $1, last_used_at = NOW() WHERE key_id = $2",
                [newCounter.toString(), body.keyId],
            );
            installId = `ios:${body.keyId}`;
        } else {
            // Play Integrity is one-shot — no separate register/verify phases.
            // Google intentionally doesn't expose a stable device identifier
            // (privacy), so we mint a fresh installId per attestation. If you
            // later need stable Android install IDs (per-device rate limits,
            // analytics), have the client generate a UUID at install time and
            // include its hash in the request nonce, then trust the attested
            // value here.
            await verifyPlayIntegrity({
                token: body.integrityToken,
                expectedNonce: body.nonce,
            });
            installId = `android:${crypto.randomUUID()}`;
        }

        const { token, exp } = await issueAppToken({
            installId,
            ttlSec: TOKEN_TTL_SEC,
        });
        res.json({ token, exp });
    } catch (err) {
        // Log real reason for ops debugging but return a generic 401 so a
        // malicious caller can't distinguish failure modes (nonce reuse vs
        // bad signature vs failed verdict) — all rejections look identical.
        req.log.warn({ err }, "Attestation verification failed");
        res.status(401).json({ error: "Attestation rejected" });
    }
});

export default router;
