/**
 * OpenClaw event hooks — captures tool executions, agent turns, messages,
 * and gateway lifecycle as connected OTel traces.
 *
 * Trace structure per request:
 *   openclaw.request (root span, covers full message → reply lifecycle)
 *   ├── openclaw.agent.turn (agent processing span)
 *   │   ├── openclaw.dispatch.prepare
 *   │   ├── chat {model} (model call span, GenAI semconv)
 *   │   ├── execute_tool Read (tool span)
 *   │   ├── execute_tool Write (tool span)
 *   │   └── execute_tool Bash (tool span)
 *   └── openclaw.message.sent
 *
 * Context propagation:
 *   - message_received:     creates root span, stores in TraceContextStore
 *   - before_model_resolve: creates child "agent turn" span under root
 *                           (fires earliest in the agent run, model not yet
 *                           resolved — model attrs are populated later)
 *   - before_prompt_build:  enriches the agent turn span with prompt length
 *                           and session history size once messages are loaded
 *   - tool_result_persist:  creates child tool span under agent turn
 *   - agent_end:            ends the agent turn + root spans
 *
 * Hook migration note (ISI-730):
 *   OpenClaw 2026.4.21+ treats `before_agent_start` as a legacy compatibility
 *   hook and recommends `before_model_resolve` / `before_prompt_build` for
 *   new work. This plugin is fully migrated — it no longer registers
 *   `before_agent_start`. Minimum OpenClaw runtime is therefore 2026.4.21.
 *
 * IMPORTANT: OpenClaw has TWO hook registration systems:
 *   - api.registerHook() → event-stream hooks (command:new, gateway:startup)
 *   - api.on()           → typed plugin hooks (tool_result_persist, agent_end)
 */

import { SpanKind, SpanStatusCode, context, trace, type Span, type Context } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { ContentCapturePolicy, OtelObservabilityConfig } from "./config.js";
import { activeAgentSpans, getPendingUsage, enrichSpanWithUsage, hasDiagnosticsSupport } from "./diagnostics.js";
import {
  checkToolSecurity,
  checkMessageSecurity,
  redactSensitiveText,
  setRedactedAttribute,
  type SecurityCounters,
} from "./security.js";
import { TraceContextStore } from "./trace-context-store.js";
import {
  GEN_AI_AGENT_ID,
  GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_STREAM,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  GEN_AI_TOKEN_TYPE,
  GEN_AI_TOOL_CALL_ID,
  GEN_AI_TOOL_NAME,
  OPENCLAW_TOOL_APPROVAL_REQUESTED,
  OPENCLAW_TOOL_APPROVAL_RESOLUTION,
  OPENCLAW_TOOL_APPROVAL_DURATION_MS,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_TOKENS,
  GEN_AI_USAGE_CACHE_WRITE_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
  CODE_FUNCTION,
  CODE_NAMESPACE,
  CODE_FUNCTION_NAME,
  CODE_FILE_PATH,
  ERROR_TYPE,
  spanNameExecuteTool,
  spanNameChat,
  OC_SUBAGENT_PARENT_SESSION,
  OC_SUBAGENT_CHILD_SESSION,
  OC_SUBAGENT_CHILD_AGENT_ID,
  OC_SUBAGENT_CHILD_AGENT_NAME,
  OC_SUBAGENT_SPAWN_REASON,
  OC_SUBAGENT_DELIVERY_TYPE,
  OC_SUBAGENT_SUCCESS,
  OC_SUBAGENT_DURATION_MS,
  OC_CRON_JOB_NAME,
  OC_CRON_ACTION,
  OC_CRON_TRIGGER,
  OC_CRON_EXPRESSION,
  OC_CRON_DURATION_MS,
  OC_CRON_SUCCESS,
  OC_CRON_AGENT_ID,
} from "./semconv.js";

const CODE_NS = "openclaw.otel.hooks";
const CODE_FILE = "src/hooks.ts";

/**
 * Dual-emits legacy (`code.function` / `code.namespace`) and stable
 * (`code.function.name` / `code.file.path`) attributes for a hook span.
 * Spread the result into the span `attributes` block.
 *
 * `filePath` defaults to this module's `CODE_FILE`; callers from other
 * modules MUST pass their own path so `code.file.path` does not lie.
 *
 * Centralised so the deprecation window can be closed in one place
 * (schema `1.3.0`) by dropping the legacy keys from this helper.
 */
function codeAttrs(funcName: string, filePath: string = CODE_FILE): Record<string, string> {
  return {
    [CODE_FUNCTION]: funcName,
    [CODE_NAMESPACE]: CODE_NS,
    [CODE_FUNCTION_NAME]: `${CODE_NS}.${funcName}`,
    [CODE_FILE_PATH]: filePath,
  };
}

const store = new TraceContextStore();

/**
 * Register all plugin hooks on the OpenClaw plugin API.
 *
 * Hooks are registered during the synchronous `register()` phase using a
 * **lazy telemetry getter** instead of a concrete runtime. This decouples
 * hook registration from telemetry initialization — hooks can be wired
 * before `initTelemetry()` runs in `start()`. Each handler calls
 * `getTelemetry()` at fire time and gracefully no-ops when telemetry is
 * null (e.g., between `register()` and `start()`, or in embedded runner
 * contexts where `service.start()` is a no-op).
 */
