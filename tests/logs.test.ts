/**
 * Tests for the log export pipeline (ISI-930: Sprint 7).
 *
 * Covers:
 *   - Log filtering/exclusion rules for noisy logs
 *   - Log config parsing from raw input
 *   - Log pipeline disabled when config.logs = false
 */

import { describe, expect, it, vi } from "vitest";

import {
  bridgeGatewayLogger,
  initLogPipeline,
  parseLogConfig,
  shouldExclude,
  toAnyValue,
  type LogEvent,
  type LogPipelineConfig,
} from "../src/logs.js";
import type { OtelObservabilityConfig } from "../src/config.js";

function createConfig(overrides: Partial<OtelObservabilityConfig> = {}): OtelObservabilityConfig {
  return {
    endpoint: "http://localhost:4318",
    protocol: "http",
    serviceName: "test-gateway",
    headers: {},
    traces: true,
    metrics: true,
    logs: true,
    captureContent: false,
    metricsIntervalMs: 30_000,
    resourceAttributes: {},
    ...overrides,
  };
}

function createLogEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    type: "log.record",
    level: "info",
    message: "test log message",
    logger: "test-logger",
    function: "handleRequest",
    file: "server.ts",
    line: 42,
    sessionKey: "session-123",
    agentId: "agent-456",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("log pipeline initialization (ISI-930)", () => {
  it("returns null when logs are disabled in config", () => {
    const config = createConfig({ logs: false });
    const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pipeline = initLogPipeline(config, logger);
    expect(pipeline).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      "[otel-logs] Log export disabled in config"
    );
  });
});

describe("log filtering/exclusion (ISI-930)", () => {
  it("excludes logs matching excluded levels", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [],
      excludeLevels: ["debug", "trace"],
      excludeLoggers: [],
      excludeMessagePatterns: [],
    };

    expect(shouldExclude(createLogEvent({ level: "debug" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ level: "trace" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ level: "info" }), config)).toBe(false);
  });

  it("excludes logs matching excluded loggers (case-insensitive substring)", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [],
      excludeLevels: [],
      excludeLoggers: ["noisy-module", "verbose-lib"],
      excludeMessagePatterns: [],
    };

    expect(shouldExclude(createLogEvent({ logger: "noisy-module.service" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ logger: "VERBOSE-LIB" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ logger: "important-service" }), config)).toBe(false);
  });

  it("excludes logs matching message patterns (string and regex)", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [],
      excludeLevels: [],
      excludeLoggers: [],
      excludeMessagePatterns: ["health check", /ping/i],
    };

    expect(shouldExclude(createLogEvent({ message: "health check OK" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ message: "PING received" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ message: "processing request" }), config)).toBe(false);
  });

  it("applies filter rules with exclude action", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [
        { field: "logger", pattern: "internal.", action: "exclude" },
      ],
      excludeLevels: [],
      excludeLoggers: [],
      excludeMessagePatterns: [],
    };

    expect(shouldExclude(createLogEvent({ logger: "internal.scheduler" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ logger: "external.api" }), config)).toBe(false);
  });

  it("applies filter rules with include action (keeps matching logs)", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [
        { field: "level", pattern: "error", action: "include" },
      ],
      excludeLevels: [],
      excludeLoggers: [],
      excludeMessagePatterns: [],
    };

    expect(shouldExclude(createLogEvent({ level: "error" }), config)).toBe(false);
    expect(shouldExclude(createLogEvent({ level: "info" }), config)).toBe(false);
  });

  it("filters by type field", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [
        { field: "type", pattern: "health", action: "exclude" },
      ],
      excludeLevels: [],
      excludeLoggers: [],
      excludeMessagePatterns: [],
    };

    expect(shouldExclude(createLogEvent({ type: "health" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ type: "log.record" }), config)).toBe(false);
  });

  it("passes through when no filters match", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [],
      excludeLevels: [],
      excludeLoggers: [],
      excludeMessagePatterns: [],
    };

    expect(shouldExclude(createLogEvent(), config)).toBe(false);
  });

  it("checks exclusion order: levels → loggers → patterns → filter rules", () => {
    const config: LogPipelineConfig = {
      enabled: true,
      filters: [],
      excludeLevels: ["debug"],
      excludeLoggers: ["noisy"],
      excludeMessagePatterns: ["skip-me"],
    };

    expect(shouldExclude(createLogEvent({ level: "debug" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ logger: "noisy.svc" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ message: "skip-me please" }), config)).toBe(true);
    expect(shouldExclude(createLogEvent({ level: "info", logger: "ok", message: "normal" }), config)).toBe(false);
  });
});

