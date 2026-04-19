#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { getBudgetSummary, getTotalTokens, reportTokenUsage } from "./budget.js";
import { runGateway } from "./gateway.js";
import { loadConfig, setupConfig } from "./gateway-config.js";
import { getLastFailure, queryRuns } from "./log.js";
import { startMcpServer } from "./mcp.js";
import {
	detectPatterns,
	diffSnapshots,
	diffToMarkdown,
	exportSnapshot,
	snapshotToMarkdown,
	suggest,
} from "./memory.js";
import { listMessages, sendMessage } from "./messages.js";
import { parseTodo } from "./parser.js";
import { retryWorker, runSwarm } from "./swarm.js";
import { loadState } from "./swarm-state.js";
import type { RunResult } from "./types.js";
import { runContract } from "./verifier.js";
import { startWatcher } from "./watcher.js";
import { updateTodo } from "./writer.js";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
	reset: COLOR ? "\x1b[0m" : "",
	red: COLOR ? "\x1b[31m" : "",
	green: COLOR ? "\x1b[32m" : "",
	yellow: COLOR ? "\x1b[33m" : "",
	cyan: COLOR ? "\x1b[36m" : "",
	bold: COLOR ? "\x1b[1m" : "",
	dim: COLOR ? "\x1b[2m" : "",
};

function formatCommand(v: RunResult["contract"]["verifier"]): string {
	if (!v) return "no verifier";
	if (v.kind === "shell") return v.command;
	if (v.kind === "composite") return `${v.mode}(${v.steps.length} steps)`;
	if (v.kind === "llm") return `llm: ${v.prompt.slice(0, 60)}`;
	return "unknown";
}

function looksLikeFailure(s: string): boolean {
	return /\b(error|fail(ed)?|expected|assertion|✖|✗|throws?)\b/i.test(s);
}

async function cmdCheck(todoPath: string, watchFlag = false): Promise<number> {
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const source = readFileSync(todoPath, "utf8");
	const contracts = parseTodo(source);
	const pending = contracts.filter((c) => !c.checked && c.verifier);

	if (pending.length === 0) {
		console.log(
			`${C.dim}evalgate: no pending contracts with verifiers in ${basename(todoPath)}${C.reset}`,
		);
		return 0;
	}

	console.log(
		`${C.bold}evalgate${C.reset} ${C.dim}·${C.reset} checking ${pending.length} contract${pending.length === 1 ? "" : "s"} ${C.dim}in ${basename(todoPath)}${C.reset}\n`,
	);

	const cwd = resolve(dirname(todoPath));
	const results: RunResult[] = [];
	let passed = 0;
	let failed = 0;

	for (const c of pending) {
		process.stdout.write(`  ${C.dim}▸${C.reset} ${c.title} ${C.dim}(${c.id})${C.reset} ... `);
		const result = await runContract(c, cwd, { todoPath, trigger: "manual" });
		results.push(result);

		if (result.passed) {
			console.log(`${C.green}✓ passed${C.reset} ${C.dim}(${result.durationMs}ms)${C.reset}`);
			passed++;
		} else {
			console.log(
				`${C.red}✗ failed${C.reset} ${C.dim}(exit ${result.exitCode}, ${result.durationMs}ms)${C.reset}`,
			);
			failed++;
			// Prefer whichever stream carries the assertion detail. Many test
			// runners emit failures on stdout (TAP) while others use stderr.
			const stderr = result.stderr.trim();
			const stdout = result.stdout.trim();
			const failSource = looksLikeFailure(stderr) ? stderr : stdout || stderr;
			const tail = failSource.split("\n").slice(-20);
			for (const l of tail) {
				console.log(`    ${C.dim}│${C.reset} ${l}`);
			}
		}
	}

	const updated = updateTodo(source, results);
	if (updated !== source) {
		writeFileSync(todoPath, updated);
	}

	console.log(
		`\n${C.bold}Summary:${C.reset} ${C.green}${passed} passed${C.reset}, ${failed > 0 ? C.red : C.dim}${failed} failed${C.reset}`,
	);

	if (watchFlag) {
		const failedIds = new Set(results.filter((r) => !r.passed).map((r) => r.contract.id));

		if (failedIds.size === 0) {
			// All passed on the first run — nothing to watch
			return 0;
		}

		console.log(`\nWatching for changes... (Ctrl+C to stop)\n`);

		const { startCheckWatch } = await import("./check-watch.js");
		const resolvedTodoPath = resolve(todoPath);

		return new Promise<number>((resolvePromise) => {
			const handle = startCheckWatch({
				todoPath: resolvedTodoPath,
				failedIds,
				cwd,
				onCycle(cycleResults) {
					for (const r of cycleResults) {
						const icon = r.passed ? "✓" : "✗";
						const color = r.passed ? C.green : C.red;
						console.log(
							`  ${color}${icon}${C.reset} ${r.contract.title} ${C.dim}(${r.durationMs}ms)${C.reset}`,
						);
					}
					if (failedIds.size === 0) {
						console.log(`\n${C.green}All contracts passed.${C.reset}\n`);
					}
				},
			});

			// Auto-exit when the watcher stops itself (all passed)
			const origStop = handle.stop.bind(handle);
			handle.stop = () => {
				origStop();
				resolvePromise(failedIds.size === 0 ? 0 : 1);
			};

			function shutdown() {
				handle.stop();
			}

			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		});
	}

	return failed > 0 ? 1 : 0;
}

