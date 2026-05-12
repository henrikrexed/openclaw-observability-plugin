# Dynatrace Setup

Send OpenClaw telemetry directly to Dynatrace using OTLP.

## Prerequisites

- Dynatrace environment (SaaS or Managed)
- API token with ingest permissions

## Create API Token

1. Go to **Settings** → **Access tokens**
2. Click **Generate new token**
3. Add scopes:
   - `metrics.ingest`
   - `logs.ingest`
   - `openTelemetryTrace.ingest`
4. Copy the token (starts with `dt0c01.`)

## Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{environment-id}.live.dynatrace.com/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token dt0c01.XXXXXXXX"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

Replace:
- `{environment-id}` — Your Dynatrace environment ID (e.g., `abc12345`)
- `dt0c01.XXXXXXXX` — Your API token

### Dynatrace Managed

For Dynatrace Managed, use your ActiveGate URL:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{your-activegate}/e/{environment-id}/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token dt0c01.XXXXXXXX"
      },
      "serviceName": "openclaw-gateway"
    }
  }
}
```

## Restart Gateway

```bash
openclaw gateway restart
```

## Verify in Dynatrace

### Find Your Service

1. Go to **Services** in Dynatrace
2. Search for `openclaw-gateway`
3. Click to view service details

### View Traces

1. Go to **Distributed traces**
2. Filter by service: `openclaw-gateway`
3. Click a trace to see spans

### View Metrics

1. Go to **Explore** → **Metrics**
2. Search for `openclaw.`
3. Available metrics:

**From this plugin (`openclaw-observability`):**
   - `openclaw.llm.tokens.total` / `openclaw.llm.tokens.prompt` / `openclaw.llm.tokens.completion` — Token usage by `gen_ai.response.model`
   - `openclaw.llm.cost.usd` — Estimated model cost by `gen_ai.response.model`
   - `openclaw.tool.calls` — Tool call counter
   - `openclaw.session.resets` — Session reset counter

**From the built-in `diagnostics-otel` plugin (only if you also enabled it in `openclaw.json`):**
   - `openclaw.tokens` — Token usage (emitted by `diagnostics-otel`, not by this plugin)
   - `openclaw.cost.usd` — Cost tracking (emitted by `diagnostics-otel`, not by this plugin)
   - `openclaw.run.duration_ms` — Agent run times
   - `openclaw.message.*` — Message processing
   - `openclaw.queue.*` — Queue metrics

### Create Dashboard

Create a dashboard with (queries below assume this plugin's metrics):

```sql
-- Token usage by model
timeseries sum(openclaw.llm.tokens.total), by:{gen_ai.response.model}

-- Cost over time
timeseries sum(openclaw.llm.cost.usd), by:{gen_ai.response.model}

-- Agent turn duration (span attribute, query via spans)
fetch spans
| filter span.name == "openclaw.agent.turn"
| summarize avg_duration = avg(openclaw.agent.duration_ms),
    by:{gen_ai.response.model}
```

### View Logs

1. Go to **Logs**
2. Filter: `dt.entity.service = "openclaw-gateway"`
3. View log records with severity and attributes

## Example DQL Queries

> The queries below target spans/metrics emitted by **this** plugin. If you only have the built-in `diagnostics-otel` plugin enabled, you'll need to swap `openclaw.llm.*` for `openclaw.tokens` / `openclaw.cost.usd` and adjust the group-by attribute to `openclaw.model`.

### Token Usage by Model
```sql
timeseries tokens = sum(openclaw.llm.tokens.total),
  by:{gen_ai.response.model}
| sort arrayLast(tokens) desc
```

### Average Agent Turn Duration
```sql
fetch spans
| filter dt.entity.service == "openclaw-gateway"
| filter span.name == "openclaw.agent.turn"
| summarize avg_duration = avg(openclaw.agent.duration_ms),
    by:{gen_ai.response.model}
```

### Error Rate
```sql
fetch logs
| filter dt.entity.service == "openclaw-gateway"
| filter loglevel == "ERROR"
| summarize count = count()
```

## Troubleshooting

### No Data in Dynatrace?

1. **Check token permissions**: Ensure all three scopes are enabled
2. **Verify endpoint URL**: Should be `https://{env-id}.live.dynatrace.com/api/v2/otlp`
3. **Test connectivity**:
   ```bash
   curl -v "https://{env-id}.live.dynatrace.com/api/v2/otlp/v1/traces" \
     -H "Authorization: Api-Token dt0c01.xxx"
   ```

### Service Not Appearing?

- Wait 2-5 minutes for service detection
- Send a few messages to generate telemetry
- Check Dynatrace logs for ingest errors

### 403 Forbidden?

Token lacks required scopes. Regenerate with all three:
- `metrics.ingest`
- `logs.ingest`
- `openTelemetryTrace.ingest`
