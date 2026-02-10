/**
 * Security Detection Module for OpenClaw Observability
 * 
 * Implements real-time threat detection patterns:
 * - Detection 1: Sensitive file access (.env, credentials, etc.)
 * - Detection 2: Prompt injection patterns
 * - Detection 3: Dangerous command execution
 * - Detection 4: Token spike anomaly (via metrics, alert in Dynatrace)
 */

import { SpanStatusCode, type Span } from "@opentelemetry/api";
import type { Counter } from "@opentelemetry/api";

// ═══════════════════════════════════════════════════════════════════
// DETECTION PATTERNS
// ═══════════════════════════════════════════════════════════════════

/** Detection 1: Sensitive file patterns */
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/i,
  /\.env\./i,
  /openclaw\.json$/i,
  /\.ssh\//i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials/i,
  /\.aws\/credentials/i,
  /\.kube\/config/i,
  /\.docker\/config\.json/i,
  /\.netrc/i,
  /\.pgpass/i,
  /\.my\.cnf/i,
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
];

/** Detection 2: Prompt injection patterns */
const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous/i,
  /ignore\s+(your\s+)?instructions/i,
  /disregard\s+(all\s+)?prior/i,
  /forget\s+everything/i,
  /new\s+instructions/i,
  /\[SYSTEM\]/i,
  /\[ADMIN\]/i,
  /\[OVERRIDE\]/i,
  /SYSTEM:/i,
  /<<<\s*SYSTEM/i,
  /you\s+are\s+now\s+/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+if/i,
  /roleplay\s+as/i,
  /bypass\s+(your\s+)?(safety|security|restrictions)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
];

/** Detection 3: Dangerous command patterns */
const DANGEROUS_COMMAND_PATTERNS: Array<{ pattern: RegExp; severity: Severity; desc: string }> = [
  // Data exfiltration
  { pattern: /\bcurl\b.*(-d|--data|-F|--form)/i, severity: "critical", desc: "curl with data upload" },
  { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)/i, severity: "critical", desc: "curl piped to shell" },
  { pattern: /\bwget\b.*-O\s*-\s*\|/i, severity: "critical", desc: "wget piped to shell" },
  { pattern: /\bnc\b.*-e/i, severity: "critical", desc: "netcat reverse shell" },
  { pattern: /\bnetcat\b/i, severity: "high", desc: "netcat usage" },
  
  // Destructive commands
  { pattern: /\brm\s+(-rf?|--recursive).*\//i, severity: "critical", desc: "recursive delete" },
  { pattern: /\brm\s+-rf?\s+\//i, severity: "critical", desc: "rm on root path" },
  { pattern: />\s*\/dev\/sd/i, severity: "critical", desc: "overwrite disk device" },
  { pattern: /\bmkfs\b/i, severity: "critical", desc: "filesystem format" },
  { pattern: /\bdd\b.*of=\/dev/i, severity: "critical", desc: "dd to device" },
  
  // Permission/privilege
  { pattern: /\bchmod\s+777\b/i, severity: "high", desc: "chmod 777 (world-writable)" },
  { pattern: /\bchmod\s+\+s\b/i, severity: "critical", desc: "setuid bit" },
  { pattern: /\bsudo\b/i, severity: "warning", desc: "sudo usage" },
  { pattern: /\bsu\s+-\s*$/i, severity: "warning", desc: "switch to root" },
  
  // Crypto/mining
  { pattern: /\bxmrig\b/i, severity: "critical", desc: "crypto miner" },
  { pattern: /stratum\+tcp/i, severity: "critical", desc: "mining pool connection" },
  
  // Persistence
  { pattern: /crontab\s+-e/i, severity: "high", desc: "crontab edit" },
  { pattern: /\/etc\/cron/i, severity: "high", desc: "cron directory access" },
  { pattern: /systemctl\s+(enable|start)/i, severity: "warning", desc: "systemd service modification" },
  { pattern: /\.bashrc|\.zshrc|\.profile/i, severity: "warning", desc: "shell profile modification" },
];

// ═══════════════════════════════════════════════════════════════════
// DETECTION TYPES
// ═══════════════════════════════════════════════════════════════════

export type Severity = "critical" | "high" | "warning" | "info";

export interface SecurityEvent {
  detection: string;
  severity: Severity;
  description: string;
  sessionKey: string;
  agentId?: string;
  timestamp: number;
  details: Record<string, any>;
}

export interface SecurityCounters {
  securityEvents: Counter;
  sensitiveFileAccess: Counter;
  promptInjection: Counter;
  dangerousCommand: Counter;
}

// ═══════════════════════════════════════════════════════════════════
// DETECTION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Detection 1: Check if a file path matches sensitive patterns
 */
export function detectSensitiveFileAccess(
  filePath: string
): { detected: boolean; severity: Severity; pattern?: string } {
  const normalizedPath = filePath.toLowerCase();
  
  for (const pattern of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return {
        detected: true,
        severity: "critical",
        pattern: pattern.source,
      };
    }
  }
  
  return { detected: false, severity: "info" };
}

