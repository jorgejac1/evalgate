/**
 * evalgate MCP server — v0.2
 *
 * Implements the Model Context Protocol over stdio (JSON-RPC 2.0).
 * Zero runtime dependencies: reads stdin line-by-line, writes to stdout.
 * All debug/log output goes to stderr so it never pollutes the protocol stream.
 *
 * Tools exposed:
 *   list_pending    — return all unchecked contracts with verifiers
 *   run_eval        — run a single contract by id
 *   check_all       — run all pending contracts
 *   get_retry_context — return failure context for a failed contract
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getBudgetSummary, getTotalTokens, reportTokenUsage } from "./budget.js";
import { getLastFailure, queryRuns } from "./log.js";
import { detectPatterns, exportSnapshot, suggest } from "./memory.js";
import { listMessages, sendMessage } from "./messages.js";
import { parseTodo } from "./parser.js";
import type {
	Contract,
	McpJsonRpcRequest,
	McpJsonRpcResponse,
	McpToolDefinition,
	RunResult,
} from "./types.js";
import { runContract } from "./verifier.js";
import { updateTodo } from "./writer.js";

// ---------------------------------------------------------------------------
// Tool manifest
// ---------------------------------------------------------------------------

const TOOLS: McpToolDefinition[] = [
	{
		name: "list_triggers",
		description:
			"List all contracts that have an automatic trigger (schedule, watch, or webhook). Shows what will fire without manual intervention.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
		},
	},
	{
		name: "list_all",
		description:
			"List all contracts in the todo.md file — checked and unchecked, with and without verifiers. Shows current status of the full project.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
		},
	},
	{
		name: "list_pending",
		description: "List all unchecked contracts that have an eval verifier in the todo.md file.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
		},
	},
	{
		name: "run_eval",
		description:
			"Run the verifier for a single contract identified by its id or title slug. Returns pass/fail and full output.",
		inputSchema: {
			type: "object",
			properties: {
				contract_id: {
					type: "string",
					description: "The contract id (slug) or exact title to run.",
				},
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
			required: ["contract_id"],
		},
	},
	{
		name: "check_all",
		description:
			"Run verifiers for all pending (unchecked) contracts in the todo.md file. Updates checkboxes for contracts that pass.",
		inputSchema: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
		},
	},
	{
		name: "get_retry_context",
		description:
			"Return the full failure output from the last run of a contract, formatted for an agent to read and retry.",
		inputSchema: {
			type: "object",
			properties: {
				contract_id: {
					type: "string",
					description: "The contract id (slug) or exact title.",
				},
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
			required: ["contract_id"],
		},
	},
	{
		name: "get_run_history",
		description:
			"Return the run history for all contracts or a specific contract from the durable log.",
		inputSchema: {
			type: "object",
			properties: {
				contract_id: {
					type: "string",
					description: "Filter by contract id. Omit for all contracts.",
				},
				failed_only: {
					type: "boolean",
					description: "If true, return only failed runs.",
				},
				limit: {
					type: "number",
					description: "Max records to return (default 20).",
				},
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
		},
	},
	{
		name: "get_last_failure",
		description:
			"Return the most recent failed run record for a contract. Useful for understanding why a contract keeps failing.",
		inputSchema: {
			type: "object",
			properties: {
				contract_id: {
					type: "string",
					description: "The contract id (slug).",
				},
				path: {
					type: "string",
					description: "Path to todo.md. Defaults to ./todo.md.",
				},
			},
			required: ["contract_id"],
		},
	},
	{
		name: "send_message",
		description:
			"Send a typed message to another agent. Messages are persisted in .evalgate/messages.ndjson.",
		inputSchema: {
			type: "object",
			properties: {
				from: { type: "string", description: "Sender agent id." },
				to: { type: "string", description: "Recipient agent id or '*' for broadcast." },
				kind: {
					type: "string",
					description:
						"Message kind: completion | blocker | review_request | status_update | retry_request",
				},
				payload: { type: "string", description: "JSON string payload." },
				contract_id: { type: "string", description: "Optional contract this message relates to." },
				correlation_id: { type: "string", description: "Optional id to link related messages." },
				path: { type: "string", description: "Path to todo.md. Defaults to ./todo.md." },
			},
			required: ["from", "to", "kind"],
		},
	},
	{
		name: "list_messages",
		description:
			"List agent messages from the durable log, optionally filtered by recipient or kind.",
		inputSchema: {
			type: "object",
			properties: {
				to: { type: "string", description: "Filter by recipient agent id." },
				kind: { type: "string", description: "Filter by message kind." },
				limit: { type: "number", description: "Max messages to return (default 20)." },
				path: { type: "string", description: "Path to todo.md. Defaults to ./todo.md." },
			},
		},
	},
	{
		name: "get_provider_hints",
		description:
			"Return provider routing hints for all contracts: preferred model (opus/sonnet/haiku), role (coordinator/worker/linter), allowed MCP servers, and budget. Orchestrators use this to route the right model to each task.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to todo.md. Defaults to ./todo.md." },
			},
		},
	},
	{
		name: "suggest_template",
		description:
			"Given a task title, find the most similar past successful completions using trigram similarity. Returns ranked suggestions with verifier commands to reuse as templates.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Task title to find similar completions for." },
				limit: { type: "number", description: "Max suggestions to return (default 5)." },
				path: { type: "string", description: "Path to todo.md. Defaults to ./todo.md." },
			},
			required: ["query"],
		},
	},
	{
		name: "get_patterns",
		description:
			"Analyze run history for systemic failure patterns: contracts with high failure rates, flaky contracts, and common error messages.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to todo.md. Defaults to ./todo.md." },
			},
		},
	},
	{
		name: "export_state",
		description:
			"Export the full project state as a JSON snapshot: contracts, run history, budget, messages, and failure patterns.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path to todo.md. Defaults to ./todo.md." },
			},
		},
	},
	{
		name: "report_token_usage",
		description:
			"Report how many tokens were consumed working on a contract. Greenlight persists this in .evalgate/budget.ndjson and emits a budget_exceeded message if the contract's budget is breached.",
		inputSchema: {
			type: "object",
			properties: {
				contract_id: { type: "string", description: "The contract id (slug)." },
				tokens: { type: "number", description: "Number of tokens used in this session." },
				path: { type: "string", description: "Path to todo.md. Defaults to ./todo.md." },
			},
			required: ["contract_id", "tokens"],
		},
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTodoPath(raw: unknown, serverCwd: string): string {
	const p = typeof raw === "string" && raw.trim() ? raw.trim() : "todo.md";
	return resolve(serverCwd, p);
}

function loadContracts(
	todoPath: string,
): { source: string; contracts: Contract[] } | { error: string } {
	if (!existsSync(todoPath)) {
		return { error: `todo.md not found: ${todoPath}` };
	}
	const source = readFileSync(todoPath, "utf8");
	return { source, contracts: parseTodo(source) };
}

function findContract(contracts: Contract[], contractId: string): Contract | undefined {
	const normalized = contractId.trim().toLowerCase();
	return contracts.find((c) => c.id === normalized || c.title.toLowerCase() === normalized);
}

function formatResult(result: RunResult): Record<string, unknown> {
	return {
		id: result.contract.id,
		title: result.contract.title,
		passed: result.passed,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		stdout: result.stdout.slice(0, 4000),
		stderr: result.stderr.slice(0, 4000),
	};
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

type Params = Record<string, unknown>;

async function handleListTriggers(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	const triggered = loaded.contracts.filter((c) => c.trigger);
	return {
		count: triggered.length,
		contracts: triggered.map((c) => ({
			id: c.id,
			title: c.title,
			checked: c.checked,
			trigger: c.trigger,
			verifier: c.verifier?.kind === "shell" ? c.verifier.command : c.verifier ? "composite" : null,
		})),
	};
}

async function handleListAll(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	return {
		count: loaded.contracts.length,
		contracts: loaded.contracts.map((c) => ({
			id: c.id,
			title: c.title,
			status: c.checked ? "done" : c.verifier ? "pending" : "ungated",
			verifier: c.verifier?.kind === "shell" ? c.verifier.command : c.verifier ? "composite" : null,
			retries: c.retries,
			budget: c.budget,
		})),
	};
}

async function handleListPending(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	const pending = loaded.contracts.filter((c) => !c.checked && c.verifier);
	return {
		count: pending.length,
		contracts: pending.map((c) => ({
			id: c.id,
			title: c.title,
			verifier: c.verifier?.kind === "shell" ? c.verifier.command : "composite",
			retries: c.retries,
			budget: c.budget,
		})),
	};
}

async function handleRunEval(params: Params, serverCwd: string): Promise<unknown> {
	const contractId = params.contract_id;
	if (typeof contractId !== "string" || !contractId.trim()) {
		return { error: "contract_id is required" };
	}
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	const contract = findContract(loaded.contracts, contractId);
	if (!contract) {
		return { error: `contract not found: ${contractId}` };
	}
	if (!contract.verifier) {
		return { error: `contract '${contractId}' has no verifier` };
	}

	const cwd = resolve(dirname(todoPath));
	const result = await runContract(contract, cwd, { todoPath, trigger: "mcp" });

	// Flip the checkbox if it passed
	if (result.passed) {
		const updated = updateTodo(loaded.source, [result]);
		if (updated !== loaded.source) {
			writeFileSync(todoPath, updated);
		}
	}

	return formatResult(result);
}

async function handleCheckAll(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	const pending = loaded.contracts.filter((c) => !c.checked && c.verifier);
	if (pending.length === 0) {
		return { count: 0, results: [] };
	}

	const cwd = resolve(dirname(todoPath));
	const results: RunResult[] = [];
	for (const contract of pending) {
		results.push(await runContract(contract, cwd, { todoPath, trigger: "mcp" }));
	}

	const updated = updateTodo(loaded.source, results);
	if (updated !== loaded.source) {
		writeFileSync(todoPath, updated);
	}

	return {
		count: results.length,
		passed: results.filter((r) => r.passed).length,
		failed: results.filter((r) => !r.passed).length,
		results: results.map(formatResult),
	};
}

async function handleGetRetryContext(params: Params, serverCwd: string): Promise<unknown> {
	const contractId = params.contract_id;
	if (typeof contractId !== "string" || !contractId.trim()) {
		return { error: "contract_id is required" };
	}
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	const contract = findContract(loaded.contracts, contractId);
	if (!contract) {
		return { error: `contract not found: ${contractId}` };
	}

	// Run the verifier now to get fresh failure context
	if (!contract.verifier) {
		return { error: `contract '${contractId}' has no verifier` };
	}

	const cwd = resolve(dirname(todoPath));
	const result = await runContract(contract, cwd, { todoPath, trigger: "retry" });

	if (result.passed) {
		return {
			message: `Contract '${contract.title}' now passes — no retry needed.`,
			passed: true,
		};
	}

	const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
	return {
		passed: false,
		context: [
			`Contract: ${contract.title} (${contract.id})`,
			`Verifier: ${contract.verifier.kind === "shell" ? contract.verifier.command : "composite"}`,
			`Exit code: ${result.exitCode}`,
			`Duration: ${result.durationMs}ms`,
			"",
			"--- Failure output ---",
			combined || "(no output)",
		].join("\n"),
	};
}

async function handleGetRunHistory(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const contractId = typeof params.contract_id === "string" ? params.contract_id : undefined;
	const failedOnly = params.failed_only === true;
	const limit = typeof params.limit === "number" ? params.limit : 20;

	const records = queryRuns(todoPath, {
		contractId,
		passed: failedOnly ? false : undefined,
		limit,
	});

	return { count: records.length, records };
}

async function handleGetLastFailure(params: Params, serverCwd: string): Promise<unknown> {
	const contractId = params.contract_id;
	if (typeof contractId !== "string" || !contractId.trim()) {
		return { error: "contract_id is required" };
	}
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const record = getLastFailure(todoPath, contractId.trim());
	return record ?? { error: `no failure records found for: ${contractId}` };
}

const VALID_MESSAGE_KINDS = new Set([
	"completion",
	"blocker",
	"review_request",
	"status_update",
	"retry_request",
	"budget_exceeded",
]);

async function handleSendMessage(params: Params, serverCwd: string): Promise<unknown> {
	const from = typeof params.from === "string" ? params.from : undefined;
	const to = typeof params.to === "string" ? params.to : undefined;
	const kind = typeof params.kind === "string" ? params.kind : undefined;
	const contract_id = typeof params.contract_id === "string" ? params.contract_id : undefined;
	const correlation_id =
		typeof params.correlation_id === "string" ? params.correlation_id : undefined;

	if (!from || !to || !kind) {
		return { error: "from, to, and kind are required" };
	}
	if (!VALID_MESSAGE_KINDS.has(kind)) {
		return {
			error: `invalid kind: "${kind}". Must be one of: ${[...VALID_MESSAGE_KINDS].join(", ")}`,
		};
	}
	const todoPath = resolveTodoPath(params.path, serverCwd);
	let payload: unknown = null;
	if (typeof params.payload === "string") {
		try {
			payload = JSON.parse(params.payload);
		} catch {
			payload = params.payload;
		}
	} else if (params.payload !== undefined) {
		payload = params.payload;
	}
	const msg = sendMessage(todoPath, {
		from,
		to,
		kind: kind as Parameters<typeof sendMessage>[1]["kind"],
		payload,
		contractId: contract_id,
		correlationId: correlation_id,
	});
	return msg;
}

async function handleSuggestTemplate(params: Params, serverCwd: string): Promise<unknown> {
	const query = params.query;
	if (typeof query !== "string" || !query.trim()) {
		return { error: "query is required" };
	}
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const limit = typeof params.limit === "number" ? params.limit : 5;
	const results = suggest(todoPath, query.trim(), limit);
	return { query, count: results.length, suggestions: results };
}

async function handleGetPatterns(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const patterns = detectPatterns(todoPath);
	return { count: patterns.length, patterns };
}

async function handleExportState(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	return exportSnapshot(todoPath);
}

async function handleGetProviderHints(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	const summary = getBudgetSummary(todoPath, loaded.contracts);
	const usageById = new Map(summary.map((s) => [s.contractId, s]));

	return {
		count: loaded.contracts.length,
		contracts: loaded.contracts.map((c) => {
			const usage = usageById.get(c.id);
			return {
				id: c.id,
				title: c.title,
				status: c.checked ? "done" : c.verifier ? "pending" : "ungated",
				provider: c.provider ?? null,
				role: c.role ?? null,
				mcpServers: c.mcpServers ?? null,
				budget: c.budget ?? null,
				tokensUsed: usage?.used ?? 0,
				budgetExceeded: usage?.exceeded ?? false,
			};
		}),
	};
}

async function handleReportTokenUsage(params: Params, serverCwd: string): Promise<unknown> {
	const contractId = params.contract_id;
	const tokens = params.tokens;

	if (typeof contractId !== "string" || !contractId.trim()) {
		return { error: "contract_id is required" };
	}
	if (typeof tokens !== "number" || tokens < 0) {
		return { error: "tokens must be a non-negative number" };
	}

	const todoPath = resolveTodoPath(params.path, serverCwd);
	const loaded = loadContracts(todoPath);
	if ("error" in loaded) return { error: loaded.error };

	const contract = findContract(loaded.contracts, contractId);
	const record = reportTokenUsage(todoPath, contractId, tokens, contract);
	const total = getTotalTokens(todoPath, contractId);

	return {
		recorded: record,
		totalTokens: total,
		budget: contract?.budget ?? null,
		budgetExceeded: contract?.budget !== undefined && total > contract.budget,
	};
}

async function handleListMessages(params: Params, serverCwd: string): Promise<unknown> {
	const todoPath = resolveTodoPath(params.path, serverCwd);
	const to = typeof params.to === "string" ? params.to : undefined;
	const kind = typeof params.kind === "string" ? params.kind : undefined;
	const limit = typeof params.limit === "number" ? params.limit : 20;

	const messages = listMessages(todoPath, {
		to,
		kind: kind as import("./types.js").MessageKind | undefined,
		limit,
	});
	return { count: messages.length, messages };
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function send(response: McpJsonRpcResponse): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function error(id: McpJsonRpcRequest["id"], code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function dispatch(req: McpJsonRpcRequest, serverCwd: string): Promise<void> {
	const { id, method, params } = req;
	const p = (params ?? {}) as Params;

	// MCP initialization handshake
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				serverInfo: { name: "evalgate", version: "0.2.0" },
				capabilities: { tools: {} },
			},
		});
		return;
	}

	if (method === "notifications/initialized") {
		// No response needed for notifications
		return;
	}

	if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
		return;
	}

	if (method === "tools/call") {
		const toolName = (p.name ?? p.tool) as string | undefined;
		const toolParams = (p.arguments ?? p.params ?? {}) as Params;

		let result: unknown;
		switch (toolName) {
			case "list_triggers":
				result = await handleListTriggers(toolParams, serverCwd);
				break;
			case "list_all":
				result = await handleListAll(toolParams, serverCwd);
				break;
			case "list_pending":
				result = await handleListPending(toolParams, serverCwd);
				break;
			case "run_eval":
				result = await handleRunEval(toolParams, serverCwd);
				break;
			case "check_all":
				result = await handleCheckAll(toolParams, serverCwd);
				break;
			case "get_retry_context":
				result = await handleGetRetryContext(toolParams, serverCwd);
				break;
			case "get_run_history":
				result = await handleGetRunHistory(toolParams, serverCwd);
				break;
			case "get_last_failure":
				result = await handleGetLastFailure(toolParams, serverCwd);
				break;
			case "send_message":
				result = await handleSendMessage(toolParams, serverCwd);
				break;
			case "list_messages":
				result = await handleListMessages(toolParams, serverCwd);
				break;
			case "get_provider_hints":
				result = await handleGetProviderHints(toolParams, serverCwd);
				break;
			case "report_token_usage":
				result = await handleReportTokenUsage(toolParams, serverCwd);
				break;
			case "suggest_template":
				result = await handleSuggestTemplate(toolParams, serverCwd);
				break;
			case "get_patterns":
				result = await handleGetPatterns(toolParams, serverCwd);
				break;
			case "export_state":
				result = await handleExportState(toolParams, serverCwd);
				break;
			default:
				error(id, -32601, `unknown tool: ${toolName}`);
				return;
		}

		// MCP expects tool results as content arrays
		send({
			jsonrpc: "2.0",
			id,
			result: {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			},
		});
		return;
	}

	error(id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Server entrypoint
// ---------------------------------------------------------------------------

export function startMcpServer(serverCwd: string = process.cwd()): void {
	process.stderr.write(`[evalgate] MCP server started (cwd: ${serverCwd})\n`);

	const rl = createInterface({ input: process.stdin, terminal: false });

	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;

		let req: McpJsonRpcRequest;
		try {
			req = JSON.parse(trimmed) as McpJsonRpcRequest;
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
			return;
		}

		dispatch(req, serverCwd).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`[evalgate] dispatch error: ${msg}\n`);
			send({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32603, message: msg } });
		});
	});

	rl.on("close", () => {
		process.stderr.write("[evalgate] stdin closed, exiting\n");
		process.exit(0);
	});
}
