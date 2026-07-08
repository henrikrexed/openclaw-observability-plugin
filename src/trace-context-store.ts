/**
 * Tiered trace context store — replaces flat `sessionContextMap` with
 * structured, tiered maps for gateway, session, request, agentTurn, and
 * cron-job contexts. Supports sub-agent parent-child linking.
 *
 * Tiers:
 *   1. gateway  — spans the full gateway process lifetime
 *   2. session  — one per conversation (may span multiple requests)
 *   3. request  — one per `message_received` → `agent_end` cycle
 *   4. agentTurn — one per `before_model_resolve` → `agent_end` cycle
 *   5. cronJob  — one per cron execution
 *
 * Context lookup order: agentTurn → request → session → gateway.
 */

import { type Span, type Context } from "@opentelemetry/api";

// ── Tier interfaces ──────────────────────────────────────────────────

export interface GatewayContext {
  span: Span;
  context: Context;
  startedAt: number;
}

export interface SessionContext {
  span?: Span;
  context?: Context;
  startedAt: number;
  requestCount: number;
  channel?: string;
}

export interface RequestContext {
  rootSpan: Span;
  rootContext: Context;
  startedAt: number;
}

export interface AgentTurnContext {
  span: Span;
  context: Context;
  llmSpan?: Span;
  llmStartTime?: number;
  modelCallSpan?: Span;
  modelCallStartTime?: number;
  startedAt: number;
}

export interface CronJobContext {
  span: Span;
  context: Context;
  jobName: string;
  startedAt: number;
}

/** In-flight tool span keyed by toolCallId. */
export interface ActiveToolSpan {
  span: Span;
  startTime: number;
  approvalRequested?: boolean;
  approvalResolvedAt?: number;
}

/** Legacy-compatible context that hooks.ts used to manage inline. */
export interface LegacyTraceContext {
  rootSpan: Span;
  rootContext: Context;
  agentSpan?: Span;
  agentContext?: Context;
  llmSpan?: Span;
  llmStartTime?: number;
  modelCallSpan?: Span;
  modelCallStartTime?: number;
  dispatchSpan?: Span;
  dispatchStartTime?: number;
  activeToolSpans?: Map<string, ActiveToolSpan>;
  startTime: number;
}

// ── Store ────────────────────────────────────────────────────────────

export class TraceContextStore {
  private gateway: GatewayContext | null = null;
  private sessions = new Map<string, SessionContext>();
  private requests = new Map<string, RequestContext>();
  private agentTurns = new Map<string, AgentTurnContext>();
  private cronJobs = new Map<string, CronJobContext>();
  private activeContexts = new Map<string, LegacyTraceContext>();

  private subAgentLinks = new Map<string, string>();

  private activeRequestKey = new Map<string, string>();
  private activeTurnKey = new Map<string, string>();

  // ── Retained recent request contexts (ISI-1653) ───────────────────
  // Trailing lifecycle events — an outbound `message_sent` (channel
  // delivery) or a late `cron_changed` — frequently fire AFTER `agent_end`
  // has already run `cleanupSession`, so the live activeContext is gone and
  // the span would start a fresh root, orphaning into its own single-span
  // trace. We retain the just-ended request's root Context briefly, keyed by
  // sessionKey, so those trailing spans still nest into the SAME trace as the
  // request they belong to. Bounded by size + TTL: the size cap prevents
  // unbounded growth, and the TTL prevents a much-later event from being
  // cross-linked into a stale, unrelated trace.
  private recentRequests = new Map<string, { rootContext: Context; retainedAt: number }>();
  private static readonly RECENT_MAX = 256;
  private static readonly RECENT_TTL_MS = 60_000;

  // ── Gateway ───────────────────────────────────────────────────────

  setGateway(ctx: GatewayContext): void {
    this.gateway = ctx;
  }

  getGateway(): GatewayContext | null {
    return this.gateway;
  }

  clearGateway(): void {
    this.gateway = null;
  }

  // ── Active context (live-references for mutation pattern) ──────────

  setActiveContext(sessionKey: string, ctx: LegacyTraceContext): void {
    this.activeContexts.set(sessionKey, ctx);
  }

