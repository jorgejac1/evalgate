/**
 * Tests for resumeSwarm() added in v2.3.
 *
 * resumeSwarm validates that prior swarm state exists before delegating to runSwarm.
 * When no state file is found it must throw with a descriptive message.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resumeSwarm } from "../src/swarm.js";

describe("resumeSwarm", () => {
	it('rejects with "resumeSwarm: no prior swarm state found" for a nonexistent path', async () => {
		await assert.rejects(
			() => resumeSwarm("/nonexistent/todo.md"),
			(err: unknown) => {
				assert.ok(err instanceof Error, "should throw an Error");
				assert.ok(
					err.message.includes("resumeSwarm: no prior swarm state found"),
					`Expected message to contain "resumeSwarm: no prior swarm state found", got: ${err.message}`,
				);
				return true;
			},
		);
	});

	it("rejects when the todo.md exists but no swarm-state.json has been written", async () => {
		const dir = mkdtempSync(join(tmpdir(), "evalgate-resume-test-"));
		try {
			const todoPath = join(dir, "todo.md");
			writeFileSync(todoPath, "- [ ] A task\n  - eval: `true`\n");

			await assert.rejects(
				() => resumeSwarm(todoPath),
				(err: unknown) => {
					assert.ok(err instanceof Error, "should throw an Error");
					assert.ok(
						err.message.includes("resumeSwarm: no prior swarm state found"),
						`Expected message to contain "resumeSwarm: no prior swarm state found", got: ${err.message}`,
					);
					return true;
				},
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is exported as a function from the package", () => {
		// Type-level smoke test: if the import above worked and it's callable, we're good.
		assert.strictEqual(typeof resumeSwarm, "function");
	});
});
