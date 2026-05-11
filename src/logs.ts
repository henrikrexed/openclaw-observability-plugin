import { SeverityNumber, logs, type AnyValue, type AnyValueMap } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as OTLPLogExporterGRPC } from "@opentelemetry/exporter-logs-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { context } from "@opentelemetry/api";

import type { OtelObservabilityConfig } from "./config.js";
import type { TelemetryRuntime } from "./telemetry.js";
import {
  CODE_FILE_PATH,
  CODE_FUNCTION_NAME,
  CODE_LINE_NUMBER,
  OC_SCHEMA_VERSION,
  OPENCLAW_SCHEMA_VERSION,
  OTEL_SCHEMA_URL,
} from "./semconv.js";
import { redactSensitiveText } from "./security.js";
import { PLUGIN_VERSION } from "./version.js";

type LogEvent = {
  type?: string;
  level?: string;
  message?: string;
  body?: string;
  logger?: string;
  function?: string;
  file?: string;
  line?: number;
  sessionKey?: string;
  agentId?: string;
  timestamp?: number;
  [key: string]: unknown;
};

export interface LogFilterRule {
  field: "logger" | "message" | "level" | "type";
  pattern: string | RegExp;
  action: "exclude" | "include";
}

export interface LogPipelineConfig {
  enabled: boolean;
  filters: LogFilterRule[];
  excludeLevels: string[];
  excludeLoggers: string[];
  excludeMessagePatterns: (string | RegExp)[];
}

interface LogPipelineRuntime {
  loggerProvider: LoggerProvider;
  emit(logEvent: LogEvent, sessionKey?: string): void;
  shutdown(): Promise<void>;
}

const SEVERITY_MAP: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  warning: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

function resolveSeverity(level?: string): SeverityNumber {
  if (!level) return SeverityNumber.INFO;
  return SEVERITY_MAP[level.toLowerCase()] ?? SeverityNumber.INFO;
}

export function matchesPattern(value: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
  return pattern.test(value);
}

export function shouldExclude(
  evt: LogEvent,
  config: LogPipelineConfig
): boolean {
  if (config.excludeLevels.length > 0) {
    const lvl = (evt.level || "").toLowerCase();
    if (config.excludeLevels.includes(lvl)) return true;
  }

  if (config.excludeLoggers.length > 0) {
    const logger = (evt.logger || "").toLowerCase();
    for (const exc of config.excludeLoggers) {
      if (logger.includes(exc.toLowerCase())) return true;
    }
  }

  if (config.excludeMessagePatterns.length > 0) {
    const msg = evt.message || evt.body || "";
    for (const pat of config.excludeMessagePatterns) {
      if (matchesPattern(msg, pat)) return true;
    }
  }

  for (const rule of config.filters) {
    const value = (() => {
      switch (rule.field) {
        case "logger": return evt.logger || "";
        case "message": return evt.message || evt.body || "";
        case "level": return evt.level || "";
        case "type": return evt.type || "";
      }
    })();
    if (matchesPattern(value, rule.pattern)) {
      return rule.action === "exclude";
    }
  }

  return false;
}

export function parseLogConfig(raw: unknown): LogPipelineConfig {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const excludeLevels: string[] = Array.isArray(obj.excludeLevels)
    ? obj.excludeLevels.filter((v: unknown) => typeof v === "string").map((v: string) => v.toLowerCase())
    : [];

  const excludeLoggers: string[] = Array.isArray(obj.excludeLoggers)
    ? obj.excludeLoggers.filter((v: unknown) => typeof v === "string").map((v: string) => v.toLowerCase())
    : [];

  const excludeMessagePatterns: (string | RegExp)[] = Array.isArray(obj.excludeMessagePatterns)
    ? obj.excludeMessagePatterns.map((v: unknown) => {
        if (typeof v === "string") return v;
        if (v instanceof RegExp) return v;
        return String(v);
      })
    : [];

  const filters: LogFilterRule[] = Array.isArray(obj.filters)
    ? obj.filters.filter((r: unknown) => {
        if (!r || typeof r !== "object") return false;
        const rule = r as Record<string, unknown>;
        return (
          typeof rule.field === "string" &&
          ["logger", "message", "level", "type"].includes(rule.field) &&
          (typeof rule.pattern === "string" || rule.pattern instanceof RegExp) &&
          typeof rule.action === "string" &&
          ["exclude", "include"].includes(rule.action)
        );
      }) as LogFilterRule[]
    : [];

  return {
    enabled: obj.enabled !== false,
    filters,
    excludeLevels,
    excludeLoggers,
    excludeMessagePatterns,
  };
}

