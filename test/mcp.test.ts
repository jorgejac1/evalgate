/**
 * MCP server tests — spawn the server as a child process and drive it
 * via stdio JSON-RPC, exactly as Claude Desktop / Cursor would.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RpcResult {
  result?: unknown;
  error?: { code: number; message: string };
}

function rpc(
  cwd: string,
  requests: object[]
): Promise<RpcResult[]> {
  // Count how many requests have an id (notifications have no id and get no response)
  const expectedCount = requests.filter(
    (r) => (r as Record<string, unknown>)["id"] != null
  ).length;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "serve", cwd],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    const results: RpcResult[] = [];
    let buffer = "";

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server timeout — got ${results.length}/${expectedCount} responses`));
    }, 15_000);

    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      // Parse complete lines as they arrive
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep incomplete last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          results.push(JSON.parse(trimmed) as RpcResult);
        } catch {
          results.push({ error: { code: -1, message: `bad json: ${trimmed}` } });
        }
        // Once we have all expected responses, close stdin and let server exit
        if (results.length >= expectedCount) {
          clearTimeout(timeout);
          child.stdin.end();
        }
      }
    });

    // Send all requests upfront — server processes them in order
    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + "\n");
    }

    child.on("close", () => {
      clearTimeout(timeout);
      resolve(results);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function makeTmpProject(todoContent: string): string {
  const dir = join(tmpdir(), `gl-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "todo.md"), todoContent);
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// Standard JSON-RPC helpers
let _id = 1;
function req(method: string, params: object = {}): object {
  return { jsonrpc: "2.0", id: _id++, method, params };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server — protocol handshake", () => {
  it("responds to initialize with server info and capabilities", async () => {
    const dir = makeTmpProject("- [ ] nothing\n");
    try {
      const [resp] = await rpc(dir, [req("initialize", { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "1" }, capabilities: {} })]);
      assert.ok(resp.result, "expected result");
      const result = resp.result as Record<string, unknown>;
      assert.equal((result["serverInfo"] as Record<string, unknown>)["name"], "greenlight");
      assert.ok(result["capabilities"]);
    } finally {
      cleanup(dir);
    }
  });

  it("responds to tools/list with 4 tools", async () => {
    const dir = makeTmpProject("- [ ] nothing\n");
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/list"),
      ]);
      const result = resp.result as Record<string, unknown>;
      const tools = result["tools"] as unknown[];
      assert.equal(tools.length, 15);
      const names = tools.map((t) => (t as Record<string, unknown>)["name"]);
      assert.ok(names.includes("list_triggers"));
      assert.ok(names.includes("list_all"));
      assert.ok(names.includes("list_pending"));
      assert.ok(names.includes("run_eval"));
      assert.ok(names.includes("check_all"));
      assert.ok(names.includes("get_retry_context"));
    } finally {
      cleanup(dir);
    }
  });
});

describe("MCP server — list_pending tool", () => {
  it("returns pending contracts", async () => {
    const dir = makeTmpProject(
      `- [ ] Add feature
  - eval: \`echo hello\`
- [x] Already done
  - eval: \`echo done\`
- [ ] No eval (ungated)
`
    );
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "list_pending", arguments: {} }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.equal(data["count"], 1);
      const contracts = data["contracts"] as Array<Record<string, unknown>>;
      assert.equal(contracts[0]["id"], "add-feature");
    } finally {
      cleanup(dir);
    }
  });

  it("returns empty when nothing is pending", async () => {
    const dir = makeTmpProject("- [x] Done\n  - eval: `echo ok`\n");
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "list_pending", arguments: {} }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.equal(data["count"], 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe("MCP server — run_eval tool", () => {
  it("passes and flips checkbox on exit 0", async () => {
    const dir = makeTmpProject("- [ ] Echo test\n  - eval: `echo ok`\n");
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "run_eval", arguments: { contract_id: "echo-test" } }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.equal(data["passed"], true);
      assert.equal(data["exitCode"], 0);
    } finally {
      cleanup(dir);
    }
  });

  it("fails on non-zero exit", async () => {
    const dir = makeTmpProject("- [ ] Failing test\n  - eval: `exit 1`\n");
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "run_eval", arguments: { contract_id: "failing-test" } }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.equal(data["passed"], false);
      assert.equal(data["exitCode"], 1);
    } finally {
      cleanup(dir);
    }
  });

  it("returns error for unknown contract_id", async () => {
    const dir = makeTmpProject("- [ ] Something\n  - eval: `echo x`\n");
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "run_eval", arguments: { contract_id: "does-not-exist" } }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.ok(typeof data["error"] === "string");
    } finally {
      cleanup(dir);
    }
  });
});

describe("MCP server — check_all tool", () => {
  it("runs all pending contracts and reports summary", async () => {
    const dir = makeTmpProject(
      `- [ ] Pass one
  - eval: \`echo pass\`
- [ ] Pass two
  - eval: \`echo pass\`
`
    );
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "check_all", arguments: {} }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.equal(data["count"], 2);
      assert.equal(data["passed"], 2);
      assert.equal(data["failed"], 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe("MCP server — get_retry_context tool", () => {
  it("returns failure context for a failing contract", async () => {
    const dir = makeTmpProject(
      "- [ ] Broken thing\n  - eval: `echo 'assertion failed' && exit 1`\n"
    );
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "get_retry_context", arguments: { contract_id: "broken-thing" } }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.equal(data["passed"], false);
      assert.ok(typeof data["context"] === "string");
      assert.ok((data["context"] as string).includes("assertion failed"));
    } finally {
      cleanup(dir);
    }
  });

  it("returns passed=true when contract now passes", async () => {
    const dir = makeTmpProject("- [ ] Passing thing\n  - eval: `echo ok`\n");
    try {
      const [, resp] = await rpc(dir, [
        req("initialize"),
        req("tools/call", { name: "get_retry_context", arguments: { contract_id: "passing-thing" } }),
      ]);
      const content = (resp.result as Record<string, unknown>)["content"] as Array<Record<string, unknown>>;
      const data = JSON.parse(content[0]["text"] as string) as Record<string, unknown>;
      assert.equal(data["passed"], true);
    } finally {
      cleanup(dir);
    }
  });
});