describe("parseLogConfig (ISI-930)", () => {
  it("returns defaults for null input", () => {
    const config = parseLogConfig(null);
    expect(config.enabled).toBe(true);
    expect(config.filters).toEqual([]);
    expect(config.excludeLevels).toEqual([]);
    expect(config.excludeLoggers).toEqual([]);
    expect(config.excludeMessagePatterns).toEqual([]);
  });

  it("returns defaults for non-object input", () => {
    const config = parseLogConfig("string");
    expect(config.enabled).toBe(true);
  });

  it("parses excludeLevels (lowercased)", () => {
    const config = parseLogConfig({ excludeLevels: ["DEBUG", "Trace"] });
    expect(config.excludeLevels).toEqual(["debug", "trace"]);
  });

  it("parses excludeLoggers", () => {
    const config = parseLogConfig({ excludeLoggers: ["noisy-lib"] });
    expect(config.excludeLoggers).toEqual(["noisy-lib"]);
  });

  it("parses excludeMessagePatterns (string values)", () => {
    const config = parseLogConfig({ excludeMessagePatterns: ["health"] });
    expect(config.excludeMessagePatterns).toEqual(["health"]);
  });

  it("preserves RegExp instances in excludeMessagePatterns", () => {
    const regex = /ping/i;
    const config = parseLogConfig({ excludeMessagePatterns: [regex] });
    expect(config.excludeMessagePatterns).toEqual([regex]);
  });

  it("parses valid filter rules", () => {
    const config = parseLogConfig({
      filters: [
        { field: "logger", pattern: "noisy", action: "exclude" },
        { field: "message", pattern: /skip/i, action: "exclude" },
      ],
    });
    expect(config.filters.length).toBe(2);
    expect(config.filters[0].field).toBe("logger");
    expect(config.filters[0].action).toBe("exclude");
    expect(config.filters[1].pattern).toEqual(/skip/i);
  });

  it("ignores invalid filter rules", () => {
    const config = parseLogConfig({
      filters: [
        { field: "invalid_field", pattern: "x", action: "exclude" },
        { field: "logger", pattern: 123, action: "exclude" },
        { field: "logger", pattern: "ok", action: "bad_action" },
        "not-an-object",
        null,
      ],
    });
    expect(config.filters).toEqual([]);
  });

  it("sets enabled=false when explicitly disabled", () => {
    const config = parseLogConfig({ enabled: false });
    expect(config.enabled).toBe(false);
  });

  it("filters out non-string values from excludeLevels", () => {
    const config = parseLogConfig({ excludeLevels: ["debug", 42, null, "info"] });
    expect(config.excludeLevels).toEqual(["debug", "info"]);
  });
});

// ─── ISI-999 M3: redaction in the OTLP log bridge ───────────────────────

describe("toAnyValue redaction (ISI-999 M3)", () => {
  it("redacts string scalars before they leave the log bridge", () => {
    expect(toAnyValue("Authorization: Bearer abcdef1234567890ABCDEF")).toBe(
      "Authorization: Bearer [REDACTED_TOKEN]",
    );
    expect(toAnyValue("user bob@example.com signed in")).toBe(
      "user [REDACTED_EMAIL] signed in",
    );
  });

  it("recursively redacts strings inside nested attribute payloads", () => {
    const result = toAnyValue({
      header: "Authorization: Bearer abcdef1234567890ABCDEF",
      meta: {
        actor: "alice@example.com",
        count: 3,
        enabled: true,
        nested: ["sk-abcdefghijklmnopqrstuv", 42],
      },
    });
    expect(result).toEqual({
      header: "Authorization: Bearer [REDACTED_TOKEN]",
      meta: {
        actor: "[REDACTED_EMAIL]",
        count: 3,
        enabled: true,
        nested: ["[REDACTED_API_KEY]", 42],
      },
    });
  });

  it("passes numbers, booleans, null, and Uint8Array through unchanged", () => {
    expect(toAnyValue(42)).toBe(42);
    expect(toAnyValue(true)).toBe(true);
    expect(toAnyValue(null)).toBe(null);
    expect(toAnyValue(undefined)).toBe(undefined);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(toAnyValue(bytes)).toBe(bytes);
  });
});