/**
 * Build the AnyValueMap of LogRecord attributes from a LogEvent.
 *
 * Exported for unit tests (ISI-995). Runtime callers go through `emit()`
 * inside `initLogPipeline`, which then redacts the body and forwards the
 * active context to the LogRecord — so the OTLP-native trace_id /
 * span_id / trace_flags travel with the record without needing a
 * duplicate `openclaw.log.trace_id` attribute set.
 *
 * Per ISI-995, this helper emits OTel-stable `code.function.name`,
 * `code.file.path`, and `code.line.number` for the emit site instead of
 * the legacy `openclaw.log.function|file|line` triplet.
 */
export function buildLogAttributes(
  evt: LogEvent,
  sessionKey?: string,
): AnyValueMap {
  const attributes: AnyValueMap = {};

  if (evt.logger) attributes["openclaw.log.logger"] = evt.logger;
  if (evt.function) attributes[CODE_FUNCTION_NAME] = evt.function;
  if (evt.file) attributes[CODE_FILE_PATH] = evt.file;
  if (typeof evt.line === "number") attributes[CODE_LINE_NUMBER] = evt.line;
  if (evt.type) attributes["openclaw.log.type"] = evt.type;
  if (evt.sessionKey || sessionKey) {
    attributes["openclaw.session.key"] = evt.sessionKey || sessionKey;
  }
  if (evt.agentId) attributes["openclaw.agent.id"] = evt.agentId;

  for (const [k, v] of Object.entries(evt)) {
    if (
      k !== "type" && k !== "level" && k !== "message" && k !== "body" &&
      k !== "logger" && k !== "function" && k !== "file" && k !== "line" &&
      k !== "sessionKey" && k !== "agentId" && k !== "timestamp"
    ) {
      attributes[`openclaw.log.extra.${k}`] = toAnyValue(v);
    }
  }

  return attributes;
}

// Exported for unit tests — see tests/logs.test.ts. Runtime callers should
// keep going through emit(), which already routes string bodies/attrs
// through redaction before this helper runs.
export function toAnyValue(value: unknown): AnyValue {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toAnyValue(entry));
  }
  if (typeof value === "object") {
    const map: AnyValueMap = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      map[key] = toAnyValue(entry);
    }
    return map;
  }
  return redactSensitiveText(String(value));
}

