/**
 * Tests for the v2.3 QueryOptions extensions: offset, from, to.
 *
 * Uses the same temp-dir + appendRun pattern from log.test.ts.
 * Records are ordered most-recent-first by queryRuns, so offset/limit
 * paginate through that reversed order.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendRun, logDir, queryRuns } from "../src/log.js";
import type { Contract, RunRecord, RunResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers — identical to log.test.ts
// ---------------------------------------------------------------------------

function makeTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "gl-log-pag-test-"));
	writeFileSync(join(dir, "todo.md"), "- [ ] test\n  - eval: `echo ok`\n");
	return dir;
}

function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function makeResult(overrides: Partial<RunResult> = {}): RunResult {
	const contract: Contract = {
		id: "test-contract",
		title: "Test contract",
		checked: false,
		status: "pending",
		line: 0,
		rawLines: [0],
	};
	return {
		contract,
		passed: true,
		exitCode: 0,
		durationMs: 100,
		stdout: "ok",
		stderr: "",
		...overrides,
	};
}

/**
 * Write a set of RunRecord objects with controlled timestamps.
 *
 * v3.0: writes to the legacy NDJSON path so the SQLite migration picks them up
 * on the next DB open. Must be called BEFORE any appendRun to avoid the DB
 * being already open (migration only runs once on first open).
 * The caller should NOT have called appendRun on this todoPath yet.
 */
function writeRawRecords(todoPath: string, records: RunRecord[]): void {
	const dir = logDir(todoPath);
	mkdirSync(dir, { recursive: true });
	const ndjsonPath = join(dir, "runs.ndjson");
	writeFileSync(ndjsonPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function makeRecord(id: string, ts: string, durationMs: number): RunRecord {
	return {
		id,
		ts,
		contractId: "test-contract",
		contractTitle: "Test contract",
		trigger: "manual",
		passed: true,
		exitCode: 0,
		durationMs,
		stdout: "",
		stderr: "",
	};
}

// ---------------------------------------------------------------------------
// Tests: offset (pagination)
// ---------------------------------------------------------------------------

describe("queryRuns — offset (pagination)", () => {
	it("{ limit: 2 } returns at most 2 records", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			for (let i = 0; i < 5; i++) appendRun(makeResult({ durationMs: i }), todoPath, "manual");

			const page = queryRuns(todoPath, { limit: 2 });
			assert.strictEqual(page.length, 2);
		} finally {
			cleanup(dir);
		}
	});

	it("{ limit: 2, offset: 2 } returns the next page without overlapping page 1", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			for (let i = 0; i < 5; i++) appendRun(makeResult({ durationMs: i }), todoPath, "manual");

			const page1 = queryRuns(todoPath, { limit: 2 });
			const page2 = queryRuns(todoPath, { limit: 2, offset: 2 });

			const page1Ids = new Set(page1.map((r) => r.id));
			for (const r of page2) {
				assert.ok(!page1Ids.has(r.id), "page2 must not contain page1 records");
			}
			assert.ok(page2.length >= 1, "page2 should have at least 1 record");
			assert.ok(page2.length <= 2, "page2 should have at most 2 records");
		} finally {
			cleanup(dir);
		}
	});

	it("{ offset: 0 } returns same result as no offset", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			for (let i = 0; i < 3; i++) appendRun(makeResult(), todoPath, "manual");
			const all = queryRuns(todoPath);
			const withOffset = queryRuns(todoPath, { offset: 0 });
			assert.strictEqual(withOffset.length, all.length);
		} finally {
			cleanup(dir);
		}
	});

	it("{ offset: N } >= total returns empty array", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			for (let i = 0; i < 3; i++) appendRun(makeResult(), todoPath, "manual");
			const result = queryRuns(todoPath, { offset: 100 });
			assert.strictEqual(result.length, 0);
		} finally {
			cleanup(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: from / to date filters
// ---------------------------------------------------------------------------

describe("queryRuns — from/to date filters", () => {
	it("{ from } returns only records at or after the given timestamp", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");

			// Write NDJSON records BEFORE opening the DB so migration picks them up.
			writeRawRecords(todoPath, [
				makeRecord("r1", "2025-01-01T00:00:00.000Z", 1),
				makeRecord("r2", "2025-06-15T12:00:00.000Z", 2),
				makeRecord("r3", "2025-12-31T23:59:59.000Z", 3),
			]);
			// Trigger migration + add one more record
			appendRun(makeResult(), todoPath, "manual");

			const result = queryRuns(todoPath, { from: "2025-06-01T00:00:00.000Z" });
			// r2, r3, and the appended record (current year) should qualify
			for (const r of result) {
				assert.ok(r.ts >= "2025-06-01T00:00:00.000Z", `Expected ts >= from cutoff, got ${r.ts}`);
			}
			assert.ok(result.length >= 2, `Should return at least r2 and r3, got ${result.length}`);
		} finally {
			cleanup(dir);
		}
	});

	it("{ to } returns only records at or before the given timestamp", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");

			writeRawRecords(todoPath, [
				makeRecord("r1", "2025-01-01T00:00:00.000Z", 1),
				makeRecord("r2", "2025-06-15T12:00:00.000Z", 2),
				makeRecord("r3", "2025-12-31T23:59:59.000Z", 3),
			]);
			appendRun(makeResult(), todoPath, "manual");

			const result = queryRuns(todoPath, { to: "2025-06-30T23:59:59.999Z" });
			for (const r of result) {
				assert.ok(r.ts <= "2025-06-30T23:59:59.999Z", `Expected ts <= to cutoff, got ${r.ts}`);
			}
			assert.strictEqual(result.length, 2, "Should return r1 and r2");
		} finally {
			cleanup(dir);
		}
	});

	it("{ from, to } returns only records within the date range", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");

			writeRawRecords(todoPath, [
				makeRecord("r1", "2025-01-01T00:00:00.000Z", 1),
				makeRecord("r2", "2025-06-15T12:00:00.000Z", 2),
				makeRecord("r3", "2025-12-31T23:59:59.000Z", 3),
			]);
			appendRun(makeResult(), todoPath, "manual");

			const result = queryRuns(todoPath, {
				from: "2025-05-01T00:00:00.000Z",
				to: "2025-07-31T23:59:59.999Z",
			});
			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0]?.ts, "2025-06-15T12:00:00.000Z");
		} finally {
			cleanup(dir);
		}
	});

	it("{ from } beyond all records returns empty array", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult(), todoPath, "manual");

			const result = queryRuns(todoPath, { from: "2099-01-01T00:00:00.000Z" });
			assert.strictEqual(result.length, 0);
		} finally {
			cleanup(dir);
		}
	});

	it("{ to } before all records returns empty array", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");

			writeRawRecords(todoPath, [makeRecord("r1", "2025-06-15T12:00:00.000Z", 1)]);
			appendRun(makeResult(), todoPath, "manual");

			const result = queryRuns(todoPath, { to: "2024-01-01T00:00:00.000Z" });
			assert.strictEqual(result.length, 0);
		} finally {
			cleanup(dir);
		}
	});
});
