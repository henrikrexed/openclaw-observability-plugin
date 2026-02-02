# Getting Started

Get OpenTelemetry observability for your OpenClaw agent in 5 minutes.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- Node.js 18+ (comes with OpenClaw)
- An OpenTelemetry-compatible backend (Dynatrace, Grafana, etc.) — or use the included OTel Collector

## Step 1: Clone and Install

```bash
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
cd openclaw-observability-plugin
npm install
```

## Step 2: Install into OpenClaw

=== "Production install"

    ```bash
    openclaw plugins install .
    ```

    This copies the plugin into `~/.openclaw/extensions/otel-observability/`.

=== "Development (linked)"

    ```bash
    openclaw plugins install -l .
    ```

    This symlinks the plugin — changes you make are reflected on gateway restart.

## Step 3: Set Up the OTel Collector

You have two options: use an OTel Collector (recommended) or export directly to your backend.

=== "OTel Collector (recommended)"

    The repo includes a Docker Compose setup with a pre-configured collector.

    ```bash
    # Set your backend credentials (example: Dynatrace)
    export DYNATRACE_ENDPOINT=https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp
    export DYNATRACE_API_TOKEN=<YOUR_ACCESS_TOKEN>

    # Start the collector
    docker compose up -d
    ```

    The collector listens on:

    - `localhost:4317` — OTLP/gRPC
    - `localhost:4318` — OTLP/HTTP

    !!! tip "Why use a collector?"
        The OTel Collector gives you batching, retry, filtering, and fan-out to multiple backends. It also keeps your backend credentials off the OpenClaw machine.

=== "Direct export"

    Skip the collector and point the plugin directly at your backend. See [Backends](backends/index.md) for backend-specific URLs and auth.

## Step 4: Configure the Plugin

Add the plugin config to your OpenClaw configuration:

```bash
# Open your config
openclaw configure
```

Add the following under `plugins`:

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

!!! warning "Privacy: captureContent"
    When `captureContent` is `false` (default), the plugin does **not** record prompt or completion text in traces. This is important for privacy — LLM conversations may contain sensitive data. Only enable this in development or when you have appropriate data handling in place.

## Step 5: Restart the Gateway

```bash
openclaw gateway restart
```

## Step 6: Verify

Check that the plugin is running:

```bash
openclaw otel
```

Expected output:

```
🔭 OpenTelemetry Observability Plugin
────────────────────────────────────────
  Endpoint:        http://localhost:4318
  Protocol:        http
  Service:         openclaw-gateway
  Traces:          ✅
  Metrics:         ✅
  Logs:            ✅
  Capture content: ❌
  Initialized:     ✅
```

You can also check from within a conversation using the agent tool:

```
> Check the OTel observability status
```

The agent will call the `otel_status` tool and report the plugin state.

## Step 7: Send Some Messages

Now just use your OpenClaw agent normally. Every LLM call, tool execution, and command will be traced and metricked automatically.

Check your backend:

- **Dynatrace** → Services → `openclaw-gateway` → Traces
- **Grafana** → Explore → Tempo → Search for `openclaw-gateway`
- **Collector debug** → `docker compose logs -f` shows exported spans

## What's Next?

- [Configuration Reference](configuration.md) — all options explained
- [Traces Reference](telemetry/traces.md) — what spans are generated
- [Metrics Reference](telemetry/metrics.md) — all exported metrics
- [Dynatrace Setup](backends/dynatrace.md) — detailed Dynatrace integration
