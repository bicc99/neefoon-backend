/**
 * Google Play Integrity verifier.
 *
 * Why server-side decode (this) vs local decryption?
 *   - Local: decrypts the JWE locally with keys from Play Console. Faster
 *     (no Google round-trip per attestation) but you manage and rotate two
 *     keys yourself.
 *   - Server: POST the token to Google's decode endpoint and they return the
 *     verdict. Adds ~100-200ms per attestation but Google handles key
 *     rotation. Sensible default until volume justifies optimizing it away.
 *
 * Install: npm install googleapis google-auth-library
 * Setup:
 *   1. In Google Cloud Console for the project linked to your Play Console,
 *      enable the Play Integrity API.
 *   2. Create a service account, grant it the "Play Integrity API" role.
 *   3. Download its JSON key.
 *   4. Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json (the standard
 *      env var google-auth-library reads automatically).
 * Spec: https://developer.android.com/google/play/integrity/verdicts
 */

import { google } from "googleapis";

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME;
if (!PACKAGE_NAME) {
    console.error("FATAL: ANDROID_PACKAGE_NAME environment variable is not set");
    process.exit(1);
}

const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/playintegrity"],
});

const playintegrity = google.playintegrity({ version: "v1", auth });

/**
 * Verifies a Play Integrity token by asking Google to decode it, then checks
 * each verdict field against our policy.
 *
 * Throws on any verification failure. The route handler logs the message for
 * ops visibility and returns a generic 401 so failure modes look identical
 * from outside.
 */
export async function verifyPlayIntegrity(input: {
    token: string;
    expectedNonce: string;
}): Promise<void> {
    const response = await playintegrity.v1.decodeIntegrityToken({
        packageName: PACKAGE_NAME!,
        requestBody: { integrityToken: input.token },
    });

    const payload = response.data.tokenPayloadExternal;
    if (!payload) {
        throw new Error("Play Integrity returned no payload");
    }

    // The nonce binds this attestation to our specific challenge. Without
    // this check, an attestation captured from another install or another
    // moment could be replayed against us.
    if (payload.requestDetails?.nonce !== input.expectedNonce) {
        throw new Error("Nonce mismatch");
    }
    if (payload.requestDetails?.requestPackageName !== PACKAGE_NAME) {
        throw new Error("Package name mismatch");
    }

    // appRecognitionVerdict says whether this is a genuine, unmodified build
    // distributed via Play.
    //   PLAY_RECOGNIZED       — installed/updated through Play, unmodified
    //   UNRECOGNIZED_VERSION  — sideloaded or modified build
    //   UNEVALUATED           — couldn't evaluate (rare; treat as failure)
    //
    // We accept UNRECOGNIZED_VERSION outside production so dev builds running
    // directly from Android Studio pass. NODE_ENV is asserted by deploy.
    const appVerdict = payload.appIntegrity?.appRecognitionVerdict;
    const appOk =
        appVerdict === "PLAY_RECOGNIZED" ||
        (process.env.NODE_ENV !== "production" && appVerdict === "UNRECOGNIZED_VERSION");
    if (!appOk) {
        throw new Error(`App recognition verdict not acceptable: ${appVerdict}`);
    }

    // deviceRecognitionVerdict is a list of integrity levels the device meets:
    //   MEETS_DEVICE_INTEGRITY  — genuine device, unrooted, Play Protect on
    //   MEETS_BASIC_INTEGRITY   — weaker; root with Magisk Hide can pass
    //   MEETS_STRONG_INTEGRITY  — hardware-backed key attestation
    //
    // For an AQI app maximum strictness isn't required, but rejecting devices
    // that fail basic integrity blocks emulators and obviously-tampered devices.
    // Tighten to MEETS_DEVICE_INTEGRITY only if abuse appears.
    const deviceVerdicts =
        payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const deviceOk =
        deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY") ||
        deviceVerdicts.includes("MEETS_BASIC_INTEGRITY") ||
        deviceVerdicts.includes("MEETS_STRONG_INTEGRITY");
    if (!deviceOk) {
        throw new Error(
            `Device integrity not acceptable: ${deviceVerdicts.join(",") || "none"}`,
        );
    }
}
