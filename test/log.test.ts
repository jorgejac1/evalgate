import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { appendRun, queryRuns, getLastFailure, getLastRun } from "../src/log.js";
import type { RunResult, Contract } from "../src/types.js";

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "gl-log-test-"));
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

describe("appendRun + queryRuns", () => {
  it("appends a run and reads it back", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      const result = makeResult();
      appendRun(result, todoPath, "manual");
      const records = queryRuns(todoPath);
      assert.equal(records.length, 1);
      assert.equal(records[0].contractId, "test-contract");
      assert.equal(records[0].passed, true);
      assert.equal(records[0].trigger, "manual");
    } finally { cleanup(dir); }
  });

  it("returns empty array when no log exists", () => {
    const dir = makeTmp();
    try {
      const records = queryRuns(join(dir, "todo.md"));
      assert.equal(records.length, 0);
    } finally { cleanup(dir); }
  });

  it("returns most recent first", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      appendRun(makeResult({ durationMs: 1 }), todoPath, "manual");
      appendRun(makeResult({ durationMs: 2 }), todoPath, "manual");
      appendRun(makeResult({ durationMs: 3 }), todoPath, "manual");
      const records = queryRuns(todoPath);
      assert.equal(records[0].durationMs, 3);
      assert.equal(records[2].durationMs, 1);
    } finally { cleanup(dir); }
  });

  it("filters by contractId", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      const other: Contract = { id: "other", title: "Other", checked: false, status: "pending", line: 1, rawLines: [1] };
      appendRun(makeResult(), todoPath, "manual");
      appendRun({ ...makeResult(), contract: other }, todoPath, "manual");
      const records = queryRuns(todoPath, { contractId: "test-contract" });
      assert.equal(records.length, 1);
      assert.equal(records[0].contractId, "test-contract");
    } finally { cleanup(dir); }
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
    } finally { cleanup(dir); }
  });

  it("respects limit", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      for (let i = 0; i < 5; i++) appendRun(makeResult(), todoPath, "manual");
      const records = queryRuns(todoPath, { limit: 2 });
      assert.equal(records.length, 2);
    } finally { cleanup(dir); }
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
    } finally { cleanup(dir); }
  });
});

describe("getLastFailure", () => {
  it("returns the most recent failure", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      appendRun(makeResult({ passed: false, exitCode: 1, stdout: "first fail" }), todoPath, "manual");
      appendRun(makeResult({ passed: false, exitCode: 2, stdout: "second fail" }), todoPath, "manual");
      const record = getLastFailure(todoPath, "test-contract");
      assert.ok(record);
      assert.equal(record.stdout, "second fail");
    } finally { cleanup(dir); }
  });

  it("returns null if no failures exist", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      appendRun(makeResult({ passed: true }), todoPath, "manual");
      const record = getLastFailure(todoPath, "test-contract");
      assert.equal(record, null);
    } finally { cleanup(dir); }
  });
});

describe("getLastRun", () => {
  it("returns the most recent run regardless of pass/fail", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      appendRun(makeResult({ passed: false }), todoPath, "manual");
      appendRun(makeResult({ passed: true, durationMs: 999 }), todoPath, "manual");
      const record = getLastRun(todoPath, "test-contract");
      assert.ok(record);
      assert.equal(record.durationMs, 999);
    } finally { cleanup(dir); }
  });
});
