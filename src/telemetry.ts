/**
 * Core OpenTelemetry setup — initializes tracing (with OpenLLMetry),
 * metrics, and resource configuration.
 *
 * OpenLLMetry auto-instruments Anthropic/OpenAI SDK calls and produces
 * standard OTel spans following the GenAI semantic conventions.
 */

import { trace, metrics, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Span, Tracer, Meter, Counter, Histogram, UpDownCounter } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import type { Sampler } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from "@opentelemetry/exporter-trace-otlp-grpc";

import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc";

import type { OtelObservabilityConfig } from "./config.js";
import { setupGlobalPropagator } from "./propagation.js";
import {
  METRIC_OPERATION_DURATION,
  METRIC_TOKEN_USAGE,
  OC_SCHEMA_VERSION,
  OPENCLAW_SCHEMA_VERSION,
  OTEL_SCHEMA_URL,
} from "./semconv.js";
import { PLUGIN_VERSION } from "./version.js";

/**
 * Env var set by instrumentation/preload.mjs when OpenClaw is launched with
 * `NODE_OPTIONS=--import .../preload.mjs`. When set, an OTel SDK is already
 * registered as the global TracerProvider in this process, and the plugin
 * MUST NOT register a second one (the second register() silently replaces
 * the preload's provider, and plugin spans stop reaching the exporter).
 */
export const PRELOADED_OTEL_SDK_ENV = "OPENCLAW_OTEL_PRELOADED";

/**
 * Reads the preload hint from env + globalThis without verifying the global
 * TracerProvider. Exported for tests; production callers should use
 * {@link hasPreloadedOtelSdk}, which also verifies a real provider is
 * registered.
 */
export function readPreloadHint(): boolean {
  return (
    process.env[PRELOADED_OTEL_SDK_ENV] === "1" ||
    (globalThis as any).__OPENCLAW_OTEL_PRELOAD_ACTIVE === true
  );
}

/**
 * Returns true iff the current global TracerProvider is a real (non-Noop)
 * provider — i.e. some SDK has called `provider.register()` and the proxy
 * has a non-Noop delegate, or a non-proxy provider was registered directly.
 *
 * Used to defend against env-var-lying scenarios: a child process can inherit
 * `OPENCLAW_OTEL_PRELOADED=1` while `NODE_OPTIONS` is stripped (sandbox
 * runners, setuid binaries, `child_process.spawn({env})` overriding the
 * environment), in which case the preload script never ran and no real
 * provider exists. Without verification, the plugin would skip its own
 * registration and silently drop every span as a NOOP.
 */
function hasRealGlobalTracerProvider(): boolean {
  try {
    const provider = trace.getTracerProvider() as unknown as {
      getDelegate?: () => unknown;
    };
    if (provider == null) return false;

    // ProxyTracerProvider exposes getDelegate(); unset → NoopTracerProvider.
    if (typeof provider.getDelegate === "function") {
      const delegate = provider.getDelegate();
      const ctorName =
        (delegate as { constructor?: { name?: string } } | null)?.constructor
          ?.name ?? "";
      if (delegate == null) return false;
      if (ctorName === "NoopTracerProvider") return false;
      if (ctorName === "ProxyTracerProvider") return false;
      return true;
    }

    // A non-proxy provider was registered directly — treat as real unless
    // it's a NoopTracerProvider.
    const ctorName =
      (provider as { constructor?: { name?: string } }).constructor?.name ?? "";
    if (ctorName === "NoopTracerProvider") return false;
    if (ctorName === "ProxyTracerProvider") return false;
    return true;
  } catch {
    // Be conservative: if we can't verify a real provider, fall through so
    // the plugin registers its own — better to risk a double-register warning
    // than to drop every span silently.
    return false;
  }
}

/**
 * Returns true when an OTel SDK has already been registered by the preload.
 *
 * Strategy: treat env/globalThis as a hint, then verify with the OTel API
 * that a real global TracerProvider is actually registered. Falls through
 * (returns false) when the hint is set but no real provider exists, so the
 * plugin will register its own provider and spans always have an exporter.
 *
 * @see hasRealGlobalTracerProvider for the verification step.
 */
