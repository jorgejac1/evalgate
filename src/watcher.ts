/**
 * greenlight watcher daemon — v0.3
 *
 * Runs three trigger engines simultaneously:
 *   - Schedule engine: fires contracts on cron expressions
 *   - Watch engine:    fires contracts when files matching a glob change
 *   - Webhook engine:  fires contracts when an HTTP path is hit
 *
 * All engines share a single `fireContract` function that runs the eval
 * and writes the result back to todo.md.
 *
 * Zero runtime dependencies.
 */

import { readFileSync, writeFileSync, existsSync, watch as fsWatch } from "node:fs";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { parseTodo } from "./parser.js";
import { runContract } from "./verifier.js";
import { updateTodo } from "./writer.js";
import { parseCron, nextFireMs } from "./cron.js";
import type { Contract, ContractTrigger, RunResult } from "./types.js";

export interface WatcherOptions {
  todoPath: string;
  webhookPort?: number;
  enableSchedule?: boolean;
  enableWatch?: boolean;
  enableWebhook?: boolean;
  /**
   * Root directory for resolving watch globs. Defaults to process.cwd() so
   * globs like "src/auth/**" are relative to where greenlight is invoked,
   * not to the todo.md location.
   */
  watchRoot?: string;
  onFire?: (contract: Contract, result: RunResult) => void;
  onError?: (err: Error) => void;
}

