# OpenClaw Observability

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://henrikrexed.github.io/openclaw-observability-plugin/)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

OpenTelemetry observability for [OpenClaw](https://github.com/openclaw/openclaw) AI agents.

📖 **[Full Documentation](https://henrikrexed.github.io/openclaw-observability-plugin/)** — Setup guides, configuration reference, and backend examples.

## Support matrix

The plugin follows a two-track support model. Pick the plugin track that matches your OpenClaw Gateway version. See [`SUPPORT.md`](SUPPORT.md) for the full policy, and [`CONTRIBUTING.md`](CONTRIBUTING.md#backports-to-release01x) for the backport workflow.

| Plugin track | OpenClaw range    | Branch           | Status                                                   | Window                                         |
| ------------ | ----------------- | ---------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `0.1.x`      | `< 2026.4.21`     | `release/0.1.x`  | Maintenance — security + critical regressions only        | Through **2026-10-21**                         |
| `0.2.x`      | `>= 2026.4.21`    | `main`           | Superseded by 0.3.x                                      | Replaced by 0.3.x                             |
| `0.3.x`      | `>= 2026.4.21`    | `main`           | Active — V3 features, log pipeline, bug fixes             | Default going forward                          |

> OpenClaw `2026.4.21` introduced the `before_model_resolve` and `before_prompt_build` hooks and deprecated `before_agent_start`. The `0.2.x` line targets the new hooks; the `0.1.x` line remains on the legacy hook for existing deployments.

## Two Approaches to Observability

This repository documents **two complementary approaches** to monitoring OpenClaw:

| Approach | Best For | Setup Complexity |
|----------|----------|------------------|
| **Official Plugin** | Operational metrics, Gateway health, cost tracking | Simple config |
| **Custom Plugin** | Deep tracing, tool call visibility, request lifecycle | Plugin installation |

**Recommendation:** Use both for complete observability.

---

## Approach 1: Official Diagnostics Plugin (Built-in)

OpenClaw v2026.2+ includes **built-in OpenTelemetry support**. Just add to `openclaw.json`:

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

Then restart:

```bash
openclaw gateway restart
```

### What It Captures

**Metrics:**
- `openclaw.tokens` — Token usage by type (input/output/cache)
- `openclaw.cost.usd` — Estimated model cost
- `openclaw.run.duration_ms` — Agent run duration
- `openclaw.context.tokens` — Context window usage
- `openclaw.webhook.*` — Webhook processing stats
- `openclaw.message.*` — Message processing stats
- `openclaw.queue.*` — Queue depth and wait times
- `openclaw.session.*` — Session state transitions

**Traces:** Model usage, webhook processing, message processing, stuck sessions

**Logs:** All Gateway logs via OTLP with severity, subsystem, and code location

---

## Approach 2: Custom Hook-Based Plugin (This Repo)

For **deeper observability**, install the custom plugin from this repo. It uses OpenClaw's typed plugin hooks to capture the full agent lifecycle.

### What It Adds

**Connected Traces:**
```
openclaw.request (root span)
├── openclaw.session (long-lived session span)
├── openclaw.agent.turn
│   ├── openclaw.dispatch.prepare
│   ├── chat {model} (model call span, GenAI semconv)
│   ├── execute_tool Read (tool span)
│   ├── execute_tool Write (tool span)
│   └── execute_tool Bash (tool span)
└── openclaw.message.sent
```

**V3 New Capabilities:**

| Feature | Description |
|---------|-------------|
| Model Call Spans | `chat {model}` CLIENT spans with full GenAI semconv (request/response model, tokens, cache, finish reasons) |
| Tool Call Timing | `before_tool_call` / `after_tool_call` hooks with accurate duration, approval workflow |
| Session Tracking | Long-lived `openclaw.session` spans with duration, request count, end reason |
| Dispatch Spans | `openclaw.dispatch.prepare` spans for LLM request dispatch phase |
| Log Export Pipeline | OTLP log export via `log.record` diagnostic events with severity, filtering, trace correlation |
| Security Detection | Prompt injection, dangerous command, sensitive file access detection on spans |
| GenAI Semantic Conventions | Full stable `gen_ai.*` attributes alongside legacy `openclaw.*` for dashboard compat |
| Tool Approval Tracking | `openclaw.tool.approval.requested/resolution/duration_ms` attributes (schema 1.1.0; renamed from `gen_ai.tool.approval.*`) |
| Cron & Sub-Agent Monitoring | Spans and metrics for cron jobs and sub-agent orchestration |
| Diagnostic Integration | Token/cost data from `model.usage` events enriches spans via `onDiagnosticEvent` |

**Per-Tool Visibility:**
- Individual `execute_tool {name}` spans per GenAI semconv
- Tool execution time via `before_tool_call` → `after_tool_call`
- Result size (characters), input preview
- Error tracking per tool with `error.type`
- Tool approval requested/resolution/duration

**Request Lifecycle:**
- Full message → response tracing with connected parent-child spans
- Session context propagation via TraceContextStore
- Agent turn duration with token breakdown from diagnostics
- Dispatch prepare/reply phase tracking

### Plugin Lifecycle

OpenClaw has two hook registration moments, and the plugin uses both at the right phase:

| Phase | Runs | What the plugin does |
|---|---|---|
| `register()` | Synchronous, before the gateway accepts traffic | Registers **all V3 typed hooks** via `api.on()` (see list below), plus event-stream hooks (`command:*`, `gateway:startup`), the `otel-observability.status` RPC, the `otel` CLI command, the background service, and the optional `otel_status` agent tool. Hooks receive a **lazy telemetry getter** (`() => telemetry`) so they can be wired before the OTel runtime exists. |

<details>
<summary>Typed hooks registered in <code>register()</code></summary>

**Lifecycle hooks:** `message_received`, `session_start`, `session_end`, `before_model_resolve`, `before_prompt_build`, `llm_input`, `llm_output`, `model_call_started`, `model_call_ended`, `before_dispatch`, `reply_dispatch`, `before_tool_call`, `after_tool_call`, `tool_approval_resolution`, `tool_result_persist`, `message_sent`, `before_agent_finalize`, `agent_end`, `before_reset`

**Orchestration hooks:** cron hooks (`cron_change`, `cron_execution`, `cron_error`), subagent hooks (`subagent_spawn`, `subagent_ended`)

</details>
| `start()` | Async, after the gateway is ready | Calls `initTelemetry()` to build the `TracerProvider`/`MeterProvider` and register them globally, initializes the OTLP log export pipeline, conditionally initializes OpenLLMetry wraps when `traces` is on, and subscribes to OpenClaw diagnostic events (`model.usage`, `log.record`) for cost/token data and log forwarding. |
| `stop()` | Async, on gateway reload/shutdown | Clears the stale-session sweeper `setInterval`, unsubscribes from diagnostics, shuts down the log pipeline, and calls `telemetry.shutdown()` to flush exporters. |

**Why this matters:** OpenClaw snapshots typed hooks at registration time. If hooks are registered from `start()` instead of `register()`, the gateway never sees them and **hooks register but never fire**. PR #6 (see [ISI-515](https://github.com/henrikrexed/openclaw-observability-plugin/pull/6)) moved them back to `register()` and introduced the lazy getter so handlers no-op cleanly during the brief `register()` → `start()` window.

### Installation

#### Option 1 — npm (recommended)

Install the plugin from npm. This is the path that the [openclaw-operator](https://github.com/henrikrexed/openclaw-operator) uses via `OpenClawInstance.spec.plugins`, and the recommended path for production.

```bash
npm install @henrikrexed/openclaw-otel-observability
```

Then add it to your `openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["./node_modules/@henrikrexed/openclaw-otel-observability"]
    },
    "entries": {
      "otel-observability": {
        "enabled": true
      }
    }
  }
}
```

For the operator (Kubernetes), reference the package directly:

```yaml
apiVersion: openclaw.io/v1alpha1
kind: OpenClawInstance
spec:
  plugins:
    - name: "@henrikrexed/openclaw-otel-observability"
      version: "^0.3.1"
```

Clear the jiti cache and restart the gateway:

```bash
rm -rf /tmp/jiti
systemctl --user restart openclaw-gateway
```

#### Option 2 — Local development (clone)

For contributing or running an unreleased build:

1. Clone this repository:
   ```bash
   git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
   ```

2. Add to your `openclaw.json` pointing at the clone path:
   ```json
   {
     "plugins": {
       "load": {
         "paths": ["/path/to/openclaw-observability-plugin"]
       },
       "entries": {
         "otel-observability": {
           "enabled": true,
           "hooks": {
             "allowConversationAccess": true
           }
         }
       }
     }
   }
   ```

   > **Required for OpenClaw ≥ 2026.4.23.** The runtime silently blocks the conversation typed hooks (`before_model_resolve`, `llm_input`, `llm_output`, `before_agent_finalize`, `agent_end`, `before_agent_reply`, `before_agent_run`) for non-bundled (path-loaded) plugins unless `hooks.allowConversationAccess: true` is set on the entry. Without it, the registration banners still print but `openclaw.request` / `openclaw.agent.turn` spans never reach your backend. See [Troubleshooting → Hooks register but never fire](#hooks-register-but-never-fire) and [github issue #20](https://github.com/henrikrexed/openclaw-observability-plugin/issues/20).

3. Clear cache and restart:
   ```bash
   rm -rf /tmp/jiti
   systemctl --user restart openclaw-gateway
   ```

### Validate your first trace

Send a message that triggers at least one tool call and check Gateway logs for the lifecycle markers:

```bash
journalctl --user -u openclaw-gateway -f | grep -E '\[otel\]'
```

You should see, in this order:

```
[otel] Registered message_received hook (via api.on)
[otel] Registered before_model_resolve hook (via api.on)
[otel] Registered before_prompt_build hook (via api.on)
[otel] Registered model_call_started hook (via api.on)
[otel] Registered before_tool_call hook (via api.on)
[otel] Registered tool_result_persist hook (via api.on)
[otel] Registered agent_end hook (via api.on)
[otel] Registered session_start hook (via api.on)
[otel] Registered command event hooks (via api.registerHook)
[otel] Registered gateway:startup hook (via api.registerHook)
[otel] Starting OpenTelemetry observability...
[otel] Telemetry runtime initialized
[otel] ✅ Log export pipeline initialized
[otel] ✅ Observability pipeline active
[otel]   Traces=true Metrics=true Logs=true
[otel]   Endpoint=http://localhost:4318 (http)
```

> **Hook migration (v0.2.0, ISI-730).** The plugin migrated off the legacy
> `before_agent_start` hook. The agent turn span is now started in
> `before_model_resolve` and enriched in `before_prompt_build`. This requires
> OpenClaw ≥ 2026.4.21. Pin to `0.1.x` if you need the legacy path.

Then, on the next inbound message, the debug log confirms hooks are live:

```
[otel] Root span started for session=<sessionKey>
[otel] Agent turn span started: agent=<agentId>, session=<sessionKey>
```

In your backend, look for an `openclaw.request` span with at least one `openclaw.agent.turn` child. A healthy trace has `openclaw.request` → `openclaw.agent.turn` → one or more `tool.*` children.

---

## Comparing the Two Approaches

| Feature | Official Plugin | Custom Plugin |
|---------|-----------------|---------------|
| Token metrics | Per model | Per session + model + cache |
| Cost tracking | Yes | Yes (from diagnostics) |
| Gateway health | Webhooks, queues, sessions | Not focused |
| Session state | State transitions | Long-lived session spans |
| **Tool call tracing** | No | Individual tool spans with timing |
| **Request lifecycle** | No | Full request → response connected |
| **Connected traces** | Separate spans | Parent-child hierarchy |
| **Model call spans** | No | `chat {model}` with GenAI semconv |
| **Tool approval** | No | Approval workflow tracking |
| **Log export** | Basic OTLP | OTLP with filtering + trace correlation |
| **Security detection** | No | Prompt injection, dangerous commands |
| **Cron monitoring** | No | Cron change/execution/error spans |
| **Sub-agent tracking** | No | Spawn/duration/ended spans |
| Setup complexity | Config only | Plugin installation |

---

## Backend Examples

### Dynatrace (Direct)

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://{env-id}.live.dynatrace.com/api/v2/otlp",
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

### Grafana Cloud

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otlp-gateway-{region}.grafana.net/otlp",
      "headers": {
        "Authorization": "Basic {base64-credentials}"
      },
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true
    }
  }
}
```

### Local OTel Collector

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

---

## Configuration Reference

### Official Plugin Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `diagnostics.enabled` | boolean | false | Enable diagnostics system |
| `diagnostics.otel.enabled` | boolean | false | Enable OTel export |
| `diagnostics.otel.endpoint` | string | — | OTLP endpoint URL |
| `diagnostics.otel.protocol` | string | "http/protobuf" | Protocol |
| `diagnostics.otel.headers` | object | — | Custom headers |
| `diagnostics.otel.serviceName` | string | "openclaw" | Service name |
| `diagnostics.otel.traces` | boolean | true | Enable traces |
| `diagnostics.otel.metrics` | boolean | true | Enable metrics |
| `diagnostics.otel.logs` | boolean | false | Enable logs |
| `diagnostics.otel.sampleRate` | number | (unset) | Head-based trace sampling rate, 0.0–1.0. Wraps `TraceIdRatioBasedSampler` in `ParentBasedSampler` so child spans inherit the root decision. Omit (or use `1.0`) to keep all traces. |

### Custom Plugin Options

> **Important:** Do NOT add a `config` block inside the plugin entry — OpenClaw's plugin framework rejects unknown properties. The plugin reads its configuration from the `diagnostics.otel` section instead.

The following settings are controlled via the `diagnostics.otel` config block:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | `http://localhost:4318` | OTLP endpoint URL |
| `serviceName` | string | `openclaw-gateway` | Service name |
| `protocol` | string | `http/protobuf` | OTLP protocol (`http` or `grpc`) |
| `traces` | boolean | true | Enable traces |
| `metrics` | boolean | true | Enable metrics |
| `logs` | boolean | true | Enable OTLP log export via diagnostic events |
| `captureContent` | boolean | false | Capture LLM prompt/completion text (privacy-sensitive) |
| `metricsIntervalMs` | number | 30000 | Metric export interval in milliseconds |

### Log Pipeline Configuration

The log export pipeline supports filtering and exclusion rules via the `logConfig` block:

```json
{
  "logConfig": {
    "enabled": true,
    "excludeLevels": ["debug", "trace"],
    "excludeLoggers": ["noisy-module"],
    "excludeMessagePatterns": ["health check", "/ping/i"],
    "filters": [
      { "field": "logger", "pattern": "internal.", "action": "exclude" }
    ]
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `enabled` | boolean | Enable log pipeline (default: true) |
| `excludeLevels` | string[] | Severity levels to exclude (e.g., `["debug", "trace"]`) |
| `excludeLoggers` | string[] | Logger names to exclude (case-insensitive substring match) |
| `excludeMessagePatterns` | (string\|RegExp)[] | Message patterns to exclude |
| `filters` | FilterRule[] | Advanced filter rules with `field`, `pattern`, `action` |

---

## Documentation

- [Getting Started](./docs/getting-started.md) — Setup guide
- [Configuration](./docs/configuration.md) — All options
- [Architecture](./docs/architecture.md) — How it works
- [Migration V2 → V3](./docs/migration-v2-to-v3.md) — Upgrade guide
- [Limitations](./docs/limitations.md) — Known constraints
- [Backends](./docs/backends/) — Backend-specific guides

---

## Optional: Kernel-Level Security with Tetragon

For **defense in depth**, add [Tetragon](https://tetragon.io) eBPF-based monitoring. While the plugins above capture application-level telemetry, Tetragon sees what happens at the kernel level — file access, process execution, network connections, and privilege changes.

### Why Tetragon?

- **Tamper-proof**: Even a compromised agent can't hide its kernel-level actions
- **Sensitive file detection**: Alert when `.env`, SSH keys, or credentials are accessed
- **Dangerous command detection**: Catch `rm`, `curl | sh`, `chmod 777`, etc.
- **Privilege escalation**: Detect `setuid`/`setgid` attempts
- **Supply chain defense**: Monitor npm/pip installs for malicious packages
- **Persistence detection**: Catch HEARTBEAT.md/SOUL.md tampering
- **Network exfiltration**: Detect DNS/HTTP data exfiltration attempts
- **Obfuscation detection**: Flag base64/encoding tool usage
- **Git credential protection**: Monitor git operations and credential access

### TracingPolicy Coverage (11 Policies)

| # | Policy | Threat | References |
|---|--------|--------|------------|
| 01 | `process-exec` | All process execution | General visibility |
| 02 | `sensitive-files` | Credential/file theft | SSH, AWS, Kube configs |
| 04 | `privilege-escalation` | Root access attempts | setuid/setgid/sudo |
| 05 | `dangerous-commands` | Destructive/exfil commands | rm, curl, nc, xmrig |
| 06 | `kernel-modules` | Rootkit loading | init_module, insmod |
| 07 | `prompt-injection-shell` | Injected shell commands | curl\|bash, reverse shells |
| 08 | `network-exfiltration` | DNS/HTTP data exfil | CVE-2025-55284, Agent Commander C2 |
| 09 | `supply-chain` | Malicious packages | LiteLLM 1.82.8, Trivy compromise |
| 10 | `persistence-tampering` | Config/memory tampering | HEARTBEAT.md backdoor, Skill overwrite |
| 11 | `obfuscation-encoding` | Encoded payloads | Unicode steganography, base64 |
| 12 | `git-operations` | Git credential theft | Force push, .git-credentials |

Policies are in [`tetragon-policies/`](./tetragon-policies/) with install instructions.

```bash
# Install Tetragon
curl -LO https://github.com/cilium/tetragon/releases/latest/download/tetragon-v1.6.0-amd64.tar.gz
tar -xzf tetragon-v1.6.0-amd64.tar.gz && cd tetragon-v1.6.0-amd64
sudo ./install.sh

# Create OpenClaw policies directory
sudo mkdir -p /etc/tetragon/tetragon.tp.d/openclaw

# Add policies (see docs/security/tetragon.md for full examples)
# Start Tetragon
sudo systemctl enable --now tetragon
```

Tetragon events are exported to `/var/log/tetragon/tetragon.log` and can be ingested by the OTel Collector using the `filelog` receiver.

### Complete Observability Stack

| Layer | Source | What It Shows |
|-------|--------|---------------|
| **Application** | Custom Plugin | Tool calls, tokens, request flow |
| **Gateway** | Official Plugin | Session health, queues, costs |
| **Kernel** | Tetragon | System calls, file access, network |

See [Security: Tetragon](./docs/security/tetragon.md) for full installation and configuration guide.

---

## Troubleshooting

### Hooks register but never fire

**Symptom.** The plugin logs `[otel] ✅ Observability pipeline active` at gateway startup and prints all the `[otel] Registered ... hook (via api.on)` banners, but no `openclaw.request` or `openclaw.agent.turn` spans ever reach your backend — even after you send messages that clearly invoke tools. The plugin's metrics keep exporting every 30 s with the right resource attributes but every counter stays at `Value: 0.000000` with `openclaw.idle: Bool(true)` (the idle-keepalive heartbeat).

There are two distinct causes that produce the same outward symptom. Check both.

#### Cause A — `hooks.allowConversationAccess` not set (OpenClaw ≥ 2026.4.23)

OpenClaw 2026.4.23 introduced a typed-hook policy gate. The runtime silently drops registrations for the **conversation hooks** — `before_model_resolve`, `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_finalize`, `agent_end`, `before_agent_run` — when the plugin is **non-bundled** (loaded via `plugins.load.paths`, the install path documented in this repo) and the entry does not explicitly opt in. `api.on(...)` returns silently, so the plugin's `[otel] Registered ... hook` banner still prints, but the handler is never wired into the typed-hook registry. The gateway log records the block as a `pluginDiagnostics` warning:

```
typed hook "agent_end" blocked because non-bundled plugins must set
plugins.entries.otel-observability.hooks.allowConversationAccess=true
```

(One line per blocked hook. Look for it under `openclaw plugins list --diagnostics` or in `~/.openclaw/logs/gateway.log`.)

**Fix.** Set the policy on the plugin entry:

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

Restart the gateway after editing. This setting was added to OpenClaw's plugin-config schema in 2026.4.23 alongside the gate; if you saw `Unrecognized key: "allowConversationAccess"` and a `Config auto-restored from last-known-good` rollback on first attempt, you were briefly on a build between [openclaw#71621](https://github.com/openclaw/openclaw/issues/71621) opening and its same-day fix — upgrade to any 2026.4.24+ release.

**Why this matters here.** The conversation hooks are exactly the ones that anchor the plugin's trace structure: `before_model_resolve` opens the agent turn span, `llm_input`/`llm_output` produce the model-call span, and `agent_end` closes everything. Without them, only the standalone counters (`messagesReceived`, etc.) and the `message_received` root span survive — and even those usually go undetected because the agent never finishes the turn properly. Sibling plugins that **are** bundled in OpenClaw (e.g., `memory-lancedb-pro`) are not affected by the gate, which is why their `agent_end` handler still fires on the same turns.

This is the cause behind [github issue #20](https://github.com/henrikrexed/openclaw-observability-plugin/issues/20) and the most common report on `0.2.x`/`0.3.x` against OpenClaw 2026.4.23 or newer.

#### Cause B — Hooks registered from `start()` instead of `register()` (pre-PR #6)

Earlier builds registered typed hooks from inside the async `service.start()` phase. OpenClaw snapshots typed hooks at plugin registration time, ~30 s before `start()` runs, so the gateway never saw the listeners. See [ISI-515](https://github.com/henrikrexed/openclaw-observability-plugin/pull/6).

**Fix.** Upgrade to a build that includes PR #6 (any `0.2.x` or newer). Hooks are now registered synchronously in `register()` and resolve the telemetry runtime lazily.

#### How to confirm hooks are live

1. Check the gateway log for the registration lines emitted from `register()`:
   ```
   [otel] Registered message_received hook (via api.on)
   [otel] Registered before_model_resolve hook (via api.on)
   [otel] Registered before_prompt_build hook (via api.on)
   [otel] Registered tool_result_persist hook (via api.on)
   [otel] Registered agent_end hook (via api.on)
   [otel] Registered command event hooks (via api.registerHook)
   [otel] Registered gateway:startup hook (via api.registerHook)
   ```
   If these are **missing**, the plugin is not loaded — check `plugins.load.paths` in `openclaw.json` and clear `/tmp/jiti`. If they print but spans still never appear, jump to step 2.

2. Look for `pluginDiagnostics` warnings about blocked typed hooks. The presence of any
   `typed hook "<name>" blocked because non-bundled plugins must set ... allowConversationAccess=true`
   line is the deterministic signal for **Cause A** above. The registration banner and the block warning can both be present in the same boot — the banner only proves `api.on()` returned, not that the registration was accepted.

3. Send a real message through the pipeline and watch for the per-event debug lines (enable debug logging first):
   ```
   [otel] Root span started for session=<sessionKey>
   [otel] Agent turn span started: agent=<agentId>, session=<sessionKey>
   ```
   If only the `Root span started` line appears but never `Agent turn span started`, conversation hooks are blocked (Cause A). If neither appears on inbound `/v1/chat/completions` or channel messages, the gateway is not firing typed hooks for your event path (e.g., heartbeats and some internal events do not carry full session context).

4. Verify your OTLP endpoint is actually receiving data:
   ```bash
   curl -v http://localhost:4318/v1/traces
   ```

### Plugin not loaded at all

Check plugin discovery:

```bash
openclaw plugins list
```

Clear the jiti cache and restart:

```bash
rm -rf /tmp/jiti
systemctl --user restart openclaw-gateway
```

### Traces exported but not connected

The custom plugin requires messages to flow through the normal pipeline (`message_received` → `before_model_resolve` → `before_prompt_build` → tools → `agent_end`). Heartbeats and some internal events skip `message_received`, so those turns produce a standalone `openclaw.agent.turn` span without a parent `openclaw.request`. This is expected.

---

## Known Limitations

**Auto-instrumentation not possible:** OpenLLMetry/IITM breaks `@mariozechner/pi-ai` named exports due to ESM/CJS module isolation. All telemetry is captured via hooks, not direct SDK instrumentation.

See [Limitations](./docs/limitations.md) for details.

---

## License

Apache License 2.0 — see [LICENSE](./LICENSE) for the full text.
