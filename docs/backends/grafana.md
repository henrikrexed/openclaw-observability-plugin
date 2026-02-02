# Grafana Integration

Export OpenClaw traces to **Grafana Tempo** and metrics to **Grafana Mimir** (or Prometheus) for visualization in Grafana dashboards.

## Grafana Cloud (Direct Export)

### 1. Get Your OTLP Credentials

1. Go to [grafana.com](https://grafana.com) → Your stack → **Connections** → **OpenTelemetry**
2. Note the OTLP endpoint and generate an API token

### 2. Configure the Plugin

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "endpoint": "https://otlp-gateway-<region>.grafana.net/otlp",
          "protocol": "http",
          "serviceName": "openclaw-gateway",
          "headers": {
            "Authorization": "Basic <base64-of-instanceId:apiToken>"
          }
        }
      }
    }
  }
}
```

!!! tip "Creating the Basic auth header"
    ```bash
    echo -n "<instanceId>:<apiToken>" | base64
    ```

## Self-Hosted Grafana Stack

### Docker Compose Addition

Add Tempo and Grafana to the collector setup:

```yaml
services:
  otel-collector:
    # ... existing config ...

  tempo:
    image: grafana/tempo:latest
    container_name: openclaw-tempo
    ports:
      - "3200:3200"   # Tempo API
      - "4417:4317"   # OTLP gRPC (Tempo)
    volumes:
      - ./collector/tempo-config.yaml:/etc/tempo/config.yaml:ro
    command: ["-config.file=/etc/tempo/config.yaml"]

  grafana:
    image: grafana/grafana:latest
    container_name: openclaw-grafana
    ports:
      - "3000:3000"
    environment:
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Admin
    volumes:
      - grafana-data:/var/lib/grafana

volumes:
  grafana-data:
```

### Tempo Configuration

Create `collector/tempo-config.yaml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317

storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo/blocks
    wal:
      path: /tmp/tempo/wal

metrics_generator:
  storage:
    path: /tmp/tempo/generator/wal
```

### Collector Config (Fan-Out)

Update `collector/otel-collector-config.yaml` to export to both Dynatrace and Tempo:

```yaml
exporters:
  otlphttp/dynatrace:
    endpoint: "${DYNATRACE_ENDPOINT}"
    headers:
      Authorization: "Api-Token ${DYNATRACE_API_TOKEN}"

  otlp/tempo:
    endpoint: "tempo:4317"
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/dynatrace, otlp/tempo]
```

### Grafana Data Source

1. Open Grafana at `http://localhost:3000`
2. Go to **Configuration** → **Data Sources** → **Add data source**
3. Select **Tempo**
4. Set URL: `http://tempo:3200`
5. Click **Save & Test**

## Grafana Dashboards

### Explore View

1. Go to **Explore**
2. Select the **Tempo** data source
3. Search by service name: `openclaw-gateway`
4. Or search by span name: `openclaw.agent.turn` or `tool.*`

### Example Dashboard Panels

**Token Usage Over Time** (Prometheus/Mimir):
```promql
sum(rate(openclaw_llm_tokens_total[5m])) by (model)
```

**LLM Latency P95** (Prometheus/Mimir):
```promql
histogram_quantile(0.95, rate(openclaw_llm_duration_bucket[5m]))
```

**Tool Call Rate** (Prometheus/Mimir):
```promql
sum(rate(openclaw_tool_calls_total[5m])) by (tool_name)
```

**Error Rate** (Prometheus/Mimir):
```promql
sum(rate(openclaw_llm_errors_total[5m])) / sum(rate(openclaw_llm_requests_total[5m])) * 100
```

!!! note "Metric name format"
    OTel metrics use dots (`openclaw.llm.tokens.total`) but Prometheus converts them to underscores (`openclaw_llm_tokens_total`).