  getActiveContext(sessionKey: string): LegacyTraceContext | undefined {
    return this.activeContexts.get(sessionKey);
  }

  deleteActiveContext(sessionKey: string): void {
    this.activeContexts.delete(sessionKey);
  }

  get activeContextCount(): number {
    return this.activeContexts.size;
  }

  activeContextEntries(): IterableIterator<[string, LegacyTraceContext]> {
    return this.activeContexts.entries();
  }

  // ── Session ───────────────────────────────────────────────────────

  setSession(sessionKey: string, ctx: SessionContext): void {
    this.sessions.set(sessionKey, ctx);
  }

  getSession(sessionKey: string): SessionContext | undefined {
    return this.sessions.get(sessionKey);
  }

  getOrCreateSession(sessionKey: string): SessionContext {
    let ctx = this.sessions.get(sessionKey);
    if (!ctx) {
      ctx = { startedAt: Date.now(), requestCount: 0 };
      this.sessions.set(sessionKey, ctx);
    }
    return ctx;
  }

  deleteSession(sessionKey: string): boolean {
    this.activeRequestKey.delete(sessionKey);
    this.activeTurnKey.delete(sessionKey);
    return this.sessions.delete(sessionKey);
  }

  // ── Request ───────────────────────────────────────────────────────

  setRequest(sessionKey: string, requestKey: string, ctx: RequestContext): void {
    this.requests.set(requestKey, ctx);
    this.activeRequestKey.set(sessionKey, requestKey);
    const session = this.getOrCreateSession(sessionKey);
    session.requestCount++;
  }

  getRequest(requestKey: string): RequestContext | undefined {
    return this.requests.get(requestKey);
  }

  getActiveRequest(sessionKey: string): RequestContext | undefined {
    const rk = this.activeRequestKey.get(sessionKey);
    return rk ? this.requests.get(rk) : undefined;
  }

  deleteRequest(requestKey: string): void {
    this.requests.delete(requestKey);
  }

  // ── AgentTurn ─────────────────────────────────────────────────────

  setAgentTurn(sessionKey: string, turnKey: string, ctx: AgentTurnContext): void {
    this.agentTurns.set(turnKey, ctx);
    this.activeTurnKey.set(sessionKey, turnKey);
  }

  getAgentTurn(turnKey: string): AgentTurnContext | undefined {
    return this.agentTurns.get(turnKey);
  }

  getActiveTurn(sessionKey: string): AgentTurnContext | undefined {
    const tk = this.activeTurnKey.get(sessionKey);
    return tk ? this.agentTurns.get(tk) : undefined;
  }

  deleteAgentTurn(turnKey: string): void {
    this.agentTurns.delete(turnKey);
  }

  // ── CronJob ───────────────────────────────────────────────────────

  setCronJob(jobKey: string, ctx: CronJobContext): void {
    this.cronJobs.set(jobKey, ctx);
  }

  getCronJob(jobKey: string): CronJobContext | undefined {
    return this.cronJobs.get(jobKey);
  }

  deleteCronJob(jobKey: string): boolean {
    return this.cronJobs.delete(jobKey);
  }

  // ── Sub-agent links ───────────────────────────────────────────────

  linkSubAgent(childSessionKey: string, parentSessionKey: string): void {
    this.subAgentLinks.set(childSessionKey, parentSessionKey);
  }

  getParentSession(childSessionKey: string): string | undefined {
    return this.subAgentLinks.get(childSessionKey);
  }

  unlinkSubAgent(childSessionKey: string): void {
    this.subAgentLinks.delete(childSessionKey);
  }

  // ── Resolved context (legacy compat) ──────────────────────────────

