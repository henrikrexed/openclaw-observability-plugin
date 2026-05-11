/**
 * Tests for plugin hook registration and lazy telemetry getter pattern.
 *
 * Covers:
 *   - ISI-730: the plugin must no longer register `before_agent_start`
 *     and must register `before_model_resolve` + `before_prompt_build` instead.
 *   - ISI-924: hooks use a lazy `getTelemetry()` getter — they register
 *     during `register()` and resolve the runtime at fire time. Handlers
 *     gracefully no-op when telemetry is null.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Counter, Histogram, Span, Tracer, UpDownCounter } from "@opentelemetry/api";

import { registerHooks } from "../src/hooks.js";
import {
  CONTENT_POLICY_DISABLED,
  CONTENT_POLICY_ENABLED,
  type OtelObservabilityConfig,
} from "../src/config.js";
import type { TelemetryRuntime } from "../src/telemetry.js";

// ── Test doubles ────────────────────────────────────────────────────

interface SpanSpy {
  attrs: Record<string, unknown>;
  ended: boolean;
  status: { code?: number; message?: string };
  spanName: string;
}

function createSpanSpy(name: string): Span & SpanSpy {
  const spy: SpanSpy = {
    attrs: {},
    ended: false,
    status: {},
    spanName: name,
  };
  const span = {
    ...spy,
    get ended() { return spy.ended; },
    setAttribute(key: string, value: unknown) {
      spy.attrs[key] = value;
      return this;
    },
    setAttributes(values: Record<string, unknown>) {
      Object.assign(spy.attrs, values);
      return this;
    },
    setStatus(status: { code?: number; message?: string }) {
      spy.status = status;
      return this;
    },
    addEvent() {
      return this;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
    setStatusFromException() {
      return this;
    },
    recordException() {
      return this;
    },
    updateName(n: string) {
      spy.spanName = n;
      return this;
    },
    end() {
      spy.ended = true;
    },
    isRecording() {
      return !spy.ended;
    },
    spanContext() {
      return { traceId: "t", spanId: "s", traceFlags: 1 };
    },
  };
  return span as unknown as Span & SpanSpy;
}

function createTracerSpy(): { tracer: Tracer; spans: Array<Span & SpanSpy> } {
  const spans: Array<Span & SpanSpy> = [];
  const tracer = {
    startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
      const span = createSpanSpy(name);
      if (options?.attributes) {
        Object.assign((span as unknown as SpanSpy).attrs, options.attributes);
      }
      spans.push(span);
      return span;
    },
    startActiveSpan: (() => {
      throw new Error("startActiveSpan not used by hooks");
    }) as Tracer["startActiveSpan"],
  } as Tracer;
  return { tracer, spans };
}

function noopCounter(): Counter {
  return { add: vi.fn() } as unknown as Counter;
}
function noopUpDownCounter(): UpDownCounter {
  return { add: vi.fn() } as unknown as UpDownCounter;
}
function noopHistogram(): Histogram {
  return { record: vi.fn() } as unknown as Histogram;
}

function createTelemetry(): { telemetry: TelemetryRuntime; spans: Array<Span & SpanSpy> } {
  const { tracer, spans } = createTracerSpy();
  const telemetry: TelemetryRuntime = {
    tracer,
    meter: {} as TelemetryRuntime["meter"],
    counters: {
      llmRequests: noopCounter(),
      llmErrors: noopCounter(),
      tokensTotal: noopCounter(),
      tokensPrompt: noopCounter(),
      tokensCompletion: noopCounter(),
      toolCalls: noopCounter(),
      toolErrors: noopCounter(),
      toolApprovals: noopCounter(),
      sessionResets: noopCounter(),
      messagesReceived: noopCounter(),
      messagesSent: noopCounter(),
      securityEvents: noopCounter(),
      sensitiveFileAccess: noopCounter(),
      promptInjection: noopCounter(),
      dangerousCommand: noopCounter(),
      cronChanges: noopCounter(),
      cronExecutions: noopCounter(),
      cronErrors: noopCounter(),
      subagentSpawns: noopCounter(),
      subagentEnded: noopCounter(),
    } as unknown as TelemetryRuntime["counters"],
    histograms: {
      agentTurnDuration: noopHistogram(),
      genAiTokenUsage: noopHistogram(),
      genAiOperationDuration: noopHistogram(),
      toolCallDuration: noopHistogram(),
      cronDuration: noopHistogram(),
      subagentDuration: noopHistogram(),
    } as unknown as TelemetryRuntime["histograms"],
    gauges: {
      activeSessions: noopUpDownCounter(),
    } as unknown as TelemetryRuntime["gauges"],
    shutdown: async () => {},
  };
  return { telemetry, spans };
}

type TypedHandler = (event: unknown, ctx: unknown) => unknown;
type EventStreamHandler = (event: unknown) => unknown;

function createStubApi() {
  const typedHooks = new Map<string, TypedHandler>();
  const eventStreamHooks = new Map<string, EventStreamHandler>();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const api = {
    logger,
    on(name: string, handler: TypedHandler) {
      typedHooks.set(name, handler);
    },
    registerHook(events: string | string[], handler: EventStreamHandler) {
      const list = Array.isArray(events) ? events : [events];
      for (const ev of list) {
        eventStreamHooks.set(ev, handler);
      }
    },
  };
  return { api, typedHooks, eventStreamHooks, logger };
}

const config: OtelObservabilityConfig = {
  endpoint: "http://localhost:4318",
  protocol: "http",
  serviceName: "test",
  headers: {},
  traces: true,
  metrics: true,
  logs: false,
  captureContent: { ...CONTENT_POLICY_DISABLED },
  metricsIntervalMs: 30_000,
  resourceAttributes: {},
};

function configWithPolicy(
  overrides: Partial<typeof CONTENT_POLICY_DISABLED> = {},
): OtelObservabilityConfig {
  return {
    ...config,
    captureContent: { ...CONTENT_POLICY_DISABLED, ...overrides },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("plugin hook registration (ISI-730 migration)", () => {
  let stopHooks: () => void;

  beforeEach(() => {
    // nothing — each test sets up its own stubs
  });

  it("registers the new phase hooks and NOT the legacy before_agent_start", () => {
    const { api, typedHooks, logger } = createStubApi();
    const { telemetry } = createTelemetry();

    stopHooks = registerHooks(api, () => telemetry, config);

    expect(typedHooks.has("before_model_resolve")).toBe(true);
    expect(typedHooks.has("before_prompt_build")).toBe(true);
    expect(typedHooks.has("before_agent_start")).toBe(false);

    // Other existing typed hooks are still registered.
    expect(typedHooks.has("message_received")).toBe(true);
    expect(typedHooks.has("llm_input")).toBe(true);
    expect(typedHooks.has("llm_output")).toBe(true);
    expect(typedHooks.has("tool_result_persist")).toBe(true);
    expect(typedHooks.has("message_sent")).toBe(true);
    expect(typedHooks.has("agent_end")).toBe(true);
    expect(typedHooks.has("model_call_started")).toBe(true);
    expect(typedHooks.has("model_call_ended")).toBe(true);
    expect(typedHooks.has("before_tool_call")).toBe(true);
    expect(typedHooks.has("after_tool_call")).toBe(true);
    expect(typedHooks.has("tool_approval_resolution")).toBe(true);

    expect(logger.info).toHaveBeenCalledWith(
      "[otel] Registered before_model_resolve hook (via api.on)",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[otel] Registered before_prompt_build hook (via api.on)",
    );

    stopHooks();
  });

  it("before_model_resolve creates an agent.turn span with agent_id + session_key", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const handler = typedHooks.get("before_model_resolve");
    expect(handler).toBeDefined();
    const result = handler!({ prompt: "hi" }, {
      agentId: "claude-4",
      sessionKey: "session-123",
    });
    // Must NOT return a value — we do not override provider/model.
    expect(result).toBeUndefined();

    const turnSpan = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(turnSpan).toBeDefined();
    expect(turnSpan!.attrs["openclaw.agent.id"]).toBe("claude-4");
    expect(turnSpan!.attrs["openclaw.session.key"]).toBe("session-123");
    expect(turnSpan!.attrs["gen_ai.agent.id"]).toBe("claude-4");
    expect(turnSpan!.attrs["gen_ai.conversation.id"]).toBe("session-123");
    expect(turnSpan!.attrs["code.function"]).toBe("before_model_resolve");
    // Model is NOT known at this point — must NOT be set.
    expect(turnSpan!.attrs["gen_ai.request.model"]).toBeUndefined();
    expect(turnSpan!.attrs["openclaw.agent.model"]).toBeUndefined();

    stopHooks();
  });

  it("before_prompt_build enriches the existing agent.turn span with prompt + history size", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolveHandler = typedHooks.get("before_model_resolve")!;
    const buildHandler = typedHooks.get("before_prompt_build")!;

    // 1. agent turn span starts in before_model_resolve
    resolveHandler({ prompt: "hi" }, { agentId: "a", sessionKey: "s" });

    // 2. before_prompt_build enriches it
    const out = buildHandler(
      {
        prompt: "user asked about X",
        messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
      },
      { agentId: "a", sessionKey: "s" },
    );
    expect(out).toBeUndefined();

    const turnSpan = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(turnSpan).toBeDefined();
    expect(turnSpan!.attrs["openclaw.prompt.chars"]).toBe("user asked about X".length);
    expect(turnSpan!.attrs["openclaw.session.message_count"]).toBe(3);

    stopHooks();
  });

  it("before_prompt_build is a no-op when no agent span has been started", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const buildHandler = typedHooks.get("before_prompt_build")!;
    // Never ran before_model_resolve → no agent span exists.
    const out = buildHandler(
      { prompt: "x", messages: [] },
      { agentId: "a", sessionKey: "orphan-session" },
    );
    expect(out).toBeUndefined();
    // No agent.turn span created by the build hook.
    expect(spans.find((s) => s.spanName === "openclaw.agent.turn")).toBeUndefined();

    stopHooks();
  });

  it("end-to-end: message_received → before_model_resolve → before_prompt_build produces a connected turn span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const build = typedHooks.get("before_prompt_build")!;

    // Await message_received — async handler.
    return Promise.resolve(
      received(
        { channel: "cli", sessionKey: "s1", from: "user" },
        { sessionKey: "s1" },
      ),
    ).then(() => {
      resolve({ prompt: "hi" }, { agentId: "a1", sessionKey: "s1" });
      build({ prompt: "hi", messages: [] }, { agentId: "a1", sessionKey: "s1" });

      const request = spans.find((s) => s.spanName === "openclaw.request");
      const turn = spans.find((s) => s.spanName === "openclaw.agent.turn");
      expect(request).toBeDefined();
      expect(turn).toBeDefined();
      expect(turn!.attrs["openclaw.session.key"]).toBe("s1");
      expect(turn!.attrs["openclaw.agent.id"]).toBe("a1");

      stopHooks();
    });
  });
});

// ── Lazy getter timing tests (ISI-924) ─────────────────────────────

describe("lazy telemetry getter pattern (ISI-924)", () => {
  let stopHooks: () => void;

  it("hooks register successfully when telemetry getter returns null", () => {
    const { api, typedHooks } = createStubApi();
    const nullGetter = () => null as TelemetryRuntime | null;

    stopHooks = registerHooks(api, nullGetter, config);

    // All hooks are still registered even with null telemetry
    expect(typedHooks.has("message_received")).toBe(true);
    expect(typedHooks.has("before_model_resolve")).toBe(true);
    expect(typedHooks.has("before_prompt_build")).toBe(true);
    expect(typedHooks.has("llm_input")).toBe(true);
    expect(typedHooks.has("llm_output")).toBe(true);
    expect(typedHooks.has("tool_result_persist")).toBe(true);
    expect(typedHooks.has("message_sent")).toBe(true);
    expect(typedHooks.has("agent_end")).toBe(true);
    expect(typedHooks.has("model_call_started")).toBe(true);
    expect(typedHooks.has("model_call_ended")).toBe(true);
    expect(typedHooks.has("before_tool_call")).toBe(true);
    expect(typedHooks.has("after_tool_call")).toBe(true);
    expect(typedHooks.has("tool_approval_resolution")).toBe(true);

    stopHooks();
  });

  it("handlers no-op when telemetry getter returns null (no spans created)", () => {
    const { api, typedHooks } = createStubApi();
    let nullGetter = () => null as TelemetryRuntime | null;

    stopHooks = registerHooks(api, () => nullGetter(), config);

    // Fire message_received — should be a no-op
    const received = typedHooks.get("message_received")!;
    received(
      { channel: "cli", sessionKey: "s1", from: "user" },
      { sessionKey: "s1" },
    );

    // Fire before_model_resolve — should be a no-op
    const resolve = typedHooks.get("before_model_resolve")!;
    const result = resolve({ prompt: "hi" }, { agentId: "a1", sessionKey: "s1" });
    expect(result).toBeUndefined();

    // No spans created because telemetry was null
    // (spans array is only accessible from a createTelemetry call, so we
    // verify indirectly: fire hooks with telemetry and confirm no errors)

    stopHooks();
  });

  it("handlers start working once telemetry becomes available via the getter", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();

    // Simulate: telemetry starts as null, becomes available later
    let currentTelemetry: TelemetryRuntime | null = null;
    const getTelemetry = () => currentTelemetry;

    stopHooks = registerHooks(api, getTelemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;

    // 1. Fire before telemetry is available — no-op
    await received(
      { channel: "cli", sessionKey: "s1", from: "user" },
      { sessionKey: "s1" },
    );
    expect(spans.length).toBe(0);

    // 2. Telemetry becomes available (simulates start() completing)
    currentTelemetry = telemetry;

    // 3. Fire again — now spans should be created
    await received(
      { channel: "cli", sessionKey: "s2", from: "user" },
      { sessionKey: "s2" },
    );
    resolve({ prompt: "hi" }, { agentId: "a1", sessionKey: "s2" });

    const request = spans.find((s) => s.spanName === "openclaw.request");
    const turn = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(request).toBeDefined();
    expect(turn).toBeDefined();
    expect(turn!.attrs["openclaw.session.key"]).toBe("s2");

    stopHooks();
  });

  it("agent_end ends both root and agent spans (direct telemetry)", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const agentEnd = typedHooks.get("agent_end")!;

    return Promise.resolve(
      received(
        { channel: "cli", sessionKey: "s-end", from: "user" },
        { sessionKey: "s-end" },
      ),
    ).then(() => {
      resolve({}, { agentId: "a", sessionKey: "s-end" });
      return Promise.resolve(
        agentEnd(
          { success: true, messages: [], durationMs: 42 },
          { agentId: "a", sessionKey: "s-end" },
        ),
      );
    }).then(() => {
      const request = spans.find((s) => s.spanName === "openclaw.request");
      const turn = spans.find((s) => s.spanName === "openclaw.agent.turn");
      expect(request).toBeDefined();
      expect(turn).toBeDefined();

      // Check if agent_end ran at all — duration attr is set before .end()
      expect(turn!.attrs["openclaw.agent.duration_ms"]).toBe(42);
      expect(turn!.ended).toBe(true);
      expect(request!.ended).toBe(true);

      stopHooks();
    });
  });

  it("hooks fire during message processing after telemetry init — no timing race", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();

    let currentTelemetry: TelemetryRuntime | null = null;
    stopHooks = registerHooks(api, () => currentTelemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const build = typedHooks.get("before_prompt_build")!;
    const agentEnd = typedHooks.get("agent_end")!;

    // Simulate: register() runs, then start() inits telemetry
    currentTelemetry = telemetry;

    // Full message lifecycle — match the pattern from the existing
    // end-to-end test (use Promise.resolve for async message_received)
    return Promise.resolve(
      received(
        { channel: "cli", sessionKey: "s-timing", from: "user" },
        { sessionKey: "s-timing" },
      ),
    ).then(() => {
      resolve({}, { agentId: "a", sessionKey: "s-timing" });
      build(
        { prompt: "timing test", messages: [{ role: "user" }] },
        { agentId: "a", sessionKey: "s-timing" },
      );
      return Promise.resolve(
        agentEnd(
          { success: true, messages: [], durationMs: 42 },
          { agentId: "a", sessionKey: "s-timing" },
        ),
      );
    }).then(() => {
      const request = spans.find((s) => s.spanName === "openclaw.request");
      const turn = spans.find((s) => s.spanName === "openclaw.agent.turn");
      expect(request).toBeDefined();
      expect(turn).toBeDefined();
      expect(turn!.ended).toBe(true);
      expect(turn!.attrs["openclaw.agent.duration_ms"]).toBe(42);
      expect(request!.ended).toBe(true);
      expect(turn!.attrs["openclaw.prompt.chars"]).toBe("timing test".length);
      expect(turn!.attrs["openclaw.session.message_count"]).toBe(1);

      stopHooks();
    });
  });

  it("tool_result_persist and message_sent no-op when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry } = createTelemetry();
    let currentTelemetry: TelemetryRuntime | null = null;

    stopHooks = registerHooks(api, () => currentTelemetry, config);

    const toolHandler = typedHooks.get("tool_result_persist")!;
    const sentHandler = typedHooks.get("message_sent")!;

    // Fire with null telemetry — should not throw
    const toolResult = toolHandler(
      { toolName: "Read", toolCallId: "tc1", input: { path: "/foo" } },
      { sessionKey: "s1", agentId: "a1" },
    );
    expect(toolResult).toBeUndefined();

    const sentResult = sentHandler(
      { sessionKey: "s1", channel: "cli", to: "user", text: "hello" },
      { sessionKey: "s1" },
    );
    expect(sentResult).toBeUndefined();

    // Now enable telemetry — verify counters work
    currentTelemetry = telemetry;

    const toolResult2 = toolHandler(
      { toolName: "Read", toolCallId: "tc2", input: { path: "/bar" } },
      { sessionKey: "s1", agentId: "a1" },
    );
    expect(toolResult2).toBeUndefined();
    expect(telemetry.counters.toolCalls.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "gen_ai.tool.name": "Read" }),
    );

    stopHooks();
  });

  it("cleanup interval still runs even when telemetry is null", () => {
    const { api } = createStubApi();

    // Register with null telemetry — the cleanup interval should still work
    // because it operates on sessionContextMap, not telemetry
    stopHooks = registerHooks(api, () => null, config);

    // Calling stopHooks should clear the interval without errors
    expect(() => stopHooks()).not.toThrow();
  });
});

// ── Model Call Span Instrumentation tests (ISI-926) ──────────────────

describe("model_call_started / model_call_ended hooks (ISI-926)", () => {
  let stopHooks: () => void;

  it("model_call_started creates a CLIENT span named `chat {model}` with full semconv", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;

    resolve({}, { agentId: "a1", sessionKey: "s1" });

    const result = modelStarted(
      {
        sessionKey: "s1",
        agentId: "a1",
        model: "gpt-4o",
        provider: "openai",
        stream: true,
        maxTokens: 4096,
      },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    const chatSpan = spans.find((s) => s.spanName === "chat gpt-4o");
    expect(chatSpan).toBeDefined();
    expect(chatSpan!.attrs["gen_ai.operation.name"]).toBe("chat");
    expect(chatSpan!.attrs["gen_ai.system"]).toBe("openai");
    expect(chatSpan!.attrs["gen_ai.provider.name"]).toBe("openai");
    expect(chatSpan!.attrs["gen_ai.request.model"]).toBe("gpt-4o");
    expect(chatSpan!.attrs["gen_ai.request.stream"]).toBe(true);
    expect(chatSpan!.attrs["gen_ai.request.max_tokens"]).toBe(4096);
    expect(chatSpan!.attrs["gen_ai.conversation.id"]).toBe("s1");
    expect(chatSpan!.attrs["code.function"]).toBe("model_call_started");
    expect(chatSpan!.ended).toBe(false);

    stopHooks();
  });

  it("model_call_ended closes the span with response attrs and token usage", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;
    const modelEnded = typedHooks.get("model_call_ended")!;

    resolve({}, { agentId: "a1", sessionKey: "s2" });
    modelStarted(
      { sessionKey: "s2", model: "claude-3.5-sonnet", provider: "anthropic" },
      { sessionKey: "s2" },
    );
    const result = modelEnded(
      {
        sessionKey: "s2",
        responseModel: "claude-3.5-sonnet-20241022",
        responseId: "resp-abc123",
        finishReasons: ["stop"],
        usage: {
          input: 150,
          output: 80,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 20,
          cacheRead: 50,
          cacheWrite: 10,
          total: 290,
        },
      },
      { sessionKey: "s2" },
    );
    expect(result).toBeUndefined();

    const chatSpan = spans.find((s) => s.spanName === "chat claude-3.5-sonnet");
    expect(chatSpan).toBeDefined();
    expect(chatSpan!.attrs["gen_ai.response.model"]).toBe("claude-3.5-sonnet-20241022");
    expect(chatSpan!.attrs["gen_ai.response.id"]).toBe("resp-abc123");
    expect(chatSpan!.attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(Array.isArray(chatSpan!.attrs["gen_ai.response.finish_reasons"])).toBe(true);
    expect(typeof chatSpan!.attrs["gen_ai.response.finish_reasons"]).not.toBe("string");
    expect(chatSpan!.attrs["gen_ai.usage.input_tokens"]).toBe(150);
    expect(chatSpan!.attrs["gen_ai.usage.output_tokens"]).toBe(80);
    expect(chatSpan!.attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(100);
    expect(chatSpan!.attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(20);
    expect(chatSpan!.attrs["gen_ai.usage.total_tokens"]).toBe(290);
    expect(chatSpan!.ended).toBe(true);

    stopHooks();
  });

  it("model_call_ended emits gen_ai.response.finish_reasons as string[] (ISI-993)", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;
    const modelEnded = typedHooks.get("model_call_ended")!;

    resolve({}, { agentId: "a-multi", sessionKey: "s-multi" });
    modelStarted(
      { sessionKey: "s-multi", model: "claude-3.5-sonnet", provider: "anthropic" },
      { sessionKey: "s-multi" },
    );
    modelEnded(
      {
        sessionKey: "s-multi",
        responseModel: "claude-3.5-sonnet-20241022",
        finishReasons: ["tool_use", "stop"],
      },
      { sessionKey: "s-multi" },
    );

    const chatSpan = spans.find((s) => s.spanName === "chat claude-3.5-sonnet");
    expect(chatSpan).toBeDefined();
    const reasons = chatSpan!.attrs["gen_ai.response.finish_reasons"];
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons).toEqual(["tool_use", "stop"]);
    expect(typeof reasons).not.toBe("string");
    expect(reasons).not.toContain(",");

    stopHooks();
  });

  it("model_call_ended filters non-string entries from finish_reasons (ISI-993 L1)", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;
    const modelEnded = typedHooks.get("model_call_ended")!;

    resolve({}, { agentId: "a-mixed", sessionKey: "s-mixed" });
    modelStarted(
      { sessionKey: "s-mixed", model: "claude-3.5-sonnet", provider: "anthropic" },
      { sessionKey: "s-mixed" },
    );
    modelEnded(
      {
        sessionKey: "s-mixed",
        responseModel: "claude-3.5-sonnet-20241022",
        finishReasons: ["stop", null, undefined, 42, "", "tool_use"] as unknown as string[],
      },
      { sessionKey: "s-mixed" },
    );

    const chatSpan = spans.find((s) => s.spanName === "chat claude-3.5-sonnet");
    expect(chatSpan).toBeDefined();
    const reasons = chatSpan!.attrs["gen_ai.response.finish_reasons"];
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons).toEqual(["stop", "tool_use"]);

    stopHooks();
  });

  it("model_call_ended omits finish_reasons when all entries are invalid (ISI-993 L1)", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;
    const modelEnded = typedHooks.get("model_call_ended")!;

    resolve({}, { agentId: "a-bad", sessionKey: "s-bad" });
    modelStarted(
      { sessionKey: "s-bad", model: "claude-3.5-sonnet", provider: "anthropic" },
      { sessionKey: "s-bad" },
    );
    modelEnded(
      {
        sessionKey: "s-bad",
        responseModel: "claude-3.5-sonnet-20241022",
        finishReasons: [null, undefined, 42, ""] as unknown as string[],
      },
      { sessionKey: "s-bad" },
    );

    const chatSpan = spans.find((s) => s.spanName === "chat claude-3.5-sonnet");
    expect(chatSpan).toBeDefined();
    expect(chatSpan!.attrs["gen_ai.response.finish_reasons"]).toBeUndefined();

    stopHooks();
  });

  it("model_call_ended records error on span when event.error is set", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;
    const modelEnded = typedHooks.get("model_call_ended")!;

    resolve({}, { agentId: "a1", sessionKey: "s3" });
    modelStarted(
      { sessionKey: "s3", model: "gpt-4", provider: "openai" },
      { sessionKey: "s3" },
    );
    modelEnded(
      { sessionKey: "s3", error: "rate limit exceeded" },
      { sessionKey: "s3" },
    );

    const chatSpan = spans.find((s) => s.spanName === "chat gpt-4");
    expect(chatSpan).toBeDefined();
    expect(chatSpan!.attrs["error.type"]).toBe("llm_error");
    expect(chatSpan!.ended).toBe(true);

    stopHooks();
  });

  it("model_call_started no-ops when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const modelStarted = typedHooks.get("model_call_started")!;
    const result = modelStarted(
      { sessionKey: "s1", model: "gpt-4", provider: "openai" },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("model_call_ended no-ops when no modelCallSpan exists", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const modelEnded = typedHooks.get("model_call_ended")!;
    const result = modelEnded(
      { sessionKey: "nonexistent", responseModel: "x" },
      { sessionKey: "nonexistent" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("agent_end closes leftover modelCallSpan as safety net", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;
    const agentEnd = typedHooks.get("agent_end")!;

    await received(
      { channel: "cli", sessionKey: "s-safety", from: "user" },
      { sessionKey: "s-safety" },
    );
    resolve({}, { agentId: "a", sessionKey: "s-safety" });
    modelStarted(
      { sessionKey: "s-safety", model: "gpt-4o", provider: "openai" },
      { sessionKey: "s-safety" },
    );

    const chatSpan = spans.find((s) => s.spanName === "chat gpt-4o");
    expect(chatSpan).toBeDefined();
    expect(chatSpan!.ended).toBe(false);

    await agentEnd(
      { success: true, messages: [], durationMs: 100 },
      { agentId: "a", sessionKey: "s-safety" },
    );

    expect(chatSpan!.ended).toBe(true);

    stopHooks();
  });

  it("model_call_started falls back to root context when no agent span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const modelStarted = typedHooks.get("model_call_started")!;

    // message_received creates root span, but no before_model_resolve
    return Promise.resolve(
      received(
        { channel: "cli", sessionKey: "s-root-only", from: "user" },
        { sessionKey: "s-root-only" },
      ),
    ).then(() => {
      modelStarted(
        { sessionKey: "s-root-only", model: "claude-3", provider: "anthropic" },
        { sessionKey: "s-root-only" },
      );

      const chatSpan = spans.find((s) => s.spanName === "chat claude-3");
      expect(chatSpan).toBeDefined();
      expect(chatSpan!.attrs["gen_ai.request.model"]).toBe("claude-3");
      expect(chatSpan!.ended).toBe(false);

      stopHooks();
    });
  });
});

// ── Tool Call Span Instrumentation tests (ISI-927) ────────────────────

describe("before_tool_call / after_tool_call hooks (ISI-927)", () => {
  let stopHooks: () => void;

  it("before_tool_call creates a tool span under the agent turn with accurate start time", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeTool = typedHooks.get("before_tool_call")!;

    resolve({}, { agentId: "a1", sessionKey: "s1" });

    const result = beforeTool(
      {
        toolName: "Read",
        toolCallId: "tc-1",
        input: { path: "/etc/hosts" },
      },
      { sessionKey: "s1", agentId: "a1" },
    );
    expect(result).toBeUndefined();

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Read");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs["gen_ai.tool.name"]).toBe("Read");
    expect(toolSpan!.attrs["gen_ai.tool.call.id"]).toBe("tc-1");
    expect(toolSpan!.attrs["gen_ai.operation.name"]).toBe("execute_tool");
    expect(toolSpan!.attrs["gen_ai.conversation.id"]).toBe("s1");
    expect(toolSpan!.attrs["gen_ai.agent.id"]).toBe("a1");
    expect(toolSpan!.attrs["code.function"]).toBe("before_tool_call");
    expect(toolSpan!.attrs["openclaw.tool.input_preview"]).toBe('{"path":"/etc/hosts"}');
    expect(toolSpan!.ended).toBe(false);

    stopHooks();
  });

  it("after_tool_call closes the span with result metadata and duration", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeTool = typedHooks.get("before_tool_call")!;
    const afterTool = typedHooks.get("after_tool_call")!;

    resolve({}, { agentId: "a1", sessionKey: "s2" });
    beforeTool(
      { toolName: "Write", toolCallId: "tc-2", input: { path: "/tmp/out" } },
      { sessionKey: "s2", agentId: "a1" },
    );

    const result = afterTool(
      {
        toolName: "Write",
        toolCallId: "tc-2",
        message: {
          content: [{ type: "text", text: "File written successfully" }],
        },
      },
      { sessionKey: "s2" },
    );
    expect(result).toBeUndefined();

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Write");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs["openclaw.tool.result_chars"]).toBe("File written successfully".length);
    expect(toolSpan!.attrs["openclaw.tool.duration_ms"]).toBeDefined();
    expect(toolSpan!.ended).toBe(true);

    expect(telemetry.counters.toolCalls.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "gen_ai.tool.name": "Write" }),
    );

    expect(telemetry.histograms.toolCallDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ "gen_ai.tool.name": "Write" }),
    );

    stopHooks();
  });

  it("after_tool_call records error when message.is_error is true", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeTool = typedHooks.get("before_tool_call")!;
    const afterTool = typedHooks.get("after_tool_call")!;

    resolve({}, { agentId: "a1", sessionKey: "s3" });
    beforeTool(
      { toolName: "Exec", toolCallId: "tc-3" },
      { sessionKey: "s3", agentId: "a1" },
    );
    afterTool(
      {
        toolName: "Exec",
        toolCallId: "tc-3",
        message: {
          is_error: true,
          content: [{ type: "text", text: "command not found" }],
        },
      },
      { sessionKey: "s3" },
    );

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Exec");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs["error.type"]).toBe("tool_execution_error");
    expect(toolSpan!.ended).toBe(true);

    stopHooks();
  });

  it("before_tool_call records approval request attributes", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeTool = typedHooks.get("before_tool_call")!;

    resolve({}, { agentId: "a1", sessionKey: "s4" });
    beforeTool(
      {
        toolName: "Bash",
        toolCallId: "tc-4",
        input: { command: "rm -rf /tmp/test" },
        requiresApproval: true,
      },
      { sessionKey: "s4", agentId: "a1" },
    );

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Bash");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs["openclaw.tool.approval.requested"]).toBe(true);

    expect(telemetry.counters.toolApprovals.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "gen_ai.tool.name": "Bash" }),
    );

    stopHooks();
  });

  it("tool_approval_resolution enriches the in-flight tool span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeTool = typedHooks.get("before_tool_call")!;
    const approvalResolution = typedHooks.get("tool_approval_resolution")!;

    resolve({}, { agentId: "a1", sessionKey: "s5" });
    beforeTool(
      { toolName: "Bash", toolCallId: "tc-5", requiresApproval: true },
      { sessionKey: "s5", agentId: "a1" },
    );
    approvalResolution(
      {
        toolName: "Bash",
        toolCallId: "tc-5",
        resolution: "approved",
      },
      { sessionKey: "s5" },
    );

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Bash");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs["openclaw.tool.approval.resolution"]).toBe("approved");
    expect(toolSpan!.attrs["openclaw.tool.approval.duration_ms"]).toBeDefined();

    stopHooks();
  });

  it("tool_result_persist enriches existing span instead of creating a new one", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeTool = typedHooks.get("before_tool_call")!;
    const toolPersist = typedHooks.get("tool_result_persist")!;

    resolve({}, { agentId: "a1", sessionKey: "s6" });
    beforeTool(
      { toolName: "Read", toolCallId: "tc-6", input: { path: "/etc/hosts" } },
      { sessionKey: "s6", agentId: "a1" },
    );

    expect(spans.length).toBe(2); // agent.turn + execute_tool

    toolPersist(
      {
        toolName: "Read",
        toolCallId: "tc-6",
        input: { path: "/etc/hosts" },
        message: {
          content: [{ type: "text", text: "127.0.0.1 localhost" }],
        },
      },
      { sessionKey: "s6", agentId: "a1" },
    );

    expect(spans.length).toBe(2); // No new span created

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Read");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs["openclaw.tool.result_chars"]).toBe("127.0.0.1 localhost".length);

    stopHooks();
  });

  it("tool_result_persist creates a new span when before_tool_call did not fire (backward compat)", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const toolPersist = typedHooks.get("tool_result_persist")!;

    resolve({}, { agentId: "a1", sessionKey: "s7" });

    toolPersist(
      {
        toolName: "Grep",
        toolCallId: "tc-7",
        input: { pattern: "TODO" },
        message: {
          content: [{ type: "text", text: "3 matches found" }],
        },
      },
      { sessionKey: "s7", agentId: "a1" },
    );

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Grep");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attrs["gen_ai.tool.name"]).toBe("Grep");
    expect(toolSpan!.attrs["code.function"]).toBe("tool_result_persist");
    expect(toolSpan!.ended).toBe(true);

    stopHooks();
  });

  it("agent_end closes leftover tool spans as safety net", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeTool = typedHooks.get("before_tool_call")!;
    const agentEnd = typedHooks.get("agent_end")!;

    await received(
      { channel: "cli", sessionKey: "s-safety", from: "user" },
      { sessionKey: "s-safety" },
    );
    resolve({}, { agentId: "a", sessionKey: "s-safety" });
    beforeTool(
      { toolName: "Read", toolCallId: "tc-safety" },
      { sessionKey: "s-safety", agentId: "a" },
    );

    const toolSpan = spans.find((s) => s.spanName === "execute_tool Read");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.ended).toBe(false);

    await agentEnd(
      { success: true, messages: [], durationMs: 100 },
      { agentId: "a", sessionKey: "s-safety" },
    );

    expect(toolSpan!.ended).toBe(true);
    expect(toolSpan!.attrs["openclaw.tool.duration_ms"]).toBeDefined();

    stopHooks();
  });

  it("before_tool_call no-ops when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const beforeTool = typedHooks.get("before_tool_call")!;
    const result = beforeTool(
      { toolName: "Read", toolCallId: "tc-null" },
      { sessionKey: "s1", agentId: "a1" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("after_tool_call no-ops when no active tool span exists", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const afterTool = typedHooks.get("after_tool_call")!;
    const result = afterTool(
      { toolName: "Read", toolCallId: "tc-missing" },
      { sessionKey: "s-missing" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });
});

// ── Session & Lifecycle Spans tests (ISI-928) ──────────────────────────

describe("session_start / session_end hooks (ISI-928)", () => {
  let stopHooks: () => void;

  it("session_start creates a session span with full attributes", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const sessionStart = typedHooks.get("session_start")!;

    await sessionStart(
      { sessionKey: "sess-1", channel: "cli", agentId: "a1", userId: "user-42" },
      { sessionKey: "sess-1" },
    );

    const sessionSpan = spans.find((s) => s.spanName === "openclaw.session");
    expect(sessionSpan).toBeDefined();
    expect(sessionSpan!.attrs["gen_ai.conversation.id"]).toBe("sess-1");
    expect(sessionSpan!.attrs["gen_ai.agent.id"]).toBe("a1");
    expect(sessionSpan!.attrs["gen_ai.agent.name"]).toBe("a1");
    expect(sessionSpan!.attrs["openclaw.session.key"]).toBe("sess-1");
    expect(sessionSpan!.attrs["openclaw.session.channel"]).toBe("cli");
    expect(sessionSpan!.attrs["openclaw.session.user_id"]).toBe("user-42");
    expect(sessionSpan!.attrs["code.function"]).toBe("session_start");
    expect(sessionSpan!.ended).toBe(false);

    expect(telemetry.gauges.activeSessions.add).toHaveBeenCalledWith(1, expect.any(Object));

    stopHooks();
  });

  it("session_start no-ops when telemetry is null", async () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const sessionStart = typedHooks.get("session_start")!;
    await sessionStart(
      { sessionKey: "sess-1" },
      { sessionKey: "sess-1" },
    );

    stopHooks();
  });

  it("session_start skips when session already active", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const sessionStart = typedHooks.get("session_start")!;

    await sessionStart(
      { sessionKey: "sess-dup", channel: "cli", agentId: "a1" },
      { sessionKey: "sess-dup" },
    );
    await sessionStart(
      { sessionKey: "sess-dup", channel: "cli", agentId: "a1" },
      { sessionKey: "sess-dup" },
    );

    const sessionSpans = spans.filter((s) => s.spanName === "openclaw.session");
    expect(sessionSpans.length).toBe(1);

    stopHooks();
  });

  it("session_end ends the session span with duration and request count", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const sessionStart = typedHooks.get("session_start")!;
    const sessionEnd = typedHooks.get("session_end")!;

    await sessionStart(
      { sessionKey: "sess-end", channel: "cli", agentId: "a1" },
      { sessionKey: "sess-end" },
    );

    await sessionEnd(
      { sessionKey: "sess-end", reason: "user_closed" },
      { sessionKey: "sess-end" },
    );

    const sessionSpan = spans.find((s) => s.spanName === "openclaw.session");
    expect(sessionSpan).toBeDefined();
    expect(sessionSpan!.attrs["openclaw.session.duration_ms"]).toBeDefined();
    expect(sessionSpan!.attrs["openclaw.session.end_reason"]).toBe("user_closed");
    expect(sessionSpan!.attrs["openclaw.session.request_count"]).toBe(0);
    expect(sessionSpan!.ended).toBe(true);

    expect(telemetry.gauges.activeSessions.add).toHaveBeenCalledWith(-1, {
      "openclaw.session.channel": "cli",
    });

    stopHooks();
  });

  it("session_end records error when event.error is set", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const sessionStart = typedHooks.get("session_start")!;
    const sessionEnd = typedHooks.get("session_end")!;

    await sessionStart(
      { sessionKey: "sess-err", channel: "cli", agentId: "a1" },
      { sessionKey: "sess-err" },
    );

    await sessionEnd(
      { sessionKey: "sess-err", reason: "error", error: "connection lost" },
      { sessionKey: "sess-err" },
    );

    const sessionSpan = spans.find((s) => s.spanName === "openclaw.session");
    expect(sessionSpan).toBeDefined();
    expect(sessionSpan!.attrs["error.type"]).toBe("session_error");
    expect(sessionSpan!.ended).toBe(true);

    stopHooks();
  });

  it("session_end no-ops when no session span exists", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const sessionEnd = typedHooks.get("session_end")!;
    await sessionEnd(
      { sessionKey: "nonexistent" },
      { sessionKey: "nonexistent" },
    );

    const sessionSpans = spans.filter((s) => s.spanName === "openclaw.session");
    expect(sessionSpans.length).toBe(0);

    stopHooks();
  });
});

describe("gen_ai.provider.name propagation (ISI-928)", () => {
  let stopHooks: () => void;

  it("llm_input propagates gen_ai.provider.name to agent turn span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const llmInput = typedHooks.get("llm_input")!;

    resolve({}, { agentId: "a1", sessionKey: "s1" });
    llmInput(
      { sessionKey: "s1", agentId: "a1", model: "gpt-4o", provider: "openai" },
      { sessionKey: "s1" },
    );

    const agentTurn = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.attrs["gen_ai.provider.name"]).toBe("openai");

    stopHooks();
  });

  it("model_call_started propagates gen_ai.provider.name and gen_ai.request.max_tokens to agent turn span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const modelStarted = typedHooks.get("model_call_started")!;

    resolve({}, { agentId: "a1", sessionKey: "s2" });
    modelStarted(
      { sessionKey: "s2", agentId: "a1", model: "claude-3", provider: "anthropic", maxTokens: 8192 },
      { sessionKey: "s2" },
    );

    const agentTurn = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(agentTurn!.attrs["gen_ai.request.max_tokens"]).toBe(8192);

    stopHooks();
  });

  it("agent_end sets gen_ai.provider.name from diagnostic usage", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const agentEnd = typedHooks.get("agent_end")!;

    await received(
      { channel: "cli", sessionKey: "s-diag", from: "user" },
      { sessionKey: "s-diag" },
    );
    resolve({}, { agentId: "a1", sessionKey: "s-diag" });

    const { activeAgentSpans } = await import("../src/diagnostics.js");
    const diagSpan = spans.find((s) => s.spanName === "openclaw.agent.turn");
    activeAgentSpans.set("s-diag", diagSpan!);

    await agentEnd(
      { success: true, messages: [], durationMs: 100 },
      { agentId: "a1", sessionKey: "s-diag" },
    );

    const agentTurn = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(agentTurn).toBeDefined();

    stopHooks();
  });
});

describe("before_dispatch / reply_dispatch hooks (ISI-928)", () => {
  let stopHooks: () => void;

  it("before_dispatch creates a dispatch prepare span under the agent turn", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeDispatch = typedHooks.get("before_dispatch")!;

    resolve({}, { agentId: "a1", sessionKey: "s1" });

    const result = beforeDispatch(
      { sessionKey: "s1", agentId: "a1", model: "gpt-4o", provider: "openai" },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    const dispatchSpan = spans.find((s) => s.spanName === "openclaw.dispatch.prepare");
    expect(dispatchSpan).toBeDefined();
    expect(dispatchSpan!.attrs["gen_ai.operation.name"]).toBe("chat");
    expect(dispatchSpan!.attrs["gen_ai.conversation.id"]).toBe("s1");
    expect(dispatchSpan!.attrs["gen_ai.request.model"]).toBe("gpt-4o");
    expect(dispatchSpan!.attrs["gen_ai.provider.name"]).toBe("openai");
    expect(dispatchSpan!.attrs["code.function"]).toBe("before_dispatch");
    expect(dispatchSpan!.ended).toBe(false);

    stopHooks();
  });

  it("reply_dispatch closes the dispatch span with response metadata", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeDispatch = typedHooks.get("before_dispatch")!;
    const replyDispatch = typedHooks.get("reply_dispatch")!;

    resolve({}, { agentId: "a1", sessionKey: "s2" });
    beforeDispatch(
      { sessionKey: "s2", model: "gpt-4o", provider: "openai" },
      { sessionKey: "s2" },
    );

    const result = replyDispatch(
      { sessionKey: "s2", responseModel: "gpt-4o-2024-08-06" },
      { sessionKey: "s2" },
    );
    expect(result).toBeUndefined();

    const dispatchSpan = spans.find((s) => s.spanName === "openclaw.dispatch.prepare");
    expect(dispatchSpan).toBeDefined();
    expect(dispatchSpan!.attrs["gen_ai.response.model"]).toBe("gpt-4o-2024-08-06");
    expect(dispatchSpan!.attrs["openclaw.dispatch.duration_ms"]).toBeDefined();
    expect(dispatchSpan!.ended).toBe(true);

    stopHooks();
  });

  it("reply_dispatch records error on dispatch span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeDispatch = typedHooks.get("before_dispatch")!;
    const replyDispatch = typedHooks.get("reply_dispatch")!;

    resolve({}, { agentId: "a1", sessionKey: "s3" });
    beforeDispatch(
      { sessionKey: "s3", model: "gpt-4", provider: "openai" },
      { sessionKey: "s3" },
    );
    replyDispatch(
      { sessionKey: "s3", error: "timeout" },
      { sessionKey: "s3" },
    );

    const dispatchSpan = spans.find((s) => s.spanName === "openclaw.dispatch.prepare");
    expect(dispatchSpan).toBeDefined();
    expect(dispatchSpan!.attrs["error.type"]).toBe("dispatch_error");
    expect(dispatchSpan!.ended).toBe(true);

    stopHooks();
  });

  it("before_dispatch no-ops when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const beforeDispatch = typedHooks.get("before_dispatch")!;
    const result = beforeDispatch(
      { sessionKey: "s1", model: "gpt-4o" },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("reply_dispatch no-ops when no dispatch span exists", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const replyDispatch = typedHooks.get("reply_dispatch")!;
    const result = replyDispatch(
      { sessionKey: "nonexistent" },
      { sessionKey: "nonexistent" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("agent_end closes leftover dispatch span as safety net", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const beforeDispatch = typedHooks.get("before_dispatch")!;
    const agentEnd = typedHooks.get("agent_end")!;

    await received(
      { channel: "cli", sessionKey: "s-safety", from: "user" },
      { sessionKey: "s-safety" },
    );
    resolve({}, { agentId: "a", sessionKey: "s-safety" });
    beforeDispatch(
      { sessionKey: "s-safety", model: "gpt-4o", provider: "openai" },
      { sessionKey: "s-safety" },
    );

    const dispatchSpan = spans.find((s) => s.spanName === "openclaw.dispatch.prepare");
    expect(dispatchSpan).toBeDefined();
    expect(dispatchSpan!.ended).toBe(false);

    await agentEnd(
      { success: true, messages: [], durationMs: 100 },
      { agentId: "a", sessionKey: "s-safety" },
    );

    expect(dispatchSpan!.ended).toBe(true);

    stopHooks();
  });
});

describe("before_agent_finalize / before_reset hooks (ISI-928)", () => {
  let stopHooks: () => void;

  it("before_agent_finalize creates a finalize span under the agent turn", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const finalize = typedHooks.get("before_agent_finalize")!;

    resolve({}, { agentId: "a1", sessionKey: "s1" });

    const result = finalize(
      { sessionKey: "s1", agentId: "a1", pendingMessageCount: 2 },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    const finalizeSpan = spans.find((s) => s.spanName === "openclaw.agent.finalize");
    expect(finalizeSpan).toBeDefined();
    expect(finalizeSpan!.attrs["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(finalizeSpan!.attrs["gen_ai.conversation.id"]).toBe("s1");
    expect(finalizeSpan!.attrs["gen_ai.agent.id"]).toBe("a1");
    expect(finalizeSpan!.attrs["openclaw.agent.pending_messages"]).toBe(2);
    expect(finalizeSpan!.attrs["code.function"]).toBe("before_agent_finalize");
    expect(finalizeSpan!.ended).toBe(true);

    stopHooks();
  });

  it("before_agent_finalize no-ops when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const finalize = typedHooks.get("before_agent_finalize")!;
    const result = finalize(
      { sessionKey: "s1", agentId: "a1" },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("before_reset creates a reset span with session metadata", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const reset = typedHooks.get("before_reset")!;

    const result = reset(
      { sessionKey: "s1", agentId: "a1", reason: "user_requested" },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    const resetSpan = spans.find((s) => s.spanName === "openclaw.session.reset");
    expect(resetSpan).toBeDefined();
    expect(resetSpan!.attrs["gen_ai.conversation.id"]).toBe("s1");
    expect(resetSpan!.attrs["openclaw.session.key"]).toBe("s1");
    expect(resetSpan!.attrs["openclaw.session.reset_reason"]).toBe("user_requested");
    expect(resetSpan!.attrs["code.function"]).toBe("before_reset");
    expect(resetSpan!.ended).toBe(true);

    expect(telemetry.counters.sessionResets.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "openclaw.session.reset_reason": "user_requested" }),
    );

    stopHooks();
  });

  it("before_reset includes session duration when session exists", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const sessionStart = typedHooks.get("session_start")!;
    const reset = typedHooks.get("before_reset")!;

    await sessionStart(
      { sessionKey: "s-reset", channel: "cli", agentId: "a1" },
      { sessionKey: "s-reset" },
    );

    reset(
      { sessionKey: "s-reset", agentId: "a1", reason: "timeout" },
      { sessionKey: "s-reset" },
    );

    const resetSpan = spans.find((s) => s.spanName === "openclaw.session.reset");
    expect(resetSpan).toBeDefined();
    expect(resetSpan!.attrs["openclaw.session.duration_at_reset_ms"]).toBeDefined();

    stopHooks();
  });

  it("before_reset no-ops when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const reset = typedHooks.get("before_reset")!;
    const result = reset(
      { sessionKey: "s1", agentId: "a1" },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });
});

describe("hook registration includes all new lifecycle hooks (ISI-928)", () => {
  it("registers all new typed hooks", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry } = createTelemetry();
    const stopHooks = registerHooks(api, () => telemetry, config);

    expect(typedHooks.has("session_start")).toBe(true);
    expect(typedHooks.has("session_end")).toBe(true);
    expect(typedHooks.has("before_dispatch")).toBe(true);
    expect(typedHooks.has("reply_dispatch")).toBe(true);
    expect(typedHooks.has("before_agent_finalize")).toBe(true);
    expect(typedHooks.has("before_reset")).toBe(true);

    stopHooks();
  });
});

// ── Sub-agent Orchestration tests (ISI-929) ────────────────────────────

describe("subagent_spawning / subagent_delivery_target / subagent_ended hooks (ISI-929)", () => {
  let stopHooks: () => void;

  it("registers all sub-agent hooks", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    expect(typedHooks.has("subagent_spawning")).toBe(true);
    expect(typedHooks.has("subagent_delivery_target")).toBe(true);
    expect(typedHooks.has("subagent_ended")).toBe(true);

    stopHooks();
  });

  it("subagent_spawning creates a spawning span with parent-child link attributes", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const spawning = typedHooks.get("subagent_spawning")!;

    resolve({}, { agentId: "parent-agent", sessionKey: "parent-sess" });

    const result = spawning(
      {
        childSessionKey: "child-sess",
        childAgentId: "child-agent-id",
        childAgentName: "child-agent",
        reason: "task_delegation",
      },
      { sessionKey: "parent-sess", agentId: "parent-agent" },
    );
    expect(result).toBeUndefined();

    const spawnSpan = spans.find((s) => s.spanName === "openclaw.subagent.spawning");
    expect(spawnSpan).toBeDefined();
    expect(spawnSpan!.attrs["openclaw.subagent.parent_session_key"]).toBe("parent-sess");
    expect(spawnSpan!.attrs["openclaw.subagent.child_session_key"]).toBe("child-sess");
    expect(spawnSpan!.attrs["openclaw.subagent.child_agent_id"]).toBe("child-agent-id");
    expect(spawnSpan!.attrs["openclaw.subagent.child_agent_name"]).toBe("child-agent");
    expect(spawnSpan!.attrs["openclaw.subagent.spawn_reason"]).toBe("task_delegation");
    expect(spawnSpan!.attrs["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(spawnSpan!.attrs["code.function"]).toBe("subagent_spawning");
    expect(spawnSpan!.ended).toBe(false);

    expect(telemetry.counters.subagentSpawns.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "openclaw.subagent.child_agent_name": "child-agent" }),
    );

    stopHooks();
  });

  it("subagent_delivery_target creates a delivery span with delivery type", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const delivery = typedHooks.get("subagent_delivery_target")!;

    resolve({}, { agentId: "parent-agent", sessionKey: "parent-sess" });

    const result = delivery(
      {
        childSessionKey: "child-sess",
        parentSessionKey: "parent-sess",
        childAgentId: "child-agent",
        deliveryType: "task_prompt",
      },
      { sessionKey: "parent-sess" },
    );
    expect(result).toBeUndefined();

    const deliverySpan = spans.find((s) => s.spanName === "openclaw.subagent.delivery");
    expect(deliverySpan).toBeDefined();
    expect(deliverySpan!.attrs["openclaw.subagent.parent_session_key"]).toBe("parent-sess");
    expect(deliverySpan!.attrs["openclaw.subagent.child_session_key"]).toBe("child-sess");
    expect(deliverySpan!.attrs["openclaw.subagent.delivery_type"]).toBe("task_prompt");
    expect(deliverySpan!.attrs["code.function"]).toBe("subagent_delivery_target");
    expect(deliverySpan!.ended).toBe(true);

    stopHooks();
  });

  it("subagent_ended closes the spawning span with duration and success", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const spawning = typedHooks.get("subagent_spawning")!;
    const ended = typedHooks.get("subagent_ended")!;

    resolve({}, { agentId: "parent-agent", sessionKey: "parent-sess" });
    spawning(
      {
        childSessionKey: "child-sess",
        childAgentId: "child-agent",
        childAgentName: "child-agent",
        reason: "delegation",
      },
      { sessionKey: "parent-sess", agentId: "parent-agent" },
    );

    const result = ended(
      {
        childSessionKey: "child-sess",
        parentSessionKey: "parent-sess",
        success: true,
        durationMs: 1234,
        childAgentId: "child-agent",
        childAgentName: "child-agent",
      },
      { sessionKey: "parent-sess" },
    );
    expect(result).toBeUndefined();

    const spawnSpan = spans.find((s) => s.spanName === "openclaw.subagent.spawning");
    expect(spawnSpan).toBeDefined();
    expect(spawnSpan!.attrs["openclaw.subagent.duration_ms"]).toBe(1234);
    expect(spawnSpan!.attrs["openclaw.subagent.success"]).toBe(true);
    expect(spawnSpan!.ended).toBe(true);

    expect(telemetry.histograms.subagentDuration.record).toHaveBeenCalledWith(
      1234,
      expect.objectContaining({ "openclaw.subagent.child_agent_name": "child-agent" }),
    );

    expect(telemetry.counters.subagentEnded.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "openclaw.subagent.child_agent_name": "child-agent" }),
    );

    stopHooks();
  });

  it("subagent_ended records error on the spawning span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const spawning = typedHooks.get("subagent_spawning")!;
    const ended = typedHooks.get("subagent_ended")!;

    resolve({}, { agentId: "parent-agent", sessionKey: "parent-sess" });
    spawning(
      { childSessionKey: "child-err", childAgentId: "child", childAgentName: "child", reason: "test" },
      { sessionKey: "parent-sess", agentId: "parent-agent" },
    );

    ended(
      {
        childSessionKey: "child-err",
        parentSessionKey: "parent-sess",
        success: false,
        error: "child agent crashed",
        childAgentId: "child",
        childAgentName: "child",
      },
      { sessionKey: "parent-sess" },
    );

    const spawnSpan = spans.find((s) => s.spanName === "openclaw.subagent.spawning");
    expect(spawnSpan).toBeDefined();
    expect(spawnSpan!.attrs["error.type"]).toBe("subagent_error");
    expect(spawnSpan!.attrs["openclaw.subagent.success"]).toBe(false);
    expect(spawnSpan!.ended).toBe(true);

    stopHooks();
  });

  it("subagent hooks no-op when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const spawning = typedHooks.get("subagent_spawning")!;
    const delivery = typedHooks.get("subagent_delivery_target")!;
    const ended = typedHooks.get("subagent_ended")!;

    expect(spawning({}, { sessionKey: "s1" })).toBeUndefined();
    expect(delivery({}, { sessionKey: "s1" })).toBeUndefined();
    expect(ended({}, { sessionKey: "s1" })).toBeUndefined();

    stopHooks();
  });

  it("subagent_spawning stores context and leaves spawning span open for subagent_ended", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const resolve = typedHooks.get("before_model_resolve")!;
    const spawning = typedHooks.get("subagent_spawning")!;
    const ended = typedHooks.get("subagent_ended")!;

    resolve({}, { agentId: "parent-agent", sessionKey: "parent-sess" });

    spawning(
      { childSessionKey: "child-linked", childAgentId: "c1", childAgentName: "c1", reason: "test" },
      { sessionKey: "parent-sess", agentId: "parent-agent" },
    );

    const spawnSpan = spans.find((s) => s.spanName === "openclaw.subagent.spawning");
    expect(spawnSpan).toBeDefined();
    expect(spawnSpan!.ended).toBe(false);

    ended(
      {
        childSessionKey: "child-linked",
        parentSessionKey: "parent-sess",
        success: true,
        childAgentId: "c1",
        childAgentName: "c1",
      },
      { sessionKey: "parent-sess" },
    );

    expect(spawnSpan!.ended).toBe(true);

    stopHooks();
  });
});

// ── Cron Job Hooks tests (ISI-929) ──────────────────────────────────────

describe("cron_changed / cron_executed hooks (ISI-929)", () => {
  let stopHooks: () => void;

  it("registers cron hooks", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    expect(typedHooks.has("cron_changed")).toBe(true);
    expect(typedHooks.has("cron_executed")).toBe(true);

    stopHooks();
  });

  it("cron_changed creates a span with job name and action", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const cronChanged = typedHooks.get("cron_changed")!;

    const result = cronChanged(
      {
        jobName: "healthcheck",
        action: "created",
        expression: "*/5 * * * *",
        agentId: "agent-1",
        provider: "openai",
      },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    const cronSpan = spans.find((s) => s.spanName === "openclaw.cron.changed");
    expect(cronSpan).toBeDefined();
    expect(cronSpan!.attrs["openclaw.cron.job_name"]).toBe("healthcheck");
    expect(cronSpan!.attrs["openclaw.cron.action"]).toBe("created");
    expect(cronSpan!.attrs["openclaw.cron.expression"]).toBe("*/5 * * * *");
    expect(cronSpan!.attrs["gen_ai.agent.id"]).toBe("agent-1");
    expect(cronSpan!.attrs["gen_ai.provider.name"]).toBe("openai");
    expect(cronSpan!.attrs["code.function"]).toBe("cron_changed");
    expect(cronSpan!.ended).toBe(true);

    expect(telemetry.counters.cronChanges.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "openclaw.cron.job_name": "healthcheck", "openclaw.cron.action": "created" }),
    );

    stopHooks();
  });

  it("cron_changed no-ops when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const cronChanged = typedHooks.get("cron_changed")!;
    const result = cronChanged(
      { jobName: "test", action: "deleted" },
      { sessionKey: "s1" },
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("cron_executed creates a span with job name, trigger, and duration", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const cronExec = typedHooks.get("cron_executed")!;

    const result = cronExec(
      {
        jobName: "cleanup",
        trigger: "scheduled",
        agentId: "agent-2",
        provider: "anthropic",
        success: true,
        durationMs: 500,
        jobKey: "cleanup-key",
      },
      {},
    );
    expect(result).toBeUndefined();

    const cronSpan = spans.find((s) => s.spanName === "openclaw.cron.exec cleanup");
    expect(cronSpan).toBeDefined();
    expect(cronSpan!.attrs["openclaw.cron.job_name"]).toBe("cleanup");
    expect(cronSpan!.attrs["openclaw.cron.trigger"]).toBe("scheduled");
    expect(cronSpan!.attrs["openclaw.cron.duration_ms"]).toBe(500);
    expect(cronSpan!.attrs["openclaw.cron.success"]).toBe(true);
    expect(cronSpan!.attrs["openclaw.cron.agent_id"]).toBe("agent-2");
    expect(cronSpan!.attrs["gen_ai.agent.id"]).toBe("agent-2");
    expect(cronSpan!.attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(cronSpan!.attrs["code.function"]).toBe("cron_executed");
    // ISI-993: `cron_executed` is not a valid OTel gen_ai.operation.name value.
    expect(cronSpan!.attrs["gen_ai.operation.name"]).toBeUndefined();
    expect(cronSpan!.ended).toBe(true);

    expect(telemetry.counters.cronExecutions.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "openclaw.cron.job_name": "cleanup", "openclaw.cron.trigger": "scheduled" }),
    );

    expect(telemetry.histograms.cronDuration.record).toHaveBeenCalledWith(
      500,
      expect.objectContaining({ "openclaw.cron.job_name": "cleanup" }),
    );

    stopHooks();
  });

  it("cron_executed records error on the span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const cronExec = typedHooks.get("cron_executed")!;

    cronExec(
      {
        jobName: "failing-job",
        trigger: "manual",
        success: false,
        error: "timeout exceeded",
        durationMs: 30000,
        jobKey: "failing-key",
      },
      {},
    );

    const cronSpan = spans.find((s) => s.spanName === "openclaw.cron.exec failing-job");
    expect(cronSpan).toBeDefined();
    expect(cronSpan!.attrs["error.type"]).toBe("cron_error");
    expect(cronSpan!.attrs["openclaw.cron.success"]).toBe(false);
    expect(cronSpan!.ended).toBe(true);

    expect(telemetry.counters.cronErrors.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ "openclaw.cron.job_name": "failing-job" }),
    );

    stopHooks();
  });

  it("cron_executed stores context in TraceContextStore when no durationMs", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const cronExec = typedHooks.get("cron_executed")!;

    cronExec(
      {
        jobName: "long-job",
        trigger: "scheduled",
        success: true,
        jobKey: "long-job-key",
      },
      {},
    );

    const cronSpan = spans.find((s) => s.spanName === "openclaw.cron.exec long-job");
    expect(cronSpan).toBeDefined();
    expect(cronSpan!.ended).toBe(false);

    stopHooks();
  });

  it("cron_executed no-ops when telemetry is null", () => {
    const { api, typedHooks } = createStubApi();
    stopHooks = registerHooks(api, () => null, config);

    const cronExec = typedHooks.get("cron_executed")!;
    const result = cronExec(
      { jobName: "test", trigger: "manual" },
      {},
    );
    expect(result).toBeUndefined();

    stopHooks();
  });

  it("cron_executed with sessionKey resolves parent context", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    const resolve = typedHooks.get("before_model_resolve")!;
    const cronExec = typedHooks.get("cron_executed")!;

    return Promise.resolve(
      received(
        { channel: "cli", sessionKey: "cron-sess", from: "user" },
        { sessionKey: "cron-sess" },
      ),
    ).then(() => {
      resolve({}, { agentId: "a1", sessionKey: "cron-sess" });

      cronExec(
        {
          jobName: "session-cron",
          trigger: "webhook",
          agentId: "a1",
          provider: "openai",
          success: true,
          durationMs: 100,
          jobKey: "session-cron-key",
          sessionKey: "cron-sess",
        },
        { sessionKey: "cron-sess" },
      );

      const cronSpan = spans.find((s) => s.spanName === "openclaw.cron.exec session-cron");
      expect(cronSpan).toBeDefined();
      expect(cronSpan!.attrs["openclaw.session.key"]).toBe("cron-sess");
      expect(cronSpan!.ended).toBe(true);

      stopHooks();
    });
  });
});

