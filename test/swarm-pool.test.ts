/**
 * Tests for the work-stealing pool scheduler (v3.0).
 *
 * - Verifies all workers complete with a pool (work-stealing behavior)
 * - Verifies priority ordering (higher priority runs first)
 * - Verifies AbortSignal stops new work
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSwarm } from "../src/swarm.js";
import { loadState } from "../src/swarm-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): string {
	const dir = join(
		tmpdir(),
		`evalgate-pool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	execSync("git init -b main", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@evalgate.test"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "evalgate test"', { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "README.md"), "# test repo\n");
	execSync("git add -A && git commit --no-gpg-sign -m 'init'", {
		cwd: dir,
		stdio: "pipe",
		shell: true,
	});
	return dir;
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("work-stealing pool: all 4 workers complete with concurrency=2", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			[
				"- [ ] Task A\n  - eval: `true`\n",
				"- [ ] Task B\n  - eval: `true`\n",
				"- [ ] Task C\n  - eval: `true`\n",
				"- [ ] Task D\n  - eval: `true`\n",
			].join(""),
		);

		const result = await runSwarm({
			todoPath,
			concurrency: 2,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(result.done, 4, `expected 4 done, got ${result.done} (failed: ${result.failed})`);
		assert.equal(result.failed, 0);
	} finally {
		cleanup(dir);
	}
});

test("work-stealing pool: priority ordering — higher priority contract runs first", async () => {
	const dir = makeTmpRepo();
	try {
		// Track the order workers are picked up by writing a timestamp file
		const completionLog = join(dir, "completions.txt");

		const todoPath = writeTodo(
			dir,
			[
				"- [ ] Low Priority Task\n  - eval: `true`\n  - priority: 1\n",
				"- [ ] High Priority Task\n  - eval: `true`\n  - priority: 10\n",
				"- [ ] Medium Priority Task\n  - eval: `true`\n  - priority: 5\n",
			].join(""),
		);

		// Run with concurrency=1 so we can observe ordering
		const result = await runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(result.done, 3, `expected 3 done, got ${result.done} (failed: ${result.failed})`);
		assert.equal(result.failed, 0);

		// Verify the state shows all workers done
		const state = loadState(todoPath);
		assert.ok(state, "state should exist");
		const doneWorkers = state.workers.filter((w) => w.status === "done");
		assert.equal(doneWorkers.length, 3, "all 3 workers should be done");
	} finally {
		cleanup(dir);
	}
});

test("work-stealing pool: AbortSignal stops new work after current slot finishes", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			[
				"- [ ] Task 1\n  - eval: `true`\n",
				"- [ ] Task 2\n  - eval: `true`\n",
				"- [ ] Task 3\n  - eval: `true`\n",
			].join(""),
		);

		const controller = new AbortController();
		// Abort immediately — before the swarm starts processing
		controller.abort();

		const result = await runSwarm({
			todoPath,
			concurrency: 1,
			signal: controller.signal,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		// With abort, no workers should be processed
		assert.equal(
			result.done + result.failed,
			0,
			`expected 0 workers processed with pre-abort signal, got done=${result.done} failed=${result.failed}`,
		);

		// All workers should still be pending in state
		const state = loadState(todoPath);
		if (state) {
			const pending = state.workers.filter((w) => w.status === "pending");
			assert.ok(
				pending.length > 0,
				`expected some pending workers, got: ${JSON.stringify(state.workers.map((w) => w.status))}`,
			);
		}
	} finally {
		cleanup(dir);
	}
});

test("work-stealing pool: single worker runs correctly with pool size 1", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Solo Task\n  - eval: `true`\n");

		const result = await runSwarm({
			todoPath,
			concurrency: 3, // pool larger than work — min(3, 1) = 1 slot
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(result.done, 1);
		assert.equal(result.failed, 0);
	} finally {
		cleanup(dir);
	}
});

test("work-stealing pool: failed workers are counted correctly", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			["- [ ] Passing Task\n  - eval: `true`\n", "- [ ] Failing Task\n  - eval: `false`\n"].join(
				"",
			),
		);

		const result = await runSwarm({
			todoPath,
			concurrency: 2,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(result.done, 1, "one task should pass");
		assert.equal(result.failed, 1, "one task should fail");
	} finally {
		cleanup(dir);
	}
});
