# Traces Reference

The plugin generates connected distributed traces using OpenClaw's hook-based plugin API.

## Trace Structure

Every user message produces a trace tree:

```
openclaw.request (SERVER span — full message lifecycle)
├── openclaw.agent.turn (INTERNAL — LLM processing)
│   ├── gen_ai.usage.input_tokens: 4521
│   ├── gen_ai.usage.output_tokens: 892
│   ├── gen_ai.response.model: claude-opus-4-5
│   ├── tool.exec (INTERNAL — 156ms)
│   ├── tool.Read (INTERNAL — 12ms)
│   └── tool.web_fetch (INTERNAL — 1200ms)
├── openclaw.compaction (INTERNAL — if context is compacted)
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

Created by the `before_model_resolve` hook at the earliest point in the agent
run, enriched by `before_prompt_build` once session history is loaded, and
ended by `agent_end`. Child of the request span.

Prior to v0.2.0 this span was created in the legacy `before_agent_start` hook.
See [CHANGELOG](../../CHANGELOG.md) and ISI-730 for the migration details.

| Field | Value |
|-------|-------|
| **Span Name** | `openclaw.agent.turn` |
| **Kind** | `INTERNAL` |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.agent.id` | string | Agent identifier |
| `openclaw.session.key` | string | Session identifier |
| `openclaw.prompt.chars` | int | Length of the user prompt (set by `before_prompt_build`) |
| `openclaw.session.message_count` | int | Session history size fed to the LLM (set by `before_prompt_build`) |
| `openclaw.agent.duration_ms` | int | Turn duration in milliseconds |
| `openclaw.agent.success` | boolean | Whether the turn completed successfully |
| `openclaw.agent.error` | string | Error message (if failed) |
| `gen_ai.usage.input_tokens` | int | Total input tokens (including cache read/write) |
| `gen_ai.usage.output_tokens` | int | Total output tokens |
| `gen_ai.response.model` | string | Actual model used (from last assistant message) |
| `traceloop.span.kind` | string | `task` — Traceloop/OpenLLMetry marker read by Dynatrace AI Observability |
| `gen_ai.input.messages` | string | **Opt-in.** Input messages (JSON array, or flat prompt when no array). Gated by `captureContent.inputMessages`; redacted before truncation |
| `gen_ai.system_instructions` | string | **Opt-in.** System-prompt text. Gated by `captureContent.systemPrompt`; redacted before truncation. Distinct from `gen_ai.provider.name` |

> Schema `1.4.0` (ISI-1605) added the opt-in GenAI content keys
> (`gen_ai.input.messages`, `gen_ai.system_instructions`, and on other
> spans `gen_ai.output.messages`, `gen_ai.prompt.prompt_filter_results`,
> `gen_ai.completion.content_filter_results`) plus the `traceloop.span.kind`
> marker. Content keys emit only when the matching `captureContent` flag is
> on (default off) and always pass through the redact-before-truncate funnel.

> Schema `1.3.0` (ISI-1004) removed `gen_ai.usage.total_tokens` — compute
> it as `gen_ai.usage.input_tokens + gen_ai.usage.output_tokens`.

!!! note "`gen_ai.request.model` on the turn span"
    The agent turn span no longer carries `gen_ai.request.model` — in
    OpenClaw 2026.2+ the model has not been resolved when the span is
    created (`before_model_resolve` fires pre-resolution). The resolved
    model is recorded as `gen_ai.response.model` at `agent_end` and is
    also available on `openclaw.llm.call` spans from the `llm_input` hook.

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
| `openclaw.tool.error_preview` | string | **Failure paths only.** Bounded, redacted preview of the tool error text. Gated by `captureContent.toolErrorMessages`; redacted before truncation (1024 chars) |
| `openclaw.tool.kind` | string | Tool provider classification (e.g. `builtin` vs `mcp`), from `before_tool_call`. *Unreleased — see note below.* |
| `openclaw.tool.input_kind` | string | Shape of the tool input (e.g. `command`, `file`, `query`), from `before_tool_call`. *Unreleased.* |
| `openclaw.tool.derived_paths` | string[] | Filesystem paths the call will touch (file blast-radius). Capped at 50 entries / 512 chars each; each entry redacted before truncation. *Unreleased.* |
| `openclaw.session.key` | string | Session identifier |
| `openclaw.agent.id` | string | Agent identifier |
| `gen_ai.tool.name` | string | Tool name (GenAI semconv) |
| `gen_ai.operation.name` | string | `execute_tool` |
| `traceloop.span.kind` | string | `tool` — Traceloop/OpenLLMetry marker read by Dynatrace AI Observability |

