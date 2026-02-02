/**
 * Configuration types and defaults for the OTel Observability plugin.
 */

export interface OtelObservabilityConfig {
  /** OTLP endpoint URL */
  endpoint: string;
  /** OTLP export protocol: 'http' (OTLP/HTTP) or 'grpc' (OTLP/gRPC) */
  protocol: "http" | "grpc";
  /** OpenTelemetry service name */
  serviceName: string;
  /** Custom headers for OTLP export (e.g., Authorization for Dynatrace) */
  headers: Record<string, string>;
  /** Enable trace export */
  traces: boolean;
  /** Enable metrics export */
  metrics: boolean;
  /** Enable log export */
  logs: boolean;
  /** Capture prompt/completion content in spans (disable for privacy) */
  captureContent: boolean;
  /** Metrics export interval in milliseconds */
  metricsIntervalMs: number;
  /** Additional OTel resource attributes */
  resourceAttributes: Record<string, string>;
}

const DEFAULTS: OtelObservabilityConfig = {
  endpoint: "http://localhost:4318",
  protocol: "http",
  serviceName: "openclaw-gateway",
  headers: {},
  traces: true,
  metrics: true,
  logs: true,
  captureContent: false,
  metricsIntervalMs: 30_000,
  resourceAttributes: {},
};

export function parseConfig(raw: unknown): OtelObservabilityConfig {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    endpoint: typeof obj.endpoint === "string" ? obj.endpoint : DEFAULTS.endpoint,
    protocol: obj.protocol === "grpc" ? "grpc" : DEFAULTS.protocol,
    serviceName:
      typeof obj.serviceName === "string" ? obj.serviceName : DEFAULTS.serviceName,
    headers:
      obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)
        ? (obj.headers as Record<string, string>)
        : DEFAULTS.headers,
    traces: typeof obj.traces === "boolean" ? obj.traces : DEFAULTS.traces,
    metrics: typeof obj.metrics === "boolean" ? obj.metrics : DEFAULTS.metrics,
    logs: typeof obj.logs === "boolean" ? obj.logs : DEFAULTS.logs,
    captureContent:
      typeof obj.captureContent === "boolean" ? obj.captureContent : DEFAULTS.captureContent,
    metricsIntervalMs:
      typeof obj.metricsIntervalMs === "number" && obj.metricsIntervalMs >= 1000
        ? obj.metricsIntervalMs
        : DEFAULTS.metricsIntervalMs,
    resourceAttributes:
      obj.resourceAttributes &&
      typeof obj.resourceAttributes === "object" &&
      !Array.isArray(obj.resourceAttributes)
        ? (obj.resourceAttributes as Record<string, string>)
        : DEFAULTS.resourceAttributes,
  };
}
