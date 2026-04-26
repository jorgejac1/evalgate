/**
 * Tests for the SwarmOptions.parseUsage hook (evalgate v3.2).
 *
 * Verifies that the optional parseUsage function overrides the built-in
 * Claude JSON parser, and that the default parser still works when no hook
 * is provided.
 *
 * Each test uses a real git repo and a lightweight agentCmd (node -e) so
 * the full swarm infrastructure runs without calling any external service.
 * The agent writes controlled output to its log file via stdout, which
 * LocalRunner captures verbatim.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getTotalTokens, queryBudgetRecords, runSwarm } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): string {
	const dir = join(tmpdir(), `eg-parse-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	execSync("git init -b main", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@evalgate.test"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "evalgate test"', { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "# test\n");
	execSync("git add -A && git commit --no-gpg-sign -m 'init'", {
		cwd: dir,
		stdio: "pipe",
		shell: true,
	});
	return dir;
}

function writeTodo(dir: string, content: string): string {
	const p = join(dir, "todo.md");
	writeFileSync(p, content);
	execSync("git add todo.md && git commit --no-gpg-sign -m 'add todo'", {
		cwd: dir,
		stdio: "pipe",
		shell: true,
	});
	return p;
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

// A one-task todo that passes its eval immediately.
const PASSING_TASK = "- [ ] Task A\n  - eval: `true`\n";

// Claude --output-format json result line shape.
function claudeResultLine(input: number, output: number): string {
	return JSON.stringify({ type: "result", usage: { input_tokens: input, output_tokens: output } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SwarmOptions.parseUsage hook", () => {
	it("should call the hook and record its return value in budget.db", async () => {
		const dir = makeTmpRepo();
		try {
			const todoPath = writeTodo(dir, PASSING_TASK);
			let hookCallCount = 0;

			const result = await runSwarm({
				todoPath,
				concurrency: 1,
				agentCmd: "node",
				agentArgs: ["-e", "process.exit(0)"],
				parseUsage: (_logContent, _stderr) => {
					hookCallCount++;
					return { inputTokens: 100, outputTokens: 50 };
				},
			});

			assert.equal(result.done, 1, "task should complete");
			assert.equal(result.failed, 0);
			assert.equal(hookCallCount, 1, "parseUsage should be called exactly once");

			const records = queryBudgetRecords(todoPath);
			assert.equal(records.length, 1, "one budget record should be written");
			assert.equal(records[0]?.inputTokens, 100);
			assert.equal(records[0]?.outputTokens, 50);
			assert.equal(records[0]?.tokens, 150);
		} finally {
			cleanup(dir);
		}
	});

	it("should not insert a budget row when hook returns null", async () => {
		const dir = makeTmpRepo();
		try {
			const todoPath = writeTodo(dir, PASSING_TASK);

			const result = await runSwarm({
				todoPath,
				concurrency: 1,
				agentCmd: "node",
				agentArgs: ["-e", "process.exit(0)"],
				parseUsage: () => null,
			});

			assert.equal(result.done, 1);
			const records = queryBudgetRecords(todoPath);
			assert.equal(records.length, 0, "no budget row when hook returns null");
		} finally {
			cleanup(dir);
		}
	});

	it("should not crash the worker when hook throws, and should record 0 tokens", async () => {
		const dir = makeTmpRepo();
		try {
			const todoPath = writeTodo(dir, PASSING_TASK);

			const result = await runSwarm({
				todoPath,
				concurrency: 1,
				agentCmd: "node",
				agentArgs: ["-e", "process.exit(0)"],
				parseUsage: () => {
					throw new Error("plugin parse failure");
				},
			});

			// Worker must still complete (not fail) — plugin error doesn't kill the worker
			assert.equal(result.done, 1, "worker should complete even if parseUsage throws");
			assert.equal(result.failed, 0);

			// No record inserted (hook threw before returning a value)
			const records = queryBudgetRecords(todoPath);
			assert.equal(records.length, 0, "no budget row when hook throws");
		} finally {
			cleanup(dir);
		}
	});

	it("should use the default Claude parser when no hook is provided and log has Claude format", async () => {
		const dir = makeTmpRepo();
		try {
			const todoPath = writeTodo(dir, PASSING_TASK);

			// Agent writes a Claude-format result line to stdout → captured in logPath
			const claudeLine = claudeResultLine(200, 80);
			const result = await runSwarm({
				todoPath,
				concurrency: 1,
				agentCmd: "node",
				agentArgs: ["-e", `console.log(${JSON.stringify(claudeLine)})`],
				// No parseUsage — default Claude parser must fire
			});

			assert.equal(result.done, 1);
			const total = getTotalTokens(todoPath, "task-a");
			assert.equal(total, 280, "default Claude parser should record 200+80=280 tokens");
		} finally {
			cleanup(dir);
		}
	});

	it("should record zero tokens (no row) when no hook and log has non-Claude format", async () => {
		const dir = makeTmpRepo();
		try {
			const todoPath = writeTodo(dir, PASSING_TASK);

			// Agent writes arbitrary non-JSON output — default parser finds no result line
			const result = await runSwarm({
				todoPath,
				concurrency: 1,
				agentCmd: "node",
				agentArgs: ["-e", 'console.log("Tokens: 123 sent, 456 received")'],
				// No parseUsage — default Claude parser should return null
			});

			assert.equal(result.done, 1);
			const records = queryBudgetRecords(todoPath);
			assert.equal(records.length, 0, "no row when log has non-Claude format and no hook");
		} finally {
			cleanup(dir);
		}
	});

	it("should call hook with the log file content", async () => {
		const dir = makeTmpRepo();
		try {
			const todoPath = writeTodo(dir, PASSING_TASK);

			let capturedLog = "";
			const agentOutput = "agent output line 1\nagent output line 2\n";

			const result = await runSwarm({
				todoPath,
				concurrency: 1,
				agentCmd: "node",
				agentArgs: ["-e", `process.stdout.write(${JSON.stringify(agentOutput)})`],
				parseUsage: (logContent) => {
					capturedLog = logContent;
					return null;
				},
			});

			assert.equal(result.done, 1);
			assert.ok(
				capturedLog.includes("agent output line 1"),
				`hook should receive log content; got: ${capturedLog.slice(0, 200)}`,
			);
		} finally {
			cleanup(dir);
		}
	});
});
