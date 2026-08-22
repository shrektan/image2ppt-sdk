/**
 * The package version must match the one that actually gets published.
 *
 * These drifted apart once on the Python side (`__version__` said 0.1.0 while the
 * built package was 0.1.1), which makes a bug report's version line useless.
 * `package.json` is the release number; `VERSION` must follow it.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
