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

## Step 5: Configure the Systemd Service

If you run OpenClaw via **systemd** (the default when using `openclaw gateway start`), you need to ensure the plugin can load properly. The plugin is loaded at runtime via [jiti](https://github.com/unjs/jiti), but **code changes require a full process restart** — `SIGUSR1` hot-reload does not clear jiti's module cache.

### Locate the Service Unit

```bash
# User-level service (most common)
cat ~/.config/systemd/user/openclaw-gateway.service

# Or system-level (if installed globally)
cat /etc/systemd/system/openclaw-gateway.service
```

### Add the Plugin Load Path

Make sure your OpenClaw config (`~/.openclaw/openclaw.json`) includes the plugin path in `plugins.load.paths`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-observability-plugin"
      ]
    }
  }
}
```

!!! important "Use absolute paths"
    The systemd service runs with a different working directory than your shell. Always use **absolute paths** for plugin load paths — relative paths will fail silently.

### Restart Properly

After any plugin code change, you must:

1. **Clear the jiti cache** (TypeScript compilation cache):

    ```bash
    rm -rf /tmp/jiti
    ```

2. **Restart the systemd service** (not just SIGUSR1):

    ```bash
    # User-level service
    systemctl --user restart openclaw-gateway

    # Or system-level
    sudo systemctl restart openclaw-gateway
    ```

!!! warning "SIGUSR1 is NOT enough"
    `openclaw gateway restart` sends `SIGUSR1` which triggers a soft reload. This does **not** clear Node.js `require.cache` or jiti's compiled module cache. For plugin TypeScript changes to take effect, you must do a full systemd restart.

### Environment Variables

If you need to pass environment variables to the gateway (e.g., for debugging), add them to the service unit:

```bash
# Edit the service
systemctl --user edit openclaw-gateway

# Add under [Service]:
# Environment="OTEL_LOG_LEVEL=debug"
```

Then reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway
```

### Verify the Service is Running

```bash
# Check status
systemctl --user status openclaw-gateway

# Check logs for [otel] messages
journalctl --user -u openclaw-gateway --since "2 min ago" | grep "\[otel\]"
```

You should see:

```
[otel] Starting OpenTelemetry observability...
[otel] Trace exporter → http://localhost:4318/v1/traces (http)
[otel] Metrics exporter → http://localhost:4318/v1/metrics (http, interval=30000ms)
[otel] Registered message_received hook (via api.on)
[otel] Registered before_agent_start hook (via api.on)
[otel] Registered tool_result_persist hook (via api.on)
[otel] Registered agent_end hook (via api.on)
[otel] ✅ Observability pipeline active
```

## Step 6: Restart the Gateway

If you're **not** using systemd (e.g., running `openclaw gateway` directly in a terminal):

```bash
openclaw gateway restart
```

## Step 7: Verify

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

## Step 8: Send Some Messages

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
