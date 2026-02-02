# Metrics Reference

All metrics use the `openclaw.*` namespace and are exported via OTLP at the configured interval (default: 30 seconds).

## LLM Metrics

### `openclaw.llm.requests`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | requests |
| **Description** | Total number of LLM API requests made |

Tracks every call to Anthropic or OpenAI APIs. Use this to understand request volume over time.

---

### `openclaw.llm.errors`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | errors |
| **Description** | Total number of LLM API errors |

Counts failed LLM calls (rate limits, timeouts, invalid requests, etc.). A spike here usually means rate limiting or API issues.

---

### `openclaw.llm.tokens.total`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | tokens |
| **Description** | Total tokens consumed (prompt + completion) |

The primary cost metric. Combine with model information to estimate costs.

---

### `openclaw.llm.tokens.prompt`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | tokens |
| **Description** | Prompt tokens consumed |

Tracks input tokens. High prompt token counts may indicate large system prompts, long conversation histories, or excessive context injection.

---

### `openclaw.llm.tokens.completion`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | tokens |
| **Description** | Completion tokens consumed |

Tracks output tokens. Useful for understanding response verbosity.

---

### `openclaw.llm.duration`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | LLM request duration in milliseconds |

Latency distribution for LLM calls. Use percentiles (p50, p95, p99) to understand typical and worst-case latency.

## Tool Metrics

### `openclaw.tool.calls`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | calls |
| **Attributes** | `tool.name` |
| **Description** | Total tool invocations |

Broken down by tool name. Shows which tools are used most frequently.

**Example attribute values:** `exec`, `Read`, `Write`, `web_fetch`, `web_search`, `browser`, `memory_search`

---

### `openclaw.tool.errors`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | errors |
| **Attributes** | `tool.name` |
| **Description** | Total tool execution errors |

Broken down by tool name. High error rates on specific tools may indicate configuration issues or external service problems.

---

### `openclaw.tool.duration`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Attributes** | `tool.name` |
| **Description** | Tool execution duration in milliseconds |

How long each tool takes. Useful for identifying slow tools that bottleneck agent turns.

## Agent Metrics

### `openclaw.agent.turn_duration`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | ms |
| **Description** | Full agent turn duration (LLM + tools + processing) |

End-to-end time for a complete agent turn. This is the user-perceived latency.

## Session Metrics

### `openclaw.session.resets`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | resets |
| **Attributes** | `command.source` |
| **Description** | Total session resets |

How often sessions are reset via `/new` or `/reset`. Broken down by channel source.

---

### `openclaw.sessions.active`

| | |
|---|---|
| **Type** | UpDownCounter |
| **Unit** | sessions |
| **Description** | Currently active sessions |

A gauge-like metric showing the number of active sessions at any point in time.

## Message Metrics

### `openclaw.messages.received`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | messages |
| **Description** | Total inbound messages |

Counts messages received from users across all channels.

---

### `openclaw.messages.sent`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | messages |
| **Description** | Total outbound messages |

Counts messages sent by the agent across all channels.

## Dashboard Examples

### Token Usage Over Time

Track cost by monitoring `openclaw.llm.tokens.total` over time. In Dynatrace:

```
timeseries avg(openclaw.llm.tokens.total), by:{gen_ai.request.model}
```

### LLM Latency Percentiles

```
timeseries percentile(openclaw.llm.duration, 50, 95, 99)
```

### Tool Error Rate

```
timeseries sum(openclaw.tool.errors) / sum(openclaw.tool.calls) * 100, by:{tool.name}
```

### Most Used Tools

```
timeseries sum(openclaw.tool.calls), by:{tool.name}
```
