# V3 Major Rewrite — BMAD Brainstorming Kickoff

## Summary

The official `@openclaw/diagnostics-otel` plugin (v2026.5.6) has grown significantly and now covers ~35 diagnostic event types with GenAI semantic conventions, content capture, and full signal export. Our `@openclaw/otel-observability` plugin (v0.2.0) currently uses only 9 of the 35 available typed hooks and relies on a manual `sessionContextMap` for trace context propagation.

This issue requests a **BMAD Method** engagement starting with the **brainstorming phase** to plan a V3 that is significantly more capable than the official diagnostics-otel plugin — not just matching it, but exceeding it by leveraging the full plugin SDK hook surface that diagnostic events cannot access.

---

## Why V3? Why Now?

1. **Hook surface gap:** The plugin SDK now exposes **35 typed hooks** (`PluginHookName`). We use 9. The official plugin accesses similar data through diagnostic events, but hooks provide richer context (params, results, error details, approval flows) that events don't carry.
2. **End-to-end trace scope:** Our traces currently cover `message_received → agent turn → tool execution → agent_end`. We miss: session lifecycle, sub-agent orchestration, compaction impact, cron job execution, message delivery pipeline, gateway lifecycle.
3. **Log depth:** We currently export no logs. OpenClaw emits structured `log.record` diagnostic events with level, logger name, function/line, and arbitrary attributes. V3 should capture and export these as OTLP logs.
4. **Competitive differentiation:** The official plugin is event-driven (reactive). Our plugin is hook-driven (proactive — can intercept, modify, and enrich in real-time). V3 should leverage this architectural advantage.

---

## BMAD Scope

### Phase 1: Brainstorming (This Issue)

Explore improvements across all three OTel signals:

#### 🔥 Traces — Full End-to-End Coverage

**Current trace (V2):**
```
openclaw.request (root)
└── openclaw.agent.turn
    ├── openclaw.llm.call
    ├── tool.exec (via tool_result_persist — AFTER execution)
    └── (missing: most lifecycle events)
```

**Proposed V3 trace:**
```
openclaw.gateway.lifecycle (gateway_start → gateway_stop)
openclaw.session (session_start → session_end, with reason, messageCount, duration)
openclaw.request (root — per inbound message)
├── inbound_claim (message claim/routing decision)
├── before_dispatch (pre-processing)
├── openclaw.agent.turn
│   ├── agent_turn_prepare (earliest hook)
│   ├── before_model_resolve (model selection)
│   ├── model.call (per API call — model_call_started → model_call_ended)
│   │   ├── gen_ai.client.* semconv (tokens, TTFB, payload bytes)
│   │   └── openllmetry HTTP span (if preload active)
│   ├── before_tool_call → after_tool_call (accurate timing + params + result)
│   ├── before_agent_finalize (revision/retry visibility)
│   └── before/after_compaction (context window pressure)
├── reply_dispatch (delivery pipeline)
├── message_sending (outbound intercept)
└── message_sent (delivery confirmation)
openclaw.cron.job (cron_changed: started → finished, with model, duration, summary)
openclaw.subagent (subagent_spawning → subagent_ended, parent-child trace links)
```

**New hooks to instrument (currently unused):**

| Hook | Trace Value |
|------|------------|
| `model_call_started` / `model_call_ended` | Per-API-call spans with `callId`, `requestPayloadBytes`, `responseStreamBytes`, `timeToFirstByteMs`, `upstreamRequestIdHash`, `failureKind` |
| `before_tool_call` / `after_tool_call` | Proper start→end tool spans with full params, result, error, `durationMs` |
| `session_start` / `session_end` | Session lifecycle spans with `resumedFrom`, `messageCount`, `durationMs`, `reason` (new/reset/idle/daily/compaction/deleted) |
| `subagent_spawning` / `subagent_spawned` / `subagent_ended` | Parent→child trace links, spawn mode, outcome (ok/error/timeout/killed) |
| `gateway_start` / `gateway_stop` | Gateway uptime span |
| `before_compaction` / `after_compaction` | Context pressure spans: `messageCount`, `tokenCount`, `compactingCount` |
| `cron_changed` | Cron execution spans: action, model, provider, duration, summary |
| `inbound_claim` | Message routing span |
| `message_sending` / `message_sent` | Outbound delivery spans |
| `before_dispatch` / `reply_dispatch` | Full dispatch pipeline |
| `before_agent_finalize` | Revision/retry visibility |
| `before_reset` | Session reset tracking |