/**
 * Detection 2: Check message for prompt injection patterns
 */
export function detectPromptInjection(
  message: string
): { detected: boolean; severity: Severity; patterns: string[] } {
  const matchedPatterns: string[] = [];
  
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      matchedPatterns.push(pattern.source);
    }
  }
  
  return {
    detected: matchedPatterns.length > 0,
    severity: matchedPatterns.length > 2 ? "critical" : "high",
    patterns: matchedPatterns,
  };
}

/**
 * Detection 3: Check command for dangerous patterns
 */
export function detectDangerousCommand(
  command: string
): { detected: boolean; severity: Severity; matches: Array<{ pattern: string; desc: string; severity: Severity }> } {
  const matches: Array<{ pattern: string; desc: string; severity: Severity }> = [];
  
  for (const { pattern, severity, desc } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      matches.push({ pattern: pattern.source, desc, severity });
    }
  }
  
  // Return highest severity found
  let highestSeverity: Severity = "info";
  if (matches.some(m => m.severity === "critical")) highestSeverity = "critical";
  else if (matches.some(m => m.severity === "high")) highestSeverity = "high";
  else if (matches.some(m => m.severity === "warning")) highestSeverity = "warning";
  
  return {
    detected: matches.length > 0,
    severity: highestSeverity,
    matches,
  };
}

// ═══════════════════════════════════════════════════════════════════
// SPAN ENRICHMENT
// ═══════════════════════════════════════════════════════════════════

/**
 * Add security event attributes to a span
 */
export function enrichSpanWithSecurityEvent(
  span: Span,
  event: SecurityEvent
): void {
  span.setAttribute("security.event.detected", true);
  span.setAttribute("security.event.detection", event.detection);
  span.setAttribute("security.event.severity", event.severity);
  span.setAttribute("security.event.description", event.description);
  span.setAttribute("security.event.timestamp", event.timestamp);
  
  // Set span status based on severity
  if (event.severity === "critical" || event.severity === "high") {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `Security: ${event.detection} - ${event.description}`,
    });
  }
  
  // Add event as span event (visible in trace timeline)
  span.addEvent("security.alert", {
    "security.detection": event.detection,
    "security.severity": event.severity,
    "security.description": event.description,
  });
}

/**
 * Check tool call and enrich span with security detection if matched
 */
export function checkToolSecurity(
  toolName: string,
  toolInput: any,
  span: Span,
  counters: SecurityCounters,
  sessionKey: string,
  agentId?: string
): SecurityEvent | null {
  const timestamp = Date.now();
  
  // Detection 1: Sensitive file access (Read, Write, Edit tools)
  if (["Read", "read", "Write", "write", "Edit", "edit"].includes(toolName)) {
    const filePath = toolInput?.path || toolInput?.file_path || toolInput?.filePath || "";
    const detection = detectSensitiveFileAccess(filePath);
    
    if (detection.detected) {
      const event: SecurityEvent = {
        detection: "sensitive_file_access",
        severity: detection.severity,
        description: `Access to sensitive file: ${filePath}`,
        sessionKey,
        agentId,
        timestamp,
        details: {
          tool: toolName,
          filePath,
          matchedPattern: detection.pattern,
        },
      };
      
      enrichSpanWithSecurityEvent(span, event);
      counters.securityEvents.add(1, { detection: "sensitive_file_access", severity: detection.severity });
      counters.sensitiveFileAccess.add(1, { file_pattern: detection.pattern || "unknown" });
      
      return event;
    }
  }
  
  // Detection 3: Dangerous command execution
  if (["exec", "Exec"].includes(toolName)) {
    const command = toolInput?.command || "";
    const detection = detectDangerousCommand(command);
    
    if (detection.detected) {
      const event: SecurityEvent = {
        detection: "dangerous_command",
        severity: detection.severity,
        description: detection.matches.map(m => m.desc).join(", "),
        sessionKey,
        agentId,
        timestamp,
        details: {
          tool: toolName,
          command: command.slice(0, 500), // Truncate for safety
          matches: detection.matches,
        },
      };
      
      enrichSpanWithSecurityEvent(span, event);
      counters.securityEvents.add(1, { detection: "dangerous_command", severity: detection.severity });
      counters.dangerousCommand.add(1, { command_type: detection.matches[0]?.desc || "unknown" });
      
      return event;
    }
  }
  
  return null;
}

