# Dynatrace Integration

Dynatrace has native OTLP ingest — you can export directly or via the included OTel Collector.

## Prerequisites

1. A Dynatrace environment (SaaS or Managed)
2. An access token with these scopes:
    - `openTelemetryTrace.ingest`
    - `metrics.ingest`
    - `logs.ingest`

### Create an Access Token

1. Go to your Dynatrace environment
2. Navigate to **Access Tokens** (Settings → Integration → Access Tokens, or via Manage → Access Tokens)
3. Click **Generate new token**
4. Name it (e.g., `openclaw-otel`)
5. Add scopes: `openTelemetryTrace.ingest`, `metrics.ingest`, `logs.ingest`
6. Click **Generate token** and copy it

## Option A: Direct Export (Simplest)

Point the plugin directly at Dynatrace's OTLP endpoint.

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "endpoint": "https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp",
          "protocol": "http",
          "serviceName": "openclaw-gateway",
          "headers": {
            "Authorization": "Api-Token <YOUR_ACCESS_TOKEN>"
          },
          "traces": true,
          "metrics": true,
          "logs": true
        }
      }
    }
  }
}
```

Replace:

- `<YOUR_ENV>` — your Dynatrace environment ID (e.g., `abc12345`)
- `<YOUR_ACCESS_TOKEN>` — the token you created above

!!! note "SaaS vs Managed"
    - **SaaS:** `https://<env-id>.live.dynatrace.com/api/v2/otlp`
    - **Managed:** `https://<your-domain>/e/<env-id>/api/v2/otlp`
    - **ActiveGate:** `https://<activegate-host>:9999/e/<env-id>/api/v2/otlp`

## Option B: Via OTel Collector (Recommended)

Use the included Docker Compose setup.

### 1. Set Environment Variables

```bash
export DYNATRACE_ENDPOINT=https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp
export DYNATRACE_API_TOKEN=<YOUR_ACCESS_TOKEN>
```

### 2. Start the Collector

```bash
cd openclaw-observability-plugin
docker compose up -d
```

### 3. Configure the Plugin

Point the plugin at the local collector:

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "protocol": "http",
          "serviceName": "openclaw-gateway"
        }
      }
    }
  }
}
```

No auth headers needed — the collector handles authentication with Dynatrace.

### 4. Verify

Check the collector logs:

```bash
docker compose logs -f otel-collector
```

You should see export confirmations.

## Viewing Data in Dynatrace

### Traces

1. Open **Distributed Traces** (or search for it)
2. Filter by service: `openclaw-gateway`
3. You'll see traces for LLM calls, tool executions, and commands

### GenAI Observability

Dynatrace has a dedicated GenAI observability view:

1. Navigate to **Apps → GenAI Observability**
2. This view is specifically designed for LLM traces and shows:
    - Model usage breakdown
    - Token consumption
    - Latency per model
    - Error rates

### Metrics

1. Open **Metrics Explorer** (or Data Explorer)
2. Search for `openclaw.*`
3. Available metrics:
    - `openclaw.llm.tokens.total`
    - `openclaw.llm.duration`
    - `openclaw.tool.calls`
    - etc.

### Dashboards

Create a dashboard with:

```
# Token usage over time
timeseries avg(openclaw.llm.tokens.total), by:{gen_ai.request.model}

# LLM latency
timeseries percentile(openclaw.llm.duration, 50, 95, 99)

# Tool usage
timeseries sum(openclaw.tool.calls), by:{tool.name}

# Error rate
timeseries sum(openclaw.llm.errors) / sum(openclaw.llm.requests) * 100
```

## Troubleshooting

### No data appearing?

1. **Check the plugin:** `openclaw otel` — is it initialized?
2. **Check connectivity:** Can the machine reach the Dynatrace endpoint?
3. **Check the token:** Does it have the right scopes?
4. **Check collector logs:** `docker compose logs -f` (if using collector)

### 401 Unauthorized

Your access token is missing or invalid. Regenerate it with the correct scopes.

### Traces appear but no metrics

Ensure `metrics.ingest` scope is on the token and `metrics: true` is in the plugin config.
