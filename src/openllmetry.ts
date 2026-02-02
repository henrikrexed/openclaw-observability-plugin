/**
 * LLM SDK instrumentation placeholder.
 *
 * Direct SDK wrapping doesn't work because:
 *   - OpenClaw/pi-ai loads @anthropic-ai/sdk via ESM (index.mjs)
 *   - This plugin runs in jiti (CJS context) — can't access ESM module instances
 *   - ESM and CJS are separate module instances with different prototypes
 *   - jiti blocks native import() (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING)
 *
 * The proper solution is NODE_OPTIONS=--import with a preload script.
 * See instrumentation/preload.mjs for the preload approach.
 */

import type { OtelObservabilityConfig } from "./config.js";

export async function initOpenLLMetry(_config: OtelObservabilityConfig, logger: any): Promise<void> {
  // Check if preload instrumentation is active (it sets a global flag)
  const preloadActive = (globalThis as any).__OPENCLAW_OTEL_PRELOAD_ACTIVE === true;

  if (preloadActive) {
    logger.info("[otel] ✅ GenAI instrumentation active via NODE_OPTIONS preload");
  } else {
    logger.info("[otel] GenAI SDK instrumentation not active (preload not configured)");
    logger.info("[otel]   To enable: set NODE_OPTIONS='--import /path/to/preload.mjs' before starting openclaw");
    logger.info("[otel]   Hook-based spans (agent turns, tools, messages) are still active");
  }
}
