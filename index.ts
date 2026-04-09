/**
 * OpenClaw OTel Observability Plugin
 *
 * Provides full OpenTelemetry observability for OpenClaw:
 *   - Connected distributed traces (request → agent turn → tools)
 *   - Cost tracking via OpenClaw diagnostic events integration
 *   - Token usage (input, output, cache read/write) as spans + metrics
 *   - Tool execution spans with result metadata
 *   - Metrics: token usage, cost, latency histograms, tool calls
 *   - OTLP export to any OpenTelemetry-compatible backend (Dynatrace, Grafana, etc.)
 *
 * Usage in openclaw config:
 *   {
 *     "plugins": {
 *       "entries": {
 *         "otel-observability": {
 *           "enabled": true,
 *           "config": {
 *             "endpoint": "http://localhost:4318",
 *             "protocol": "http",
 *             "serviceName": "openclaw-gateway",
 *             "traces": true,
 *             "metrics": true,
 *             "captureContent": false
 *           }
 *         }
 *       }
 *     }
 *   }
 */

import { parseConfig, type OtelObservabilityConfig } from "./src/config.js";
import { initTelemetry, type TelemetryRuntime } from "./src/telemetry.js";
import { initOpenLLMetry } from "./src/openllmetry.js";
import { registerHooks } from "./src/hooks.js";
import { registerDiagnosticsListener, hasDiagnosticsSupport } from "./src/diagnostics.js";

const otelObservabilityPlugin = {
  id: "otel-observability",
  name: "OpenTelemetry Observability",
  description:
    "Connected traces, cost tracking, and metrics for OpenClaw via OpenTelemetry",

  configSchema: {
    parse(value: unknown): OtelObservabilityConfig {
      return parseConfig(value);
    },
  },

  register(api: any) {
    const config = parseConfig(api.pluginConfig);
    const logger = api.logger;

    let telemetry: TelemetryRuntime | null = null;
    let unsubscribeDiagnostics: (() => void) | null = null;

    // ── Init telemetry + hooks at top level ─────────────────────────
    // MUST happen in register() (not inside registerService.start())
    // because registerService is a no-op in embedded runner contexts.
    // Hooks registered here will fire in both gateway and runner processes;
    // hooks registered inside registerService.start() only fire in gateway.
    // See: api-builder.ts noopRegisterService
    try {
      telemetry = initTelemetry(config, logger);
      logger.info("[otel] Telemetry initialized in register() (universal context)");
      registerHooks(api, telemetry, config);
      logger.info("[otel] Hooks registered at top level (runner-compatible)");
    } catch (err) {
      logger.error(`[otel] Failed to initialize telemetry at register() time: ${err}`);
    }

    // ── RPC: status endpoint ────────────────────────────────────────

    api.registerGatewayMethod(
      "otel-observability.status",
      ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        respond(true, {
          initialized: telemetry !== null,
          config: {
            endpoint: config.endpoint,
            protocol: config.protocol,
            serviceName: config.serviceName,
            traces: config.traces,
            metrics: config.metrics,
            logs: config.logs,
            captureContent: config.captureContent,
          },
        });
      }
    );

    // ── CLI command ─────────────────────────────────────────────────

    api.registerCli(
      ({ program }: { program: any }) => {
        program
          .command("otel")
          .description("OpenTelemetry observability status")
          .action(async () => {
            console.log("🔭 OpenTelemetry Observability Plugin");
            console.log("─".repeat(40));
            console.log(`  Endpoint:        ${config.endpoint}`);
            console.log(`  Protocol:        ${config.protocol}`);
            console.log(`  Service:         ${config.serviceName}`);
            console.log(`  Traces:          ${config.traces ? "✅" : "❌"}`);
            console.log(`  Metrics:         ${config.metrics ? "✅" : "❌"}`);
            console.log(`  Logs:            ${config.logs ? "✅" : "❌"}`);
            console.log(`  Capture content: ${config.captureContent ? "✅" : "❌"}`);
            console.log(`  Initialized:     ${telemetry ? "✅" : "❌"}`);
            console.log(`  Cost tracking:   ${hasDiagnosticsSupport() ? "✅ (via diagnostics API)" : "❌"}`);

          });
      },
      { commands: ["otel"] }
    );

    // ── Background service ──────────────────────────────────────────

    api.registerService({
      id: "otel-observability",

      start: async () => {
        logger.info("[otel] Starting OpenTelemetry observability (gateway-only init)...");

        // Telemetry + hooks were already initialized at register() time so
        // they work in both gateway and runner contexts. Here we only do
        // gateway-specific steps that don't need to run in the runner.

        // Gateway-only: OpenLLMetry SDK wrap detection (no-op without NODE_OPTIONS preload)
        if (config.traces) {
          await initOpenLLMetry(config, logger);
        }

        // Gateway-only: subscribe to diagnostic events (emitted from gateway process)
        if (telemetry) {
          unsubscribeDiagnostics = await registerDiagnosticsListener(telemetry, logger);
          if (hasDiagnosticsSupport()) {
            logger.info("[otel] ✅ Integrated with OpenClaw diagnostics (cost tracking enabled)");
          }
        }

        logger.info("[otel] ✅ Observability pipeline active (gateway-side)");
        logger.info(
          `[otel]   Traces=${config.traces} Metrics=${config.metrics} Logs=${config.logs}`
        );
        logger.info(`[otel]   Endpoint=${config.endpoint} (${config.protocol})`);
      },

      stop: async () => {
        if (unsubscribeDiagnostics) {
          unsubscribeDiagnostics();
          unsubscribeDiagnostics = null;
        }
        if (telemetry) {
          await telemetry.shutdown();
          telemetry = null;
          logger.info("[otel] Telemetry shut down");
        }
      },
    });

    // ── Agent tool: otel_status ─────────────────────────────────────
    // Lets the agent check observability status in conversation

    api.registerTool(
      {
        name: "otel_status",
        label: "OTel Status",
        description:
          "Check the OpenTelemetry observability plugin status and configuration.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        async execute() {
          const status = {
            initialized: telemetry !== null,
            endpoint: config.endpoint,
            protocol: config.protocol,
            serviceName: config.serviceName,
            traces: config.traces,
            metrics: config.metrics,
            logs: config.logs,
            captureContent: config.captureContent,
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(status, null, 2),
              },
            ],
          };
        },
      },
      { optional: true }
    );
  },
};

export default otelObservabilityPlugin;
