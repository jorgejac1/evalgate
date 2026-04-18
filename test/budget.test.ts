/**
 * Tests for src/budget.ts (v0.12 additions):
 *   - reportTokenUsage stores optional input/output/workerId fields
 *   - "cost" event fires on swarmEvents when reportTokenUsage is called
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getBudgetSummary, queryBudgetRecords, reportTokenUsage } from "../src/budget.js";
import { swarmEvents } from "../src/swarm.js";
import type { CostEvent } from "../src/types.js";

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "evalgate-budget-test-"));
}

function todoPath(dir: string): string {
	const p = join(dir, "todo.md");
	writeFileSync(p, "- [ ] Test task\n  - eval: `true`\n");
	return p;
}

// ---------------------------------------------------------------------------
// Extended BudgetRecord storage
// ---------------------------------------------------------------------------

test("reportTokenUsage stores inputTokens + outputTokens + workerId when provided", () => {
	const dir = makeTmpDir();
	try {
		const path = todoPath(dir);
		const record = reportTokenUsage(path, "contract-1", 1000, undefined, {
			inputTokens: 600,
			outputTokens: 400,
			workerId: "worker-abc",
		});

		assert.equal(record.tokens, 1000);
		assert.equal(record.inputTokens, 600);
		assert.equal(record.outputTokens, 400);
		assert.equal(record.workerId, "worker-abc");

		// Verify persisted to NDJSON
		const records = queryBudgetRecords(path, "contract-1");
		assert.equal(records.length, 1);
		assert.equal(records[0].inputTokens, 600);
		assert.equal(records[0].outputTokens, 400);
		assert.equal(records[0].workerId, "worker-abc");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reportTokenUsage without opts produces record with undefined optional fields", () => {
	const dir = makeTmpDir();
	try {
		const path = todoPath(dir);
		const record = reportTokenUsage(path, "contract-2", 500);

		assert.equal(record.tokens, 500);
		assert.equal(record.inputTokens, undefined);
		assert.equal(record.outputTokens, undefined);
		assert.equal(record.workerId, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// "cost" event on swarmEvents
// ---------------------------------------------------------------------------

test('"cost" event fires on swarmEvents when reportTokenUsage is called', () => {
	const dir = makeTmpDir();
	const received: CostEvent[] = [];
	const listener = (evt: CostEvent) => received.push(evt);
	swarmEvents.on("cost", listener);

	try {
		const path = todoPath(dir);
		reportTokenUsage(path, "contract-3", 2000, undefined, {
			inputTokens: 1200,
			outputTokens: 800,
			workerId: "worker-xyz",
		});

		assert.equal(received.length, 1);
		const evt = received[0];
		assert.equal(evt.type, "cost");
		assert.equal(evt.contractId, "contract-3");
		assert.equal(evt.workerId, "worker-xyz");
		assert.equal(evt.tokens.input, 1200);
		assert.equal(evt.tokens.output, 800);
		assert.ok(typeof evt.estimatedUsd === "number");
		// Rough check: 1200 * 3 + 800 * 15 = 3600 + 12000 = 15600 / 1_000_000 ≈ 0.0156
		assert.ok(evt.estimatedUsd > 0);
	} finally {
		swarmEvents.off("cost", listener);
		rmSync(dir, { recursive: true, force: true });
	}
});

test('"cost" event fires even without input/output breakdown (zeros)', () => {
	const dir = makeTmpDir();
	const received: CostEvent[] = [];
	const listener = (evt: CostEvent) => received.push(evt);
	swarmEvents.on("cost", listener);

	try {
		const path = todoPath(dir);
		// Old-style call: no opts
		reportTokenUsage(path, "contract-4", 300);

		assert.equal(received.length, 1);
		assert.equal(received[0].tokens.input, 0);
		assert.equal(received[0].tokens.output, 0);
		assert.equal(received[0].estimatedUsd, 0);
	} finally {
		swarmEvents.off("cost", listener);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("estimatedUsd uses Sonnet 4 pricing ($3/$15 per MTok)", () => {
	const dir = makeTmpDir();
	const received: CostEvent[] = [];
	const listener = (evt: CostEvent) => received.push(evt);
	swarmEvents.on("cost", listener);

	try {
		const path = todoPath(dir);
		// 1M input + 1M output tokens
		reportTokenUsage(path, "contract-5", 2_000_000, undefined, {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
		});

		assert.equal(received.length, 1);
		// $3 + $15 = $18
		assert.ok(Math.abs(received[0].estimatedUsd - 18) < 0.001);
	} finally {
		swarmEvents.off("cost", listener);
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// getBudgetSummary still works correctly
// ---------------------------------------------------------------------------

test("getBudgetSummary aggregates token usage across multiple calls", () => {
	const dir = makeTmpDir();
	try {
		const path = todoPath(dir);
		const contract = {
			id: "contract-6",
			title: "Test contract",
			verifier: { kind: "shell" as const, command: "true" },
		};

		reportTokenUsage(path, "contract-6", 500);
		reportTokenUsage(path, "contract-6", 300);

		const summary = getBudgetSummary(path, [contract]);
		assert.equal(summary.length, 1);
		assert.equal(summary[0].used, 800);
		assert.equal(summary[0].contractId, "contract-6");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
