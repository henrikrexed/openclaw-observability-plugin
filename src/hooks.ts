/**
 * OpenClaw event hooks — captures tool executions, agent turns, messages,
 * and gateway lifecycle as connected OTel traces.
 *
 * Trace structure per request:
 *   openclaw.request (root span, covers full message → reply lifecycle)
 *   ├── openclaw.agent.turn (agent processing span)
 *   │   ├── tool.exec (tool call)
 *   │   ├── tool.Read (tool call)
 *   │   ├── anthropic.chat (auto-instrumented by OpenLLMetry)
 *   │   └── tool.write (tool call)
 *   └── (future: message.sent span)
 *
 * Context propagation:
 *   - message_received: creates root span, stores in sessionContextMap
 *   - before_agent_start: creates child "agent turn" span under root
 *   - tool_result_persist: creates child tool span under agent turn
 *   - agent_end: ends the agent turn span
 *
 * IMPORTANT: OpenClaw has TWO hook registration systems:
 *   - api.registerHook() → event-stream hooks (command:new, gateway:startup)
 *   - api.on()           → typed plugin hooks (tool_result_persist, agent_end)
 */

import { SpanKind, SpanStatusCode, context, trace, type Span, type Context } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";

/** Active trace context for a session — allows connecting spans into one trace. */
interface SessionTraceContext {
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  startTime: number;
}

/** Map of sessionKey → active trace context. Cleaned up on agent_end. */
const sessionContextMap = new Map<string, SessionTraceContext>();

/**
 * Register all plugin hooks on the OpenClaw plugin API.
 */
