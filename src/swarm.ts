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
import { reportTokenUsage } from "./budget.js";
import { appendRun } from "./log.js";
import { parseTodo } from "./parser.js";
import { spawnAgent } from "./spawn.js";
import { loadState, saveState, updateWorker } from "./swarm-state.js";
import type {
	BudgetExceededEvent,
	Contract,
	EvalResultEvent,
	FailureKind,
	SwarmState,
	TaskCompleteEvent,
	WorkerRetryEvent,
	WorkerRunner,
	WorkerRunOpts,
	WorkerStartEvent,
	WorkerState,
	WorkerStatus,
} from "./types.js";
import { slugify as _slugifyBase } from "./utils.js";
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
// LocalRunner — default WorkerRunner that wraps spawnAgent
// ---------------------------------------------------------------------------

export class LocalRunner implements WorkerRunner {
	async run(opts: WorkerRunOpts): Promise<number> {
		return spawnAgent(opts);
	}
}

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
	/**
	 * Context string prepended to every task in this swarm run.
	 * Use {task} in agentArgs to reference the full prompt (context + title).
	 */
	taskContext?: string;
	/**
	 * Abort signal — when aborted, stops spawning new workers after the current
	 * batch completes. In-flight workers run to completion (or to agentTimeoutMs).
	 * Abort granularity is one batch; remaining pending workers stay in "pending"
	 * state so resumeSwarm() can pick them up.
	 */
	signal?: AbortSignal;
	/**
	 * Called after a worker transitions to "spawning". Fired after the swarmEvents
	 * "worker-start" event so existing listeners are unaffected.
	 * Exceptions thrown here are swallowed and do not affect the worker.
	 */
	onWorkerStart?: (worker: WorkerState) => void | Promise<void>;
	/**
	 * Called after a worker reaches a terminal state ("done" or "failed"). Fired
	 * after both the swarmEvents "task-complete" event and disk state update.
	 * Exceptions thrown here are swallowed and do not affect the worker.
	 */
	onWorkerComplete?: (
		worker: WorkerState,
		result: { status: "done" | "failed"; failureKind?: FailureKind },
	) => void | Promise<void>;
	/**
	 * Called when cumulative token spend crosses a contract budget. Wired to the
	 * "budget-exceeded" swarmEvent; useful for aborting the swarm inline.
	 * Exceptions thrown here are swallowed.
	 */
	onBudgetExceeded?: (evt: BudgetExceededEvent) => void | Promise<void>;
	/**
	 * Custom worker runner — defaults to LocalRunner (wraps spawnAgent).
	 * Provide SSHRunner or DockerRunner from conductor-agents for remote execution.
	 */
	runner?: WorkerRunner;
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

// Git branch names capped at 40 chars for safety
const slugify = (s: string) => _slugifyBase(s, 40);

/**
 * Simple async mutex — ensures at most one holder at a time.
 *
 * Used to serialize the commit+merge phase across concurrent workers so that
 * each worker reads the latest todo.md from the main branch before committing,
 * preventing add/add conflicts on todo.md when multiple workers merge in parallel.
 */
class Mutex {
	private _locked = false;
	private _queue: Array<() => void> = [];

	acquire(): Promise<void> {
		if (!this._locked) {
			this._locked = true;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this._queue.push(resolve);
		});
	}

	release(): void {
		const next = this._queue.shift();
		if (next) {
			next();
		} else {
			this._locked = false;
		}
	}
}

/**
 * One Mutex per repo root — shared across all concurrent swarm runs that
 * operate on the same git repository. This prevents cross-track merge
 * conflicts when multiple tracks are run simultaneously in the same repo.
 */
const repoMutexes = new Map<string, Mutex>();

