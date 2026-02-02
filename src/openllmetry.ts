/**
 * LLM SDK instrumentation — wraps Anthropic/OpenAI streaming calls
 * to produce GenAI-standard OTel spans.
 *
 * Key insight: OpenClaw calls `client.messages.stream()` not `.create()`.
 * `.stream()` returns a MessageStream that internally calls `.create()`.
 * Wrapping `.create()` with `.then()` breaks the `APIPromise.withResponse()`
 * chain. So we wrap `.stream()` instead — it's the real entry point.
 *
 * The MessageStream emits a 'finalMessage' event with full usage data.
 */

import { createRequire } from "node:module";
import { trace, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { OtelObservabilityConfig } from "./config.js";

const openclawRequire = createRequire(
  "/home/hrexed/.npm-global/lib/node_modules/openclaw/package.json"
);

let initialized = false;

export async function initOpenLLMetry(config: OtelObservabilityConfig, logger: any): Promise<void> {
  if (initialized) {
    logger.info("[otel] LLM instrumentation already initialized, skipping");
    return;
  }
  initialized = true;
  let patchedCount = 0;

  // ── Anthropic SDK ─────────────────────────────────────────────────
  try {
    const sdk = openclawRequire("@anthropic-ai/sdk");
    const Anthropic = sdk.Anthropic || sdk.default;

    // Wrap .stream() — the method OpenClaw actually calls
    if (Anthropic?.Messages?.prototype?.stream) {
      const origStream = Anthropic.Messages.prototype.stream;

      Anthropic.Messages.prototype.stream = function patchedStream(this: any, body: any, options?: any) {
        const model = body?.model || "unknown";
        const tracer = trace.getTracer("openclaw-genai", "0.1.0");
        const span = tracer.startSpan(`chat ${model}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.system": "anthropic",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.request.max_tokens": body?.max_tokens,
            "gen_ai.request.temperature": body?.temperature,
            "gen_ai.request.stream": true,
          },
        });

        try {
          // Call original — returns a MessageStream
          const messageStream = origStream.call(this, body, options);

          // MessageStream emits 'finalMessage' with complete response + usage
          if (messageStream && typeof messageStream.on === "function") {
            messageStream.on("finalMessage", (msg: any) => {
              try {
                if (msg?.usage) {
                  span.setAttribute("gen_ai.usage.input_tokens", msg.usage.input_tokens || 0);
                  span.setAttribute("gen_ai.usage.output_tokens", msg.usage.output_tokens || 0);
                }
                if (msg?.model) span.setAttribute("gen_ai.response.model", msg.model);
                if (msg?.stop_reason) span.setAttribute("gen_ai.response.finish_reasons", [msg.stop_reason]);
                if (msg?.id) span.setAttribute("gen_ai.response.id", msg.id);
                span.setStatus({ code: SpanStatusCode.OK });
              } catch { /* ignore */ }
              span.end();
            });

            // Handle errors
            messageStream.on("error", (err: any) => {
              try {
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                span.setAttribute("error.type", err?.constructor?.name || "Error");
              } catch { /* ignore */ }
              span.end();
            });

            // Handle abort — if stream ends without finalMessage
            messageStream.on("abort", () => {
              try {
                span.setStatus({ code: SpanStatusCode.ERROR, message: "Stream aborted" });
              } catch { /* ignore */ }
              span.end();
            });
          } else {
            // Unexpected — end span immediately
            span.end();
          }

          return messageStream;
        } catch (err: any) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          span.end();
          throw err;
        }
      };

      patchedCount++;
      logger.info("[otel] ✅ Anthropic Messages.stream wrapped (GenAI spans with usage)");
    }

    // Also wrap non-streaming .create() for users who call it directly
    if (Anthropic?.Messages?.prototype?.create) {
      const origCreate = Anthropic.Messages.prototype.create;

      // Use a non-invasive approach: wrap but preserve the APIPromise type
      const origCreateDescriptor = Object.getOwnPropertyDescriptor(
        Anthropic.Messages.prototype, "create"
      );

      // We'll add span tracking via a side-channel, not by wrapping the Promise
      Anthropic.Messages.prototype.create = function patchedCreate(this: any, body: any, options?: any) {
        const isStream = body?.stream === true;

        // For stream: true, the .stream() wrapper handles it
        // Only instrument non-streaming calls here
        if (isStream) {
          return origCreate.call(this, body, options);
        }

        const model = body?.model || "unknown";
        const tracer = trace.getTracer("openclaw-genai", "0.1.0");
        const span = tracer.startSpan(`chat ${model}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.system": "anthropic",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.request.max_tokens": body?.max_tokens,
            "gen_ai.request.temperature": body?.temperature,
            "gen_ai.request.stream": false,
          },
        });

        // Call original and get APIPromise
        const result = origCreate.call(this, body, options);

        // Use .finally-style approach to capture result without breaking the chain
        // APIPromise supports .then/.catch/.finally
        if (result && typeof result.then === "function") {
          // Track completion without altering the return type
          result.then(
            (res: any) => {
              try {
                if (res?.usage) {
                  span.setAttribute("gen_ai.usage.input_tokens", res.usage.input_tokens || 0);
                  span.setAttribute("gen_ai.usage.output_tokens", res.usage.output_tokens || 0);
                }
                if (res?.model) span.setAttribute("gen_ai.response.model", res.model);
                if (res?.stop_reason) span.setAttribute("gen_ai.response.finish_reasons", [res.stop_reason]);
                if (res?.id) span.setAttribute("gen_ai.response.id", res.id);
                span.setStatus({ code: SpanStatusCode.OK });
              } catch { /* ignore */ }
              span.end();
            },
            (err: any) => {
              try {
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
              } catch { /* ignore */ }
              span.end();
            }
          );
        }

        // Return the ORIGINAL APIPromise unchanged — preserves .withResponse() etc.
        return result;
      };

      logger.info("[otel] ✅ Anthropic Messages.create wrapped (non-streaming GenAI spans)");
    }
  } catch (err) {
    logger.warn(`[otel] Anthropic SDK not available: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── OpenAI SDK ────────────────────────────────────────────────────
  try {
    const sdk = openclawRequire("openai");
    const OpenAI = sdk.OpenAI || sdk.default;

    if (OpenAI?.Chat?.Completions?.prototype?.create) {
      const origCreate = OpenAI.Chat.Completions.prototype.create;

      OpenAI.Chat.Completions.prototype.create = function patchedOpenAICreate(this: any, body: any, options?: any) {
        const model = body?.model || "unknown";
        const tracer = trace.getTracer("openclaw-genai", "0.1.0");
        const span = tracer.startSpan(`chat ${model}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.system": "openai",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.request.stream": body?.stream === true,
          },
        });

        const result = origCreate.call(this, body, options);

        if (result && typeof result.then === "function") {
          result.then(
            (res: any) => {
              try {
                if (res?.usage) {
                  span.setAttribute("gen_ai.usage.input_tokens", res.usage.prompt_tokens || 0);
                  span.setAttribute("gen_ai.usage.output_tokens", res.usage.completion_tokens || 0);
                }
                if (res?.model) span.setAttribute("gen_ai.response.model", res.model);
                span.setStatus({ code: SpanStatusCode.OK });
              } catch { /* ignore */ }
              span.end();
            },
            (err: any) => {
              try { span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message }); } catch { /* ignore */ }
              span.end();
            }
          );
        }

        return result;
      };

      patchedCount++;
      logger.info("[otel] ✅ OpenAI Chat.Completions.create wrapped");
    }
  } catch {
    // Not available — fine
  }

  // ── Bedrock SDK ───────────────────────────────────────────────────
  try {
    const sdk = openclawRequire("@aws-sdk/client-bedrock-runtime");
    if (sdk?.BedrockRuntimeClient?.prototype?.send) {
      const origSend = sdk.BedrockRuntimeClient.prototype.send;

      sdk.BedrockRuntimeClient.prototype.send = function patchedSend(this: any, command: any, ...rest: any[]) {
        const modelId = command?.input?.modelId || "unknown";
        const tracer = trace.getTracer("openclaw-genai", "0.1.0");
        const span = tracer.startSpan(`chat ${modelId}`, {
          kind: SpanKind.CLIENT,
          attributes: { "gen_ai.system": "aws.bedrock", "gen_ai.request.model": modelId },
        });

        const result = origSend.call(this, command, ...rest);
        if (result && typeof result.then === "function") {
          result.then(
            () => { span.setStatus({ code: SpanStatusCode.OK }); span.end(); },
            (err: any) => { span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message }); span.end(); }
          );
        }
        return result;
      };

      patchedCount++;
      logger.info("[otel] ✅ Bedrock send wrapped");
    }
  } catch { /* Not available */ }

  if (patchedCount > 0) {
    logger.info(`[otel] ${patchedCount} LLM SDK(s) instrumented`);
  } else {
    logger.warn("[otel] No LLM SDKs instrumented");
  }
}