  resolveLegacyContext(sessionKey: string, _visited?: Set<string>): LegacyTraceContext | undefined {
    const visited = _visited ?? new Set<string>();
    if (visited.has(sessionKey)) return undefined;
    visited.add(sessionKey);

    const turn = this.getActiveTurn(sessionKey);
    const req = this.getActiveRequest(sessionKey);
    const legacy = this.activeContexts.get(sessionKey);

    if (turn && req) {
      return {
        rootSpan: req.rootSpan,
        rootContext: req.rootContext,
        agentSpan: turn.span,
        agentContext: turn.context,
        llmSpan: turn.llmSpan,
        llmStartTime: turn.llmStartTime,
        modelCallSpan: turn.modelCallSpan,
        modelCallStartTime: turn.modelCallStartTime,
        dispatchSpan: legacy?.dispatchSpan,
        dispatchStartTime: legacy?.dispatchStartTime,
        activeToolSpans: legacy?.activeToolSpans,
        startTime: req.startedAt,
      };
    }

    if (req) {
      return {
        rootSpan: req.rootSpan,
        rootContext: req.rootContext,
        dispatchSpan: legacy?.dispatchSpan,
        dispatchStartTime: legacy?.dispatchStartTime,
        activeToolSpans: legacy?.activeToolSpans,
        startTime: req.startedAt,
      };
    }

    if (turn) {
      return {
        rootSpan: turn.span,
        rootContext: turn.context,
        agentSpan: turn.span,
        agentContext: turn.context,
        llmSpan: turn.llmSpan,
        llmStartTime: turn.llmStartTime,
        modelCallSpan: turn.modelCallSpan,
        modelCallStartTime: turn.modelCallStartTime,
        dispatchSpan: legacy?.dispatchSpan,
        dispatchStartTime: legacy?.dispatchStartTime,
        activeToolSpans: legacy?.activeToolSpans,
        startTime: turn.startedAt,
      };
    }

    const parentKey = this.subAgentLinks.get(sessionKey);
    if (parentKey) {
      return this.resolveLegacyContext(parentKey, visited);
    }

    return undefined;
  }

  // ── Retained recent request context (ISI-1653) ────────────────────

  /**
   * Retain a request's root Context after it ends so a trailing lifecycle
   * event (outbound `message_sent`, late `cron_changed`) that fires after
   * teardown can still nest into the same trace. Evicts the oldest entry
   * when the size cap is reached (the Map is insertion-ordered).
   */
  retainRecentRequest(sessionKey: string, rootContext: Context): void {
    // Re-insert to move this key to the newest position.
    this.recentRequests.delete(sessionKey);
    if (this.recentRequests.size >= TraceContextStore.RECENT_MAX) {
      const oldest = this.recentRequests.keys().next().value;
      if (oldest !== undefined) this.recentRequests.delete(oldest);
    }
    this.recentRequests.set(sessionKey, { rootContext, retainedAt: Date.now() });
  }

  /**
   * Return the retained root Context for a recently-ended request, or
   * undefined when none exists or the retained entry has aged past the TTL
   * (in which case it is evicted so it can never parent a stale trace).
   */
  getRecentRequestContext(sessionKey: string): Context | undefined {
    const retained = this.recentRequests.get(sessionKey);
    if (!retained) return undefined;
    if (Date.now() - retained.retainedAt > TraceContextStore.RECENT_TTL_MS) {
      this.recentRequests.delete(sessionKey);
      return undefined;
    }
    return retained.rootContext;
  }

  resolveParentContext(sessionKey: string): Context | undefined {
    const parentKey = this.subAgentLinks.get(sessionKey);
    if (!parentKey) return undefined;

    const parentTurn = this.getActiveTurn(parentKey);
    if (parentTurn) return parentTurn.context;

    const parentReq = this.getActiveRequest(parentKey);
    if (parentReq) return parentReq.rootContext;

    return undefined;
  }

  // ── Mutable accessors for active turn ─────────────────────────────

  setActiveTurnLlm(sessionKey: string, span: Span | undefined, startTime?: number): void {
    const turn = this.getActiveTurn(sessionKey);
    if (turn) {
      turn.llmSpan = span;
      turn.llmStartTime = startTime;
    }
  }

