# Getting Started

Get OpenTelemetry observability for your OpenClaw AI agents.

## Prerequisites

- OpenClaw v2026.2.0 or later
- An OTLP endpoint (local collector, Dynatrace, Grafana, etc.)

## Option 1: Official Diagnostics Plugin (Recommended Start)

The fastest way to get observability. No installation needed — just configure.

### Step 1: Add Configuration

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

### Step 2: Restart Gateway

```bash
openclaw gateway restart
```

### Step 3: Verify

Send a message to your agent and check your backend for:

- **Metrics (emitted by `diagnostics-otel`):** `openclaw.tokens`, `openclaw.cost.usd`, `openclaw.run.duration_ms`
- **Traces:** `openclaw.model.usage`, `openclaw.message.processed`
- **Logs:** Gateway logs with severity and code location

> If you also installed Option 2 (this repo's custom plugin), the metrics from the custom plugin are different: `openclaw.llm.tokens.{total,prompt,completion}`, `openclaw.llm.cost.usd`, and the OTel stable `gen_ai.*` set.

---

## Option 2: Custom Hook-Based Plugin (Deeper Tracing)

For connected traces and per-tool-call visibility, add the custom plugin.

### Step 1: Clone the Repository

```bash
cd ~/.openclaw/extensions
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git otel-observability
```

### Step 2: Install Dependencies

```bash
cd otel-observability
npm install
```

### Step 3: Configure OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/otel-observability"]
    },
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4318",
          "protocol": "http",
          "serviceName": "openclaw-gateway"
        },
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

> **Required for OpenClaw ≥ 2026.4.23.** Path-loaded (non-bundled) plugins must explicitly opt in to conversation typed hooks. Without `hooks.allowConversationAccess: true`, OpenClaw silently drops the registrations for `before_model_resolve`, `llm_input`, `llm_output`, `before_agent_finalize`, `agent_end`, `before_agent_reply`, and `before_agent_run`. The plugin still prints its `[otel] Registered ... hook (via api.on)` banners but the handlers never fire, so no `openclaw.request` / `openclaw.agent.turn` spans reach your backend. See [github issue #20](https://github.com/henrikrexed/openclaw-observability-plugin/issues/20) and the [troubleshooting section](../README.md#hooks-register-but-never-fire).

> **Note:** Custom plugin settings live under `plugins.entries.otel-observability.config`. OpenClaw's built-in diagnostics exporter uses a separate `diagnostics.otel` block; do not mix the two config surfaces.

### Step 4: Clear Cache and Restart

```bash
rm -rf /tmp/jiti
systemctl --user restart openclaw-gateway
# Or: openclaw gateway restart
```

### Step 5: Verify Connected Traces

First, confirm the plugin is wired into the gateway. Tail the gateway log during startup:

```bash
journalctl --user -u openclaw-gateway -f | grep -E '\[otel\]'
```

You should see these lines **during `register()`** (before the gateway accepts traffic):

```
[otel] Registered message_received hook (via api.on)
[otel] Registered before_model_resolve hook (via api.on)
[otel] Registered before_prompt_build hook (via api.on)
[otel] Registered tool_result_persist hook (via api.on)
[otel] Registered agent_end hook (via api.on)
[otel] Registered command event hooks (via api.registerHook)
[otel] Registered gateway:startup hook (via api.registerHook)
```

Then, **during `start()`** (after the gateway is ready):

```
[otel] Starting OpenTelemetry observability...
[otel] ✅ Observability pipeline active
[otel]   Traces=true Metrics=true Logs=true
[otel]   Endpoint=http://localhost:4318 (http)
```

Now send a message that triggers tool calls (e.g., "read my AGENTS.md file"). On each inbound message, debug-level logs confirm hooks are firing:

```
[otel] Root span started for session=<sessionKey>
[otel] Agent turn span started: agent=<agentId>, session=<sessionKey>
```

In your backend you should see a connected trace:

```
openclaw.request
└── openclaw.agent.turn
    └── tool.Read
```

---

## Using Both Plugins Together

For complete observability, enable both:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://localhost:4318",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  },
  "plugins": {
    "load": {
      "paths": ["~/.openclaw/extensions/otel-observability"]
    },
    "entries": {
      "otel-observability": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "endpoint": "http://localhost:4318",
          "serviceName": "openclaw-gateway"
        }
      }
    }
  }
}
```

> `hooks.allowConversationAccess: true` is required on OpenClaw ≥ 2026.4.23. See [the install step above](#step-3-configure-openclaw).

**What you get:**

| Source | Data |
|--------|------|
| Official | Gateway health, queue metrics, log forwarding, session states |
| Custom | Connected request traces, tool call spans, agent turn details |

---

## Backend Quick Setup

### Local OTel Collector

1. Install:
   ```bash
   # Ubuntu/Debian
   wget https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.144.0/otelcol-contrib_0.144.0_linux_amd64.deb
   sudo dpkg -i otelcol-contrib_0.144.0_linux_amd64.deb
   ```

2. Configure (`/etc/otelcol-contrib/config.yaml`):
   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318

   processors:
     batch:

   exporters:
     debug:
       verbosity: detailed
     # Add your backend exporter

   service:
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       metrics:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
       logs:
         receivers: [otlp]
         processors: [batch]
         exporters: [debug]
   ```