async function cmdList(todoPath: string): Promise<number> {
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const source = readFileSync(todoPath, "utf8");
	const contracts = parseTodo(source);
	if (contracts.length === 0) {
		console.log(`${C.dim}no contracts found${C.reset}`);
		return 0;
	}

	for (const c of contracts) {
		const mark = c.checked
			? `${C.green}✓${C.reset}`
			: c.verifier
				? `${C.yellow}○${C.reset}`
				: `${C.dim}○${C.reset}`;
		console.log(`${mark} ${c.title} ${C.dim}(${c.id})${C.reset}`);
		if (c.verifier) {
			console.log(`  ${C.dim}eval:${C.reset} ${C.cyan}${formatCommand(c.verifier)}${C.reset}`);
		}
		if (c.retries !== undefined) {
			console.log(`  ${C.dim}retries: ${c.retries}${C.reset}`);
		}
		if (c.budget !== undefined) {
			console.log(`  ${C.dim}budget: ${c.budget.toLocaleString()} tokens${C.reset}`);
		}
	}
	return 0;
}

async function cmdRetry(contractId: string, todoPath: string): Promise<number> {
	if (!contractId) {
		console.error(`${C.red}evalgate retry: contract id required${C.reset}`);
		console.error(`  usage: evalgate retry <id> [path]`);
		return 1;
	}
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const source = readFileSync(todoPath, "utf8");
	const contracts = parseTodo(source);
	const normalized = contractId.trim().toLowerCase();
	const contract = contracts.find(
		(c) => c.id === normalized || c.title.toLowerCase() === normalized,
	);

	if (!contract) {
		console.error(`${C.red}evalgate: contract not found: ${contractId}${C.reset}`);
		console.log(`\nAvailable ids:`);
		for (const c of contracts) {
			console.log(`  ${C.dim}${c.id}${C.reset} — ${c.title}`);
		}
		return 1;
	}

	if (!contract.verifier) {
		console.error(`${C.red}evalgate: contract '${contractId}' has no verifier${C.reset}`);
		return 1;
	}

	console.log(
		`${C.bold}evalgate retry${C.reset} ${C.dim}·${C.reset} ${contract.title} ${C.dim}(${contract.id})${C.reset}\n`,
	);

	// Show last failure from durable log if available
	const lastFailure = getLastFailure(todoPath, contract.id);
	if (lastFailure) {
		const ago = new Date(lastFailure.ts).toLocaleString();
		console.log(
			`${C.bold}Last failure${C.reset} ${C.dim}(${ago}, exit ${lastFailure.exitCode}, ${lastFailure.durationMs}ms):${C.reset}`,
		);
		const combined = [lastFailure.stdout.trim(), lastFailure.stderr.trim()]
			.filter(Boolean)
			.join("\n");
		for (const l of combined.split("\n").slice(-20)) {
			console.log(`  ${C.dim}│${C.reset} ${l}`);
		}
		console.log();
	}

	const cwd = resolve(dirname(todoPath));
	process.stdout.write(`  ${C.dim}▸${C.reset} retrying ... `);
	const result = await runContract(contract, cwd, { todoPath, trigger: "retry" });

	if (result.passed) {
		console.log(`${C.green}✓ passed${C.reset} ${C.dim}(${result.durationMs}ms)${C.reset}`);
		const updated = updateTodo(source, [result]);
		if (updated !== source) writeFileSync(todoPath, updated);
		return 0;
	}

	console.log(
		`${C.red}✗ failed${C.reset} ${C.dim}(exit ${result.exitCode}, ${result.durationMs}ms)${C.reset}`,
	);
	const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	for (const l of combined.split("\n").slice(-20)) {
		console.log(`  ${C.dim}│${C.reset} ${l}`);
	}

	return 1;
}

async function cmdLog(todoPath: string, args: string[]): Promise<number> {
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const contractId = args.find((a) => a.startsWith("--contract="))?.split("=")[1];
	const failedOnly = args.includes("--failed");
	const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
	const limit = limitArg ? parseInt(limitArg, 10) : 20;

	const records = queryRuns(todoPath, {
		contractId,
		passed: failedOnly ? false : undefined,
		limit,
	});

	if (records.length === 0) {
		console.log(`${C.dim}no run history found${C.reset}`);
		return 0;
	}

	console.log(`${C.bold}evalgate log${C.reset} ${C.dim}· ${records.length} run(s)${C.reset}\n`);
	for (const r of records) {
		const status = r.passed ? `${C.green}✓ passed${C.reset}` : `${C.red}✗ failed${C.reset}`;
		const ts = new Date(r.ts).toLocaleString();
		console.log(
			`${status}  ${C.bold}${r.contractTitle}${C.reset} ${C.dim}(${r.contractId})${C.reset}`,
		);
		console.log(
			`  ${C.dim}${ts} · ${r.trigger} · exit ${r.exitCode} · ${r.durationMs}ms${C.reset}`,
		);
	}
	return 0;
}

