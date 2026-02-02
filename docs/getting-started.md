# Getting Started

Get OpenTelemetry observability for your OpenClaw agent in 5 minutes.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- Node.js 18+ (comes with OpenClaw)
- An OpenTelemetry-compatible backend (Dynatrace, Grafana, etc.) — or use the included OTel Collector

## Step 1: Clone and Install

```bash
git clone https://github.com/henrikrexed/openclaw-observability-plugin.git
cd openclaw-observability-plugin
npm install
```

## Step 2: Install into OpenClaw

=== "Production install"

    ```bash
    openclaw plugins install .
    ```

    This copies the plugin into `~/.openclaw/extensions/otel-observability/`.

=== "Development (linked)"

    ```bash
    openclaw plugins install -l .
    ```

    This symlinks the plugin — changes you make are reflected on gateway restart.

## Step 3: Set Up the OTel Collector

You have two options: use an OTel Collector (recommended) or export directly to your backend.

=== "OTel Collector (recommended)"

    The repo includes a Docker Compose setup with a pre-configured collector.

    ```bash
    # Set your backend credentials (example: Dynatrace)
    export DYNATRACE_ENDPOINT=https://<YOUR_ENV>.live.dynatrace.com/api/v2/otlp
    export DYNATRACE_API_TOKEN=<YOUR_ACCESS_TOKEN>

    # Start the collector
    docker compose up -d
    ```

    The collector listens on:

    - `localhost:4317` — OTLP/gRPC
    - `localhost:4318` — OTLP/HTTP

    !!! tip "Why use a collector?"
        The OTel Collector gives you batching, retry, filtering, and fan-out to multiple backends. It also keeps your backend credentials off the OpenClaw machine.

=== "Direct export"

    Skip the collector and point the plugin directly at your backend. See [Backends](backends/index.md) for backend-specific URLs and auth.

## Step 4: Configure the Plugin

Add the plugin config to your OpenClaw configuration:

```bash
# Open your config
openclaw configure
```

Add the following under `plugins`:

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
          "traces": true,
          "metrics": true,
          "logs": true,
          "captureContent": false
        }
      }
    }
  }
}
```

!!! warning "Privacy: captureContent"
    When `captureContent` is `false` (default), the plugin does **not** record prompt or completion text in traces. This is important for privacy — LLM conversations may contain sensitive data. Only enable this in development or when you have appropriate data handling in place.

## Step 5: Process Management & Restart

The plugin is loaded at runtime via [jiti](https://github.com/unjs/jiti). **Code changes require a full process restart** — `SIGUSR1` hot-reload does not clear jiti's module cache.

### Plugin Load Path

Make sure your OpenClaw config (`~/.openclaw/openclaw.json`) includes the plugin path in `plugins.load.paths`:

```json
{
  "plugins": {
    "load": {
      "paths": [
        "/absolute/path/to/openclaw-observability-plugin"
      ]
    }
  }
}
```

!!! important "Use absolute paths"
    When OpenClaw runs as a background service, the working directory differs from your shell. Always use **absolute paths** for plugin load paths — relative paths will fail silently.

### Clearing the jiti Cache

After any plugin TypeScript change, clear the compilation cache before restarting:

=== "Linux / macOS"

    ```bash
    rm -rf /tmp/jiti
    ```

=== "Windows (PowerShell)"

    ```powershell
    Remove-Item -Recurse -Force "$env:TEMP\jiti" -ErrorAction SilentlyContinue
    ```

!!! warning "SIGUSR1 is NOT enough"
    `openclaw gateway restart` sends `SIGUSR1` which triggers a soft reload. This does **not** clear Node.js `require.cache` or jiti's compiled module cache. For plugin TypeScript changes to take effect, you must do a full process restart as described below.

---

### Linux (systemd)

OpenClaw installs a **systemd user service** by default when using `openclaw gateway start`.

#### Locate the Service Unit

```bash
# User-level service (most common)
cat ~/.config/systemd/user/openclaw-gateway.service

# Or system-level (if installed globally)
cat /etc/systemd/system/openclaw-gateway.service
```

#### Restart the Service

```bash
# Clear jiti cache first
rm -rf /tmp/jiti

# User-level service
systemctl --user restart openclaw-gateway

# Or system-level
sudo systemctl restart openclaw-gateway
```

#### Add Environment Variables

To pass environment variables to the gateway (e.g., for debugging):

```bash
# Edit the service override
systemctl --user edit openclaw-gateway
```

Add under `[Service]`:

```ini
[Service]
Environment="OTEL_LOG_LEVEL=debug"
```

Then reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart openclaw-gateway
```

#### Verify

```bash
# Check status
systemctl --user status openclaw-gateway

# Check logs for [otel] messages
journalctl --user -u openclaw-gateway --since "2 min ago" | grep "\[otel\]"
```

---

### macOS (launchd)

On macOS, OpenClaw may run as a **launchd user agent**. If you started it with `openclaw gateway start`, check for a plist file:

#### Locate the Launch Agent

