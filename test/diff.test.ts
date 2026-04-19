import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Contract, DiffVerifier } from "../src/types.js";
import { runContract } from "../src/verifier.js";

function makeContract(verifier: DiffVerifier): Contract {
	return {
		id: "test-diff",
		title: "Test diff",
		checked: false,
		status: "pending",
		verifier,
		line: 0,
		rawLines: [0],
	};
}

function tmpDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "evalgate-diff-test-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("diff verifier", () => {
	it("passes when file has matching pattern", async () => {
		const { dir, cleanup } = tmpDir();
		try {
			writeFileSync(join(dir, "auth.ts"), "export function validateToken(t: string) { return t; }");
			const result = await runContract(
				makeContract({ kind: "diff", file: "auth.ts", mode: "has", pattern: "validateToken" }),
				dir,
			);
			assert.strictEqual(result.passed, true);
		} finally {
			cleanup();
		}
	});

	it("fails when file lacks expected pattern", async () => {
		const { dir, cleanup } = tmpDir();
		try {
			writeFileSync(join(dir, "auth.ts"), "export function login() {}");
			const result = await runContract(
				makeContract({ kind: "diff", file: "auth.ts", mode: "has", pattern: "validateToken" }),
				dir,
			);
			assert.strictEqual(result.passed, false);
		} finally {
			cleanup();
		}
	});

	it("passes with lacks mode when pattern absent", async () => {
		const { dir, cleanup } = tmpDir();
		try {
			writeFileSync(join(dir, "utils.ts"), "export function newHelper() {}");
			const result = await runContract(
				makeContract({ kind: "diff", file: "utils.ts", mode: "lacks", pattern: "deprecatedFn" }),
				dir,
			);
			assert.strictEqual(result.passed, true);
		} finally {
			cleanup();
		}
	});

	it("fails with lacks mode when pattern present", async () => {
		const { dir, cleanup } = tmpDir();
		try {
			writeFileSync(join(dir, "utils.ts"), "export function deprecatedFn() {} // old");
			const result = await runContract(
				makeContract({ kind: "diff", file: "utils.ts", mode: "lacks", pattern: "deprecatedFn" }),
				dir,
			);
			assert.strictEqual(result.passed, false);
		} finally {
			cleanup();
		}
	});

	it("fails when file does not exist", async () => {
		const { dir, cleanup } = tmpDir();
		try {
			const result = await runContract(
				makeContract({ kind: "diff", file: "nonexistent.ts", mode: "has", pattern: "anything" }),
				dir,
			);
			assert.strictEqual(result.passed, false);
			assert.ok(result.stderr.includes("not found"));
		} finally {
			cleanup();
		}
	});

	it("supports regex patterns", async () => {
		const { dir, cleanup } = tmpDir();
		try {
			writeFileSync(join(dir, "api.ts"), "export function getUserById(id: number) {}");
			const result = await runContract(
				makeContract({ kind: "diff", file: "api.ts", mode: "has", pattern: "function\\s+get\\w+" }),
				dir,
			);
			assert.strictEqual(result.passed, true);
		} finally {
			cleanup();
		}
	});
});
