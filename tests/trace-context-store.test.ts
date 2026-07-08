import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Span, Context } from "@opentelemetry/api";
import { TraceContextStore } from "../src/trace-context-store.js";

function createSpanSpy(name: string): Span {
  return {
    spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
    setAttribute: vi.fn().mockReturnThis(),
    setAttributes: vi.fn().mockReturnThis(),
    setStatus: vi.fn().mockReturnThis(),
    addEvent: vi.fn().mockReturnThis(),
    addLink: vi.fn().mockReturnThis(),
    addLinks: vi.fn().mockReturnThis(),
    recordException: vi.fn().mockReturnThis(),
    updateName: vi.fn().mockReturnThis(),
    end: vi.fn(),
    isRecording: () => true,
  } as unknown as Span;
}

function createContextSpy(): Context {
  return {} as Context;
}

describe("TraceContextStore", () => {
  let store: TraceContextStore;

  beforeEach(() => {
    store = new TraceContextStore();
  });

  // ── Active context (legacy compat) ────────────────────────────────

  describe("active context management", () => {
    it("stores and retrieves active context by sessionKey", () => {
      const span = createSpanSpy("root");
      const ctx = createContextSpy();
      store.setActiveContext("s1", {
        rootSpan: span,
        rootContext: ctx,
        startTime: Date.now(),
      });
      const result = store.getActiveContext("s1");
      expect(result).toBeDefined();
      expect(result!.rootSpan).toBe(span);
      expect(result!.rootContext).toBe(ctx);
    });

    it("returns undefined for unknown sessionKey", () => {
      expect(store.getActiveContext("missing")).toBeUndefined();
    });

    it("returns live reference so mutations persist", () => {
      const span = createSpanSpy("root");
      store.setActiveContext("s1", {
        rootSpan: span,
        rootContext: createContextSpy(),
        startTime: Date.now(),
      });

      const agentSpan = createSpanSpy("agent");
      const ctx = store.getActiveContext("s1");
      ctx!.agentSpan = agentSpan;

      expect(store.getActiveContext("s1")!.agentSpan).toBe(agentSpan);
    });

    it("deletes active context", () => {
      store.setActiveContext("s1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startTime: Date.now(),
      });
      store.deleteActiveContext("s1");
      expect(store.getActiveContext("s1")).toBeUndefined();
    });
  });

  // ── Gateway ────────────────────────────────────────────────────────

  describe("gateway context", () => {
    it("stores and retrieves gateway context", () => {
      const span = createSpanSpy("gateway");
      store.setGateway({ span, context: createContextSpy(), startedAt: 100 });
      expect(store.getGateway()).toBeDefined();
      expect(store.getGateway()!.span).toBe(span);
    });

    it("clears gateway context", () => {
      store.setGateway({ span: createSpanSpy("g"), context: createContextSpy(), startedAt: 1 });
      store.clearGateway();
      expect(store.getGateway()).toBeNull();
    });
  });

  // ── Session ────────────────────────────────────────────────────────

  describe("session context", () => {
    it("creates session on first access via getOrCreateSession", () => {
      const ctx = store.getOrCreateSession("s1");
      expect(ctx.requestCount).toBe(0);
      expect(ctx.startedAt).toBeGreaterThan(0);
    });

    it("returns existing session on subsequent calls", () => {
      const first = store.getOrCreateSession("s1");
      first.requestCount = 5;
      const second = store.getOrCreateSession("s1");
      expect(second.requestCount).toBe(5);
    });

    it("deletes session", () => {
      store.setActiveContext("s1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startTime: Date.now(),
      });
      store.deleteSession("s1");
      expect(store.getSession("s1")).toBeUndefined();
    });
  });

  // ── Request ────────────────────────────────────────────────────────

  describe("request context", () => {
    it("stores and retrieves request by requestKey", () => {
      const span = createSpanSpy("request");
      store.setRequest("s1", "r1", {
        rootSpan: span,
        rootContext: createContextSpy(),
        startedAt: 100,
      });
      expect(store.getRequest("r1")).toBeDefined();
      expect(store.getRequest("r1")!.rootSpan).toBe(span);
    });

    it("getActiveRequest returns request for session", () => {
      store.setRequest("s1", "r1", {
        rootSpan: createSpanSpy("req"),
        rootContext: createContextSpy(),
        startedAt: 100,
      });
      expect(store.getActiveRequest("s1")).toBeDefined();
      expect(store.getActiveRequest("s1")!.rootSpan.spanContext().spanId).toBe("s");
    });

    it("increments session requestCount on setRequest", () => {
      store.setRequest("s1", "r1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startedAt: 100,
      });
      store.setRequest("s1", "r2", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startedAt: 200,
      });
      expect(store.getSession("s1")!.requestCount).toBe(2);
    });
  });

  // ── AgentTurn ──────────────────────────────────────────────────────

  describe("agent turn context", () => {
    it("stores and retrieves agent turn", () => {
      const span = createSpanSpy("turn");
      store.setAgentTurn("s1", "t1", {
        span,
        context: createContextSpy(),
        startedAt: 100,
      });
      expect(store.getAgentTurn("t1")).toBeDefined();
      expect(store.getAgentTurn("t1")!.span).toBe(span);
    });

    it("getActiveTurn returns turn for session", () => {
      store.setAgentTurn("s1", "t1", {
        span: createSpanSpy("turn"),
        context: createContextSpy(),
        startedAt: 100,
      });
      expect(store.getActiveTurn("s1")).toBeDefined();
    });

    it("setActiveTurnLlm mutates the active turn", () => {
      store.setAgentTurn("s1", "t1", {
        span: createSpanSpy("turn"),
        context: createContextSpy(),
        startedAt: 100,
      });
      const llmSpan = createSpanSpy("llm");
      store.setActiveTurnLlm("s1", llmSpan, 150);
      const turn = store.getActiveTurn("s1");
      expect(turn!.llmSpan).toBe(llmSpan);
      expect(turn!.llmStartTime).toBe(150);
    });

    it("setActiveTurnModelCall mutates the active turn", () => {
      store.setAgentTurn("s1", "t1", {
        span: createSpanSpy("turn"),
        context: createContextSpy(),
        startedAt: 100,
      });
      const mcSpan = createSpanSpy("model");
      store.setActiveTurnModelCall("s1", mcSpan, 200);
      const turn = store.getActiveTurn("s1");
      expect(turn!.modelCallSpan).toBe(mcSpan);
      expect(turn!.modelCallStartTime).toBe(200);
    });
  });

  // ── CronJob ────────────────────────────────────────────────────────

  describe("cron job context", () => {
    it("stores and retrieves cron job", () => {
      const span = createSpanSpy("cron");
      store.setCronJob("healthcheck", {
        span,
        context: createContextSpy(),
        jobName: "healthcheck",
        startedAt: 100,
      });
      expect(store.getCronJob("healthcheck")).toBeDefined();
      expect(store.getCronJob("healthcheck")!.jobName).toBe("healthcheck");
    });

    it("deletes cron job", () => {
      store.setCronJob("j1", {
        span: createSpanSpy("c"),
        context: createContextSpy(),
        jobName: "j1",
        startedAt: 100,
      });
      expect(store.deleteCronJob("j1")).toBe(true);
      expect(store.getCronJob("j1")).toBeUndefined();
    });
  });

  // ── Sub-agent links ────────────────────────────────────────────────

  describe("sub-agent parent-child links", () => {
    it("links child to parent session", () => {
      store.linkSubAgent("child-session", "parent-session");
      expect(store.getParentSession("child-session")).toBe("parent-session");
    });

    it("unlinks sub-agent", () => {
      store.linkSubAgent("child", "parent");
      store.unlinkSubAgent("child");
      expect(store.getParentSession("child")).toBeUndefined();
    });

    it("resolveParentContext returns parent turn context", () => {
      const parentCtx = createContextSpy();
      store.setAgentTurn("parent", "pt1", {
        span: createSpanSpy("pt"),
        context: parentCtx,
        startedAt: 100,
      });
      store.linkSubAgent("child", "parent");
      expect(store.resolveParentContext("child")).toBe(parentCtx);
    });

    it("resolveParentContext falls back to parent request context", () => {
      const parentCtx = createContextSpy();
      store.setRequest("parent", "pr1", {
        rootSpan: createSpanSpy("pr"),
        rootContext: parentCtx,
        startedAt: 100,
      });
      store.linkSubAgent("child", "parent");
      expect(store.resolveParentContext("child")).toBe(parentCtx);
    });

    it("resolveParentContext returns undefined when no parent context exists", () => {
      store.linkSubAgent("child", "parent-noctx");
      expect(store.resolveParentContext("child")).toBeUndefined();
    });
  });

  // ── Legacy resolution ──────────────────────────────────────────────

  describe("resolveLegacyContext", () => {
    it("resolves from active turn + request", () => {
      const rootSpan = createSpanSpy("root");
      const turnSpan = createSpanSpy("turn");
      const reqCtx = createContextSpy();
      const turnCtx = createContextSpy();

      store.setRequest("s1", "r1", {
        rootSpan,
        rootContext: reqCtx,
        startedAt: 100,
      });
      store.setAgentTurn("s1", "t1", {
        span: turnSpan,
        context: turnCtx,
        startedAt: 150,
      });

      const legacy = store.resolveLegacyContext("s1");
      expect(legacy).toBeDefined();
      expect(legacy!.rootSpan).toBe(rootSpan);
      expect(legacy!.agentSpan).toBe(turnSpan);
      expect(legacy!.agentContext).toBe(turnCtx);
    });

    it("resolves from request only when no turn exists", () => {
      const rootSpan = createSpanSpy("root");
      store.setRequest("s1", "r1", {
        rootSpan,
        rootContext: createContextSpy(),
        startedAt: 100,
      });

      const legacy = store.resolveLegacyContext("s1");
      expect(legacy).toBeDefined();
      expect(legacy!.rootSpan).toBe(rootSpan);
      expect(legacy!.agentSpan).toBeUndefined();
    });

    it("resolves from turn only when no request exists", () => {
      const turnSpan = createSpanSpy("turn");
      store.setAgentTurn("s1", "t1", {
        span: turnSpan,
        context: createContextSpy(),
        startedAt: 100,
      });

      const legacy = store.resolveLegacyContext("s1");
      expect(legacy).toBeDefined();
      expect(legacy!.rootSpan).toBe(turnSpan);
      expect(legacy!.agentSpan).toBe(turnSpan);
    });

    it("returns undefined when no context exists", () => {
      expect(store.resolveLegacyContext("missing")).toBeUndefined();
    });

    it("traverses sub-agent link when child has no context", () => {
      const rootSpan = createSpanSpy("root");
      const turnSpan = createSpanSpy("turn");
      store.setRequest("parent", "pr1", {
        rootSpan,
        rootContext: createContextSpy(),
        startedAt: 100,
      });
      store.setAgentTurn("parent", "pt1", {
        span: turnSpan,
        context: createContextSpy(),
        startedAt: 150,
      });
      store.linkSubAgent("child", "parent");

      const legacy = store.resolveLegacyContext("child");
      expect(legacy).toBeDefined();
      expect(legacy!.rootSpan).toBe(rootSpan);
      expect(legacy!.agentSpan).toBe(turnSpan);
    });

    it("traverses multi-level sub-agent chain", () => {
      const rootSpan = createSpanSpy("root");
      store.setRequest("grandparent", "gp1", {
        rootSpan,
        rootContext: createContextSpy(),
        startedAt: 100,
      });
      store.linkSubAgent("child", "parent");
      store.linkSubAgent("parent", "grandparent");

      const legacy = store.resolveLegacyContext("child");
      expect(legacy).toBeDefined();
      expect(legacy!.rootSpan).toBe(rootSpan);
    });

    it("handles circular sub-agent links without infinite loop", () => {
      store.linkSubAgent("a", "b");
      store.linkSubAgent("b", "a");

      const legacy = store.resolveLegacyContext("a");
      expect(legacy).toBeUndefined();
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────────

  describe("cleanupSession", () => {
    it("cleans up all contexts for a session", () => {
      store.setActiveContext("s1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startTime: Date.now(),
      });
      store.setRequest("s1", "r1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startedAt: Date.now(),
      });
      store.setAgentTurn("s1", "t1", {
        span: createSpanSpy("t"),
        context: createContextSpy(),
        startedAt: Date.now(),
      });
      store.linkSubAgent("s1", "parent");

      store.cleanupSession("s1");

      expect(store.getActiveContext("s1")).toBeUndefined();
      expect(store.getActiveRequest("s1")).toBeUndefined();
      expect(store.getActiveTurn("s1")).toBeUndefined();
      expect(store.getParentSession("s1")).toBeUndefined();
    });
  });

  describe("cleanupStale", () => {
    it("removes contexts older than maxAgeMs", () => {
      const oldTime = Date.now() - 600_000;
      store.setActiveContext("old", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startTime: oldTime,
      });
      store.setActiveContext("fresh", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startTime: Date.now(),
      });

      const cleaned = store.cleanupStale(300_000);
      expect(cleaned).toBe(1);
      expect(store.getActiveContext("old")).toBeUndefined();
      expect(store.getActiveContext("fresh")).toBeDefined();
    });
  });

  describe("clear", () => {
    it("clears everything", () => {
      store.setActiveContext("s1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startTime: Date.now(),
      });
      store.setGateway({ span: createSpanSpy("g"), context: createContextSpy(), startedAt: 1 });
      store.linkSubAgent("child", "parent");

      store.clear();

      expect(store.getGateway()).toBeNull();
      expect(store.getActiveContext("s1")).toBeUndefined();
      expect(store.getParentSession("child")).toBeUndefined();
      expect(store.stats.sessions).toBe(0);
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────

  describe("stats", () => {
    it("reports accurate counts", () => {
      store.setActiveContext("s1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startTime: Date.now(),
      });
      store.setRequest("s2", "r1", {
        rootSpan: createSpanSpy("r"),
        rootContext: createContextSpy(),
        startedAt: Date.now(),
      });
      store.setAgentTurn("s3", "t1", {
        span: createSpanSpy("t"),
        context: createContextSpy(),
        startedAt: Date.now(),
      });
      store.setCronJob("j1", {
        span: createSpanSpy("c"),
        context: createContextSpy(),
        jobName: "j1",
        startedAt: Date.now(),
      });
      store.linkSubAgent("child", "parent");

      const stats = store.stats;
      expect(stats.agentTurns).toBe(1);
      expect(stats.cronJobs).toBe(1);
      expect(stats.subAgentLinks).toBe(1);
    });
  });

  describe("retained recent request context (ISI-1653)", () => {
    it("returns a retained root context within the TTL window", () => {
      const ctx = createContextSpy();
      store.retainRecentRequest("s1", ctx);
      expect(store.getRecentRequestContext("s1")).toBe(ctx);
    });

    it("returns undefined for a session with nothing retained", () => {
      expect(store.getRecentRequestContext("missing")).toBeUndefined();
    });

    it("evicts and returns undefined once the entry ages past the TTL", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const ctx = createContextSpy();
        store.retainRecentRequest("s1", ctx);
        // Just inside the 60s TTL — still resolvable.
        vi.setSystemTime(59_000);
        expect(store.getRecentRequestContext("s1")).toBe(ctx);
        // Past the TTL — evicted.
        vi.setSystemTime(61_000);
        expect(store.getRecentRequestContext("s1")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cleanupSession retains the request root so a trailing event can nest", () => {
      const rootCtx = createContextSpy();
      store.setActiveContext("s1", {
        rootSpan: createSpanSpy("openclaw.request"),
        rootContext: rootCtx,
        startTime: Date.now(),
      });
      store.cleanupSession("s1");
      // Live context is gone…
      expect(store.getActiveContext("s1")).toBeUndefined();
      // …but the trace is retained for trailing lifecycle spans.
      expect(store.getRecentRequestContext("s1")).toBe(rootCtx);
    });

    it("clear() drops retained contexts", () => {
      store.retainRecentRequest("s1", createContextSpy());
      store.clear();
      expect(store.getRecentRequestContext("s1")).toBeUndefined();
    });
  });
});
