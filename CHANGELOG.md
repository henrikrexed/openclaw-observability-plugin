# Changelog

All notable changes to the `@openclaw/otel-observability` plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
