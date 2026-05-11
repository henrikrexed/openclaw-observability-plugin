/**
 * Tests for ISI-995 — resource identity (plugin version + schema URL).
 *
 * Acceptance criteria pinned here:
 *
 *   - `PLUGIN_VERSION` resolves to the version in `openclaw.plugin.json`
 *     (not the legacy hard-coded `"0.1.0"` placeholder).
 *   - `OTEL_SCHEMA_URL` matches the version of
 *     `@opentelemetry/semantic-conventions` that's actually installed on
 *     disk — bumping the dep without bumping the constant would silently
 *     mislead downstream backends about which attribute generation the
 *     plugin emits.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PLUGIN_VERSION } from "../src/version.js";
import { OTEL_SCHEMA_URL } from "../src/semconv.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("PLUGIN_VERSION (ISI-995)", () => {
  it("equals the version declared in openclaw.plugin.json", () => {
    const manifest = readJson(resolve(repoRoot, "openclaw.plugin.json"));
    expect(typeof manifest.version).toBe("string");
    expect(PLUGIN_VERSION).toBe(manifest.version);
  });

  it("is kept in lockstep with package.json (release-please contract)", () => {
    // openclaw.plugin.json and package.json are bumped together by
    // release-please. If this assertion ever fires, either the manifests
    // drifted (CI bug) or someone bumped one by hand — neither should
    // ship.
    const pkg = readJson(resolve(repoRoot, "package.json"));
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });

  it("is not the legacy hard-coded placeholder", () => {
    // Catch a regression where someone reintroduces the "0.1.0" sentinel
    // for whatever reason.
    expect(PLUGIN_VERSION).not.toBe("0.1.0");
    expect(PLUGIN_VERSION).not.toBe("unknown");
  });
});

describe("OTEL_SCHEMA_URL (ISI-995)", () => {
  it("matches the installed @opentelemetry/semantic-conventions version", () => {
    const semconv = readJson(
      resolve(repoRoot, "node_modules/@opentelemetry/semantic-conventions/package.json"),
    );
    expect(typeof semconv.version).toBe("string");
    expect(OTEL_SCHEMA_URL).toBe(
      `https://opentelemetry.io/schemas/${semconv.version as string}`,
    );
  });

  it("is a well-formed opentelemetry.io schema URL", () => {
    expect(OTEL_SCHEMA_URL).toMatch(
      /^https:\/\/opentelemetry\.io\/schemas\/\d+\.\d+\.\d+$/,
    );
  });
});