export function initLogPipeline(
  config: OtelObservabilityConfig,
  logger: any
): LogPipelineRuntime | null {
  if (!config.logs) {
    logger.info("[otel-logs] Log export disabled in config");
    return null;
  }

  const logConfig = parseLogConfig(config.logConfig);

  const logEndpoint =
    config.protocol === "http"
      ? `${config.endpoint}/v1/logs`
      : config.endpoint;

  const logExporter =
    config.protocol === "grpc"
      ? new OTLPLogExporterGRPC({ url: logEndpoint, headers: config.headers })
      : new OTLPLogExporterHTTP({ url: logEndpoint, headers: config.headers });

  // ISI-995: mirror the trace/metric Resource — real plugin version from
  // openclaw.plugin.json (not the legacy "0.1.0" placeholder) and an
  // OTel semconv schema URL so backends can resolve attribute names.
  const resource = resourceFromAttributes(
    {
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: PLUGIN_VERSION,
      "openclaw.plugin": "otel-observability",
      [OC_SCHEMA_VERSION]: OPENCLAW_SCHEMA_VERSION,
      ...config.resourceAttributes,
    },
    { schemaUrl: OTEL_SCHEMA_URL },
  );

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
      }),
    ],
  });

  logs.setGlobalLoggerProvider(loggerProvider);

  // ISI-995: instrumentation-scope version tracks the real plugin version
  // emitted on the Resource so the scope.version field on every LogRecord
  // matches the release.
  const otelLogger = loggerProvider.getLogger("openclaw-observability", PLUGIN_VERSION);

  const emit = (evt: LogEvent, sessionKey?: string) => {
    try {
      if (shouldExclude(evt, logConfig)) return;

      const severityNumber = resolveSeverity(evt.level);
      const severityText = (evt.level || "info").toUpperCase();

      const attributes = buildLogAttributes(evt, sessionKey);

      // ISI-995: pass the active context into emit() so the LogRecord
      // itself carries trace_id / span_id / trace_flags via the
      // OTLP-native fields. Setting them as duplicate attributes
      // (openclaw.log.trace_id etc.) was double-recording the same
      // semantics and confused log-pipeline filters that already key on
      // the OTLP LogRecord trace context.
      const logContext = context.active();

      const timestamp = evt.timestamp || Date.now();

      // Redact the body before emit. Log bodies can carry copy-pasted
      // tokens, emails, or auth headers; the OTLP exporter will ship
      // them straight to the backend otherwise.
      const rawBody = evt.message || evt.body || "";
      const body = typeof rawBody === "string" ? redactSensitiveText(rawBody) : rawBody;

      otelLogger.emit({
        severityNumber,
        severityText,
        body,
        attributes,
        timestamp: typeof timestamp === "number" ? timestamp * 1_000_000 : timestamp,
        observedTimestamp: Date.now() * 1_000_000,
        context: logContext,
      });
    } catch {
      // Never let log emission errors affect the gateway
    }
  };

  logger.info(`[otel-logs] Log exporter → ${logEndpoint} (${config.protocol})`);

  return {
    loggerProvider,
    emit,
    shutdown: async () => {
      try {
        await loggerProvider.shutdown();
        logger.info("[otel-logs] Logger provider shut down");
      } catch (err) {
        logger.error(`[otel-logs] Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/**
 * Bridge a gateway-style logger to the OTel log pipeline by wrapping its
 * level methods in place. Every wrapped call still forwards to the original
 * logger; in addition, the call is emitted as an OTel LogRecord via `emit`.
 *
 * Wrapping in place is intentional — other code in the plugin (telemetry,
 * hooks) already captured a reference to `baseLogger` and will pick up the
 * bridge automatically. Returns a restore function that puts the original
 * methods back; call it during plugin shutdown before draining the pipeline.
 *
 * Supports both string-first (`logger.info("msg")`) and object-first
 * (`logger.info({ ...attrs }, "msg")` — pino-style) call shapes. Bridge
 * failures are swallowed so a misbehaving exporter cannot break gateway
 * logging.
 */
export function bridgeGatewayLogger(
  baseLogger: any,
  emit: (evt: LogEvent) => void
): () => void {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
  const originals: Record<string, ((...args: unknown[]) => unknown) | undefined> = {};

  for (const lvl of levels) {
    const orig = baseLogger?.[lvl];
    if (typeof orig !== "function") continue;
    // Idempotency: if a previous bridge call already wrapped this method,
    // skip it. Otherwise we'd capture the wrapper as the "original" and the
    // returned restore() would reinstall the wrapper instead of the truly-
    // original method.
    if ((orig as { __otelBridged?: boolean }).__otelBridged) continue;
    originals[lvl] = orig;
    const bridged = function (...args: unknown[]) {
      try {
        const evt = buildLogEvent(lvl, args);
        emit(evt);
      } catch {
        // Bridge failure must never break the gateway logger.
      }
      return (originals[lvl] as (...a: unknown[]) => unknown).apply(
        baseLogger,
        args
      );
    };
    (bridged as { __otelBridged?: boolean }).__otelBridged = true;
    baseLogger[lvl] = bridged;
  }

  return () => {
    for (const lvl of levels) {
      if (originals[lvl]) {
        baseLogger[lvl] = originals[lvl];
      }
    }
  };
}

function buildLogEvent(level: string, args: unknown[]): LogEvent {
  if (args.length === 0) {
    return { level, message: "", logger: "openclaw-gateway", timestamp: Date.now() };
  }
  const first = args[0];
  if (typeof first === "string") {
    const message =
      args.length === 1
        ? first
        : first + " " + args.slice(1).map(stringifyArg).join(" ");
    return { level, message, logger: "openclaw-gateway", timestamp: Date.now() };
  }
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const attrs = { ...(first as Record<string, unknown>) };
    const message =
      typeof args[1] === "string" ? args[1] : stringifyArg(first);
    // Spread attrs FIRST so reserved structural fields (level, message,
    // logger, timestamp) below override anything a caller passed in. The
    // downstream emit() picks these by name and a non-numeric timestamp
    // would break the `* 1_000_000` math and silently drop the log.
    return {
      ...attrs,
      level,
      message,
      logger: "openclaw-gateway",
      timestamp: Date.now(),
    };
  }
  return {
    level,
    message: args.map(stringifyArg).join(" "),
    logger: "openclaw-gateway",
    timestamp: Date.now(),
  };
}

function stringifyArg(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type { LogPipelineRuntime, LogEvent };