3. Start:
   ```bash
   sudo systemctl start otelcol-contrib
   ```

### Dynatrace (Direct)

No collector needed:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{environment-id}.live.dynatrace.com/api/v2/otlp",
      "headers": {
        "Authorization": "Api-Token {your-token}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  }
}
```

**Required scopes:** `metrics.ingest`, `logs.ingest`, `openTelemetryTrace.ingest`

### Grafana Cloud

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-{region}.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic {base64(instanceId:apiKey)}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true
    }
  }
}
```

---

## Troubleshooting

### No data appearing?

1. Check Gateway logs:
   ```bash
   journalctl --user -u openclaw-gateway -f
   ```

2. Verify endpoint is reachable:
   ```bash
   curl -v http://localhost:4318/v1/traces
   ```

3. Check diagnostics config:
   ```bash
   cat ~/.openclaw/openclaw.json | jq '.diagnostics'
   ```

### Custom plugin not loading?

1. Check plugin discovery:
   ```bash
   openclaw plugins list
   ```

2. Clear jiti cache:
   ```bash
   rm -rf /tmp/jiti
   ```

3. Check for TypeScript errors in Gateway logs

### Traces not connected?

The custom plugin requires messages to flow through the normal pipeline. Heartbeats and some internal events may not have full trace context.

### Hooks register but never fire

**Symptom:** Gateway logs `[otel] ✅ Observability pipeline active`, but no `openclaw.request` or `tool.*` spans reach your backend when you send messages.

**Cause (pre-PR #6):** Earlier builds registered typed hooks from inside the async `service.start()` phase. OpenClaw snapshots typed hooks at plugin registration time — ~30 s before `start()` runs — so the gateway never saw the 15 hook listeners. Tracked as [ISI-515](https://github.com/henrikrexed/openclaw-observability-plugin/pull/6).

**Fix:** Upgrade to a build that includes PR #6. Hooks are now registered synchronously in `register()` and resolve the telemetry runtime through a lazy getter.

**How to confirm hooks are live:**

1. During gateway startup, look for all six registration lines from `register()`:
   ```
   [otel] Registered message_received hook (via api.on)
   [otel] Registered before_agent_start hook (via api.on)
   [otel] Registered tool_result_persist hook (via api.on)
   [otel] Registered agent_end hook (via api.on)
   [otel] Registered command event hooks (via api.registerHook)
   [otel] Registered gateway:startup hook (via api.registerHook)
   ```
   If these are missing, the plugin is not loaded — recheck `plugins.load.paths` and clear `/tmp/jiti`.

2. Send a real message through the pipeline and enable debug logging. You should see:
   ```
   [otel] Root span started for session=<sessionKey>
   [otel] Agent turn span started: agent=<agentId>, session=<sessionKey>
   ```
   If registration lines are present but these are missing, the gateway is not firing hooks for that event path (e.g., heartbeats skip `message_received`).

3. Verify the OTLP endpoint is reachable:
   ```bash
   curl -v http://localhost:4318/v1/traces
   ```

See [Architecture → Plugin Lifecycle](architecture.md#plugin-lifecycle) for why the `register()` vs `start()` split matters.

---

## Next Steps

- [Configuration Reference](./configuration.md) — All options
- [Architecture](./architecture.md) — How it works
- [Limitations](./limitations.md) — Known constraints
- [Backend Guides](./backends/) — Specific backend setup
