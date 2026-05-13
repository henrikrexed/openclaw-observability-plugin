/**
 * Diagnostic events integration — subscribes to OpenClaw's internal diagnostic
 * events to get accurate cost/token data, then enriches our connected traces.
 *
 * This combines the best of both approaches:
 * - Our plugin: Connected traces (request → agent turn → tools)
 * - Official diagnostics: Accurate cost, token counts, context limits
 */

import type { Span } from "@opentelemetry/api";
import type { TelemetryRuntime } from "./telemetry.js";
import {
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOKEN_TYPE,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  OP_INVOKE_AGENT,
  OC_PROVIDER,
  TOKEN_TYPE_INPUT,
  TOKEN_TYPE_OUTPUT,
} from "./semconv.js";

// Import from OpenClaw plugin SDK (loaded lazily)
let onDiagnosticEvent: ((listener: (evt: any) => void) => () => void) | null = null;
let sdkLoadAttempted = false;

async function loadSdk(): Promise<void> {
  if (sdkLoadAttempted) return;
  sdkLoadAttempted = true;
  try {
    // Dynamic import to avoid build issues if SDK not available
    // @ts-ignore - openclaw/plugin-sdk types not available at build time
    const sdk = await import("openclaw/plugin-sdk") as any;
    onDiagnosticEvent = sdk.onDiagnosticEvent;
  } catch {
    // SDK not available — will use fallback token extraction
  }
}

/** Pending usage data waiting to be attached to spans */
interface PendingUsageData {
  costUsd?: number;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  durationMs?: number;
  provider?: string;
  model?: string;
}

/** Map of sessionKey → pending usage data from diagnostic events */
const pendingUsageMap = new Map<string, PendingUsageData>();

/** Map of sessionKey → active agent span (set by hooks.ts) */
export const activeAgentSpans = new Map<string, Span>();

/**
 * Register diagnostic event listener to capture model.usage events.
 * Returns unsubscribe function.
 */
