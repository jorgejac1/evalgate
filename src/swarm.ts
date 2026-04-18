/**
 * evalgate swarm orchestrator — v0.9
 *
 * Spawns one agent worker per pending contract in isolated git worktrees,
 * runs the evalgate verifier after each agent finishes, and merges back only
 * when the verifier passes.
 *
 * State machine per worker:
 *   pending → spawning → running → verifying → merging → done
 *                                             → failed
 *
 * All state transitions are written atomically to .evalgate/swarm-state.json
 * so the run can be inspected or resumed after a crash.
 *
 * Zero runtime dependencies — uses Node built-ins only.
 */

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { parseTodo } from "./parser.js";
import { spawnAgent } from "./spawn.js";
import { loadState, saveState, updateWorker } from "./swarm-state.js";
import type {
	Contract,
	EvalResultEvent,
	SwarmState,
	TaskCompleteEvent,
	WorkerState,
	WorkerStatus,
} from "./types.js";
import { runContract } from "./verifier.js";
import {
	createWorktree,
	deleteBranch,
	getRepoRoot,
	mergeWorktree,
	removeWorktree,
} from "./worktree.js";
import { updateTodo } from "./writer.js";

// ---------------------------------------------------------------------------
// Public event emitter — ui.ts subscribes to this for SSE
// ---------------------------------------------------------------------------

/** Emits "worker" (WorkerState) and "state" (SwarmState) events. */
export const swarmEvents = new EventEmitter();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SwarmOptions {
	todoPath: string;
	/** Max parallel workers. Defaults to 3. */
	concurrency?: number;
	/** Re-attach to an interrupted swarm run by reading swarm-state.json. */
	resume?: boolean;
	/** Agent executable. Defaults to "claude". */
	agentCmd?: string;
	/** Full agent arg list. When set, overrides the default --headless --print args. */
	agentArgs?: string[];
}

export interface SwarmResult {
	done: number;
	failed: number;
	skipped: number;
	state: SwarmState;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
}

function workerLogPath(todoPath: string, workerId: string): string {
	return join(dirname(todoPath), ".evalgate", "sessions", `${workerId}.log`);
}

function emitWorker(
	todoPath: string,
	id: string,
	status: WorkerStatus,
	extra?: Partial<WorkerState>,
): void {
	updateWorker(todoPath, id, { status, ...extra });
	const state = loadState(todoPath);
	const worker = state?.workers.find((w) => w.id === id);
	if (worker) swarmEvents.emit("worker", worker);
	if (state) swarmEvents.emit("state", state);
}

function emitTaskComplete(workerId: string, contractId: string, status: "done" | "failed"): void {
	swarmEvents.emit("task-complete", {
		type: "task-complete",
		workerId,
		contractId,
		status,
	} satisfies TaskCompleteEvent);
}

// ---------------------------------------------------------------------------
// Single worker lifecycle
// ---------------------------------------------------------------------------

