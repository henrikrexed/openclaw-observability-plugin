import { SeverityNumber, logs, type AnyValue, type AnyValueMap } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as OTLPLogExporterGRPC } from "@opentelemetry/exporter-logs-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { trace, context } from "@opentelemetry/api";

import type { OtelObservabilityConfig } from "./config.js";
import type { TelemetryRuntime } from "./telemetry.js";
import { OC_SCHEMA_VERSION, OPENCLAW_SCHEMA_VERSION } from "./semconv.js";

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

function toAnyValue(value: unknown): AnyValue {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
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
  return String(value);
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

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: "0.1.0",
    "openclaw.plugin": "otel-observability",
    [OC_SCHEMA_VERSION]: OPENCLAW_SCHEMA_VERSION,
    ...config.resourceAttributes,
  });

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

  const otelLogger = loggerProvider.getLogger("openclaw-observability", "0.1.0");

  const emit = (evt: LogEvent, sessionKey?: string) => {
    try {
      if (shouldExclude(evt, logConfig)) return;

      const severityNumber = resolveSeverity(evt.level);
      const severityText = (evt.level || "info").toUpperCase();

      const attributes: AnyValueMap = {};

      if (evt.logger) attributes["openclaw.log.logger"] = evt.logger;
      if (evt.function) attributes["openclaw.log.function"] = evt.function;
      if (evt.file) attributes["openclaw.log.file"] = evt.file;
      if (typeof evt.line === "number") attributes["openclaw.log.line"] = evt.line;
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

      const activeCtx = context.active();
      const activeSpan = trace.getSpan(activeCtx);
      let logContext = activeCtx;

      if (activeSpan) {
        attributes["openclaw.log.trace_id"] = activeSpan.spanContext().traceId;
        attributes["openclaw.log.span_id"] = activeSpan.spanContext().spanId;
        attributes["openclaw.log.trace_flags"] = activeSpan.spanContext().traceFlags;
      }

      const timestamp = evt.timestamp || Date.now();

      otelLogger.emit({
        severityNumber,
        severityText,
        body: evt.message || evt.body || "",
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

export type { LogPipelineRuntime, LogEvent };
