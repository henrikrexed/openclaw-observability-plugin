# 🔭 OpenClaw Observability Plugin

OpenTelemetry observability for [OpenClaw](https://github.com/openclaw/openclaw) — full traces, metrics, and logs for your AI agent.

Uses [OpenLLMetry](https://github.com/traceloop/openllmetry-js) to auto-instrument LLM calls (Anthropic, OpenAI) and exports everything via OTLP to any OpenTelemetry-compatible backend.

## Architecture

```
┌──────────────────────────┐
│   OpenClaw Gateway       │
│  ┌────────────────────┐  │
│  │  OTel Plugin        │  │
│  │  ├─ OpenLLMetry     │──┼──► OTLP ──► OTel Collector ──► Dynatrace
│  │  ├─ Custom Spans    │  │                              ├── Grafana
│  │  ├─ Metrics         │  │                              ├── Datadog
│  │  └─ Logs            │  │                              └── any backend
│  └────────────────────┘  │
└──────────────────────────┘
```

## What You Get

### Traces (via OpenLLMetry)
- **LLM API calls** — auto-instrumented Anthropic/OpenAI requests with:
  - Model name, token counts (prompt + completion)
  - Request/response latency
  - Error details
  - Optional: prompt/completion content capture
- **Tool executions** — spans for every agent tool call (exec, web_fetch, browser, etc.)
- **Session commands** — `/new`, `/reset`, `/stop` events
- **Gateway lifecycle** — startup events

### Metrics
| Metric | Type | Description |
|--------|------|-------------|
| `openclaw.llm.requests` | Counter | Total LLM API requests |
| `openclaw.llm.errors` | Counter | Total LLM API errors |
| `openclaw.llm.tokens.total` | Counter | Total tokens consumed |
| `openclaw.llm.tokens.prompt` | Counter | Prompt tokens |
| `openclaw.llm.tokens.completion` | Counter | Completion tokens |
| `openclaw.llm.duration` | Histogram | LLM request duration (ms) |
| `openclaw.tool.calls` | Counter | Tool invocations |
| `openclaw.tool.errors` | Counter | Tool errors |
| `openclaw.tool.duration` | Histogram | Tool execution duration (ms) |
| `openclaw.agent.turn_duration` | Histogram | Full agent turn duration (ms) |
| `openclaw.session.resets` | Counter | Session resets |
| `openclaw.sessions.active` | UpDownCounter | Active sessions |
| `openclaw.messages.received` | Counter | Inbound messages |
| `openclaw.messages.sent` | Counter | Outbound messages |

All metrics include relevant attributes (model, tool name, channel, etc.) for filtering/grouping.

## Quick Start

### 1. Deploy the OTel Collector

```bash
# Set your Dynatrace credentials
export DYNATRACE_ENDPOINT=https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp
export DYNATRACE_API_TOKEN=<YOUR_ACCESS_TOKEN>

# Start the collector
docker compose up -d
```

The collector listens on:
- `localhost:4317` — OTLP/gRPC
- `localhost:4318` — OTLP/HTTP

### 2. Install the Plugin

```bash
# From the plugin directory
cd openclaw-observability-plugin
npm install

# Install into OpenClaw
openclaw plugins install .
```

Or link for development:
```bash
openclaw plugins install -l .
```

### 3. Configure

Add to your OpenClaw config:

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

### 4. Restart Gateway

```bash
openclaw gateway restart
```

### 5. Verify

```bash
# Check plugin status
openclaw otel

# Should show:
# 🔭 OpenTelemetry Observability Plugin
# ────────────────────────────────────────
#   Endpoint:        http://localhost:4318
#   Protocol:        http
#   Service:         openclaw-gateway
#   Traces:          ✅
#   Metrics:         ✅
#   Initialized:     ✅
```

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | `http://localhost:4318` | OTLP endpoint URL |
| `protocol` | `"http"` \| `"grpc"` | `"http"` | OTLP export protocol |
| `serviceName` | string | `"openclaw-gateway"` | OTel service name |
| `headers` | object | `{}` | Custom OTLP headers (auth, etc.) |
| `traces` | boolean | `true` | Enable trace export |
| `metrics` | boolean | `true` | Enable metrics export |
| `logs` | boolean | `true` | Enable log export |
| `captureContent` | boolean | `false` | Record prompt/completion text in spans |
| `metricsIntervalMs` | number | `30000` | Metrics export interval (ms) |
| `resourceAttributes` | object | `{}` | Extra OTel resource attributes |

## Dynatrace Setup

### Direct (no collector)

Point the plugin directly at Dynatrace:

```json
{
  "config": {
    "endpoint": "https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp",
    "headers": {
      "Authorization": "Api-Token <YOUR_TOKEN>"
    }
  }
}
```

Required Dynatrace token scopes:
- `openTelemetryTrace.ingest`
- `metrics.ingest`
- `logs.ingest`

### Via OTel Collector (recommended)

Use the included `docker-compose.yaml` and `collector/otel-collector-config.yaml`. The collector gives you:
- Batching and retry
- Data processing/filtering
- Fan-out to multiple backends
- Decoupled auth (credentials stay on the collector, not in OpenClaw config)

## Development

```bash
# Clone
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
cd openclaw-observability-plugin

# Install deps
npm install

# Link to OpenClaw for dev
openclaw plugins install -l .

# Type-check
npm run typecheck
```

## How It Works

1. **Gateway startup** → Plugin registers as a background service
2. **Service start** → Initializes OpenLLMetry (monkey-patches Anthropic/OpenAI SDKs) and sets up OTel trace/metrics providers
3. **LLM calls** → OpenLLMetry auto-creates spans with GenAI semantic conventions
4. **Tool calls** → `tool_result_persist` hook creates spans + updates metrics
5. **Commands** → Command hooks track `/new`, `/reset` events
6. **Export** → BatchSpanProcessor + PeriodicExportingMetricReader send data via OTLP

## License

Apache 2.0