export function hasPreloadedOtelSdk(): boolean {
  if (!readPreloadHint()) return false;
  return hasRealGlobalTracerProvider();
}

// ── Types ───────────────────────────────────────────────────────────

export interface TelemetryRuntime {
  tracer: Tracer;
  meter: Meter;
  counters: OtelCounters;
  histograms: OtelHistograms;
  gauges: OtelGauges;
  shutdown: () => Promise<void>;
  /** Flush pending spans/metrics without destroying the providers. Safe to
   *  call on hot-reload — providers remain usable after flush returns. */
  flush: () => Promise<void>;
}

export interface OtelCounters {
  /** Total LLM requests */
  llmRequests: Counter;
  /** Total LLM errors */
  llmErrors: Counter;
  /** Total tokens (prompt + completion) */
  tokensTotal: Counter;
  /** Prompt tokens */
  tokensPrompt: Counter;
  /** Completion tokens */
  tokensCompletion: Counter;
  /** Tool invocations */
  toolCalls: Counter;
  /** Tool errors */
  toolErrors: Counter;
  /** Tool approvals requested */
  toolApprovals: Counter;
  /** Session resets */
  sessionResets: Counter;
  /** Messages received */
  messagesReceived: Counter;
  /** Messages sent */
  messagesSent: Counter;
  /** Security events detected */
  securityEvents: Counter;
  /** Sensitive file access attempts */
  sensitiveFileAccess: Counter;
  /** Prompt injection attempts */
  promptInjection: Counter;
  /** Dangerous command executions */
  dangerousCommand: Counter;
  /** Cron change events */
  cronChanges: Counter;
  /** Cron execution events */
  cronExecutions: Counter;
  /** Cron execution errors */
  cronErrors: Counter;
  /** Sub-agent spawn events */
  subagentSpawns: Counter;
  /** Sub-agent completion events */
  subagentEnded: Counter;
  /** Queue lane enqueue events */
  queueLaneEnqueue: Counter;
  /** Queue lane dequeue events */
  queueLaneDequeue: Counter;
  /** Session stuck events */
  sessionStuck: Counter;
  /** Session long-running events */
  sessionLongRunning: Counter;
  /** Session stalled events */
  sessionStalled: Counter;
  /** Liveness warning events */
  livenessWarnings: Counter;
  /** Diagnostic heartbeat events */
  diagnosticHeartbeats: Counter;
  /** System prompt tokens */
  tokensSystem: Counter;
  /** User message tokens */
  tokensUser: Counter;
  /** Tool result tokens */
  tokensToolResult: Counter;
  /** Skill tokens */
  tokensSkill: Counter;
  /** Webhook received events */
  webhooksReceived: Counter;
  /** Webhook processed events */
  webhooksProcessed: Counter;
  /** Webhook error events */
  webhooksErrors: Counter;
  /** Compaction events (attr: reason) — ISI-1628 */
  compactionCount: Counter;
}

export interface OtelHistograms {
  /** LLM request duration in ms */
  llmDuration: Histogram;
  /** Tool execution duration in ms */
  toolDuration: Histogram;
  /** Alias of toolDuration for backward compatibility with existing tool-call duration references. */
  toolCallDuration: Histogram;
  /** Agent turn duration in ms */
  agentTurnDuration: Histogram;
  /** Stable GenAI client operation duration (seconds). */
  genAiOperationDuration: Histogram;
  /** Stable GenAI client token usage (tokens); use with gen_ai.token.type attr. */
  genAiTokenUsage: Histogram;
  /** Cron execution duration in ms */
  cronDuration: Histogram;
  /** Sub-agent duration in ms */
  subagentDuration: Histogram;
  /** Queue depth */
  queueDepth: Histogram;
  /** Queue wait time in ms */
  queueWaitMs: Histogram;
  /** Session stuck age in ms */
  sessionStuckAgeMs: Histogram;
  /** Gateway event loop delay p99 in ms */
  gatewayEventLoopDelayP99: Histogram;
  /** Gateway event loop delay max in ms */
  gatewayEventLoopDelayMax: Histogram;
  /** Gateway event loop utilization */
  gatewayEventLoopUtilization: Histogram;
  /** Gateway CPU core ratio */
  gatewayCpuCoreRatio: Histogram;
  /** Gateway work queued */
  gatewayWorkQueued: Histogram;
  /** Context build duration in ms */
  contextBuildDuration: Histogram;
  /** Webhook processing duration in ms */
  webhookDuration: Histogram;
  /** Webhook payload size in bytes */
  webhookPayloadSize: Histogram;
  /** Tokens reclaimed by a compaction event — ISI-1628 */
  compactionTokensReclaimed: Histogram;
}