/**
 * Check message content for prompt injection
 */
export function checkMessageSecurity(
  messageContent: string,
  span: Span,
  counters: SecurityCounters,
  sessionKey: string
): SecurityEvent | null {
  const detection = detectPromptInjection(messageContent);
  
  if (detection.detected) {
    const event: SecurityEvent = {
      detection: "prompt_injection",
      severity: detection.severity,
      description: `Potential prompt injection: ${detection.patterns.length} patterns matched`,
      sessionKey,
      timestamp: Date.now(),
      details: {
        patternsMatched: detection.patterns,
        messagePreview: messageContent.slice(0, 200),
      },
    };
    
    enrichSpanWithSecurityEvent(span, event);
    counters.securityEvents.add(1, { detection: "prompt_injection", severity: detection.severity });
    counters.promptInjection.add(1, { pattern_count: String(detection.patterns.length) });
    
    return event;
  }
  
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// DYNATRACE METRIC QUERIES (for Detection 4: Token Spike)
// ═══════════════════════════════════════════════════════════════════

/**
 * Dynatrace metric selector for token spike detection.
 * Use this in Dynatrace Custom Events / Metric Alerts.
 * 
 * Detection 4: Token Spike Anomaly
 * Metric: openclaw.llm.tokens.total
 * Condition: rate(5m) > 3x avg(rate(1h), offset=1d)
 * 
 * DQL Query for Dynatrace:
 * ```
 * timeseries usage = sum(openclaw.llm.tokens.total), by:{gen_ai.response.model}
 * | fieldsAdd baseline = rollup(avg, 1h, offset:-1d)
 * | fieldsAdd current = rollup(sum, 5m)
 * | filter current > baseline * 3
 * ```
 */
export const DYNATRACE_TOKEN_SPIKE_QUERY = `
timeseries {
  current = sum(openclaw.llm.tokens.total),
  baseline = sum(openclaw.llm.tokens.total, shift:-1d)
}
| fieldsAdd spike_ratio = current / baseline
| filter spike_ratio > 3
| summarize alert_count = count()
`.trim();

/**
 * Dynatrace metric event configuration for security alerts.
 * Import this as JSON in Dynatrace Settings > Anomaly Detection > Metric Events.
 */
export const DYNATRACE_SECURITY_METRIC_EVENTS = {
  sensitiveFileAccess: {
    name: "OpenClaw: Sensitive File Access",
    description: "Detects attempts to access sensitive files like .env, credentials, SSH keys",
    metricSelector: "openclaw.security.sensitive_file_access:count",
    threshold: 0,
    operator: "ABOVE",
    severity: "CRITICAL",
  },
  promptInjection: {
    name: "OpenClaw: Prompt Injection Attempt",
    description: "Detects potential prompt injection patterns in user messages",
    metricSelector: "openclaw.security.prompt_injection:count",
    threshold: 0,
    operator: "ABOVE",
    severity: "HIGH",
  },
  dangerousCommand: {
    name: "OpenClaw: Dangerous Command Execution",
    description: "Detects dangerous shell commands like rm -rf, curl exfiltration",
    metricSelector: "openclaw.security.dangerous_command:count",
    threshold: 0,
    operator: "ABOVE",
    severity: "HIGH",
  },
  tokenSpike: {
    name: "OpenClaw: Token Usage Spike",
    description: "Detects sudden spikes in token usage (3x baseline)",
    metricSelector: "openclaw.llm.tokens.total:rate(5m)",
    threshold: "3x avg(1h offset 1d)",
    operator: "ABOVE",
    severity: "WARNING",
  },
};
