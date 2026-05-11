/**
 * Tests for the config parser, in particular the granular
 * `ContentCapturePolicy` introduced in ISI-1000.
 *
 * Covers:
 *   - Default policy is all-off (privacy-first).
 *   - Legacy `captureContent: true` / `false` still normalize to a
 *     fully populated policy.
 *   - Object form accepts partial input and ignores unknown keys.
 *   - Non-boolean field values coerce to `false`.
 *   - `policyEnablesLlmContent` is true only when any LLM-content flag
 *     is on (used to derive Traceloop's traceContent).
 */

import { describe, expect, it } from "vitest";

import {
  CONTENT_POLICY_DISABLED,
  CONTENT_POLICY_ENABLED,
  normalizeContentCapturePolicy,
  parseConfig,
  policyEnablesLlmContent,
} from "../src/config.js";

describe("parseConfig — content capture policy", () => {
  it("defaults to all flags off when captureContent is unset", () => {
    const cfg = parseConfig({});
    expect(cfg.captureContent).toEqual(CONTENT_POLICY_DISABLED);
  });

  it("treats legacy `captureContent: true` as every flag on", () => {
    const cfg = parseConfig({ captureContent: true });
    expect(cfg.captureContent).toEqual(CONTENT_POLICY_ENABLED);
  });

  it("treats legacy `captureContent: false` as every flag off", () => {
    const cfg = parseConfig({ captureContent: false });
    expect(cfg.captureContent).toEqual(CONTENT_POLICY_DISABLED);
  });

  it("accepts partial object form and fills missing flags as false", () => {
    const cfg = parseConfig({
      captureContent: { inputMessages: true, toolOutputs: true },
    });
    expect(cfg.captureContent).toEqual({
      ...CONTENT_POLICY_DISABLED,
      inputMessages: true,
      toolOutputs: true,
    });
  });

  it("ignores unknown keys in the object form", () => {
    const cfg = parseConfig({
      captureContent: { inputMessages: true, somethingElse: true } as any,
    });
    expect(cfg.captureContent).toEqual({
      ...CONTENT_POLICY_DISABLED,
      inputMessages: true,
    });
  });

  it("coerces non-boolean field values to false", () => {
    const cfg = parseConfig({
      captureContent: {
        inputMessages: "yes" as any,
        outputMessages: 1 as any,
        toolInputs: null as any,
        toolOutputs: true,
        systemPrompt: undefined as any,
      },
    });
    expect(cfg.captureContent).toEqual({
      ...CONTENT_POLICY_DISABLED,
      toolOutputs: true,
    });
  });

  it("rejects arrays and falls back to disabled policy", () => {
    const cfg = parseConfig({ captureContent: [] as any });
    expect(cfg.captureContent).toEqual(CONTENT_POLICY_DISABLED);
  });
});

describe("normalizeContentCapturePolicy", () => {
  it("returns a fresh copy of the disabled policy for null/undefined input", () => {
    expect(normalizeContentCapturePolicy(undefined)).toEqual(
      CONTENT_POLICY_DISABLED,
    );
    expect(normalizeContentCapturePolicy(null)).toEqual(
      CONTENT_POLICY_DISABLED,
    );
  });

  it("returns a mutable copy (not the frozen constant)", () => {
    const out = normalizeContentCapturePolicy(false);
    expect(() => {
      out.inputMessages = true;
    }).not.toThrow();
    expect(out.inputMessages).toBe(true);
  });
});

describe("policyEnablesLlmContent", () => {
  it("returns false for the disabled policy", () => {
    expect(policyEnablesLlmContent(CONTENT_POLICY_DISABLED)).toBe(false);
  });

  it("returns true for any LLM-content flag", () => {
    for (const flag of ["inputMessages", "outputMessages", "systemPrompt"] as const) {
      const policy = { ...CONTENT_POLICY_DISABLED, [flag]: true };
      expect(policyEnablesLlmContent(policy)).toBe(true);
    }
  });

  it("returns false when only tool flags are enabled", () => {
    expect(
      policyEnablesLlmContent({
        ...CONTENT_POLICY_DISABLED,
        toolInputs: true,
        toolOutputs: true,
      }),
    ).toBe(false);
  });
});