describe("bridgeGatewayLogger (ISI-997)", () => {
  function makeLogger() {
    return {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
  }

  it("forwards every log level to both the original logger and the OTel emitter", () => {
    const logger = makeLogger();
    const emit = vi.fn();
    // Capture original spy references — the bridge replaces logger[level]
    // with a wrapper, but the wrapper still invokes the captured spy.
    const originalInfo = logger.info;
    const originalError = logger.error;
    bridgeGatewayLogger(logger, emit);

    logger.info("startup complete");
    logger.warn("slow request");
    logger.error("boom");
    logger.debug("trace internals");
    logger.trace("very chatty");
    logger.fatal("game over");

    expect(emit).toHaveBeenCalledTimes(6);
    expect(originalInfo).toHaveBeenCalledWith("startup complete");
    expect(originalError).toHaveBeenCalledWith("boom");

    const levels = emit.mock.calls.map(([evt]: [LogEvent]) => evt.level);
    expect(levels).toEqual(["info", "warn", "error", "debug", "trace", "fatal"]);
    for (const [evt] of emit.mock.calls) {
      expect((evt as LogEvent).logger).toBe("openclaw-gateway");
      expect(typeof (evt as LogEvent).timestamp).toBe("number");
    }
  });

  it("preserves pino-style (object, message) calls — attrs spread, message extracted", () => {
    const logger = makeLogger();
    const emit = vi.fn();
    const originalInfo = logger.info;
    bridgeGatewayLogger(logger, emit);

    logger.info({ requestId: "req-123", userId: 42 }, "request handled");

    expect(emit).toHaveBeenCalledTimes(1);
    const [evt] = emit.mock.calls[0] as [LogEvent];
    expect(evt.level).toBe("info");
    expect(evt.message).toBe("request handled");
    expect(evt.requestId).toBe("req-123");
    expect(evt.userId).toBe(42);
    expect(originalInfo).toHaveBeenCalledWith(
      { requestId: "req-123", userId: 42 },
      "request handled"
    );
  });

  it("concatenates string-rest args (printf-style logs) into the message", () => {
    const logger = makeLogger();
    const emit = vi.fn();
    bridgeGatewayLogger(logger, emit);

    logger.warn("user %s exceeded quota", "alice");

    const [evt] = emit.mock.calls[0] as [LogEvent];
    expect(evt.message).toBe("user %s exceeded quota alice");
  });

  it("never throws when the emitter throws — gateway logging keeps working", () => {
    const logger = makeLogger();
    const emit = vi.fn().mockImplementation(() => {
      throw new Error("OTLP exporter is sad");
    });
    const originalInfo = logger.info;
    bridgeGatewayLogger(logger, emit);

    expect(() => logger.info("hello")).not.toThrow();
    expect(originalInfo).toHaveBeenCalledWith("hello");
  });

  it("restore() puts the original logger methods back", () => {
    const logger = makeLogger();
    const emit = vi.fn();
    const original = logger.info;
    const restore = bridgeGatewayLogger(logger, emit);

    // Bridge is in place.
    logger.info("bridged");
    expect(emit).toHaveBeenCalledTimes(1);

    restore();

    // After restore, the original method is back and emit is not called again.
    logger.info("post-restore");
    expect(logger.info).toBe(original);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("skips levels the logger does not implement", () => {
    const partial: any = { info: vi.fn(), error: vi.fn() };
    const emit = vi.fn();

    expect(() => bridgeGatewayLogger(partial, emit)).not.toThrow();

    partial.info("ok");
    partial.error("bad");
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
