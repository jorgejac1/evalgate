/**
 * Agent process spawner.
 *
 * Spawns an agent command in a given worktree directory and streams all
 * stdout+stderr to a log file. The process runs to completion; the resolved
 * value is the exit code.
 *
 * The default command is `claude --print "<task>"` which sends the
 * task title (optionally preceded by taskContext) as the first user message to
 * Claude Code in non-interactive mode.
 * Override with agentCmd/agentArgs for testing or alternative agents.
 * Use {task} in agentArgs as a placeholder that is replaced with the full
 * prompt (context + task title) at spawn time.
 *
 * Zero runtime dependencies — uses Node built-ins only.
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface SpawnOpts {
	/** Absolute path to the git worktree the agent should work in. */
	cwd: string;
	/** Task description sent as the initial prompt (used in default agentArgs). */
	task: string;
	/** Absolute path to the log file; parent directory is created if needed. */
	logPath: string;
	/** Agent executable. Defaults to "claude". */
	agentCmd?: string;
	/**
	 * Full arg list. Defaults to ["--print", fullTask].
	 * Use {task} as a placeholder — it is replaced with the full prompt
	 * (taskContext + task title) at spawn time.
	 */
	agentArgs?: string[];
	/**
	 * Context prepended to the task when building the prompt string.
	 * Injected before the contract title with a "## Task" separator.
	 * Works with any agent CLI — no special flags required.
	 */
	taskContext?: string;
	/**
	 * Additional environment variables to merge into the agent process env.
	 * Merged on top of process.env — use this for retry context injection.
	 */
	env?: Record<string, string>;
}

/**
 * Spawns the agent process and streams output to `logPath`.
 * Resolves with the agent process exit code (or -1 on spawn error).
 */
export async function spawnAgent(opts: SpawnOpts): Promise<number> {
	const { cwd, task, logPath } = opts;
	const cmd = opts.agentCmd ?? "claude";

	// Build the full prompt: prepend context if provided.
	// Strip UTF-8 BOM (\uFEFF) that Windows editors sometimes prepend to context files.
	const cleanContext = opts.taskContext?.replace(/^\uFEFF/, "");
	const fullTask = cleanContext ? `${cleanContext}\n\n---\n\n## Task\n\n${task}` : task;

	// Substitute {task} in custom args; fall back to Claude defaults.
	// An empty agentArgs array is treated as "not set" — prevents silently
	// spawning an agent with zero arguments when the user misconfigures it.
	const args =
		opts.agentArgs && opts.agentArgs.length > 0
			? opts.agentArgs.map((a) => a.replaceAll("{task}", fullTask))
			: ["--print", fullTask];

	mkdirSync(dirname(logPath), { recursive: true });
	const logStream = createWriteStream(logPath, { flags: "a" });

	// Write a header line so the log is self-describing.
	// Escape newlines and truncate to 200 chars so the header stays on a single
	// readable line even when a large taskContext is substituted into {task}.
	const rawHeader = args.join(" ").replace(/\n/g, "\\n");
	const safeArgs = rawHeader.length > 200 ? `${rawHeader.slice(0, 200)}…` : rawHeader;
	logStream.write(`[evalgate swarm] starting agent: ${cmd} ${safeArgs}\n`);
	logStream.write(`[evalgate swarm] cwd: ${cwd}\n`);
	logStream.write(`[evalgate swarm] ts: ${new Date().toISOString()}\n\n`);

	return new Promise<number>((resolve) => {
		const child = spawn(cmd, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			// Merge caller-supplied env vars on top of the current process env.
			// When undefined, spawn inherits process.env automatically.
			env: opts.env ? { ...process.env, ...opts.env } : undefined,
		});

		// Guard against both 'error' and 'close' firing (which happens on ENOENT).
		let settled = false;
		function settle(code: number): void {
			if (settled) return;
			settled = true;
			logStream.end(() => resolve(code));
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			if (!settled) logStream.write(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (!settled) logStream.write(chunk);
		});

		child.on("error", (err) => {
			if (!settled) logStream.write(`\n[evalgate swarm] spawn error: ${err.message}\n`);
			settle(-1);
		});

		child.on("close", (code) => {
			if (!settled) logStream.write(`\n[evalgate swarm] agent exited with code ${code ?? -1}\n`);
			settle(code ?? -1);
		});
	});
}
