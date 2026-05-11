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

import { parseConfig, policyEnablesLlmContent, type OtelObservabilityConfig } from "./src/config.js";
import { initTelemetry, type TelemetryRuntime } from "./src/telemetry.js";
import { initOpenLLMetry } from "./src/openllmetry.js";
import { registerHooks } from "./src/hooks.js";
import { registerDiagnosticsListener, hasDiagnosticsSupport } from "./src/diagnostics.js";

// ── Public re-exports ───────────────────────────────────────────────
// W3C trace context propagation helpers. Available without the plugin
// register lifecycle so user code (custom RPC, message queues,
// sub-agent transports) can inject/extract `traceparent` directly.
export {
  injectTraceContext,
  extractTraceContext,
  getPropagator,
  setupGlobalPropagator,
  propagationFields,
  type HeaderCarrier,
} from "./src/propagation.js";

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
    let stopHooks: (() => void) | null = null;

    // ── Telemetry + hooks (init at register() time) ─────────────────
    // Both MUST run during register() so they work in every OpenClaw
    // context, not just the gateway:
    //   - Hooks: OpenClaw snapshots typed hooks at plugin registration,
    //     so registering later means the gateway never sees them.
    //   - Telemetry: api.registerService.start() is a no-op in embedded
    //     runner contexts (openclaw agent CLI, cron, heartbeat,
    //     task-runner, subagent — see openclaw src/plugins/api-builder.ts).
    //     Initializing inside start() means telemetry stays null in
    //     those contexts and every hook is a no-op.
    // registerHooks returns a cleanup fn (clears the stale-session
    // sweeper interval) so service.stop() doesn't leak the timer.
    try {
      telemetry = initTelemetry(config, logger);
      stopHooks = registerHooks(api, () => telemetry, config);
      logger.info("[otel] Telemetry + hooks initialized at register() (runner-compatible)");
    } catch (err) {
      logger.error(`[otel] Failed to initialize telemetry at register() time: ${String(err)}`);
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
            const policy = config.captureContent;
            const onFlags = (Object.keys(policy) as Array<keyof typeof policy>)
              .filter((k) => policy[k]);
            const capContentStr =
              onFlags.length === 0
                ? "❌ none"
                : onFlags.length === Object.keys(policy).length
                  ? "✅ all"
                  : `⚠️ ${onFlags.join(", ")}`;
            console.log(`  Capture content: ${capContentStr}`);
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

        // Telemetry + hooks are already initialized at register() time so
        // they work in both gateway and embedded runner contexts. Only
        // gateway-specific work lives here.

        // Bridge captureContent → env vars consumed by the preload.
        // The preload reads these at gateway launch, but any subprocess
        // spawned later inherits them from here too. If the preload was
        // already active with a mismatched value, LLM-client spans will
        // reflect the preload's value (not the plugin config) — warn so
        // operators know to set the env vars before launching the gateway.
        //
        // Two vars are published:
        //   - OPENCLAW_OTEL_CONTENT_POLICY: full granular policy as JSON
        //     (ISI-1000). The preload reads this with precedence.
        //   - OPENCLAW_OTEL_CAPTURE_CONTENT: legacy single boolean
        //     (`inputMessages || outputMessages || systemPrompt`), kept
        //     for older preloads and external subprocesses that still
        //     read the legacy flag.
        //
        // Precedence (subprocesses): these assignments **always
        // overwrite** whatever the gateway was launched with. A
        // subprocess spawned by gateway code (e.g. a child OpenClaw
        // runner) therefore inherits the plugin's resolved policy, not
        // whatever the operator originally set in the gateway's
        // environment. This is intentional — plugin config is the
        // authority for in-process behavior; the env vars exist only to
        // brief the preload that ran before plugin config was parsed.
        // If you need a subprocess to see a different value, set it
        // explicitly in that subprocess's spawn-time env, not in the
        // gateway's.
        const llmContentEnabled = policyEnablesLlmContent(config.captureContent);
        const policyJson = JSON.stringify(config.captureContent);
        const preloadActive = (globalThis as any).__OPENCLAW_OTEL_PRELOAD_ACTIVE === true;
        const preloadResolved = (globalThis as any).__OPENCLAW_OTEL_CAPTURE_CONTENT;
        if (preloadActive && preloadResolved !== llmContentEnabled) {
          logger.warn(
            `[otel] captureContent policy resolves traceContent=${llmContentEnabled} but the preload resolved OPENCLAW_OTEL_CAPTURE_CONTENT=${preloadResolved} at gateway launch. ` +
              `Traceloop LLM-client spans will use the preload's value. ` +
              `Set OPENCLAW_OTEL_CONTENT_POLICY='${policyJson}' (or OPENCLAW_OTEL_CAPTURE_CONTENT=${llmContentEnabled}) in the gateway's environment before starting (see docs/security/privacy.md).`
          );
        }
        process.env.OPENCLAW_OTEL_CAPTURE_CONTENT = String(llmContentEnabled);
        process.env.OPENCLAW_OTEL_CONTENT_POLICY = policyJson;

        // 1. Wrap LLM SDKs. The wraps use trace.getTracer() which goes
        //    through the provider we registered above. OpenLLMetry's
        //    IITM preload only matters in the long-running gateway
        //    process, so leave it here.
        if (config.traces) {
          await initOpenLLMetry(config, logger);
        }

        // 2. Subscribe to OpenClaw diagnostic events (model.usage, etc.)
        //    for cost + accurate token counts. These events are emitted
        //    from the gateway process, so the listener only needs to
        //    live there.
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
        if (stopHooks) {
          stopHooks();
          stopHooks = null;
        }
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