  setActiveTurnModelCall(sessionKey: string, span: Span | undefined, startTime?: number): void {
    const turn = this.getActiveTurn(sessionKey);
    if (turn) {
      turn.modelCallSpan = span;
      turn.modelCallStartTime = startTime;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  cleanupSession(sessionKey: string): void {
    const rk = this.activeRequestKey.get(sessionKey);
    const tk = this.activeTurnKey.get(sessionKey);

    // ISI-1653: retain the request's root trace briefly BEFORE teardown so a
    // trailing `message_sent` / `cron_changed` still nests into this trace
    // instead of orphaning. Prefer the request tier, fall back to the legacy
    // activeContext root.
    const retainRoot =
      (rk ? this.requests.get(rk)?.rootContext : undefined) ??
      this.activeContexts.get(sessionKey)?.rootContext;
    if (retainRoot) this.retainRecentRequest(sessionKey, retainRoot);

    if (tk) {
      const turn = this.agentTurns.get(tk);
      if (turn) {
        try { turn.llmSpan?.end(); } catch { /* ignore */ }
        try { turn.modelCallSpan?.end(); } catch { /* ignore */ }
        try { turn.span.end(); } catch { /* ignore */ }
      }
      this.agentTurns.delete(tk);
    }

    if (rk) {
      const req = this.requests.get(rk);
      if (req) {
        try { req.rootSpan.end(); } catch { /* ignore */ }
      }
      this.requests.delete(rk);
    }

    this.activeRequestKey.delete(sessionKey);
    this.activeTurnKey.delete(sessionKey);
    this.subAgentLinks.delete(sessionKey);
    this.sessions.delete(sessionKey);
    this.activeContexts.delete(sessionKey);
  }

  cleanupStale(maxAgeMs: number): number {
    const now = Date.now();
    let cleaned = 0;

    const staleContexts: string[] = [];
    for (const [key, ctx] of this.activeContexts) {
      if (now - ctx.startTime > maxAgeMs) {
        try { ctx.llmSpan?.end(); } catch { /* ignore */ }
        try { ctx.modelCallSpan?.end(); } catch { /* ignore */ }
        try { ctx.dispatchSpan?.end(); } catch { /* ignore */ }
        try { ctx.agentSpan?.end(); } catch { /* ignore */ }
        if (ctx.activeToolSpans) {
          for (const [, active] of ctx.activeToolSpans) {
            try { active.span.end(); } catch { /* ignore */ }
          }
        }
        if (ctx.rootSpan !== ctx.agentSpan) {
          try { ctx.rootSpan.end(); } catch { /* ignore */ }
        }
        staleContexts.push(key);
        cleaned++;
      }
    }
    for (const key of staleContexts) {
      this.activeContexts.delete(key);
    }

    const staleRequests: string[] = [];
    for (const [key, ctx] of this.requests) {
      if (now - ctx.startedAt > maxAgeMs) {
        try { ctx.rootSpan.end(); } catch { /* ignore */ }
        staleRequests.push(key);
        cleaned++;
      }
    }
    for (const key of staleRequests) {
      this.requests.delete(key);
    }

    const staleTurns: string[] = [];
    for (const [key, ctx] of this.agentTurns) {
      if (now - ctx.startedAt > maxAgeMs) {
        try { ctx.llmSpan?.end(); } catch { /* ignore */ }
        try { ctx.modelCallSpan?.end(); } catch { /* ignore */ }
        try { ctx.span.end(); } catch { /* ignore */ }
        staleTurns.push(key);
        cleaned++;
      }
    }
    for (const key of staleTurns) {
      this.agentTurns.delete(key);
    }

    const staleCronJobs: string[] = [];
    for (const [key, ctx] of this.cronJobs) {
      if (now - ctx.startedAt > maxAgeMs) {
        try { ctx.span.end(); } catch { /* ignore */ }
        staleCronJobs.push(key);
        cleaned++;
      }
    }
    for (const key of staleCronJobs) {
      this.cronJobs.delete(key);
    }

    return cleaned;
  }

  clear(): void {
    this.gateway = null;
    this.sessions.clear();
    this.requests.clear();
    this.agentTurns.clear();
    this.cronJobs.clear();
    this.activeContexts.clear();
    this.subAgentLinks.clear();
    this.activeRequestKey.clear();
    this.activeTurnKey.clear();
    this.recentRequests.clear();
  }

  // ── Diagnostics ───────────────────────────────────────────────────

  get stats() {
    return {
      sessions: this.sessions.size,
      requests: this.requests.size,
      agentTurns: this.agentTurns.size,
      cronJobs: this.cronJobs.size,
      subAgentLinks: this.subAgentLinks.size,
    };
  }
}
