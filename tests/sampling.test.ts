/**
 * ISI-1003 — sampler wiring tests:
 *
 *   - Nit #3: boot-log content assertion. The plugin's boot log must say
 *     `sampler=parentbased_traceidratio(<value>)` when `sampleRate` is set,
 *     and must NOT include any sampler annotation when `sampleRate` is
 *     omitted (the SDK default `parentbased_always_on` applies silently).
 *     Pinning this string keeps it discoverable in operator logs and a
 *     refactor that drops it surfaces here, not in production.
 *
 *   - Nit #4: ParentBased upstream-sampled-out honor. `ParentBased` is
 *     contractually required to honor an upstream `sampled=false` parent
 *     span context even when the local `TraceIdRatio` would have sampled
 *     in. The contract is the SDK's, but a wiring slip (e.g. forgetting
 *     to wrap `TraceIdRatioBasedSampler` in `ParentBasedSampler`) silently
 *     breaks distributed sampling — so we pin the wiring with an
 *     end-to-end assertion using the real plugin sampler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  context,
  trace,
  TraceFlags,
  type SpanContext,
} from "@opentelemetry/api";

import { initTelemetry } from "../src/telemetry.js";
import type { OtelObservabilityConfig } from "../src/config.js";
import { CONTENT_POLICY_DISABLED } from "../src/config.js";

function baseConfig(
  overrides: Partial<OtelObservabilityConfig> = {},
): OtelObservabilityConfig {
  return {
    endpoint: "http://127.0.0.1:14318",
    protocol: "http",
    serviceName: "isi-1003-test",
    headers: {},
    traces: true,
    // Skip metrics so the test doesn't spin up a PeriodicExportingMetricReader.
    metrics: false,
    logs: false,
    captureContent: { ...CONTENT_POLICY_DISABLED },
    metricsIntervalMs: 30_000,
    resourceAttributes: {},
    ...overrides,
  };
}

function makeLoggerSpy() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("ISI-1003 — boot-log sampler annotation (Nit #3)", () => {
  let runtimes: Array<{ shutdown: () => Promise<void> }> = [];

  afterEach(async () => {
    // Tear down any tracer providers we registered so global state stays
    // clean between cases (esp. the periodic batch processor timers).
    for (const r of runtimes.splice(0)) {
      await r.shutdown();
    }
  });

  it("omits the sampler annotation when sampleRate is unset", () => {
    const logger = makeLoggerSpy();
    const runtime = initTelemetry(baseConfig(), logger);
    runtimes.push(runtime);

    const traceLine = logger.info.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.startsWith("[otel] Trace exporter"));

    expect(traceLine).toBeDefined();
    // Default-sampler path: no sampler= suffix.
    expect(traceLine).not.toContain("sampler=");
    // Endpoint + protocol still reported.
    expect(traceLine).toContain("http://127.0.0.1:14318/v1/traces");
    expect(traceLine).toContain("(http)");
  });

  it("emits sampler=parentbased_traceidratio(<rate>) when sampleRate is set", () => {
    const logger = makeLoggerSpy();
    const runtime = initTelemetry(baseConfig({ sampleRate: 0.25 }), logger);
    runtimes.push(runtime);

    const traceLine = logger.info.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.startsWith("[otel] Trace exporter"));

    expect(traceLine).toBeDefined();
    expect(traceLine).toContain("sampler=parentbased_traceidratio(0.25)");
  });

  it("emits sampler=parentbased_traceidratio(1) for sampleRate=1.0", () => {
    // Pin the always-on-but-explicit boot log path documented in
    // docs/configuration.md (Trace Sampling section).
    const logger = makeLoggerSpy();
    const runtime = initTelemetry(baseConfig({ sampleRate: 1 }), logger);
    runtimes.push(runtime);

    const traceLine = logger.info.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.startsWith("[otel] Trace exporter"));

    expect(traceLine).toContain("sampler=parentbased_traceidratio(1)");
  });
});

describe("ISI-1003 — ParentBased honors upstream sampled=false (Nit #4)", () => {
  let runtime: { tracer: ReturnType<typeof trace.getTracer>; shutdown: () => Promise<void> } | undefined;

  beforeEach(() => {
    // sampleRate=1.0 means the local TraceIdRatio would sample in *every*
    // root span. The only way the child below ends up not-recording is if
    // the ParentBased wrapper honors the upstream sampled=false flag — so
    // this is the test that catches a wiring slip.
    const logger = makeLoggerSpy();
    runtime = initTelemetry(baseConfig({ sampleRate: 1.0 }), logger);
  });

  afterEach(async () => {
    if (runtime) await runtime.shutdown();
    runtime = undefined;
  });

  it("does NOT record a child span when the parent context is sampled=false", () => {
    // Build a synthetic non-sampled parent SpanContext (TraceFlags.NONE).
    // `isRemote: true` is the realistic case for an upstream HTTP caller
    // who passed `traceparent: 00-…-00` (sampled=false). ParentBased must
    // consult its `remoteParentNotSampled` sampler (defaults to
    // AlwaysOffSampler) and drop the child.
    const parentCtx: SpanContext = {
      traceId: "11112222333344445555666677778888",
      spanId: "1234567890abcdef",
      traceFlags: TraceFlags.NONE,
      isRemote: true,
    };

    const ctxWithParent = trace.setSpanContext(context.active(), parentCtx);

    const child = runtime!.tracer.startSpan("child", undefined, ctxWithParent);

    try {
      // Two assertions — both should hold for ParentBased honoring the
      // non-sampled parent. `isRecording()` covers the local effect (no
      // attributes/events captured); `traceFlags` covers what we'd
      // propagate downstream (no surprise re-sampling on egress).
      expect(child.isRecording()).toBe(false);
      expect(child.spanContext().traceFlags).toBe(TraceFlags.NONE);
      // Trace ID is inherited from the parent — child stays in the same
      // (non-sampled) trace rather than starting a new sampled root.
      expect(child.spanContext().traceId).toBe(parentCtx.traceId);
    } finally {
      child.end();
    }
  });

  it("DOES record a child span when the parent context is sampled=true (sanity baseline)", () => {
    // Mirrors the negative case above so a regression that flips
    // `isRecording()` to always-false (e.g. swapping in AlwaysOff at the
    // root) gets caught too.
    const parentCtx: SpanContext = {
      traceId: "aaaa1111bbbb2222cccc3333dddd4444",
      spanId: "abcdef1234567890",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };

    const ctxWithParent = trace.setSpanContext(context.active(), parentCtx);
    const child = runtime!.tracer.startSpan("child", undefined, ctxWithParent);

    try {
      expect(child.isRecording()).toBe(true);
      expect(child.spanContext().traceFlags).toBe(TraceFlags.SAMPLED);
      expect(child.spanContext().traceId).toBe(parentCtx.traceId);
    } finally {
      child.end();
    }
  });
});
