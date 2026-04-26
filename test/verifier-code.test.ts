/**
 * Tests for the eval.code verifier (v3.0).
 *
 * The code verifier reads a file from the worktree and passes its content
 * to an inline JS function. Passes if the function returns truthy.
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Contract } from "../src/types.js";
import { runContract } from "../src/verifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo(): string {
	const dir = join(
		tmpdir(),
		`evalgate-code-verifier-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
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

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function makeContract(fn: string, file?: string, timeoutMs?: number): Contract {
	return {
		id: "code-test",
		title: "Code verifier test",
		checked: false,
		status: "pending",
		line: 0,
		rawLines: [0],
		verifier: {
			kind: "code",
			fn,
			...(file !== undefined ? { file } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("eval.code verifier", () => {
	it("passes when fn returns true for matching output", () => {
		const dir = makeTmpRepo();
		try {
			writeFileSync(join(dir, "output.txt"), "hello");
			const contract = makeContract("out => out.trim() === 'hello'");
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, true);
				assert.ok(
					result.stdout.includes("true"),
					`stdout should contain 'true', got: ${result.stdout}`,
				);
			});
		} finally {
			cleanup(dir);
		}
	});

	it("fails when fn returns false for non-matching output", () => {
		const dir = makeTmpRepo();
		try {
			writeFileSync(join(dir, "output.txt"), "wrong content");
			const contract = makeContract("out => out.trim() === 'hello'");
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, false);
				assert.equal(result.exitCode, 1);
			});
		} finally {
			cleanup(dir);
		}
	});

	it("fails when output.txt does not exist", () => {
		const dir = makeTmpRepo();
		try {
			const contract = makeContract("out => out.trim() === 'hello'");
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, false);
				assert.ok(
					result.stderr.includes("output.txt"),
					`expected 'output.txt' in stderr, got: ${result.stderr}`,
				);
			});
		} finally {
			cleanup(dir);
		}
	});

	it("fails with error in stderr when fn has invalid JS", () => {
		const dir = makeTmpRepo();
		try {
			writeFileSync(join(dir, "output.txt"), "hello");
			const contract = makeContract("not valid => javascript +++");
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, false);
				assert.ok(
					result.stderr.includes("code verifier error"),
					`expected 'code verifier error' in stderr, got: ${result.stderr}`,
				);
			});
		} finally {
			cleanup(dir);
		}
	});

	it("times out with timedOut=true when fn loops forever", () => {
		const dir = makeTmpRepo();
		try {
			writeFileSync(join(dir, "output.txt"), "hello");
			const contract = makeContract("out => { while(true) {} }", undefined, 100);
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, false);
				assert.equal(result.timedOut, true);
				assert.ok(
					result.stderr.includes("timed out"),
					`expected 'timed out' in stderr, got: ${result.stderr}`,
				);
			});
		} finally {
			cleanup(dir);
		}
	});

	it("reads from a custom file path via the file field", () => {
		const dir = makeTmpRepo();
		try {
			mkdirSync(join(dir, "results"), { recursive: true });
			writeFileSync(join(dir, "results", "score.txt"), "0.95");
			const contract = makeContract("out => parseFloat(out.trim()) >= 0.9", "results/score.txt");
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, true, `expected pass, got stderr: ${result.stderr}`);
			});
		} finally {
			cleanup(dir);
		}
	});

	it("parses JSON output correctly", () => {
		const dir = makeTmpRepo();
		try {
			writeFileSync(join(dir, "output.txt"), JSON.stringify({ score: 0.95, label: "pass" }));
			const contract = makeContract("out => JSON.parse(out).score >= 0.9");
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, true, `stderr: ${result.stderr}`);
			});
		} finally {
			cleanup(dir);
		}
	});

	it("fails when custom file path does not exist", () => {
		const dir = makeTmpRepo();
		try {
			const contract = makeContract("out => true", "nonexistent/path.txt");
			return runContract(contract, dir).then((result) => {
				assert.equal(result.passed, false);
				assert.ok(result.stderr.includes("nonexistent/path.txt"), `stderr: ${result.stderr}`);
			});
		} finally {
			cleanup(dir);
		}
	});
});
