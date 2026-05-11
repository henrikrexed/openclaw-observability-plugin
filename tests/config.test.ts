/**
 * Tests for `parseConfig` — focuses on validation of new fields.
 *
 * ISI-998: sampleRate accepts only finite numbers in [0, 1]; anything else
 * (out-of-range, NaN, wrong type, missing) yields `undefined` so the plugin
 * falls back to the SDK default sampler.
 */

import { describe, expect, it } from "vitest";

import { parseConfig } from "../src/config.js";

describe("parseConfig — sampleRate", () => {
  it("returns undefined when sampleRate is not provided", () => {
    expect(parseConfig({}).sampleRate).toBeUndefined();
  });

  it("accepts 0.0 (drop all)", () => {
    expect(parseConfig({ sampleRate: 0 }).sampleRate).toBe(0);
  });

  it("accepts 1.0 (keep all)", () => {
    expect(parseConfig({ sampleRate: 1 }).sampleRate).toBe(1);
  });

  it("accepts a fractional rate", () => {
    expect(parseConfig({ sampleRate: 0.25 }).sampleRate).toBe(0.25);
  });

  it("rejects values above 1", () => {
    expect(parseConfig({ sampleRate: 1.5 }).sampleRate).toBeUndefined();
  });

  it("rejects negative values", () => {
    expect(parseConfig({ sampleRate: -0.1 }).sampleRate).toBeUndefined();
  });

  it("rejects NaN", () => {
    expect(parseConfig({ sampleRate: Number.NaN }).sampleRate).toBeUndefined();
  });

  it("rejects Infinity", () => {
    expect(
      parseConfig({ sampleRate: Number.POSITIVE_INFINITY }).sampleRate,
    ).toBeUndefined();
  });

  it("rejects non-number types", () => {
    expect(parseConfig({ sampleRate: "0.5" }).sampleRate).toBeUndefined();
  });
});
