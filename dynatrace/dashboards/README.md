# Dynatrace Dashboard Templates

Pre-built Dynatrace dashboard JSON for monitoring OpenClaw AI agent operations.

## Dashboard: OpenClaw Overview

**File:** `openclaw-overview-dashboard.json`

### Sections

| # | Section | DQL Metrics | Visualization |
|---|---------|-------------|---------------|
| 1 | **Overview** | Agent count, monthly cost, health score, active issues | Single value tiles |
| 2 | **Token Usage** | `gen_ai.client.token.usage` by model/type, cache hit rate | Bar + line charts |
| 3 | **Cost by Agent** | `paperclip.cost.cents` (cents, divide by 100 for USD) by agent/model | Bar + area charts |
| 4 | **Agent Performance** | `gen_ai.client.operation.duration` by provider | Line charts |
| 5 | **Issue Flow** | `paperclip.issues.count` by status, completion rate | Area + line charts |
| 6 | **Budget Utilization** | `paperclip.budget.utilization` by agent, status table | Line chart + table |

### Import

1. Open Dynatrace → **Dashboards** → **Upload**
2. Select `openclaw-overview-dashboard.json`
3. The dashboard uses Dynatrace Dashboard v7 format (Grail/DQL)

### Prerequisites

- `@paperclipai/plugin-paperclip-observability` loaded in the agent runtime
- OTel Collector forwarding to Dynatrace OTLP endpoint

### Metric Sources

| Metric | Source |
|--------|--------|
| `gen_ai.client.token.usage` (histogram) | paperclip-observability plugin — GenAI semconv emit |
| `gen_ai.client.operation.duration` (histogram) | paperclip-observability plugin — GenAI semconv emit |
| `paperclip.cost.cents` | paperclip-observability plugin (unit: cents) |
| `paperclip.tokens.input`, `paperclip.tokens.output` | paperclip-observability plugin |
| `paperclip.agent.health.score`, `paperclip.issues.count`, `paperclip.budget.*` | paperclip control plane |

> Tool-call tiles (span.name `tool.*`) and Security tiles (`openclaw.security.*`, Tetragon-detected incidents) are tracked as follow-up work — see [ISI-567](https://app.paperclip.ing/ISI/issues/ISI-567) (tool-call tracing) and [ISI-568](https://app.paperclip.ing/ISI/issues/ISI-568) (security port). They will be added back once the plugin-side emit surfaces land.

> Cache hit rate tile depends on `gen_ai.token.type == "cache_read"` histogram dimension — pending plugin PR.

### Customization

- Adjust time ranges per tile as needed
- Add management zone filters for multi-environment setups
- Modify thresholds in single-value tiles to match your budget/SLO targets
