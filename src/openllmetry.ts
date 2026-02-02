/**
 * LLM SDK instrumentation — wraps Anthropic/OpenAI streaming calls
 * to produce GenAI-standard OTel spans.
 *
 * CRITICAL: OpenClaw is an ESM application. pi-ai does:
 *   import Anthropic from "@anthropic-ai/sdk"  → loads index.mjs (ESM)
 * But createRequire() loads index.js (CJS) — a DIFFERENT module instance.
 * We MUST use dynamic import() to patch the same ESM prototype that pi-ai uses.
 */

import { appendFileSync } from "node:fs";
import { trace, SpanKind, SpanStatusCode, context } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { OtelObservabilityConfig } from "./config.js";

const DIAG_FILE = "/tmp/otel-genai-diag.log";
function diag(msg: string) {
  try { appendFileSync(DIAG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

let initialized = false;

export async function initOpenLLMetry(config: OtelObservabilityConfig, logger: any): Promise<void> {
  if (initialized) {
    logger.info("[otel] LLM instrumentation already initialized, skipping");
    return;
  }
  initialized = true;
  let patchedCount = 0;

  // ── Anthropic SDK (ESM) ───────────────────────────────────────────
  try {
    // MUST use dynamic import() with absolute ESM path to get the same
    // module instance that pi-ai loaded via `import Anthropic from "@anthropic-ai/sdk"`
    const SDK_ESM_PATH = "/home/hrexed/.npm-global/lib/node_modules/openclaw/node_modules/@anthropic-ai/sdk/index.mjs";
    const sdk = await import(SDK_ESM_PATH);
    const Anthropic = sdk.Anthropic || sdk.default;

    if (!Anthropic?.Messages?.prototype) {
      logger.warn("[otel] Anthropic SDK loaded but Messages.prototype not found");
      diag("WARN: Messages.prototype not found on ESM import");
    }

    // Wrap .stream() — the method OpenClaw/pi-ai actually calls
    if (Anthropic?.Messages?.prototype?.stream) {
      const origStream = Anthropic.Messages.prototype.stream;

      Anthropic.Messages.prototype.stream = function patchedStream(this: any, body: any, options?: any) {
        const model = body?.model || "unknown";
        diag(`🔥 stream() called, model=${model}`);
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
              diag(`✅ finalMessage: model=${msg?.model}, in=${msg?.usage?.input_tokens}, out=${msg?.usage?.output_tokens}`);
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

            messageStream.on("error", (err: any) => {
              diag(`❌ stream error: ${err?.message}`);
              try {
                span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
                span.setAttribute("error.type", err?.constructor?.name || "Error");
              } catch { /* ignore */ }
              span.end();
            });

            messageStream.on("abort", () => {
              diag("⚠️ stream aborted");
              try {
                span.setStatus({ code: SpanStatusCode.ERROR, message: "Stream aborted" });
              } catch { /* ignore */ }
              span.end();
            });
          } else {
            diag("WARN: messageStream has no .on() method");
            span.end();
          }

          return messageStream;
        } catch (err: any) {
          diag(`❌ stream() threw: ${err?.message}`);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
          span.end();
          throw err;
        }
      };

      patchedCount++;
      diag(`stream patched OK (ESM), orig name was: ${origStream.name}`);
      logger.info("[otel] ✅ Anthropic Messages.stream wrapped (ESM, GenAI spans with usage)");
    }

    // Also wrap non-streaming .create() 
    if (Anthropic?.Messages?.prototype?.create) {
      const origCreate = Anthropic.Messages.prototype.create;

      Anthropic.Messages.prototype.create = function patchedCreate(this: any, body: any, options?: any) {
        const isStream = body?.stream === true;

        // For stream: true, the .stream() wrapper handles it
        if (isStream) {
          return origCreate.call(this, body, options);
        }

        const model = body?.model || "unknown";
        diag(`🔥 create() called (non-stream), model=${model}`);
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

        const result = origCreate.call(this, body, options);

        if (result && typeof result.then === "function") {
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
              try { span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message }); } catch { /* ignore */ }
              span.end();
            }
          );
        }

        // Return ORIGINAL APIPromise — preserves .withResponse()
        return result;
      };

      logger.info("[otel] ✅ Anthropic Messages.create wrapped (ESM, non-streaming)");
    }
  } catch (err) {
    logger.warn(`[otel] Anthropic SDK not available: ${err instanceof Error ? err.message : String(err)}`);
    diag(`Anthropic import failed: ${err}`);
  }

  // ── OpenAI SDK (ESM) ─────────────────────────────────────────────
  try {
    const OPENAI_ESM_PATH = "/home/hrexed/.npm-global/lib/node_modules/openclaw/node_modules/openai/index.mjs";
    const sdk = await import(OPENAI_ESM_PATH);
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
      logger.info("[otel] ✅ OpenAI Chat.Completions.create wrapped (ESM)");
    }
  } catch {
    // Not available — fine
  }

  // ── Bedrock SDK ───────────────────────────────────────────────────
  try {
    const BEDROCK_ESM_PATH = "/home/hrexed/.npm-global/lib/node_modules/openclaw/node_modules/@aws-sdk/client-bedrock-runtime/dist-es/index.js";
    const sdk = await import(BEDROCK_ESM_PATH);
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
      logger.info("[otel] ✅ Bedrock send wrapped (ESM)");
    }
  } catch { /* Not available */ }

  if (patchedCount > 0) {
    logger.info(`[otel] ${patchedCount} LLM SDK(s) instrumented via ESM dynamic import`);
  } else {
    logger.warn("[otel] No LLM SDKs instrumented");
  }
}
