import { describe, expect, it, beforeAll } from "vitest";
import {
  context,
  trace,
  propagation,
  ROOT_CONTEXT,
  type SpanContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

import {
  injectTraceContext,
  extractTraceContext,
  getPropagator,
  setupGlobalPropagator,
  propagationFields,
} from "../src/propagation.js";

const SAMPLE_SPAN_CONTEXT: SpanContext = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1,
  isRemote: false,
};

describe("W3C trace context propagation", () => {
  beforeAll(() => {
    setupGlobalPropagator();
    const cm = new AsyncLocalStorageContextManager();
    cm.enable();
    context.setGlobalContextManager(cm);
  });

  it("exposes the W3C TraceContext + Baggage propagator fields", () => {
    const fields = propagationFields();
    expect(fields).toContain("traceparent");
    expect(fields).toContain("baggage");
  });

  it("registers the composite propagator as the OTel global propagator", () => {
    const installed = setupGlobalPropagator();
    expect(installed).toBe(getPropagator());
    // The global API should now produce the same field set.
    expect(propagation.fields()).toEqual(expect.arrayContaining(["traceparent"]));
  });

  it("injects a W3C `traceparent` for the active span context", () => {
    const headers: Record<string, string> = {};
    const ctxWithSpan = trace.setSpanContext(ROOT_CONTEXT, SAMPLE_SPAN_CONTEXT);

    injectTraceContext(headers, ctxWithSpan);

    expect(typeof headers.traceparent).toBe("string");
    expect(headers.traceparent).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01$/,
    );
  });

  it("round-trips through inject -> extract preserving trace + span IDs", () => {
    const carrier: Record<string, string> = {};
    const ctxWithSpan = trace.setSpanContext(ROOT_CONTEXT, SAMPLE_SPAN_CONTEXT);

    injectTraceContext(carrier, ctxWithSpan);
    const extracted = extractTraceContext(carrier);
    const spanCtx = trace.getSpanContext(extracted);

    expect(spanCtx?.traceId).toBe(SAMPLE_SPAN_CONTEXT.traceId);
    expect(spanCtx?.spanId).toBe(SAMPLE_SPAN_CONTEXT.spanId);
    // Remote-extracted contexts must be flagged isRemote=true.
    expect(spanCtx?.isRemote).toBe(true);
  });

  it("extracts case-insensitively (Node IncomingMessage.headers style)", () => {
    const carrier: Record<string, string> = {};
    const ctxWithSpan = trace.setSpanContext(ROOT_CONTEXT, SAMPLE_SPAN_CONTEXT);
    injectTraceContext(carrier, ctxWithSpan);

    const upper: Record<string, string> = {};
    for (const [k, v] of Object.entries(carrier)) {
      upper[k.toUpperCase()] = v;
    }

    const extracted = extractTraceContext(upper);
    const spanCtx = trace.getSpanContext(extracted);
    expect(spanCtx?.traceId).toBe(SAMPLE_SPAN_CONTEXT.traceId);
    expect(spanCtx?.spanId).toBe(SAMPLE_SPAN_CONTEXT.spanId);
  });

  it("returns a context without a span when no traceparent is present", () => {
    const extracted = extractTraceContext({}, ROOT_CONTEXT);
    expect(trace.getSpanContext(extracted)).toBeUndefined();
  });

  it("defaults to the active context when none is supplied to inject", () => {
    const headers: Record<string, string> = {};
    const ctxWithSpan = trace.setSpanContext(ROOT_CONTEXT, SAMPLE_SPAN_CONTEXT);

    context.with(ctxWithSpan, () => {
      injectTraceContext(headers);
    });

    expect(headers.traceparent).toMatch(/-4bf92f3577b34da6a3ce929d0e0e4736-/);
  });
});