async function cmdBudget(todoPath: string, args: string[]): Promise<number> {
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const source = readFileSync(todoPath, "utf8");
	const contracts = parseTodo(source);

	// Sub-command: evalgate budget <id> <tokens> — record usage
	const positional = args.filter((a) => !a.startsWith("--"));
	if (positional.length >= 2) {
		const [contractId, tokensRaw] = positional;
		const tokens = parseInt(tokensRaw, 10);
		if (Number.isNaN(tokens) || tokens < 0) {
			console.error(`${C.red}evalgate budget: tokens must be a non-negative integer${C.reset}`);
			return 1;
		}
		const contract = contracts.find(
			(c) => c.id === contractId || c.title.toLowerCase() === contractId.toLowerCase(),
		);
		if (!contract) {
			console.error(`${C.red}evalgate: contract not found: ${contractId}${C.reset}`);
			return 1;
		}
		const record = reportTokenUsage(todoPath, contract.id, tokens, contract);
		const total = getTotalTokens(todoPath, contract.id);
		console.log(
			`${C.green}recorded${C.reset} ${tokens.toLocaleString()} tokens for ${C.bold}${contract.title}${C.reset}` +
				` ${C.dim}(total: ${total.toLocaleString()}${contract.budget ? ` / ${contract.budget.toLocaleString()}` : ""})${C.reset}`,
		);
		if (contract.budget && total > contract.budget) {
			console.log(
				`${C.red}⚠ budget exceeded by ${(total - contract.budget).toLocaleString()} tokens${C.reset}`,
			);
		}
		void record;
		return 0;
	}

	// Default: show budget summary table
	const summary = getBudgetSummary(todoPath, contracts);
	const anyBudget = summary.some((s) => s.budget !== undefined || s.used > 0);

	if (!anyBudget) {
		console.log(`${C.dim}no budget data yet — use: evalgate budget <id> <tokens>${C.reset}`);
		return 0;
	}

	console.log(`${C.bold}evalgate budget${C.reset} ${C.dim}· ${basename(todoPath)}${C.reset}\n`);

	for (const s of summary) {
		if (s.budget === undefined && s.used === 0) continue;

		const status = s.exceeded
			? `${C.red}exceeded${C.reset}`
			: s.budget !== undefined
				? `${C.green}ok${C.reset}`
				: `${C.dim}no limit${C.reset}`;

		const bar = s.budget && s.budget > 0 ? buildBar(s.used, s.budget, 20) : "";

		console.log(`  ${C.bold}${s.contractTitle}${C.reset} ${C.dim}(${s.contractId})${C.reset}`);
		console.log(
			`  ${C.dim}used:${C.reset} ${s.used.toLocaleString()}` +
				(s.budget ? ` ${C.dim}/ ${s.budget.toLocaleString()}${C.reset}` : "") +
				(bar ? `  ${bar}` : "") +
				`  ${status}`,
		);
	}

	return 0;
}

async function cmdSuggest(query: string, todoPath: string): Promise<number> {
	if (!query) {
		console.error(`${C.red}evalgate suggest: query required${C.reset}`);
		console.error(`  usage: evalgate suggest "<title>" [path]`);
		return 1;
	}
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const results = suggest(todoPath, query, 5);

	if (results.length === 0) {
		console.log(`${C.dim}no similar past completions found${C.reset}`);
		return 0;
	}

	console.log(`${C.bold}evalgate suggest${C.reset} ${C.dim}·${C.reset} "${query}"\n`);

	for (const r of results) {
		const sim = Math.round(r.similarity * 100);
		const simColor = sim >= 60 ? C.green : sim >= 30 ? C.yellow : C.dim;
		console.log(
			`  ${simColor}${sim}%${C.reset} ${C.bold}${r.contractTitle}${C.reset} ${C.dim}(${r.contractId})${C.reset}`,
		);
		if (r.verifier) {
			console.log(`       ${C.dim}eval:${C.reset} ${C.cyan}${r.verifier}${C.reset}`);
		}
		console.log(
			`       ${C.dim}pass rate: ${Math.round(r.passRate * 100)}% · ${r.runCount} run(s)${C.reset}`,
		);
	}
	return 0;
}

async function cmdPatterns(todoPath: string): Promise<number> {
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const patterns = detectPatterns(todoPath);

	if (patterns.length === 0) {
		console.log(`${C.dim}no failure patterns detected${C.reset}`);
		return 0;
	}

	console.log(`${C.bold}evalgate patterns${C.reset} ${C.dim}· ${basename(todoPath)}${C.reset}\n`);

	for (const p of patterns) {
		const flakyTag = p.flaky ? ` ${C.yellow}(flaky)${C.reset}` : "";
		console.log(
			`  ${C.bold}${p.contractTitle}${C.reset}${flakyTag} ${C.dim}(${p.contractId})${C.reset}`,
		);
		const rate = Math.round(p.failureRate * 100);
		const rateColor = rate >= 75 ? C.red : rate >= 40 ? C.yellow : C.dim;
		console.log(
			`  ${C.dim}runs: ${p.totalRuns} · failures: ${C.reset}${rateColor}${p.failures}${C.reset}` +
				` ${C.dim}· passes: ${p.passes} · rate: ${C.reset}${rateColor}${rate}%${C.reset}`,
		);
		if (p.topErrors.length > 0) {
			for (const e of p.topErrors) {
				console.log(`  ${C.dim}│${C.reset} ${C.dim}${e}${C.reset}`);
			}
		}
		console.log();
	}
	return 0;
}

