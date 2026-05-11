/**
 * OpenTelemetry attribute keys used by this plugin.
 *
 * Centralised so the same constant is referenced on spans, metrics, and docs,
 * and so a future Weaver-generated schema can replace this file without
 * touching every call site.
 *
 * References:
 *   - gen_ai.* stable conventions (GenAI agents / tools / tokens)
 *   - exception.* / error.type (general conventions)
 *   - code.* (general conventions)
 *   - openclaw.* keys are plugin-domain attributes not covered by OTel semconv;
 *     they are kept as legacy mirrors alongside the standard gen_ai.* keys to
 *     preserve existing Dynatrace dashboards during the rollout window.
 */

// ── GenAI stable attribute keys ─────────────────────────────────────
export const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
export const GEN_AI_PROVIDER_NAME = "gen_ai.provider.name";
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
export const GEN_AI_REQUEST_MAX_TOKENS = "gen_ai.request.max_tokens";
export const GEN_AI_REQUEST_STREAM = "gen_ai.request.stream";
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
export const GEN_AI_RESPONSE_ID = "gen_ai.response.id";
export const GEN_AI_RESPONSE_FINISH_REASONS = "gen_ai.response.finish_reasons";
export const GEN_AI_CONVERSATION_ID = "gen_ai.conversation.id";
export const GEN_AI_AGENT_ID = "gen_ai.agent.id";
export const GEN_AI_AGENT_NAME = "gen_ai.agent.name";
export const GEN_AI_TOOL_NAME = "gen_ai.tool.name";
export const GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id";
export const GEN_AI_TOOL_TYPE = "gen_ai.tool.type";
export const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
export const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
/** Stable cache attributes (OTel GenAI semconv 2026-04). */
export const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read.input_tokens";
export const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  "gen_ai.usage.cache_creation.input_tokens";
/** Used on `gen_ai.client.token.usage` histogram to distinguish input / output. */
export const GEN_AI_TOKEN_TYPE = "gen_ai.token.type";

// ── GenAI operation name values ─────────────────────────────────────
export const OP_INVOKE_AGENT = "invoke_agent";
export const OP_EXECUTE_TOOL = "execute_tool";
export const OP_CHAT = "chat";

// ── GenAI stable metric names ───────────────────────────────────────
export const METRIC_TOKEN_USAGE = "gen_ai.client.token.usage";
export const METRIC_OPERATION_DURATION = "gen_ai.client.operation.duration";

// ── GenAI span name helpers ─────────────────────────────────────────
export const spanNameInvokeAgent = (agentName: string): string =>
  `${OP_INVOKE_AGENT} ${agentName}`;
export const spanNameChat = (modelName: string): string => `${OP_CHAT} ${modelName}`;
export const spanNameExecuteTool = (toolName: string): string =>
  `${OP_EXECUTE_TOOL} ${toolName}`;

// ── Error / exception conventions ───────────────────────────────────
export const ERROR_TYPE = "error.type";

// ── Code conventions ────────────────────────────────────────────────
/** Stable: fully-qualified function identifier, e.g. `namespace.function`. */
export const CODE_FUNCTION_NAME = "code.function.name";
/** Stable: repo-relative source file path of the emit site. */
export const CODE_FILE_PATH = "code.file.path";
/** Stable: line number within {@link CODE_FILE_PATH} of the emit site. */
export const CODE_LINE_NUMBER = "code.line.number";

// ── General attribute keys ──────────────────────────────────────────
/**
 * Stable general OTel attribute for the end-user id (`user.id`). Plugin
 * code mirrors this from {@link OC_SESSION_KEY}'s user id so consumers
 * outside the openclaw namespace can correlate sessions on a registry
 * key, while the `openclaw.session.user_id` legacy key keeps existing
 * dashboards working.
 */
export const ATTR_USER_ID = "user.id";

/**
 * OpenTelemetry semantic-conventions schema URL emitted on the plugin's
 * Resource (ISI-995). Pinned to the version of
 * `@opentelemetry/semantic-conventions` declared in `package.json`.
 *
 * When upgrading the semconv dependency, bump this constant in lockstep
 * — the schema URL on the Resource is what tells downstream backends
 * which generation of OTel attribute names this plugin emits.
 */
export const OTEL_SCHEMA_URL = "https://opentelemetry.io/schemas/1.39.0";

