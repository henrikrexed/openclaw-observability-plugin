/**
 * OpenClaw OTel GenAI Preload Script
 *
 * Usage:
 *   NODE_OPTIONS="--import /path/to/preload.mjs" openclaw gateway start
 *
 * CRITICAL: Must import the IITM hook FIRST to register ESM loader hooks.
 * Without this, instrumentations cannot intercept ESM module imports
 * (like @anthropic-ai/sdk/index.mjs which pi-ai loads via ESM import).
 */

// Step 1: Register ESM loader hooks (import-in-the-middle)
// This MUST be imported before any instrumented modules are loaded.
import '@opentelemetry/instrumentation/hook.mjs';

// Step 2: Set up the OTel SDK with GenAI instrumentations
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";

const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "openclaw-gateway";

const resource = resourceFromAttributes({
  "service.name": SERVICE_NAME,
  "service.version": "0.1.0",
  "telemetry.sdk.name": "openclaw-otel-preload",
});

const traceExporter = new OTLPTraceExporter({
  url: `${OTLP_ENDPOINT}/v1/traces`,
});

const sdk = new NodeSDK({
  resource,
  spanProcessors: [new BatchSpanProcessor(traceExporter)],
  instrumentations: [
    new AnthropicInstrumentation({ traceContent: false }),
    new OpenAIInstrumentation({ traceContent: false }),
  ],
});

sdk.start();

// Signal to the plugin that preload is active
globalThis.__OPENCLAW_OTEL_PRELOAD_ACTIVE = true;

process.on("SIGTERM", () => sdk.shutdown());
process.on("SIGINT", () => sdk.shutdown());

console.log(`[otel-preload] GenAI instrumentation registered with ESM hooks (endpoint=${OTLP_ENDPOINT})`);
