# Changelog

All notable changes to the `@henrikrexed/openclaw-otel-observability` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **OTel GenAI / code semconv 2026-04 alignment — dual-emit window (ISI-994).**
  Schema version bumped to `1.2.0` (resource attribute
  `openclaw.schema.version`). Spans and metrics that previously emitted
  deprecated attribute keys now also emit the stable replacements alongside
  the legacy ones for one minor release:
  - `gen_ai.system` → dual-emit with `gen_ai.provider.name` (LLM client span
    from `llm_input`, agent-turn enrichment in
    `enrichSpanWithUsage`, and the `model.usage` metric attribute set in
    `diagnostics.ts`). `model_call_started` already dual-emitted.
  - `code.function` + `code.namespace` → dual-emit with
    `code.function.name` (fully-qualified `${namespace}.${function}`) plus
    `code.file.path` at every hook-span emit site. Centralised in the new
    `codeAttrs(funcName)` helper in `src/hooks.ts`. Per-site source line
    numbers are intentionally not emitted (they would rot on every edit);
    consumers needing precise emit locations should rely on the function
    name + file path pair.
  - `gen_ai.usage.cache_read_tokens` / `gen_ai.usage.cache_write_tokens`
    → dual-emit with the stable `gen_ai.usage.cache_read.input_tokens` /
    `gen_ai.usage.cache_creation.input_tokens`. Migrated call sites:
    `llm_output`, both `agent_end` safety nets in `src/hooks.ts`, and
    `enrichSpanWithUsage` in `src/diagnostics.ts`.
  - `gen_ai.usage.total_tokens` is **kept** but marked `@deprecated` in
    `src/semconv.ts` — consumers should compute `input + output` going
    forward.

  **Planned removal:** schema `1.3.0` / plugin `0.5.0`. The deprecation
  window is one minor release; the follow-up removal task is filed as a
  child of [ISI-992](https://github.com/henrikrexed/openclaw-o11y-plugin).
  See `docs/otel-integration.md#deprecated-attributes--dual-emit-window`
  for the full migration table and the consumer-side update checklist.
- **Granular content capture policy (ISI-1000).** The `captureContent`
  plugin option now accepts a `ContentCapturePolicy` object with five
  per-category flags (`inputMessages`, `outputMessages`, `toolInputs`,
  `toolOutputs`, `systemPrompt`) in addition to the legacy single boolean.
  Each flag gates one or more `openclaw.content.*` span attributes (capped
  at 8192 UTF-16 code units per value, with surrogate-pair-safe truncation).
  The legacy boolean still works — `true` enables all five flags, `false`
  disables them. Traceloop's `traceContent` is derived from
  `inputMessages || outputMessages || systemPrompt`; because Traceloop has a
  single boolean, enabling any one of those three causes its LLM-client spans
  to record both prompt and completion content (see
  [`docs/security/privacy.md`](./docs/security/privacy.md)).
- New env var `OPENCLAW_OTEL_CONTENT_POLICY` (JSON) bridges the policy to
  the ESM preload. Takes precedence over the legacy
  `OPENCLAW_OTEL_CAPTURE_CONTENT` when both are set.
- **Configurable trace sampling rate (ISI-998).** New `sampleRate` option
  (0.0–1.0) in `diagnostics.otel`. When set, the plugin wires a
  `ParentBasedSampler` around a `TraceIdRatioBasedSampler` so root spans
  make a deterministic, trace-id-based sampling decision and child spans
  inherit it — keeping distributed traces coherent under head-based
  sampling. Invalid values (out of range, `NaN`, non-numeric) are ignored
  and the SDK default (`parentbased_always_on`) is used. Documented in
  `docs/configuration.md#trace-sampling`.

### Changed

- **OpenClaw attribute schema bumped to `1.1.0` (ISI-993).** Three call sites
  that emitted invalid OpenTelemetry GenAI semantic-convention data are now
  registry-compliant:
  - `gen_ai.response.finish_reasons` now emits as `string[]` (it was previously
    a comma-joined string). Consumers reading the attribute should expect an
    array on captured spans.
  - The invalid `gen_ai.operation.name = "cron_executed"` attribute is no
    longer set on `openclaw.cron.exec` spans; the registry only allows the
    nine standard values (`chat`, `create_agent`, `embeddings`, `execute_tool`,
    `generate_content`, `invoke_agent`, `invoke_workflow`, `retrieval`,
    `text_completion`). Cron context remains available via `openclaw.cron.*`.

### Fixed

- **`gen_ai.response.finish_reasons` array hardening (ISI-993).** Non-string
  entries (`null`, `undefined`, numbers, empty strings) are now filtered out
  of the array before the attribute is set. If the array contains no valid
  strings after filtering, the attribute is omitted entirely. This prevents
  malformed upstream events from emitting non-spec data via the unchecked
  TypeScript cast that landed in the initial Story 1 fix.
- **Boundary-straddle redaction leak in content capture (ISI-1000).**
  `captureContentAttribute` and `setToolInputPreview` now redact BEFORE
  truncating. The previous order let a secret straddling the 8192-char
  (or 1000-char preview) cap get sliced below the redaction regex's
  minimum-match length, leaving a plaintext token prefix in the captured
  span attribute. Verified with a bearer-token regression test driving
  the boundary.
- **Synthetic tool span SECURITY warn log redaction (ISI-1000).** The
  third `[otel] SECURITY: ...` warn callsite (the `tool_result_persist`
  no-active-tool-span fallback) was missing the `redactSensitiveText`
  wrap that the other two security warns already had. With ISI-997's
  OTLP log bridge on `main`, that callsite could ship credentials
  embedded in user-supplied paths/commands to the backend logs. All
  three callsites now share the redacted shape.

### Breaking

- **Tool-approval attributes moved out of the reserved `gen_ai.*` namespace
  (ISI-993).** The OTel registry reserves `gen_ai.*` for standardised
  attributes; the plugin's custom approval keys have been renamed to the
  plugin-domain namespace:
  - `gen_ai.tool.approval.requested` → `openclaw.tool.approval.requested`
  - `gen_ai.tool.approval.resolution` → `openclaw.tool.approval.resolution`
  - `gen_ai.tool.approval.duration_ms` → `openclaw.tool.approval.duration_ms`

  Dashboards or alert rules filtering on the old `gen_ai.tool.approval.*` keys
  must be updated. `OPENCLAW_SCHEMA_VERSION` is bumped from `1.0.0` to `1.1.0`
  so consumers can detect the rename.

## [0.3.1] — 2026-05-10

### Added

- **npm publication (ISI-947 / GH#21).** Plugin is now published on npm as
  `@henrikrexed/openclaw-otel-observability`, enabling installation via
  `openclaw-operator`'s `OpenClawInstance.spec.plugins`.
- **Release automation.** `release-please` workflow opens versioning PRs from
  conventional-commit history; merging a release PR creates a GitHub Release,
  which triggers the `publish-npm` workflow with `--provenance --access public`.
- `package.json` now declares a `files` allowlist (source `.ts`, preload mjs,
  manifest, README, LICENSE, CHANGELOG) so the published tarball excludes
  tests, dashboards, docs site, and dev tooling.

### Changed

- Package renamed from `@openclaw/otel-observability` to
  `@henrikrexed/openclaw-otel-observability`. The `@openclaw` scope is owned
  by an unrelated maintainer, so the plugin uses the author's personal scope
  (mirroring `@larksuite/openclaw-lark` and `@tencent-weixin/openclaw-weixin`).
- README install guide leads with `npm install`; the `git clone` path is
  retained as a "local development" fallback.

### Fixed

- **Document the `hooks.allowConversationAccess: true` requirement (ISI-945,
  github issue [#20](https://github.com/henrikrexed/openclaw-observability-plugin/issues/20)).**
  OpenClaw 2026.4.23 introduced a typed-hook policy gate: non-bundled
  (path-loaded) plugins must explicitly opt in to the conversation hooks
  (`before_model_resolve`, `before_agent_reply`, `llm_input`, `llm_output`,
  `before_agent_finalize`, `agent_end`, `before_agent_run`) by setting
  `plugins.entries.<plugin-id>.hooks.allowConversationAccess: true` on their
  entry. Without it the runtime silently drops those registrations — the
  plugin's `[otel] Registered ... hook (via api.on)` banners still print but
  the handlers never fire, so no `openclaw.request` / `openclaw.agent.turn`
  spans reach the backend even though the metric heartbeat keeps emitting.
  README install snippets, `docs/getting-started.md`, and the
  README troubleshooting section now document the requirement and the
  `pluginDiagnostics` block warning to look for.

## [0.3.0] — 2026-05-10

### Added

- **Log export pipeline (ISI-930).** OTLP log export via `log.record` diagnostic events
  with severity mapping, trace context enrichment, configurable filtering, and logger
  name/function/file/line attributes.
- **Trace context store.** New `TraceContextStore` module for session context propagation
  across spans, including legacy context merge and stale session cleanup.
- **V2 → V3 migration guide** at `docs/migration-v2-to-v3.md` covering breaking changes,
  new features, dashboard migration, and upgrade steps.
- **Troubleshooting section** in README covering hook registration, plugin loading, and
  trace connectivity issues.

### Fixed

- Align `activeSessions` gauge attributes between `session_start` and `session_end` hooks.
- `resolveLegacyContext` now traverses sub-agent links for correct context resolution.
- Trace context store handles legacy context merge and safe stale cleanup.
- Deduplicated tool input preview logic via `setToolInputPreview` helper.
- Telemetry histogram alias wording clarified.
- Review follow-up typecheck inconsistencies resolved.
- Lint script replaced broken `eslint` reference with `tsc --noEmit`.

### Changed

- README updated with V3 features table, plugin lifecycle documentation, and log pipeline
  configuration reference.
- Architecture docs updated with new trace structure and GenAI semconv attributes table.

## [0.2.0] — 2026-04-23

### Changed

- **Hook migration (ISI-730).** Replaced the legacy `before_agent_start` hook
  registration with the phase-specific hooks introduced in OpenClaw 2026.4.21:
  - `before_model_resolve` — creates the `openclaw.agent.turn` span at the
    earliest point in the agent run. Agent-identity attributes
    (`gen_ai.agent.id`, `gen_ai.conversation.id`, `openclaw.agent.id`,
    `openclaw.session.key`) are set here. `gen_ai.request.model` is
    intentionally omitted because the model has not yet been resolved.
  - `before_prompt_build` — enriches the existing agent turn span with
    `openclaw.prompt.chars` and `openclaw.session.message_count` once the
    session history has been loaded, before the LLM call.

  Existing trace structure (`openclaw.request` → `openclaw.agent.turn` →
  tool spans → `agent_end`) is preserved. All previously-emitted span
  attributes still appear on the agent turn span; two new
  `openclaw.prompt.*` / `openclaw.session.message_count` attributes are
  added as a bonus.

- **`captureContent` is now wired end-to-end to Traceloop LLM-client spans
  (ISI-733).** Setting `captureContent: true` in the plugin config (plus
  `OPENCLAW_OTEL_CAPTURE_CONTENT=true` in the gateway's environment, read by
  `instrumentation/preload.mjs` before Traceloop loads) causes
  `@traceloop/instrumentation-anthropic` and
  `@traceloop/instrumentation-openai` to record prompt and completion text
  as `gen_ai.prompt.*` / `gen_ai.completion.*` span attributes. Previously
  the option was accepted but had no effect on LLM-client spans.
  - Default stays `false` (privacy-first).
  - `captureContent` is a **gateway-launch setting, not hot-reloadable** —
    the preload runs before plugin config is parsed, so the Traceloop
    instrumentations are constructed once at process start. Restart the
    gateway to pick up changes.
  - The plugin logs a warning at `start()` if the config and the preload's
    resolved env-var value disagree.
  - See [docs/security/privacy.md](docs/security/privacy.md) and
    [docs/configuration.md](docs/configuration.md#capturecontent-gateway-launch-setting).
  - Resolves [github issue #15](https://github.com/henrikrexed/openclaw-observability-plugin/issues/15)
    (ISI-733 / ISI-734).

### Removed

- `before_agent_start` hook registration. The plugin no longer listens to
  this legacy hook. If you run this version against OpenClaw &lt; 2026.4.21,
  the agent turn span will not be created. Pin to `0.1.x` if you still
  need the legacy path.

### Added

- `minOpenClawVersion: 2026.4.21` in `openclaw.plugin.json`.
- Regression tests for hook wiring (`tests/hooks.test.ts`).
- `instrumentation/capture-content.mjs` exports `resolveCaptureContent(env)`
  and the `CAPTURE_CONTENT_ENV` constant, consumed by the preload and
  covered by `instrumentation/capture-content.test.mjs` (`npm test`, uses
  `node --test`).
- `docs/security/privacy.md` — new page covering the privacy implications
  of `captureContent`, how to enable it safely, and redaction guidance.

## [0.1.0] — 2026-04-16

Initial public release. See the repository `README.md` and `docs/` tree for
capability documentation.