#### 📊 Metrics — Beyond What diagnostics-otel Offers

The official plugin has good metrics from diagnostic events. V3 should add **hook-derived metrics** that events don't provide:

- **Tool params size** histogram (from `before_tool_call.params`)
- **Tool result size** histogram (from `after_tool_call.result`)
- **Session lifespan** histogram (from `session_end.durationMs`, `session_end.reason`)
- **Compaction rate** counter + tokens lost gauge (from `before/after_compaction`)
- **Sub-agent spawn latency** (from `subagent_spawning` → `subagent_spawned`)
- **Sub-agent outcome** counter by reason (ok/error/timeout/killed)
- **Cron job execution** histogram by model/provider, success rate
- **Message delivery latency** (from `message_sending` → `message_sent`)
- **Inbound claim routing** counter by channel/isGroup/wasMentioned
- **Context window pressure** gauge (from `before_compaction.tokenCount`)
- **Approval resolution** counter (from `before_tool_call` approval flows: allow-once/allow-always/deny/timeout)

#### 📝 Logs — Rich Structured Log Export

OpenClaw emits `log.record` diagnostic events with:
- `level`, `message`, `loggerName`, `loggerParents[]`
- `attributes: Record<string, string | number | boolean>`
- `code: { line?, functionName? }`

The official plugin exports these as OTLP logs. V3 should do the same AND enrich them with:
- Session key correlation (from active trace context)
- Agent ID association
- Model/provider context from current run
- Hook context (which hook was active when the log fired)

Additionally, explore whether plugin hooks can capture **more log detail** than what `log.record` events expose — e.g., tool execution stderr/stdout from `after_tool_call`, model response fragments from `llm_output`, etc.

---

### Phase 2: PRD (After Brainstorming)

Produce a detailed Product Requirements Document covering:
- All three signals (traces, metrics, logs)
- Configuration schema (signal toggles, content capture policy, sampling)
- Backward compatibility with V2 dashboards
- Performance requirements (no measurable latency impact on agent turns)
- Migration guide from V2

### Phase 3: Architecture (After PRD)

Technical design covering:
- Hook registration strategy (priority ordering, error isolation)
- Trace context propagation (replace manual `sessionContextMap` with proper OTel context propagation)
- GenAI semantic convention alignment (stable + experimental opt-in)
- OpenLLMetry integration (HTTP-level instrumentation)
- Memory management (span cleanup, stale context eviction)
- Plugin SDK version compatibility matrix

### Phase 4: Implementation (After Architecture)

Execute the plan with proper testing, documentation, and dashboard updates.

---

## Success Criteria

1. **V3 uses all 35 typed hooks** (or has a documented reason for excluding specific ones)
2. **End-to-end traces** cover the full lifecycle: gateway → session → message → agent → tools → delivery → session end
3. **Cron jobs are fully traced** with model, duration, outcome, and summary
4. **Compaction visibility** shows context pressure, tokens lost, and correlation with response quality
5. **Sub-agent traces** link parent and child sessions with outcome tracking
6. **Log export** captures structured OpenClaw logs as OTLP log records with trace correlation
7. **Metrics** exceed what diagnostics-otel provides with hook-derived data
8. **GenAI semantic conventions** are fully aligned with OTel GenAI spec
9. **Dashboards** are updated to leverage the new data

## References

- Current plugin: `openclaw-observability-plugin` v0.2.0
- Official plugin: `@openclaw/diagnostics-otel` v2026.5.6
- Plugin SDK hooks: `PluginHookName` (35 hooks in OpenClaw 2026.5.x)
- GenAI SemConv: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- BMAD Method: brainstorming → PRD → architecture → implementation
