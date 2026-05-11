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
| `sampleRate` | number | `1.0` | Trace sampling rate (0.0–1.0) |
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
| `OPENCLAW_OTEL_CAPTURE_CONTENT` | Legacy single-boolean flag for Traceloop content capture. `true` enables prompt/completion text on LLM-client spans. See [captureContent (gateway-launch setting)](#capturecontent-gateway-launch-setting). |
| `OPENCLAW_OTEL_CONTENT_POLICY` | Granular policy JSON (ISI-1000). When set, takes precedence over the legacy boolean. Same shape as the plugin's `captureContent` object form. |

Config file values take precedence over environment variables.

## `captureContent` (gateway-launch setting)

The plugin exposes a `captureContent` field in `plugins.entries.otel-observability.config`. It accepts either:

- a single boolean — `true` turns every capture category on, `false` turns every category off (legacy shape, kept for backwards compatibility), or
- a granular **`ContentCapturePolicy`** object with five independent flags:

| Flag | Span attribute(s) | What is captured |
|------|--------------------|-------------------|
| `inputMessages` | `openclaw.content.input_message` (request span), `openclaw.content.prompt` / `openclaw.content.messages` (agent.turn span) | Inbound user message + the prompt and message history fed to the LLM |
| `outputMessages` | `openclaw.content.output_message` (message.sent span) | Outbound assistant reply text |
| `toolInputs` | `openclaw.content.tool_input` (execute_tool span) | Full tool-call input arguments (JSON-stringified, capped at 8 KB) |
| `toolOutputs` | `openclaw.content.tool_output` (execute_tool span) | Tool-call result text (text parts of the result message, capped at 8 KB) |
| `systemPrompt` | `openclaw.content.system_prompt` (agent.turn span) | System prompt text |

LLM-client spans emitted by Traceloop (`@traceloop/instrumentation-anthropic`, `@traceloop/instrumentation-openai`) still respect the legacy single-boolean Traceloop flag. The plugin derives it from the policy as `inputMessages || outputMessages || systemPrompt` — the three categories that map to prompt/completion text.

**Default: `false` (every flag off, privacy-first).** See [github issue #15](https://github.com/henrikrexed/openclaw-observability-plugin/issues/15) for the motivating report and ISI-1000 for the granular policy.

### Not hot-reloadable

`captureContent` is a **gateway-launch setting**, not a hot-reloadable plugin option, because the ESM preload (`instrumentation/preload.mjs`) instantiates `AnthropicInstrumentation` and `OpenAIInstrumentation` *before* OpenClaw parses plugin config. Changing the value in `openclaw.json` mid-run has no effect until the next gateway restart.

### How to enable content capture

The preload reads two env vars and picks the granular one whenever it is set:

- `OPENCLAW_OTEL_CONTENT_POLICY` — granular policy as JSON. Preferred.
- `OPENCLAW_OTEL_CAPTURE_CONTENT` — legacy single boolean. Fallback.

#### All-on (legacy boolean)

```bash
OPENCLAW_OTEL_CAPTURE_CONTENT=true \
  NODE_OPTIONS="--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs" \
  openclaw gateway start
```

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

#### Granular (recommended)

Enable only what you actually need. For example, capture tool inputs/outputs for debugging without recording user prompts:

```bash
OPENCLAW_OTEL_CONTENT_POLICY='{"toolInputs":true,"toolOutputs":true}' \
  NODE_OPTIONS="--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs" \
  openclaw gateway start
```

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "captureContent": {
            "toolInputs": true,
            "toolOutputs": true
          }
        }
      }
    }
  }
}
```

Or via systemd:

```ini
[Service]
Environment=OPENCLAW_OTEL_CONTENT_POLICY={"toolInputs":true,"toolOutputs":true}
Environment=NODE_OPTIONS=--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs
ExecStart=/usr/bin/openclaw gateway start
```

### Mismatch warning

If the plugin config and the preload-time env vars disagree about whether LLM-client content capture is on, the plugin logs a warning at `start()`:

```
[otel] captureContent policy resolves traceContent=true but the preload resolved
OPENCLAW_OTEL_CAPTURE_CONTENT=false at gateway launch. Traceloop LLM-client
spans will use the preload's value. Set OPENCLAW_OTEL_CONTENT_POLICY='{"inputMessages":true}'
(or OPENCLAW_OTEL_CAPTURE_CONTENT=true) in the gateway's environment before
starting (see docs/security/privacy.md).
```

Fix by setting the env var and restarting the gateway. The plugin's own hook-surface content attributes (`openclaw.content.*`) are not affected by this warning — they are evaluated against the live plugin config and so are always consistent with the running policy.

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
