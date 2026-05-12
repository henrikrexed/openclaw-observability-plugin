# Implementation Plan: ISI-1017 through ISI-1020
## Combined PR for Plugin Gap Closure

### P2 — Queue & Session State Metrics (ISI-1017)
**Files to modify:**
- `src/diagnostics.ts`: Add queue and session event handlers
- `src/telemetry.ts`: Add new histograms/counters
- `src/semconv.ts`: Add new metric attribute keys

**Events to handle:**
- `queue.lane.enqueue` → counter `openclaw.queue.lane.enqueue`
- `queue.lane.dequeue` → counter `openclaw.queue.lane.dequeue`
- `queue.depth` → histogram `openclaw.queue.depth`
- `queue.wait_ms` → histogram `openclaw.queue.wait_ms`
- `session.stuck` → span + counter
- `session.long_running` → span + counter
- `session.stalled` → span + counter

### P3 — Context Layer & Skill Usage (ISI-1018)
**Files to modify:**
- `src/hooks.ts`: Add `before_prompt_build` enrichment
- `src/semconv.ts`: Add skill/context attribute keys

**Features:**
- `openclaw.context.build` span
- Skill loading tracking
- Token breakdown: system/user/tool_result/skill

### P4 — Subagent Deep Tracing (ISI-1019)
**Files to modify:**
- `src/hooks.ts`: Enhance subagent spans (already has W3C fix)

**Features:**
- Child run traces with delivery details
- Subagent model usage aggregation
- Context fork detection

### P5 — Webhook Observability (ISI-1020)
**Files to modify:**
- `src/diagnostics.ts`: Add webhook event handlers
- `src/telemetry.ts`: Add webhook metrics

**Events to handle:**
- `webhook.received` → span + counter
- `webhook.processed` → span
- `webhook.error` → span + counter
- `webhook.duration_ms` → histogram

## Metrics to Add

```typescript
// Queue metrics
openclaw.queue.lane.enqueue: Counter
openclaw.queue.lane.dequeue: Counter
openclaw.queue.depth: Histogram
openclaw.queue.wait_ms: Histogram

// Session metrics
openclaw.session.stuck: Counter
openclaw.session.long_running: Counter
openclaw.session.stalled: Counter
openclaw.session.stuck_age_ms: Histogram

// Webhook metrics
openclaw.webhook.received: Counter
openclaw.webhook.processed: Counter
openclaw.webhook.error: Counter
openclaw.webhook.duration_ms: Histogram
openclaw.webhook.payload_size_bytes: Histogram
```

## Spans to Add

```
openclaw.queue.lane.enqueue
openclaw.queue.lane.dequeue
openclaw.session.stuck
openclaw.session.long_running
openclaw.session.stalled
openclaw.context.build
openclaw.webhook.received
openclaw.webhook.processed
openclaw.webhook.error
```
