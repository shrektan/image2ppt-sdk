/**
 * Package version, in one place.
 *
 * `package.json` is the published number. This constant is what the User-Agent
 * is built from, and `test/version.test.ts` keeps the two in step — they drifted
 * apart once on the Python side, which made a bug report's version line useless.
 *
 * Do not read `package.json` at runtime: ESM + bundlers will not resolve it.
 */
export const VERSION = "0.4.0";