async function runWorker(
	worker: WorkerState,
	contract: Contract,
	todoPath: string,
	repoRoot: string,
	opts: SwarmOptions,
	/** Optional extra env vars merged into the agent process environment. */
	extraEnv?: Record<string, string>,
): Promise<void> {
	const now = () => new Date().toISOString();

	// ── 1. spawning ──────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "spawning", { startedAt: now() });

	try {
		createWorktree(repoRoot, worker.branch, worker.worktreePath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		writeFileSync(worker.logPath, `[evalgate swarm] worktree creation failed: ${msg}\n`);
		emitWorker(todoPath, worker.id, "failed", { finishedAt: now() });
		emitTaskComplete(worker.id, contract.id, "failed");
		return;
	}

	// Copy todo.md into the worktree so the verifier can reference it.
	const worktreeTodoPath = join(worker.worktreePath, "todo.md");
	writeFileSync(worktreeTodoPath, readFileSync(todoPath, "utf8"));

	// ── 2. running ───────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "running");

	const agentExit = await spawnAgent({
		cwd: worker.worktreePath,
		task: contract.title,
		logPath: worker.logPath,
		agentCmd: opts.agentCmd,
		agentArgs: opts.agentArgs,
		env: extraEnv,
	});

	// ── 3. verifying ─────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "verifying", { agentExitCode: agentExit });

	const result = await runContract(contract, worker.worktreePath, {
		todoPath: worktreeTodoPath,
		trigger: "manual",
	});

	swarmEvents.emit("eval-result", {
		type: "eval-result",
		workerId: worker.id,
		contractId: contract.id,
		passed: result.passed,
		output: result.stdout,
		durationMs: result.durationMs,
	} satisfies EvalResultEvent);

	if (!result.passed) {
		// Keep the worktree for human inspection.
		emitWorker(todoPath, worker.id, "failed", { verifierPassed: false, finishedAt: now() });
		emitTaskComplete(worker.id, contract.id, "failed");
		return;
	}

	// ── 4. merging ───────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "merging", { verifierPassed: true });

	// Update the checkbox in the worktree's todo.md and commit.
	const updatedSource = updateTodo(readFileSync(worktreeTodoPath, "utf8"), [result]);
	writeFileSync(worktreeTodoPath, updatedSource);

	try {
		execSync("git add -A", { cwd: worker.worktreePath, stdio: "pipe" });
		// Unstage .evalgate/ — runContract writes run logs there, and merging
		// them causes add/add conflicts when multiple workers run in parallel.
		try {
			execSync("git restore --staged .evalgate", { cwd: worker.worktreePath, stdio: "pipe" });
		} catch {
			/* .evalgate wasn't staged — fine */
		}
		execSync(`git commit --no-gpg-sign -m "evalgate: ${contract.title}"`, {
			cwd: worker.worktreePath,
			stdio: "pipe",
		});
	} catch {
		// Commit may fail if the agent already committed everything, or if
		// there are no staged changes. Both are fine — proceed with merge.
	}

	try {
		mergeWorktree(repoRoot, worker.branch);
	} catch (err) {
		// Merge conflict or other git failure — keep the worktree.
		const msg = err instanceof Error ? err.message : String(err);
		writeFileSync(worker.logPath, `\n[evalgate swarm] merge failed: ${msg}\n`, { flag: "a" });
		emitWorker(todoPath, worker.id, "failed", { finishedAt: now() });
		emitTaskComplete(worker.id, contract.id, "failed");
		return;
	}

	// Clean up: worktree and branch are no longer needed.
	removeWorktree(repoRoot, worker.worktreePath);
	deleteBranch(repoRoot, worker.branch);

	emitWorker(todoPath, worker.id, "done", { finishedAt: now() });
	emitTaskComplete(worker.id, contract.id, "done");
}

// ---------------------------------------------------------------------------
// Retry a single failed worker
// ---------------------------------------------------------------------------

/**
 * Retries a failed worker by id.
 *
 * Reads the last 100 lines of the worker's log and injects them as failure
 * context via the `EVALGATE_RETRY_CONTEXT_FILE` environment variable.  The
 * agent can read that file to understand what went wrong on the previous
 * attempt.  This is a hint — the retry does not block on the agent reading it.
 *
 * Throws if:
 *  - No swarm state exists for the given todoPath.
 *  - The worker id is not found in the persisted state.
 *  - The worker's current status is not "failed" (only failed workers are
 *    retryable; use --resume for in-flight recovery).
 *  - The contract for the worker is no longer present in the todo file.
 */
export async function retryWorker(
	workerId: string,
	todoPath: string,
	opts: SwarmOptions,
): Promise<WorkerState> {
	const resolvedTodoPath = resolvePath(todoPath);

	const state = loadState(resolvedTodoPath);
	if (!state) {
		throw new Error(`no swarm state found for: ${resolvedTodoPath}`);
	}

	const worker = state.workers.find((w) => w.id === workerId);
	if (!worker) {
		throw new Error(`worker not found: ${workerId}`);
	}
	if (worker.status !== "failed") {
		throw new Error(
			`worker ${workerId} is not retryable — status is "${worker.status}" (must be "failed")`,
		);
	}

	// Write the last 100 lines of the failure log to a temp file so the agent
	// can read it via EVALGATE_RETRY_CONTEXT_FILE.
	const contextFile = join(tmpdir(), `evalgate-retry-context-${workerId}-${Date.now()}.txt`);
	if (existsSync(worker.logPath)) {
		const logContent = readFileSync(worker.logPath, "utf8");
		const lines = logContent.split("\n");
		const last100 = lines.slice(Math.max(0, lines.length - 100)).join("\n");
		writeFileSync(
			contextFile,
			`# Retry context for worker ${workerId}\n# Previous failure log (last 100 lines):\n\n${last100}\n`,
		);
	} else {
		writeFileSync(
			contextFile,
			`# Retry context for worker ${workerId}\n# No previous log found.\n`,
		);
	}

	// Clean up leftover worktree and branch from the failed run before retrying.
	// runWorker keeps them for human inspection after a failure, so we must tidy
	// them up here to allow createWorktree to succeed with the same branch name.
	const repoRoot = getRepoRoot(dirname(resolvedTodoPath));
	removeWorktree(repoRoot, worker.worktreePath);
	deleteBranch(repoRoot, worker.branch);

	// Reset the worker to pending, clearing transient fields from the failed run.
	updateWorker(resolvedTodoPath, workerId, {
		status: "pending",
		finishedAt: undefined,
		verifierPassed: undefined,
		agentExitCode: undefined,
	});

	// Re-read the reset worker record (updateWorker writes atomically).
	const freshState = loadState(resolvedTodoPath);
	const freshWorker = freshState?.workers.find((w) => w.id === workerId);
	if (!freshWorker) {
		throw new Error(`worker ${workerId} disappeared from state after reset — this is a bug`);
	}

	if (!existsSync(resolvedTodoPath)) {
		throw new Error(`todo file not found: ${resolvedTodoPath}`);
	}
	const source = readFileSync(resolvedTodoPath, "utf8");
	const contracts = parseTodo(source);
	const contract = contracts.find((c) => c.id === freshWorker.contractId);
	if (!contract) {
		throw new Error(
			`contract "${freshWorker.contractId}" not found in ${resolvedTodoPath} — was the task removed?`,
		);
	}

	// Run the full worker lifecycle with the failure context injected via env.
	await runWorker(freshWorker, contract, resolvedTodoPath, repoRoot, opts, {
		EVALGATE_RETRY_CONTEXT_FILE: contextFile,
	});

	// Return the final state from disk (runWorker writes it via emitWorker).
	const finalState = loadState(resolvedTodoPath);
	const finalWorker = finalState?.workers.find((w) => w.id === workerId);
	if (!finalWorker) {
		throw new Error(`worker ${workerId} missing from state after retry — this is a bug`);
	}
	return finalWorker;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSwarm(opts: SwarmOptions): Promise<SwarmResult> {
	const todoPath = resolvePath(opts.todoPath);
	const concurrency = opts.concurrency ?? 3;

	if (!existsSync(todoPath)) {
		throw new Error(`todo file not found: ${todoPath}`);
	}

	const repoRoot = getRepoRoot(dirname(todoPath));
	const source = readFileSync(todoPath, "utf8");
	const contracts = parseTodo(source).filter((c) => !c.checked && c.verifier);

	if (contracts.length === 0) {
		const emptyState: SwarmState = {
			id: randomUUID(),
			ts: new Date().toISOString(),
			todoPath,
			workers: [],
		};
		return { done: 0, failed: 0, skipped: 0, state: emptyState };
	}

	// ── Build or resume SwarmState ──────────────────────────────────────────
	function buildFreshState(): SwarmState {
		mkdirSync(join(dirname(todoPath), ".evalgate", "sessions"), { recursive: true });
		const fresh: SwarmState = {
			id: randomUUID(),
			ts: new Date().toISOString(),
			todoPath,
			workers: contracts.map((c) => {
				const wid = randomUUID().slice(0, 8);
				const branch = `evalgate/${slugify(c.title)}-${wid}`;
				const worktreePath = join(repoRoot, `.evalgate-worktrees`, wid);
				return {
					id: wid,
					contractId: c.id,
					contractTitle: c.title,
					worktreePath,
					branch,
					status: "pending" as WorkerStatus,
					logPath: workerLogPath(todoPath, wid),
				};
			}),
		};
		saveState(todoPath, fresh);
		return fresh;
	}

	let state: SwarmState;

	if (opts.resume) {
		const existing = loadState(todoPath);
		if (existing) {
			state = existing;
			// Workers that were mid-flight when the process died are reset to pending.
			for (const w of state.workers) {
				if (["spawning", "running", "verifying", "merging"].includes(w.status)) {
					w.status = "pending";
				}
			}
			saveState(todoPath, state);
		} else {
			state = buildFreshState();
		}
	} else {
		state = buildFreshState();
	}

	swarmEvents.emit("state", state);

	// ── Process workers with concurrency limit (batch approach) ──────────────
	const pending = state.workers.filter((w) => w.status === "pending");
	const contractMap = new Map(contracts.map((c) => [c.id, c]));

	let done = 0;
	let failed = 0;
	let skipped = 0;

	for (let i = 0; i < pending.length; i += concurrency) {
		const batch = pending.slice(i, i + concurrency);
		await Promise.allSettled(
			batch.map(async (worker) => {
				const contract = contractMap.get(worker.contractId);
				if (!contract) {
					skipped++;
					return;
				}
				await runWorker(worker, contract, todoPath, repoRoot, opts);
				// Read fresh state to get the actual final status.
				const fresh = loadState(todoPath);
				const w = fresh?.workers.find((x) => x.id === worker.id);
				if (w?.status === "done") done++;
				else if (w?.status === "failed") failed++;
			}),
		);
	}

	const finalState = loadState(todoPath) ?? state;
	swarmEvents.emit("state", finalState);
	return { done, failed, skipped, state: finalState };
}
