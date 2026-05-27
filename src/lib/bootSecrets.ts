/**
 * Decodes secrets that arrive base64-encoded in env vars and writes them to
 * disk so client libraries expecting file paths (google-auth-library being
 * the current consumer) can read them.
 *
 * Why base64 env vars instead of mounted files:
 *   Railway and most container hosts have no first-class concept of mounting
 *   a private JSON file at runtime. Volumes exist but are platform-specific.
 *   A base64-encoded env var is portable: it survives redeploys, dashboard
 *   edits, and host migrations, without anything platform-specific in the
 *   codebase. Local dev can still point GOOGLE_APPLICATION_CREDENTIALS at a
 *   real file path on disk and skip this entirely.
 *
 * Why import this first in src/index.ts:
 *   google-auth-library reads GOOGLE_APPLICATION_CREDENTIALS lazily (on first
 *   auth call, not at import time), so strictly speaking the env var only
 *   needs to be set before the first request. Running this at boot anyway
 *   makes the lifecycle obvious and surfaces any base64 decoding errors
 *   immediately rather than on the first attestation attempt.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PLAY_INTEGRITY_KEY_B64 = process.env.PLAY_INTEGRITY_KEY_B64;

if (PLAY_INTEGRITY_KEY_B64) {
    // Use the OS tmpdir so we don't fight permissions or assume a writable
    // CWD. The container is single-tenant and the file is overwritten on
    // every boot, so a stable filename is fine.
    const keyPath = path.join(os.tmpdir(), "play-integrity-key.json");

    const decoded = Buffer.from(PLAY_INTEGRITY_KEY_B64, "base64");

    // Mode 0o600 (owner read/write only) is cheap defense-in-depth even on
    // a single-tenant container, in case another process ever shares /tmp.
    fs.writeFileSync(keyPath, decoded, { mode: 0o600 });

    // google-auth-library reads this env var lazily on first auth call.
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

    console.log(
        `[bootSecrets] Decoded PLAY_INTEGRITY_KEY_B64 to ${keyPath}`,
    );
}