export interface OtelGauges {
  /** Currently active sessions */
  activeSessions: UpDownCounter;
  /** Currently active requests */
  activeRequests: UpDownCounter;
  /** Currently active agent turns */
  activeAgentTurns: UpDownCounter;
}

// ── Init ────────────────────────────────────────────────────────────

// Module-level guard to prevent double-registration when the plugin is
// re-initialized (e.g., hot-reload or multiple register() calls).
// Each registration would otherwise replace the global TracerProvider,
// breaking span parent chains and causing orphaned single-span traces.
let initializedRuntime: TelemetryRuntime | null = null;
let tracerProviderRef: NodeTracerProvider | null = null;

type FlushableProvider = {
  forceFlush: () => Promise<void>;
};

function getFlushableGlobalTracerProvider(): FlushableProvider | undefined {
  try {
    const provider = trace.getTracerProvider() as unknown as {
      forceFlush?: () => Promise<void>;
      getDelegate?: () => unknown;
    };
    const delegate =
      typeof provider.getDelegate === "function"
        ? provider.getDelegate()
        : provider;
    if (
      delegate &&
      typeof (delegate as { forceFlush?: unknown }).forceFlush === "function"
    ) {
      return delegate as FlushableProvider;
    }
  } catch {
    // If the global provider cannot be inspected, fall back to the plugin
    // provider below (if any). Flush is best-effort and must not break OC.
  }
  return undefined;
}

