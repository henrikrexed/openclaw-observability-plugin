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

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter as OTLPTraceExporterHTTP } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as OTLPTraceExporterGRPC } from "@opentelemetry/exporter-trace-otlp-grpc";

import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc";

import type { OtelObservabilityConfig } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────

export interface TelemetryRuntime {
  tracer: Tracer;
  meter: Meter;
  counters: OtelCounters;
  histograms: OtelHistograms;
  gauges: OtelGauges;
  shutdown: () => Promise<void>;
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
}

export interface OtelHistograms {
  /** LLM request duration in ms */
  llmDuration: Histogram;
  /** Tool execution duration in ms */
  toolDuration: Histogram;
  /** Agent turn duration in ms */
  agentTurnDuration: Histogram;
}

export interface OtelGauges {
  /** Currently active sessions */
  activeSessions: UpDownCounter;
}

// ── Init ────────────────────────────────────────────────────────────

export function initTelemetry(config: OtelObservabilityConfig, logger: any): TelemetryRuntime {
  const resourceAttrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
    "openclaw.plugin": "otel-observability",
    ...config.resourceAttributes,
  };

  const resource = resourceFromAttributes(resourceAttrs);

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

  if (config.traces) {
    const traceExporter =
      config.protocol === "grpc"
        ? new OTLPTraceExporterGRPC({ url: traceEndpoint, headers: config.headers })
        : new OTLPTraceExporterHTTP({ url: traceEndpoint, headers: config.headers });

    // SDK v2: pass spanProcessors in constructor (addSpanProcessor was removed)
    tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    tracerProvider.register();

    logger.info(`[otel] Trace exporter → ${traceEndpoint} (${config.protocol})`);
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

  const tracer = trace.getTracer("openclaw-observability", "0.1.0");
  const meter = metrics.getMeter("openclaw-observability", "0.1.0");

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
  };

  const histograms: OtelHistograms = {
    llmDuration: meter.createHistogram("openclaw.llm.duration", {
      description: "LLM request duration",
      unit: "ms",
    }),
    toolDuration: meter.createHistogram("openclaw.tool.duration", {
      description: "Tool execution duration",
      unit: "ms",
    }),
    agentTurnDuration: meter.createHistogram("openclaw.agent.turn_duration", {
      description: "Full agent turn duration (LLM + tools)",
      unit: "ms",
    }),
  };

  const gauges: OtelGauges = {
    activeSessions: meter.createUpDownCounter("openclaw.sessions.active", {
      description: "Currently active sessions",
      unit: "sessions",
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

  // ── Shutdown ────────────────────────────────────────────────────

  const shutdown = async () => {
    logger.info("[otel] Shutting down telemetry...");
    clearInterval(metricHeartbeatInterval);
    try {
      if (tracerProvider) await tracerProvider.shutdown();
      if (meterProvider) await meterProvider.shutdown();
    } catch (err) {
      logger.error(`[otel] Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { tracer, meter, counters, histograms, gauges, shutdown };
}
