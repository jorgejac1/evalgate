/**
 * Tests for src/spawn.ts
 *
 * We spawn real processes (echo, node, false) instead of mocking child_process
 * so these tests verify actual I/O streaming and exit-code propagation.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnAgent } from "../src/spawn.js";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`evalgate-spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

test("spawnAgent resolves with exit code 0 for a passing command", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w1.log");
		const exitCode = await spawnAgent({
			cwd: dir,
			task: "echo test",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.equal(exitCode, 0);
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent resolves with non-zero exit code for a failing command", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w2.log");
		const exitCode = await spawnAgent({
			cwd: dir,
			task: "fail task",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(1)"],
		});
		assert.equal(exitCode, 1);
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent streams stdout to log file", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w3.log");
		await spawnAgent({
			cwd: dir,
			task: "print hello",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.stdout.write('hello from agent\\n')"],
		});
		assert.ok(existsSync(logPath), "log file should be created");
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("hello from agent"), "stdout should be in log");
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent streams stderr to log file", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w4.log");
		await spawnAgent({
			cwd: dir,
			task: "print error",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.stderr.write('error from agent\\n')"],
		});
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("error from agent"), "stderr should be in log");
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent creates parent directories for logPath", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "deeply", "nested", "sessions", "w5.log");
		await spawnAgent({
			cwd: dir,
			task: "nested log",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		assert.ok(existsSync(logPath), "log file should be created in nested dir");
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent returns -1 when command is not found", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w6.log");
		const exitCode = await spawnAgent({
			cwd: dir,
			task: "bad cmd",
			logPath,
			agentCmd: "this-command-does-not-exist-evalgate-test",
			agentArgs: [],
		});
		// On ENOENT, Node fires both 'error' and 'close'; we settle with the
		// first one. Exact code is platform-dependent (-1, -2, etc.).
		assert.ok(exitCode < 0, `exit code should be negative, got ${exitCode}`);
		// Log should contain the spawn error message
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("spawn error"), "log should contain spawn error");
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent writes header lines to the log", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w7.log");
		await spawnAgent({
			cwd: dir,
			task: "header test",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.exit(0)"],
		});
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("[evalgate swarm] starting agent"), "should have header");
		assert.ok(contents.includes("[evalgate swarm] cwd:"), "should have cwd");
	} finally {
		cleanup(dir);
	}
});

test("taskContext is prepended to task in default args", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w8.log");
		await spawnAgent({
			cwd: dir,
			task: "fix login",
			logPath,
			agentCmd: "node",
			// Print the first arg (the full prompt) to stdout so we can inspect it
			agentArgs: ["-e", "process.stdout.write(process.argv[1])", "{task}"],
			taskContext: "You are working on auth",
		});
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("You are working on auth"), "context should appear in log");
		assert.ok(contents.includes("fix login"), "task should appear in log");
		assert.ok(contents.includes("---"), "separator should appear between context and task");
		assert.ok(contents.includes("## Task"), "Task header should appear");
	} finally {
		cleanup(dir);
	}
});

test("{task} substitution works in custom agentArgs", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w9.log");
		await spawnAgent({
			cwd: dir,
			task: "hello world",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.stdout.write('{task}')"],
		});
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("hello world"), "{task} should be replaced with task title");
	} finally {
		cleanup(dir);
	}
});

test("{task} substitution includes taskContext when both are set", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w10.log");
		await spawnAgent({
			cwd: dir,
			task: "add rate limiting",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.stdout.write('{task}')"],
			taskContext: "# Auth track\n\nOwns src/auth/**",
		});
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("# Auth track"), "context should be in substituted {task}");
		assert.ok(contents.includes("add rate limiting"), "task title should be in substituted {task}");
		assert.ok(contents.includes("## Task"), "Task section header should be present");
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent strips UTF-8 BOM from taskContext", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w11.log");
		await spawnAgent({
			cwd: dir,
			task: "do work",
			logPath,
			agentCmd: "node",
			agentArgs: ["-e", "process.stdout.write(process.argv[2])", "x", "{task}"],
			taskContext: "\uFEFF# Auth Module\n\nContext here.", // BOM-prefixed
		});
		const contents = readFileSync(logPath, "utf8");
		assert.ok(
			!contents.includes("\uFEFF"),
			"BOM should be stripped from the prompt sent to the agent",
		);
		assert.ok(contents.includes("# Auth Module"), "context content should still be present");
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent falls back to default args when agentArgs is empty array", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w11.log");
		await spawnAgent({
			cwd: dir,
			task: "important task",
			logPath,
			agentCmd: "echo",
			agentArgs: [], // empty — should fall through to ["--print", task]
		});
		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.includes("important task"), "task should reach the agent via default args");
	} finally {
		cleanup(dir);
	}
});

test("spawnAgent escapes newlines in log header", async () => {
	const dir = makeTmpDir();
	try {
		const logPath = join(dir, "sessions", "w12.log");
		await spawnAgent({
			cwd: dir,
			task: "line one\nline two\nline three",
			logPath,
			agentCmd: "echo",
		});
		const contents = readFileSync(logPath, "utf8");
		const headerLine = contents.split("\n")[0];
		assert.ok(
			headerLine.startsWith("[evalgate swarm] starting agent:"),
			"header should start correctly",
		);
		// The header line itself must not split across lines
		assert.ok(!headerLine.includes("\n"), "header line must not contain raw newlines");
		assert.ok(headerLine.includes("\\n"), "newlines should be escaped as \\n in header");
	} finally {
		cleanup(dir);
	}
});
