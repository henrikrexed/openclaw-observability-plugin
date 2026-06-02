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
import { initTelemetry, hasPreloadedOtelSdk, type TelemetryRuntime } from "./src/telemetry.js";
import { initOpenLLMetry } from "./src/openllmetry.js";
import { registerHooks } from "./src/hooks.js";
import { registerDiagnosticsListener, hasDiagnosticsSupport } from "./src/diagnostics.js";
import { initLogPipeline, bridgeGatewayLogger, type LogPipelineRuntime } from "./src/logs.js";

let gatewayStopFinalizer: (() => Promise<void>) | null = null;
let gatewayStopFinalizationStarted = false;

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
    const logger = api.logger;
    const config = parseConfig(api.pluginConfig, logger);

    let telemetry: TelemetryRuntime | null = null;
    let logPipeline: LogPipelineRuntime | null = null;
    let restoreLogger: (() => void) | null = null;
    let unsubscribeDiagnostics: (() => void) | null = null;
    let stopHooks: (() => void) | null = null;

    const shutdownTelemetry = async () => {
      if (!telemetry) return;
      await telemetry.shutdown();
      telemetry = null;
      logger.info("[otel] Telemetry shut down on gateway_stop");
    };
    gatewayStopFinalizer = shutdownTelemetry;
    gatewayStopFinalizationStarted = false;

    // ── Telemetry + hooks (init at register() time) ─────────────────
    // Telemetry, the log pipeline, and hooks ALL run during register()
    // so they work in every OpenClaw context, not just the gateway:
    //   - Hooks: OpenClaw snapshots typed hooks at plugin registration,
    //     so registering later means the gateway never sees them.
    //   - Telemetry / log pipeline: api.registerService.start() is a no-op
    //     in embedded runner contexts (openclaw agent CLI, cron,
    //     heartbeat, task-runner, subagent — see openclaw
    //     src/plugins/api-builder.ts). Initializing inside start() means
    //     telemetry/logs stay null in those contexts and every hook is
    //     a no-op.
    // registerHooks returns a cleanup fn (clears the stale-session
    // sweeper interval) so service.stop() doesn't leak the timer.
    try {
      telemetry = initTelemetry(config, logger);

      // ISI-997 — wire the OTLP log pipeline + bridge api.logger calls so
      // every gateway log emitted by this plugin (and anyone holding the
      // same logger reference) is exported as an OTel LogRecord.
      if (config.logs) {
        logPipeline = initLogPipeline(config, logger);
        if (logPipeline) {
          restoreLogger = bridgeGatewayLogger(logger, logPipeline.emit);
          logger.info("[otel] Gateway logger bridged to OTel log pipeline");
        }
      }

      stopHooks = registerHooks(api, () => telemetry, config);
      // `api.on` does not expose an unsubscribe handle. If a host retains
      // old hook registrations across hot reloads, every registered wrapper
      // shares this module-level guard and dispatches only the latest finalizer.
      api.on?.("gateway_stop", async () => {
        if (gatewayStopFinalizationStarted) return;
        gatewayStopFinalizationStarted = true;
        await gatewayStopFinalizer?.();
      });
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

    // Subscribe to diagnostic events immediately (not just in start())
    // so we capture gateway health metrics even if start() isn't called.
    if (telemetry) {
      registerDiagnosticsListener(telemetry, logger).then((unsub) => {
        unsubscribeDiagnostics = unsub;
        if (hasDiagnosticsSupport()) {
          logger.info("[otel] ✅ Integrated with OpenClaw diagnostics (cost tracking enabled)");
        }
      }).catch((err) => {
        logger.error(`[otel] Failed to register diagnostics listener: ${String(err)}`);
      });
    }

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
        const preloadActive = hasPreloadedOtelSdk();
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
        if (restoreLogger) {
          restoreLogger();
          restoreLogger = null;
        }
        if (logPipeline) {
          await logPipeline.shutdown();
          logPipeline = null;
        }
        // Flush pending data but do NOT destroy the providers. OC's config
        // hot-reload calls stop() → register() in sequence; a destructive
        // shutdown() here kills the TracerProvider's exporter, and the new
        // register() cycle's hooks still hold closures over the old runtime
        // whose tracer routes through the (now dead) global provider.
        // Flush is non-destructive: pending spans/metrics drain to the
        // collector, but the providers stay usable for the existing hooks.
        // True shutdown happens on process exit via the OTel SDK's
        // registered signal handlers.
        if (telemetry) {
          await telemetry.flush();
          logger.info("[otel] Telemetry flushed (providers preserved for hot-reload)");
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
