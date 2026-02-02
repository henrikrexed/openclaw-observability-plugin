/**
 * OpenClaw event hooks — captures tool executions, session events,
 * and gateway lifecycle as OTel spans + metrics.
 */

import { SpanKind, SpanStatusCode, trace, context } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import type { OtelObservabilityConfig } from "./config.js";

/**
 * Register plugin hooks on the OpenClaw plugin API.
 * These hooks capture tool results and command events as OTel telemetry.
 */
export function registerHooks(
  api: any,
  telemetry: TelemetryRuntime,
  config: OtelObservabilityConfig
): void {
  const { tracer, counters, histograms } = telemetry;

  // ── tool_result_persist hook ─────────────────────────────────────
  // Fires synchronously before a tool result is written to the transcript.
  // We use it to record tool execution spans and metrics.

  api.registerHook("tool_result_persist", (toolResult: any) => {
    try {
      const toolName = toolResult?.name || toolResult?.toolName || "unknown";
      const isError = toolResult?.isError === true;

      // Record metric
      counters.toolCalls.add(1, { "tool.name": toolName });
      if (isError) {
        counters.toolErrors.add(1, { "tool.name": toolName });
      }

      // Create a span for the tool execution
      const span = tracer.startSpan(`tool.${toolName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          "openclaw.tool.name": toolName,
          "openclaw.tool.is_error": isError,
        },
      });

      // If there's duration info, record it
      if (typeof toolResult?.durationMs === "number") {
        span.setAttribute("openclaw.tool.duration_ms", toolResult.durationMs);
        histograms.toolDuration.record(toolResult.durationMs, { "tool.name": toolName });
      }

      // Capture a summary of the result (not the full content for privacy)
      if (toolResult?.content && Array.isArray(toolResult.content)) {
        const textParts = toolResult.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => String(c.text || ""));
        const totalChars = textParts.reduce((sum: number, t: string) => sum + t.length, 0);
        span.setAttribute("openclaw.tool.result_chars", totalChars);
        span.setAttribute("openclaw.tool.result_parts", toolResult.content.length);
      }

      if (isError) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution error" });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
    } catch {
      // Never let telemetry errors break the main flow
    }

    // Return undefined to keep the tool result unchanged
    return undefined;
  });
}

/**
 * Create a hook handler function for command events (session resets, etc.)
 * This returns a HookHandler compatible with OpenClaw's hook system.
 */
export function createCommandHookHandler(telemetry: TelemetryRuntime) {
  return async (event: any) => {
    try {
      const { tracer, counters } = telemetry;

      if (event.type === "command") {
        const span = tracer.startSpan(`openclaw.command.${event.action}`, {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.command.action": event.action,
            "openclaw.command.session_key": event.sessionKey || "unknown",
            "openclaw.command.source": event.context?.commandSource || "unknown",
          },
        });

        if (event.action === "new" || event.action === "reset") {
          counters.sessionResets.add(1, {
            "command.source": event.context?.commandSource || "unknown",
          });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }

      if (event.type === "gateway" && event.action === "startup") {
        const span = tracer.startSpan("openclaw.gateway.startup", {
          kind: SpanKind.INTERNAL,
          attributes: {
            "openclaw.event.type": "gateway",
            "openclaw.event.action": "startup",
          },
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      }
    } catch {
      // Silently ignore telemetry errors
    }
  };
}