async function cmdDiff(
	pathA: string,
	pathB: string,
	format: "json" | "md" | "text",
): Promise<number> {
	if (!existsSync(pathA)) {
		console.error(`${C.red}evalgate diff: file not found: ${pathA}${C.reset}`);
		return 1;
	}
	if (!existsSync(pathB)) {
		console.error(`${C.red}evalgate diff: file not found: ${pathB}${C.reset}`);
		return 1;
	}

	let snapshotA: ReturnType<typeof exportSnapshot>;
	let snapshotB: ReturnType<typeof exportSnapshot>;

	try {
		snapshotA = JSON.parse(readFileSync(pathA, "utf8")) as ReturnType<typeof exportSnapshot>;
	} catch {
		console.error(`${C.red}evalgate diff: failed to parse ${pathA}${C.reset}`);
		return 1;
	}
	try {
		snapshotB = JSON.parse(readFileSync(pathB, "utf8")) as ReturnType<typeof exportSnapshot>;
	} catch {
		console.error(`${C.red}evalgate diff: failed to parse ${pathB}${C.reset}`);
		return 1;
	}

	const diff = diffSnapshots(snapshotA, snapshotB);

	if (format === "json") {
		process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
		return 0;
	}

	if (format === "md") {
		process.stdout.write(`${diffToMarkdown(diff)}\n`);
		return 0;
	}

	// Default text output
	const { contracts, runs, budget, messages } = diff;
	console.log(
		`${C.bold}evalgate diff${C.reset} ${C.dim}·${C.reset} ` +
			`${new Date(diff.from).toLocaleString()} ${C.dim}→${C.reset} ${new Date(diff.to).toLocaleString()}\n`,
	);

	if (contracts.nowPassed.length > 0) {
		for (const t of contracts.nowPassed) console.log(`  ${C.green}✓ passed${C.reset}  ${t}`);
	}
	if (contracts.nowPending.length > 0) {
		for (const t of contracts.nowPending) console.log(`  ${C.yellow}○ regressed${C.reset}  ${t}`);
	}
	if (contracts.added.length > 0) {
		for (const t of contracts.added) console.log(`  ${C.cyan}+ added${C.reset}    ${t}`);
	}
	if (contracts.removed.length > 0) {
		for (const t of contracts.removed) console.log(`  ${C.dim}- removed${C.reset}   ${t}`);
	}
	if (
		contracts.nowPassed.length === 0 &&
		contracts.nowPending.length === 0 &&
		contracts.added.length === 0 &&
		contracts.removed.length === 0
	) {
		console.log(`  ${C.dim}no contract changes${C.reset}`);
	}

	console.log(
		`\n  ${C.dim}runs: +${runs.added} · pass rate: ${runs.passRate.before}% → ${runs.passRate.after}%${C.reset}`,
	);
	if (budget.contractsExceeded.length > 0) {
		console.log(`  ${C.red}⚠ budget exceeded: ${budget.contractsExceeded.join(", ")}${C.reset}`);
	}
	if (messages.added > 0) {
		console.log(`  ${C.dim}+${messages.added} message(s)${C.reset}`);
	}

	return 0;
}

async function cmdExport(todoPath: string, format: "json" | "md"): Promise<number> {
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const snapshot = exportSnapshot(todoPath);

	if (format === "md") {
		process.stdout.write(`${snapshotToMarkdown(snapshot)}\n`);
	} else {
		process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
	}
	return 0;
}

function buildBar(used: number, budget: number, width: number): string {
	const pct = Math.min(1, used / budget);
	const filled = Math.round(pct * width);
	const empty = width - filled;
	const color = pct >= 1 ? C.red : pct >= 0.8 ? C.yellow : C.green;
	return color + "█".repeat(filled) + C.dim + "░".repeat(empty) + C.reset;
}

