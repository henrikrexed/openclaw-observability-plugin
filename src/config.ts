/**
 * Configuration types and defaults for the OTel Observability plugin.
 */

/**
 * Granular content capture policy. Each flag toggles capture of one
 * category of content attribute on hook-surface spans:
 *
 *   - inputMessages  → inbound user message / prompt content
 *                      (`openclaw.content.input_message`,
 *                       `openclaw.content.messages`)
 *   - outputMessages → outbound assistant reply content
 *                      (`openclaw.content.output_message`)
 *   - toolInputs     → tool-call input arguments
 *                      (`openclaw.content.tool_input`)
 *   - toolOutputs    → tool-call result text
 *                      (`openclaw.content.tool_output`)
 *   - systemPrompt   → system prompt text
 *                      (`openclaw.content.system_prompt`)
 *
 * For backwards compatibility the plugin still accepts a single
 * `captureContent: boolean` — `true` turns every flag on, `false` turns
 * every flag off. Values not listed above are coerced to `false`.
 *
 * The legacy Traceloop `traceContent` bridging (used by
 * `instrumentation/preload.mjs`) is enabled whenever **any** of
 * `inputMessages`, `outputMessages`, or `systemPrompt` is true — those
 * are the categories that map to LLM-client prompt/completion text.
 */
export interface ContentCapturePolicy {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
}

export type ContentCaptureInput = boolean | Partial<ContentCapturePolicy>;

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
  /**
   * Per-category content-capture policy. Always normalized to a fully
   * populated `ContentCapturePolicy` regardless of input form.
   */
  captureContent: ContentCapturePolicy;
  /** Metrics export interval in milliseconds */
  metricsIntervalMs: number;
  /** Additional OTel resource attributes */
  resourceAttributes: Record<string, string>;
  /** Optional log pipeline filtering configuration */
  logConfig?: Record<string, unknown>;
}

export const CONTENT_POLICY_DISABLED: ContentCapturePolicy = Object.freeze({
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
});

export const CONTENT_POLICY_ENABLED: ContentCapturePolicy = Object.freeze({
  inputMessages: true,
  outputMessages: true,
  toolInputs: true,
  toolOutputs: true,
  systemPrompt: true,
});

const DEFAULTS: OtelObservabilityConfig = {
  endpoint: "http://localhost:4318",
  protocol: "http",
  serviceName: "openclaw-gateway",
  headers: {},
  traces: true,
  metrics: true,
  logs: true,
  captureContent: { ...CONTENT_POLICY_DISABLED },
  metricsIntervalMs: 30_000,
  resourceAttributes: {},
};

/**
 * Normalize the loose `captureContent` input to a fully populated
 * `ContentCapturePolicy`. Accepts:
 *   - `true`              → all flags on
 *   - `false` / undefined → all flags off
 *   - object              → field-by-field merge over the disabled baseline
 *
 * Unknown keys are ignored. Non-boolean field values are coerced to
 * `false` so the resulting policy is always deterministic.
 */
export function normalizeContentCapturePolicy(
  input: unknown,
): ContentCapturePolicy {
  if (input === true) {
    return { ...CONTENT_POLICY_ENABLED };
  }
  if (input === false || input === undefined || input === null) {
    return { ...CONTENT_POLICY_DISABLED };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ...CONTENT_POLICY_DISABLED };
  }

  const obj = input as Record<string, unknown>;
  const policy: ContentCapturePolicy = { ...CONTENT_POLICY_DISABLED };
  for (const key of Object.keys(CONTENT_POLICY_DISABLED) as Array<
    keyof ContentCapturePolicy
  >) {
    if (key in obj) {
      policy[key] = obj[key] === true;
    }
  }
  return policy;
}

/**
 * True when the policy enables any LLM-client prompt/completion capture
 * (inputMessages, outputMessages, or systemPrompt). Used to derive the
 * legacy single-boolean `OPENCLAW_OTEL_CAPTURE_CONTENT` env var that
 * Traceloop's `traceContent` flag consumes at preload time.
 */
export function policyEnablesLlmContent(
  policy: ContentCapturePolicy,
): boolean {
  return (
    policy.inputMessages || policy.outputMessages || policy.systemPrompt
  );
}

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
    captureContent: normalizeContentCapturePolicy(obj.captureContent),
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
    logConfig:
      obj.logConfig &&
      typeof obj.logConfig === "object" &&
      !Array.isArray(obj.logConfig)
        ? (obj.logConfig as Record<string, unknown>)
        : undefined,
  };
}