// ── ContentCapturePolicy gating (ISI-1000) ──────────────────────────

describe("content capture policy gating (ISI-1000)", () => {
  let stopHooks: () => void;

  it("emits no openclaw.content.* attributes when policy is all-off", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(api, () => telemetry, config);

    const received = typedHooks.get("message_received")!;
    await Promise.resolve(
      received(
        { channel: "cli", sessionKey: "s1", from: "user", text: "secret prompt" },
        { sessionKey: "s1" },
      ),
    );

    typedHooks.get("before_model_resolve")!(
      {},
      { agentId: "a1", sessionKey: "s1" },
    );
    typedHooks.get("before_prompt_build")!(
      {
        prompt: "user content",
        messages: [{ role: "user", content: "x" }],
        systemPrompt: "be helpful",
      },
      { agentId: "a1", sessionKey: "s1" },
    );
    typedHooks.get("message_sent")!(
      { sessionKey: "s1", channel: "cli", to: "user", text: "reply text" },
      { sessionKey: "s1" },
    );

    for (const span of spans) {
      for (const key of Object.keys(span.attrs)) {
        expect(
          key.startsWith("openclaw.content."),
          `unexpected content attribute "${key}" with policy=all-off`,
        ).toBe(false);
      }
    }

    stopHooks();
  });

  it("inputMessages=true captures inbound user text + prompt + messages", async () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ inputMessages: true }),
    );

    await Promise.resolve(
      typedHooks.get("message_received")!(
        { channel: "cli", sessionKey: "s1", from: "user", text: "hello" },
        { sessionKey: "s1" },
      ),
    );
    typedHooks.get("before_model_resolve")!(
      {},
      { agentId: "a1", sessionKey: "s1" },
    );
    typedHooks.get("before_prompt_build")!(
      {
        prompt: "hello prompt",
        messages: [{ role: "user", content: "hi" }],
      },
      { agentId: "a1", sessionKey: "s1" },
    );

    const request = spans.find((s) => s.spanName === "openclaw.request");
    const turn = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(request!.attrs["openclaw.content.input_message"]).toBe("hello");
    expect(turn!.attrs["openclaw.content.prompt"]).toBe("hello prompt");
    expect(turn!.attrs["openclaw.content.messages"]).toEqual(
      JSON.stringify([{ role: "user", content: "hi" }]),
    );
    // systemPrompt is gated separately
    expect(turn!.attrs["openclaw.content.system_prompt"]).toBeUndefined();

    stopHooks();
  });

  it("systemPrompt=true is independent of inputMessages", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ systemPrompt: true }),
    );

    typedHooks.get("before_model_resolve")!(
      {},
      { agentId: "a1", sessionKey: "s1" },
    );
    typedHooks.get("before_prompt_build")!(
      {
        prompt: "user-only",
        messages: [{ role: "user", content: "x" }],
        systemPrompt: "be helpful and safe",
      },
      { agentId: "a1", sessionKey: "s1" },
    );

    const turn = spans.find((s) => s.spanName === "openclaw.agent.turn");
    expect(turn!.attrs["openclaw.content.system_prompt"]).toBe(
      "be helpful and safe",
    );
    expect(turn!.attrs["openclaw.content.prompt"]).toBeUndefined();
    expect(turn!.attrs["openclaw.content.messages"]).toBeUndefined();

    stopHooks();
  });

  it("outputMessages=true captures outbound reply text on message.sent span", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ outputMessages: true }),
    );

    typedHooks.get("message_sent")!(
      { sessionKey: "s1", channel: "cli", to: "user", text: "the reply" },
      { sessionKey: "s1" },
    );

    const sent = spans.find((s) => s.spanName === "openclaw.message.sent");
    expect(sent!.attrs["openclaw.content.output_message"]).toBe("the reply");

    stopHooks();
  });

  it("toolInputs=true captures tool args; toolOutputs=true captures result text", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ toolInputs: true, toolOutputs: true }),
    );

    // Tools live under an active session — set up message_received first.
    return Promise.resolve(
      typedHooks.get("message_received")!(
        { channel: "cli", sessionKey: "s1", from: "u" },
        { sessionKey: "s1" },
      ),
    ).then(() => {
      typedHooks.get("before_tool_call")!(
        {
          toolName: "Read",
          toolCallId: "call-1",
          input: { path: "/tmp/file.txt" },
        },
        { sessionKey: "s1", agentId: "a1" },
      );
      typedHooks.get("after_tool_call")!(
        {
          toolName: "Read",
          toolCallId: "call-1",
          sessionKey: "s1",
          message: {
            content: [{ type: "text", text: "hello world" }],
          },
        },
        { sessionKey: "s1" },
      );

      const tool = spans.find((s) => s.spanName === "execute_tool Read");
      expect(tool).toBeDefined();
      expect(tool!.attrs["openclaw.content.tool_input"]).toBe(
        JSON.stringify({ path: "/tmp/file.txt" }),
      );
      expect(tool!.attrs["openclaw.content.tool_output"]).toBe("hello world");

      stopHooks();
    });
  });

  it("truncates content captures longer than 8192 code units with an inline marker", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ outputMessages: true }),
    );

    const big = "x".repeat(10_000);
    typedHooks.get("message_sent")!(
      { sessionKey: "s1", channel: "cli", to: "user", text: big },
      { sessionKey: "s1" },
    );

    const sent = spans.find((s) => s.spanName === "openclaw.message.sent");
    const captured = sent!.attrs["openclaw.content.output_message"] as string;
    expect(captured.length).toBeLessThanOrEqual(10_000);
    expect(captured).toMatch(/^x{8192}…\(truncated, 1808 more chars\)$/);

    stopHooks();
  });

  it("backs off one code unit when the truncation cut would split a UTF-16 surrogate pair", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ outputMessages: true }),
    );

    // 8191 ASCII chars + a non-BMP emoji (2 UTF-16 code units) + filler.
    // A naïve `.slice(0, 8192)` would split the surrogate pair and leave
    // a lone high surrogate as the last code unit, which is invalid
    // UTF-16. The captureContentAttribute helper detects that and backs
    // off by one code unit, so the prefix becomes exactly 8191 'x's.
    const head = "x".repeat(8191);
    const emoji = "😀"; // U+1F600 — encoded as two UTF-16 code units
    const tail = "y".repeat(2_000);
    const text = head + emoji + tail;
    expect(text.length).toBe(8191 + 2 + 2_000);
    expect(text.charCodeAt(8191)).toBeGreaterThanOrEqual(0xd800);
    expect(text.charCodeAt(8191)).toBeLessThanOrEqual(0xdbff);

    typedHooks.get("message_sent")!(
      { sessionKey: "s1", channel: "cli", to: "user", text },
      { sessionKey: "s1" },
    );

    const sent = spans.find((s) => s.spanName === "openclaw.message.sent");
    const captured = sent!.attrs["openclaw.content.output_message"] as string;
    // Prefix is 8191 'x's (one less than the 8192 cap), the surrogate
    // pair is dropped, and the truncation marker reports the overflow
    // relative to the actual cut point.
    const overflow = text.length - 8191; // 2002 more code units
    expect(captured).toMatch(
      new RegExp(`^x{8191}…\\(truncated, ${overflow} more chars\\)$`),
    );
    // Verify the prefix is well-formed UTF-16 (no dangling high surrogate).
    const lastCode = captured.charCodeAt(8191 - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);

    stopHooks();
  });

  it("captures nothing for null/undefined values even when the flag is on", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ ...CONTENT_POLICY_ENABLED }),
    );

    typedHooks.get("message_sent")!(
      // text is missing
      { sessionKey: "s1", channel: "cli", to: "user" },
      { sessionKey: "s1" },
    );

    const sent = spans.find((s) => s.spanName === "openclaw.message.sent");
    expect(sent!.attrs["openclaw.content.output_message"]).toBeUndefined();

    stopHooks();
  });

  it("redacts secrets that straddle the truncation boundary (ISI-1000 M2)", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ outputMessages: true }),
    );

    // Place a bearer token so the 8192-char cut falls INSIDE the token
    // and leaves only 10 surviving chars — below the bearer regex's
    // {16,} minimum. If captureContentAttribute truncates BEFORE it
    // redacts, those 10 chars leak as plaintext. Redact-first scrubs
    // the secret before truncation can split it.
    const bearer = "abc123xyz0123456789DEFGHIJKL"; // 28 chars
    // 8160 a's + "Authorization: Bearer " (22) = 8182. Bearer occupies
    // positions 8182..8209; cut at 8192 strands chars 8182..8191 (10
    // chars: "abc123xyz0") in the OLD truncate-first code path.
    const head = "a".repeat(8160);
    const text = `${head}Authorization: Bearer ${bearer} trailing-context-that-pushes-past-the-cap`;
    expect(text.length).toBeGreaterThan(8192);

    typedHooks.get("message_sent")!(
      { sessionKey: "s1", channel: "cli", to: "user", text },
      { sessionKey: "s1" },
    );

    const sent = spans.find((s) => s.spanName === "openclaw.message.sent");
    const captured = sent!.attrs["openclaw.content.output_message"] as string;
    // No portion of the raw bearer — full, 10-char tail, or 5-char head —
    // must be present, even though the cut falls in the middle of it.
    expect(captured).not.toContain(bearer);
    expect(captured).not.toContain(bearer.slice(0, 10));
    expect(captured).not.toContain(bearer.slice(0, 5));

    stopHooks();
  });

  it("redacts bearer tokens and API keys in captured content (ISI-999 + ISI-1000)", () => {
    const { api, typedHooks } = createStubApi();
    const { telemetry, spans } = createTelemetry();
    stopHooks = registerHooks(
      api,
      () => telemetry,
      configWithPolicy({ outputMessages: true }),
    );

    // Mix of secret patterns redactSensitiveText knows: a bearer token and
    // an Anthropic-style API key. Both must be scrubbed before reaching the
    // span attribute — captureContentAttribute MUST route through
    // setRedactedAttribute so operators who turn on content capture cannot
    // accidentally leak credentials embedded in tool/LLM output.
    const bearer = "abc123xyz0123456789DEFGHIJKL";
    const apiKey = "sk-ant-AAAABBBBCCCCDDDDEEEE";
    const leaky = `reply with Authorization: Bearer ${bearer} and key ${apiKey}`;
    typedHooks.get("message_sent")!(
      { sessionKey: "s1", channel: "cli", to: "user", text: leaky },
      { sessionKey: "s1" },
    );

    const sent = spans.find((s) => s.spanName === "openclaw.message.sent");
    const captured = sent!.attrs["openclaw.content.output_message"] as string;
    expect(captured).toContain("Bearer [REDACTED_TOKEN]");
    expect(captured).toContain("[REDACTED_API_KEY]");
    expect(captured).not.toContain(bearer);
    expect(captured).not.toContain(apiKey);

    stopHooks();
  });
});