export function registerHooks(
  api: any,
  getTelemetry: () => TelemetryRuntime | null,
  config: OtelObservabilityConfig
): () => void {
  const logger = api.logger;

  function buildSecurityCounters(tel: TelemetryRuntime): SecurityCounters {
    return {
      securityEvents: tel.counters.securityEvents,
      sensitiveFileAccess: tel.counters.sensitiveFileAccess,
      promptInjection: tel.counters.promptInjection,
      dangerousCommand: tel.counters.dangerousCommand,
    };
  }

  function setToolInputPreview(span: any, toolInput: any): void {
    if (toolInput && typeof toolInput === "object") {
      // Redact BEFORE truncating: slicing at 1000 chars can split a secret
      // below the redaction regex's minimum-match length, leaving a
      // plaintext token prefix in the preview. Running redactSensitiveText
      // on the full JSON first guarantees the cut point lands on already-
      // sanitized text. setRedactedAttribute is idempotent, so routing
      // through it preserves the funnel invariant.
      const redacted = redactSensitiveText(JSON.stringify(toolInput));
      const preview = redacted.slice(0, 1000);
      setRedactedAttribute(span, "openclaw.tool.input_preview", preview);
    }
  }

  // ── Granular content capture (ISI-1000) ──────────────────────────
  // `config.captureContent` is normalized to a fully populated
  // `ContentCapturePolicy` in `parseConfig`. Each `openclaw.content.*`
  // attribute is gated by exactly one policy flag; default policy is
  // all-off, preserving the legacy `captureContent: false` behavior.
  //
  // Capture size is capped per attribute to keep span payloads bounded.
  // The cap is measured in UTF-16 code units (JS string `.length`), not
  // bytes — operators should size their OTLP payload budgets with CJK /
  // emoji content in mind (one code point can be 2–4 bytes in UTF-8).
  // Operators who enable content capture accept the privacy implications
  // documented in `docs/security/privacy.md`.
  const contentPolicy: ContentCapturePolicy = config.captureContent;
  const CONTENT_MAX_CHARS = 8192;

  function captureContentAttribute(
    span: any,
    enabled: boolean,
    key: string,
    raw: unknown,
  ): void {
    if (!enabled || !span) return;
    if (raw === undefined || raw === null) return;
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else {
      try {
        text = JSON.stringify(raw);
      } catch {
        return;
      }
    }
    if (!text) return;
    // Redact BEFORE truncating. If a secret straddles the truncation
    // boundary, slicing first can cut the token below the redaction
    // regex's minimum-match length, so setRedactedAttribute would no
    // longer scrub it and a plaintext prefix would ship to OTLP.
    // Redacting the full text first guarantees that anything still
    // visible after truncation has already passed through the
    // SENSITIVE_VALUE_PATTERNS pipeline. redactSensitiveText is
    // idempotent, so the funnel through setRedactedAttribute below is
    // preserved as defense-in-depth.
    text = redactSensitiveText(text);
    if (text.length > CONTENT_MAX_CHARS) {
      // Slicing on a UTF-16 boundary can leave a lone high surrogate
      // (0xD800–0xDBFF) as the last code unit, which is not a valid
      // standalone character. Trim one extra code unit when that
      // happens so the truncated prefix is always well-formed UTF-16.
      let cut = CONTENT_MAX_CHARS;
      const lastCode = text.charCodeAt(cut - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut -= 1;
      const overflow = text.length - cut;
      text = `${text.slice(0, cut)}…(truncated, ${overflow} more chars)`;
    }
    // Route through setRedactedAttribute so this attribute key
    // never bypasses redaction even if a future caller drifts.
    setRedactedAttribute(span, key, text);
  }

  function extractToolOutputText(message: any): string | undefined {
    if (!message) return undefined;
    if (typeof message === "string") return message;
    const contentArray = message?.content;
    if (Array.isArray(contentArray)) {
      const parts = contentArray
        .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text as string);
      if (parts.length > 0) return parts.join("\n");
    }
    if (typeof message?.text === "string") return message.text;
    return undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  // TYPED HOOKS — registered via api.on() into registry.typedHooks
  // ═══════════════════════════════════════════════════════════════════

  // ── message_received ─────────────────────────────────────────────
  // Creates the ROOT span for the entire request lifecycle.
  // All subsequent spans (agent, tools) become children of this span.

  api.on(
    "message_received",
    async (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return;
        const { tracer, counters } = tel;
        const securityCounters = buildSecurityCounters(tel);

        const channel = event?.channel || "unknown";
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const from = event?.from || event?.senderId || "unknown";
        const messageText = event?.text || event?.message || "";

        // Create root span for this request
        const rootSpan = tracer.startSpan("openclaw.request", {
          kind: SpanKind.SERVER,
          attributes: {
            // openclaw legacy
            "openclaw.message.channel": channel,
            "openclaw.session.key": sessionKey,
            "openclaw.message.direction": "inbound",
            "openclaw.message.from": from,
            // GenAI conversation correlation
            [GEN_AI_CONVERSATION_ID]: sessionKey,
            // code.*
            ...codeAttrs("message_received"),
          },
        });

        // ═══ SECURITY DETECTION 2: Prompt Injection ═══════════════
        if (messageText && typeof messageText === "string" && messageText.length > 0) {
          const securityEvent = checkMessageSecurity(
            messageText,
            rootSpan,
            securityCounters,
            sessionKey
          );
          if (securityEvent) {
            // Redact before logging: the gateway logger is piped to the
            // OTLP log bridge in production, and an un-redacted description
            // would otherwise exfiltrate any sensitive value the detection
            // captured (e.g. a path / command fragment containing a token).
            logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${redactSensitiveText(securityEvent.description)}`);
          }
        }

        // Content capture (ISI-1000) — inbound user message text.
        captureContentAttribute(
          rootSpan,
          contentPolicy.inputMessages,
          "openclaw.content.input_message",
          messageText,
        );

        // Store the context so child spans can reference it
        const rootContext = trace.setSpan(context.active(), rootSpan);

        store.setActiveContext(sessionKey, {
          rootSpan,
          rootContext,
          startTime: Date.now(),
        });

        // Record message count metric
        counters.messagesReceived.add(1, {
          "openclaw.message.channel": channel,
        });

        logger.debug?.(`[otel] Root span started for session=${sessionKey}`);
      } catch {
        // Never let telemetry errors break the main flow
      }
    },
    { priority: 100 } // High priority — run first to establish context
  );

  logger.info("[otel] Registered message_received hook (via api.on)");

  // ── session_start ─────────────────────────────────────────────────
  // Creates a long-lived session span that covers the entire conversation.
  // Multiple request/turn cycles can occur within a single session.
  // Stored in TraceContextStore's session tier.

  api.on(
    "session_start",
    async (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return;
        const { tracer, counters, gauges } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const channel = event?.channel || ctx?.channel || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const userId = event?.userId || ctx?.userId || "unknown";

        const existingSession = store.getSession(sessionKey);
        if (existingSession?.span) {
          logger.debug?.(`[otel] session_start: session already active for ${sessionKey}, skipping`);
          return;
        }

        const sessionSpan = tracer.startSpan("openclaw.session", {
          kind: SpanKind.SERVER,
          attributes: {
            [GEN_AI_CONVERSATION_ID]: sessionKey,
            [GEN_AI_AGENT_ID]: agentId,
            [GEN_AI_AGENT_NAME]: agentId,
            "openclaw.session.key": sessionKey,
            "openclaw.session.channel": channel,
            "openclaw.session.user_id": userId,
            "openclaw.agent.id": agentId,
            ...codeAttrs("session_start"),
          },
        });

        const sessionContext = trace.setSpan(context.active(), sessionSpan);

        store.setSession(sessionKey, {
          span: sessionSpan,
          context: sessionContext,
          startedAt: Date.now(),
          requestCount: 0,
          channel,
        });

        gauges.activeSessions.add(1, {
          "openclaw.session.channel": channel,
        });

        logger.debug?.(`[otel] Session span started: session=${sessionKey}, agent=${agentId}`);
      } catch {
      }
    },
    { priority: 110 }
  );

  logger.info("[otel] Registered session_start hook (via api.on)");

  // ── session_end ───────────────────────────────────────────────────
  // Ends the long-lived session span. Records session duration and
  // request count.

  api.on(
    "session_end",
    async (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return;
        const { counters, gauges } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const reason = event?.reason || "unknown";

        const sessionCtx = store.getSession(sessionKey);
        if (!sessionCtx?.span) {
          logger.debug?.(`[otel] session_end: no active session span for ${sessionKey}`);
          return;
        }

        const sessionSpan = sessionCtx.span;
        const durationMs = Date.now() - sessionCtx.startedAt;

        sessionSpan.setAttribute("openclaw.session.duration_ms", durationMs);
        sessionSpan.setAttribute("openclaw.session.request_count", sessionCtx.requestCount);
        sessionSpan.setAttribute("openclaw.session.end_reason", reason);

        if (event?.error) {
          const errStr = String(event.error).slice(0, 500);
          sessionSpan.setAttribute(ERROR_TYPE, "session_error");
          sessionSpan.recordException({ name: "SessionError", message: errStr });
          sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
        } else {
          sessionSpan.setStatus({ code: SpanStatusCode.OK });
        }

        sessionSpan.end();

        gauges.activeSessions.add(-1, {
          "openclaw.session.channel": sessionCtx.channel || "unknown",
        });

        store.deleteSession(sessionKey);

        logger.debug?.(`[otel] Session span ended: session=${sessionKey}, duration=${durationMs}ms, requests=${sessionCtx.requestCount}`);
      } catch {
      }
    },
    { priority: -110 }
  );

  logger.info("[otel] Registered session_end hook (via api.on)");

  // ── before_model_resolve ─────────────────────────────────────────
  // Creates an "agent turn" child span under the root request span.
  //
  // Fires EARLIEST in the agent run, before provider/model resolution
  // (OpenClaw 2026.4.21+). The resolved model is NOT known at this point —
  // it is populated later from diagnostic events or at agent_end
  // (as gen_ai.response.model).
  //
  // Replaces the legacy `before_agent_start` registration used by
  // earlier plugin versions. See ISI-730.

  api.on(
    "before_model_resolve",
    (_event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer } = tel;

        const sessionKey = ctx?.sessionKey || "unknown";
        const agentId = ctx?.agentId || "unknown";

        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        // Create agent turn span as child of root span.
        // Name is kept as `openclaw.agent.turn` for dashboard backwards-compat;
        // GenAI stable attributes below make it semconv-compliant.
        const agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              // GenAI stable
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_AGENT_ID]: agentId,
              [GEN_AI_AGENT_NAME]: agentId,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              // NOTE: gen_ai.request.model is intentionally omitted here.
              // The model is still being resolved. gen_ai.response.model
              // is written at agent_end from diagnostic usage events.
              // code.*
              ...codeAttrs("before_model_resolve"),
              // openclaw legacy (preserve for dashboards)
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
            },
          },
          parentContext
        );

        const agentContext = trace.setSpan(parentContext, agentSpan);

        // Store agent span context for tool spans
        if (sessionCtx) {
          sessionCtx.agentSpan = agentSpan;
          sessionCtx.agentContext = agentContext;
        } else {
          store.setActiveContext(sessionKey, {
            rootSpan: agentSpan,
            rootContext: agentContext,
            agentSpan,
            agentContext,
            startTime: Date.now(),
          });
        }

        // Register in activeAgentSpans for diagnostics integration
        activeAgentSpans.set(sessionKey, agentSpan);

        logger.debug?.(`[otel] Agent turn span started: agent=${agentId}, session=${sessionKey}`);
      } catch {
        // Silently ignore
      }

      // Return undefined — we do not override provider/model.
      return undefined;
    },
    { priority: 90 }
  );

  logger.info("[otel] Registered before_model_resolve hook (via api.on)");

  // ── before_prompt_build ──────────────────────────────────────────
  // Enriches the agent turn span with prompt + session-history context
  // once the session messages are loaded (fires after before_model_resolve
  // but before the LLM call). Produces two attributes:
  //   - openclaw.prompt.chars         — raw user-prompt length for this turn
  //   - openclaw.session.message_count — history size being fed to the LLM
  //
  // No return value — we never rewrite systemPrompt or prependContext.

  api.on(
    "before_prompt_build",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const sessionKey = ctx?.sessionKey || "unknown";
        const sessionCtx = store.getActiveContext(sessionKey);
        const agentSpan = sessionCtx?.agentSpan;
        if (!agentSpan) {
          return undefined;
        }

        const prompt = typeof event?.prompt === "string" ? event.prompt : "";
        const messagesArr = Array.isArray(event?.messages) ? event.messages : [];

        agentSpan.setAttribute("openclaw.prompt.chars", prompt.length);
        agentSpan.setAttribute("openclaw.session.message_count", messagesArr.length);

        // Content capture (ISI-1000).
        captureContentAttribute(
          agentSpan,
          contentPolicy.inputMessages,
          "openclaw.content.prompt",
          prompt,
        );
        if (contentPolicy.inputMessages && messagesArr.length > 0) {
          captureContentAttribute(
            agentSpan,
            true,
            "openclaw.content.messages",
            messagesArr,
          );
        }
        const systemPrompt =
          typeof event?.systemPrompt === "string"
            ? event.systemPrompt
            : typeof event?.system === "string"
              ? event.system
              : undefined;
        captureContentAttribute(
          agentSpan,
          contentPolicy.systemPrompt,
          "openclaw.content.system_prompt",
          systemPrompt,
        );
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined — we do not modify system prompt / prepend context.
      return undefined;
    },
    { priority: 80 }
  );

  logger.info("[otel] Registered before_prompt_build hook (via api.on)");

  // ── llm_input ────────────────────────────────────────────────────
  // Start a CLIENT span for the outbound LLM call. The span is the
  // OpenClaw-level record of the round-trip (not the HTTP transport
  // layer — OpenLLMetry's AnthropicInstrumentation covers that if
  // the preload is active). Closed in `llm_output`.

  api.on(
    "llm_input",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || event?.requestModel || ctx?.model || "unknown";
        const provider = event?.provider || ctx?.provider || "unknown";

        const sessionCtx = store.getActiveContext(sessionKey);
        // If llm_input fires without a prior agent span (unusual), fall back
        // to root context so the CLIENT span still attaches to the trace.
        const parentContext =
          sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const llmSpan = tracer.startSpan(
          "openclaw.llm.call",
          {
            kind: SpanKind.CLIENT,
            attributes: {
              // GenAI stable — dual-emit gen_ai.system (legacy) + gen_ai.provider.name
              // for the schema 1.2.x deprecation window.
              [GEN_AI_OPERATION_NAME]: OP_CHAT,
              [GEN_AI_SYSTEM]: provider,
              [GEN_AI_PROVIDER_NAME]: provider,
              [GEN_AI_REQUEST_MODEL]: model,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              // code.*
              ...codeAttrs("llm_input"),
              // openclaw legacy
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
              "openclaw.llm.provider": provider,
              "openclaw.llm.request_model": model,
            },
          },
          parentContext
        );

        if (sessionCtx) {
          sessionCtx.llmSpan = llmSpan;
          sessionCtx.llmStartTime = Date.now();

          if (sessionCtx.agentSpan && provider && provider !== "unknown") {
            sessionCtx.agentSpan.setAttribute(GEN_AI_PROVIDER_NAME, provider);
          }
        } else {
          llmSpan.setStatus({ code: SpanStatusCode.OK });
          llmSpan.end();
        }

        logger.debug?.(`[otel] LLM call span started: session=${sessionKey}, model=${model}`);
      } catch {
      }

      return undefined;
    },
    { priority: 80 }
  );

  logger.info("[otel] Registered llm_input hook (via api.on)");

  // ── llm_output ───────────────────────────────────────────────────
  // Closes the CLIENT span opened in `llm_input`, recording response
  // model, token counts, and (when available) error state.

  api.on(
    "llm_output",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const sessionCtx = store.getActiveContext(sessionKey);
        const llmSpan = sessionCtx?.llmSpan;
        if (!llmSpan) return undefined;

        const responseModel =
          event?.responseModel || event?.model || ctx?.model || "unknown";
        const usage = event?.usage || {};
        const inputTokens =
          usage.input ?? usage.inputTokens ?? usage.input_tokens ?? 0;
        const outputTokens =
          usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0;
        const cacheRead = usage.cacheRead ?? usage.cache_read_tokens ?? 0;
        const cacheWrite = usage.cacheWrite ?? usage.cache_write_tokens ?? 0;
        const totalTokens =
          usage.total ?? inputTokens + outputTokens + cacheRead + cacheWrite;

        llmSpan.setAttribute(GEN_AI_RESPONSE_MODEL, responseModel);
        if (inputTokens > 0) {
          llmSpan.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, inputTokens);
        }
        if (outputTokens > 0) {
          llmSpan.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, outputTokens);
        }
        // Dual-emit legacy (`cache_*_tokens`) + stable (`cache_*.input_tokens`)
        // forms during the schema 1.2.x deprecation window.
        if (cacheRead > 0) {
          llmSpan.setAttribute(GEN_AI_USAGE_CACHE_READ_TOKENS, cacheRead);
          llmSpan.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, cacheRead);
        }
        if (cacheWrite > 0) {
          llmSpan.setAttribute(GEN_AI_USAGE_CACHE_WRITE_TOKENS, cacheWrite);
          llmSpan.setAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, cacheWrite);
        }
        if (totalTokens > 0) {
          llmSpan.setAttribute(GEN_AI_USAGE_TOTAL_TOKENS, totalTokens);
        }

        const durationMs =
          typeof event?.durationMs === "number"
            ? event.durationMs
            : sessionCtx?.llmStartTime
              ? Date.now() - sessionCtx.llmStartTime
              : undefined;
        if (typeof durationMs === "number") {
          llmSpan.setAttribute("openclaw.llm.duration_ms", durationMs);
        }

        const errorMsg = event?.error;
        if (errorMsg) {
          const errStr = String(errorMsg).slice(0, 500);
          llmSpan.setAttribute(ERROR_TYPE, "llm_error");
          llmSpan.recordException({ name: "LlmError", message: errStr });
          llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
        } else {
          llmSpan.setStatus({ code: SpanStatusCode.OK });
        }

        llmSpan.end();
        sessionCtx!.llmSpan = undefined;
        sessionCtx!.llmStartTime = undefined;
      } catch {
        // Never let telemetry errors break the main flow
      }

      return undefined;
    },
    { priority: -80 }
  );

  logger.info("[otel] Registered llm_output hook (via api.on)");

  // ── model_call_started ──────────────────────────────────────────────
  // Creates a CLIENT span named `chat {model}` per OTel GenAI semconv.
  // Populates request-side attributes: provider, model, stream, max_tokens.
  // Closed in `model_call_ended`.

  api.on(
    "model_call_started",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || event?.requestModel || ctx?.model || "unknown";
        const provider = event?.provider || ctx?.provider || "unknown";
        const stream = event?.stream;
        const maxTokens = event?.maxTokens;

        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext =
          sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          spanNameChat(model),
          {
            kind: SpanKind.CLIENT,
            attributes: {
              [GEN_AI_OPERATION_NAME]: OP_CHAT,
              [GEN_AI_SYSTEM]: provider,
              [GEN_AI_PROVIDER_NAME]: provider,
              [GEN_AI_REQUEST_MODEL]: model,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              ...codeAttrs("model_call_started"),
            },
          },
          parentContext
        );

        if (typeof stream === "boolean") {
          span.setAttribute(GEN_AI_REQUEST_STREAM, stream);
        }
        if (typeof maxTokens === "number") {
          span.setAttribute(GEN_AI_REQUEST_MAX_TOKENS, maxTokens);
        }

        if (sessionCtx) {
          sessionCtx.modelCallSpan = span;
          sessionCtx.modelCallStartTime = Date.now();

          if (sessionCtx.agentSpan) {
            if (provider && provider !== "unknown") {
              sessionCtx.agentSpan.setAttribute(GEN_AI_PROVIDER_NAME, provider);
            }
            if (typeof maxTokens === "number") {
              sessionCtx.agentSpan.setAttribute(GEN_AI_REQUEST_MAX_TOKENS, maxTokens);
            }
          }
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }

        logger.debug?.(`[otel] Model call span started: session=${sessionKey}, model=${model}`);
      } catch {
      }

      return undefined;
    },
    { priority: 75 }
  );

  logger.info("[otel] Registered model_call_started hook (via api.on)");

  // ── model_call_ended ────────────────────────────────────────────────
  // Closes the CLIENT span opened in `model_call_ended`, recording
  // response model, response id, finish reasons, token usage, and
  // cache token attributes per the latest OTel GenAI semconv.

  api.on(
    "model_call_ended",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const sessionCtx = store.getActiveContext(sessionKey);
        const span = sessionCtx?.modelCallSpan;
        if (!span) return undefined;

        const responseModel =
          event?.responseModel || event?.model || ctx?.model || "unknown";
        const responseId = event?.responseId;
        const finishReasons = event?.finishReasons;
        const usage = event?.usage || {};
        const inputTokens =
          usage.input ?? usage.inputTokens ?? usage.input_tokens ?? 0;
        const outputTokens =
          usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0;
        const cacheReadInputTokens =
          usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0;
        const cacheCreationInputTokens =
          usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0;
        const cacheRead = usage.cacheRead ?? usage.cache_read_tokens ?? 0;
        const cacheWrite = usage.cacheWrite ?? usage.cache_write_tokens ?? 0;
        const totalTokens =
          usage.total ?? inputTokens + outputTokens + cacheRead + cacheWrite;

        span.setAttribute(GEN_AI_RESPONSE_MODEL, responseModel);
        if (typeof responseId === "string" && responseId) {
          span.setAttribute(GEN_AI_RESPONSE_ID, responseId);
        }
        if (Array.isArray(finishReasons) && finishReasons.length > 0) {
          const cleanReasons = finishReasons.filter(
            (r): r is string => typeof r === "string" && r.length > 0,
          );
          if (cleanReasons.length > 0) {
            span.setAttribute(GEN_AI_RESPONSE_FINISH_REASONS, cleanReasons);
          }
        } else if (typeof finishReasons === "string" && finishReasons) {
          span.setAttribute(GEN_AI_RESPONSE_FINISH_REASONS, [finishReasons]);
        }

        if (inputTokens > 0) {
          span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, inputTokens);
        }
        if (outputTokens > 0) {
          span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, outputTokens);
        }
        if (cacheReadInputTokens > 0) {
          span.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, cacheReadInputTokens);
        }
        if (cacheCreationInputTokens > 0) {
          span.setAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, cacheCreationInputTokens);
        }
        if (totalTokens > 0) {
          span.setAttribute(GEN_AI_USAGE_TOTAL_TOKENS, totalTokens);
        }

        const durationMs =
          typeof event?.durationMs === "number"
            ? event.durationMs
            : sessionCtx?.modelCallStartTime
              ? Date.now() - sessionCtx.modelCallStartTime
              : undefined;
        if (typeof durationMs === "number") {
          span.setAttribute("openclaw.llm.duration_ms", durationMs);
        }

        const errorMsg = event?.error;
        if (errorMsg) {
          const errStr = String(errorMsg).slice(0, 500);
          span.setAttribute(ERROR_TYPE, "llm_error");
          span.recordException({ name: "LlmError", message: errStr });
          span.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
        sessionCtx!.modelCallSpan = undefined;
        sessionCtx!.modelCallStartTime = undefined;
      } catch {
      }

      return undefined;
    },
    { priority: -75 }
  );

  logger.info("[otel] Registered model_call_ended hook (via api.on)");

  // ── before_dispatch ──────────────────────────────────────────────
  // Fires just before the LLM request is dispatched over the wire.
  // Creates a short INTERNAL span for trace continuity, linking the
  // agent turn span to the outbound dispatch phase.

  api.on(
    "before_dispatch",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || ctx?.model || "unknown";
        const provider = event?.provider || ctx?.provider || "unknown";

        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext =
          sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          "openclaw.dispatch.prepare",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [GEN_AI_OPERATION_NAME]: OP_CHAT,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              [GEN_AI_REQUEST_MODEL]: model,
              [GEN_AI_PROVIDER_NAME]: provider,
              ...codeAttrs("before_dispatch"),
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        if (sessionCtx) {
          sessionCtx.dispatchSpan = span;
          sessionCtx.dispatchStartTime = Date.now();
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }

        logger.debug?.(`[otel] Dispatch prepare span started: session=${sessionKey}, model=${model}`);
      } catch {
      }

      return undefined;
    },
    { priority: 72 }
  );

  logger.info("[otel] Registered before_dispatch hook (via api.on)");

  // ── reply_dispatch ───────────────────────────────────────────────
  // Fires when the LLM reply is received and dispatched for processing.
  // Closes the dispatch span opened in `before_dispatch`.

  api.on(
    "reply_dispatch",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const sessionCtx = store.getActiveContext(sessionKey);
        const span = sessionCtx?.dispatchSpan;
        if (!span) return undefined;

        const responseModel = event?.responseModel || event?.model || ctx?.model || "unknown";

        span.setAttribute(GEN_AI_RESPONSE_MODEL, responseModel);

        const durationMs = sessionCtx?.dispatchStartTime
          ? Date.now() - sessionCtx.dispatchStartTime
          : undefined;
        if (typeof durationMs === "number") {
          span.setAttribute("openclaw.dispatch.duration_ms", durationMs);
        }

        if (event?.error) {
          const errStr = String(event.error).slice(0, 500);
          span.setAttribute(ERROR_TYPE, "dispatch_error");
          span.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
        sessionCtx!.dispatchSpan = undefined;
        sessionCtx!.dispatchStartTime = undefined;

        logger.debug?.(`[otel] Reply dispatch span ended: session=${sessionKey}`);
      } catch {
      }

      return undefined;
    },
    { priority: -72 }
  );

  logger.info("[otel] Registered reply_dispatch hook (via api.on)");

  // ── before_tool_call ──────────────────────────────────────────────
  // Creates a tool span BEFORE execution starts, enabling accurate
  // duration timing. The span is closed in `after_tool_call`.
  // Falls back gracefully: `tool_result_persist` creates + ends a span
  // when before_tool_call never fired (backward compat).

  api.on(
    "before_tool_call",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer, counters } = tel;

        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const sessionKey = ctx?.sessionKey || event?.sessionKey || "unknown";
        const agentId = ctx?.agentId || event?.agentId || "unknown";
        const toolInput = event?.input || event?.toolInput || event?.args || {};
        const requiresApproval = event?.requiresApproval === true;

        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          spanNameExecuteTool(toolName),
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
              [GEN_AI_TOOL_NAME]: toolName,
              [GEN_AI_TOOL_CALL_ID]: toolCallId,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              ...codeAttrs("before_tool_call"),
              "openclaw.tool.name": toolName,
              "openclaw.tool.call_id": toolCallId,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        setToolInputPreview(span, toolInput);

        // Content capture (ISI-1000) — full tool input, gated by policy.
        captureContentAttribute(
          span,
          contentPolicy.toolInputs,
          "openclaw.content.tool_input",
          toolInput,
        );

        if (requiresApproval) {
          span.setAttribute(OPENCLAW_TOOL_APPROVAL_REQUESTED, true);
          counters.toolApprovals.add(1, {
            [GEN_AI_TOOL_NAME]: toolName,
            [GEN_AI_CONVERSATION_ID]: sessionKey,
          });
        }

        if (sessionCtx) {
          if (!sessionCtx.activeToolSpans) {
            sessionCtx.activeToolSpans = new Map();
          }
          sessionCtx.activeToolSpans.set(toolCallId || toolName, {
            span,
            startTime: Date.now(),
            approvalRequested: requiresApproval,
          });
        }

        logger.debug?.(`[otel] Tool call span started: tool=${toolName}, callId=${toolCallId}, session=${sessionKey}`);
      } catch {
      }

      return undefined;
    },
    { priority: 70 }
  );

  logger.info("[otel] Registered before_tool_call hook (via api.on)");

  // ── after_tool_call ───────────────────────────────────────────────
  // Closes the tool span opened in `before_tool_call`, recording result
  // metadata, duration, and approval resolution.

  api.on(
    "after_tool_call",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { counters, histograms } = tel;

        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const sessionKey = ctx?.sessionKey || event?.sessionKey || "unknown";

        const sessionCtx = store.getActiveContext(sessionKey);
        if (!sessionCtx?.activeToolSpans) return undefined;

        const key = toolCallId || toolName;
        const active = sessionCtx.activeToolSpans.get(key);
        if (!active) return undefined;

        const { span, startTime, approvalRequested } = active;
        const durationMs = Date.now() - startTime;

        counters.toolCalls.add(1, {
          [GEN_AI_TOOL_NAME]: toolName,
          [GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
          [GEN_AI_CONVERSATION_ID]: sessionKey,
        });

        span.setAttribute("openclaw.tool.duration_ms", durationMs);

        const message = event?.message || event?.result;
        if (message) {
          const contentArray = message?.content;
          if (contentArray && Array.isArray(contentArray)) {
            const textParts = contentArray
              .filter((c: any) => c.type === "text")
              .map((c: any) => String(c.text || ""));
            const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
            span.setAttribute("openclaw.tool.result_chars", totalChars);
            span.setAttribute("openclaw.tool.result_parts", contentArray.length);
          }

          // Content capture (ISI-1000) — tool output text.
          captureContentAttribute(
            span,
            contentPolicy.toolOutputs,
            "openclaw.content.tool_output",
            extractToolOutputText(message),
          );

          if (message?.is_error === true || message?.isError === true) {
            counters.toolErrors.add(1, {
              [GEN_AI_TOOL_NAME]: toolName,
            });
            span.setAttribute(ERROR_TYPE, "tool_execution_error");
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        const approvalResolution = event?.approvalResolution || event?.approval?.resolution;
        if (approvalRequested && approvalResolution) {
          span.setAttribute(OPENCLAW_TOOL_APPROVAL_RESOLUTION, String(approvalResolution));
          const approvalDurationMs = active.approvalResolvedAt
            ? active.approvalResolvedAt - startTime
            : undefined;
          if (typeof approvalDurationMs === "number") {
            span.setAttribute(OPENCLAW_TOOL_APPROVAL_DURATION_MS, approvalDurationMs);
          }
        }

        histograms.toolCallDuration.record(durationMs, {
          [GEN_AI_TOOL_NAME]: toolName,
          [GEN_AI_CONVERSATION_ID]: sessionKey,
        });

        span.end();
        sessionCtx.activeToolSpans.delete(key);

        logger.debug?.(`[otel] Tool call span ended: tool=${toolName}, duration=${durationMs}ms, session=${sessionKey}`);
      } catch {
      }

      return undefined;
    },
    { priority: -70 }
  );

  logger.info("[otel] Registered after_tool_call hook (via api.on)");

  // ── tool_approval_resolution ──────────────────────────────────────
  // Records approval resolution on the in-flight tool span. Fired when
  // a human reviewer approves or denies a tool call that was pending.

  api.on(
    "tool_approval_resolution",
    (event: any, ctx: any) => {
      try {
        const sessionKey = ctx?.sessionKey || event?.sessionKey || "unknown";
        const toolCallId = event?.toolCallId || "";
        const toolName = event?.toolName || "unknown";
        const resolution = event?.resolution || "unknown";

        const sessionCtx = store.getActiveContext(sessionKey);
        if (!sessionCtx?.activeToolSpans) return undefined;

        const key = toolCallId || toolName;
        const active = sessionCtx.activeToolSpans.get(key);
        if (!active) return undefined;

        active.span.setAttribute(OPENCLAW_TOOL_APPROVAL_RESOLUTION, String(resolution));
        active.span.addEvent("tool.approval.resolved", {
          "tool.approval.resolution": String(resolution),
          "tool.name": toolName,
        });
        active.approvalResolvedAt = Date.now();

        if (typeof active.startTime === "number") {
          const waitMs = active.approvalResolvedAt - active.startTime;
          active.span.setAttribute(OPENCLAW_TOOL_APPROVAL_DURATION_MS, waitMs);
        }

        logger.debug?.(`[otel] Tool approval resolved: tool=${toolName}, resolution=${resolution}, session=${sessionKey}`);
      } catch {
      }

      return undefined;
    },
    { priority: 80 }
  );

  logger.info("[otel] Registered tool_approval_resolution hook (via api.on)");

  // ── tool_result_persist ──────────────────────────────────────────
  // Creates a child span under the agent turn span for each tool call.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer, counters } = tel;
        const securityCounters = buildSecurityCounters(tel);

        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const isSynthetic = event?.isSynthetic === true;
        const sessionKey = ctx?.sessionKey || "unknown";
        const agentId = ctx?.agentId || "unknown";

        const toolInput = event?.input || event?.toolInput || event?.args || {};

        const sessionCtx = store.getActiveContext(sessionKey);

        const activeToolKey = toolCallId || toolName;
        const activeTool = sessionCtx?.activeToolSpans?.get(activeToolKey);

        if (activeTool) {
          const span = activeTool.span;

          const securityEvent = checkToolSecurity(
            toolName,
            toolInput,
            span,
            securityCounters,
            sessionKey,
            agentId
          );
          if (securityEvent) {
            // Redact before logging: the gateway logger is piped to the
            // OTLP log bridge in production, and an un-redacted description
            // would otherwise exfiltrate any sensitive value the detection
            // captured (e.g. a path / command fragment containing a token).
            logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${redactSensitiveText(securityEvent.description)}`);
            setToolInputPreview(span, toolInput);
          }

          // Content capture (ISI-1000) — tool input persists onto the
          // pre-existing tool span (created in before_tool_call). Gated.
          captureContentAttribute(
            span,
            contentPolicy.toolInputs,
            "openclaw.content.tool_input",
            toolInput,
          );

          const message = event?.message;
          if (message) {
            const contentArray = message?.content;
            if (contentArray && Array.isArray(contentArray)) {
              const textParts = contentArray
                .filter((c: any) => c.type === "text")
                .map((c: any) => String(c.text || ""));
              const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
              span.setAttribute("openclaw.tool.result_chars", totalChars);
            }

            captureContentAttribute(
              span,
              contentPolicy.toolOutputs,
              "openclaw.content.tool_output",
              extractToolOutputText(message),
            );

            if (message?.is_error === true || message?.isError === true) {
              span.setAttribute(ERROR_TYPE, "tool_execution_error");
              span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
            }
          }

          return undefined;
        }

        counters.toolCalls.add(1, {
          [GEN_AI_TOOL_NAME]: toolName,
          [GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
          [GEN_AI_CONVERSATION_ID]: sessionKey,
        });

        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          spanNameExecuteTool(toolName),
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [GEN_AI_OPERATION_NAME]: OP_EXECUTE_TOOL,
              [GEN_AI_TOOL_NAME]: toolName,
              [GEN_AI_TOOL_CALL_ID]: toolCallId,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              ...codeAttrs("tool_result_persist"),
              "openclaw.tool.name": toolName,
              "openclaw.tool.call_id": toolCallId,
              "openclaw.tool.is_synthetic": isSynthetic,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        const securityEvent = checkToolSecurity(
          toolName,
          toolInput,
          span,
          securityCounters,
          sessionKey,
          agentId
        );
        if (securityEvent) {
          logger.warn?.(`[otel] SECURITY: ${securityEvent.detection} - ${redactSensitiveText(securityEvent.description)}`);
          setToolInputPreview(span, toolInput);
        }

        // Content capture (ISI-1000) on the fallback-created tool span.
        captureContentAttribute(
          span,
          contentPolicy.toolInputs,
          "openclaw.content.tool_input",
          toolInput,
        );

        const message = event?.message;
        if (message) {
          const contentArray = message?.content;
          if (contentArray && Array.isArray(contentArray)) {
            const textParts = contentArray
              .filter((c: any) => c.type === "text")
              .map((c: any) => String(c.text || ""));
            const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
            span.setAttribute("openclaw.tool.result_chars", totalChars);
            span.setAttribute("openclaw.tool.result_parts", contentArray.length);
          }

          captureContentAttribute(
            span,
            contentPolicy.toolOutputs,
            "openclaw.content.tool_output",
            extractToolOutputText(message),
          );

          if (message?.is_error === true || message?.isError === true) {
            counters.toolErrors.add(1, {
              [GEN_AI_TOOL_NAME]: toolName,
            });
            span.setAttribute(ERROR_TYPE, "tool_execution_error");
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
          } else if (!securityEvent) {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } else if (!securityEvent) {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      } catch {
      }

      return undefined;
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered tool_result_persist hook (via api.on)");

  // ── message_sent ─────────────────────────────────────────────────
  // Records the outbound reply as a short INTERNAL span under the root
  // request span. Also increments the `openclaw.messages.sent` counter
  // that the plugin already declares but has never populated.

  api.on(
    "message_sent",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer, counters } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const channel = event?.channel || ctx?.channel || "unknown";
        const to = event?.to || event?.recipientId || "unknown";
        const messageText = event?.text || event?.message || "";
        const charCount =
          typeof messageText === "string" ? messageText.length : 0;

        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext =
          sessionCtx?.rootContext || sessionCtx?.agentContext || context.active();

        const span = tracer.startSpan(
          "openclaw.message.sent",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              // openclaw legacy
              "openclaw.message.channel": channel,
              "openclaw.session.key": sessionKey,
              "openclaw.message.direction": "outbound",
              "openclaw.message.to": to,
              "openclaw.message.chars": charCount,
              // GenAI conversation correlation
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              // code.*
              ...codeAttrs("message_sent"),
            },
          },
          parentContext
        );

        counters.messagesSent.add(1, {
          "openclaw.message.channel": channel,
        });

        // Content capture (ISI-1000) — outbound assistant reply text.
        captureContentAttribute(
          span,
          contentPolicy.outputMessages,
          "openclaw.content.output_message",
          messageText,
        );

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] Outbound message span recorded: session=${sessionKey}, channel=${channel}, chars=${charCount}`);
      } catch {
        // Never let telemetry errors break the main flow
      }

      return undefined;
    },
    { priority: -90 }
  );

  logger.info("[otel] Registered message_sent hook (via api.on)");

  // ── before_agent_finalize ────────────────────────────────────────
  // Fires before the agent finalizes its response. Creates a short
  // INTERNAL span for cleanup tracking.

  api.on(
    "before_agent_finalize",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";

        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext =
          sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          "openclaw.agent.finalize",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              ...codeAttrs("before_agent_finalize"),
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        const pendingMessageCount = event?.pendingMessageCount;
        if (typeof pendingMessageCount === "number") {
          span.setAttribute("openclaw.agent.pending_messages", pendingMessageCount);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] Agent finalize span recorded: session=${sessionKey}, agent=${agentId}`);
      } catch {
      }

      return undefined;
    },
    { priority: -85 }
  );

  logger.info("[otel] Registered before_agent_finalize hook (via api.on)");

  // ── before_reset ─────────────────────────────────────────────────
  // Fires before a session/conversation reset. Creates a short span
  // to capture the reset event and any cleanup state.

  api.on(
    "before_reset",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer, counters } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const resetReason = event?.reason || event?.resetReason || "unknown";

        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext =
          sessionCtx?.rootContext || sessionCtx?.agentContext || context.active();

        const span = tracer.startSpan(
          "openclaw.session.reset",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [GEN_AI_CONVERSATION_ID]: sessionKey,
              [GEN_AI_AGENT_ID]: agentId,
              "openclaw.session.key": sessionKey,
              "openclaw.session.reset_reason": resetReason,
              "openclaw.agent.id": agentId,
              ...codeAttrs("before_reset"),
            },
          },
          parentContext
        );

        const sessionInfo = store.getSession(sessionKey);
        if (sessionInfo) {
          span.setAttribute("openclaw.session.request_count_at_reset", sessionInfo.requestCount);
          const sessionDuration = Date.now() - sessionInfo.startedAt;
          span.setAttribute("openclaw.session.duration_at_reset_ms", sessionDuration);
        }

        counters.sessionResets.add(1, {
          "openclaw.session.reset_reason": resetReason,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] Session reset span recorded: session=${sessionKey}, reason=${resetReason}`);
      } catch {
      }

      return undefined;
    },
    { priority: 95 }
  );

  logger.info("[otel] Registered before_reset hook (via api.on)");

  // ── agent_end ────────────────────────────────────────────────────
  // Ends the agent turn span AND the root request span.
  // Event shape from OpenClaw:
  //   event: { messages, success, error?, durationMs }
  //   ctx:   { agentId, sessionKey, workspaceDir, messageProvider? }
  // Token usage is embedded in the last assistant message's .usage field.

  api.on(
    "agent_end",
    async (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return;
        const { counters, histograms } = tel;

        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const durationMs = event?.durationMs;
        const success = event?.success !== false;
        const errorMsg = event?.error;

        // Try to get usage from diagnostic events (includes cost!)
        const diagUsage = getPendingUsage(sessionKey);

        // Fallback: Extract token usage from the messages array
        const messages: any[] = event?.messages || [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let model = "unknown";
        let costUsd: number | undefined;

        if (diagUsage) {
          // Use diagnostic event data (more accurate, includes cost)
          totalInputTokens = diagUsage.usage.input || 0;
          totalOutputTokens = diagUsage.usage.output || 0;
          cacheReadTokens = diagUsage.usage.cacheRead || 0;
          cacheWriteTokens = diagUsage.usage.cacheWrite || 0;
          model = diagUsage.model || "unknown";
          costUsd = diagUsage.costUsd;
          logger.debug?.(`[otel] agent_end using diagnostic data: cost=$${costUsd?.toFixed(4) || "?"}`);
        } else {
          // Fallback: parse messages manually
          for (const msg of messages) {
            if (msg?.role === "assistant" && msg?.usage) {
              const u = msg.usage;
              // pi-ai stores usage as .input/.output (normalized names)
              if (typeof u.input === "number") totalInputTokens += u.input;
              else if (typeof u.inputTokens === "number") totalInputTokens += u.inputTokens;
              else if (typeof u.input_tokens === "number") totalInputTokens += u.input_tokens;

              if (typeof u.output === "number") totalOutputTokens += u.output;
              else if (typeof u.outputTokens === "number") totalOutputTokens += u.outputTokens;
              else if (typeof u.output_tokens === "number") totalOutputTokens += u.output_tokens;

              if (typeof u.cacheRead === "number") cacheReadTokens += u.cacheRead;
              if (typeof u.cacheWrite === "number") cacheWriteTokens += u.cacheWrite;
            }
            if (msg?.role === "assistant" && msg?.model) {
              model = msg.model;
            }
          }
        }

        const totalTokens = totalInputTokens + totalOutputTokens + cacheReadTokens + cacheWriteTokens;
        logger.debug?.(`[otel] agent_end tokens: input=${totalInputTokens}, output=${totalOutputTokens}, cache_read=${cacheReadTokens}, cache_write=${cacheWriteTokens}, model=${model}`);

        const sessionCtx = store.getActiveContext(sessionKey);

        // Safety net: close any leftover in-flight dispatch span
        if (sessionCtx?.dispatchSpan) {
          try {
            sessionCtx.dispatchSpan.setStatus({
              code: SpanStatusCode.OK,
              message: "closed by agent_end (reply_dispatch did not fire)",
            });
            sessionCtx.dispatchSpan.end();
          } catch { /* ignore */ }
          sessionCtx.dispatchSpan = undefined;
          sessionCtx.dispatchStartTime = undefined;
        }

        // Safety net: close any leftover in-flight LLM span so it
        // doesn't leak past the agent turn.
        // Some providers (e.g., ZAI/GLM) don't emit llm_output events,
        // so we populate the span with token data from agent_end diagnostics
        // and close it with OK status instead of ERROR.
        if (sessionCtx?.llmSpan) {
          try {
            // Populate token data from agent_end diagnostics if available
            if (totalInputTokens > 0) {
              sessionCtx.llmSpan.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, totalInputTokens);
            }
            if (totalOutputTokens > 0) {
              sessionCtx.llmSpan.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, totalOutputTokens);
            }
            // Dual-emit legacy + stable cache attribute forms.
            if (cacheReadTokens > 0) {
              sessionCtx.llmSpan.setAttribute(GEN_AI_USAGE_CACHE_READ_TOKENS, cacheReadTokens);
              sessionCtx.llmSpan.setAttribute(
                GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
                cacheReadTokens,
              );
            }
            if (cacheWriteTokens > 0) {
              sessionCtx.llmSpan.setAttribute(GEN_AI_USAGE_CACHE_WRITE_TOKENS, cacheWriteTokens);
              sessionCtx.llmSpan.setAttribute(
                GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
                cacheWriteTokens,
              );
            }
            const llmDurationMs = sessionCtx.llmStartTime
              ? Date.now() - sessionCtx.llmStartTime
              : undefined;
            if (typeof llmDurationMs === "number") {
              sessionCtx.llmSpan.setAttribute("openclaw.llm.duration_ms", llmDurationMs);
            }
            sessionCtx.llmSpan.setStatus({
              code: SpanStatusCode.OK,
              message: "closed by agent_end (provider did not emit llm_output)",
            });
            sessionCtx.llmSpan.end();
          } catch { /* ignore */ }
          sessionCtx.llmSpan = undefined;
          sessionCtx.llmStartTime = undefined;
        }

        if (sessionCtx?.modelCallSpan) {
          try {
            sessionCtx.modelCallSpan.setStatus({
              code: SpanStatusCode.OK,
              message: "closed by agent_end (provider did not emit model_call_ended)",
            });
            sessionCtx.modelCallSpan.end();
          } catch { /* ignore */ }
          sessionCtx.modelCallSpan = undefined;
          sessionCtx.modelCallStartTime = undefined;
        }

        if (sessionCtx?.activeToolSpans && sessionCtx.activeToolSpans.size > 0) {
          for (const [key, active] of sessionCtx.activeToolSpans) {
            try {
              const durationMs = Date.now() - active.startTime;
              active.span.setAttribute("openclaw.tool.duration_ms", durationMs);
              active.span.setStatus({
                code: SpanStatusCode.OK,
                message: "closed by agent_end (after_tool_call did not fire)",
              });
              active.span.end();
            } catch { /* ignore */ }
          }
          sessionCtx.activeToolSpans.clear();
        }

        // End the agent turn span
        if (sessionCtx?.agentSpan) {
          const agentSpan = sessionCtx.agentSpan;

          if (typeof durationMs === "number") {
            agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
          }

          // Token usage — GenAI semantic convention attributes
          agentSpan.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, totalInputTokens);
          agentSpan.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, totalOutputTokens);
          agentSpan.setAttribute(GEN_AI_USAGE_TOTAL_TOKENS, totalTokens);
          agentSpan.setAttribute(GEN_AI_RESPONSE_MODEL, model);
          agentSpan.setAttribute("openclaw.agent.success", success);

          if (diagUsage?.provider) {
            agentSpan.setAttribute(GEN_AI_PROVIDER_NAME, diagUsage.provider);
          }

          // Cache tokens — dual-emit legacy + stable input_tokens forms.
          if (cacheReadTokens > 0) {
            agentSpan.setAttribute(GEN_AI_USAGE_CACHE_READ_TOKENS, cacheReadTokens);
            agentSpan.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, cacheReadTokens);
          }
          if (cacheWriteTokens > 0) {
            agentSpan.setAttribute(GEN_AI_USAGE_CACHE_WRITE_TOKENS, cacheWriteTokens);
            agentSpan.setAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, cacheWriteTokens);
          }

          // Cost (from diagnostic events) — this is the key addition!
          if (typeof costUsd === "number") {
            agentSpan.setAttribute("openclaw.llm.cost_usd", costUsd);
          }

          // Context window (from diagnostic events)
          if (diagUsage?.context?.limit) {
            agentSpan.setAttribute("openclaw.context.limit", diagUsage.context.limit);
          }
          if (diagUsage?.context?.used) {
            agentSpan.setAttribute("openclaw.context.used", diagUsage.context.used);
          }

          // Record metrics only if we didn't get them from diagnostics
          // (diagnostics module already records metrics on model.usage event)
          if (!diagUsage && (totalInputTokens > 0 || totalOutputTokens > 0)) {
            const metricAttrs = {
              [GEN_AI_RESPONSE_MODEL]: model,
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_AGENT_ID]: agentId,
              "openclaw.agent.id": agentId,
            };
            counters.tokensPrompt.add(totalInputTokens + cacheReadTokens + cacheWriteTokens, metricAttrs);
            counters.tokensCompletion.add(totalOutputTokens, metricAttrs);
            counters.tokensTotal.add(totalTokens, metricAttrs);
            counters.llmRequests.add(1, metricAttrs);

            // Stable GenAI token usage histogram (per gen_ai.token.type)
            histograms.genAiTokenUsage.record(totalInputTokens + cacheReadTokens + cacheWriteTokens, {
              ...metricAttrs,
              [GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_INPUT,
            });
            histograms.genAiTokenUsage.record(totalOutputTokens, {
              ...metricAttrs,
              [GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_OUTPUT,
            });
          }

          // Record duration histograms — legacy (ms) and stable GenAI (s).
          if (typeof durationMs === "number") {
            const durationAttrs = {
              [GEN_AI_RESPONSE_MODEL]: model,
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_AGENT_ID]: agentId,
              "openclaw.agent.id": agentId,
            };
            histograms.agentTurnDuration.record(durationMs, durationAttrs);
            histograms.genAiOperationDuration.record(durationMs / 1000, durationAttrs);
          }

          if (errorMsg) {
            const errStr = String(errorMsg).slice(0, 500);
            agentSpan.setAttribute("openclaw.agent.error", errStr);
            agentSpan.setAttribute(ERROR_TYPE, "agent_error");
            agentSpan.recordException({ name: "AgentError", message: errStr });
            agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
          } else {
            agentSpan.setStatus({ code: SpanStatusCode.OK });
          }

          agentSpan.end();
        }

        // End the root request span
        if (sessionCtx?.rootSpan && sessionCtx.rootSpan !== sessionCtx.agentSpan) {
          const totalMs = Date.now() - sessionCtx.startTime;
          sessionCtx.rootSpan.setAttribute("openclaw.request.duration_ms", totalMs);
          sessionCtx.rootSpan.setStatus({ code: SpanStatusCode.OK });
          sessionCtx.rootSpan.end();
        }

        // Clean up
        store.cleanupSession(sessionKey);
        activeAgentSpans.delete(sessionKey);

        logger.debug?.(`[otel] Trace completed for session=${sessionKey}`);
      } catch {
        // Silently ignore
      }
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered agent_end hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // SUB-AGENT ORCHESTRATION HOOKS
  // ═══════════════════════════════════════════════════════════════════

  // ── subagent_spawning ─────────────────────────────────────────────
  // Fires when a parent agent spawns a sub-agent. Creates a child span
  // linked to the parent agent's turn span via the TraceContextStore
  // sub-agent link table. The child session will resolve parent context
  // for trace correlation.

  api.on(
    "subagent_spawning",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer, counters } = tel;

        const parentSessionKey = ctx?.sessionKey || event?.parentSessionKey || "unknown";
        const childSessionKey = event?.childSessionKey || event?.sessionKey || "unknown";
        const childAgentId = event?.childAgentId || event?.agentId || "unknown";
        const childAgentName = event?.childAgentName || event?.agentName || childAgentId;
        const spawnReason = event?.reason || event?.spawnReason || "unknown";
        const parentAgentId = ctx?.agentId || event?.parentAgentId || "unknown";

        const parentContext = store.resolveParentContext(childSessionKey)
          || store.getActiveContext(parentSessionKey)?.agentContext
          || store.getActiveContext(parentSessionKey)?.rootContext
          || context.active();

        const span = tracer.startSpan(
          "openclaw.subagent.spawning",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
              [GEN_AI_AGENT_ID]: childAgentId,
              [GEN_AI_AGENT_NAME]: childAgentName,
              [GEN_AI_CONVERSATION_ID]: childSessionKey,
              [OC_SUBAGENT_PARENT_SESSION]: parentSessionKey,
              [OC_SUBAGENT_CHILD_SESSION]: childSessionKey,
              [OC_SUBAGENT_CHILD_AGENT_ID]: childAgentId,
              [OC_SUBAGENT_CHILD_AGENT_NAME]: childAgentName,
              [OC_SUBAGENT_SPAWN_REASON]: spawnReason,
              ...codeAttrs("subagent_spawning"),
              "openclaw.session.key": parentSessionKey,
              "openclaw.agent.id": parentAgentId,
            },
          },
          parentContext
        );

        store.linkSubAgent(childSessionKey, parentSessionKey);

        if (store.getActiveContext(parentSessionKey)?.agentSpan) {
          const parentSpan = store.getActiveContext(parentSessionKey)!.agentSpan!;
          span.addLink({
            context: parentSpan.spanContext(),
            attributes: { "openclaw.link.type": "subagent_parent" },
          });
        }

        counters.subagentSpawns.add(1, {
          [OC_SUBAGENT_CHILD_AGENT_NAME]: childAgentName,
          [OC_SUBAGENT_SPAWN_REASON]: spawnReason,
        });

        const sessionCtx = store.getActiveContext(parentSessionKey);
        if (sessionCtx) {
          if (!sessionCtx.activeToolSpans) {
            sessionCtx.activeToolSpans = new Map();
          }
          sessionCtx.activeToolSpans.set(`__subagent_${childSessionKey}`, {
            span,
            startTime: Date.now(),
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }

        logger.debug?.(`[otel] Sub-agent spawning: parent=${parentSessionKey}, child=${childSessionKey}, agent=${childAgentName}`);
      } catch {
      }

      return undefined;
    },
    { priority: 60 }
  );

  logger.info("[otel] Registered subagent_spawning hook (via api.on)");

  // ── subagent_delivery_target ──────────────────────────────────────
  // Fires when the parent delivers a target (task/prompt) to the child
  // sub-agent. Creates a short span for the delivery event.

  api.on(
    "subagent_delivery_target",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer } = tel;

        const childSessionKey = event?.childSessionKey || event?.sessionKey || "unknown";
        const parentSessionKey = event?.parentSessionKey || ctx?.sessionKey || "unknown";
        const deliveryType = event?.deliveryType || event?.type || "unknown";
        const childAgentId = event?.childAgentId || event?.agentId || "unknown";

        const parentContext = store.getActiveContext(parentSessionKey)?.agentContext
          || store.getActiveContext(parentSessionKey)?.rootContext
          || context.active();

        const span = tracer.startSpan(
          "openclaw.subagent.delivery",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [GEN_AI_CONVERSATION_ID]: childSessionKey,
              [OC_SUBAGENT_PARENT_SESSION]: parentSessionKey,
              [OC_SUBAGENT_CHILD_SESSION]: childSessionKey,
              [OC_SUBAGENT_CHILD_AGENT_ID]: childAgentId,
              [OC_SUBAGENT_DELIVERY_TYPE]: deliveryType,
              ...codeAttrs("subagent_delivery_target"),
              "openclaw.session.key": parentSessionKey,
            },
          },
          parentContext
        );

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] Sub-agent delivery: parent=${parentSessionKey}, child=${childSessionKey}, type=${deliveryType}`);
      } catch {
      }

      return undefined;
    },
    { priority: 55 }
  );

  logger.info("[otel] Registered subagent_delivery_target hook (via api.on)");

  // ── subagent_ended ────────────────────────────────────────────────
  // Fires when a sub-agent finishes execution. Closes the sub-agent
  // spawning span and records duration/success.

  api.on(
    "subagent_ended",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { counters, histograms } = tel;

        const childSessionKey = event?.childSessionKey || event?.sessionKey || "unknown";
        const parentSessionKey = event?.parentSessionKey || ctx?.sessionKey || "unknown";
        const success = event?.success !== false;
        const errorMsg = event?.error;
        const durationMs = event?.durationMs;
        const childAgentId = event?.childAgentId || event?.agentId || "unknown";
        const childAgentName = event?.childAgentName || childAgentId;

        const parentSessionCtx = store.getActiveContext(parentSessionKey);
        const subagentKey = `__subagent_${childSessionKey}`;
        const active = parentSessionCtx?.activeToolSpans?.get(subagentKey);

        if (active) {
          const { span, startTime } = active;
          const elapsed = typeof durationMs === "number" ? durationMs : Date.now() - startTime;

          span.setAttribute(OC_SUBAGENT_DURATION_MS, elapsed);
          span.setAttribute(OC_SUBAGENT_SUCCESS, success);

          if (errorMsg) {
            const errStr = String(errorMsg).slice(0, 500);
            span.setAttribute(ERROR_TYPE, "subagent_error");
            span.recordException({ name: "SubAgentError", message: errStr });
            span.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }

          histograms.subagentDuration.record(elapsed, {
            [OC_SUBAGENT_CHILD_AGENT_NAME]: childAgentName,
          });

          span.end();
          parentSessionCtx!.activeToolSpans!.delete(subagentKey);
        }

        counters.subagentEnded.add(1, {
          [OC_SUBAGENT_CHILD_AGENT_NAME]: childAgentName,
          [OC_SUBAGENT_SUCCESS]: String(success),
        });

        store.unlinkSubAgent(childSessionKey);

        logger.debug?.(`[otel] Sub-agent ended: child=${childSessionKey}, parent=${parentSessionKey}, success=${success}`);
      } catch {
      }

      return undefined;
    },
    { priority: -60 }
  );

  logger.info("[otel] Registered subagent_ended hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // CRON JOB HOOKS
  // ═══════════════════════════════════════════════════════════════════

  // ── cron_changed ──────────────────────────────────────────────────
  // Fires when a cron job is created, updated, or deleted. Creates a
  // short span capturing the change event.

  api.on(
    "cron_changed",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer, counters } = tel;

        const jobName = event?.jobName || event?.name || "unknown";
        const action = event?.action || event?.changeType || "unknown";
        const expression = event?.expression || event?.cronExpression || "";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const sessionKey = ctx?.sessionKey || event?.sessionKey || "unknown";
        const provider = event?.provider || ctx?.provider || "unknown";

        const parentContext = store.getActiveContext(sessionKey)?.agentContext
          || store.getActiveContext(sessionKey)?.rootContext
          || context.active();

        const span = tracer.startSpan(
          "openclaw.cron.changed",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [OC_CRON_JOB_NAME]: jobName,
              [OC_CRON_ACTION]: action,
              [GEN_AI_AGENT_ID]: agentId,
              [GEN_AI_PROVIDER_NAME]: provider,
              ...codeAttrs("cron_changed"),
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        if (expression) {
          span.setAttribute(OC_CRON_EXPRESSION, expression);
        }

        counters.cronChanges.add(1, {
          [OC_CRON_JOB_NAME]: jobName,
          [OC_CRON_ACTION]: action,
        });

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        logger.debug?.(`[otel] Cron changed: job=${jobName}, action=${action}`);
      } catch {
      }

      return undefined;
    },
    { priority: 50 }
  );

  logger.info("[otel] Registered cron_changed hook (via api.on)");

  // ── cron_executed ─────────────────────────────────────────────────
  // Fires when a cron job is executed. Creates a span that tracks the
  // execution and stores context in the cronJob tier of TraceContextStore
  // for child span correlation.

  api.on(
    "cron_executed",
    (event: any, ctx: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return undefined;
        const { tracer, counters, histograms } = tel;

        const jobName = event?.jobName || event?.name || "unknown";
        const trigger = event?.trigger || "scheduled";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const sessionKey = ctx?.sessionKey || event?.sessionKey || "";
        const provider = event?.provider || ctx?.provider || "unknown";
        const success = event?.success !== false;
        const errorMsg = event?.error;
        const durationMs = event?.durationMs;
        const jobKey = event?.jobKey || jobName;

        const parentContext = sessionKey
          ? (store.getActiveContext(sessionKey)?.agentContext
            || store.getActiveContext(sessionKey)?.rootContext
            || context.active())
          : context.active();

        const span = tracer.startSpan(
          `openclaw.cron.exec ${jobName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [OC_CRON_JOB_NAME]: jobName,
              [OC_CRON_TRIGGER]: trigger,
              [OC_CRON_AGENT_ID]: agentId,
              [GEN_AI_AGENT_ID]: agentId,
              [GEN_AI_PROVIDER_NAME]: provider,
              ...codeAttrs("cron_executed"),
            },
          },
          parentContext
        );

        if (sessionKey) {
          span.setAttribute("openclaw.session.key", sessionKey);
        }

        store.setCronJob(jobKey, {
          span,
          context: trace.setSpan(parentContext, span),
          jobName,
          startedAt: Date.now(),
        });

        if (typeof durationMs === "number") {
          span.setAttribute(OC_CRON_DURATION_MS, durationMs);
          histograms.cronDuration.record(durationMs, {
            [OC_CRON_JOB_NAME]: jobName,
            [OC_CRON_TRIGGER]: trigger,
          });
        }

        span.setAttribute(OC_CRON_SUCCESS, success);

        if (errorMsg) {
          const errStr = String(errorMsg).slice(0, 500);
          span.setAttribute(ERROR_TYPE, "cron_error");
          span.recordException({ name: "CronError", message: errStr });
          span.setStatus({ code: SpanStatusCode.ERROR, message: errStr.slice(0, 200) });
          counters.cronErrors.add(1, {
            [OC_CRON_JOB_NAME]: jobName,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        counters.cronExecutions.add(1, {
          [OC_CRON_JOB_NAME]: jobName,
          [OC_CRON_TRIGGER]: trigger,
        });

        if (typeof durationMs === "number") {
          span.end();
          store.deleteCronJob(jobKey);
        }

        logger.debug?.(`[otel] Cron executed: job=${jobName}, trigger=${trigger}, success=${success}`);
      } catch {
      }

      return undefined;
    },
    { priority: 50 }
  );

  logger.info("[otel] Registered cron_executed hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // EVENT-STREAM HOOKS — registered via api.registerHook()
  // ═══════════════════════════════════════════════════════════════════

  // ── Command event hooks ──────────────────────────────────────────

  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return;
        const { tracer, counters } = tel;

        const action = event?.action || "unknown";
        const sessionKey = event?.sessionKey || "unknown";

        // Get parent context if available
        const sessionCtx = store.getActiveContext(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        const span = tracer.startSpan(
          `openclaw.command.${action}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.command.action": action,
              "openclaw.command.session_key": sessionKey,
              "openclaw.command.source": event?.context?.commandSource || "unknown",
            },
          },
          parentContext
        );

        if (action === "new" || action === "reset") {
          counters.sessionResets.add(1, {
            "command.source": event?.context?.commandSource || "unknown",
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore telemetry errors
      }
    },
    {
      name: "otel-command-events",
      description: "Records session command spans via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered command event hooks (via api.registerHook)");

  // ── Gateway startup hook ─────────────────────────────────────────

  api.registerHook(
    "gateway:startup",
    async (event: any) => {
      try {
        const tel = getTelemetry();
        if (!tel) return;
        const { tracer } = tel;

        const span = tracer.startSpan("openclaw.gateway.startup", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.event.type": "gateway",
            "openclaw.event.action": "startup",
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
        // Silently ignore
      }
    },
    {
      name: "otel-gateway-startup",
      description: "Records gateway startup event via OpenTelemetry",
    }
  );

  logger.info("[otel] Registered gateway:startup hook (via api.registerHook)");

  // ── Periodic cleanup ─────────────────────────────────────────────
  // Safety net: clean up stale session contexts (e.g., if agent_end never fires).
  // The handle is returned to the caller so service.stop() can clear it and
  // avoid leaking timers across plugin reload / shutdown.
  const cleanupInterval = setInterval(() => {
    const maxAge = 5 * 60 * 1000;
    const cleaned = store.cleanupStale(maxAge);
    if (cleaned > 0) {
      logger.debug?.(`[otel] Cleaned up ${cleaned} stale trace contexts`);
    }
  }, 60_000);

  return () => {
    clearInterval(cleanupInterval);
  };
}
