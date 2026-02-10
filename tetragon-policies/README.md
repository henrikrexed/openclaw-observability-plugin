# Tetragon TracingPolicies for OpenClaw Security

Kernel-level security monitoring for OpenClaw using [Tetragon](https://tetragon.io/).

These policies complement the plugin's application-layer security detection:

| Layer | Tool | Detection | 
|-------|------|-----------|
| Application | Plugin (`security.ts`) | What the AI *intends* to do |
| Kernel | Tetragon (these policies) | What *actually happens* |

## Policies Overview

| # | Policy | Threat | Plugin Alignment |
|---|--------|--------|------------------|
| 01 | `process-exec.yaml` | All process execution | General visibility |
| 02 | `sensitive-files.yaml` | Credential theft | Detection 1: Sensitive File Access |
| 04 | `privilege-escalation.yaml` | Root access attempts | Detection 3: Dangerous Commands |
| 05 | `dangerous-commands.yaml` | Destructive/exfil commands | Detection 3: Dangerous Commands |
| 06 | `kernel-modules.yaml` | Rootkit loading | General security |
| 07 | `prompt-injection-shell.yaml` | Injected shell commands | Detection 2: Prompt Injection |

## Installation

```bash
# Copy policies to Tetragon config directory
sudo cp *.yaml /etc/tetragon/tetragon.tp.d/openclaw/

# Restart Tetragon to load policies
sudo systemctl restart tetragon

# Verify policies loaded
sudo tetra tracingpolicy list
```

## Policy Details

### 01-process-exec.yaml
Basic process execution monitoring. Captures all commands spawned by Node.js.

### 02-sensitive-files.yaml
**Aligned with Plugin Detection 1: Sensitive File Access**

Monitors `security_file_open` for:
- SSH keys (`.ssh/id_*`, `authorized_keys`)
- Cloud credentials (`.aws/credentials`, `.kube/config`, `.docker/config.json`)
- Environment files (`.env`, `.env.local`, `.env.production`)
- OpenClaw config (`openclaw.json`)
- Database credentials (`.pgpass`, `.my.cnf`, `.netrc`)

### 04-privilege-escalation.yaml
Detects attempts to gain elevated privileges:
- `setuid` calls
- Capability changes
- `sudo` / `su` execution

### 05-dangerous-commands.yaml
**Aligned with Plugin Detection 3: Dangerous Commands**

Monitors `sys_execve` for:
- **Exfiltration:** curl, wget, nc/netcat, socat
- **Destruction:** rm, dd, mkfs, shred
- **Permission abuse:** chmod, chown
- **Crypto mining:** xmrig, minerd, cpuminer
- **Persistence:** crontab, at
- **Privilege escalation:** sudo, su, pkexec
- **Container escape:** nsenter, unshare

### 06-kernel-modules.yaml
Detects kernel module loading (rootkit prevention):
- `init_module` / `finit_module` syscalls
- `insmod` / `modprobe` execution

### 07-prompt-injection-shell.yaml
**Aligned with Plugin Detection 2: Prompt Injection**

Catches injection attacks that reach shell execution:
- Piped commands (`curl | bash`)
- Base64 decode + execute (obfuscation)
- Reverse shell patterns (`/dev/tcp/`, `nc -e`)
- Silent download (`curl -s`, `wget -q`)

## Event Flow

```
┌──────────────────┐
│ OpenClaw Gateway │
│   (Node.js)      │
└────────┬─────────┘
         │ Tool execution
         ▼
┌──────────────────┐     ┌──────────────────┐
│  Plugin Hooks    │     │    Tetragon      │
│  (Application)   │     │    (Kernel)      │
└────────┬─────────┘     └────────┬─────────┘
         │                        │
         │ OTel spans/metrics     │ JSON events
         │                        │
         ▼                        ▼
┌──────────────────────────────────────────┐
│          OTel Collector                  │
│  ┌─────────────┐  ┌──────────────────┐   │
│  │ OTLP input  │  │ Filelog input    │   │
│  │ (traces)    │  │ (tetragon.log)   │   │
│  └─────────────┘  └──────────────────┘   │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│              Dynatrace                   │
│  ┌─────────────┐  ┌──────────────────┐   │
│  │   Traces    │  │      Logs        │   │
│  │  (spans)    │  │  (kernel events) │   │
│  └─────────────┘  └──────────────────┘   │
└──────────────────────────────────────────┘
```

## Cross-Correlation Example

When an attack occurs, you can correlate plugin spans with Tetragon events:

**Attack scenario:** Prompt injection → read credentials → exfiltrate

1. **Plugin span:** `openclaw.request` with `security.event.detection: prompt_injection`
2. **Plugin span:** `tool.Read` with `security.event.detection: sensitive_file_access`
3. **Tetragon event:** `security_file_open` on `/home/user/.env`
4. **Plugin span:** `tool.exec` with `security.event.detection: dangerous_command`
5. **Tetragon event:** `sys_execve` of `/usr/bin/curl`

In Dynatrace, filter by `openclaw.session.key` to see the full attack chain.

## Tuning

If policies generate too much noise:

1. **Add binary filters** — Only monitor specific Node.js paths
2. **Use selectors** — Narrow down to specific file paths or commands
3. **Disable verbose policies** — Remove `01-process-exec.yaml` in production

## See Also

- [Plugin Security Detection](../docs/security/detection.md) — Application-layer detection
- [Tetragon Documentation](../docs/security/tetragon.md) — Full setup guide
