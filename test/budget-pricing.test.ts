/**
 * Tests for the estimateUsd() export added in v2.3.
 * Validates per-model pricing against known rates:
 *   sonnet4: $3/$15 per MTok in/out
 *   haiku4:  $0.80/$4 per MTok in/out
 *   opus4:   $15/$75 per MTok in/out
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateUsd } from "../src/budget.js";

describe("estimateUsd", () => {
	it("returns 1.8 for 100k/100k tokens with default (sonnet4) model", () => {
		// 100_000 * 3 / 1_000_000 + 100_000 * 15 / 1_000_000 = 0.3 + 1.5 = 1.8
		const result = estimateUsd(100_000, 100_000);
		assert.ok(Math.abs(result - 1.8) < 0.0001, `Expected ~1.8, got ${result}`);
	});

	it('returns 0.48 for 100k/100k tokens with "haiku4" model', () => {
		// 100_000 * 0.8 / 1_000_000 + 100_000 * 4 / 1_000_000 = 0.08 + 0.4 = 0.48
		const result = estimateUsd(100_000, 100_000, "haiku4");
		assert.ok(Math.abs(result - 0.48) < 0.0001, `Expected ~0.48, got ${result}`);
	});

	it('returns 9.0 for 100k/100k tokens with "opus4" model', () => {
		// 100_000 * 15 / 1_000_000 + 100_000 * 75 / 1_000_000 = 1.5 + 7.5 = 9.0
		const result = estimateUsd(100_000, 100_000, "opus4");
		assert.ok(Math.abs(result - 9.0) < 0.0001, `Expected ~9.0, got ${result}`);
	});

	it("returns 0 when both token counts are 0", () => {
		const result = estimateUsd(0, 0);
		assert.strictEqual(result, 0);
	});

	it("returns 3.0 for pure input: 1M input tokens, 0 output (sonnet4)", () => {
		// 1_000_000 * 3 / 1_000_000 + 0 = 3.0
		const result = estimateUsd(1_000_000, 0);
		assert.ok(Math.abs(result - 3.0) < 0.0001, `Expected ~3.0, got ${result}`);
	});

	it("returns 15.0 for pure output: 0 input tokens, 1M output (sonnet4)", () => {
		// 0 + 1_000_000 * 15 / 1_000_000 = 15.0
		const result = estimateUsd(0, 1_000_000);
		assert.ok(Math.abs(result - 15.0) < 0.0001, `Expected ~15.0, got ${result}`);
	});
});
