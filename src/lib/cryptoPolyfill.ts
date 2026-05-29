// Imported first (before any module that loads jose) so the Web Crypto global
// is guaranteed to exist for the lifetime of the process.
//
// jose v6 signs and verifies JWTs through the Web Crypto API, which it reaches
// via the *global* `crypto` object — it does not import from node:crypto. Node
// 19+ exposes `globalThis.crypto` by default, but some runtimes (and the
// nixpacks Node our container ended up on) don't, and jose then throws
// `ReferenceError: crypto is not defined` the moment it tries to sign. In our
// case that surfaced as spurious 401 "Attestation rejected" responses from
// /auth/token: attestation actually passed, but minting the JWT crashed and the
// route's catch-all turned it into a 401.
//
// node:crypto has always shipped the same Web Crypto implementation under
// `webcrypto`; this simply exposes it at the global name jose expects. Guarded
// so we never clobber a runtime that already provides it. defineProperty (not
// plain assignment) because the global `crypto` is declared read-only in the
// type definitions.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        configurable: true,
        enumerable: false,
        writable: false,
    });
}