export async function registerDiagnosticsListener(
  telemetry: TelemetryRuntime,
  logger: any
): Promise<() => void> {
  // Load the SDK if not already loaded
  await loadSdk();

  if (!onDiagnosticEvent) {
    logger.debug?.("[otel] onDiagnosticEvent not available — using fallback token extraction");
    return () => {};
  }

  const { counters, histograms } = telemetry;

  const unsubscribe = onDiagnosticEvent((evt: any) => {
    logger.info(`[otel] diagnostic event received: type=${evt?.type}`);
    
    // ISI-1017: Queue events
    if (evt.type === "queue.lane.enqueue") {
      const { lane, depth, waitMs } = evt;
      const attrs: Record<string, string | number> = {};
      if (lane) attrs["openclaw.queue.lane"] = lane;
      counters.queueLaneEnqueue.add(1, attrs);
      if (typeof depth === "number") histograms.queueDepth.record(depth, attrs);
      if (typeof waitMs === "number") histograms.queueWaitMs.record(waitMs, attrs);
      logger.debug?.(`[otel] queue.lane.enqueue: lane=${lane}, depth=${depth}, waitMs=${waitMs}`);
      return;
    }

    if (evt.type === "queue.lane.dequeue") {
      const { lane, depth } = evt;
      const attrs: Record<string, string | number> = {};
      if (lane) attrs["openclaw.queue.lane"] = lane;
      counters.queueLaneDequeue.add(1, attrs);
      if (typeof depth === "number") histograms.queueDepth.record(depth, attrs);
      logger.debug?.(`[otel] queue.lane.dequeue: lane=${lane}, depth=${depth}`);
      return;
    }

    // ISI-1017: Session events
    if (evt.type === "session.stuck") {
      const { sessionKey, ageMs } = evt;
      const attrs = { "openclaw.session.key": sessionKey || "unknown" };
      counters.sessionStuck.add(1, attrs);
      if (typeof ageMs === "number") histograms.sessionStuckAgeMs.record(ageMs, attrs);
      logger.debug?.(`[otel] session.stuck: session=${sessionKey}, ageMs=${ageMs}`);
      return;
    }

    if (evt.type === "session.long_running") {
      const { sessionKey, ageMs } = evt;
      const attrs = { "openclaw.session.key": sessionKey || "unknown" };
      counters.sessionLongRunning.add(1, attrs);
      logger.debug?.(`[otel] session.long_running: session=${sessionKey}, ageMs=${ageMs}`);
      return;
    }

    if (evt.type === "session.stalled") {
      const { sessionKey, ageMs } = evt;
      const attrs = { "openclaw.session.key": sessionKey || "unknown" };
      counters.sessionStalled.add(1, attrs);
      logger.debug?.(`[otel] session.stalled: session=${sessionKey}, ageMs=${ageMs}`);
      return;
    }

    // ISI-1016: Gateway health metrics from diagnostic events
    if (evt.type === "diagnostic.liveness.warning") {
      const {
        eventLoopDelayP99Ms,
        eventLoopDelayMaxMs,
        eventLoopUtilization,
        cpuCoreRatio,
        active,
        waiting,
        queued,
      } = evt;

      counters.livenessWarnings.add(1, {
        "openclaw.diagnostic.phase": evt.phase || "unknown",
      });

      if (typeof eventLoopDelayP99Ms === "number") {
        histograms.gatewayEventLoopDelayP99.record(eventLoopDelayP99Ms);
      }
      if (typeof eventLoopDelayMaxMs === "number") {
        histograms.gatewayEventLoopDelayMax.record(eventLoopDelayMaxMs);
      }
      if (typeof eventLoopUtilization === "number") {
        histograms.gatewayEventLoopUtilization.record(eventLoopUtilization);
      }
      if (typeof cpuCoreRatio === "number") {
        histograms.gatewayCpuCoreRatio.record(cpuCoreRatio);
      }
      if (typeof queued === "number") {
        histograms.gatewayWorkQueued.record(queued);
      }

      logger.info(
        `[otel] diagnostic.liveness.warning: eventLoopDelayP99Ms=${eventLoopDelayP99Ms}, cpuCoreRatio=${cpuCoreRatio}, queued=${queued}`
      );
      return;
    }

    if (evt.type === "diagnostic.heartbeat") {
      counters.diagnosticHeartbeats.add(1, {
        "openclaw.diagnostic.phase": evt.phase || "unknown",
      });

      // Record queue depth if available
      if (typeof evt.queued === "number") {
        histograms.gatewayWorkQueued.record(evt.queued);
      }

      logger.debug?.(`[otel] diagnostic.heartbeat: webhooks=${evt.webhooks?.received}/${evt.webhooks?.processed}/${evt.webhooks?.errors}`);
      return;
    }

    if (evt.type !== "model.usage") return;

    const sessionKey = evt.sessionKey || "unknown";
    const usage = evt.usage || {};
    const costUsd = evt.costUsd;
    const model = evt.model || "unknown";
    const provider = evt.provider || "unknown";

    // Store for later attachment to agent span
    pendingUsageMap.set(sessionKey, {
      costUsd,
      usage,
      context: evt.context,
      durationMs: evt.durationMs,
      provider,
      model,
    });

    // Record metrics immediately (don't wait for span).
    // Stable GenAI attribute keys only — `gen_ai.system` dropped in schema
    // 1.3.0 (ISI-1004). `openclaw.provider` (legacy mirror) is retained.
    const metricAttrs = {
      [GEN_AI_RESPONSE_MODEL]: model,
      [GEN_AI_PROVIDER_NAME]: provider,
      [GEN_AI_OPERATION_NAME]: OP_INVOKE_AGENT,
      [GEN_AI_CONVERSATION_ID]: sessionKey,
      [OC_PROVIDER]: provider,
    };

    if (usage.input) {
      counters.tokensPrompt.add(usage.input, metricAttrs);
      histograms.genAiTokenUsage.record(usage.input, {
        ...metricAttrs,
        [GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_INPUT,
      });
    }
    if (usage.output) {
      counters.tokensCompletion.add(usage.output, metricAttrs);
      histograms.genAiTokenUsage.record(usage.output, {
        ...metricAttrs,
        [GEN_AI_TOKEN_TYPE]: TOKEN_TYPE_OUTPUT,
      });
    }
    if (usage.cacheRead) {
      counters.tokensPrompt.add(usage.cacheRead, { ...metricAttrs, "token.type": "cache_read" });
    }
    if (usage.cacheWrite) {
      counters.tokensPrompt.add(usage.cacheWrite, { ...metricAttrs, "token.type": "cache_write" });
    }
    if (usage.total) {
      counters.tokensTotal.add(usage.total, metricAttrs);
    }

    // ISI-1018: Token breakdown by type (system, user, tool_result, skill)
    if (usage.system) {
      counters.tokensSystem.add(usage.system, metricAttrs);
    }
    if (usage.user) {
      counters.tokensUser.add(usage.user, metricAttrs);
    }
    if (usage.toolResult) {
      counters.tokensToolResult.add(usage.toolResult, metricAttrs);
    }
    if (usage.skill) {
      counters.tokensSkill.add(usage.skill, metricAttrs);
    }

    // Record cost metric
    if (typeof costUsd === "number" && costUsd > 0) {
      telemetry.meter.createCounter("openclaw.llm.cost.usd", {
        description: "Estimated LLM cost in USD",
        unit: "usd",
      }).add(costUsd, metricAttrs);
    }

    // Record LLM duration — legacy (ms) and stable GenAI (seconds).
    if (typeof evt.durationMs === "number") {
      histograms.llmDuration.record(evt.durationMs, metricAttrs);
      histograms.genAiOperationDuration.record(evt.durationMs / 1000, metricAttrs);
    }

    counters.llmRequests.add(1, metricAttrs);

    // If we have an active agent span for this session, enrich it now
    const agentSpan = activeAgentSpans.get(sessionKey);
    if (agentSpan) {
      enrichSpanWithUsage(agentSpan, evt);
      pendingUsageMap.delete(sessionKey);
    }

    logger.debug?.(`[otel] model.usage: session=${sessionKey}, model=${model}, cost=$${costUsd?.toFixed(4) || "?"}, tokens=${usage.total || "?"}`);
  });

  logger.info("[otel] Subscribed to OpenClaw diagnostic events (model.usage, etc.)");
  return unsubscribe;
}

/**
 * Get pending usage data for a session (if any).
 * Called by agent_end hook to attach data to span.
 */
export function getPendingUsage(sessionKey: string): PendingUsageData | undefined {
  const data = pendingUsageMap.get(sessionKey);
  if (data) {
    pendingUsageMap.delete(sessionKey);
  }
  return data;
}

/**
 * Enrich a span with usage data from diagnostic event.
 */
export function enrichSpanWithUsage(span: Span, data: PendingUsageData): void {
  const usage = data.usage || {};

  // GenAI semantic convention attributes — stable keys only.
  // `gen_ai.usage.total_tokens` and `gen_ai.usage.cache_*_tokens` (legacy)
  // dropped in schema 1.3.0 (ISI-1004).
  if (usage.input !== undefined) {
    span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input);
  }
  if (usage.output !== undefined) {
    span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output);
  }
  if (usage.cacheRead !== undefined) {
    span.setAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cacheRead);
  }
  if (usage.cacheWrite !== undefined) {
    span.setAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cacheWrite);
  }

  // Cost (custom attribute — not in GenAI semconv yet)
  if (data.costUsd !== undefined) {
    span.setAttribute("openclaw.llm.cost_usd", data.costUsd);
  }

  // Context window
  if (data.context?.limit !== undefined) {
    span.setAttribute("openclaw.context.limit", data.context.limit);
  }
  if (data.context?.used !== undefined) {
    span.setAttribute("openclaw.context.used", data.context.used);
  }

  // Provider/model — `gen_ai.provider.name` only (legacy `gen_ai.system`
  // dropped in schema 1.3.0 / ISI-1004).
  if (data.provider) {
    span.setAttribute(GEN_AI_PROVIDER_NAME, data.provider);
  }
  if (data.model) {
    span.setAttribute(GEN_AI_RESPONSE_MODEL, data.model);
  }
}

/**
 * Check if diagnostic events are available.
 * Note: Only accurate after registerDiagnosticsListener() has been called.
 */
export function hasDiagnosticsSupport(): boolean {
  return onDiagnosticEvent !== null;
}

/**
 * Async check for diagnostics support (loads SDK if needed).
 */
export async function checkDiagnosticsSupport(): Promise<boolean> {
  await loadSdk();
  return onDiagnosticEvent !== null;
}
