/**
 * OpenLLMetry initialization — auto-instruments Anthropic and OpenAI SDK calls.
 *
 * IMPORTANT: This must be initialized BEFORE the Anthropic/OpenAI SDK modules
 * are imported by OpenClaw. Since plugins load at gateway startup, this is
 * handled by calling initOpenLLMetry() in the service start hook.
 *
 * OpenLLMetry uses monkey-patching (standard OTel instrumentation approach)
 * to wrap LLM SDK methods and produce GenAI spans automatically.
 */

import type { OtelObservabilityConfig } from "./config.js";

let initialized = false;

export async function initOpenLLMetry(config: OtelObservabilityConfig, logger: any): Promise<void> {
  if (initialized) {
    logger.info("[otel] OpenLLMetry already initialized, skipping");
    return;
  }

  try {
    // Dynamic import to avoid issues if the SDK isn't installed
    const traceloop = await import("@traceloop/node-server-sdk");

    // Build the initialization options
    const initOptions: Record<string, any> = {
      // Use our own OTLP endpoint instead of Traceloop cloud
      baseUrl: config.endpoint,
      // Disable batch for faster feedback during development
      disableBatch: false,
      // App name shows up as the service name in traces
      appName: config.serviceName,
      // Control content capture (prompts/completions)
      traceContent: config.captureContent,
    };

    // Pass custom headers if configured
    if (config.headers && Object.keys(config.headers).length > 0) {
      // OpenLLMetry uses TRACELOOP_HEADERS env var format or direct config
      const headerStr = Object.entries(config.headers)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      process.env.TRACELOOP_HEADERS = headerStr;
    }

    // Set the base URL env var (OpenLLMetry reads this)
    process.env.TRACELOOP_BASE_URL = config.endpoint;

    // Initialize OpenLLMetry
    traceloop.initialize(initOptions);

    initialized = true;
    logger.info(`[otel] OpenLLMetry initialized → ${config.endpoint} (captureContent=${config.captureContent})`);
  } catch (err) {
    logger.error(
      `[otel] Failed to initialize OpenLLMetry: ${err instanceof Error ? err.message : String(err)}`
    );
    logger.error("[otel] LLM auto-instrumentation will not be available");
  }
}