```bash
# Check for OpenClaw plist
ls ~/Library/LaunchAgents/ | grep -i openclaw

# View the plist
cat ~/Library/LaunchAgents/com.openclaw.gateway.plist
```

#### Restart the Service

```bash
# Clear jiti cache
rm -rf /tmp/jiti

# Unload and reload the launch agent
launchctl unload ~/Library/LaunchAgents/com.openclaw.gateway.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.gateway.plist
```

Or if using a newer macOS with `launchctl bootstrap`:

```bash
rm -rf /tmp/jiti
launchctl kickstart -k gui/$(id -u)/com.openclaw.gateway
```

#### Add Environment Variables

Edit the plist file to add environment variables:

```bash
# Open in your editor
nano ~/Library/LaunchAgents/com.openclaw.gateway.plist
```

Add inside the top-level `<dict>`:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>OTEL_LOG_LEVEL</key>
    <string>debug</string>
</dict>
```

Then reload the agent.

#### Verify

```bash
# Check if running
launchctl list | grep openclaw

# Check logs (location depends on plist config)
tail -f /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep "\[otel\]"

# Or if stdout/stderr are redirected in the plist:
tail -f ~/Library/Logs/openclaw-gateway.log
```

---

### Windows

On Windows, OpenClaw may run as a background process or a Windows Service.

#### Running in the Foreground (PowerShell)

The simplest approach — run directly in a terminal:

```powershell
# Clear jiti cache
Remove-Item -Recurse -Force "$env:TEMP\jiti" -ErrorAction SilentlyContinue

# Start the gateway
openclaw gateway --port 18789
```

To set environment variables:

```powershell
$env:OTEL_LOG_LEVEL = "debug"
openclaw gateway --port 18789
```

#### Running as a Windows Service (NSSM)

If you've set up OpenClaw as a Windows Service using [NSSM](https://nssm.cc/) or similar:

```powershell
# Clear jiti cache
Remove-Item -Recurse -Force "$env:TEMP\jiti" -ErrorAction SilentlyContinue

# Restart the service
nssm restart openclaw-gateway

# Or via native service management
Restart-Service openclaw-gateway
```

#### Add Environment Variables (NSSM)

```powershell
nssm set openclaw-gateway AppEnvironmentExtra "OTEL_LOG_LEVEL=debug"
nssm restart openclaw-gateway
```

#### Running as a Scheduled Task

Alternatively, use Task Scheduler to start OpenClaw at login:

1. Open **Task Scheduler** → Create Task
2. **Trigger:** At log on
3. **Action:** Start a program
    - Program: `node`
    - Arguments: `C:\Users\<you>\AppData\Roaming\npm\node_modules\openclaw\dist\index.js gateway --port 18789`
4. **Settings:** Do not stop the task if it runs longer than...

To restart: stop the task and start it again.

#### Verify

```powershell
# Check the gateway log
Get-Content -Tail 20 "$env:TEMP\openclaw\openclaw-$(Get-Date -Format yyyy-MM-dd).log" | Select-String "\[otel\]"
```

---

### All Platforms: Expected Output

After a successful restart, you should see these log lines:

```
[otel] Starting OpenTelemetry observability...
[otel] Trace exporter → http://localhost:4318/v1/traces (http)
[otel] Metrics exporter → http://localhost:4318/v1/metrics (http, interval=30000ms)
[otel] Registered message_received hook (via api.on)
[otel] Registered before_agent_start hook (via api.on)
[otel] Registered tool_result_persist hook (via api.on)
[otel] Registered agent_end hook (via api.on)
[otel] ✅ Observability pipeline active
```

## Step 6: Restart the Gateway

If you're running OpenClaw **directly in a terminal** (not as a service):

```bash
# Clear jiti cache first
rm -rf /tmp/jiti   # Linux/macOS

# Then restart
openclaw gateway restart
```

## Step 7: Verify

Check that the plugin is running:

```bash
openclaw otel
```

Expected output:

```
🔭 OpenTelemetry Observability Plugin
────────────────────────────────────────
  Endpoint:        http://localhost:4318
  Protocol:        http
  Service:         openclaw-gateway
  Traces:          ✅
  Metrics:         ✅
  Logs:            ✅
  Capture content: ❌
  Initialized:     ✅
```

You can also check from within a conversation using the agent tool:

```
> Check the OTel observability status
```

The agent will call the `otel_status` tool and report the plugin state.

## Step 8: Send Some Messages

Now just use your OpenClaw agent normally. Every LLM call, tool execution, and command will be traced and metricked automatically.

Check your backend:

- **Dynatrace** → Services → `openclaw-gateway` → Traces
- **Grafana** → Explore → Tempo → Search for `openclaw-gateway`
- **Collector debug** → `docker compose logs -f` shows exported spans

## What's Next?

- [Configuration Reference](configuration.md) — all options explained
- [Traces Reference](telemetry/traces.md) — what spans are generated
- [Metrics Reference](telemetry/metrics.md) — all exported metrics
- [Dynatrace Setup](backends/dynatrace.md) — detailed Dynatrace integration
