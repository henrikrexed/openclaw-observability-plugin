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

// ── Raw-boolean shorthand on the policy env (ISI-1000 PR-30 review) ──

test("policy env accepts raw 'true' as an all-on shorthand", () => {
  // An operator setting OPENCLAW_OTEL_CONTENT_POLICY=true (without
  // wrapping it as JSON) used to silently fall through to the legacy
  // CAPTURE_CONTENT env, which made the granular var feel broken. The
  // resolver now accepts the raw boolean directly.
  assert.equal(resolveCaptureContent({ [CONTENT_POLICY_ENV]: "true" }), true);
});

test("policy env accepts raw 'false' as an all-off shorthand", () => {
  assert.equal(
    resolveCaptureContent({ [CONTENT_POLICY_ENV]: "false" }),
    false,
  );
});

test("raw 'false' on policy env wins over legacy 'true'", () => {
  // Same precedence rule as the JSON form: the granular var is the
  // operator's intent, the legacy var is whatever someone set earlier.
  const env = {
    [CAPTURE_CONTENT_ENV]: "true",
    [CONTENT_POLICY_ENV]: "false",
  };
  assert.equal(resolveCaptureContent(env), false);
});

test("raw 'true' on policy env wins over legacy 'false'", () => {
  const env = {
    [CAPTURE_CONTENT_ENV]: "false",
    [CONTENT_POLICY_ENV]: "true",
  };
  assert.equal(resolveCaptureContent(env), true);
});

test("loose truthy raw values on policy env still fall through to legacy", () => {
  // Mirrors the legacy var's strict-lowercase contract. `'1'`, `'True'`,
  // `'yes'` are not recognized as the shorthand and therefore fall
  // through to the legacy var (which itself is strict — those values
  // resolve to false there too, except 'true').
  for (const value of ["1", "yes", "True", "TRUE", "on", " true ", "enabled"]) {
    assert.equal(
      resolveCaptureContent({ [CONTENT_POLICY_ENV]: value }),
      false,
      `expected raw policy value '${value}' to fall through to legacy=false`,
    );
  }
  assert.equal(
    resolveCaptureContent({
      [CONTENT_POLICY_ENV]: "1",
      [CAPTURE_CONTENT_ENV]: "true",
    }),
    true,
    "raw '1' should fall through and let legacy 'true' win",
  );
});

test("malformed JSON that is not the literal 'true' or 'false' still falls through to legacy", () => {
  // Sanity-check the existing fallthrough contract: garbage on the
  // policy var lets the legacy var decide. This protects ops who copy a
  // JSON snippet wrong from a silent privacy regression.
  const env = {
    [CAPTURE_CONTENT_ENV]: "true",
    [CONTENT_POLICY_ENV]: "{not-json",
  };
  assert.equal(resolveCaptureContent(env), true);
});
