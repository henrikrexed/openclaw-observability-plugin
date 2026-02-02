/**
 * LLM SDK instrumentation — wraps Anthropic/OpenAI API calls to produce
 * GenAI-standard OTel spans.
 *
 * Instead of relying on OpenLLMetry's auto-instrumentation (which has timing
 * issues with ESM and requires _enabled state), we directly wrap the SDK
 * prototypes ourselves. This is simpler and more reliable.
 *
 * Produces spans following OpenTelemetry GenAI semantic conventions:
 *   - span name: "chat <model>" (e.g., "chat claude-opus-4-5")
 *   - gen_ai.system: "anthropic"
 *   - gen_ai.request.model: model name
 *   - gen_ai.usage.input_tokens / output_tokens
 *   - gen_ai.response.finish_reasons
 */

import { createRequire } from "node:module";
import { trace, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import type { OtelObservabilityConfig } from "./config.js";

// Resolve modules from OpenClaw's node_modules
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

    if (Anthropic?.Messages?.prototype?.create) {
      const origCreate = Anthropic.Messages.prototype.create;

      Anthropic.Messages.prototype.create = function patchedCreate(this: any, ...args: any[]) {
        const params = args[0] || {};
        const model = params.model || "unknown";
        const isStream = params.stream === true;

        const tracer = trace.getTracer("openclaw-genai", "0.1.0");
        const span = tracer.startSpan(`chat ${model}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.system": "anthropic",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.request.max_tokens": params.max_tokens,
            "gen_ai.request.temperature": params.temperature,
            "gen_ai.request.stream": isStream,
          },
        });

        const spanContext = trace.setSpan(context.active(), span);

        const handleResponse = (response: any) => {
          try {
            // Extract usage from response
            const usage = response?.usage;
            if (usage) {
              span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens || 0);
              span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens || 0);
            }

            // Model from response
            if (response?.model) {
              span.setAttribute("gen_ai.response.model", response.model);
            }

            // Stop reason
            if (response?.stop_reason) {
              span.setAttribute("gen_ai.response.finish_reasons", [response.stop_reason]);
            }

            // Response ID
            if (response?.id) {
              span.setAttribute("gen_ai.response.id", response.id);
            }

            span.setStatus({ code: SpanStatusCode.OK });
          } catch {
            // Don't let span attribute errors propagate
          }
        };

        const handleError = (err: any) => {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err?.message || String(err),
          });
          span.setAttribute("error.type", err?.constructor?.name || "Error");
        };

        try {
          const result = context.with(spanContext, () => origCreate.apply(this, args));

          // result could be a Promise (for non-stream) or a stream object
          if (result && typeof result.then === "function") {
            return result.then(
              (res: any) => {
                // For streaming, the result might be a MessageStream
                // that has .finalMessage() or emits events
                if (res && typeof res.finalMessage === "function") {
                  // It's a MessageStream — listen for the final message
                  const origFinalMessage = res.finalMessage.bind(res);
                  res.finalMessage = async function () {
                    const msg = await origFinalMessage();
                    handleResponse(msg);
                    span.end();
                    return msg;
                  };
                  // Also handle .on('finalMessage') style
                  if (typeof res.on === "function") {
                    res.on("finalMessage", (msg: any) => {
                      handleResponse(msg);
                      span.end();
                    });
                  }
                  return res;
                }

                // Regular response (non-stream create)
                handleResponse(res);
                span.end();
                return res;
              },
              (err: any) => {
                handleError(err);
                span.end();
                throw err;
              }
            );
          }

          // Synchronous result (unlikely but handle it)
          handleResponse(result);
          span.end();
          return result;
        } catch (err: any) {
          handleError(err);
          span.end();
          throw err;
        }
      };

      patchedCount++;
      logger.info("[otel] ✅ Anthropic Messages.create wrapped with GenAI spans");
    }

    // Also wrap Beta.Messages.create if it exists
    if (Anthropic?.Beta?.Messages?.prototype?.create) {
      const origBetaCreate = Anthropic.Beta.Messages.prototype.create;
      Anthropic.Beta.Messages.prototype.create = function patchedBetaCreate(this: any, ...args: any[]) {
        // Delegate to the same logic — the regular create wrapper handles everything
        return Anthropic.Messages.prototype.create.apply(this, args);
      };
      logger.info("[otel] ✅ Anthropic Beta.Messages.create wrapped");
    }
  } catch (err) {
    logger.warn(`[otel] Anthropic SDK not available or patch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── OpenAI SDK ────────────────────────────────────────────────────
  try {
    const sdk = openclawRequire("openai");
    const OpenAI = sdk.OpenAI || sdk.default;

    if (OpenAI?.Chat?.Completions?.prototype?.create) {
      const origCreate = OpenAI.Chat.Completions.prototype.create;

      OpenAI.Chat.Completions.prototype.create = function patchedOpenAICreate(this: any, ...args: any[]) {
        const params = args[0] || {};
        const model = params.model || "unknown";
        const isStream = params.stream === true;

        const tracer = trace.getTracer("openclaw-genai", "0.1.0");
        const span = tracer.startSpan(`chat ${model}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.system": "openai",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "gen_ai.request.max_tokens": params.max_tokens,
            "gen_ai.request.temperature": params.temperature,
            "gen_ai.request.stream": isStream,
          },
        });

        try {
          const result = origCreate.apply(this, args);

          if (result && typeof result.then === "function") {
            return result.then(
              (res: any) => {
                try {
                  const usage = res?.usage;
                  if (usage) {
                    span.setAttribute("gen_ai.usage.input_tokens", usage.prompt_tokens || 0);
                    span.setAttribute("gen_ai.usage.output_tokens", usage.completion_tokens || 0);
                  }
                  if (res?.model) span.setAttribute("gen_ai.response.model", res.model);
                  span.setStatus({ code: SpanStatusCode.OK });
                } catch { /* ignore */ }
                span.end();
                return res;
              },
              (err: any) => {
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
                span.end();
                throw err;
              }
            );
          }

          span.end();
          return result;
        } catch (err: any) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          span.end();
          throw err;
        }
      };

      patchedCount++;
      logger.info("[otel] ✅ OpenAI Chat.Completions.create wrapped with GenAI spans");
    }
  } catch (err) {
    logger.warn(`[otel] OpenAI SDK not available or patch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Bedrock SDK ───────────────────────────────────────────────────
  try {
    const sdk = openclawRequire("@aws-sdk/client-bedrock-runtime");

    if (sdk?.BedrockRuntimeClient?.prototype?.send) {
      const origSend = sdk.BedrockRuntimeClient.prototype.send;

      sdk.BedrockRuntimeClient.prototype.send = function patchedBedrockSend(this: any, ...args: any[]) {
        const command = args[0];
        const modelId = command?.input?.modelId || "unknown";

        const tracer = trace.getTracer("openclaw-genai", "0.1.0");
        const span = tracer.startSpan(`chat ${modelId}`, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.system": "aws.bedrock",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": modelId,
          },
        });

        try {
          const result = origSend.apply(this, args);

          if (result && typeof result.then === "function") {
            return result.then(
              (res: any) => {
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                return res;
              },
              (err: any) => {
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
                span.end();
                throw err;
              }
            );
          }

          span.end();
          return result;
        } catch (err: any) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          span.end();
          throw err;
        }
      };

      patchedCount++;
      logger.info("[otel] ✅ Bedrock BedrockRuntimeClient.send wrapped with GenAI spans");
    }
  } catch {
    // Bedrock not available — fine
  }

  if (patchedCount > 0) {
    logger.info(`[otel] ${patchedCount} LLM SDK(s) instrumented with direct GenAI spans`);
  } else {
    logger.warn("[otel] No LLM SDKs instrumented — GenAI spans won't be available");
  }
}
