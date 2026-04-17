/**
 * evalgate terminal dashboard — v0.5
 *
 * ANSI-based live dashboard. Clears and redraws the terminal every 2 seconds
 * (or immediately when a new run is appended via the onRun hook).
 * Zero runtime dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { onRun, queryRuns } from "./log.js";
import { listMessages } from "./messages.js";
import { parseTodo } from "./parser.js";

const _ESC = "\x1b[";
const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const C =
	process.stdout.isTTY && !process.env.NO_COLOR
		? {
				reset: "\x1b[0m",
				bold: "\x1b[1m",
				dim: "\x1b[2m",
				red: "\x1b[31m",
				green: "\x1b[32m",
				yellow: "\x1b[33m",
				cyan: "\x1b[36m",
				magenta: "\x1b[35m",
				white: "\x1b[37m",
			}
		: Object.fromEntries(
				["reset", "bold", "dim", "red", "green", "yellow", "cyan", "magenta", "white"].map((k) => [
					k,
					"",
				]),
			);

function col(width: number, s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
	const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
	const pad = Math.max(0, width - plain.length);
	return s + " ".repeat(pad);
}

function timeAgo(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
	return `${Math.round(ms / 3_600_000)}h ago`;
}

function render(todoPath: string): void {
	const cols = process.stdout.columns || 100;
	const lines: string[] = [];

	const push = (s = "") => lines.push(s);
	const hr = () => push(C.dim + "─".repeat(cols) + C.reset);

	// Header
	push(
		C.bold +
			C.cyan +
			"evalgate" +
			C.reset +
			C.dim +
			" · " +
			C.reset +
			basename(todoPath) +
			C.dim +
			" · " +
			new Date().toLocaleTimeString() +
			C.reset,
	);
	hr();

	// Contracts
	const contracts = existsSync(todoPath) ? parseTodo(readFileSync(todoPath, "utf8")) : [];

	if (contracts.length === 0) {
		push(`${C.dim}  no contracts found${C.reset}`);
	} else {
		push(`${C.bold}  Contracts${C.reset}`);
		for (const c of contracts) {
			const mark = c.checked
				? `${C.green}✓${C.reset}`
				: c.verifier
					? `${C.yellow}○${C.reset}`
					: `${C.dim}·${C.reset}`;
			const cmd = c.verifier
				? C.dim +
					" eval: " +
					C.reset +
					C.cyan +
					(c.verifier.kind === "shell"
						? c.verifier.command
						: c.verifier.kind === "composite"
							? `${c.verifier.mode}(${c.verifier.steps.length})`
							: `llm: ${c.verifier.prompt.slice(0, 40)}`) +
					C.reset
				: "";
			push(`  ${mark} ${c.title}${cmd}`);
		}
	}
	hr();

	// Run history
	const runs = queryRuns(todoPath, { limit: 10 });
	push(`${C.bold}  Recent Runs${C.reset}`);
	if (runs.length === 0) {
		push(`${C.dim}  no runs yet${C.reset}`);
	} else {
		push(
			C.dim +
				"  " +
				col(3, "") +
				col(30, "Contract") +
				col(10, "Trigger") +
				col(8, "Exit") +
				col(10, "Duration") +
				"When" +
				C.reset,
		);
		for (const r of runs) {
			const icon = r.passed ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
			const title =
				r.contractTitle.length > 28 ? `${r.contractTitle.slice(0, 25)}…` : r.contractTitle;
			push(
				"  " +
					icon +
					" " +
					col(30, title) +
					C.dim +
					col(10, r.trigger) +
					col(8, String(r.exitCode)) +
					col(10, `${r.durationMs}ms`) +
					timeAgo(r.ts) +
					C.reset,
			);
		}
	}
	hr();

	// Messages
	const messages = listMessages(todoPath, { limit: 5 });
	push(`${C.bold}  Agent Messages${C.reset}`);
	if (messages.length === 0) {
		push(`${C.dim}  no messages yet${C.reset}`);
	} else {
		for (const m of messages) {
			const payload = typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload);
			const preview = payload.length > 50 ? `${payload.slice(0, 47)}…` : payload;
			push(
				"  " +
					C.magenta +
					m.kind +
					C.reset +
					C.dim +
					" " +
					m.from +
					" → " +
					m.to +
					" · " +
					timeAgo(m.ts) +
					C.reset +
					"\n    " +
					C.dim +
					preview +
					C.reset,
			);
		}
	}
	hr();

	push(`${C.dim}  Press Ctrl+C to exit${C.reset}`);

	process.stdout.write(`${CLEAR + lines.join("\n")}\n`);
}

export interface DashHandle {
	stop: () => void;
}

export function startDash(todoPath: string): DashHandle {
	const resolved = resolve(todoPath);

	if (!process.stdout.isTTY) {
		console.error("evalgate dash: requires an interactive terminal (TTY)");
		process.exit(1);
	}

	process.stdout.write(HIDE_CURSOR);
	render(resolved);

	let timer: ReturnType<typeof setInterval>;

	function startTimer(): void {
		timer = setInterval(() => render(resolved), 2_000);
	}

	startTimer();

	const unsubscribe = onRun(() => {
		// Redraw immediately when a run completes, reset the 2s cycle
		clearInterval(timer);
		render(resolved);
		startTimer();
	});

	function stop(): void {
		clearInterval(timer);
		unsubscribe();
		process.stdout.write(`${SHOW_CURSOR}\n`);
	}

	return { stop };
}
