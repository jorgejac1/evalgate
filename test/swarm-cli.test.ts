/**
 * Tests for the `evalgate swarm status` CLI subcommand.
 *
 * Uses the compiled dist/cli.js via child_process.execSync so we exercise
 * the real CLI path, not just the library functions.
 */

import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { saveState } from "../src/swarm-state.js";
import type { SwarmState } from "../src/types.js";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "cli.js");

function makeTmpRepo(): string {
	const dir = join(
		tmpdir(),
		`evalgate-swarm-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	execSync("git init -b main", { cwd: dir, stdio: "pipe" });
	execSync('git config user.email "test@evalgate.test"', { cwd: dir, stdio: "pipe" });
	execSync('git config user.name "evalgate test"', { cwd: dir, stdio: "pipe" });
	writeFileSync(join(dir, "todo.md"), "- [ ] Status test task\n  - eval: `true`\n");
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("swarm status prints no-state message when state file is absent", () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = join(dir, "todo.md");
		const result = spawnSync("node", [CLI, "swarm", "status", todoPath], { encoding: "utf8" });
		assert.equal(result.status, 0, "exit code should be 0");
		assert.match(result.stdout, /no swarm state found/i);
	} finally {
		cleanup(dir);
	}
});

test("swarm status prints worker summary from existing state file", () => {
	const dir = makeTmpRepo();
	try {
		const todoPath = join(dir, "todo.md");

		const state: SwarmState = {
			id: "test-state-id",
			ts: new Date().toISOString(),
			todoPath,
			workers: [
				{
					id: "abc00001",
					contractId: "status-test-task",
					contractTitle: "Status test task",
					worktreePath: join(dir, ".evalgate-worktrees", "abc00001"),
					branch: "evalgate/status-test-task-abc00001",
					status: "done",
					startedAt: new Date(Date.now() - 5000).toISOString(),
					finishedAt: new Date().toISOString(),
					verifierPassed: true,
					logPath: join(dir, ".evalgate", "sessions", "abc00001.log"),
				},
				{
					id: "abc00002",
					contractId: "another-task",
					contractTitle: "Another task",
					worktreePath: join(dir, ".evalgate-worktrees", "abc00002"),
					branch: "evalgate/another-task-abc00002",
					status: "failed",
					startedAt: new Date(Date.now() - 3000).toISOString(),
					finishedAt: new Date().toISOString(),
					verifierPassed: false,
					logPath: join(dir, ".evalgate", "sessions", "abc00002.log"),
				},
			],
		};
		mkdirSync(join(dir, ".evalgate", "sessions"), { recursive: true });
		saveState(todoPath, state);

		const result = spawnSync("node", [CLI, "swarm", "status", todoPath], { encoding: "utf8" });
		assert.equal(result.status, 0);
		assert.match(result.stdout, /evalgate swarm status/i);
		assert.match(result.stdout, /Status test task/);
		assert.match(result.stdout, /done/);
		assert.match(result.stdout, /Another task/);
		assert.match(result.stdout, /failed/);
	} finally {
		cleanup(dir);
	}
});
