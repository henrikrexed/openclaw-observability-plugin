/**
 * Tests for `redactSensitiveText` (ISI-999).
 *
 * The redactor scrubs common credential and PII patterns from strings
 * before they are written into span attributes, log records, or event
 * payloads.
 */

import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../src/security.js";

describe("redactSensitiveText", () => {
  it("returns empty/non-string inputs unchanged", () => {
    expect(redactSensitiveText("")).toBe("");
    // @ts-expect-error — exercise the runtime guard
    expect(redactSensitiveText(undefined)).toBeUndefined();
    // @ts-expect-error — exercise the runtime guard
    expect(redactSensitiveText(null)).toBeNull();
  });

  it("leaves benign text alone", () => {
    const input = "Tool Read called with path=/etc/hosts";
    expect(redactSensitiveText(input)).toBe(input);
  });

  it("redacts OpenAI-style API keys", () => {
    expect(
      redactSensitiveText("authorization: sk-abcdefghijklmnopqrstuv"),
    ).toBe("authorization: [REDACTED_API_KEY]");
  });

  it("redacts Anthropic-style API keys", () => {
    expect(
      redactSensitiveText("key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv01"),
    ).toBe("key=[REDACTED_API_KEY]");
  });

  it("redacts GitHub personal access tokens", () => {
    expect(
      redactSensitiveText("token ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
    ).toBe("token [REDACTED_GITHUB_TOKEN]");
  });

  it("redacts AWS access key IDs", () => {
    expect(
      redactSensitiveText("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE rest"),
    ).toBe("AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY] rest");
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSensitiveText(`token=${jwt}`)).toBe("token=[REDACTED_JWT]");
  });

  it("redacts Bearer tokens but keeps the scheme", () => {
    expect(
      redactSensitiveText("Authorization: Bearer abcdef1234567890ABCDEF"),
    ).toBe("Authorization: Bearer [REDACTED_TOKEN]");
  });

  it("redacts Basic auth credentials but keeps the scheme", () => {
    expect(
      redactSensitiveText("Authorization: Basic dXNlcjpzdXBlcl9zZWNyZXQ="),
    ).toBe("Authorization: Basic [REDACTED_CREDENTIALS]");
  });

  it("redacts email addresses", () => {
    expect(redactSensitiveText("user alice@example.com signed in")).toBe(
      "user [REDACTED_EMAIL] signed in",
    );
  });

  it("redacts multiple sensitive values in a single string", () => {
    const out = redactSensitiveText(
      'curl -H "Authorization: Bearer abcdef1234567890ABCDEF" -d \'{"email":"bob@example.com","key":"sk-abcdefghijklmnopqrstuv"}\'',
    );
    expect(out).toContain("Bearer [REDACTED_TOKEN]");
    expect(out).toContain("[REDACTED_EMAIL]");
    expect(out).toContain("[REDACTED_API_KEY]");
    expect(out).not.toContain("bob@example.com");
    expect(out).not.toContain("sk-abcdef");
  });

  it("does not corrupt JSON structure when redacting values", () => {
    const json = JSON.stringify({
      tool: "Bash",
      command: "echo sk-abcdefghijklmnopqrstuv",
      user: "bob@example.com",
    });
    const out = redactSensitiveText(json);
    expect(out).toContain("[REDACTED_API_KEY]");
    expect(out).toContain("[REDACTED_EMAIL]");
    // Round-trip through JSON.parse to confirm structure is intact.
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
