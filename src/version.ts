/**
 * Plugin version resolution for the OTel Resource (ISI-995).
 *
 * The plugin's `openclaw.plugin.json` is the source of truth for the version
 * shown to dashboards as `service.version`. release-please keeps that
 * manifest, `package.json`, and the published npm tag in lockstep, so any
 * of those is fine — we read the OpenClaw manifest because it is the one
 * the plugin loader resolves and ships with the published package.
 *
 * Reading happens once at module load and the result is cached as a
 * constant. If the manifest is missing or malformed (e.g. a sandbox that
 * stripped JSON files from the bundle) the fallback `"unknown"` keeps the
 * Resource emitting a well-formed `service.version` instead of leaking the
 * old hard-coded `"0.1.0"` placeholder.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readPluginVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = resolve(here, "..", "openclaw.plugin.json");
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Plugin version emitted as `service.version` on every span / metric / log.
 * Resolved from `openclaw.plugin.json` at module load.
 */
export const PLUGIN_VERSION: string = readPluginVersion();
