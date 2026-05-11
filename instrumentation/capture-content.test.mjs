/**
 * Sanity test for the captureContent → traceContent wiring.
 *
 * The preload uses `resolveCaptureContent(process.env)` to decide whether
 * Traceloop records prompt/completion text on LLM-client spans. This test
 * pins the resolution semantics so a future regression that (for example)
 * loosens the comparison to truthy won't silently change the privacy
 * default from `false` to `true`.
 *
 * Run with: npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveCaptureContent,
  parseContentPolicyEnv,
  CAPTURE_CONTENT_ENV,
  CONTENT_POLICY_ENV,
} from "./capture-content.mjs";

test("returns false when env var is unset", () => {
  assert.equal(resolveCaptureContent({}), false);
});

test("returns true only for the exact lowercase string 'true'", () => {
  assert.equal(resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: "true" }), true);
});

test("returns false for 'false'", () => {
  assert.equal(resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: "false" }), false);
});

test("returns false for other truthy strings (privacy-first default)", () => {
  for (const value of ["1", "yes", "True", "TRUE", "on", " true ", "enabled"]) {
    assert.equal(
      resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: value }),
      false,
      `expected '${value}' to resolve to false`
    );
  }
});

test("returns false for empty string", () => {
  assert.equal(resolveCaptureContent({ [CAPTURE_CONTENT_ENV]: "" }), false);
});

test("exports the env var names so callers stay in sync", () => {
  assert.equal(CAPTURE_CONTENT_ENV, "OPENCLAW_OTEL_CAPTURE_CONTENT");
  assert.equal(CONTENT_POLICY_ENV, "OPENCLAW_OTEL_CONTENT_POLICY");
});

// ── Policy env (ISI-1000) ────────────────────────────────────────────

test("policy with any LLM-content flag enables traceContent", () => {
  for (const flag of ["inputMessages", "outputMessages", "systemPrompt"]) {
    const env = { [CONTENT_POLICY_ENV]: JSON.stringify({ [flag]: true }) };
    assert.equal(resolveCaptureContent(env), true, `expected ${flag}=true → true`);
  }
});

test("policy with only tool-* flags leaves traceContent off", () => {
  const env = {
    [CONTENT_POLICY_ENV]: JSON.stringify({ toolInputs: true, toolOutputs: true }),
  };
  assert.equal(resolveCaptureContent(env), false);
});

test("policy env overrides the legacy boolean env (preferred when set)", () => {
  const env = {
    [CAPTURE_CONTENT_ENV]: "true",
    [CONTENT_POLICY_ENV]: JSON.stringify({}),
  };
  assert.equal(resolveCaptureContent(env), false);
});

test("malformed policy JSON falls back to the legacy boolean", () => {
  const env = {
    [CAPTURE_CONTENT_ENV]: "true",
    [CONTENT_POLICY_ENV]: "{not-json",
  };
  assert.equal(resolveCaptureContent(env), true);
});

test("parseContentPolicyEnv returns undefined for non-object JSON", () => {
  assert.equal(parseContentPolicyEnv(undefined), undefined);
  assert.equal(parseContentPolicyEnv(""), undefined);
  assert.equal(parseContentPolicyEnv("null"), undefined);
  assert.equal(parseContentPolicyEnv("[]"), undefined);
  assert.equal(parseContentPolicyEnv('"string"'), undefined);
});
