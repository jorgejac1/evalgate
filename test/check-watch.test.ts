import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { startCheckWatch } from "../src/check-watch.js";
import type { RunResult } from "../src/types.js";

function makeTmp(label: string): string {
	return mkdtempSync(join(tmpdir(), `gl-check-watch-${label}-`));
}

function waitMs(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Re-runs failing contract when a tracked file changes
// ---------------------------------------------------------------------------

describe("startCheckWatch — re-run on file change", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("re-runs failing contract when tracked file changes", { timeout: 5000 }, async () => {
		const dir = makeTmp("rerun");
		dirs.push(dir);

		const marker = join(dir, "marker.txt");
		const todoPath = join(dir, "todo.md");

		// Contract checks for the marker file
		writeFileSync(todoPath, `- [ ] Marker exists\n  - eval: \`test -f ${marker}\`\n`);

		const failedIds = new Set(["marker-exists"]);
		const cycleResults: RunResult[] = [];

		await new Promise<void>((resolve, reject) => {
			const handle = startCheckWatch({
				todoPath,
				failedIds,
				cwd: dir,
				onCycle(results) {
					cycleResults.push(...results);
					if (cycleResults.some((r) => r.passed)) {
						handle.stop();
						resolve();
					}
				},
			});

			// Trigger a file change after the watcher is ready
			setTimeout(() => {
				writeFileSync(marker, "exists");
				// Touch a source file to trigger the watcher
				writeFileSync(join(dir, "src.ts"), "// changed");
			}, 150);

			setTimeout(() => {
				handle.stop();
				reject(new Error("timeout: onCycle never fired with a passing result"));
			}, 4500);
		});

		assert.ok(
			cycleResults.some((r) => r.passed),
			"at least one passed result expected",
		);
	});
});

// ---------------------------------------------------------------------------
// Stops automatically when all contracts pass
// ---------------------------------------------------------------------------

describe("startCheckWatch — auto-stop when all pass", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("stops automatically when all contracts pass", { timeout: 5000 }, async () => {
		const dir = makeTmp("autostop");
		dirs.push(dir);

		const marker = join(dir, "done.txt");
		const todoPath = join(dir, "todo.md");

		writeFileSync(todoPath, `- [ ] Done file exists\n  - eval: \`test -f ${marker}\`\n`);

		const failedIds = new Set(["done-file-exists"]);
		let stopCalledWithEmpty = false;

		await new Promise<void>((resolve, reject) => {
			const handle = startCheckWatch({
				todoPath,
				failedIds,
				cwd: dir,
				onCycle() {
					if (failedIds.size === 0) {
						stopCalledWithEmpty = true;
					}
				},
			});

			// Override stop to detect auto-stop
			const origStop = handle.stop.bind(handle);
			handle.stop = () => {
				origStop();
				resolve();
			};

			setTimeout(() => {
				writeFileSync(marker, "done");
				writeFileSync(join(dir, "trigger.ts"), "// change");
			}, 150);

			setTimeout(() => {
				handle.stop();
				reject(new Error("timeout: watcher did not auto-stop"));
			}, 4500);
		});

		// After all pass, failedIds should be empty
		assert.equal(failedIds.size, 0, "failedIds should be empty after all pass");
		assert.ok(stopCalledWithEmpty, "onCycle should have been called with empty failedIds");
	});
});

// ---------------------------------------------------------------------------
// Ignores changes in .git and node_modules
// ---------------------------------------------------------------------------

describe("startCheckWatch — ignored directories", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("ignores changes in .git and node_modules", { timeout: 4000 }, async () => {
		const { mkdirSync } = await import("node:fs");
		const dir = makeTmp("ignore");
		dirs.push(dir);

		// Create ignored subdirs before writing todo.md so FSEvents doesn't
		// report them as new-directory events during the watch window.
		mkdirSync(join(dir, ".git"), { recursive: true });
		mkdirSync(join(dir, "node_modules"), { recursive: true });

		const todoPath = join(dir, "todo.md");
		writeFileSync(todoPath, `- [ ] Always fails\n  - eval: \`false\`\n`);

		// Allow FSEvents to settle before starting the watcher
		await waitMs(100);

		const failedIds = new Set(["always-fails"]);
		let cycleCount = 0;

		const handle = startCheckWatch({
			todoPath,
			failedIds,
			cwd: dir,
			onCycle() {
				cycleCount++;
			},
		});

		// Allow the watcher to initialise before writing into ignored paths
		await waitMs(150);

		// Write files inside the ignored directories
		writeFileSync(join(dir, ".git", "COMMIT_EDITMSG"), "wip");
		await waitMs(50);
		writeFileSync(join(dir, "node_modules", "dep.js"), "module.exports = {}");
		await waitMs(50);

		// Wait long enough that any triggered debounce + cycle would have fired
		await waitMs(700);
		handle.stop();

		assert.equal(cycleCount, 0, "no cycles should fire for .git / node_modules changes");
	});
});

// ---------------------------------------------------------------------------
// Debounces rapid file changes
// ---------------------------------------------------------------------------

describe("startCheckWatch — debounce", () => {
	const dirs: string[] = [];
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	it("debounces rapid changes into a single cycle", { timeout: 4000 }, async () => {
		const dir = makeTmp("debounce");
		dirs.push(dir);

		const marker = join(dir, "marker.txt");
		const todoPath = join(dir, "todo.md");

		// Start without marker so first cycle will fail, then re-trigger
		writeFileSync(todoPath, `- [ ] Marker exists\n  - eval: \`test -f ${marker}\`\n`);

		const failedIds = new Set(["marker-exists"]);
		let cycleCount = 0;

		await new Promise<void>((resolve, reject) => {
			const handle = startCheckWatch({
				todoPath,
				failedIds,
				cwd: dir,
				onCycle() {
					cycleCount++;
				},
			});

			// Trigger multiple rapid changes within the debounce window
			setTimeout(() => {
				for (let i = 0; i < 5; i++) {
					writeFileSync(join(dir, `file${i}.ts`), `// change ${i}`);
				}
			}, 100);

			// Stop after enough time for the debounce to settle + one cycle
			setTimeout(() => {
				handle.stop();
				resolve();
			}, 1500);

			setTimeout(() => {
				handle.stop();
				reject(new Error("timeout in debounce test"));
			}, 3500);
		});

		// 5 rapid writes within a 300ms debounce window should produce ≤ 2 cycles
		assert.ok(cycleCount <= 2, `expected ≤2 cycles from rapid changes, got ${cycleCount}`);
	});
});
