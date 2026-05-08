# Migration Guide: V2 to V3

This guide covers upgrading from the OpenClaw Observability Plugin V2 (0.1.x) to V3 (0.2.x).

## Minimum Requirements

- OpenClaw Gateway >= 2026.4.21 (for `before_model_resolve` and `before_prompt_build` hooks)
- OpenTelemetry SDK packages updated to v2.x

## Breaking Changes

### Hook Migration (ISI-730)

The legacy `before_agent_start` hook is no longer registered. V3 uses two new hooks:

| V2 Hook | V3 Replacement | Notes |
|---------|---------------|-------|
| `before_agent_start` | `before_model_resolve` + `before_prompt_build` | Agent turn span starts earlier (before model resolution) |

If you were relying on `before_agent_start` timing for custom integrations, update to listen for `before_model_resolve` instead.

### Span Naming Changes

| V2 Span Name | V3 Span Name | Reason |
|-------------|-------------|--------|
| `tool.{name}` | `execute_tool {name}` | GenAI semantic convention compliance |
| (none) | `chat {model}` | New model call span |
| (none) | `openclaw.session` | New session tracking span |
| (none) | `openclaw.dispatch.prepare` | New dispatch phase span |

### Attribute Key Additions

V3 emits both GenAI stable attributes (`gen_ai.*`) and legacy attributes (`openclaw.*`) for backward compatibility. New attributes:

**GenAI stable:**
- `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`
- `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`
- `gen_ai.request.stream`, `gen_ai.request.max_tokens`
- `gen_ai.provider.name`
- `gen_ai.tool.approval.requested`, `gen_ai.tool.approval.resolution`, `gen_ai.tool.approval.duration_ms`

**New openclaw attributes:**
- `openclaw.session.channel`, `openclaw.session.user_id`, `openclaw.session.duration_ms`
- `openclaw.dispatch.duration_ms`
- `openclaw.prompt.chars`, `openclaw.session.message_count`
- `openclaw.cron.*` (cron job monitoring)
- `openclaw.subagent.*` (sub-agent tracking)

## New Features

### Model Call Spans (ISI-926)

Each LLM call now gets a dedicated `chat {model}` CLIENT span with full GenAI semantic conventions:

```
openclaw.agent.turn
├── chat gpt-4o
│   gen_ai.request.model: "gpt-4o"
│   gen_ai.response.model: "gpt-4o-2024-08-06"
│   gen_ai.usage.input_tokens: 150
│   gen_ai.usage.output_tokens: 80
│   gen_ai.usage.cache_read.input_tokens: 100
```

### Tool Call Timing (ISI-927)

Tool spans now use `before_tool_call` / `after_tool_call` hooks for accurate timing instead of relying solely on `tool_result_persist`:

- Duration measured from before execution to after completion
- Tool approval workflow tracking (`gen_ai.tool.approval.*`)
- Backward compatible: `tool_result_persist` still creates spans when `before_tool_call` didn't fire

### Session Spans (ISI-928)

Long-lived session spans cover the entire conversation:

```
openclaw.session
│   gen_ai.conversation.id: "session-abc"
│   openclaw.session.duration_ms: 45000
│   openclaw.session.request_count: 5
│   openclaw.session.end_reason: "user_closed"
```

### Log Export Pipeline (ISI-930)

V3 adds OTLP log export via `log.record` diagnostic events:

- Severity mapping (trace → fatal)
- Trace context enrichment (trace_id, span_id from active spans)
- Configurable filtering (exclude levels, loggers, message patterns)
- Logger name, function, file, line attributes

Configuration:
```json
{
  "logs": true,
  "logConfig": {
    "excludeLevels": ["debug", "trace"],
    "excludeLoggers": ["noisy-module"]
  }
}
```

### Security Detection

V3 detects and records security events on spans:
- Prompt injection attempts
- Dangerous command execution
- Sensitive file access

## Dashboard Migration

### Dynatrace / Grafana

Update DQL/ PromQL queries to use new span names:

**V2:**
```sql
FROM spans WHERE span.name = "tool.Read"
```

**V3:**
```sql
FROM spans WHERE span.name = "execute_tool Read"
-- or use the stable attribute:
FROM spans WHERE span.attributes["gen_ai.operation.name"] = "execute_tool"
```

The legacy `openclaw.*` attributes are still emitted for backward compatibility during the transition.

## Configuration Changes

No breaking config changes. New options:

| Option | Default | Description |
|--------|---------|-------------|
| `logs` | `true` | Enable OTLP log export |
| `logConfig` | `{}` | Log pipeline filtering configuration |

## Upgrade Steps

1. Update OpenClaw Gateway to >= 2026.4.21
2. Update the plugin package to 0.2.x
3. Clear the jiti cache: `rm -rf /tmp/jiti`
4. Restart the gateway: `systemctl --user restart openclaw-gateway`
5. Verify new hooks are registered in logs (look for `model_call_started`, `before_tool_call`, `session_start`)
6. Update dashboards to use new span names and attributes

## Rollback

If issues arise, pin to the 0.1.x branch:

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "version": "0.1.x"
      }
    }
  }
}
```

The 0.1.x branch receives security and critical regression fixes through 2026-10-21.
