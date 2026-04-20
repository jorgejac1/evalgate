/**
 * Tests for verifier timeout behaviour added in v2.1:
 *   - Composite aggregate timeoutMs cuts off execution early
 *   - timedOut=true propagates through RunResult when a shell step times out
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Contract } from "../src/types.js";
import { runContract } from "../src/verifier.js";

function makeContract(overrides: Partial<Contract> = {}): Contract {
	return {
		id: "test-contract",
		title: "Test contract",
		checked: false,
		status: "pending",
		line: 0,
		rawLines: [0],
		...overrides,
	};
}

test("composite verifier respects aggregate timeoutMs and sets timedOut=true", async () => {
	const contract = makeContract({
		verifier: {
			kind: "composite",
			mode: "all",
			// Each step would take 30 s normally; aggregate budget is 300 ms.
			// Using node instead of sleep — sleep ignores SIGTERM on some Linux
			// environments (GitHub Actions), so the process runs to completion.
			// Node responds to SIGTERM reliably cross-platform.
			timeoutMs: 300,
			steps: [
				{ kind: "shell", command: 'node -e "setTimeout(()=>{},30000)"', timeoutMs: 10_000 },
				{ kind: "shell", command: 'node -e "process.exit(0)"', timeoutMs: 10_000 },
			],
		},
	});

	const result = await runContract(contract, process.cwd());

	assert.equal(result.passed, false, "should fail when timeout exceeded");
	assert.equal(result.timedOut, true, "timedOut should be true");
	// Should complete much faster than 5 s (the step duration without timeout)
	assert.ok(result.durationMs < 3_000, `took too long: ${result.durationMs}ms`);
});

test("composite verifier passes when all steps finish within timeout", async () => {
	const contract = makeContract({
		verifier: {
			kind: "composite",
			mode: "all",
			timeoutMs: 5_000,
			steps: [
				{ kind: "shell", command: "true", timeoutMs: 1_000 },
				{ kind: "shell", command: "true", timeoutMs: 1_000 },
			],
		},
	});

	const result = await runContract(contract, process.cwd());

	assert.equal(result.passed, true, "should pass when all steps succeed within timeout");
	assert.ok(!result.timedOut, "timedOut should not be set");
});

test("shell verifier propagates timedOut=true through RunResult", async () => {
	// node responds to SIGTERM reliably; sleep ignores it on some Linux envs.
	const contract = makeContract({
		verifier: {
			kind: "shell",
			command: 'node -e "setTimeout(()=>{},30000)"',
			timeoutMs: 150,
		},
	});

	const result = await runContract(contract, process.cwd());

	assert.equal(result.passed, false, "timed-out shell verifier should not pass");
	assert.equal(result.timedOut, true, "timedOut should be true on RunResult");
	assert.ok(result.durationMs < 2_000, `took too long: ${result.durationMs}ms`);
});