> `openclaw.tool.error_preview` (ISI-1318) shipped in **0.7.0**. It is written
> only when a tool call fails. Its `captureContent.toolErrorMessages` gate is
> the one content flag that defaults **on** when `captureContent` is supplied
> as an object — error text is operational data, a different privacy class
> from prompt/response bodies. See
> [Configuration → `captureContent`](../configuration.md#capturecontent-gateway-launch-setting).

> **Unreleased (ISI-1629):** the tool-span enrichment keys
> `openclaw.tool.kind`, `openclaw.tool.input_kind`, and
> `openclaw.tool.derived_paths` are on a feature branch, **not yet merged to
> `main`** or in a tagged release. They are read from the already-subscribed
> `before_tool_call` hook — additive only, no `minOpenClawVersion` bump. This
> reference will move them into the released set once the change lands.

**Status:** `OK` on success, `ERROR` if the tool returned an error.

### Outbound message span (`openclaw.message.sent`)

When `captureContent.outputMessages` is enabled the outbound reply is also
emitted as `gen_ai.output.messages` (alongside the legacy
`openclaw.content.output_message`), redacted before truncation.

### Content-filter results (`openclaw.llm.call` / `chat <model>`)

Azure/OpenAI content-filter payloads returned on the model response are
emitted — when gated on — as `gen_ai.prompt.prompt_filter_results` (behind
`captureContent.inputMessages`) and `gen_ai.completion.content_filter_results`
(behind `captureContent.outputMessages`), JSON-encoded and redacted.

## Compaction Span

Created when the runtime compacts session context (a major context/token
event). The span is opened by `before_compaction` and closed by
`after_compaction`, and is **nested under the active session/agent context**
so it appears inside the end-to-end trace rather than as a separate root.

| | |
|---|---|
| **Span Name** | `openclaw.compaction` |
| **Kind** | INTERNAL |

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.compaction.reason` | string | Why compaction ran (auto-compaction reports `"auto"`) |
| `openclaw.compaction.messages_before` | int | Session message count before compaction |
| `openclaw.compaction.messages_after` | int | Session message count after compaction |
| `openclaw.compaction.tokens_before` | int | Token count before compaction (when reported) |
| `openclaw.compaction.tokens_after` | int | Token count after compaction (when reported) |
| `openclaw.compaction.tokens_reclaimed` | int | `tokens_before − tokens_after`, clamped at 0 (when both known) |
| `openclaw.compaction.duration_ms` | int | Compaction duration in milliseconds |
| `openclaw.session.key` | string | Session identifier |
| `openclaw.agent.id` | string | Agent identifier |

Emits the `openclaw.compaction.count` counter and
`openclaw.compaction.tokens_reclaimed` histogram (see the Metrics Reference).

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
2. `before_model_resolve` creates an agent turn span as a child of the root
3. `before_prompt_build` enriches the agent turn span with prompt/history attrs
4. `tool_result_persist` creates tool spans as children of the agent turn
5. `agent_end` ends the agent turn and root spans, cleans up the context

Stale contexts (no `agent_end` within 5 minutes) are automatically cleaned up.

## Example DQL Queries (Dynatrace)

**Token usage per agent turn:**

```sql
fetch spans, samplingRatio:1
| filter contains(endpoint.name, "openclaw.agent.turn")
| fields start_time, duration, gen_ai.usage.input_tokens,
         gen_ai.usage.output_tokens,
         total_tokens = toLong(gen_ai.usage.input_tokens) + toLong(gen_ai.usage.output_tokens),
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
