/**
 * Tests for `hasPreloadedOtelSdk()` — the gate that decides whether the
 * plugin registers its own NodeTracerProvider or reuses one already
 * registered by `instrumentation/preload.mjs`.
 *
 * Two concerns are covered:
 *
 *  1. The env/globalThis hint is read correctly across the obvious truth
 *     table (matches the test plan in ISI-1002).
 *  2. When the hint is set, the helper actually verifies that a real global
 *     TracerProvider is registered — defends against sandbox runners that
 *     inherit env vars but strip `NODE_OPTIONS`, in which case the preload
 *     script never executed and the global provider is still a Noop. If the
 *     helper trusted the hint blindly there, the plugin would skip its own
 *     provider registration and silently drop every span.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trace, type TracerProvider } from "@opentelemetry/api";

import {
  PRELOADED_OTEL_SDK_ENV,
  hasPreloadedOtelSdk,
  readPreloadHint,
} from "../src/telemetry.js";

const GLOBAL_FLAG = "__OPENCLAW_OTEL_PRELOAD_ACTIVE";

function stubRealProvider() {
  // Pretend a NodeTracerProvider was registered: the global proxy now has a
  // non-Noop delegate.
  const fakeRealProvider = {
    constructor: { name: "NodeTracerProvider" },
    getTracer: () => ({}) as unknown,
  };
  const fakeProxy = {
    constructor: { name: "ProxyTracerProvider" },
    getDelegate: () => fakeRealProvider,
    getTracer: () => ({}) as unknown,
  };
  return vi
    .spyOn(trace, "getTracerProvider")
    .mockReturnValue(fakeProxy as unknown as TracerProvider);
}

function stubNoopProxy() {
  // Default state of the global proxy when no SDK has called register():
  // getDelegate() returns a NoopTracerProvider sentinel.
  const noopDelegate = {
    constructor: { name: "NoopTracerProvider" },
    getTracer: () => ({}) as unknown,
  };
  const fakeProxy = {
    constructor: { name: "ProxyTracerProvider" },
    getDelegate: () => noopDelegate,
    getTracer: () => ({}) as unknown,
  };
  return vi
    .spyOn(trace, "getTracerProvider")
    .mockReturnValue(fakeProxy as unknown as TracerProvider);
}

describe("hasPreloadedOtelSdk + readPreloadHint", () => {
  let savedEnv: string | undefined;
  let savedFlag: unknown;

  beforeEach(() => {
    savedEnv = process.env[PRELOADED_OTEL_SDK_ENV];
    savedFlag = (globalThis as Record<string, unknown>)[GLOBAL_FLAG];
    delete process.env[PRELOADED_OTEL_SDK_ENV];
    delete (globalThis as Record<string, unknown>)[GLOBAL_FLAG];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env[PRELOADED_OTEL_SDK_ENV];
    } else {
      process.env[PRELOADED_OTEL_SDK_ENV] = savedEnv;
    }
    if (savedFlag === undefined) {
      delete (globalThis as Record<string, unknown>)[GLOBAL_FLAG];
    } else {
      (globalThis as Record<string, unknown>)[GLOBAL_FLAG] = savedFlag;
    }
    vi.restoreAllMocks();
  });

  // ── Hint truth table (M2 baseline) ───────────────────────────────────

  describe("readPreloadHint (pure env/global read)", () => {
    it('returns true when env var === "1"', () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "1";
      expect(readPreloadHint()).toBe(true);
    });

    it("returns true when globalThis flag === true (no env var)", () => {
      (globalThis as Record<string, unknown>)[GLOBAL_FLAG] = true;
      expect(readPreloadHint()).toBe(true);
    });

    it("returns false when both env and globalThis are unset", () => {
      expect(readPreloadHint()).toBe(false);
    });

    it('returns false when env === "0"', () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "0";
      expect(readPreloadHint()).toBe(false);
    });

    it("returns false when env is empty string", () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "";
      expect(readPreloadHint()).toBe(false);
    });

    it('returns false when globalThis flag is truthy but not strictly === true', () => {
      (globalThis as Record<string, unknown>)[GLOBAL_FLAG] = 1;
      expect(readPreloadHint()).toBe(false);
    });
  });

  // ── Hardened helper (M1) ─────────────────────────────────────────────

  describe("hasPreloadedOtelSdk (hint + provider verification)", () => {
    it("returns false when no hint is set (short-circuits before provider check)", () => {
      const spy = vi.spyOn(trace, "getTracerProvider");
      expect(hasPreloadedOtelSdk()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns true when env="1" AND a real TracerProvider is registered', () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "1";
      stubRealProvider();
      expect(hasPreloadedOtelSdk()).toBe(true);
    });

    it("returns true when globalThis flag is set AND a real TracerProvider is registered", () => {
      (globalThis as Record<string, unknown>)[GLOBAL_FLAG] = true;
      stubRealProvider();
      expect(hasPreloadedOtelSdk()).toBe(true);
    });

    it('returns false when env="1" but only a Noop proxy is registered (NODE_OPTIONS stripped)', () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "1";
      stubNoopProxy();
      expect(hasPreloadedOtelSdk()).toBe(false);
    });

    it("returns false when globalThis flag is set but only a Noop proxy is registered", () => {
      (globalThis as Record<string, unknown>)[GLOBAL_FLAG] = true;
      stubNoopProxy();
      expect(hasPreloadedOtelSdk()).toBe(false);
    });

    it('returns false when env="0" regardless of provider state', () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "0";
      const spy = stubRealProvider();
      expect(hasPreloadedOtelSdk()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it("returns false when env is empty regardless of provider state", () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "";
      const spy = stubRealProvider();
      expect(hasPreloadedOtelSdk()).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it("returns false (conservative) when the provider lookup throws", () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "1";
      vi.spyOn(trace, "getTracerProvider").mockImplementation(() => {
        throw new Error("simulated failure");
      });
      expect(hasPreloadedOtelSdk()).toBe(false);
    });

    it("treats a directly-registered non-proxy non-Noop provider as real", () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "1";
      const direct = {
        constructor: { name: "NodeTracerProvider" },
        getTracer: () => ({}) as unknown,
        // no getDelegate — direct register, not via proxy
      };
      vi.spyOn(trace, "getTracerProvider").mockReturnValue(
        direct as unknown as TracerProvider,
      );
      expect(hasPreloadedOtelSdk()).toBe(true);
    });

    it("treats a directly-registered NoopTracerProvider as not real", () => {
      process.env[PRELOADED_OTEL_SDK_ENV] = "1";
      const direct = {
        constructor: { name: "NoopTracerProvider" },
        getTracer: () => ({}) as unknown,
      };
      vi.spyOn(trace, "getTracerProvider").mockReturnValue(
        direct as unknown as TracerProvider,
      );
      expect(hasPreloadedOtelSdk()).toBe(false);
    });
  });
});
