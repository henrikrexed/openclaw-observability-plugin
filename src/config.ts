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
 *   - toolOutputs        → tool-call result text
 *                          (`openclaw.content.tool_output`)
 *   - toolErrorMessages  → bounded, redacted error text from failed tool calls
 *                          (`openclaw.tool.error_preview`); defaults to true
 *                          even when other flags are off because error messages
 *                          are operational data, not full content capture.
 *                          Set to false to suppress entirely.
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
  toolErrorMessages: boolean;
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
  /**
   * Trace sampling rate from 0.0 (drop all) to 1.0 (keep all).
   *
   * When undefined, the plugin does NOT register a sampler and the SDK
   * default (`parentbased_always_on`) takes over. When set, the plugin
   * wires `ParentBasedSampler(TraceIdRatioBasedSampler(sampleRate))` so
   * child spans honor the root sampling decision (head-based sampling).
   *
   * NOTE: an explicit `sampleRate` here OVERRIDES the standard
   * `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` env vars — the
   * plugin builds the sampler directly and never reads them. Operators
   * coming from other OTel SDKs should set `sampleRate` in plugin
   * config rather than rely on env vars. Omit `sampleRate` to let the
   * SDK default (`parentbased_always_on`) apply; the env vars still
   * have no effect because the SDK builds its own default sampler.
   */
  sampleRate?: number;
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
  toolErrorMessages: false,
  systemPrompt: false,
});

export const CONTENT_POLICY_ENABLED: ContentCapturePolicy = Object.freeze({
  inputMessages: true,
  outputMessages: true,
  toolInputs: true,
  toolOutputs: true,
  toolErrorMessages: true,
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
  // toolErrorMessages defaults to true (operational data, different privacy
  // class from full content capture) unless the caller explicitly sets it.
  const policy: ContentCapturePolicy = { ...CONTENT_POLICY_DISABLED, toolErrorMessages: true };
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
  // `Boolean(...)` keeps the return strictly `true` / `false` even if a
  // caller passes a hand-built policy whose field types have drifted from
  // the declared `boolean` (e.g. through a loose API or a JSON round-trip
  // that left `undefined`s in place).
  return Boolean(
    policy.inputMessages || policy.outputMessages || policy.systemPrompt,
  );
}

/**
 * Minimal logger shape used by `parseConfig` for diagnostic warnings.
 * Matches the OpenClaw gateway logger surface (and pino-style loggers)
 * without coupling to a concrete type.
 */
export interface ParseConfigLogger {
  warn: (msg: string) => void;
}

function parseSampleRate(
  obj: Record<string, unknown>,
  logger: ParseConfigLogger | undefined,
): number | undefined {
  if (!("sampleRate" in obj)) return undefined;

  const raw = obj.sampleRate;
  if (
    typeof raw === "number" &&
    Number.isFinite(raw) &&
    raw >= 0 &&
    raw <= 1
  ) {
    return raw;
  }

  // Anything else falls through to the SDK default. Surface a diagnostic
  // so silent typos like `"sampleRate": "0.5"` (string) or `1.5`
  // (out-of-range) don't quietly disable head-based sampling.
  if (logger) {
    let display: string;
    try {
      display = typeof raw === "string" ? JSON.stringify(raw) : String(raw);
    } catch {
      display = "<unserializable>";
    }
    logger.warn(
      `[otel] Ignoring invalid sampleRate=${display} (typeof=${typeof raw}); ` +
        `expected a finite number in [0, 1]. Falling back to SDK default ` +
        `(parentbased_always_on).`,
    );
  }
  return undefined;
}

export function parseConfig(
  raw: unknown,
  logger?: ParseConfigLogger,
): OtelObservabilityConfig {
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
    sampleRate: parseSampleRate(obj, logger),
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
