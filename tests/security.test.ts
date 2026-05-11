/**
 * Tests for `redactSensitiveText` and `setRedactedAttribute` (ISI-999).
 *
 * The redactor scrubs common credential and PII patterns from strings
 * before they are written into span attributes, log records, or event
 * payloads.
 */

import { describe, expect, it, vi } from "vitest";

import { redactSensitiveText, setRedactedAttribute } from "../src/security.js";

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

  // ─── Case-insensitivity for auth schemes (ISI-999 C1) ────────────────

  it("redacts uppercase BEARER tokens", () => {
    expect(
      redactSensitiveText("Authorization: BEARER abcdef1234567890ABCDEF"),
    ).toBe("Authorization: Bearer [REDACTED_TOKEN]");
  });

  it("redacts uppercase BASIC credentials", () => {
    expect(
      redactSensitiveText("Authorization: BASIC dXNlcjpzdXBlcl9zZWNyZXQ="),
    ).toBe("Authorization: Basic [REDACTED_CREDENTIALS]");
  });

  it("redacts mixed-case bearer / basic", () => {
    expect(
      redactSensitiveText("authorization: bEaReR abcdef1234567890ABCDEF"),
    ).toBe("authorization: Bearer [REDACTED_TOKEN]");
    expect(
      redactSensitiveText("authorization: bAsIc dXNlcjpzdXBlcl9zZWNyZXQ="),
    ).toBe("authorization: Basic [REDACTED_CREDENTIALS]");
  });

  it("redacts uppercase GitHub token prefixes", () => {
    expect(
      redactSensitiveText("GHP_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    ).toBe("[REDACTED_GITHUB_TOKEN]");
  });

  // ─── Email false-positive avoidance (ISI-999 M1) ─────────────────────

  it("does not redact npm-style version specifiers as emails", () => {
    expect(redactSensitiveText("install package-lock@5.0.0.tgz")).toBe(
      "install package-lock@5.0.0.tgz",
    );
    expect(redactSensitiveText("install webpack@1.2.3.tgz")).toBe(
      "install webpack@1.2.3.tgz",
    );
    expect(redactSensitiveText("pnpm add @scope/pkg@4.5.6.tgz")).toBe(
      "pnpm add @scope/pkg@4.5.6.tgz",
    );
  });

  it("still redacts real emails on tricky domains", () => {
    expect(redactSensitiveText("dev+1@my-host.co.uk")).toBe(
      "[REDACTED_EMAIL]",
    );
    expect(redactSensitiveText("ops@s3.us-east-1.amazonaws.com")).toBe(
      "[REDACTED_EMAIL]",
    );
  });

  // ─── Idempotency (ISI-999) ───────────────────────────────────────────

  it("is idempotent: redact(redact(x)) === redact(x)", () => {
    const samples = [
      "Authorization: Bearer abcdef1234567890ABCDEF",
      "Authorization: BASIC dXNlcjpzdXBlcl9zZWNyZXQ=",
      "key=sk-abcdefghijklmnopqrstuv email=bob@example.com",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "no secrets here",
      "",
    ];
    for (const s of samples) {
      const once = redactSensitiveText(s);
      const twice = redactSensitiveText(once);
      expect(twice).toBe(once);
    }
  });

  // ─── Word-boundary negatives ─────────────────────────────────────────

  it("does not redact partial prefixes inside larger words", () => {
    // sk- prefix inside another word should not match
    expect(redactSensitiveText("xsk-abcdefghijklmnopqrstuv")).toBe(
      "xsk-abcdefghijklmnopqrstuv",
    );
    // gh prefix inside another word should not match
    expect(redactSensitiveText("xghp_abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "xghp_abcdefghijklmnopqrstuvwxyz012345",
    );
  });
});

describe("setRedactedAttribute", () => {
  it("redacts string values before calling span.setAttribute", () => {
    const setAttribute = vi.fn();
    const span = { setAttribute } as any;
    setRedactedAttribute(
      span,
      "openclaw.tool.input_preview",
      'curl -H "Authorization: Bearer abcdef1234567890ABCDEF"',
    );
    expect(setAttribute).toHaveBeenCalledTimes(1);
    expect(setAttribute).toHaveBeenCalledWith(
      "openclaw.tool.input_preview",
      'curl -H "Authorization: Bearer [REDACTED_TOKEN]"',
    );
  });

  it("passes non-string values through unchanged", () => {
    const setAttribute = vi.fn();
    const span = { setAttribute } as any;
    setRedactedAttribute(span, "openclaw.tool.result_chars", 42);
    setRedactedAttribute(span, "openclaw.flag", true);
    expect(setAttribute).toHaveBeenNthCalledWith(1, "openclaw.tool.result_chars", 42);
    expect(setAttribute).toHaveBeenNthCalledWith(2, "openclaw.flag", true);
  });
});
