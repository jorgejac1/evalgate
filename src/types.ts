/**
 * A Contract is a single todo item with a verifier. The agent cannot mark
 * it complete until the verifier passes.
 */
export interface Contract {
  /** Stable slug, derived from title or explicit `id:` field. */
  id: string;
  /** The checkbox text, trimmed. */
  title: string;
  /** Current checkbox state in the source file. */
  checked: boolean;
  /** Current semantic status. */
  status: Status;
  /** Verifier to run; undefined contracts are ungated. */
  verifier?: Verifier;
  /** Max retries allowed after a failure. */
  retries?: number;
  /** Optional token budget hint, in tokens. */
  budget?: number;
  /** 0-indexed line of the checkbox in the source file. */
  line: number;
  /** All source lines belonging to this contract (checkbox + sub-bullets). */
  rawLines: number[];
}

export type Status = "pending" | "passed" | "failed";

export interface ShellVerifier {
  kind: "shell";
  command: string;
  timeoutMs?: number;
}

/** Reserved for future use (v0.2+). */
export interface CompositeVerifier {
  kind: "composite";
  all: ShellVerifier[];
}

export type Verifier = ShellVerifier | CompositeVerifier;

export interface RunResult {
  contract: Contract;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// MCP protocol types (v0.2)
// ---------------------------------------------------------------------------

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpCapabilities {
  tools?: Record<string, never>;
}