export function registerHooks(
  api: any,
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig
): void {
  const { tracer, counters, histograms } = telemetry;
  const logger = api.logger;

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
        const channel = event?.channel || "unknown";
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const from = event?.from || event?.senderId || "unknown";

        // Create root span for this request
        const rootSpan = tracer.startSpan("openclaw.request", {
          kind: SpanKind.SERVER,
          attributes: {
            "openclaw.message.channel": channel,
            "openclaw.session.key": sessionKey,
            "openclaw.message.direction": "inbound",
            "openclaw.message.from": from,
          },
        });

        // Store the context so child spans can reference it
        const rootContext = trace.setSpan(context.active(), rootSpan);

        sessionContextMap.set(sessionKey, {
          rootSpan,
          rootContext,
          startTime: Date.now(),
        });

        logger.debug?.(`[otel] Root span started for session=${sessionKey}`);
      } catch {
        // Never let telemetry errors break the main flow
      }
    },
    { priority: 100 } // High priority — run first to establish context
  );

  logger.info("[otel] Registered message_received hook (via api.on)");

  // ── before_agent_start ───────────────────────────────────────────
  // Creates an "agent turn" child span under the root request span.

  api.on(
    "before_agent_start",
    (event: any, ctx: any) => {
      try {
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const model = event?.model || "unknown";

        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.rootContext || context.active();

        // Create agent turn span as child of root span
        const agentSpan = tracer.startSpan(
          "openclaw.agent.turn",
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.agent.id": agentId,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.model": model,
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
          // No root span (e.g., heartbeat) — create a standalone context
          sessionContextMap.set(sessionKey, {
            rootSpan: agentSpan,
            rootContext: agentContext,
            agentSpan,
            agentContext,
            startTime: Date.now(),
          });
        }

        logger.debug?.(`[otel] Agent turn span started: agent=${agentId}, session=${sessionKey}`);
      } catch {
        // Silently ignore
      }

      // Return undefined — don't modify system prompt
      return undefined;
    },
    { priority: 90 }
  );

  logger.info("[otel] Registered before_agent_start hook (via api.on)");

  // ── tool_result_persist ──────────────────────────────────────────
  // Creates a child span under the agent turn span for each tool call.
  // SYNCHRONOUS — must not return a Promise.

  api.on(
    "tool_result_persist",
    (event: any, ctx: any) => {
      try {
        const toolName = event?.toolName || "unknown";
        const toolCallId = event?.toolCallId || "";
        const isSynthetic = event?.isSynthetic === true;
        const sessionKey = ctx?.sessionKey || "unknown";
        const agentId = ctx?.agentId || "unknown";

        // Record metric
        counters.toolCalls.add(1, {
          "tool.name": toolName,
          "session.key": sessionKey,
        });

        // Get parent context — prefer agent turn span, fall back to root
        const sessionCtx = sessionContextMap.get(sessionKey);
        const parentContext = sessionCtx?.agentContext || sessionCtx?.rootContext || context.active();

        // Create tool span as child of agent turn
        const span = tracer.startSpan(
          `tool.${toolName}`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              "openclaw.tool.name": toolName,
              "openclaw.tool.call_id": toolCallId,
              "openclaw.tool.is_synthetic": isSynthetic,
              "openclaw.session.key": sessionKey,
              "openclaw.agent.id": agentId,
            },
          },
          parentContext
        );

        // Inspect the message for result metadata
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

          if (message?.is_error === true || message?.isError === true) {
            counters.toolErrors.add(1, { "tool.name": toolName });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      } catch {
        // Never let telemetry errors break the main flow
      }

      // Return undefined to keep the tool result unchanged
      return undefined;
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered tool_result_persist hook (via api.on)");

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
        const sessionKey = event?.sessionKey || ctx?.sessionKey || "unknown";
        const agentId = event?.agentId || ctx?.agentId || "unknown";
        const durationMs = event?.durationMs;
        const success = event?.success !== false;
        const errorMsg = event?.error;

        // Extract token usage from the messages array
        // Each assistant message has .usage with inputTokens/outputTokens
        const messages: any[] = event?.messages || [];
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let model = "unknown";

        for (const msg of messages) {
          if (msg?.role === "assistant" && msg?.usage) {
            const u = msg.usage;
            if (typeof u.inputTokens === "number") totalInputTokens += u.inputTokens;
            if (typeof u.input_tokens === "number") totalInputTokens += u.input_tokens;
            if (typeof u.outputTokens === "number") totalOutputTokens += u.outputTokens;
            if (typeof u.output_tokens === "number") totalOutputTokens += u.output_tokens;
          }
          // Grab model from the last assistant message
          if (msg?.role === "assistant" && msg?.model) {
            model = msg.model;
          }
        }

        const sessionCtx = sessionContextMap.get(sessionKey);

        // End the agent turn span
        if (sessionCtx?.agentSpan) {
          const agentSpan = sessionCtx.agentSpan;

          if (typeof durationMs === "number") {
            agentSpan.setAttribute("openclaw.agent.duration_ms", durationMs);
            histograms.toolDuration.record(durationMs, {
              "agent.id": agentId,
              "event.type": "agent_turn",
            });
          }

          // Token usage from messages
          agentSpan.setAttribute("gen_ai.usage.input_tokens", totalInputTokens);
          agentSpan.setAttribute("gen_ai.usage.output_tokens", totalOutputTokens);
          agentSpan.setAttribute("gen_ai.usage.total_tokens", totalInputTokens + totalOutputTokens);
          agentSpan.setAttribute("gen_ai.response.model", model);
          agentSpan.setAttribute("openclaw.agent.success", success);

          if (errorMsg) {
            agentSpan.setAttribute("openclaw.agent.error", String(errorMsg).slice(0, 500));
            agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(errorMsg).slice(0, 200) });
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
        sessionContextMap.delete(sessionKey);

        logger.debug?.(`[otel] Trace completed for session=${sessionKey}`);
      } catch {
        // Silently ignore
      }
    },
    { priority: -100 }
  );

  logger.info("[otel] Registered agent_end hook (via api.on)");

  // ═══════════════════════════════════════════════════════════════════
  // EVENT-STREAM HOOKS — registered via api.registerHook()
  // ═══════════════════════════════════════════════════════════════════

  // ── Command event hooks ──────────────────────────────────────────

  api.registerHook(
    ["command:new", "command:reset", "command:stop"],
    async (event: any) => {
      try {
        const action = event?.action || "unknown";
        const sessionKey = event?.sessionKey || "unknown";

        // Get parent context if available
        const sessionCtx = sessionContextMap.get(sessionKey);
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
  // Safety net: clean up stale session contexts (e.g., if agent_end never fires)
  setInterval(() => {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes
    for (const [key, ctx] of sessionContextMap) {
      if (now - ctx.startTime > maxAge) {
        try {
          ctx.agentSpan?.end();
          if (ctx.rootSpan !== ctx.agentSpan) ctx.rootSpan?.end();
        } catch { /* ignore */ }
        sessionContextMap.delete(key);
        logger.debug?.(`[otel] Cleaned up stale trace context for session=${key}`);
      }
    }
  }, 60_000);
}
