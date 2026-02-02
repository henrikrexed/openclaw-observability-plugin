/**
 * OpenClaw OTel GenAI Preload Script
 *
 * Usage:
 *   NODE_OPTIONS="--import /path/to/preload.mjs" openclaw gateway start
 *
 * This script is loaded BEFORE any other modules, allowing OpenLLMetry
 * to properly hook into @anthropic-ai/sdk, openai, etc. via ESM loader hooks.
 *
 * It registers instrumentations that produce GenAI semantic convention spans
 * (gen_ai.system, gen_ai.request.model, gen_ai.usage.*, etc.)
 *
 * The spans are exported to the same OTLP endpoint as the plugin (localhost:4318).
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";

// Import OpenLLMetry instrumentations
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";

// Configuration — matches the plugin defaults
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

// Graceful shutdown
process.on("SIGTERM", () => sdk.shutdown());
process.on("SIGINT", () => sdk.shutdown());

console.log(`[otel-preload] GenAI instrumentation registered (endpoint=${OTLP_ENDPOINT})`);