export function initTelemetry(config: OtelObservabilityConfig, logger: any): TelemetryRuntime {
  // Idempotent: if we already initialized, reuse the existing runtime.
  // This prevents tracerProvider.register() from being called multiple
  // times, which would corrupt the global tracer provider state and
  // break span parent relationships (manifesting as missing
  // openclaw.agent.turn spans and single-span traces).
  if (initializedRuntime) {
    logger.info("[otel] Reusing existing telemetry runtime (skipping double registration)");
    return initializedRuntime;
  }
  const resourceAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    // ISI-995: emit the real plugin version (from openclaw.plugin.json)
    // instead of the legacy hard-coded "0.1.0" placeholder, so
    // version-comparison dashboards see actual plugin upgrades.
    [ATTR_SERVICE_VERSION]: PLUGIN_VERSION,
    "openclaw.plugin": "otel-observability",
    [OC_SCHEMA_VERSION]: OPENCLAW_SCHEMA_VERSION,
    ...config.resourceAttributes,
  };

  // ISI-995: attach the OTel semconv schema URL to the Resource so
  // backends know which generation of attribute names this plugin emits.
  const resource = resourceFromAttributes(resourceAttrs, {
    schemaUrl: OTEL_SCHEMA_URL,
  });

  // Resolve endpoint suffixes for HTTP protocol
  const traceEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/traces`
      : config.endpoint;
  const metricsEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/metrics`
      : config.endpoint;

  // ── Tracing ─────────────────────────────────────────────────────

  let tracerProvider: NodeTracerProvider | undefined;
  let preloadedTracerProvider: FlushableProvider | undefined;

  if (config.traces) {
    if (hasPreloadedOtelSdk()) {
      // Preload already registered a global TracerProvider with its own
      // exporter. Registering a second provider here would silently replace
      // the preload's, dropping GenAI auto-instrumentation spans. Reuse the
      // existing global provider — trace.getTracer() below will return a
      // tracer backed by it.
      preloadedTracerProvider = getFlushableGlobalTracerProvider();
      logger.info("[otel] Reusing preloaded OpenTelemetry SDK (skipping plugin TracerProvider registration)");
    } else {
      if (readPreloadHint()) {
        // Hint says preload was active but no real global TracerProvider is
        // registered — typically a sandbox that whitelisted env vars but
        // stripped NODE_OPTIONS, so the preload script never executed.
        // Register our own provider instead of trusting the lying hint, so
        // spans still reach the exporter.
        logger.warn(
          "[otel] Preload hint set but no global TracerProvider registered — registering plugin provider (NODE_OPTIONS likely stripped)",
        );
      }

      const traceExporter =
        config.protocol === "grpc"
          ? new OTLPTraceExporterGRPC({ url: traceEndpoint, headers: config.headers })
          : new OTLPTraceExporterHTTP({ url: traceEndpoint, headers: config.headers });

      // Head-based sampling: when sampleRate is set, wrap a TraceIdRatioBased
      // sampler in a ParentBasedSampler so child spans inherit the root
      // decision and distributed traces stay coherent. When sampleRate is
      // omitted, omit the `sampler` key entirely so the SDK default
      // (parentbased_always_on) applies — passing `sampler: undefined`
      // would silently break if @opentelemetry/core ever stops dropping
      // undefined keys in its internal merge().
      let sampler: Sampler | undefined;
      if (config.sampleRate !== undefined) {
        sampler = new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(config.sampleRate),
        });
      }

      // SDK v2: pass spanProcessors in constructor (addSpanProcessor was removed)
      tracerProvider = tracerProviderRef = new NodeTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(traceExporter)],
        ...(sampler ? { sampler } : {}),
      });

      // Register the composite W3C TraceContext + Baggage propagator as the
      // global propagator so HTTP auto-instrumentations (and our exported
      // injectTraceContext/extractTraceContext helpers) propagate
      // `traceparent` across service boundaries by default.
      const propagator = setupGlobalPropagator();
      tracerProviderRef = tracerProvider;
      tracerProvider.register({ propagator });

      const samplingNote =
        config.sampleRate !== undefined
          ? ` sampler=parentbased_traceidratio(${config.sampleRate})`
          : "";
      logger.info(
        `[otel] Trace exporter → ${traceEndpoint} (${config.protocol})${samplingNote}`,
      );
      logger.info("[otel] W3C TraceContext + Baggage propagator registered globally");
    }
  }

  // ── Metrics ─────────────────────────────────────────────────────

  let meterProvider: MeterProvider | undefined;

  if (config.metrics) {
    const metricExporter =
      config.protocol === "grpc"
        ? new OTLPMetricExporterGRPC({ url: metricsEndpoint, headers: config.headers })
        : new OTLPMetricExporterHTTP({ url: metricsEndpoint, headers: config.headers });

    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: config.metricsIntervalMs,
        }),
      ],
    });

    // Register as global meter provider so metrics.getMeter() returns a real meter
    metrics.setGlobalMeterProvider(meterProvider);

    logger.info(`[otel] Metrics exporter → ${metricsEndpoint} (${config.protocol}, interval=${config.metricsIntervalMs}ms)`);
  }

  // ── Instruments ─────────────────────────────────────────────────

  // Instrumentation-scope version mirrors the plugin version emitted on
  // the Resource (ISI-995) so the scope.version field on every span and
  // metric tracks the real release.
  const tracer = trace.getTracer("openclaw-observability", PLUGIN_VERSION);
  const meter = metrics.getMeter("openclaw-observability", PLUGIN_VERSION);

  const counters: OtelCounters = {
    llmRequests: meter.createCounter("openclaw.llm.requests", {
      description: "Total LLM API requests",
      unit: "requests",
    }),
    llmErrors: meter.createCounter("openclaw.llm.errors", {
      description: "Total LLM API errors",
      unit: "errors",
    }),
    tokensTotal: meter.createCounter("openclaw.llm.tokens.total", {
      description: "Total tokens consumed (prompt + completion)",
      unit: "tokens",
    }),
    tokensPrompt: meter.createCounter("openclaw.llm.tokens.prompt", {
      description: "Prompt tokens consumed",
      unit: "tokens",
    }),
    tokensCompletion: meter.createCounter("openclaw.llm.tokens.completion", {
      description: "Completion tokens consumed",
      unit: "tokens",
    }),
    toolCalls: meter.createCounter("openclaw.tool.calls", {
      description: "Total tool invocations",
      unit: "calls",
    }),
    toolErrors: meter.createCounter("openclaw.tool.errors", {
      description: "Total tool errors",
      unit: "errors",
    }),
    toolApprovals: meter.createCounter("openclaw.tool.approvals", {
      description: "Total tool approval requests",
      unit: "approvals",
    }),
    sessionResets: meter.createCounter("openclaw.session.resets", {
      description: "Total session resets",
      unit: "resets",
    }),
    messagesReceived: meter.createCounter("openclaw.messages.received", {
      description: "Total inbound messages",
      unit: "messages",
    }),
    messagesSent: meter.createCounter("openclaw.messages.sent", {
      description: "Total outbound messages",
      unit: "messages",
    }),
    // Security detection counters
    securityEvents: meter.createCounter("openclaw.security.events", {
      description: "Total security events detected",
      unit: "events",
    }),
    sensitiveFileAccess: meter.createCounter("openclaw.security.sensitive_file_access", {
      description: "Sensitive file access attempts",
      unit: "events",
    }),
    promptInjection: meter.createCounter("openclaw.security.prompt_injection", {
      description: "Prompt injection attempts detected",
      unit: "events",
    }),
    dangerousCommand: meter.createCounter("openclaw.security.dangerous_command", {
      description: "Dangerous command executions detected",
      unit: "events",
    }),
    cronChanges: meter.createCounter("openclaw.cron.changes", {
      description: "Total cron change events",
      unit: "events",
    }),
    cronExecutions: meter.createCounter("openclaw.cron.executions", {
      description: "Total cron execution events",
      unit: "events",
    }),
    cronErrors: meter.createCounter("openclaw.cron.errors", {
      description: "Total cron execution errors",
      unit: "errors",
    }),
    subagentSpawns: meter.createCounter("openclaw.subagent.spawns", {
      description: "Total sub-agent spawn events",
      unit: "events",
    }),
    subagentEnded: meter.createCounter("openclaw.subagent.ended", {
      description: "Total sub-agent completion events",
      unit: "events",
    }),
    // Queue metrics (ISI-1017)
    queueLaneEnqueue: meter.createCounter("openclaw.queue.lane.enqueue", {
      description: "Total queue lane enqueue events",
      unit: "events",
    }),
    queueLaneDequeue: meter.createCounter("openclaw.queue.lane.dequeue", {
      description: "Total queue lane dequeue events",
      unit: "events",
    }),
    // Session metrics (ISI-1017)
    sessionStuck: meter.createCounter("openclaw.session.stuck", {
      description: "Total session stuck events",
      unit: "events",
    }),
    sessionLongRunning: meter.createCounter("openclaw.session.long_running", {
      description: "Total session long-running events",
      unit: "events",
    }),
    sessionStalled: meter.createCounter("openclaw.session.stalled", {
      description: "Total session stalled events",
      unit: "events",
    }),
    // Gateway health metrics (ISI-1016)
    livenessWarnings: meter.createCounter("openclaw.liveness.warnings", {
      description: "Total liveness warning events",
      unit: "events",
    }),
    diagnosticHeartbeats: meter.createCounter("openclaw.diagnostic.heartbeats", {
      description: "Total diagnostic heartbeat events",
      unit: "events",
    }),
    // Token breakdown by type (ISI-1018)
    tokensSystem: meter.createCounter("openclaw.llm.tokens.system", {
      description: "System prompt tokens",
      unit: "tokens",
    }),
    tokensUser: meter.createCounter("openclaw.llm.tokens.user", {
      description: "User message tokens",
      unit: "tokens",
    }),
    tokensToolResult: meter.createCounter("openclaw.llm.tokens.tool_result", {
      description: "Tool result tokens",
      unit: "tokens",
    }),
    tokensSkill: meter.createCounter("openclaw.llm.tokens.skill", {
      description: "Skill tokens",
      unit: "tokens",
    }),
    // Webhook metrics (ISI-1020)
    webhooksReceived: meter.createCounter("openclaw.webhooks.received", {
      description: "Total webhook received events",
      unit: "events",
    }),
    webhooksProcessed: meter.createCounter("openclaw.webhooks.processed", {
      description: "Total webhook processed events",
      unit: "events",
    }),
    webhooksErrors: meter.createCounter("openclaw.webhooks.errors", {
      description: "Total webhook error events",
      unit: "errors",
    }),
    // Compaction metrics (ISI-1628)
    compactionCount: meter.createCounter("openclaw.compaction.count", {
      description: "Total context-compaction events",
      unit: "events",
    }),
  };

  const toolDuration = meter.createHistogram("openclaw.tool.duration", {
    description: "Tool execution duration",
    unit: "ms",
  });

  const histograms: OtelHistograms = {
    llmDuration: meter.createHistogram("openclaw.llm.duration", {
      description: "LLM request duration",
      unit: "ms",
    }),
    toolDuration,
    toolCallDuration: toolDuration,
    agentTurnDuration: meter.createHistogram("openclaw.agent.turn_duration", {
      description: "Full agent turn duration (LLM + tools)",
      unit: "ms",
    }),
    genAiOperationDuration: meter.createHistogram(METRIC_OPERATION_DURATION, {
      description: "GenAI operation duration (stable semconv)",
      unit: "s",
    }),
    genAiTokenUsage: meter.createHistogram(METRIC_TOKEN_USAGE, {
      description: "Number of input and output tokens used (stable semconv)",
      unit: "{token}",
    }),
    cronDuration: meter.createHistogram("openclaw.cron.duration", {
      description: "Cron execution duration",
      unit: "ms",
    }),
    subagentDuration: meter.createHistogram("openclaw.subagent.duration", {
      description: "Sub-agent duration",
      unit: "ms",
    }),
    // Queue histograms (ISI-1017)
    queueDepth: meter.createHistogram("openclaw.queue.depth", {
      description: "Queue depth",
      unit: "items",
    }),
    queueWaitMs: meter.createHistogram("openclaw.queue.wait_ms", {
      description: "Queue wait time",
      unit: "ms",
    }),
    // Session histograms (ISI-1017)
    sessionStuckAgeMs: meter.createHistogram("openclaw.session.stuck_age_ms", {
      description: "Session stuck age",
      unit: "ms",
    }),
    // Gateway health histograms (ISI-1016)
    gatewayEventLoopDelayP99: meter.createHistogram("openclaw.gateway.event_loop_delay_p99", {
      description: "Gateway event loop delay p99",
      unit: "ms",
    }),
    gatewayEventLoopDelayMax: meter.createHistogram("openclaw.gateway.event_loop_delay_max", {
      description: "Gateway event loop delay max",
      unit: "ms",
    }),
    gatewayEventLoopUtilization: meter.createHistogram("openclaw.gateway.event_loop_utilization", {
      description: "Gateway event loop utilization",
      unit: "1",
    }),
    gatewayCpuCoreRatio: meter.createHistogram("openclaw.gateway.cpu_core_ratio", {
      description: "Gateway CPU core ratio",
      unit: "1",
    }),
    gatewayWorkQueued: meter.createHistogram("openclaw.gateway.work_queued", {
      description: "Gateway work queued",
      unit: "items",
    }),
    // Context build duration (ISI-1018)
    contextBuildDuration: meter.createHistogram("openclaw.context.build_duration", {
      description: "Context build duration",
      unit: "ms",
    }),
    // Webhook histograms (ISI-1020)
    webhookDuration: meter.createHistogram("openclaw.webhook.duration", {
      description: "Webhook processing duration",
      unit: "ms",
    }),
    webhookPayloadSize: meter.createHistogram("openclaw.webhook.payload_size", {
      description: "Webhook payload size",
      unit: "bytes",
    }),
    // Compaction histogram (ISI-1628)
    compactionTokensReclaimed: meter.createHistogram("openclaw.compaction.tokens_reclaimed", {
      description: "Tokens reclaimed by a context-compaction event",
      unit: "{token}",
    }),
  };

  const gauges: OtelGauges = {
    activeSessions: meter.createUpDownCounter("openclaw.sessions.active", {
      description: "Currently active sessions",
      unit: "sessions",
    }),
    activeRequests: meter.createUpDownCounter("openclaw.requests.active", {
      description: "Currently active requests",
      unit: "requests",
    }),
    activeAgentTurns: meter.createUpDownCounter("openclaw.agent_turns.active", {
      description: "Currently active agent turns",
      unit: "turns",
    }),
  };

  // ── Periodic Metric Heartbeat ─────────────────────────────────
  // OTel counters only emit data points when .add() is called.
  // To maintain continuous timeseries (important for Dynatrace),
  // we periodically emit zero-value data points on all counters.
  // This ensures metrics always have data, even during idle periods.

  const metricHeartbeatInterval = setInterval(() => {
    try {
      const idleAttrs = { "openclaw.idle": true };

      // Core counters — emit 0 to keep timeseries alive
      counters.llmRequests.add(0, idleAttrs);
      counters.llmErrors.add(0, idleAttrs);
      counters.tokensTotal.add(0, idleAttrs);
      counters.tokensPrompt.add(0, idleAttrs);
      counters.tokensCompletion.add(0, idleAttrs);
      counters.toolCalls.add(0, idleAttrs);
      counters.toolErrors.add(0, idleAttrs);
      counters.messagesReceived.add(0, idleAttrs);
      counters.messagesSent.add(0, idleAttrs);
      counters.sessionResets.add(0, idleAttrs);

      // Security counters
      counters.securityEvents.add(0, idleAttrs);
      counters.sensitiveFileAccess.add(0, idleAttrs);
      counters.promptInjection.add(0, idleAttrs);
      counters.dangerousCommand.add(0, idleAttrs);
    } catch {
      // Never let metric heartbeat errors affect the gateway
    }
  }, config.metricsIntervalMs || 30_000); // Match the export interval
  if (typeof (metricHeartbeatInterval as { unref?: () => void }).unref === "function") {
    (metricHeartbeatInterval as { unref: () => void }).unref();
  }

  // ── Flush (non-destructive) ──────────────────────────────────────
  // Drains pending spans and metrics to the collector without destroying
  // the providers. Safe to call on config hot-reload — the providers
  // remain usable after flush returns. Also exposed via a well-known
  // global Symbol so the CLI exit handler can flush before process.exit()
  // in --local mode (where BatchSpanProcessor would otherwise lose its
  // queue).

  const FLUSH_TIMEOUT_MS = 3_000;

  const flushWithTimeout = async (label: string, fn: () => Promise<void>) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${label} flush timed out after ${FLUSH_TIMEOUT_MS}ms`)),
            FLUSH_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      logger.warn?.(
        `[otel] ${label} flush warning: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const flush = async () => {
    const flushableTracerProvider =
      tracerProvider ?? preloadedTracerProvider;
    await Promise.all([
      flushableTracerProvider
        ? flushWithTimeout("trace", () => flushableTracerProvider.forceFlush())
        : Promise.resolve(),
      meterProvider
        ? flushWithTimeout("metric", () =>
            meterProvider.forceFlush({ timeoutMillis: FLUSH_TIMEOUT_MS }),
          )
        : Promise.resolve(),
    ]);
  };

  (globalThis as any)[Symbol.for("openclaw.otel.preExit")] = flush;

  // ── Shutdown (destructive — process exit only) ─────────────────

  let shutdownPromise: Promise<void> | null = null;

  const shutdown = async () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info("[otel] Shutting down telemetry...");
      clearInterval(metricHeartbeatInterval);
      (globalThis as any)[Symbol.for("openclaw.otel.preExit")] = undefined;
      try {
        const results = await Promise.allSettled([
          tracerProvider ? tracerProvider.shutdown() : Promise.resolve(),
          meterProvider ? meterProvider.shutdown() : Promise.resolve(),
        ]);
        for (const result of results) {
          if (result.status === "rejected") {
            const err = result.reason;
            logger.error(`[otel] Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } finally {
        initializedRuntime = null;
        tracerProviderRef = null;
      }
    })();
    return shutdownPromise;
  };

  const runtime: TelemetryRuntime = { tracer, meter, counters, histograms, gauges, shutdown, flush };
  initializedRuntime = runtime;
  return runtime;
}
