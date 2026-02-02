# 🔭 OpenClaw Observability Plugin

Full **OpenTelemetry** observability for [OpenClaw](https://github.com/openclaw/openclaw) AI agents — traces, metrics, and logs out of the box.

Captures LLM token usage, agent turns, tool executions, and session lifecycle as connected OpenTelemetry traces and metrics. Exports everything via **OTLP** to any OpenTelemetry-compatible backend: Dynatrace, Grafana, Datadog, Honeycomb, and more.

📖 **Full documentation:** [https://henrikrexed.github.io/openclaw-observability-plugin](https://henrikrexed.github.io/openclaw-observability-plugin)

---

## Architecture

```
┌──────────────────────────────┐
│     OpenClaw Gateway         │
│  ┌────────────────────────┐  │
│  │  OTel Observability    │  │
│  │  Plugin                │  │
│  │  ├─ Connected Traces   │──┼──► OTLP ──► OTel Collector ──► Dynatrace
│  │  │  (hooks-based)      │  │         │                    ├── Grafana
│  │  ├─ Custom Metrics     │  │         │                    ├── Datadog
│  │  └─ Logs               │  │         │                    └── any backend
│  └────────────────────────┘  │
└──────────────────────────────┘
```

## What You Get

### 🔍 Traces — Connected Distributed Traces

Every user message produces a full trace tree:

```
openclaw.request (root — full message lifecycle)
├── openclaw.agent.turn (LLM processing)
│   ├── gen_ai.usage.input_tokens: 4521
│   ├── gen_ai.usage.output_tokens: 892
│   ├── gen_ai.response.model: claude-opus-4-5
│   ├── tool.exec (156ms)
│   ├── tool.Read (12ms)
│   └── tool.web_fetch (1200ms)
└── openclaw.command.new (if session reset)
```

- **Agent turns** — model, token counts (input/output/cache), duration, success/error
- **Tool executions** — individual spans per tool call with result metadata
- **Session commands** — `/new`, `/reset`, `/stop` lifecycle events
- **Gateway lifecycle** — startup events
- **Parent-child relationships** — all spans connected under one trace per request

### 📊 Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `openclaw.llm.tokens.prompt` | Counter | Prompt/input tokens by model |
| `openclaw.llm.tokens.completion` | Counter | Completion/output tokens by model |
| `openclaw.llm.tokens.total` | Counter | Total tokens (prompt + completion + cache) |
| `openclaw.llm.requests` | Counter | LLM API request count |
| `openclaw.tool.calls` | Counter | Tool invocation count |
| `openclaw.tool.errors` | Counter | Tool error count |
| `openclaw.agent.turn_duration` | Histogram | Agent turn duration (ms) |
| `openclaw.messages.received` | Counter | Inbound messages by channel |
| `openclaw.session.resets` | Counter | Session reset count |

### 📋 Logs

Structured gateway logs forwarded via OTel Collector's filelog receiver.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
cd openclaw-observability-plugin
npm install

# 2. Add plugin path to OpenClaw config
# In ~/.openclaw/openclaw.json:
{
  "plugins": {
    "load": { "paths": ["/path/to/openclaw-observability-plugin"] },
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "protocol": "http",
          "serviceName": "openclaw-gateway",
          "traces": true,
          "metrics": true,
          "logs": true
        }
      }
    }
  }
}

# 3. Start an OTel Collector (optional — see docs for direct export)
export DYNATRACE_ENDPOINT=https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp
export DYNATRACE_API_TOKEN=<YOUR_ACCESS_TOKEN>
docker compose up -d

# 4. Restart gateway
openclaw gateway restart
```

See the [Getting Started guide](https://henrikrexed.github.io/openclaw-observability-plugin/getting-started/) for detailed instructions.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "protocol": "http",
          "serviceName": "openclaw-gateway",
          "traces": true,
          "metrics": true,
          "logs": true,
          "captureContent": false
        }
      }
    }
  }
}
```

See the full [Configuration Reference](https://henrikrexed.github.io/openclaw-observability-plugin/configuration/).

## Known Limitations

### No Per-LLM-Call Auto-Instrumentation

The plugin uses OpenClaw's **hook-based API** to produce spans, not SDK-level monkey-patching. This means:

- ✅ Token usage, model, duration per **agent turn** (aggregated across all LLM calls in a turn)
- ❌ No individual `anthropic.chat` spans per LLM API call
- ❌ No request/response content capture on LLM calls

**Why?** OpenClaw uses ESM modules internally. Standard OTel auto-instrumentation (via [import-in-the-middle](https://github.com/DataDog/import-in-the-middle)) breaks `@mariozechner/pi-ai`'s named exports, crash-looping the gateway. See [the full technical writeup](https://github.com/henrikrexed/openclaw-observability-plugin/blob/main/docs/limitations.md) for details.

A [feature request](https://github.com/openclaw/openclaw/issues) has been filed to add native LLM call events to the plugin API.

## Backends

| Backend | Setup Guide |
|---------|-------------|
| Dynatrace | [Dynatrace integration](https://henrikrexed.github.io/openclaw-observability-plugin/backends/dynatrace/) |
| OTel Collector | [Collector setup](https://henrikrexed.github.io/openclaw-observability-plugin/backends/otel-collector/) |
| Grafana / Tempo | [Grafana integration](https://henrikrexed.github.io/openclaw-observability-plugin/backends/grafana/) |
| Any OTLP backend | [Generic OTLP](https://henrikrexed.github.io/openclaw-observability-plugin/backends/generic-otlp/) |

## Development

```bash
# Type-check
npm run typecheck

# Clear jiti cache + restart for code changes
rm -rf /tmp/jiti && openclaw gateway restart
```

## License

Apache 2.0
