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

## Compaction Metrics

### `openclaw.compaction.count`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Attributes** | `openclaw.compaction.reason` |
| **Description** | Total context-compaction events |

How often the runtime compacts session context. Auto-compaction reports
`reason="auto"`. Pairs with the `openclaw.compaction` span for per-event detail.

---

### `openclaw.compaction.tokens_reclaimed`

| | |
|---|---|
| **Type** | Histogram |
| **Unit** | `{token}` |
| **Attributes** | `openclaw.compaction.reason` |
| **Description** | Tokens reclaimed by a context-compaction event (`tokens_before − tokens_after`, clamped at 0) |

Quantifies how much context each compaction frees. Recorded only when the
runtime reports both pre- and post-compaction token counts.

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

## Security Metrics

### `openclaw.security.events`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Attributes** | `detection`, `severity` |
| **Description** | Total security events detected across all detection types |

The umbrella counter for all security detections. Use `detection` to filter by type (`sensitive_file_access`, `prompt_injection`, `dangerous_command`) and `severity` to filter by level (`critical`, `high`, `warning`).

---

### `openclaw.security.sensitive_file_access`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Attributes** | `file_pattern` |
| **Description** | Attempts to access sensitive files (credentials, SSH keys, .env, etc.) |

Triggers when the agent reads, writes, or edits files matching sensitive patterns (`.env`, `.ssh/`, `credentials`, `api_key`, etc.). The `file_pattern` attribute contains the regex source that matched.

---

### `openclaw.security.prompt_injection`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Attributes** | `pattern_count` |
| **Description** | Prompt injection attempts detected in inbound messages |

Detects social engineering patterns like "ignore previous instructions", fake `[SYSTEM]` tags, role manipulation ("pretend you are"), and jailbreak attempts. The `pattern_count` attribute shows how many patterns matched (more = higher confidence).

---

### `openclaw.security.dangerous_command`

| | |
|---|---|
| **Type** | Counter |
| **Unit** | events |
| **Attributes** | `command_type` |
| **Description** | Dangerous shell command executions detected |

Catches data exfiltration (`curl -d`, `nc -e`), destructive commands (`rm -rf /`, `mkfs`), privilege escalation (`chmod +s`), crypto mining (`xmrig`), and persistence mechanisms (`crontab`, `.bashrc` modification). The `command_type` attribute describes the matched threat.

---

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

### Security Events Over Time

```
timeseries sum(openclaw.security.events), by:{detection, severity}
```

### Sensitive File Access by Pattern

```
timeseries sum(openclaw.security.sensitive_file_access), by:{file_pattern}
```

### Dangerous Commands by Type

```
timeseries sum(openclaw.security.dangerous_command), by:{command_type}
```

### Prompt Injection Attempts

```
timeseries sum(openclaw.security.prompt_injection), by:{pattern_count}
```
