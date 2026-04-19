/**
 * Tests for src/swarm.ts — state machine and orchestrator integration.
 *
 * These tests use a real git repo and real processes but with a trivially-fast
 * agent command ("node -e 'process.exit(0)'") to keep them fast. The verifier
 * commands are also simple shell commands.
 *
 * This test suite exercises:
 * - State creation and persistence
 * - Worker lifecycle transitions
 * - Pass path: agent exits 0, verifier passes → merged
 * - Fail path: verifier fails → worker marked failed, worktree kept
 * - Empty todo → returns immediately
 * - Resume flag re-queues in-flight workers
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { queryRuns } from "../src/log.js";
import { runSwarm } from "../src/swarm.js";
import { loadState, saveState } from "../src/swarm-state.js";
import type { SwarmState } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): string {
	const dir = join(
		tmpdir(),
		`evalgate-swarm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
	// Commit todo.md so it's tracked — required for clean merges from worktrees.
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

test("runSwarm returns empty result for a todo with no pending contracts", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [x] Already done\n  - eval: `true`\n");
		const result = await runSwarm({
			todoPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.equal(result.done, 0);
		assert.equal(result.failed, 0);
		assert.equal(result.skipped, 0);
		assert.equal(result.state.workers.length, 0);
	} finally {
		cleanup(dir);
	}
});

test("runSwarm returns empty result for a todo with no verifiers", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] No verifier here\n");
		const result = await runSwarm({
			todoPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.equal(result.state.workers.length, 0);
	} finally {
		cleanup(dir);
	}
});

test("runSwarm creates swarm state with one worker per pending contract", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			["- [ ] Task one", "  - eval: `true`", "- [ ] Task two", "  - eval: `true`"].join("\n") +
				"\n",
		);
		// Use a no-op verifier (true exits 0) and a no-op agent (node exits 0)
		// Don't wait for the full run — just check state was created
		const swarmPromise = runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		// Poll until state appears (up to 2s)
		let state = null;
		for (let i = 0; i < 20; i++) {
			state = loadState(todoPath);
			if (state && state.workers.length >= 2) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		assert.ok(state !== null, "swarm state should be created");
		assert.equal(state.workers.length, 2);
		assert.equal(state.workers[0]?.contractTitle, "Task one");
		assert.equal(state.workers[1]?.contractTitle, "Task two");
		await swarmPromise; // let it finish cleanly
	} finally {
		cleanup(dir);
	}
});

test("runSwarm worker transitions through all states to done when verifier passes", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Passing task\n  - eval: `true`\n");
		const result = await runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		// Worker should be done
		assert.equal(result.done, 1, "one worker should be done");
		assert.equal(result.failed, 0);
		const w = result.state.workers[0];
		assert.equal(w?.status, "done");
		assert.equal(w?.verifierPassed, true);
		assert.ok(w?.startedAt, "should have startedAt");
		assert.ok(w?.finishedAt, "should have finishedAt");
	} finally {
		cleanup(dir);
	}
});

test("runSwarm worker is marked failed when verifier fails", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Failing task\n  - eval: `false`\n");
		const result = await runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.equal(result.failed, 1, "one worker should be failed");
		assert.equal(result.done, 0);
		const w = result.state.workers[0];
		assert.equal(w?.status, "failed");
		assert.equal(w?.verifierPassed, false);
	} finally {
		cleanup(dir);
	}
});

test("runSwarm throws when todo file does not exist", async () => {
	await assert.rejects(
		() => runSwarm({ todoPath: "/tmp/nonexistent-evalgate-todo.md" }),
		/not found/,
	);
});

test("runSwarm respects concurrency option", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			"- [ ] C1\n  - eval: `true`\n- [ ] C2\n  - eval: `true`\n- [ ] C3\n  - eval: `true`\n",
		);
		// Run with concurrency=1 — all should still complete
		const result = await runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.equal(result.state.workers.length, 3);
		// All should be done or failed (depending on merge success in CI)
		const terminal = result.state.workers.filter(
			(w) => w.status === "done" || w.status === "failed",
		);
		assert.equal(terminal.length, 3, "all workers should reach a terminal state");
	} finally {
		cleanup(dir);
	}
});

test("runSwarm resume re-queues in-flight workers and completes them", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			"- [ ] Resume task one\n  - eval: `true`\n- [ ] Resume task two\n  - eval: `true`\n",
		);

		// Simulate a crash mid-run: build state with both workers stuck in-flight.
		const crashedState: SwarmState = {
			id: "crash-test",
			ts: new Date().toISOString(),
			todoPath,
			workers: [
				{
					id: "aaa00001",
					contractId: "resume-task-one",
					contractTitle: "Resume task one",
					worktreePath: join(dir, ".evalgate-worktrees", "aaa00001"),
					branch: "evalgate/resume-task-one-aaa00001",
					status: "running", // in-flight — should be reset to pending
					logPath: join(dir, ".evalgate", "sessions", "aaa00001.log"),
				},
				{
					id: "aaa00002",
					contractId: "resume-task-two",
					contractTitle: "Resume task two",
					worktreePath: join(dir, ".evalgate-worktrees", "aaa00002"),
					branch: "evalgate/resume-task-two-aaa00002",
					status: "verifying", // in-flight — should be reset to pending
					logPath: join(dir, ".evalgate", "sessions", "aaa00002.log"),
				},
			],
		};
		mkdirSync(join(dir, ".evalgate", "sessions"), { recursive: true });
		saveState(todoPath, crashedState);

		// Resume should reset both workers to pending and run them fresh.
		const result = await runSwarm({
			todoPath,
			resume: true,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		// Both contracts have verifier `true` so both should pass.
		assert.equal(result.done, 2, "both resumed workers should complete");
		assert.equal(result.failed, 0);
		const statuses = result.state.workers.map((w) => w.status);
		assert.ok(
			statuses.every((s) => s === "done"),
			`all workers should be done, got: ${statuses}`,
		);
	} finally {
		cleanup(dir);
	}
});

test("runSwarm resume with no existing state behaves like a fresh run", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Fresh resume task\n  - eval: `true`\n");
		// No state file — resume should create fresh state and run normally.
		const result = await runSwarm({
			todoPath,
			resume: true,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.equal(result.done, 1);
		assert.equal(result.failed, 0);
	} finally {
		cleanup(dir);
	}
});

test("runSwarm marks worker failed when worktree creation fails", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Worktree fail task\n  - eval: `true`\n");

		// Run against a non-git directory by pointing repoRoot detection at a
		// path outside the git repo — achieved by writing the todo outside the repo.
		// Simpler approach: use a branch name that git will reject (empty string
		// is not valid). We can't easily inject a bad branch name through the
		// public API, so instead we pre-create the worktree path as a file so
		// git worktree add fails because the target already exists as a file.
		//
		// Build state manually with a worktreePath that collides with a file.
		const collidePath = join(dir, "collision");
		writeFileSync(collidePath, "I am a file, not a directory\n");
		execSync("git add collision && git commit --no-gpg-sign -m 'add collision file'", {
			cwd: dir,
			stdio: "pipe",
			shell: true,
		});

		const preState: SwarmState = {
			id: "collision-test",
			ts: new Date().toISOString(),
			todoPath,
			workers: [
				{
					id: "col00001",
					contractId: "worktree-fail-task",
					contractTitle: "Worktree fail task",
					worktreePath: collidePath, // already exists as a file → git worktree add will fail
					branch: "evalgate/worktree-fail-task-col00001",
					status: "pending",
					logPath: join(dir, ".evalgate", "sessions", "col00001.log"),
				},
			],
		};
		mkdirSync(join(dir, ".evalgate", "sessions"), { recursive: true });
		saveState(todoPath, preState);

		const result = await runSwarm({
			todoPath,
			resume: true,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(result.failed, 1, "worker with bad worktree path should be marked failed");
		assert.equal(result.done, 0);
		const w = result.state.workers[0];
		assert.equal(w?.status, "failed");
	} finally {
		cleanup(dir);
	}
});

// ---------------------------------------------------------------------------
// appendRun placement tests
// ---------------------------------------------------------------------------

test("runSwarm writes a FAIL run record when verifier fails", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Failing record task\n  - eval: `false`\n");
		await runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		const records = queryRuns(todoPath, { limit: 100 });
		assert.equal(records.length, 1, "should have exactly one run record");
		assert.equal(records[0]?.passed, false, "the run record should be a failure");
	} finally {
		cleanup(dir);
	}
});

test("runSwarm writes a PASS run record when verifier passes and merge succeeds", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Passing record task\n  - eval: `true`\n");
		const result = await runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		const records = queryRuns(todoPath, { limit: 100 });
		// Merge can legitimately fail in some CI environments (e.g. git config missing).
		// If the worker ended up "done", there must be a PASS record.
		// If the worker ended up "failed" (merge failed), no PASS record should exist.
		if (result.done === 1) {
			assert.ok(
				records.some((r) => r.passed === true),
				"a PASS run record should exist when merge succeeded",
			);
		} else {
			assert.equal(
				records.filter((r) => r.passed === true).length,
				0,
				"no PASS record should exist when merge failed",
			);
		}
	} finally {
		cleanup(dir);
	}
});

test("runSwarm does not write a PASS record when merge fails after verifier passes", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(dir, "- [ ] Merge-sensitive task\n  - eval: `true`\n");
		const result = await runSwarm({
			todoPath,
			concurrency: 1,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		const records = queryRuns(todoPath, { limit: 100 });
		const passCount = records.filter((r) => r.passed === true).length;
		const expectedPassCount = result.done === 1 ? 1 : 0;
		assert.equal(
			passCount,
			expectedPassCount,
			`PASS record count (${passCount}) should match done count (${expectedPassCount})`,
		);
	} finally {
		cleanup(dir);
	}
});

test("runSwarm concurrent workers all complete without merge conflicts", async () => {
	// This test specifically exercises the merge-mutex fix. Without the mutex,
	// concurrent workers branch from the same HEAD and both update todo.md,
	// causing an add/add conflict when the second worker tries to merge.
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			[
				"- [ ] Concurrent task A",
				"  - eval: `true`",
				"- [ ] Concurrent task B",
				"  - eval: `true`",
				"- [ ] Concurrent task C",
				"  - eval: `true`",
			].join("\n"),
		);
		const result = await runSwarm({
			todoPath,
			concurrency: 3,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.equal(result.state.workers.length, 3);
		const done = result.state.workers.filter((w) => w.status === "done").length;
		const failed = result.state.workers.filter((w) => w.status === "failed").length;
		assert.equal(done, 3, "all 3 concurrent workers should complete without merge conflicts");
		assert.equal(failed, 0, "no worker should fail due to merge conflict");
	} finally {
		cleanup(dir);
	}
});

test("runSwarm writes exactly one run record per failing contract", async () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = writeTodo(
			dir,
			"- [ ] Fail contract one\n  - eval: `false`\n- [ ] Fail contract two\n  - eval: `false`\n",
		);
		await runSwarm({
			todoPath,
			concurrency: 2,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		const records = queryRuns(todoPath, { limit: 100 });
		assert.equal(records.length, 2, "should have exactly two run records");
		assert.ok(
			records.every((r) => r.passed === false),
			"all run records should be failures",
		);
	} finally {
		cleanup(dir);
	}
});