async function cmdMsg(subCmd: string, args: string[], todoPath: string): Promise<number> {
	if (subCmd === "send") {
		const [from, to, kind, payloadRaw] = args;
		if (!from || !to || !kind) {
			console.error(`${C.red}usage: evalgate msg send <from> <to> <kind> [payload-json]${C.reset}`);
			return 1;
		}
		let payload: unknown = null;
		if (payloadRaw) {
			try {
				payload = JSON.parse(payloadRaw);
			} catch {
				payload = payloadRaw;
			}
		}
		const msg = sendMessage(todoPath, {
			from,
			to,
			kind: kind as Parameters<typeof sendMessage>[1]["kind"],
			payload,
		});
		console.log(`${C.green}sent${C.reset} ${C.dim}(${msg.id})${C.reset}`);
		console.log(JSON.stringify(msg, null, 2));
		return 0;
	}

	if (subCmd === "list") {
		const toArg = args.find((a) => a.startsWith("--to="))?.split("=")[1];
		const kindArg = args.find((a) => a.startsWith("--kind="))?.split("=")[1];
		const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
		const messages = listMessages(todoPath, {
			to: toArg,
			kind: kindArg as import("./types.js").MessageKind | undefined,
			limit: limitArg ? parseInt(limitArg, 10) : 20,
		});
		if (messages.length === 0) {
			console.log(`${C.dim}no messages found${C.reset}`);
			return 0;
		}
		for (const m of messages) {
			console.log(
				`${C.cyan}${m.kind}${C.reset}  ${C.dim}${m.from} → ${m.to}${C.reset}  ${new Date(m.ts).toLocaleString()}`,
			);
			if (m.contractId) console.log(`  ${C.dim}contract: ${m.contractId}${C.reset}`);
			console.log(`  ${C.dim}${JSON.stringify(m.payload)}${C.reset}`);
		}
		return 0;
	}

	console.error(`${C.red}unknown msg subcommand: ${subCmd}${C.reset}`);
	console.error(`  usage: evalgate msg send|list ...`);
	return 1;
}

async function cmdSwarm(todoPath: string, args: string[]): Promise<number> {
	if (!existsSync(todoPath)) {
		console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
		return 1;
	}

	const concurrencyArg = args.find((a) => a.startsWith("--concurrency="))?.split("=")[1];
	const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : 3;
	const resume = args.includes("--resume");
	const agentCmdArg = args.find((a) => a.startsWith("--agent="))?.split("=")[1];

	// Sub-command: swarm retry <worker-id> — retry a single failed worker
	if (args.includes("retry")) {
		const retryIdx = args.indexOf("retry");
		// Worker id is the first positional argument after "retry"
		const workerId = args.slice(retryIdx + 1).find((a) => !a.startsWith("--"));
		if (!workerId) {
			console.error(`${C.red}evalgate swarm retry: missing worker id${C.reset}`);
			console.error(`  usage: evalgate swarm retry <worker-id> [todo-path]`);
			return 1;
		}
		console.log(
			`${C.bold}evalgate swarm retry${C.reset} ${C.dim}·${C.reset} worker ${C.cyan}${workerId}${C.reset}\n`,
		);
		try {
			const worker = await retryWorker(workerId, todoPath, {
				todoPath,
				agentCmd: agentCmdArg,
			});
			if (worker.status === "done") {
				console.log(
					`${C.green}✓${C.reset} ${worker.contractTitle} ${C.dim}(${worker.id})${C.reset} ${C.green}done${C.reset}`,
				);
				return 0;
			}
			console.log(
				`${C.red}✗${C.reset} ${worker.contractTitle} ${C.dim}(${worker.id})${C.reset} ${C.red}failed${C.reset}`,
			);
			if (worker.logPath) {
				console.log(`  ${C.dim}log: ${worker.logPath}${C.reset}`);
			}
			return 1;
		} catch (err) {
			console.error(
				`${C.red}evalgate swarm retry error:${C.reset}`,
				err instanceof Error ? err.message : err,
			);
			return 1;
		}
	}

	// Sub-command: swarm status — print state from last run
	if (args.includes("status")) {
		const state = loadState(todoPath);
		if (!state) {
			console.log(`${C.dim}no swarm state found — run: evalgate swarm${C.reset}`);
			return 0;
		}
		console.log(
			`${C.bold}evalgate swarm status${C.reset} ${C.dim}· ${state.id}${C.reset} ${C.dim}(${new Date(state.ts).toLocaleString()})${C.reset}\n`,
		);
		for (const w of state.workers) {
			const statusColor =
				w.status === "done"
					? C.green
					: w.status === "failed"
						? C.red
						: w.status === "running" || w.status === "spawning"
							? C.cyan
							: C.yellow;
			const mark =
				w.status === "done"
					? `${C.green}✓${C.reset}`
					: w.status === "failed"
						? `${C.red}✗${C.reset}`
						: `${C.yellow}○${C.reset}`;
			console.log(
				`${mark} ${C.bold}${w.contractTitle}${C.reset}  ${statusColor}${w.status}${C.reset} ${C.dim}(${w.id})${C.reset}`,
			);
			if (w.status === "failed" || w.status === "done") {
				if (w.startedAt && w.finishedAt) {
					const ms = new Date(w.finishedAt).getTime() - new Date(w.startedAt).getTime();
					console.log(`  ${C.dim}duration: ${ms}ms${C.reset}`);
				}
				if (w.verifierPassed !== undefined) {
					console.log(
						`  ${C.dim}verifier: ${w.verifierPassed ? `${C.green}passed${C.reset}` : `${C.red}failed${C.reset}`}${C.dim}  log: ${w.logPath}${C.reset}`,
					);
				}
			}
		}
		return 0;
	}

	console.log(
		`${C.bold}evalgate swarm${C.reset} ${C.dim}·${C.reset} ${basename(todoPath)} ${C.dim}· concurrency ${concurrency}${resume ? " · resuming" : ""}${C.reset}\n`,
	);

	try {
		const result = await runSwarm({
			todoPath,
			concurrency,
			resume,
			agentCmd: agentCmdArg,
		});

		for (const w of result.state.workers) {
			const mark =
				w.status === "done"
					? `${C.green}✓${C.reset}`
					: w.status === "failed"
						? `${C.red}✗${C.reset}`
						: `${C.yellow}○${C.reset}`;
			const statusLabel =
				w.status === "done"
					? `${C.green}done${C.reset}`
					: w.status === "failed"
						? `${C.red}failed${C.reset}`
						: `${C.dim}${w.status}${C.reset}`;
			console.log(`  ${mark} ${w.contractTitle} ${C.dim}(${w.id})${C.reset} ${statusLabel}`);
		}

		console.log(
			`\n${C.bold}Swarm summary:${C.reset} ${C.green}${result.done} merged${C.reset}, ${result.failed > 0 ? C.red : C.dim}${result.failed} failed${C.reset}, ${C.dim}${result.skipped} skipped${C.reset}`,
		);
		return result.failed > 0 ? 1 : 0;
	} catch (err) {
		console.error(
			`${C.red}evalgate swarm error:${C.reset}`,
			err instanceof Error ? err.message : err,
		);
		return 1;
	}
}

