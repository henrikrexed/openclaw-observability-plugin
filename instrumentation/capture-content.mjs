/**
 * Resolve the Traceloop `traceContent` flag from the environment.
 *
 * Two environment variables are honored — the new granular policy takes
 * precedence over the legacy single-boolean:
 *
 *   - `OPENCLAW_OTEL_CONTENT_POLICY`  (ISI-1000, preferred)
 *       JSON object matching `ContentCapturePolicy`. Traceloop's
 *       `traceContent` is derived as
 *         `inputMessages || outputMessages || systemPrompt`
 *       (the three categories that map to LLM-client prompt/completion
 *       text). `toolInputs`/`toolOutputs` are captured on the plugin's
 *       own hook-surface spans, not Traceloop's.
 *
 *   - `OPENCLAW_OTEL_CAPTURE_CONTENT` (legacy)
 *       Strict string `'true'` enables Traceloop content capture.
 *       Any other value (including `'1'`, `'True'`, `'yes'`, unset)
 *       resolves to `false`.
 *
 * Because the preload runs *before* the plugin's `start()` phase
 * (NODE_OPTIONS=--import loads it before anything else), these values
 * must be bridged via env vars set by whatever launches the gateway.
 */
export function resolveCaptureContent(env = process.env) {
  const policy = parseContentPolicyEnv(env[CONTENT_POLICY_ENV]);
  if (policy) {
    return Boolean(
      policy.inputMessages || policy.outputMessages || policy.systemPrompt,
    );
  }
  return env[CAPTURE_CONTENT_ENV] === "true";
}

/**
 * Parse `OPENCLAW_OTEL_CONTENT_POLICY` as JSON. Returns the parsed
 * object on success, or `undefined` if the env var is unset, empty, or
 * malformed. Errors are swallowed silently to keep the preload from
 * crashing the gateway on operator misconfiguration.
 */
export function parseContentPolicyEnv(raw) {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed JSON; preload falls back to the legacy flag.
  }
  return undefined;
}

export const CAPTURE_CONTENT_ENV = "OPENCLAW_OTEL_CAPTURE_CONTENT";
export const CONTENT_POLICY_ENV = "OPENCLAW_OTEL_CONTENT_POLICY";
