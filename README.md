# 🔭 OpenClaw Observability Plugin

Full **OpenTelemetry** observability for [OpenClaw](https://github.com/openclaw/openclaw) AI agents — traces, metrics, and logs out of the box.

Auto-instruments LLM calls (Anthropic, OpenAI) using [OpenLLMetry](https://github.com/traceloop/openllmetry-js) and exports everything via **OTLP** to any OpenTelemetry-compatible backend: Dynatrace, Grafana, Datadog, Honeycomb, and more.

📖 **Full documentation:** [https://henrikrexed.github.io/openclaw-observability-plugin](https://henrikrexed.github.io/openclaw-observability-plugin)

---

## Architecture

```
┌──────────────────────────────┐
│     OpenClaw Gateway         │
│  ┌────────────────────────┐  │
│  │  OTel Observability    │  │
│  │  Plugin                │  │
│  │  ├─ OpenLLMetry        │──┼──► OTLP ──► OTel Collector ──► Dynatrace
│  │  │  (auto-instrument)  │  │         │                    ├── Grafana
│  │  ├─ Custom Spans       │  │         │                    ├── Datadog
│  │  ├─ Metrics            │  │         │                    └── any backend
│  │  └─ Logs               │  │         │
│  └────────────────────────┘  │         └──► Direct OTLP ──► Dynatrace
└──────────────────────────────┘
```

## What You Get

### 🔍 Traces
- **LLM API calls** — auto-instrumented via OpenLLMetry with model name, token counts, latency, errors
- **Tool executions** — spans for every agent tool call (exec, web_fetch, browser, etc.)
- **Session commands** — `/new`, `/reset`, `/stop` lifecycle events
- **Gateway lifecycle** — startup and shutdown events
- **Optional content capture** — record actual prompts/completions (disabled by default for privacy)

### 📊 Metrics
- Token usage counters (prompt, completion, total)
- LLM request duration histograms
- Tool call frequency and error rates
- Agent turn duration
- Active session gauge
- Message counters (inbound/outbound)

### 📋 Logs
- Structured gateway logs forwarded as OTel log records

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
cd openclaw-observability-plugin
npm install

# 2. Install into OpenClaw
openclaw plugins install .

# 3. Start an OTel Collector (optional — see docs for direct export)
export DYNATRACE_ENDPOINT=https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp
export DYNATRACE_API_TOKEN=<YOUR_ACCESS_TOKEN>
docker compose up -d

# 4. Configure the plugin in your OpenClaw config
# See docs/getting-started.md for full config

# 5. Restart gateway
openclaw gateway restart

# 6. Verify
openclaw otel
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

## Backends

| Backend | Setup Guide |
|---------|-------------|
| Dynatrace | [Dynatrace integration](https://henrikrexed.github.io/openclaw-observability-plugin/backends/dynatrace/) |
| OTel Collector | [Collector setup](https://henrikrexed.github.io/openclaw-observability-plugin/backends/otel-collector/) |
| Grafana / Tempo | [Grafana integration](https://henrikrexed.github.io/openclaw-observability-plugin/backends/grafana/) |
| Any OTLP backend | [Generic OTLP](https://henrikrexed.github.io/openclaw-observability-plugin/backends/generic-otlp/) |

## Development

```bash
# Link for development (live reload on gateway restart)
openclaw plugins install -l .

# Type-check
npm run typecheck
```

## License

Apache 2.0
