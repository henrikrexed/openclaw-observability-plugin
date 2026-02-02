# Traces Reference

The plugin generates connected distributed traces using OpenClaw's hook-based plugin API.

## Trace Structure

Every user message produces a trace tree:

```
openclaw.request (SERVER span — full message lifecycle)
├── openclaw.agent.turn (INTERNAL — LLM processing)
│   ├── gen_ai.usage.input_tokens: 4521
│   ├── gen_ai.usage.output_tokens: 892
│   ├── gen_ai.usage.total_tokens: 5413
│   ├── gen_ai.response.model: claude-opus-4-5
│   ├── tool.exec (INTERNAL — 156ms)
│   ├── tool.Read (INTERNAL — 12ms)
│   └── tool.web_fetch (INTERNAL — 1200ms)
└── openclaw.command.new (INTERNAL — if session reset)
```

All spans within a request share the same `traceId` and are linked via parent-child relationships.

## Request Span

Created by the `message_received` hook. This is the root span for the entire request lifecycle.

| Field | Value |
|-------|-------|
| **Span Name** | `openclaw.request` |
| **Kind** | `SERVER` |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.message.channel` | string | Source channel (`whatsapp`, `telegram`, `discord`, etc.) |
| `openclaw.session.key` | string | Session identifier |
| `openclaw.message.direction` | string | Always `"inbound"` |
| `openclaw.message.from` | string | Sender identifier |
| `openclaw.request.duration_ms` | int | Total request duration |

## Agent Turn Span

Created by `before_agent_start`, ended by `agent_end`. Child of the request span.

| Field | Value |
|-------|-------|
| **Span Name** | `openclaw.agent.turn` |
| **Kind** | `INTERNAL` |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.agent.id` | string | Agent identifier |
| `openclaw.session.key` | string | Session identifier |
| `openclaw.agent.model` | string | Model requested |
| `openclaw.agent.duration_ms` | int | Turn duration in milliseconds |
| `openclaw.agent.success` | boolean | Whether the turn completed successfully |
| `openclaw.agent.error` | string | Error message (if failed) |
| `gen_ai.usage.input_tokens` | int | Total input tokens (including cache read/write) |
| `gen_ai.usage.output_tokens` | int | Total output tokens |
| `gen_ai.usage.total_tokens` | int | Sum of input + output tokens |
| `gen_ai.response.model` | string | Actual model used (from last assistant message) |

!!! note "Token Counts"
    Token counts are **summed across all assistant messages** in the turn. If the agent makes multiple LLM calls (e.g., tool use loop), the totals reflect all calls combined. Cache tokens (`cacheRead`, `cacheWrite`) are included in the input token count.

## Tool Execution Spans

Created by the `tool_result_persist` hook. Child of the agent turn span.

| Field | Value |
|-------|-------|
| **Span Name** | `tool.<tool_name>` |
| **Kind** | `INTERNAL` |

**Examples:** `tool.exec`, `tool.web_fetch`, `tool.browser`, `tool.Read`, `tool.Write`, `tool.memory_search`, `tool.Edit`

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.tool.name` | string | Tool name |
| `openclaw.tool.call_id` | string | Unique tool call identifier |
| `openclaw.tool.is_synthetic` | boolean | Whether the tool call is synthetic |
| `openclaw.tool.result_chars` | int | Total characters in result |
| `openclaw.tool.result_parts` | int | Number of content parts in result |
| `openclaw.session.key` | string | Session identifier |
| `openclaw.agent.id` | string | Agent identifier |

**Status:** `OK` on success, `ERROR` if the tool returned an error.

## Command Spans

Created when session commands are issued.

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.command.new` | INTERNAL | `/new` command |
| `openclaw.command.reset` | INTERNAL | `/reset` command |
| `openclaw.command.stop` | INTERNAL | `/stop` command |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.command.action` | string | Command name |
| `openclaw.command.session_key` | string | Session identifier |
| `openclaw.command.source` | string | Command source |

## Gateway Spans

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.gateway.startup` | INTERNAL | Gateway startup event |

## Trace Context Propagation

The plugin maintains a `sessionContextMap` keyed by `sessionKey`:

1. `message_received` creates a root span and stores its context
2. `before_agent_start` creates an agent turn span as a child of the root
3. `tool_result_persist` creates tool spans as children of the agent turn
4. `agent_end` ends the agent turn and root spans, cleans up the context

Stale contexts (no `agent_end` within 5 minutes) are automatically cleaned up.

## Example DQL Queries (Dynatrace)

**Token usage per agent turn:**

```sql
fetch spans, samplingRatio:1
| filter contains(endpoint.name, "openclaw.agent.turn")
| fields start_time, duration, gen_ai.usage.input_tokens,
         gen_ai.usage.output_tokens, gen_ai.usage.total_tokens,
         gen_ai.response.model
| sort start_time desc
| limit 20
```

**Tool execution breakdown:**

```sql
fetch spans, samplingRatio:1
| filter startsWith(span.name, "tool.")
| fields start_time, span.name, duration, openclaw.tool.result_chars
| sort start_time desc
| limit 50
```

**Full trace for a session:**

```sql
fetch spans, samplingRatio:1
| filter openclaw.session.key == "agent:main:main"
| fields start_time, span.name, duration, span.kind, trace.id
| sort start_time desc
```

## Semantic Conventions

The plugin follows [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for token-related attributes (`gen_ai.usage.*`, `gen_ai.response.model`). Custom OpenClaw attributes use the `openclaw.*` namespace.
