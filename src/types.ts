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
	/** Trigger that fires this contract automatically (v0.3). */
	trigger?: ContractTrigger;
	/** Preferred model for the agent working this contract (v0.6). */
	provider?: "opus" | "sonnet" | "haiku";
	/** Role hint for orchestrators (v0.6). */
	role?: "coordinator" | "worker" | "linter";
	/** Whitelist of MCP server names this contract's worker may access (v0.6). */
	mcpServers?: string[];
}

// ---------------------------------------------------------------------------
// Budget tracking types (v0.6)
// ---------------------------------------------------------------------------

/** A single token usage report, appended to .evalgate/budget.ndjson */
export interface BudgetRecord {
	id: string;
	ts: string; // ISO 8601
	contractId: string;
	tokens: number;
	/** Input token count breakdown (v0.12+) */
	inputTokens?: number;
	/** Output token count breakdown (v0.12+) */
	outputTokens?: number;
	/** Worker id for swarm correlation (v0.12+) */
	workerId?: string;
}

export type Status = "pending" | "passed" | "failed";

export interface ShellVerifier {
	kind: "shell";
	command: string;
	timeoutMs?: number;
}

export interface CompositeVerifier {
	kind: "composite";
	/** "all" — every step must pass; "any" — at least one step must pass */
	mode: "all" | "any";
	steps: ShellVerifier[];
}

/** LLM-judge verifier — calls Claude API to evaluate output quality (v0.8+). */
export interface LlmVerifier {
	kind: "llm";
	/** Prompt sent to the judge model. Should be a yes/no question. */
	prompt: string;
	/** Model id — defaults to claude-haiku-4-5-20251001 */
	model?: string;
}

/** Structural-diff verifier — asserts a pattern is present or absent in a file (v0.14+). */
export interface DiffVerifier {
	kind: "diff";
	/** File path relative to cwd. */
	file: string;
	/** Regex pattern to test against file contents. */
	pattern: string;
	/** "has" = pattern must match; "lacks" = pattern must NOT match. */
	mode: "has" | "lacks";
}

export type Verifier = ShellVerifier | CompositeVerifier | LlmVerifier | DiffVerifier;

// ---------------------------------------------------------------------------
// Trigger types (v0.3)
// ---------------------------------------------------------------------------

export interface ScheduleTrigger {
	kind: "schedule";
	/** 5-field cron expression, e.g. "0 2 * * *" */
	cron: string;
}

export interface WatchTrigger {
	kind: "watch";
	/** Glob pattern relative to todo.md directory, e.g. "src/auth/**" */
	glob: string;
}

export interface WebhookTrigger {
	kind: "webhook";
	/** URL path to listen on, e.g. "/ci-passed" */
	path: string;
}

export type ContractTrigger = ScheduleTrigger | WatchTrigger | WebhookTrigger;

export interface RunResult {
	contract: Contract;
	passed: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
}

// ---------------------------------------------------------------------------
// Durable event log types (v0.4)
// ---------------------------------------------------------------------------

export type TriggerSource =
	| "manual"
	| "schedule"
	| "watch"
	| "webhook"
	| "mcp"
	| "retry"
	| "check-watch";

/** A single persisted run entry written to .evalgate/runs.ndjson */
export interface RunRecord {
	id: string;
	ts: string; // ISO 8601
	contractId: string;
	contractTitle: string;
	trigger: TriggerSource;
	passed: boolean;
	exitCode: number;
	durationMs: number;
	stdout: string;
	stderr: string;
}

export type MessageKind =
	| "completion"
	| "blocker"
	| "review_request"
	| "status_update"
	| "retry_request"
	| "budget_exceeded";

/** A typed envelope for agent-to-agent communication stored in .evalgate/messages.ndjson */
export interface AgentMessage {
	id: string;
	ts: string; // ISO 8601
	from: string; // agent id or "evalgate"
	to: string; // agent id or "*" for broadcast
	kind: MessageKind;
	contractId?: string;
	payload: unknown;
	correlationId?: string; // links request → response chains
}

// ---------------------------------------------------------------------------
// Swarm types (v0.9)
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a single worker process inside a swarm run.
 *
 * State machine:
 *   pending → spawning → running → verifying → merging → done
 *                                                       → failed
 */
export type WorkerStatus =
	| "pending"
	| "spawning"
	| "running"
	| "verifying"
	| "merging"
	| "done"
	| "failed";

/** Persisted record for one agent worker managed by the swarm orchestrator. */
export interface WorkerState {
	/** Short unique id for this worker run. */
	id: string;
	/** The contract this worker is fulfilling. */
	contractId: string;
	contractTitle: string;
	/** Absolute path to the git worktree for this worker. */
	worktreePath: string;
	/** Git branch created for this worker. */
	branch: string;
	/** OS pid of the agent process (set while running). */
	pid?: number;
	status: WorkerStatus;
	startedAt?: string; // ISO 8601
	finishedAt?: string; // ISO 8601
	/** Exit code from the agent process. */
	agentExitCode?: number;
	/** Whether the evalgate verifier passed in the worktree. */
	verifierPassed?: boolean;
	/** Absolute path to the agent session log file. */
	logPath: string;
}

/** Full swarm run state written atomically to .evalgate/swarm-state.json. */
export interface SwarmState {
	/** Unique id for this swarm run. */
	id: string;
	ts: string; // ISO 8601 — when the swarm was started
	todoPath: string;
	workers: WorkerState[];
}

// ---------------------------------------------------------------------------
// Structured swarm event types (v0.12)
// ---------------------------------------------------------------------------

/** Emitted on swarmEvents after the verifier runs for a worker. */
export interface EvalResultEvent {
	type: "eval-result";
	workerId: string;
	contractId: string;
	passed: boolean;
	/** Verifier stdout */
	output: string;
	durationMs: number;
}

/** Emitted on swarmEvents when token usage is reported via reportTokenUsage(). */
export interface CostEvent {
	type: "cost";
	workerId: string;
	contractId: string;
	tokens: { input: number; output: number };
	/** Estimated cost in USD (Sonnet 4 rates: $3/$15 per MTok in/out) */
	estimatedUsd: number;
}

/** Emitted on swarmEvents when a worker reaches a terminal state (done or failed). */
export interface TaskCompleteEvent {
	type: "task-complete";
	workerId: string;
	contractId: string;
	status: "done" | "failed";
}

/** Discriminated union of all structured swarm events (v0.12+). */
export type SwarmEvent = EvalResultEvent | CostEvent | TaskCompleteEvent;

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

// ---------------------------------------------------------------------------
// Gateway types (v0.10)
// ---------------------------------------------------------------------------

export interface GatewayConfig {
	token: string;
	chatId: number;
	todoPath: string;
	concurrency?: number;
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
}

export interface TelegramMessage {
	message_id: number;
	chat: { id: number };
	text?: string;
	date: number;
}
