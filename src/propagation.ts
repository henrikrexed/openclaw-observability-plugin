/**
 * W3C trace context propagation helpers.
 *
 * Registers a composite W3C TraceContext + Baggage propagator as the global
 * OTel propagator, and exposes inject/extract helpers for plain header
 * objects (e.g. fetch/Headers carriers, message metadata, sub-agent env).
 *
 * Auto-instrumentation libraries (e.g. @opentelemetry/instrumentation-http,
 * undici, fetch wrappers) pick up the global propagator automatically — so
 * once the plugin initializes, outgoing HTTP requests from instrumented
 * client SDKs include `traceparent` / `tracestate` headers without any
 * additional code.
 *
 * Callers that own their own carrier (custom RPC, message queues, child
 * process env vars) can use {@link injectTraceContext} /
 * {@link extractTraceContext} directly.
 */

import { context as otelContext, propagation, type Context, type TextMapGetter, type TextMapSetter } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";

/** Plain-object header carrier used by the default helpers. */
export type HeaderCarrier = Record<string, string | string[] | undefined>;

const setter: TextMapSetter<HeaderCarrier> = {
  set(carrier, key, value) {
    carrier[key] = value;
  },
};

const getter: TextMapGetter<HeaderCarrier> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    if (!carrier) return undefined;
    const direct = carrier[key];
    if (direct !== undefined) return direct;
    const lower = key.toLowerCase();
    if (carrier[lower] !== undefined) return carrier[lower];
    for (const k of Object.keys(carrier)) {
      if (k.toLowerCase() === lower) return carrier[k];
    }
    return undefined;
  },
};

let cachedPropagator: CompositePropagator | null = null;

/**
 * Returns the singleton composite W3C propagator
 * (TraceContext + Baggage). Cheap to call repeatedly.
 */
export function getPropagator(): CompositePropagator {
  if (!cachedPropagator) {
    cachedPropagator = new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    });
  }
  return cachedPropagator;
}

/**
 * Registers the composite W3C propagator as the OTel global propagator.
 * Returns the propagator instance for callers that want to attach it to a
 * `tracerProvider.register({ propagator })` call.
 *
 * Safe to call multiple times — subsequent calls are no-ops at the API
 * level because the global propagator is replaced with the same instance.
 */
export function setupGlobalPropagator(): CompositePropagator {
  const propagator = getPropagator();
  propagation.setGlobalPropagator(propagator);
  return propagator;
}

/**
 * Inject the current (or supplied) trace context into a header-style
 * carrier. Sets `traceparent` (and `tracestate` if present) plus W3C
 * `baggage` when the context carries baggage entries.
 *
 * @example
 *   const headers: Record<string, string> = {};
 *   injectTraceContext(headers);
 *   await fetch(url, { headers });
 */
export function injectTraceContext(carrier: HeaderCarrier, ctx: Context = otelContext.active()): void {
  getPropagator().inject(ctx, carrier, setter);
}

/**
 * Extract a W3C trace context from a header-style carrier and return a
 * new {@link Context}. Header lookup is case-insensitive so callers can
 * pass raw Node `IncomingMessage.headers` directly.
 *
 * The returned context can be activated with
 * `context.with(extracted, () => …)` to make downstream spans children of
 * the upstream trace.
 */
export function extractTraceContext(carrier: HeaderCarrier, ctx: Context = otelContext.active()): Context {
  return getPropagator().extract(ctx, carrier, getter);
}

/** Names of the W3C fields the propagator may produce on a carrier. */
export function propagationFields(): string[] {
  return getPropagator().fields();
}