interface ActiveSchedule {
  contractId: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface WatcherHandle {
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function startWatcher(opts: WatcherOptions): WatcherHandle {
  const {
    todoPath,
    webhookPort = 7778,
    enableSchedule = true,
    enableWatch = true,
    enableWebhook = true,
    watchRoot = process.cwd(),
    onFire,
    onError,
  } = opts;

  const cwd = resolve(dirname(todoPath));
  const resolvedWatchRoot = resolve(watchRoot);
  const schedules: ActiveSchedule[] = [];
  let webhookServer: ReturnType<typeof createServer> | null = null;
  let fsWatcher: ReturnType<typeof fsWatch> | null = null;
  let stopped = false;

  function log(msg: string): void {
    process.stderr.write(`[greenlight] ${msg}\n`);
  }

  function handleError(err: Error): void {
    log(`error: ${err.message}`);
    onError?.(err);
  }

  // ---------------------------------------------------------------------------
  // Shared: load contracts from disk
  // ---------------------------------------------------------------------------

  function loadContracts(): Contract[] {
    if (!existsSync(todoPath)) return [];
    const source = readFileSync(todoPath, "utf8");
    return parseTodo(source);
  }

  // ---------------------------------------------------------------------------
  // Shared: fire a contract
  // ---------------------------------------------------------------------------

  async function fireContract(contractId: string, trigger: ContractTrigger): Promise<void> {
    if (stopped) return;

    // Re-read from disk each time so we have the freshest state
    if (!existsSync(todoPath)) return;
    const source = readFileSync(todoPath, "utf8");
    const contracts = parseTodo(source);
    const contract = contracts.find((c) => c.id === contractId);

    if (!contract) {
      log(`trigger fired but contract '${contractId}' not found — skipping`);
      return;
    }
    if (!contract.verifier) {
      log(`trigger fired for '${contractId}' but it has no verifier — skipping`);
      return;
    }

    log(`▸ firing '${contract.title}' (${trigger.kind})`);
    const result = await runContract(contract, cwd, {
      todoPath,
      trigger: trigger.kind,
    });

    const updated = updateTodo(source, [result]);
    if (updated !== source) writeFileSync(todoPath, updated);

    const status = result.passed ? "✓ passed" : `✗ failed (exit ${result.exitCode})`;
    log(`  ${contract.title}: ${status} (${result.durationMs}ms)`);

    onFire?.(contract, result);
  }

  // ---------------------------------------------------------------------------
  // Schedule engine
  // ---------------------------------------------------------------------------

  function scheduleContract(contract: Contract): void {
    if (!contract.trigger || contract.trigger.kind !== "schedule") return;

    const { cron } = contract.trigger;
    let expr;
    try {
      expr = parseCron(cron);
    } catch (e) {
      handleError(new Error(`Invalid cron for '${contract.id}': ${cron} — ${(e as Error).message}`));
      return;
    }

    const ms = nextFireMs(expr);
    if (ms === Infinity) return;

    log(`  scheduled '${contract.title}' → next fire in ${Math.round(ms / 1000)}s (${cron})`);

    const timer = setTimeout(() => {
      if (stopped) return;
      void fireContract(contract.id, contract.trigger!).then(() => {
        // Reschedule after firing
        const remaining = schedules.findIndex((s) => s.contractId === contract.id);
        if (remaining !== -1) schedules.splice(remaining, 1);
        // Re-load contract from disk in case it changed
        const fresh = loadContracts().find((c) => c.id === contract.id);
        if (fresh?.trigger?.kind === "schedule") scheduleContract(fresh);
      });
    }, ms);

    schedules.push({ contractId: contract.id, timer });
  }

  function startScheduleEngine(): void {
    const contracts = loadContracts();
    const scheduled = contracts.filter((c) => c.trigger?.kind === "schedule");
    if (scheduled.length === 0) return;
    log(`schedule engine: ${scheduled.length} contract(s)`);
    for (const c of scheduled) scheduleContract(c);
  }

  // ---------------------------------------------------------------------------
  // Watch engine
  // ---------------------------------------------------------------------------

  function startWatchEngine(): void {
    const contracts = loadContracts();
    const watchers = contracts.filter((c) => c.trigger?.kind === "watch");
    if (watchers.length === 0) return;

    log(`watch engine: ${watchers.length} contract(s) watching ${resolvedWatchRoot}`);

    // Debounce per-contract to avoid duplicate fires on rapid saves
    const debounce = new Map<string, ReturnType<typeof setTimeout>>();

    function onFileChange(filename: string | null): void {
      if (!filename) return;

      // fs.watch returns paths relative to the watched directory.
      // Reconstruct the full path then make it relative to watchRoot so
      // globs like "examples/basic/**" work when invoked from the project root.
      const fullPath = resolve(resolvedWatchRoot, filename);
      const relPath = fullPath.startsWith(resolvedWatchRoot + "/")
        ? fullPath.slice(resolvedWatchRoot.length + 1)
        : filename;

      for (const contract of watchers) {
        if (contract.trigger?.kind !== "watch") continue;
        const glob = contract.trigger.glob;

        if (matchesGlob(relPath, glob)) {
          const existing = debounce.get(contract.id);
          if (existing) clearTimeout(existing);
          debounce.set(
            contract.id,
            setTimeout(() => {
              debounce.delete(contract.id);
              void fireContract(contract.id, contract.trigger!);
            }, 500)
          );
        }
      }
    }

    try {
      fsWatcher = fsWatch(resolvedWatchRoot, { recursive: true }, (_event, filename) => {
        onFileChange(filename);
      });
      fsWatcher.on("error", handleError);
    } catch (e) {
      handleError(new Error(`fs.watch failed: ${(e as Error).message}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Webhook engine
  // ---------------------------------------------------------------------------

  function startWebhookEngine(): void {
    const contracts = loadContracts();
    const hooks = contracts.filter((c) => c.trigger?.kind === "webhook");
    if (hooks.length === 0) return;

    log(`webhook engine: listening on port ${webhookPort}`);
    for (const c of hooks) {
      log(`  POST ${(c.trigger as { path: string }).path} → '${c.title}'`);
    }

    webhookServer = createServer((req, res) => {
      if (req.method !== "POST" && req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
        return;
      }

      // Re-load contracts fresh on each request
      const current = loadContracts();
      const contract = current.find(
        (c) => c.trigger?.kind === "webhook" &&
          (c.trigger as { path: string }).path === req.url
      );

      if (!contract) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no contract for this path" }));
        return;
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true, contract_id: contract.id }));

      // Fire asynchronously so the HTTP response is sent immediately
      void fireContract(contract.id, contract.trigger!);
    });

    webhookServer.on("error", handleError);
    webhookServer.listen(webhookPort);
  }

  // ---------------------------------------------------------------------------
  // Start all engines
  // ---------------------------------------------------------------------------

  log(`watcher started (${todoPath})`);
  if (enableSchedule) startScheduleEngine();
  if (enableWatch) startWatchEngine();
  if (enableWebhook) startWebhookEngine();

  // ---------------------------------------------------------------------------
  // Stop handle
  // ---------------------------------------------------------------------------

  return {
    stop(): void {
      stopped = true;
      for (const s of schedules) clearTimeout(s.timer);
      schedules.length = 0;
      fsWatcher?.close();
      webhookServer?.close();
      log("watcher stopped");
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal glob matcher
// Supports: * (any chars except /), ** (any chars including /), ? (any char)
// ---------------------------------------------------------------------------

export function matchesGlob(filename: string, glob: string): boolean {
  // Normalize separators
  const f = filename.replace(/\\/g, "/");
  const g = glob.replace(/\\/g, "/");

  const regexStr = g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except * and ?
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");

  return new RegExp(`^${regexStr}$`).test(f);
}
