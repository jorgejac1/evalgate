import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { sendMessage, listMessages } from "../src/messages.js";

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "gl-msg-test-"));
  writeFileSync(join(dir, "todo.md"), "- [ ] test\n");
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("sendMessage + listMessages", () => {
  it("sends a message and reads it back", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      const msg = sendMessage(todoPath, {
        from: "coordinator",
        to: "worker-1",
        kind: "review_request",
        payload: { notes: "please review auth" },
      });
      assert.ok(msg.id);
      assert.equal(msg.from, "coordinator");
      assert.equal(msg.to, "worker-1");
      assert.equal(msg.kind, "review_request");

      const messages = listMessages(todoPath);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].id, msg.id);
    } finally { cleanup(dir); }
  });

  it("returns empty array when no messages exist", () => {
    const dir = makeTmp();
    try {
      const messages = listMessages(join(dir, "todo.md"));
      assert.equal(messages.length, 0);
    } finally { cleanup(dir); }
  });

  it("returns most recent first", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      sendMessage(todoPath, { from: "a", to: "b", kind: "status_update", payload: 1 });
      sendMessage(todoPath, { from: "a", to: "b", kind: "status_update", payload: 2 });
      sendMessage(todoPath, { from: "a", to: "b", kind: "status_update", payload: 3 });
      const messages = listMessages(todoPath);
      assert.equal(messages[0].payload, 3);
      assert.equal(messages[2].payload, 1);
    } finally { cleanup(dir); }
  });

  it("filters by recipient", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      sendMessage(todoPath, { from: "a", to: "worker-1", kind: "completion", payload: null });
      sendMessage(todoPath, { from: "a", to: "worker-2", kind: "completion", payload: null });
      const messages = listMessages(todoPath, { to: "worker-1" });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].to, "worker-1");
    } finally { cleanup(dir); }
  });

  it("includes broadcast messages when filtering by recipient", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      sendMessage(todoPath, { from: "a", to: "*", kind: "status_update", payload: "broadcast" });
      sendMessage(todoPath, { from: "a", to: "worker-1", kind: "completion", payload: "direct" });
      const messages = listMessages(todoPath, { to: "worker-1" });
      assert.equal(messages.length, 2);
    } finally { cleanup(dir); }
  });

  it("filters by kind", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      sendMessage(todoPath, { from: "a", to: "b", kind: "blocker", payload: null });
      sendMessage(todoPath, { from: "a", to: "b", kind: "completion", payload: null });
      const blockers = listMessages(todoPath, { kind: "blocker" });
      assert.equal(blockers.length, 1);
      assert.equal(blockers[0].kind, "blocker");
    } finally { cleanup(dir); }
  });

  it("respects limit", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      for (let i = 0; i < 5; i++) {
        sendMessage(todoPath, { from: "a", to: "b", kind: "status_update", payload: i });
      }
      const messages = listMessages(todoPath, { limit: 2 });
      assert.equal(messages.length, 2);
    } finally { cleanup(dir); }
  });

  it("stores correlationId", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      const req = sendMessage(todoPath, { from: "a", to: "b", kind: "review_request", payload: null });
      sendMessage(todoPath, { from: "b", to: "a", kind: "completion", payload: null, correlationId: req.id });
      const messages = listMessages(todoPath);
      assert.equal(messages[0].correlationId, req.id);
    } finally { cleanup(dir); }
  });

  it("stores contractId", () => {
    const dir = makeTmp();
    try {
      const todoPath = join(dir, "todo.md");
      sendMessage(todoPath, { from: "a", to: "b", kind: "blocker", payload: null, contractId: "my-contract" });
      const messages = listMessages(todoPath);
      assert.equal(messages[0].contractId, "my-contract");
    } finally { cleanup(dir); }
  });
});