// ── Plugin-domain (legacy) attribute keys ───────────────────────────
export const OC_AGENT_ID = "openclaw.agent.id";
export const OC_AGENT_MODEL = "openclaw.agent.model";
export const OC_AGENT_DURATION_MS = "openclaw.agent.duration_ms";
export const OC_AGENT_SUCCESS = "openclaw.agent.success";
export const OC_AGENT_ERROR = "openclaw.agent.error";
export const OC_SESSION_KEY = "openclaw.session.key";
export const OC_TOOL_NAME = "openclaw.tool.name";
export const OC_TOOL_CALL_ID = "openclaw.tool.call_id";
export const OC_TOOL_IS_SYNTHETIC = "openclaw.tool.is_synthetic";
export const OC_TOOL_RESULT_CHARS = "openclaw.tool.result_chars";
export const OC_TOOL_RESULT_PARTS = "openclaw.tool.result_parts";
export const OC_TOOL_INPUT_PREVIEW = "openclaw.tool.input_preview";
/**
 * Tool-approval attributes live in the plugin-domain namespace because the
 * OTel `gen_ai.*` namespace is reserved for the registry. Renamed from the
 * former `gen_ai.tool.approval.*` keys in schema 1.1.0 (breaking change).
 */
export const OPENCLAW_TOOL_APPROVAL_REQUESTED = "openclaw.tool.approval.requested";
export const OPENCLAW_TOOL_APPROVAL_RESOLUTION = "openclaw.tool.approval.resolution";
export const OPENCLAW_TOOL_APPROVAL_DURATION_MS = "openclaw.tool.approval.duration_ms";
export const OC_MESSAGE_CHANNEL = "openclaw.message.channel";
export const OC_MESSAGE_DIRECTION = "openclaw.message.direction";
export const OC_MESSAGE_FROM = "openclaw.message.from";
export const OC_REQUEST_DURATION_MS = "openclaw.request.duration_ms";
export const OC_LLM_COST_USD = "openclaw.llm.cost_usd";
export const OC_CONTEXT_LIMIT = "openclaw.context.limit";
export const OC_CONTEXT_USED = "openclaw.context.used";
export const OC_PROVIDER = "openclaw.provider";
export const OC_SCHEMA_VERSION = "openclaw.schema.version";
export const OC_SUBAGENT_PARENT_SESSION = "openclaw.subagent.parent_session_key";
export const OC_SUBAGENT_CHILD_SESSION = "openclaw.subagent.child_session_key";
export const OC_SUBAGENT_CHILD_AGENT_ID = "openclaw.subagent.child_agent_id";
export const OC_SUBAGENT_CHILD_AGENT_NAME = "openclaw.subagent.child_agent_name";
export const OC_SUBAGENT_SPAWN_REASON = "openclaw.subagent.spawn_reason";
export const OC_SUBAGENT_DELIVERY_TYPE = "openclaw.subagent.delivery_type";
export const OC_SUBAGENT_SUCCESS = "openclaw.subagent.success";
export const OC_SUBAGENT_DURATION_MS = "openclaw.subagent.duration_ms";
export const OC_CRON_JOB_NAME = "openclaw.cron.job_name";
export const OC_CRON_ACTION = "openclaw.cron.action";
export const OC_CRON_TRIGGER = "openclaw.cron.trigger";
export const OC_CRON_EXPRESSION = "openclaw.cron.expression";
export const OC_CRON_DURATION_MS = "openclaw.cron.duration_ms";
export const OC_CRON_SUCCESS = "openclaw.cron.success";
export const OC_CRON_AGENT_ID = "openclaw.cron.agent_id";

/**
 * Schema version for plugin-domain attributes. Bump when emitted
 * attribute keys or values change in a way that consumers need to know.
 *
 * `1.3.0` — Closes the OTel GenAI / code semconv 2026-04 dual-emit
 * window opened in `1.2.0`. The following legacy keys are no longer
 * emitted (consumers must use the stable replacements shipped in
 * `1.2.0`):
 *
 * | Removed (1.3.0)                       | Stable replacement                                                       |
 * | ------------------------------------- | ------------------------------------------------------------------------ |
 * | `gen_ai.system`                       | `gen_ai.provider.name`                                                   |
 * | `code.function` + `code.namespace`    | `code.function.name` + `code.file.path`                                  |
 * | `gen_ai.usage.cache_read_tokens`      | `gen_ai.usage.cache_read.input_tokens`                                   |
 * | `gen_ai.usage.cache_write_tokens`     | `gen_ai.usage.cache_creation.input_tokens`                               |
 * | `gen_ai.usage.total_tokens`           | none — consumers compute `input + output` (per `1.2.0` deprecation note) |
 */
export const OPENCLAW_SCHEMA_VERSION = "1.3.0";

// ── Token type values ───────────────────────────────────────────────
export const TOKEN_TYPE_INPUT = "input";
export const TOKEN_TYPE_OUTPUT = "output";
