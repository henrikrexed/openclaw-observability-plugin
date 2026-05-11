# Privacy: `captureContent`

The `captureContent` plugin option controls whether prompt, completion, and tool content text is recorded on spans. It accepts either:

- a **single boolean** — `true` turns every category on, `false` turns every category off (legacy shape), or
- a granular **`ContentCapturePolicy`** object with the per-category flags `inputMessages`, `outputMessages`, `toolInputs`, `toolOutputs`, `systemPrompt` (ISI-1000).

Default: every flag is `false` (privacy-first).

## What `captureContent` controls

`captureContent` now controls **two surfaces**: the Traceloop LLM-client spans and the plugin's own hook-surface spans. The granular policy lets you turn each category on or off independently.

### Traceloop LLM-client spans (via the preload)

Traceloop instrumentations (`@traceloop/instrumentation-anthropic`, `@traceloop/instrumentation-openai`) accept a single `traceContent` boolean. The plugin derives it as `inputMessages || outputMessages || systemPrompt` — the three categories that map to prompt/completion text. When the derived boolean is `true`, Traceloop LLM-client spans include:

| Span attribute | Contents |
|----------------|----------|
| `gen_ai.prompt.N.role` | Role for message *N* (e.g., `user`, `assistant`, `system`). |
| `gen_ai.prompt.N.content` | **Full message text** for message *N*. |
| `gen_ai.completion.N.role` | Role of the model's response. |
| `gen_ai.completion.N.content` | **Full generated text** from the model. |

Token counts, model identifiers, latency, cost, and error state are recorded regardless of the flag — only the prompt/completion text is gated.

> ⚠️ **Traceloop is all-or-nothing across directions.** Traceloop exposes a single `traceContent` boolean and does not distinguish input from output. The plugin's policy unifies the three LLM-content categories with `inputMessages || outputMessages || systemPrompt`, so enabling **any one** of them flips Traceloop on and Traceloop then records **both** `gen_ai.prompt.*.content` and `gen_ai.completion.*.content` on LLM-client spans. Concretely, `{ inputMessages: true }` does not record prompts only — completions land on the LLM-client span too. If you need true one-direction capture, leave every LLM-content flag (`inputMessages`, `outputMessages`, `systemPrompt`) at `false` and rely on the plugin's per-flag-gated `openclaw.content.*` attributes on the hook-surface spans, which **do** honor the requested direction in isolation.

### Plugin hook-surface spans (`openclaw.content.*`)

Each policy flag also gates one or more `openclaw.content.*` attributes on the plugin's own spans:

| Flag | Span attribute(s) | What is captured |
|------|--------------------|-------------------|
| `inputMessages` | `openclaw.content.input_message` on `openclaw.request`; `openclaw.content.prompt` / `openclaw.content.messages` on `openclaw.agent.turn` | Inbound user message text + the prompt and message history passed to the LLM |
| `outputMessages` | `openclaw.content.output_message` on `openclaw.message.sent` | Outbound assistant reply text |
| `toolInputs` | `openclaw.content.tool_input` on `execute_tool <tool>` | Full tool-call input arguments (JSON-stringified) |
| `toolOutputs` | `openclaw.content.tool_output` on `execute_tool <tool>` | Tool-call result text (text parts only) |
| `systemPrompt` | `openclaw.content.system_prompt` on `openclaw.agent.turn` | System prompt text |

All `openclaw.content.*` attributes are truncated to **8192 UTF-16 code units** per value (a JavaScript string `.length` measurement, not bytes — CJK and emoji content can occupy 2–4 bytes per code point on the wire). Larger payloads get an inline `…(truncated, N more chars)` marker, and the cut point is adjusted by one code unit when it would otherwise split a surrogate pair so the prefix stays valid UTF-16.

## What `captureContent` does **not** affect

`captureContent` only gates the prompt/completion/tool content attributes above. Independent of the policy, hook spans still emit metadata such as:

- `openclaw.request` — session/channel identifiers, no message body
- `openclaw.agent.turn` — token counts, model, duration
- `execute_tool *` — tool name, duration, `openclaw.tool.input_preview` (1 KB truncated preview), result chars/parts counts
- `openclaw.message.sent` — channel, recipient, char count

The `openclaw.tool.input_preview` preview attribute is **always** emitted, independent of `toolInputs`. It is a 1 KB capped preview meant for debugging and security correlation; the granular `openclaw.content.tool_input` is the larger 8192-code-unit capture that the policy gates.

## Gateway-launch setting (not hot-reloadable)

