# Limitations

## No Per-LLM-Call Auto-Instrumentation

The plugin cannot produce individual spans for each LLM API call (e.g., `anthropic.chat` or `openai.chat.completions.create`). Instead, token usage and model info are captured per **agent turn** — aggregated across all LLM calls within a single turn.

### What You Get vs. What's Missing

| Capability | Status | Details |
|---|---|---|
| Token usage per agent turn | ✅ | `gen_ai.usage.input_tokens`, `.output_tokens`, `.total_tokens` |
| Model name | ✅ | `gen_ai.response.model` on agent turn span |
| Cache token tracking | ✅ | `cacheRead` and `cacheWrite` included in totals |
| Agent turn duration | ✅ | Full turn timing as span duration + histogram |
| Tool execution spans | ✅ | Individual `tool.*` spans per tool call |
| Connected traces | ✅ | `openclaw.request` → `openclaw.agent.turn` → `tool.*` |
| Per-LLM-call spans | ❌ | No individual `anthropic.chat` spans |
| Per-LLM-call latency | ❌ | Only full turn duration, not individual call timing |
| Multiple LLM calls per turn | ⚠️ | Token counts summed; can't distinguish individual calls |
| Request/response content | ❌ | No prompt/completion text capture on LLM calls |
| Standard GenAI dashboards | ⚠️ | Custom dashboards needed (not standard `gen_ai.*` span shape) |

### Why?

We attempted three approaches to enable auto-instrumentation. All failed due to OpenClaw's ESM module architecture.

#### Approach 1: Plugin-Side SDK Patching

OpenClaw's plugin loader uses **jiti** (a CJS-compatible TypeScript loader). The `@anthropic-ai/sdk` package has **dual entry points**:

- **ESM:** `@anthropic-ai/sdk/index.mjs` — loaded by `@mariozechner/pi-ai` (OpenClaw's LLM provider) via `import`
- **CJS:** `@anthropic-ai/sdk/index.js` — loaded by the plugin via `createRequire()`

These are completely separate module instances with different prototypes. Patching the CJS version has zero effect on the ESM instance that actually handles LLM calls.

Additionally, jiti blocks native `import()` calls (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), making it impossible to access the ESM instance from plugin code.

#### Approach 2: NODE_OPTIONS Preload with IITM

The standard OpenTelemetry approach for ESM instrumentation:

```bash
NODE_OPTIONS="--import ./instrumentation/preload.mjs"
```

This uses [import-in-the-middle](https://github.com/DataDog/import-in-the-middle) (IITM) to register ESM loader hooks that intercept module imports. However, IITM intercepts **all** ESM modules globally — not just the targeted ones.

When IITM wraps `@mariozechner/pi-ai`, it breaks the module's named exports:

```
SyntaxError: The requested module '@mariozechner/pi-ai' does not
provide an export named 'getEnvApiKey'
```

This crash-loops the gateway on startup.

#### Approach 3: Manual register() with IITM

Using `register()` from `node:module` to manually install IITM loader hooks produces the same crash — the hooks are global and cannot selectively skip modules.

### Environment

- Node.js v22.22.0
- `@opentelemetry/instrumentation` 0.203.0
- `import-in-the-middle` 1.15.0
- `@anthropic-ai/sdk` 0.71.2

### Path Forward

A [feature request](https://github.com/openclaw/openclaw/issues) has been filed on the OpenClaw project suggesting:

1. **LLM call events on the plugin API** — emit `llm_call_start`/`llm_call_end` events so plugins can create per-call spans without monkey-patching
2. **Built-in OTel hook in pi-ai** — a callback around the actual SDK call in the provider layer
3. **Fix IITM compatibility** — investigate why IITM breaks `@mariozechner/pi-ai` exports
4. **Native OTel support** — bundle instrumentation directly in OpenClaw where it can control the loader lifecycle

Until one of these is implemented, the hook-based approach provides solid observability for token tracking, tool monitoring, and request tracing — just without per-LLM-call granularity.
