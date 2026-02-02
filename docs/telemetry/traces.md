# Traces Reference

The plugin generates two categories of traces: **auto-instrumented** (via OpenLLMetry) and **custom** (via plugin hooks).

## Auto-Instrumented Spans (OpenLLMetry)

These spans are created automatically by OpenLLMetry when LLM SDK methods are called. No configuration beyond enabling traces is needed.

### Anthropic Spans

| Span Name | Kind | Description |
|-----------|------|-------------|
| `anthropic.messages.create` | Client | Claude messages API call |
| `anthropic.completions.create` | Client | Legacy completions API call |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.system` | string | `"anthropic"` |
| `gen_ai.request.model` | string | Model name (e.g., `"claude-sonnet-4-20250514"`) |
| `gen_ai.request.max_tokens` | int | Max tokens requested |
| `gen_ai.request.temperature` | float | Temperature setting |
| `gen_ai.request.top_p` | float | Top-p setting |
| `gen_ai.response.model` | string | Actual model used |
| `gen_ai.usage.prompt_tokens` | int | Prompt token count |
| `gen_ai.usage.completion_tokens` | int | Completion token count |
| `gen_ai.response.finish_reasons` | string[] | Stop reasons |

When `captureContent: true`:

| Attribute | Type | Description |
|-----------|------|-------------|
| `gen_ai.prompt` | string | Full prompt text |
| `gen_ai.completion` | string | Full completion text |

### OpenAI Spans

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openai.chat.completions.create` | Client | Chat completions API call |
| `openai.embeddings.create` | Client | Embeddings API call |

**Attributes:** Same as Anthropic spans, with `gen_ai.system = "openai"`.

## Custom Spans (Plugin Hooks)

These spans are created by the plugin's hook system.

### Tool Execution Spans

Created by the `tool_result_persist` hook for every agent tool call.

| Span Name | Kind | Description |
|-----------|------|-------------|
| `tool.<tool_name>` | Internal | Individual tool execution |

**Examples:** `tool.exec`, `tool.web_fetch`, `tool.browser`, `tool.Read`, `tool.Write`, `tool.memory_search`

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.tool.name` | string | Tool name |
| `openclaw.tool.is_error` | boolean | Whether the tool errored |
| `openclaw.tool.duration_ms` | float | Execution duration (when available) |
| `openclaw.tool.result_chars` | int | Total characters in result |
| `openclaw.tool.result_parts` | int | Number of content parts |

### Command Spans

Created when session commands are issued.

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.command.new` | Internal | `/new` command |
| `openclaw.command.reset` | Internal | `/reset` command |
| `openclaw.command.stop` | Internal | `/stop` command |

**Attributes:**

| Attribute | Type | Description |
|-----------|------|-------------|
| `openclaw.command.action` | string | Command name |
| `openclaw.command.session_key` | string | Session identifier |
| `openclaw.command.source` | string | Channel source (e.g., `"whatsapp"`, `"telegram"`) |

### Gateway Spans

| Span Name | Kind | Description |
|-----------|------|-------------|
| `openclaw.gateway.startup` | Internal | Gateway startup event |

## Trace Context

All spans share the same OpenTelemetry resource:

| Resource Attribute | Value |
|-------------------|-------|
| `service.name` | Configured `serviceName` |
| `service.version` | Plugin version |
| `openclaw.plugin` | `"otel-observability"` |
| *(custom)* | Any `resourceAttributes` from config |

## Example Trace

A typical agent turn produces a trace like:

```
[agent turn]
├── anthropic.messages.create (2340ms)
│   ├── gen_ai.request.model: claude-sonnet-4-20250514
│   ├── gen_ai.usage.prompt_tokens: 1523
│   └── gen_ai.usage.completion_tokens: 342
├── tool.exec (156ms)
│   ├── openclaw.tool.name: exec
│   └── openclaw.tool.is_error: false
├── tool.Read (12ms)
│   ├── openclaw.tool.name: Read
│   └── openclaw.tool.result_chars: 4521
└── anthropic.messages.create (1890ms)
    ├── gen_ai.request.model: claude-sonnet-4-20250514
    ├── gen_ai.usage.prompt_tokens: 2891
    └── gen_ai.usage.completion_tokens: 189
```

## Semantic Conventions

OpenLLMetry follows the [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), which are now an official part of the OpenTelemetry specification. This means your traces are compatible with any tool that understands these conventions.