`captureContent` is read by the ESM preload (`instrumentation/preload.mjs`) at gateway launch time, **before** OpenClaw parses plugin config. The Traceloop instrumentations are constructed once, at preload, and the `traceContent` option is fixed for the lifetime of the process.

Consequence: changing `captureContent` in `openclaw.json` mid-run has no effect until the next gateway restart.

### Bridge mechanism

The preload reads **two** environment variables and prefers the granular one:

- `OPENCLAW_OTEL_CONTENT_POLICY` — JSON encoding of the `ContentCapturePolicy` object. When set and parseable, Traceloop's `traceContent` is derived as `inputMessages || outputMessages || systemPrompt`. **This var takes precedence.**
- `OPENCLAW_OTEL_CAPTURE_CONTENT` — legacy single-boolean flag. The string value must be exactly `true` to enable; anything else (including `1`, `yes`, `True`, unset) resolves to `false`. Strict match keeps the privacy default unambiguous.

The plugin's `start()` phase re-exports both env vars from the parsed plugin config so subprocesses inherit the intended values, and warns if the preload-resolved `traceContent` does not match the policy.

### How to enable

#### All categories on (legacy boolean)

```bash
OPENCLAW_OTEL_CAPTURE_CONTENT=true \
  NODE_OPTIONS="--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs" \
  openclaw gateway start
```

#### Granular (recommended)

Capture only specific categories — e.g., tool I/O for debugging without recording user prompts:

```bash
OPENCLAW_OTEL_CONTENT_POLICY='{"toolInputs":true,"toolOutputs":true}' \
  NODE_OPTIONS="--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs" \
  openclaw gateway start
```

Via systemd:

```ini
[Service]
Environment=OPENCLAW_OTEL_CONTENT_POLICY={"toolInputs":true,"toolOutputs":true}
Environment=NODE_OPTIONS=--import /path/to/openclaw-observability-plugin/instrumentation/preload.mjs
ExecStart=/usr/bin/openclaw gateway start
```

Plugin config for parity (so the `otel_status` tool and the mismatch warning agree):

```json
{
  "plugins": {
    "entries": {
      "otel-observability": {
        "enabled": true,
        "config": {
          "captureContent": {
            "toolInputs": true,
            "toolOutputs": true
          }
        }
      }
    }
  }
}
```

## When to enable content capture

Enabling any `captureContent` flag is a deliberate tradeoff. The granular policy lets you trade off per-category instead of all-or-nothing: for example, enabling only `toolInputs`/`toolOutputs` records tool-call I/O for debugging while leaving user prompts and assistant replies out of spans. Useful when:

- You are debugging prompt engineering and need to see actual prompt/completion pairs alongside token counts.
- You operate the OTLP backend and downstream storage yourself.
- You have reviewed the backend's retention and access controls against the sensitivity of the prompts your agents handle.

Avoid enabling content capture when:

- Users can pass arbitrary data into the agent (free-form chat, uploaded documents, customer PII).
- Your backend retention is long, retention controls are weak, or access is broad.
- You have regulatory obligations around prompt/completion text (HIPAA, PCI, GDPR right-to-erasure).

## Sensitive data reaching spans

Whenever a flag is `true`, the following can land in span storage:

- `inputMessages` / `systemPrompt`: user chat input (including PII, credentials, proprietary data), document contents summarized into prompts, system prompts that may encode prompt-engineering IP.
- `outputMessages`: assistant replies, which can mirror or reveal sensitive input data.
- `toolInputs`: tool-call arguments — file paths, command lines, query strings, API request bodies. Note that even with `toolInputs: false`, the smaller `openclaw.tool.input_preview` attribute is still emitted.
- `toolOutputs`: tool-call results fed back to the model — file contents from `tool.Read`, shell command output, database query results.

The plugin does **not** scrub Traceloop or `openclaw.content.*` span attributes before export. If you need redaction, apply it at the OTel Collector (`transform` / `attributes` processors) or at the backend.

## Complementary detections

Whether or not you capture content, the real-time [detection module](./detection.md) runs on the hook-surface path and flags:

- Sensitive file access (`tool.Read` on `.env`, SSH keys, cloud creds)
- Dangerous command execution
- Prompt-injection patterns on inbound messages

These alerts work without content capture — they operate on paths, command strings, and matched patterns, and emit only the patterns and a short preview on the span.

## See also

- [Real-Time Detection](./detection.md) — application-layer security events
- [Configuration](../configuration.md#capturecontent-gateway-launch-setting) — plugin config reference
- [github issue #15](https://github.com/henrikrexed/openclaw-observability-plugin/issues/15) — original report motivating this wiring