async function cmdGatewaySetup(): Promise<number> {
	try {
		const config = await setupConfig();
		const { configPath } = await import("./gateway-config.js");
		console.log(`\n${C.green}Config saved to ${configPath()}${C.reset}`);
		console.log(`${C.dim}token: ${config.token.slice(0, 8)}…${C.reset}`);
		console.log(`${C.dim}chatId: ${config.chatId}${C.reset}`);
		console.log(`${C.dim}todoPath: ${config.todoPath}${C.reset}`);
		console.log(`\nRun ${C.bold}evalgate gateway${C.reset} to start the bot.`);
		return 0;
	} catch (err) {
		console.error(
			`${C.red}gateway setup failed:${C.reset}`,
			err instanceof Error ? err.message : err,
		);
		return 1;
	}
}

async function cmdGateway(args: string[]): Promise<number> {
	const tokenArg = args.find((a) => a.startsWith("--token="))?.split("=")[1];
	const chatIdArg = args.find((a) => a.startsWith("--chat-id="))?.split("=")[1];
	const todoArg = args.find((a) => a.startsWith("--todo="))?.split("=")[1];
	const concurrencyArg = args.find((a) => a.startsWith("--concurrency="))?.split("=")[1];

	const stored = loadConfig();

	const token = tokenArg ?? stored?.token;
	const chatId = chatIdArg ? parseInt(chatIdArg, 10) : stored?.chatId;
	const todoPath = todoArg ?? stored?.todoPath ?? "todo.md";
	const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : (stored?.concurrency ?? 3);

	if (!token) {
		console.error(
			`${C.red}evalgate gateway: no token found.${C.reset}\n` +
				`  Run ${C.bold}evalgate gateway setup${C.reset} first, ` +
				`or pass ${C.cyan}--token=<token>${C.reset}`,
		);
		return 1;
	}

	if (chatId === undefined || Number.isNaN(chatId)) {
		console.error(
			`${C.red}evalgate gateway: no chat ID found.${C.reset}\n` +
				`  Run ${C.bold}evalgate gateway setup${C.reset} first, ` +
				`or pass ${C.cyan}--chat-id=<id>${C.reset}`,
		);
		return 1;
	}

	console.log(`${C.bold}evalgate gateway${C.reset} ${C.dim}· Telegram bot starting…${C.reset}`);
	console.log(`${C.dim}todo: ${todoPath} · concurrency: ${concurrency}${C.reset}`);
	console.log(`${C.dim}Press Ctrl+C to stop.${C.reset}\n`);

	process.on("SIGINT", () => process.exit(0));
	process.on("SIGTERM", () => process.exit(0));

	try {
		await runGateway({
			config: { token, chatId, todoPath, concurrency },
			todoPath,
		});
	} catch (err) {
		console.error(
			`${C.red}evalgate gateway error:${C.reset}`,
			err instanceof Error ? err.message : err,
		);
		return 1;
	}

	return 0;
}

