# Dynatrace Dashboard Templates

Pre-built Dynatrace dashboard JSON for monitoring OpenClaw AI agent operations.

## Dashboard: OpenClaw Overview

**File:** `openclaw-overview-dashboard.json`

### Sections

| # | Section | DQL Metrics | Visualization |
|---|---------|-------------|---------------|
| 1 | **Overview** | Agent count, monthly cost, health score, active issues | Single value tiles |
| 2 | **Token Usage** | `gen_ai.client.token.usage` by model/type, cache hit rate | Bar + line charts |
| 3 | **Cost by Agent** | `paperclip.cost.cents`, `openclaw.llm.cost_usd` by agent/model | Bar + area charts |
| 4 | **Agent Performance** | `gen_ai.client.operation.duration` by provider, tool call frequency | Line + bar charts |
| 5 | **Issue Flow** | `paperclip.issues.count` by status, completion rate | Area + line charts |
| 6 | **Budget Utilization** | `paperclip.budget.utilization` by agent, status table | Line chart + table |
| 7 | **Security** | `openclaw.security.*` events, recent incidents from spans | Line chart + table |
| 8 | **V3 spans & GenAI metrics** | `chat <model>` / `execute_tool <name>` / `openclaw.dispatch.prepare` spans + stable `gen_ai.client.*` metrics from `openclaw-o11y-plugin` | Tables + line/area charts |

### Import

1. Open Dynatrace → **Dashboards** → **Upload**
2. Select `openclaw-overview-dashboard.json`
3. The dashboard uses Dynatrace Dashboard v7 format (Grail/DQL)

### Prerequisites

- OpenClaw custom plugin or official diagnostics-otel enabled
- OTel Collector forwarding to Dynatrace OTLP endpoint
- For Paperclip metrics: Paperclip control plane exporting metrics
- For security tiles: Tetragon + security detection module active

### Metric Sources

| Metric | Source |
|--------|--------|
| `gen_ai.client.token.usage` | Custom plugin (agent_end hook) |
| `gen_ai.client.operation.duration` | Custom plugin (agent turns) |
| `openclaw.llm.cost_usd` | Diagnostics API integration |
| `openclaw.security.*` | Security detection module |
| `paperclip.*` | Paperclip control plane |

### Customization

- Adjust time ranges per tile as needed
- Add management zone filters for multi-environment setups
- Modify thresholds in single-value tiles to match your budget/SLO targets
