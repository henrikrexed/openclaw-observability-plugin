# Configuration Reference

All configuration lives under `plugins.entries.otel-observability.config` in your OpenClaw config.

## Full Example

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
          "headers": {
            "Authorization": "Api-Token dt0c01.XXXX"
          },
          "traces": true,
          "metrics": true,
          "logs": true,
          "captureContent": false,
          "metricsIntervalMs": 30000,
          "resourceAttributes": {
            "deployment.environment": "production",
            "host.name": "my-server"
          }
        }
      }
    }
  }
}
```

## Options

### `endpoint`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `"http://localhost:4318"` |
| **Required** | No |

The OTLP endpoint URL. This is where trace and metric data is sent.

- For **OTLP/HTTP**: use port `4318` (e.g., `http://localhost:4318`)
- For **OTLP/gRPC**: use port `4317` (e.g., `http://localhost:4317`)
- For **Dynatrace direct**: use `https://<env>.live.dynatrace.com/api/v2/otlp`

The plugin automatically appends `/v1/traces` and `/v1/metrics` for HTTP protocol.

---

### `protocol`

| | |
|---|---|
| **Type** | `"http"` \| `"grpc"` |
| **Default** | `"http"` |
| **Required** | No |

The OTLP export protocol.

- `"http"` — OTLP/HTTP (protobuf over HTTP). Works with most backends and through proxies.
- `"grpc"` — OTLP/gRPC. Slightly more efficient, but may not work through all proxies.

!!! tip
    Use `"http"` unless you have a specific reason to use gRPC. It's more compatible and easier to debug.

---

### `serviceName`

| | |
|---|---|
| **Type** | `string` |
| **Default** | `"openclaw-gateway"` |
| **Required** | No |

The OpenTelemetry service name. This appears as the service identity in your backend's service map, trace views, and dashboards.

---

### `headers`

| | |
|---|---|
| **Type** | `object` (string → string) |
| **Default** | `{}` |
| **Required** | No |

Custom HTTP headers sent with every OTLP export request. Use this for authentication.

**Dynatrace example:**
```json
{
  "Authorization": "Api-Token dt0c01.XXXXXXXX.YYYYYYYY"
}
```

**Grafana Cloud example:**
```json
{
  "Authorization": "Basic <base64-encoded-credentials>"
}
```

---

### `traces`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Required** | No |

Enable or disable trace export. When `true`:

- Connected traces are created for requests, agent turns, and tool executions
- GenAI attributes (token counts, model) are added to agent turn spans
- Spans are exported via OTLP to the configured endpoint

---

### `metrics`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Required** | No |

Enable or disable metrics export. When `true`, counters and histograms for token usage, tool calls, latency, etc. are periodically exported.

---

### `logs`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `true` |
| **Required** | No |

Enable or disable log export. When `true`, structured gateway logs are forwarded as OTel log records.

---

### `captureContent`

| | |
|---|---|
| **Type** | `boolean` |
| **Default** | `false` |
| **Required** | No |

Reserved for future use. When per-LLM-call auto-instrumentation becomes available, this would enable recording prompt and completion text inside trace spans. Currently has no effect — the plugin does not capture message content. See [Limitations](limitations.md).

!!! danger "Privacy Warning"
    Enabling `captureContent` means LLM conversations — which may contain personal data, credentials, or sensitive business information — will be stored in your observability backend. Only enable this when:

    - You're debugging in a development environment
    - Your backend has appropriate data retention and access policies
    - You understand your compliance requirements (GDPR, etc.)

---

### `metricsIntervalMs`

| | |
|---|---|
| **Type** | `number` |
| **Default** | `30000` (30 seconds) |
| **Minimum** | `1000` |
| **Required** | No |

How often metrics are exported, in milliseconds. Lower values give faster feedback but increase network traffic. For production, 30s–60s is usually fine.

---

### `resourceAttributes`

| | |
|---|---|
| **Type** | `object` (string → string) |
| **Default** | `{}` |
| **Required** | No |

Additional [OTel resource attributes](https://opentelemetry.io/docs/concepts/resources/) attached to all exported telemetry. Useful for tagging your deployment.

```json
{
  "deployment.environment": "production",
  "host.name": "agent-server-01",
  "service.namespace": "ai-agents"
}
```

These attributes appear on every span, metric, and log record, making it easy to filter in your backend.

## Environment Variables

The plugin also respects standard OpenTelemetry environment variables as fallbacks:

| Variable | Maps to |
|----------|---------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `endpoint` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `protocol` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `headers` |
| `OTEL_SERVICE_NAME` | `serviceName` |

Plugin config takes precedence over environment variables.

## Minimal Config

The absolute minimum to get started (all defaults apply):

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true
      }
    }
  }
}
```

This exports traces and metrics to `http://localhost:4318` with service name `openclaw-gateway`.
