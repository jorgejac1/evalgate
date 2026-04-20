/**
 * evalgate MCP server — v0.2
 *
 * Implements the Model Context Protocol over stdio (JSON-RPC 2.0).
 * Zero runtime dependencies: reads stdin line-by-line, writes to stdout.
 * All debug/log output goes to stderr so it never pollutes the protocol stream.
 */

import { createInterface } from "node:readline";
import {
	handleCheckAll,
	handleExportState,
	handleGetLastFailure,
	handleGetPatterns,
	handleGetProviderHints,
	handleGetRetryContext,
	handleGetRunHistory,
	handleListAll,
	handleListMessages,
	handleListPending,
	handleListTriggers,
	handleListWorkspaces,
	handleReportTokenUsage,
	handleRunEval,
	handleSendMessage,
	handleSuggestTemplate,
	type Params,
} from "./mcp/handlers.js";
import { TOOLS } from "./mcp/tools.js";
import type { McpJsonRpcRequest, McpJsonRpcResponse } from "./types.js";
import { VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface McpServerOptions {
	workspaces?: Record<string, string>; // name → absolute path to todo.md
}

// ---------------------------------------------------------------------------
// JSON-RPC transport helpers
// ---------------------------------------------------------------------------

function send(response: McpJsonRpcResponse): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

function sendError(id: McpJsonRpcRequest["id"], code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

async function dispatch(
	req: McpJsonRpcRequest,
	serverCwd: string,
	workspaces: Record<string, string>,
): Promise<void> {
	const { id, method, params } = req;
	const p = (params ?? {}) as Params;

	// MCP initialization handshake
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2024-11-05",
				serverInfo: { name: "evalgate", version: VERSION },
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
		try {
			switch (toolName) {
				case "list_triggers":
					result = await handleListTriggers(toolParams, serverCwd, workspaces);
					break;
				case "list_all":
					result = await handleListAll(toolParams, serverCwd, workspaces);
					break;
				case "list_pending":
					result = await handleListPending(toolParams, serverCwd, workspaces);
					break;
				case "run_eval":
					result = await handleRunEval(toolParams, serverCwd, workspaces);
					break;
				case "check_all":
					result = await handleCheckAll(toolParams, serverCwd, workspaces);
					break;
				case "get_retry_context":
					result = await handleGetRetryContext(toolParams, serverCwd, workspaces);
					break;
				case "get_run_history":
					result = await handleGetRunHistory(toolParams, serverCwd, workspaces);
					break;
				case "get_last_failure":
					result = await handleGetLastFailure(toolParams, serverCwd, workspaces);
					break;
				case "send_message":
					result = await handleSendMessage(toolParams, serverCwd, workspaces);
					break;
				case "list_messages":
					result = await handleListMessages(toolParams, serverCwd, workspaces);
					break;
				case "get_provider_hints":
					result = await handleGetProviderHints(toolParams, serverCwd, workspaces);
					break;
				case "report_token_usage":
					result = await handleReportTokenUsage(toolParams, serverCwd, workspaces);
					break;
				case "suggest_template":
					result = await handleSuggestTemplate(toolParams, serverCwd, workspaces);
					break;
				case "get_patterns":
					result = await handleGetPatterns(toolParams, serverCwd, workspaces);
					break;
				case "export_state":
					result = await handleExportState(toolParams, serverCwd, workspaces);
					break;
				case "list_workspaces":
					result = handleListWorkspaces(workspaces);
					break;
				default:
					sendError(id, -32601, `unknown tool: ${toolName}`);
					return;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			sendError(id, -32603, msg);
			return;
		}

		// MCP expects tool results as content arrays
		send({
			jsonrpc: "2.0",
			id,
			result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
		});
		return;
	}

	sendError(id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Server entrypoint
// ---------------------------------------------------------------------------

export function startMcpServer(
	serverCwd: string = process.cwd(),
	options: McpServerOptions = {},
): void {
	const workspaces = options.workspaces ?? {};
	const wsCount = Object.keys(workspaces).length;
	const wsInfo = wsCount > 0 ? `, ${wsCount} workspace(s)` : "";
	process.stderr.write(`[evalgate] MCP server started (cwd: ${serverCwd}${wsInfo})\n`);

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

		dispatch(req, serverCwd, workspaces).catch((err: unknown) => {
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
