import { readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseTodo } from "./parser.js";
import type { RunResult } from "./types.js";
import { runContract } from "./verifier.js";
import { updateTodo } from "./writer.js";

export interface CheckWatchOptions {
	todoPath: string;
	failedIds: Set<string>;
	cwd?: string;
	onCycle?: (results: RunResult[]) => void;
}

export interface CheckWatchHandle {
	stop: () => void;
}

export function startCheckWatch(opts: CheckWatchOptions): CheckWatchHandle {
	const { todoPath, failedIds, onCycle } = opts;
	const cwd = opts.cwd ?? process.cwd();
	const watchDir = resolve(dirname(todoPath));

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let stopped = false;

	const watcher = watch(watchDir, { recursive: true }, (_, filename) => {
		if (stopped) return;
		if (!filename) return;
		// Ignore irrelevant directories
		if (
			filename.startsWith(".git") ||
			filename.startsWith("node_modules") ||
			filename.startsWith(".evalgate")
		)
			return;

		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			if (running || stopped) return;
			running = true;

			runCycle(todoPath, failedIds, cwd, onCycle, handle)
				.catch(() => {
					// swallow — errors are non-fatal in watch mode
				})
				.finally(() => {
					running = false;
				});
		}, 300);
	});

	const handle: CheckWatchHandle = {
		stop() {
			if (stopped) return;
			stopped = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			try {
				watcher.close();
			} catch {
				// ignore
			}
		},
	};

	return handle;
}

async function runCycle(
	todoPath: string,
	failedIds: Set<string>,
	cwd: string,
	onCycle: CheckWatchOptions["onCycle"],
	handle: CheckWatchHandle,
): Promise<void> {
	const source = readFileSync(todoPath, "utf8");
	const all = parseTodo(source);
	const toRun = all.filter((c) => failedIds.has(c.id) && !c.checked && c.verifier);

	if (toRun.length === 0) {
		handle.stop();
		return;
	}

	const results: RunResult[] = [];
	for (const contract of toRun) {
		const result = await runContract(contract, cwd, {
			todoPath,
			trigger: "check-watch",
		});
		results.push(result);
		if (result.passed) failedIds.delete(contract.id);
	}

	// Write passing results back to todo.md
	const fresh = readFileSync(todoPath, "utf8");
	const updated = updateTodo(fresh, results);
	if (updated !== fresh) {
		writeFileSync(todoPath, updated);
	}

	onCycle?.(results);

	if (failedIds.size === 0) {
		handle.stop();
	}
}
