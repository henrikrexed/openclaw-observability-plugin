import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trace, type TracerProvider } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { MeterProvider } from "@opentelemetry/sdk-metrics";

import { CONTENT_POLICY_DISABLED, type OtelObservabilityConfig } from "../src/config.js";
import { PRELOADED_OTEL_SDK_ENV, initTelemetry, type TelemetryRuntime } from "../src/telemetry.js";

const PRE_EXIT_SYMBOL = Symbol.for("openclaw.otel.preExit");

function baseConfig(
  overrides: Partial<OtelObservabilityConfig> = {},
): OtelObservabilityConfig {
  return {
    endpoint: "http://127.0.0.1:14318",
    protocol: "http",
    serviceName: "telemetry-lifecycle-test",
    headers: {},
    traces: false,
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

describe("telemetry runtime lifecycle", () => {
  const runtimes: TelemetryRuntime[] = [];
  let savedPreloadEnv: string | undefined;

  function track(runtime: TelemetryRuntime): TelemetryRuntime {
    runtimes.push(runtime);
    return runtime;
  }

  beforeEach(() => {
    savedPreloadEnv = process.env[PRELOADED_OTEL_SDK_ENV];
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const runtime of runtimes.splice(0)) {
      await runtime.shutdown().catch(() => {});
    }
    if (savedPreloadEnv === undefined) {
      delete process.env[PRELOADED_OTEL_SDK_ENV];
    } else {
      process.env[PRELOADED_OTEL_SDK_ENV] = savedPreloadEnv;
    }
    delete (globalThis as Record<symbol, unknown>)[PRE_EXIT_SYMBOL];
    vi.restoreAllMocks();
  });

  it("reuses the initialized runtime across stop/register hot reload", async () => {
    const logger = makeLoggerSpy();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const first = track(initTelemetry(baseConfig(), logger));
    const second = initTelemetry(
      baseConfig({ serviceName: "changed-during-hot-reload" }),
      logger,
    );

    expect(second).toBe(first);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect((setIntervalSpy.mock.results[0]?.value as { hasRef?: () => boolean }).hasRef?.()).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      "[otel] Reusing existing telemetry runtime (skipping double registration)",
    );
  });

  it("publishes a preExit flush function and shutdown clears it for a real restart", async () => {
    const logger = makeLoggerSpy();
    const first = track(initTelemetry(baseConfig(), logger));

    expect((globalThis as Record<symbol, unknown>)[PRE_EXIT_SYMBOL]).toBe(first.flush);
    await first.shutdown();
    expect((globalThis as Record<symbol, unknown>)[PRE_EXIT_SYMBOL]).toBeUndefined();

    const second = track(initTelemetry(baseConfig({ serviceName: "after-shutdown" }), logger));
    expect(second).not.toBe(first);
    expect((globalThis as Record<symbol, unknown>)[PRE_EXIT_SYMBOL]).toBe(second.flush);
  });

  it("flushes trace and metric providers independently", async () => {
    const logger = makeLoggerSpy();
    const traceFlush = vi
      .spyOn(NodeTracerProvider.prototype, "forceFlush")
      .mockRejectedValueOnce(new Error("trace exporter stalled"));
    const metricFlush = vi
      .spyOn(MeterProvider.prototype, "forceFlush")
      .mockResolvedValueOnce();

    const runtime = track(initTelemetry(baseConfig({ traces: true, metrics: true }), logger));
    await runtime.flush();

    expect(traceFlush).toHaveBeenCalledWith();
    expect(metricFlush).toHaveBeenCalledWith({ timeoutMillis: 3_000 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("trace flush warning: trace exporter stalled"),
    );
  });

  it("times out stalled provider flushes", async () => {
    vi.useFakeTimers();
    const logger = makeLoggerSpy();
    vi.spyOn(NodeTracerProvider.prototype, "forceFlush").mockImplementationOnce(
      () => new Promise<void>(() => {}),
    );
    const metricFlush = vi
      .spyOn(MeterProvider.prototype, "forceFlush")
      .mockResolvedValueOnce();

    const runtime = track(initTelemetry(baseConfig({ traces: true, metrics: true }), logger));
    const flushPromise = runtime.flush();

    await vi.advanceTimersByTimeAsync(3_000);
    await flushPromise;

    expect(metricFlush).toHaveBeenCalledWith({ timeoutMillis: 3_000 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("trace flush warning: trace flush timed out after 3000ms"),
    );
  });

  it("flushes a preloaded global tracer provider when the plugin did not create one", async () => {
    savedPreloadEnv = process.env[PRELOADED_OTEL_SDK_ENV];
    process.env[PRELOADED_OTEL_SDK_ENV] = "1";

    const preloadedForceFlush = vi.fn().mockResolvedValue(undefined);
    const fakeRealProvider = {
      constructor: { name: "NodeTracerProvider" },
      forceFlush: preloadedForceFlush,
      getTracer: () => ({}),
    };
    const fakeProxy = {
      constructor: { name: "ProxyTracerProvider" },
      getDelegate: () => fakeRealProvider,
      getTracer: () => ({}),
    };
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(
      fakeProxy as unknown as TracerProvider,
    );

    const runtime = track(initTelemetry(baseConfig({ traces: true }), makeLoggerSpy()));
    await runtime.flush();

    expect(preloadedForceFlush).toHaveBeenCalledTimes(1);
  });

  it("does not flush an unrelated global tracer provider when traces are disabled", async () => {
    process.env[PRELOADED_OTEL_SDK_ENV] = "1";

    const unrelatedForceFlush = vi.fn().mockResolvedValue(undefined);
    const fakeRealProvider = {
      constructor: { name: "NodeTracerProvider" },
      forceFlush: unrelatedForceFlush,
      getTracer: () => ({}),
    };
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(
      fakeRealProvider as unknown as TracerProvider,
    );

    const runtime = track(initTelemetry(baseConfig({ traces: false, metrics: false }), makeLoggerSpy()));
    await runtime.flush();

    expect(unrelatedForceFlush).not.toHaveBeenCalled();
  });
});
