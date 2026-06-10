/**
 * Apple App Attest verifier.
 *
 * Why a library instead of rolling this manually?
 *   App Attest verification requires CBOR decoding of the attestation object,
 *   x509 chain validation against Apple's root CA, parsing a binary
 *   authenticator data format, computing a specific nonce hash, signature
 *   verification, and an app ID hash check. That's ~200 lines of error-prone
 *   crypto code we don't want to own. `node-app-attest` is a focused library
 *   that handles the spec correctly. Pin the version in package.json so the
 *   surface stays stable.
 *
 * Install: npm install node-app-attest
 * Docs:    https://www.npmjs.com/package/node-app-attest
 * Spec:    https://developer.apple.com/documentation/devicecheck/establishing_your_app_s_integrity
 */

import {
    verifyAssertion,
    verifyAttestation,
} from "node-app-attest";

const BUNDLE_ID = process.env.IOS_BUNDLE_IDENTIFIER;
const TEAM_ID = process.env.IOS_TEAM_IDENTIFIER;

if (!BUNDLE_ID) {
    console.error("FATAL: IOS_BUNDLE_IDENTIFIER environment variable is not set");
    process.exit(1);
}
if (!TEAM_ID) {
    console.error("FATAL: IOS_TEAM_IDENTIFIER environment variable is not set");
    process.exit(1);
}

// App Attest's environment follows the build's code signature, not the
// distribution channel: only Xcode-run, development-signed builds attest
// against Apple's sandbox (development) environment. TestFlight and App Store
// builds are distribution-signed and both attest against the production
// environment. Allow dev attestations when either NODE_ENV is non-production OR
// the explicit ALLOW_DEV_ATTEST flag is set. The flag exists so we can test
// sandbox attestations against the live Railway backend before launch, without
// running a separate staging deploy.
//
// SECURITY: never leave ALLOW_DEV_ATTEST set in production. Sandbox
// attestations can be minted freely by anyone on their own device, so accepting
// them in production would defeat the attestation gate. Production traffic
// (including TestFlight) presents production attestations, so the flag is only
// ever needed for local dev builds hitting the live backend.
const ALLOW_DEV_ENV =
    process.env.NODE_ENV !== "production" ||
    process.env.ALLOW_DEV_ATTEST === "true";


/**
 * Verifies a fresh App Attest attestation and returns the public key for storage.
 *
 * Called once per install on first authentication. The returned public key is
 * persisted in attest_keys and used to verify every subsequent assertion from
 * that install.
 */
export async function verifyAppleAttestation(input: {
    keyId: string; // base64-encoded keyId from attestKey()
    attestation: string; // base64-encoded attestation object
    challenge: string; // the nonce we issued via /auth/challenge
}): Promise<{ publicKey: Buffer }> {
    const result = await verifyAttestation({
        attestation: Buffer.from(input.attestation, "base64"),
        challenge: input.challenge,
        keyId: input.keyId,
        bundleIdentifier: BUNDLE_ID!,
        teamIdentifier: TEAM_ID!,
        allowDevelopmentEnvironment: ALLOW_DEV_ENV,
    });

    // The library returns the public key as a PEM string or Buffer depending on
    // version; normalize to Buffer for BYTEA storage. If your version returns a
    // Buffer already this is a no-op.
    const publicKey = Buffer.isBuffer(result.publicKey)
        ? result.publicKey
        : Buffer.from(result.publicKey);

    return { publicKey };
}

/**
 * Verifies an ongoing assertion against a previously stored public key.
 *
 * Apple's sign counter is built-in replay protection: each assertion carries a
 * monotonically increasing counter, and the library rejects any assertion whose
 * counter is not strictly greater than the previousCounter we pass in. The
 * caller must persist the returned newCounter so the next call sees it.
 */
export async function verifyAppleAssertion(input: {
    publicKey: Buffer; // from attest_keys
    previousCounter: bigint; // last sign_counter we stored
    assertion: string; // base64-encoded assertion bytes
    challenge: string; // the nonce we issued via /auth/challenge
}): Promise<{ newCounter: bigint }> {
    // App Attest sign counters are 32-bit, so they fit comfortably in JS Number.
    // We use BigInt at the storage boundary because pg returns BIGINT as string
    // by default and BigInt avoids any ambiguity in arithmetic.
    const result = await verifyAssertion({
        assertion: Buffer.from(input.assertion, "base64"),
        payload: Buffer.from(input.challenge),
        publicKey: input.publicKey,
        bundleIdentifier: BUNDLE_ID!,
        teamIdentifier: TEAM_ID!,
        signCount: Number(input.previousCounter),
    });

    return { newCounter: BigInt(result.signCount) };
}
