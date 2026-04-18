/**
 * Tests for the structured swarm events added in v0.12:
 *   "eval-result"   — fires after the verifier runs
 *   "task-complete" — fires when a worker reaches a terminal state
 *
 * Uses the same real-git + trivial-agent pattern as swarm.test.ts.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSwarm, swarmEvents } from "../src/swarm.js";
import type { EvalResultEvent, TaskCompleteEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers (duplicated from swarm.test.ts — keep tests self-contained)
// ---------------------------------------------------------------------------

function makeTmpRepo(): string {
	const dir = join(
		tmpdir(),
		`evalgate-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
// "eval-result" events
// ---------------------------------------------------------------------------

test('"eval-result" fires with passed=true when verifier exits 0', async () => {
	const dir = makeTmpRepo();
	const received: EvalResultEvent[] = [];
	const listener = (evt: EvalResultEvent) => received.push(evt);
	swarmEvents.on("eval-result", listener);

	try {
		const todoPath = writeTodo(dir, "- [ ] Task A\n  - eval: `true`\n");
		await runSwarm({
			todoPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(received.length, 1);
		const evt = received[0];
		assert.equal(evt.type, "eval-result");
		assert.equal(evt.passed, true);
		assert.ok(typeof evt.workerId === "string" && evt.workerId.length > 0);
		assert.ok(typeof evt.contractId === "string" && evt.contractId.length > 0);
		assert.ok(typeof evt.durationMs === "number" && evt.durationMs >= 0);
	} finally {
		swarmEvents.off("eval-result", listener);
		cleanup(dir);
	}
});

test('"eval-result" fires with passed=false when verifier exits non-zero', async () => {
	const dir = makeTmpRepo();
	const received: EvalResultEvent[] = [];
	const listener = (evt: EvalResultEvent) => received.push(evt);
	swarmEvents.on("eval-result", listener);

	try {
		const todoPath = writeTodo(dir, "- [ ] Task B\n  - eval: `false`\n");
		await runSwarm({
			todoPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(received.length, 1);
		assert.equal(received[0].passed, false);
	} finally {
		swarmEvents.off("eval-result", listener);
		cleanup(dir);
	}
});

// ---------------------------------------------------------------------------
// "task-complete" events
// ---------------------------------------------------------------------------

test('"task-complete" fires with status="done" when verifier passes', async () => {
	const dir = makeTmpRepo();
	const received: TaskCompleteEvent[] = [];
	const listener = (evt: TaskCompleteEvent) => received.push(evt);
	swarmEvents.on("task-complete", listener);

	try {
		const todoPath = writeTodo(dir, "- [ ] Task C\n  - eval: `true`\n");
		await runSwarm({
			todoPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(received.length, 1);
		const evt = received[0];
		assert.equal(evt.type, "task-complete");
		assert.equal(evt.status, "done");
		assert.ok(typeof evt.workerId === "string" && evt.workerId.length > 0);
		assert.ok(typeof evt.contractId === "string" && evt.contractId.length > 0);
	} finally {
		swarmEvents.off("task-complete", listener);
		cleanup(dir);
	}
});

test('"task-complete" fires with status="failed" when verifier fails', async () => {
	const dir = makeTmpRepo();
	const received: TaskCompleteEvent[] = [];
	const listener = (evt: TaskCompleteEvent) => received.push(evt);
	swarmEvents.on("task-complete", listener);

	try {
		const todoPath = writeTodo(dir, "- [ ] Task D\n  - eval: `false`\n");
		await runSwarm({
			todoPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(received.length, 1);
		assert.equal(received[0].status, "failed");
	} finally {
		swarmEvents.off("task-complete", listener);
		cleanup(dir);
	}
});

test('"task-complete" fires before runSwarm resolves', async () => {
	const dir = makeTmpRepo();
	const received: TaskCompleteEvent[] = [];
	const listener = (evt: TaskCompleteEvent) => received.push(evt);
	swarmEvents.on("task-complete", listener);

	try {
		const todoPath = writeTodo(dir, "- [ ] Task E\n  - eval: `true`\n");
		await runSwarm({
			todoPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		// If runSwarm resolved, all task-complete events must already be in the array
		assert.equal(received.length, 1, "task-complete event must arrive before runSwarm resolves");
	} finally {
		swarmEvents.off("task-complete", listener);
		cleanup(dir);
	}
});

test('"eval-result" and "task-complete" both fire for two parallel tasks', async () => {
	const dir = makeTmpRepo();
	const evalResults: EvalResultEvent[] = [];
	const taskCompletes: TaskCompleteEvent[] = [];
	const elListener = (evt: EvalResultEvent) => evalResults.push(evt);
	const tcListener = (evt: TaskCompleteEvent) => taskCompletes.push(evt);
	swarmEvents.on("eval-result", elListener);
	swarmEvents.on("task-complete", tcListener);

	try {
		const todoPath = writeTodo(
			dir,
			"- [ ] Task F\n  - eval: `true`\n\n- [ ] Task G\n  - eval: `false`\n",
		);
		await runSwarm({
			todoPath,
			concurrency: 2,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});

		assert.equal(evalResults.length, 2);
		assert.equal(taskCompletes.length, 2);

		const passedEvals = evalResults.filter((e) => e.passed);
		const failedEvals = evalResults.filter((e) => !e.passed);
		assert.equal(passedEvals.length, 1);
		assert.equal(failedEvals.length, 1);

		const doneCompletes = taskCompletes.filter((e) => e.status === "done");
		const failedCompletes = taskCompletes.filter((e) => e.status === "failed");
		assert.equal(doneCompletes.length, 1);
		assert.equal(failedCompletes.length, 1);
	} finally {
		swarmEvents.off("eval-result", elListener);
		swarmEvents.off("task-complete", tcListener);
		cleanup(dir);
	}
});