function usage(): void {
	console.log(
		`
${C.bold}evalgate${C.reset} — eval-gated todos for agents

${C.bold}USAGE${C.reset}
  evalgate check  [path] [--watch]    Run verifiers; --watch re-checks on file change
  evalgate list   [path]              List contracts and their status
  evalgate retry  <id> [path]         Rerun a contract with last failure context
  evalgate log    [path] [--contract=<id>] [--failed] [--limit=N]
  evalgate msg    send <from> <to> <kind> [payload-json] [path]
  evalgate msg    list [--to=<agent>] [--kind=<kind>] [path]
  evalgate serve  [cwd]               Start MCP server on stdio
  evalgate watch  [path]              Start trigger daemon (schedule/watch/webhook)
  evalgate ui     [path] [--port=N]   Start web dashboard (default port 7777)
  evalgate dash   [path]              Live ANSI terminal dashboard
  evalgate budget [path]              Show per-contract token spend vs budget
  evalgate budget <id> <tokens> [path]  Record token usage for a contract
  evalgate suggest "<title>" [path]   Find similar past successful completions
  evalgate patterns [path]            Show failure patterns from run history
  evalgate export [path] [--format=json|md]  Export full project snapshot
  evalgate diff <a.json> <b.json> [--format=text|json|md]  Diff two snapshots
  evalgate swarm  [path] [--concurrency=N] [--resume] [--agent=cmd]
  evalgate swarm  status [path]       Show swarm worker status
  evalgate swarm  retry <id> [path]   Retry a single failed swarm worker
  evalgate gateway setup              Configure Telegram bot token and chat ID
  evalgate gateway [--todo=path]      Start Telegram bot gateway
  evalgate help                       Show this message

${C.bold}CONTRACT FORMAT${C.reset} (todo.md)
  - [ ] Refactor auth middleware to use JWT
    - eval: \`pnpm test src/auth && pnpm lint src/auth\`
    - retries: 3
    - budget: 50k

${C.dim}If no path is given, ./todo.md is used.${C.reset}
  `.trim(),
	);
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);

	let exitCode = 0;
	switch (cmd) {
		case "check": {
			const positional = args.filter((a) => !a.startsWith("--"));
			const todoPath = positional[0] ?? "todo.md";
			const watchMode = args.includes("--watch");
			exitCode = await cmdCheck(todoPath, watchMode);
			if (watchMode) return; // watch loop handles process lifetime
			break;
		}
		case "list": {
			const todoPath = args[0] ?? "todo.md";
			exitCode = await cmdList(todoPath);
			break;
		}
		case "retry": {
			const [contractId, todoPath = "todo.md"] = args;
			exitCode = await cmdRetry(contractId ?? "", todoPath);
			break;
		}
		case "log": {
			const flags = args.filter((a) => a.startsWith("--"));
			const positional = args.filter((a) => !a.startsWith("--"));
			const todoPath = positional[0] ?? "todo.md";
			exitCode = await cmdLog(todoPath, flags);
			break;
		}
		case "msg": {
			const [subCmd, ...rest] = args;
			// Last non-flag arg that looks like a path is the todoPath
			const flags = rest.filter((a) => a.startsWith("--"));
			const positional = rest.filter((a) => !a.startsWith("--"));
			const todoPath = (subCmd === "list" ? positional[0] : positional[4]) ?? "todo.md";
			// send: from to kind payload — pass all 4 positional args
			const msgArgs = subCmd === "list" ? flags : [...positional.slice(0, 4), ...flags];
			exitCode = await cmdMsg(subCmd ?? "", msgArgs, todoPath);
			break;
		}
		case "serve": {
			const positionalArgs = args.filter((a) => !a.startsWith("--"));
			const flagArgs = args.filter((a) => a.startsWith("--workspace="));
			const cwd = positionalArgs[0] ? resolve(positionalArgs[0]) : process.cwd();
			const workspaces: Record<string, string> = {};
			for (const flag of flagArgs) {
				// --workspace=name:/absolute/path/to/todo.md
				const value = flag.slice("--workspace=".length);
				const colonIdx = value.indexOf(":");
				if (colonIdx > 0) {
					const name = value.slice(0, colonIdx).trim();
					const wsPath = value.slice(colonIdx + 1).trim();
					if (name && wsPath) workspaces[name] = wsPath;
				}
			}
			startMcpServer(cwd, { workspaces });
			// startMcpServer keeps the process alive via readline — don't exit
			return;
		}
		case "watch": {
			const todoPath = resolve(args[0] ?? "todo.md");
			const portArg = args.find((a) => a.startsWith("--port="));
			const port = portArg ? parseInt(portArg.split("=")[1], 10) : 7778;
			const noSchedule = args.includes("--no-schedule");
			const noWatch = args.includes("--no-watch");
			const noWebhook = args.includes("--no-webhook");

			if (!existsSync(todoPath)) {
				console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
				process.exit(1);
			}

			const handle = startWatcher({
				todoPath,
				webhookPort: port,
				enableSchedule: !noSchedule,
				enableWatch: !noWatch,
				enableWebhook: !noWebhook,
			});

			process.on("SIGINT", () => {
				handle.stop();
				process.exit(0);
			});
			process.on("SIGTERM", () => {
				handle.stop();
				process.exit(0);
			});
			// Keep process alive — watcher engines hold open handles
			return;
		}
		case "budget": {
			const flags = args.filter((a) => a.startsWith("--"));
			const positional = args.filter((a) => !a.startsWith("--"));
			let todoPath: string;
			let subArgs: string[];
			// Detect path: first arg that ends in .md or resolves to an existing file
			const firstLooksLikePath =
				positional.length > 0 &&
				(positional[0].endsWith(".md") || existsSync(resolve(positional[0])));
			if (firstLooksLikePath) {
				// budget [path] [id] [tokens]
				todoPath = resolve(positional[0]);
				subArgs = [...positional.slice(1), ...flags];
			} else if (positional.length >= 2) {
				// budget <id> <tokens> [path]
				todoPath = resolve(positional[2] ?? "todo.md");
				subArgs = [...positional.slice(0, 2), ...flags];
			} else {
				todoPath = resolve("todo.md");
				subArgs = [...positional, ...flags];
			}
			exitCode = await cmdBudget(todoPath, subArgs);
			break;
		}
		case "ui": {
			const flags = args.filter((a) => a.startsWith("--"));
			const positional = args.filter((a) => !a.startsWith("--"));
			const todoPath = resolve(positional[0] ?? "todo.md");
			const portArg = flags.find((a) => a.startsWith("--port="));
			const port = portArg ? parseInt(portArg.split("=")[1], 10) : 7777;

			if (!existsSync(todoPath)) {
				console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
				process.exit(1);
			}

			const { startUiServer } = await import("./ui.js");
			const handle = startUiServer({ todoPath, port });

			console.log(
				`${C.bold}evalgate ui${C.reset} ${C.dim}·${C.reset} ` +
					`${C.cyan}http://localhost:${handle.port}${C.reset} ` +
					`${C.dim}· ${todoPath}${C.reset}`,
			);
			console.log(`${C.dim}Press Ctrl+C to stop.${C.reset}`);

			process.on("SIGINT", () => {
				handle.stop();
				process.exit(0);
			});
			process.on("SIGTERM", () => {
				handle.stop();
				process.exit(0);
			});
			return;
		}
		case "dash": {
			const positional = args.filter((a) => !a.startsWith("--"));
			const todoPath = resolve(positional[0] ?? "todo.md");

			if (!existsSync(todoPath)) {
				console.error(`${C.red}evalgate: file not found: ${todoPath}${C.reset}`);
				process.exit(1);
			}

			const { startDash } = await import("./dash.js");
			const handle = startDash(todoPath);

			process.on("SIGINT", () => {
				handle.stop();
				process.exit(0);
			});
			process.on("SIGTERM", () => {
				handle.stop();
				process.exit(0);
			});
			return;
		}
		case "suggest": {
			const positional = args.filter((a) => !a.startsWith("--"));
			const query = positional[0] ?? "";
			const todoPath = resolve(positional[1] ?? "todo.md");
			exitCode = await cmdSuggest(query, todoPath);
			break;
		}
		case "patterns": {
			const positional = args.filter((a) => !a.startsWith("--"));
			const todoPath = resolve(positional[0] ?? "todo.md");
			exitCode = await cmdPatterns(todoPath);
			break;
		}
		case "export": {
			const flags = args.filter((a) => a.startsWith("--"));
			const positional = args.filter((a) => !a.startsWith("--"));
			const todoPath = resolve(positional[0] ?? "todo.md");
			const formatArg = flags.find((a) => a.startsWith("--format="))?.split("=")[1];
			const format = formatArg === "md" ? "md" : "json";
			exitCode = await cmdExport(todoPath, format);
			break;
		}
		case "diff": {
			const flags = args.filter((a) => a.startsWith("--"));
			const positional = args.filter((a) => !a.startsWith("--"));
			const [pathA, pathB] = positional;
			if (!pathA || !pathB) {
				console.error(`${C.red}evalgate diff: two snapshot paths required${C.reset}`);
				console.error(`  usage: evalgate diff <a.json> <b.json> [--format=text|json|md]`);
				exitCode = 1;
				break;
			}
			const formatArg = flags.find((a) => a.startsWith("--format="))?.split("=")[1];
			const format = formatArg === "json" ? "json" : formatArg === "md" ? "md" : "text";
			exitCode = await cmdDiff(resolve(pathA), resolve(pathB), format);
			break;
		}
		case "swarm": {
			const flags = args.filter((a) => a.startsWith("--"));
			const positional = args.filter((a) => !a.startsWith("--"));
			const subCmd = ["status", "retry"].includes(positional[0] ?? "") ? positional[0] : undefined;
			let pathArg: string | undefined;
			let swarmArgs: string[];
			if (subCmd === "status") {
				pathArg = positional[1];
				swarmArgs = ["status", ...flags];
			} else if (subCmd === "retry") {
				// evalgate swarm retry <worker-id> [path]
				pathArg = positional[2];
				swarmArgs = ["retry", positional[1] ?? "", ...flags];
			} else {
				pathArg = positional[0];
				swarmArgs = flags;
			}
			const todoPath = resolve(pathArg ?? "todo.md");
			exitCode = await cmdSwarm(todoPath, swarmArgs);
			break;
		}
		case "gateway": {
			const subCmd = args[0];
			if (subCmd === "setup") {
				exitCode = await cmdGatewaySetup();
			} else {
				exitCode = await cmdGateway(args);
			}
			break;
		}
		case "help":
		case "--help":
		case "-h":
		case undefined:
			usage();
			break;
		default:
			console.error(`${C.red}unknown command: ${cmd}${C.reset}\n`);
			usage();
			exitCode = 1;
	}
	process.exit(exitCode);
}

main().catch((e) => {
	console.error(`${C.red}evalgate error:${C.reset}`, e?.stack ?? e);
	process.exit(1);
});
