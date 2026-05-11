# Configuration

Configure OpenClaw's built-in OpenTelemetry diagnostics via `~/.openclaw/openclaw.json`.

## Full Configuration Example

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "protocol": "http/protobuf",
      "headers": {
        "Authorization": "Api-Token dt0c01.xxx"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 1.0,
      "flushIntervalMs": 5000
    }
  }
}
```

## Configuration Reference

### `diagnostics`

Top-level diagnostics configuration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable the diagnostics system |

### `diagnostics.otel`

OpenTelemetry export configuration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable OTel export |
| `endpoint` | string | — | OTLP endpoint URL (required) |
| `protocol` | string | `"http/protobuf"` | Protocol: `"http/protobuf"` or `"grpc"` |
| `headers` | object | `{}` | Custom HTTP headers (e.g., auth tokens) |
| `serviceName` | string | `"openclaw"` | OTel service name attribute |
| `traces` | boolean | `true` | Enable trace export |
| `metrics` | boolean | `true` | Enable metrics export |
| `logs` | boolean | `false` | Enable log forwarding |
| `sampleRate` | number | — | Trace sampling rate, `0.0`–`1.0`. Omit to use the SDK default (`parentbased_always_on`). See [Trace Sampling](#trace-sampling). |
| `flushIntervalMs` | number | — | Export flush interval in milliseconds |

## Endpoint Configuration

### HTTP Protocol (Default)

For OTLP/HTTP endpoints (port 4318):

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "protocol": "http/protobuf"
    }
  }
}
```

The endpoint auto-appends `/v1/traces`, `/v1/metrics`, `/v1/logs` as needed.

### gRPC Protocol

For OTLP/gRPC endpoints (port 4317):

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4317",
      "protocol": "grpc"
    }
  }
}
```

**Note**: gRPC support is experimental.

## Authentication

### Bearer Token

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://api.example.com/otlp",
      "headers": {
        "Authorization": "Bearer your-token-here"
      }
    }
  }
}
```

### Dynatrace API Token

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{env-id}.live.dynatrace.com/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token dt0c01.xxx..."
      }
    }
  }
}
```

### Basic Auth (Grafana Cloud)

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-prod-us-central-0.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic base64(instanceId:apiKey)"
      }
    }
  }
}
```

## Sampling

Control trace sampling rate to reduce volume:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "sampleRate": 0.1
    }
  }
}
```

- `1.0` — Sample all traces (default)
- `0.5` — Sample 50% of traces
- `0.1` — Sample 10% of traces
- `0.0` — Disable trace sampling

## Selective Export

Enable only specific signals:

### Traces Only

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "traces": true,
      "metrics": false,
      "logs": false
    }
  }
}
```

### Metrics Only

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "traces": false,
      "metrics": true,
      "logs": false
    }
  }
}
```

### Logs Only

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "traces": false,
      "metrics": false,
      "logs": true
    }
  }
}
```

## Environment Variables

OpenClaw also respects standard OTel environment variables as fallbacks:

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Default OTLP endpoint |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Default protocol |
| `OTEL_SERVICE_NAME` | Default service name |
| `OPENCLAW_OTEL_CAPTURE_CONTENT` | `true` to capture LLM prompt/completion text in Traceloop spans. See [captureContent (gateway-launch setting)](#capturecontent-gateway-launch-setting). |

Config file values take precedence over environment variables.

## Trace Sampling

The plugin exports 100% of traces by default. For high-traffic gateways this can be tuned down with the `sampleRate` option (0.0–1.0):

```json
{
  "diagnostics": {
    "otel": {
      "sampleRate": 0.1
    }
  }
}
```

Semantics:

- `sampleRate` omitted — the SDK default sampler (`parentbased_always_on`) is used. The plugin does not construct its own sampler; nothing sampler-related appears in the boot log.
- `sampleRate: 1.0` — the plugin explicitly constructs `ParentBased(TraceIdRatio(1.0))`. Behaviourally equivalent to always-on, but the boot log reports `sampler=parentbased_traceidratio(1)` so operators can confirm the plugin took the sampling code path.
- `0.0` — drop every trace.
- Any value in between — keep that fraction of root traces.

Sampling is head-based and parent-respecting: the plugin wires a `ParentBasedSampler` around a `TraceIdRatioBasedSampler`. The root span of a trace makes the sampling decision based on the trace ID; child spans inherit the parent's decision so distributed traces stay coherent and you never see "half a trace".

Invalid values (negative, > 1, `NaN`, non-numeric) are ignored and the SDK default (`parentbased_always_on`) is used instead.

## `captureContent` (gateway-launch setting)

The custom plugin exposes a `captureContent` boolean in `plugins.entries.otel-observability.config`. When `true`, Traceloop-instrumented LLM-client spans (`@traceloop/instrumentation-anthropic`, `@traceloop/instrumentation-openai`) include the actual prompt/completion text as `gen_ai.prompt.*` and `gen_ai.completion.*` attributes.

**Default: `false` (privacy-first).** The schema help text already advertises this toggle; see [github issue #15](https://github.com/henrikrexed/openclaw-observability-plugin/issues/15) for the motivating report.

### Not hot-reloadable

`captureContent` is a **gateway-launch setting**, not a hot-reloadable plugin option, because the ESM preload (`instrumentation/preload.mjs`) instantiates `AnthropicInstrumentation` and `OpenAIInstrumentation` *before* OpenClaw parses plugin config. Changing the value in `openclaw.json` mid-run has no effect until the next gateway restart.

### How to enable content capture

Set both the plugin config **and** the environment variable before launching the gateway:

```bash
OPENCLAW_OTEL_CAPTURE_CONTENT=true \
  NODE_OPTIONS="--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs" \
  openclaw gateway start
```

Or via systemd:

```ini
[Service]
Environment=OPENCLAW_OTEL_CAPTURE_CONTENT=true
Environment=NODE_OPTIONS=--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs
ExecStart=/usr/bin/openclaw gateway start
```

Plugin config:

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "captureContent": true
        }
      }
    }
  }
}
```

### Mismatch warning

If the plugin config says `captureContent: true` but the env var was unset (or `false`) when the gateway launched, the preload will have wired the Traceloop instrumentations with `traceContent: false`. At plugin `start()` the plugin logs a warning like:

```
[otel] captureContent=true in plugin config but the preload resolved
OPENCLAW_OTEL_CAPTURE_CONTENT=false at gateway launch. Traceloop LLM-client
spans will use the preload's value. Set OPENCLAW_OTEL_CAPTURE_CONTENT=true
in the gateway's environment before starting (see docs/security/privacy.md).
```

Fix by setting the env var and restarting the gateway.

### Privacy guidance

Leave `captureContent` at `false` unless you control the backend and understand the implications. See [Privacy: `captureContent`](./security/privacy.md) for a fuller treatment.

## Applying Changes

After modifying configuration:

```bash
openclaw gateway restart
```

Or trigger a hot reload (if supported):

```bash
kill -SIGUSR1 $(pgrep -f openclaw-gateway)
```

## Troubleshooting

### Configuration Not Applied?

Check the current config:

```bash
cat ~/.openclaw/openclaw.json | jq '.diagnostics'
```

### Invalid Config Errors?

Validate JSON syntax:

```bash
cat ~/.openclaw/openclaw.json | jq .
```

### Endpoint Unreachable?

Test connectivity:

```bash
curl -v http://localhost:4318/v1/traces
```
