import { afterEach, describe, expect, it, vi } from "vitest";

describe("plugin service lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("stop flushes telemetry without destructively shutting providers down", async () => {
    vi.resetModules();

    const flush = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const stopHooks = vi.fn();
    const unsubscribeDiagnostics = vi.fn();

    vi.doMock("../src/telemetry.js", () => ({
      initTelemetry: vi.fn(() => ({
        tracer: {},
        meter: {},
        counters: {},
        histograms: {},
        gauges: {},
        flush,
        shutdown,
      })),
      hasPreloadedOtelSdk: vi.fn(() => false),
    }));
    vi.doMock("../src/openllmetry.js", () => ({
      initOpenLLMetry: vi.fn(),
    }));
    vi.doMock("../src/hooks.js", () => ({
      registerHooks: vi.fn(() => stopHooks),
    }));
    vi.doMock("../src/diagnostics.js", () => ({
      registerDiagnosticsListener: vi.fn().mockResolvedValue(unsubscribeDiagnostics),
      hasDiagnosticsSupport: vi.fn(() => true),
    }));
    vi.doMock("../src/logs.js", () => ({
      initLogPipeline: vi.fn(() => null),
      bridgeGatewayLogger: vi.fn(),
    }));

    const services: Array<{ stop?: () => Promise<void> }> = [];
    const api = {
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      pluginConfig: {
        endpoint: "http://127.0.0.1:14318",
        traces: true,
        metrics: true,
        logs: false,
      },
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => services.push(service)),
      registerTool: vi.fn(),
      on: vi.fn(),
    };

    const plugin = (await import("../index.js")).default;
    plugin.register(api);
    await Promise.resolve();

    expect(services).toHaveLength(1);
    await services[0]!.stop?.();

    expect(stopHooks).toHaveBeenCalledTimes(1);
    expect(unsubscribeDiagnostics).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      "[otel] Telemetry flushed (providers preserved for hot-reload)",
    );
  });

  it("gateway_stop destructively shuts telemetry down once", async () => {
    vi.resetModules();

    const flush = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const stopHooks = vi.fn();
    const gatewayHooks = new Map<string, () => Promise<void>>();

    vi.doMock("../src/telemetry.js", () => ({
      initTelemetry: vi.fn(() => ({
        tracer: {},
        meter: {},
        counters: {},
        histograms: {},
        gauges: {},
        flush,
        shutdown,
      })),
      hasPreloadedOtelSdk: vi.fn(() => false),
    }));
    vi.doMock("../src/openllmetry.js", () => ({
      initOpenLLMetry: vi.fn(),
    }));
    vi.doMock("../src/hooks.js", () => ({
      registerHooks: vi.fn(() => stopHooks),
    }));
    vi.doMock("../src/diagnostics.js", () => ({
      registerDiagnosticsListener: vi.fn().mockResolvedValue(() => {}),
      hasDiagnosticsSupport: vi.fn(() => true),
    }));
    vi.doMock("../src/logs.js", () => ({
      initLogPipeline: vi.fn(() => null),
      bridgeGatewayLogger: vi.fn(),
    }));

    const services: Array<{ stop?: () => Promise<void> }> = [];
    const api = {
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      pluginConfig: {
        endpoint: "http://127.0.0.1:14318",
        traces: true,
        metrics: true,
        logs: false,
      },
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => services.push(service)),
      registerTool: vi.fn(),
      on: vi.fn((hookName: string, handler: () => Promise<void>) => {
        gatewayHooks.set(hookName, handler);
      }),
    };

    const plugin = (await import("../index.js")).default;
    plugin.register(api);
    await Promise.resolve();

    expect(api.on).toHaveBeenCalledWith("gateway_stop", expect.any(Function));
    await gatewayHooks.get("gateway_stop")!();
    await gatewayHooks.get("gateway_stop")!();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(api.logger.info).toHaveBeenCalledWith(
      "[otel] Telemetry shut down on gateway_stop",
    );

    await services[0]!.stop?.();
    expect(flush).not.toHaveBeenCalled();
  });

  it("accumulated gateway_stop handlers across reload finalize only once", async () => {
    vi.resetModules();

    const firstShutdown = vi.fn().mockResolvedValue(undefined);
    const secondShutdown = vi.fn().mockResolvedValue(undefined);
    const stopHooks = vi.fn();
    const gatewayHooks: Array<() => Promise<void>> = [];

    vi.doMock("../src/telemetry.js", () => ({
      initTelemetry: vi.fn()
        .mockReturnValueOnce({
          tracer: {},
          meter: {},
          counters: {},
          histograms: {},
          gauges: {},
          flush: vi.fn().mockResolvedValue(undefined),
          shutdown: firstShutdown,
        })
        .mockReturnValueOnce({
          tracer: {},
          meter: {},
          counters: {},
          histograms: {},
          gauges: {},
          flush: vi.fn().mockResolvedValue(undefined),
          shutdown: secondShutdown,
        }),
      hasPreloadedOtelSdk: vi.fn(() => false),
    }));
    vi.doMock("../src/openllmetry.js", () => ({
      initOpenLLMetry: vi.fn(),
    }));
    vi.doMock("../src/hooks.js", () => ({
      registerHooks: vi.fn(() => stopHooks),
    }));
    vi.doMock("../src/diagnostics.js", () => ({
      registerDiagnosticsListener: vi.fn().mockResolvedValue(() => {}),
      hasDiagnosticsSupport: vi.fn(() => true),
    }));
    vi.doMock("../src/logs.js", () => ({
      initLogPipeline: vi.fn(() => null),
      bridgeGatewayLogger: vi.fn(),
    }));

    const services: Array<{ stop?: () => Promise<void> }> = [];
    const api = {
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      pluginConfig: {
        endpoint: "http://127.0.0.1:14318",
        traces: true,
        metrics: true,
        logs: false,
      },
      registerGatewayMethod: vi.fn(),
      registerCli: vi.fn(),
      registerService: vi.fn((service) => services.push(service)),
      registerTool: vi.fn(),
      on: vi.fn((_hookName: string, handler: () => Promise<void>) => {
        gatewayHooks.push(handler);
      }),
    };

    const plugin = (await import("../index.js")).default;
    plugin.register(api);
    await services[0]!.stop?.();
    plugin.register(api);
    await Promise.resolve();

    expect(gatewayHooks).toHaveLength(2);
    await Promise.all(gatewayHooks.map((handler) => handler()));

    expect(firstShutdown).not.toHaveBeenCalled();
    expect(secondShutdown).toHaveBeenCalledTimes(1);
    expect(api.logger.info.mock.calls.filter(
      (call) => call[0] === "[otel] Telemetry shut down on gateway_stop",
    )).toHaveLength(1);
  });
});
