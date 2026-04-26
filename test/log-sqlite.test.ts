/**
 * Tests for the SQLite-backed log (v3.0).
 *
 * Verifies that appendRun/queryRuns work correctly with SQLite storage,
 * and that the one-time NDJSON → SQLite migration works.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendRun, getLastFailure, getLastRun, logDir, queryRuns, runsPath } from "../src/log.js";
import type { Contract, RunRecord, RunResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "gl-log-sqlite-test-"));
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

function makeContract(id: string, title: string): Contract {
	return { id, title, checked: false, status: "pending", line: 0, rawLines: [0] };
}

function makeRecord(
	id: string,
	ts: string,
	durationMs: number,
	contractId = "test-contract",
): RunRecord {
	return {
		id,
		ts,
		contractId,
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
// Tests: basic insert + query
// ---------------------------------------------------------------------------

describe("log-sqlite: appendRun + queryRuns", () => {
	it("appends a run and reads it back from SQLite", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult(), todoPath, "manual");

			// db file should now exist
			assert.ok(existsSync(runsPath(todoPath)), "runs.db should be created");

			const records = queryRuns(todoPath);
			assert.equal(records.length, 1);
			assert.equal(records[0].contractId, "test-contract");
			assert.equal(records[0].passed, true);
			assert.equal(records[0].trigger, "manual");
		} finally {
			cleanup(dir);
		}
	});

	it("returns empty array when db does not exist", () => {
		const dir = makeTmp();
		try {
			const records = queryRuns(join(dir, "todo.md"));
			assert.equal(records.length, 0);
		} finally {
			cleanup(dir);
		}
	});

	it("returns most recent first (ordering by ts DESC)", async () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			// Insert with slight delays to ensure different ts values
			appendRun(makeResult({ durationMs: 1 }), todoPath, "manual");
			await new Promise((r) => setTimeout(r, 5));
			appendRun(makeResult({ durationMs: 2 }), todoPath, "manual");
			await new Promise((r) => setTimeout(r, 5));
			appendRun(makeResult({ durationMs: 3 }), todoPath, "manual");

			const records = queryRuns(todoPath);
			assert.equal(records.length, 3);
			// Most recent (durationMs=3) should be first
			assert.equal(records[0].durationMs, 3);
			assert.equal(records[2].durationMs, 1);
		} finally {
			cleanup(dir);
		}
	});

	it("filters by contractId", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			const other = makeContract("other-id", "Other");
			appendRun(makeResult(), todoPath, "manual");
			appendRun({ ...makeResult(), contract: other }, todoPath, "manual");

			const records = queryRuns(todoPath, { contractId: "test-contract" });
			assert.equal(records.length, 1);
			assert.equal(records[0].contractId, "test-contract");
		} finally {
			cleanup(dir);
		}
	});

	it("filters by passed=false", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult({ passed: true }), todoPath, "manual");
			appendRun(makeResult({ passed: false, exitCode: 1 }), todoPath, "manual");

			const failed = queryRuns(todoPath, { passed: false });
			assert.equal(failed.length, 1);
			assert.equal(failed[0].passed, false);
		} finally {
			cleanup(dir);
		}
	});

	it("filters by passed=true", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult({ passed: true }), todoPath, "manual");
			appendRun(makeResult({ passed: false, exitCode: 1 }), todoPath, "manual");
			appendRun(makeResult({ passed: true }), todoPath, "manual");

			const passed = queryRuns(todoPath, { passed: true });
			assert.equal(passed.length, 2);
			for (const r of passed) assert.equal(r.passed, true);
		} finally {
			cleanup(dir);
		}
	});

	it("filters by trigger source", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult(), todoPath, "manual");
			appendRun(makeResult(), todoPath, "webhook");

			const webhooks = queryRuns(todoPath, { trigger: "webhook" });
			assert.equal(webhooks.length, 1);
			assert.equal(webhooks[0].trigger, "webhook");
		} finally {
			cleanup(dir);
		}
	});

	it("respects limit", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			for (let i = 0; i < 5; i++) appendRun(makeResult(), todoPath, "manual");
			const records = queryRuns(todoPath, { limit: 2 });
			assert.equal(records.length, 2);
		} finally {
			cleanup(dir);
		}
	});

	it("respects offset for pagination", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			for (let i = 0; i < 5; i++) appendRun(makeResult({ durationMs: i }), todoPath, "manual");

			const page1 = queryRuns(todoPath, { limit: 2 });
			const page2 = queryRuns(todoPath, { limit: 2, offset: 2 });

			const page1Ids = new Set(page1.map((r) => r.id));
			for (const r of page2) {
				assert.ok(!page1Ids.has(r.id), "page2 should not overlap with page1");
			}
			assert.ok(page2.length >= 1);
		} finally {
			cleanup(dir);
		}
	});

	it("filters by from date range", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			// Seed dir first
			appendRun(makeResult(), todoPath, "manual");

			// Write records with controlled timestamps directly to the DB via appendRun
			// We rely on the SQLite DB being open now, and directly insert via queryRuns path.
			// Actually, easiest approach: just append records and check filtering works for ts values.
			// For precise ts tests, write raw SQL... but we want to keep test simple.
			// Let's just check that the from/to filters work with real ts values.
			const r1 = appendRun(makeResult({ durationMs: 10 }), todoPath, "manual");
			// Filter: records where ts >= r1.ts should include r1
			const after = queryRuns(todoPath, { from: r1.ts });
			assert.ok(after.some((r) => r.id === r1.id));
			// Filter: records where ts <= r1.ts should include r1
			const before = queryRuns(todoPath, { to: r1.ts });
			assert.ok(before.some((r) => r.id === r1.id));
		} finally {
			cleanup(dir);
		}
	});

	it("from/to beyond all records returns empty array", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult(), todoPath, "manual");

			const future = queryRuns(todoPath, { from: "2099-01-01T00:00:00.000Z" });
			assert.equal(future.length, 0);

			const past = queryRuns(todoPath, { to: "2000-01-01T00:00:00.000Z" });
			assert.equal(past.length, 0);
		} finally {
			cleanup(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: NDJSON migration
// ---------------------------------------------------------------------------

describe("log-sqlite: NDJSON migration", () => {
	it("migrates existing runs.ndjson records into SQLite on first open", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			const evalDir = logDir(todoPath);
			mkdirSync(evalDir, { recursive: true });

			// Write a legacy NDJSON file
			const legacyRecords: RunRecord[] = [
				makeRecord("legacy-1", "2025-01-01T00:00:00.000Z", 100),
				makeRecord("legacy-2", "2025-01-02T00:00:00.000Z", 200),
			];
			const ndjsonFile = join(evalDir, "runs.ndjson");
			writeFileSync(ndjsonFile, legacyRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");

			// appendRun triggers migration (opens DB for first time)
			appendRun(makeResult({ durationMs: 300 }), todoPath, "manual");

			// All legacy records + new record should be queryable
			const all = queryRuns(todoPath);
			assert.ok(all.length >= 3, `expected at least 3 records, got ${all.length}`);
			const ids = new Set(all.map((r) => r.id));
			assert.ok(ids.has("legacy-1"), "legacy-1 should be migrated");
			assert.ok(ids.has("legacy-2"), "legacy-2 should be migrated");

			// NDJSON should be renamed to .migrated
			assert.ok(!existsSync(ndjsonFile), "runs.ndjson should be renamed after migration");
			assert.ok(existsSync(`${ndjsonFile}.migrated`), "runs.ndjson.migrated should exist");
		} finally {
			cleanup(dir);
		}
	});

	it("handles malformed ndjson lines gracefully during migration", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			const evalDir = logDir(todoPath);
			mkdirSync(evalDir, { recursive: true });

			const ndjsonFile = join(evalDir, "runs.ndjson");
			writeFileSync(
				ndjsonFile,
				JSON.stringify(makeRecord("good-1", "2025-01-01T00:00:00.000Z", 100)) +
					"\n" +
					"{ this is not valid json }\n" +
					JSON.stringify(makeRecord("good-2", "2025-01-02T00:00:00.000Z", 200)) +
					"\n",
			);

			// Should not throw
			appendRun(makeResult(), todoPath, "manual");

			const all = queryRuns(todoPath);
			const ids = new Set(all.map((r) => r.id));
			assert.ok(ids.has("good-1"), "good-1 should be migrated");
			assert.ok(ids.has("good-2"), "good-2 should be migrated");
		} finally {
			cleanup(dir);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: getLastFailure / getLastRun
// ---------------------------------------------------------------------------

describe("log-sqlite: getLastFailure / getLastRun", () => {
	it("getLastFailure returns the most recent failure", async () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(
				makeResult({ passed: false, exitCode: 1, stdout: "first fail" }),
				todoPath,
				"manual",
			);
			await new Promise((r) => setTimeout(r, 5));
			appendRun(
				makeResult({ passed: false, exitCode: 2, stdout: "second fail" }),
				todoPath,
				"manual",
			);

			const record = getLastFailure(todoPath, "test-contract");
			assert.ok(record);
			assert.equal(record.stdout, "second fail");
		} finally {
			cleanup(dir);
		}
	});

	it("getLastFailure returns null if no failures", () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult({ passed: true }), todoPath, "manual");
			assert.equal(getLastFailure(todoPath, "test-contract"), null);
		} finally {
			cleanup(dir);
		}
	});

	it("getLastRun returns most recent run regardless of pass/fail", async () => {
		const dir = makeTmp();
		try {
			const todoPath = join(dir, "todo.md");
			appendRun(makeResult({ passed: false }), todoPath, "manual");
			await new Promise((r) => setTimeout(r, 5));
			appendRun(makeResult({ passed: true, durationMs: 999 }), todoPath, "manual");

			const record = getLastRun(todoPath, "test-contract");
			assert.ok(record);
			assert.equal(record.durationMs, 999);
		} finally {
			cleanup(dir);
		}
	});
});