function getRepoMutex(repoRoot: string): Mutex {
	let m = repoMutexes.get(repoRoot);
	if (!m) {
		m = new Mutex();
		repoMutexes.set(repoRoot, m);
	}
	return m;
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

function emitTaskComplete(
	workerId: string,
	contractId: string,
	status: "done" | "failed",
	reason?: FailureKind,
): void {
	swarmEvents.emit("task-complete", {
		type: "task-complete",
		workerId,
		contractId,
		status,
		...(reason !== undefined ? { reason } : {}),
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
	/** Shared mutex that serializes the commit+merge phase across concurrent workers. */
	mergeMutex?: Mutex,
): Promise<void> {
	const now = () => new Date().toISOString();

	// ── 1. spawning ──────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "spawning", { startedAt: now() });
	swarmEvents.emit("worker-start", {
		type: "worker-start",
		workerId: worker.id,
		contractId: contract.id,
	} satisfies WorkerStartEvent);
	if (opts.onWorkerStart) {
		try {
			await opts.onWorkerStart(
				loadState(todoPath)?.workers.find((w) => w.id === worker.id) ?? worker,
			);
		} catch {
			/* consumer exceptions must not abort the worker */
		}
	}

	// Fires after emitWorker + emitTaskComplete so disk state is already final.
	async function fireComplete(status: "done" | "failed", failureKind?: FailureKind): Promise<void> {
		if (!opts.onWorkerComplete) return;
		try {
			const fresh = loadState(todoPath)?.workers.find((w) => w.id === worker.id) ?? worker;
			await opts.onWorkerComplete(fresh, { status, failureKind });
		} catch {
			/* consumer exceptions must not affect the worker result */
		}
	}

	try {
		createWorktree(repoRoot, worker.branch, worker.worktreePath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		writeFileSync(worker.logPath, `[evalgate swarm] worktree creation failed: ${msg}\n`);
		emitWorker(todoPath, worker.id, "failed", {
			finishedAt: now(),
			failureKind: "worktree-create",
		});
		emitTaskComplete(worker.id, contract.id, "failed", "worktree-create");
		await fireComplete("failed", "worktree-create");
		return;
	}

	// Copy todo.md into the worktree so the verifier can reference it.
	const worktreeTodoPath = join(worker.worktreePath, "todo.md");
	writeFileSync(worktreeTodoPath, readFileSync(todoPath, "utf8"));

	// ── 2. running ───────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "running");

	const runner = opts.runner ?? new LocalRunner();
	const agentExit = await runner.run({
		cwd: worker.worktreePath,
		task: contract.title,
		logPath: worker.logPath,
		agentCmd: opts.agentCmd,
		agentArgs: opts.agentArgs,
		taskContext: opts.taskContext,
		env: extraEnv,
	});

	// Extract token usage from the log file. When using the default claude args
	// (--output-format json), the log contains a single {"type":"result",...} line
	// with usage counts. Best-effort — silently skipped for custom agents that
	// don't emit this format.
	try {
		const logContent = readFileSync(worker.logPath, "utf8");
		for (const line of logContent.split("\n").reverse()) {
			if (!line.trim().startsWith("{")) continue;
			const obj = JSON.parse(line) as Record<string, unknown>;
			if (obj["type"] === "result") {
				const usage = obj["usage"] as Record<string, number> | undefined;
				const input = usage?.["input_tokens"] ?? 0;
				const output = usage?.["output_tokens"] ?? 0;
				if (input > 0 || output > 0) {
					reportTokenUsage(todoPath, worker.contractId, input + output, undefined, {
						inputTokens: input,
						outputTokens: output,
						workerId: worker.id,
					});
				}
				break;
			}
		}
	} catch {
		// Log not available or non-JSON agent — skip token tracking.
	}

	// Exit code -2 is the timeout sentinel set by spawnAgent when agentTimeoutMs
	// is exceeded. Don't proceed to verifier — the agent didn't finish its work.
	if (agentExit === -2) {
		emitWorker(todoPath, worker.id, "failed", {
			agentExitCode: agentExit,
			finishedAt: now(),
			failureKind: "agent-timeout",
		});
		emitTaskComplete(worker.id, contract.id, "failed", "agent-timeout");
		await fireComplete("failed", "agent-timeout");
		return;
	}

	// ── 3. verifying ─────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "verifying", { agentExitCode: agentExit });

	const result = await runContract(contract, worker.worktreePath, {
		todoPath: worktreeTodoPath,
		trigger: "swarm",
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
		const verifierFailureKind: FailureKind = result.timedOut ? "verifier-timeout" : "verifier-fail";
		emitWorker(todoPath, worker.id, "failed", {
			verifierPassed: false,
			finishedAt: now(),
			failureKind: verifierFailureKind,
		});
		emitTaskComplete(worker.id, contract.id, "failed", verifierFailureKind);
		await fireComplete("failed", verifierFailureKind);
		// Mirror FAIL to canonical todoPath — eval definitively failed, record it now.
		appendRun(result, todoPath, "swarm");
		return;
	}

	// ── 4. merging ───────────────────────────────────────────────────────────
	emitWorker(todoPath, worker.id, "merging", { verifierPassed: true });

	// Serialize commit+merge across concurrent workers via the shared mutex.
	// Without serialization, two workers can branch from the same HEAD, both
	// update todo.md, and produce an add/add conflict on merge.
	//
	// Inside the lock we read the LATEST todo.md from the main repo (not the
	// stale worktree copy) so each worker's commit is a superset of all
	// previously merged workers — making the subsequent git merge conflict-free.
	if (mergeMutex) await mergeMutex.acquire();
	try {
		// Read the current main-branch todo.md and apply this worker's result.
		const latestSource = readFileSync(todoPath, "utf8");
		const updatedSource = updateTodo(latestSource, [result]);
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

		mergeWorktree(repoRoot, worker.branch);
	} catch (err) {
		// Merge conflict or other git failure — keep the worktree.
		const msg = err instanceof Error ? err.message : String(err);
		writeFileSync(worker.logPath, `\n[evalgate swarm] merge failed: ${msg}\n`, { flag: "a" });
		emitWorker(todoPath, worker.id, "failed", {
			finishedAt: now(),
			failureKind: "merge-conflict",
		});
		emitTaskComplete(worker.id, contract.id, "failed", "merge-conflict");
		await fireComplete("failed", "merge-conflict");
		return;
	} finally {
		if (mergeMutex) mergeMutex.release();
	}

	// Clean up: worktree and branch are no longer needed.
	removeWorktree(repoRoot, worker.worktreePath);
	deleteBranch(repoRoot, worker.branch);

	emitWorker(todoPath, worker.id, "done", { finishedAt: now() });
	emitTaskComplete(worker.id, contract.id, "done");
	await fireComplete("done");
	// Mirror PASS to canonical todoPath — only after successful merge.
	appendRun(result, todoPath, "swarm");
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

	// Evaluate retryIf condition if defined — skip retry when condition is false.
	const freshContracts = parseTodo(readFileSync(resolvePath(todoPath), "utf8"));
	const targetContract = freshContracts.find((c) => c.id === worker.contractId);
	if (targetContract?.retryIf !== undefined) {
		const lastExitCode = worker.agentExitCode ?? 0;
		const { op, value } = targetContract.retryIf.exitCode;
		const conditionMet =
			op === "=="
				? lastExitCode === value
				: op === "!="
					? lastExitCode !== value
					: op === ">"
						? lastExitCode > value
						: op === "<"
							? lastExitCode < value
							: op === ">="
								? lastExitCode >= value
								: lastExitCode <= value;
		if (!conditionMet) {
			updateWorker(resolvedTodoPath, workerId, {
				status: "failed",
				finishedAt: new Date().toISOString(),
				failureKind: "verifier-fail",
			});
			const finalW = loadState(resolvedTodoPath)?.workers.find((w) => w.id === workerId);
			if (!finalW) throw new Error(`worker ${workerId} missing from state — this is a bug`);
			return finalW;
		}
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

	// Announce the retry before spawning so consumers can update UI state.
	swarmEvents.emit("worker-retry", {
		type: "worker-retry",
		workerId,
		contractId: freshWorker.contractId,
	} satisfies WorkerRetryEvent);

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

	// ── Process workers with work-stealing pool ──────────────────────────────
	const contractMap = new Map(contracts.map((c) => [c.id, c]));
	const allPending = state.workers.filter((w) => w.status === "pending");

	// Sort by priority descending — higher priority workers run first.
	allPending.sort((a, b) => {
		const pa = contractMap.get(a.contractId)?.priority ?? 0;
		const pb = contractMap.get(b.contractId)?.priority ?? 0;
		return pb - pa;
	});

	// Work-stealing pool: N slots each grab the next pending worker from the queue.
	// No head-of-line blocking — a slow worker doesn't delay the next batch.
	const queue = [...allPending];
	const mergeMutex = getRepoMutex(repoRoot);

	let done = 0;
	let failed = 0;
	let skipped = 0;

	// Wire onBudgetExceeded to swarmEvents so it fires for any contract breach
	// that occurs during this run, regardless of which worker triggers it.
	let budgetHandler: ((evt: BudgetExceededEvent) => void) | undefined;
	if (opts.onBudgetExceeded) {
		budgetHandler = (evt: BudgetExceededEvent) => {
			try {
				void opts.onBudgetExceeded?.(evt);
			} catch {
				/* swallow */
			}
		};
		swarmEvents.on("budget-exceeded", budgetHandler);
	}

	try {
		const poolSize = Math.min(concurrency, allPending.length);

		async function runSlot(): Promise<void> {
			while (true) {
				if (opts.signal?.aborted) break;
				const worker = queue.shift();
				if (!worker) break;
				const contract = contractMap.get(worker.contractId);
				if (!contract) {
					skipped++;
					continue;
				}
				await runWorker(worker, contract, todoPath, repoRoot, opts, undefined, mergeMutex);
				const fresh = loadState(todoPath);
				const w = fresh?.workers.find((x) => x.id === worker.id);
				if (w?.status === "done") done++;
				else if (w?.status === "failed") failed++;
			}
		}

		const slots = Array.from({ length: poolSize }, runSlot);
		await Promise.allSettled(slots);
	} finally {
		if (budgetHandler) swarmEvents.off("budget-exceeded", budgetHandler);
	}

	const finalState = loadState(todoPath) ?? state;
	swarmEvents.emit("state", finalState);
	return { done, failed, skipped, state: finalState };
}

// ---------------------------------------------------------------------------
// Convenience entry point for resuming an interrupted run
// ---------------------------------------------------------------------------

/**
 * Resume a previously interrupted swarm run from its persisted state file or
 * todo path. Equivalent to runSwarm({ ...opts, todoPath, resume: true }).
 *
 * @param todoPath - Path to the todo.md (or its sibling swarm-state.json —
 *   the function resolves both forms automatically).
 * @param opts - Partial SwarmOptions merged with the resolved todoPath.
 *   resume is forced to true; any other options override defaults.
 * @throws if no prior swarm state exists for the given path.
 */
export async function resumeSwarm(
	todoPath: string,
	opts: Partial<Omit<SwarmOptions, "todoPath" | "resume">> = {},
): Promise<SwarmResult> {
	const resolved = resolvePath(
		todoPath.endsWith("swarm-state.json")
			? todoPath.replace(/\.evalgate[/\\]swarm-state\.json$/, "todo.md")
			: todoPath,
	);

	// Validate that prior state exists before delegating to runSwarm.
	const existing = loadState(resolved);
	if (!existing) {
		throw new Error(`resumeSwarm: no prior swarm state found for: ${resolved}`);
	}

	return runSwarm({ ...opts, todoPath: resolved, resume: true } as SwarmOptions);
}
