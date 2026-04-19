import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTodo } from "../src/parser.js";
import { updateTodo } from "../src/writer.js";

test("parses a simple unchecked item with an eval", () => {
	const src = [
		"# todo",
		"",
		"- [ ] Refactor auth to use JWT",
		"  - eval: `pnpm test src/auth`",
		"  - retries: 3",
		"  - budget: 50k",
	].join("\n");

	const [c] = parseTodo(src);
	assert.equal(c.title, "Refactor auth to use JWT");
	assert.equal(c.checked, false);
	assert.equal(c.status, "pending");
	assert.deepEqual(c.verifier, {
		kind: "shell",
		command: "pnpm test src/auth",
	});
	assert.equal(c.retries, 3);
	assert.equal(c.budget, 50_000);
});

test("parses a checked item and marks it passed", () => {
	const src = "- [x] Already done";
	const [c] = parseTodo(src);
	assert.equal(c.checked, true);
	assert.equal(c.status, "passed");
	assert.equal(c.verifier, undefined);
});

test("parses multiple contracts", () => {
	const src = [
		"- [ ] One",
		"  - eval: `true`",
		"- [ ] Two",
		"  - eval: `false`",
		"- [x] Three",
	].join("\n");

	const contracts = parseTodo(src);
	assert.equal(contracts.length, 3);
	assert.equal(contracts[0].title, "One");
	assert.equal(contracts[1].title, "Two");
	assert.equal(contracts[2].title, "Three");
	assert.equal(contracts[2].checked, true);
});

test("ignores unrelated bullets", () => {
	const src = [
		"# Notes",
		"",
		"- just a bullet, not a checkbox",
		"- [ ] Real item",
		"  - eval: `echo hi`",
	].join("\n");

	const contracts = parseTodo(src);
	assert.equal(contracts.length, 1);
	assert.equal(contracts[0].title, "Real item");
});

test("respects explicit id field over slugify", () => {
	const src = [
		"- [ ] Some very long title with punctuation!",
		"  - id: custom-id",
		"  - eval: `true`",
	].join("\n");

	const [c] = parseTodo(src);
	assert.equal(c.id, "custom-id");
});

test("parses budget suffixes (k, m)", () => {
	const src = [
		"- [ ] A",
		"  - eval: `true`",
		"  - budget: 1.5k",
		"- [ ] B",
		"  - eval: `true`",
		"  - budget: 2m",
		"- [ ] C",
		"  - eval: `true`",
		"  - budget: 500",
	].join("\n");

	const [a, b, c] = parseTodo(src);
	assert.equal(a.budget, 1_500);
	assert.equal(b.budget, 2_000_000);
	assert.equal(c.budget, 500);
});

test("updateTodo flips checkbox on pass and preserves on fail", () => {
	const src = ["- [ ] A", "  - eval: `true`", "- [ ] B", "  - eval: `false`"].join("\n");
	const contracts = parseTodo(src);
	const out = updateTodo(src, [
		{ contract: contracts[0], passed: true, stdout: "", stderr: "", exitCode: 0, durationMs: 1 },
		{ contract: contracts[1], passed: false, stdout: "", stderr: "x", exitCode: 1, durationMs: 1 },
	]);
	assert.match(out, /- \[x\] A/);
	assert.match(out, /- \[ \] B/);
});

test("sub-bullet must be more indented than checkbox", () => {
	const src = ["- [ ] Parent", "- eval: `this should NOT belong to parent`"].join("\n");
	const [c] = parseTodo(src);
	assert.equal(c.verifier, undefined);
});

test("parses eval.diff has syntax", () => {
	const source = [
		"- [ ] Add JWT validation",
		'  - eval.diff: src/auth.ts has "function validateToken"',
	].join("\n");
	const [c] = parseTodo(source);
	assert.deepEqual(c.verifier, {
		kind: "diff",
		file: "src/auth.ts",
		mode: "has",
		pattern: "function validateToken",
	});
});

test("parses eval.diff lacks syntax", () => {
	const source = [
		"- [ ] Remove deprecated helper",
		'  - eval.diff: src/utils.ts lacks "deprecatedFn"',
	].join("\n");
	const [c] = parseTodo(source);
	assert.deepEqual(c.verifier, {
		kind: "diff",
		file: "src/utils.ts",
		mode: "lacks",
		pattern: "deprecatedFn",
	});
});

test("ignores malformed eval.diff (no mode)", () => {
	const source = ["- [ ] Bad diff", "  - eval.diff: src/auth.ts badmode pattern"].join("\n");
	const [c] = parseTodo(source);
	assert.strictEqual(c.verifier, undefined);
});
