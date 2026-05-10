# Changelog

All notable changes to the `@henrikrexed/openclaw-otel-observability` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
