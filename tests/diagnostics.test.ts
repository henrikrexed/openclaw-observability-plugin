/**
 * Tests for diagnostic event handlers — liveness warnings and heartbeats.
 *
 * Covers ISI-1016: Gateway Health Metrics (event loop, CPU, liveness).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Counter, Histogram, Span, Tracer } from "@opentelemetry/api";

// We must mock the SDK before importing diagnostics, because the module
// caches the onDiagnosticEvent loader at the top level.
const mockListeners = new Set<(evt: any) => void>();
let sdkAvailable = true;

vi.mock("openclaw/plugin-sdk", () => ({
  onDiagnosticEvent: (listener: (evt: any) => void) => {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
}));

// Force a fresh module load for each test so the cached `onDiagnosticEvent`
// reference is reset.
const diagnosticsImport = () => import("../src/diagnostics.js");

interface SpanSpy {
  attrs: Record<string, unknown>;
  ended: boolean;
  status: { code?: number; message?: string };
  spanName: string;
  events: Array<{ name: string; attributes?: Record<string, unknown> }>;
}

function createSpanSpy(name: string): Span & SpanSpy {
  const spy: SpanSpy = {
    attrs: {},
    ended: false,
    status: {},
    spanName: name,
    events: [],
  };
  return {
    ...spy,
    get ended() {
      return spy.ended;
    },
    get status() {
      return spy.status;
    },
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
    addEvent(name: string, attributes?: Record<string, unknown>) {
      spy.events.push({ name, attributes });
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
  } as unknown as Span & SpanSpy;
}

function createTracerSpy(): { tracer: Tracer; spans: Array<Span & SpanSpy> } {
  const spans: Array<Span & SpanSpy> = [];
  const tracer = {
    startSpan(name: string, options?: { kind?: number; attributes?: Record<string, unknown> }) {
      const span = createSpanSpy(name);
      if (options?.attributes) {
        Object.assign((span as unknown as SpanSpy).attrs, options.attributes);
      }
      spans.push(span);
      return span;
    },
    startActiveSpan: (() => {
      throw new Error("startActiveSpan not used");
    }) as Tracer["startActiveSpan"],
  } as Tracer;
  return { tracer, spans };
}

function noopCounter(): Counter {
  return { add: vi.fn() } as unknown as Counter;
}

function noopHistogram(): Histogram {
  return { record: vi.fn() } as unknown as Histogram;
}

function createTelemetry() {
  const { tracer, spans } = createTracerSpy();
  const counters = {
    livenessWarnings: noopCounter(),
    diagnosticHeartbeats: noopCounter(),
    llmRequests: noopCounter(),
    tokensTotal: noopCounter(),
    tokensPrompt: noopCounter(),
    tokensCompletion: noopCounter(),
  };
  const histograms = {
    gatewayEventLoopDelayP99: noopHistogram(),
    gatewayEventLoopDelayMax: noopHistogram(),
    gatewayEventLoopUtilization: noopHistogram(),
    gatewayCpuCoreRatio: noopHistogram(),
    gatewayWorkQueued: noopHistogram(),
    genAiTokenUsage: noopHistogram(),
    genAiOperationDuration: noopHistogram(),
    llmDuration: noopHistogram(),
  };
  return {
    telemetry: {
      tracer,
      meter: { createCounter: () => ({ add: vi.fn() }) } as any,
      counters,
      histograms,
      gauges: {} as any,
      shutdown: async () => {},
    },
    spans,
    counters,
    histograms,
  };
}

describe("ISI-1016: diagnostic event handlers", () => {
  beforeEach(() => {
    mockListeners.clear();
    sdkAvailable = true;
    vi.resetModules();
  });

  afterEach(() => {
    mockListeners.clear();
    vi.restoreAllMocks();
  });

  describe("diagnostic.liveness.warning", () => {
    it("records histograms, counter, and creates an ERROR span", async () => {
      const { registerDiagnosticsListener } = await diagnosticsImport();
      const { telemetry, spans, counters, histograms } = createTelemetry();
      const logger = { info: vi.fn(), debug: vi.fn() };

      await registerDiagnosticsListener(telemetry, logger);
      expect(mockListeners.size).toBe(1);

      const [listener] = Array.from(mockListeners);
      listener({
        type: "diagnostic.liveness.warning",
        reasons: ["event_loop_slow"],
        eventLoopDelayP99Ms: 120,
        eventLoopDelayMaxMs: 250,
        eventLoopUtilization: 0.85,
        cpuCoreRatio: 1.4,
        active: 5,
        waiting: 2,
        queued: 10,
      });

      // Counter incremented once
      expect((counters.livenessWarnings.add as any).mock.calls).toEqual([
        [
          1,
          {
            "openclaw.liveness.reasons": "event_loop_slow",
            "openclaw.liveness.active": 5,
            "openclaw.liveness.waiting": 2,
            "openclaw.liveness.queued": 10,
          },
        ],
      ]);

      // Histograms recorded
      expect((histograms.gatewayEventLoopDelayP99.record as any).mock.calls).toEqual([
        [120, { "openclaw.liveness.reasons": "event_loop_slow", "openclaw.liveness.active": 5, "openclaw.liveness.waiting": 2, "openclaw.liveness.queued": 10 }],
      ]);
      expect((histograms.gatewayEventLoopDelayMax.record as any).mock.calls).toEqual([
        [250, { "openclaw.liveness.reasons": "event_loop_slow", "openclaw.liveness.active": 5, "openclaw.liveness.waiting": 2, "openclaw.liveness.queued": 10 }],
      ]);
      expect((histograms.gatewayEventLoopUtilization.record as any).mock.calls).toEqual([
        [0.85, { "openclaw.liveness.reasons": "event_loop_slow", "openclaw.liveness.active": 5, "openclaw.liveness.waiting": 2, "openclaw.liveness.queued": 10 }],
      ]);
      expect((histograms.gatewayCpuCoreRatio.record as any).mock.calls).toEqual([
        [1.4, { "openclaw.liveness.reasons": "event_loop_slow", "openclaw.liveness.active": 5, "openclaw.liveness.waiting": 2, "openclaw.liveness.queued": 10 }],
      ]);
      expect((histograms.gatewayWorkQueued.record as any).mock.calls).toEqual([
        [10, { "openclaw.liveness.reasons": "event_loop_slow", "openclaw.liveness.active": 5, "openclaw.liveness.waiting": 2, "openclaw.liveness.queued": 10 }],
      ]);

      // Span created and ended
      expect(spans.length).toBe(1);
      const span = spans[0];
      expect(span.spanName).toBe("openclaw.liveness.warning");
      expect(span.ended).toBe(true);
      expect(span.status.code).toBe(2); // SpanStatusCode.ERROR
      expect(span.status.message).toBe("event_loop_slow");
      expect(span.attrs["openclaw.liveness.event_loop_delay_p99_ms"]).toBe(120);
      expect(span.attrs["openclaw.liveness.event_loop_delay_max_ms"]).toBe(250);
      expect(span.attrs["openclaw.liveness.event_loop_utilization"]).toBe(0.85);
      expect(span.attrs["openclaw.liveness.cpu_core_ratio"]).toBe(1.4);
      expect(span.attrs["openclaw.liveness.reasons"]).toBe("event_loop_slow");
    });

    it("handles missing optional fields gracefully", async () => {
      const { registerDiagnosticsListener } = await diagnosticsImport();
      const { telemetry, spans, counters, histograms } = createTelemetry();
      const logger = { info: vi.fn(), debug: vi.fn() };

      await registerDiagnosticsListener(telemetry, logger);
      const [listener] = Array.from(mockListeners);

      listener({
        type: "diagnostic.liveness.warning",
        reasons: ["cpu_high"],
      });

      expect((counters.livenessWarnings.add as any).mock.calls).toEqual([
        [1, { "openclaw.liveness.reasons": "cpu_high" }],
      ]);

      // No histograms recorded when fields absent
      expect((histograms.gatewayEventLoopDelayP99.record as any).mock.calls).toEqual([]);
      expect((histograms.gatewayEventLoopDelayMax.record as any).mock.calls).toEqual([]);
      expect((histograms.gatewayEventLoopUtilization.record as any).mock.calls).toEqual([]);
      expect((histograms.gatewayCpuCoreRatio.record as any).mock.calls).toEqual([]);
      expect((histograms.gatewayWorkQueued.record as any).mock.calls).toEqual([]);

      // Span still created
      expect(spans.length).toBe(1);
      expect(spans[0].spanName).toBe("openclaw.liveness.warning");
      expect(spans[0].ended).toBe(true);
      expect(spans[0].status.message).toBe("cpu_high");
    });
  });

  describe("diagnostic.heartbeat", () => {
    it("increments heartbeat counter and records queued histogram", async () => {
      const { registerDiagnosticsListener } = await diagnosticsImport();
      const { telemetry, counters, histograms } = createTelemetry();
      const logger = { info: vi.fn(), debug: vi.fn() };

      await registerDiagnosticsListener(telemetry, logger);
      const [listener] = Array.from(mockListeners);

      listener({
        type: "diagnostic.heartbeat",
        queued: 3,
      });

      expect((counters.diagnosticHeartbeats.add as any).mock.calls).toEqual([[1]]);
      expect((histograms.gatewayWorkQueued.record as any).mock.calls).toEqual([[3]]);
    });

    it("handles missing queued field gracefully", async () => {
      const { registerDiagnosticsListener } = await diagnosticsImport();
      const { telemetry, counters, histograms } = createTelemetry();
      const logger = { info: vi.fn(), debug: vi.fn() };

      await registerDiagnosticsListener(telemetry, logger);
      const [listener] = Array.from(mockListeners);

      listener({
        type: "diagnostic.heartbeat",
      });

      expect((counters.diagnosticHeartbeats.add as any).mock.calls).toEqual([[1]]);
      expect((histograms.gatewayWorkQueued.record as any).mock.calls).toEqual([]);
    });
  });

  describe("model.usage still works", () => {
    it("processes model.usage events unchanged", async () => {
      const { registerDiagnosticsListener } = await diagnosticsImport();
      const { telemetry, counters } = createTelemetry();
      const logger = { info: vi.fn(), debug: vi.fn() };

      await registerDiagnosticsListener(telemetry, logger);
      const [listener] = Array.from(mockListeners);

      listener({
        type: "model.usage",
        sessionKey: "sess-123",
        model: "gpt-4",
        provider: "openai",
        usage: { input: 10, output: 20, total: 30 },
        costUsd: 0.001,
        durationMs: 500,
      });

      expect((counters.llmRequests.add as any).mock.calls).toEqual([
        [
          1,
          expect.objectContaining({
            "gen_ai.response.model": "gpt-4",
            "gen_ai.provider.name": "openai",
          }),
        ],
      ]);
    });
  });
});
