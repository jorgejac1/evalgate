#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { parseTodo } from "./parser.js";
import { runContract } from "./verifier.js";
import { updateTodo } from "./writer.js";
import { startMcpServer } from "./mcp.js";
import { startWatcher } from "./watcher.js";
import { queryRuns, getLastFailure } from "./log.js";
import { sendMessage, listMessages } from "./messages.js";
import type { RunResult } from "./types.js";

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: COLOR ? "\x1b[0m" : "",
  red: COLOR ? "\x1b[31m" : "",
  green: COLOR ? "\x1b[32m" : "",
  yellow: COLOR ? "\x1b[33m" : "",
  cyan: COLOR ? "\x1b[36m" : "",
  bold: COLOR ? "\x1b[1m" : "",
  dim: COLOR ? "\x1b[2m" : "",
};

function formatCommand(v: RunResult["contract"]["verifier"]): string {
  if (!v) return "no verifier";
  if (v.kind === "shell") return v.command;
  return `composite(${v.all.length})`;
}

function looksLikeFailure(s: string): boolean {
  return /\b(error|fail(ed)?|expected|assertion|✖|✗|throws?)\b/i.test(s);
}

async function cmdCheck(todoPath: string): Promise<number> {
  if (!existsSync(todoPath)) {
    console.error(`${C.red}greenlight: file not found: ${todoPath}${C.reset}`);
    return 1;
  }

  const source = readFileSync(todoPath, "utf8");
  const contracts = parseTodo(source);
  const pending = contracts.filter((c) => !c.checked && c.verifier);

  if (pending.length === 0) {
    console.log(
      `${C.dim}greenlight: no pending contracts with verifiers in ${basename(todoPath)}${C.reset}`
    );
    return 0;
  }

  console.log(
    `${C.bold}greenlight${C.reset} ${C.dim}·${C.reset} checking ${pending.length} contract${pending.length === 1 ? "" : "s"} ${C.dim}in ${basename(todoPath)}${C.reset}\n`
  );

  const cwd = resolve(dirname(todoPath));
  const results: RunResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const c of pending) {
    process.stdout.write(
      `  ${C.dim}▸${C.reset} ${c.title} ${C.dim}(${c.id})${C.reset} ... `
    );
    const result = await runContract(c, cwd, { todoPath, trigger: "manual" });
    results.push(result);

    if (result.passed) {
      console.log(
        `${C.green}✓ passed${C.reset} ${C.dim}(${result.durationMs}ms)${C.reset}`
      );
      passed++;
    } else {
      console.log(
        `${C.red}✗ failed${C.reset} ${C.dim}(exit ${result.exitCode}, ${result.durationMs}ms)${C.reset}`
      );
      failed++;
      // Prefer whichever stream carries the assertion detail. Many test
      // runners emit failures on stdout (TAP) while others use stderr.
      const stderr = result.stderr.trim();
      const stdout = result.stdout.trim();
      const source = looksLikeFailure(stderr) ? stderr : stdout || stderr;
      const tail = source.split("\n").slice(-20);
      for (const l of tail) {
        console.log(`    ${C.dim}│${C.reset} ${l}`);
      }
    }
  }

  const updated = updateTodo(source, results);
  if (updated !== source) {
    writeFileSync(todoPath, updated);
  }

  console.log(
    `\n${C.bold}Summary:${C.reset} ${C.green}${passed} passed${C.reset}, ${failed > 0 ? C.red : C.dim}${failed} failed${C.reset}`
  );

  return failed > 0 ? 1 : 0;
}

async function cmdList(todoPath: string): Promise<number> {
  if (!existsSync(todoPath)) {
    console.error(`${C.red}greenlight: file not found: ${todoPath}${C.reset}`);
    return 1;
  }

  const source = readFileSync(todoPath, "utf8");
  const contracts = parseTodo(source);
  if (contracts.length === 0) {
    console.log(`${C.dim}no contracts found${C.reset}`);
    return 0;
  }

  for (const c of contracts) {
    const mark = c.checked
      ? `${C.green}✓${C.reset}`
      : c.verifier
      ? `${C.yellow}○${C.reset}`
      : `${C.dim}○${C.reset}`;
    console.log(`${mark} ${c.title} ${C.dim}(${c.id})${C.reset}`);
    if (c.verifier) {
      console.log(`  ${C.dim}eval:${C.reset} ${C.cyan}${formatCommand(c.verifier)}${C.reset}`);
    }
    if (c.retries !== undefined) {
      console.log(`  ${C.dim}retries: ${c.retries}${C.reset}`);
    }
    if (c.budget !== undefined) {
      console.log(`  ${C.dim}budget: ${c.budget.toLocaleString()} tokens${C.reset}`);
    }
  }
  return 0;
}

async function cmdRetry(contractId: string, todoPath: string): Promise<number> {
  if (!contractId) {
    console.error(`${C.red}greenlight retry: contract id required${C.reset}`);
    console.error(`  usage: greenlight retry <id> [path]`);
    return 1;
  }
  if (!existsSync(todoPath)) {
    console.error(`${C.red}greenlight: file not found: ${todoPath}${C.reset}`);
    return 1;
  }

  const source = readFileSync(todoPath, "utf8");
  const contracts = parseTodo(source);
  const normalized = contractId.trim().toLowerCase();
  const contract = contracts.find(
    (c) => c.id === normalized || c.title.toLowerCase() === normalized
  );

  if (!contract) {
    console.error(`${C.red}greenlight: contract not found: ${contractId}${C.reset}`);
    console.log(`\nAvailable ids:`);
    for (const c of contracts) {
      console.log(`  ${C.dim}${c.id}${C.reset} — ${c.title}`);
    }
    return 1;
  }

  if (!contract.verifier) {
    console.error(`${C.red}greenlight: contract '${contractId}' has no verifier${C.reset}`);
    return 1;
  }

  console.log(
    `${C.bold}greenlight retry${C.reset} ${C.dim}·${C.reset} ${contract.title} ${C.dim}(${contract.id})${C.reset}\n`
  );

  // Show last failure from durable log if available
  const lastFailure = getLastFailure(todoPath, contract.id);
  if (lastFailure) {
    const ago = new Date(lastFailure.ts).toLocaleString();
    console.log(`${C.bold}Last failure${C.reset} ${C.dim}(${ago}, exit ${lastFailure.exitCode}, ${lastFailure.durationMs}ms):${C.reset}`);
    const combined = [lastFailure.stdout.trim(), lastFailure.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    for (const l of combined.split("\n").slice(-20)) {
      console.log(`  ${C.dim}│${C.reset} ${l}`);
    }
    console.log();
  }

  const cwd = resolve(dirname(todoPath));
  process.stdout.write(`  ${C.dim}▸${C.reset} retrying ... `);
  const result = await runContract(contract, cwd, { todoPath, trigger: "retry" });

  if (result.passed) {
    console.log(`${C.green}✓ passed${C.reset} ${C.dim}(${result.durationMs}ms)${C.reset}`);
    const updated = updateTodo(source, [result]);
    if (updated !== source) writeFileSync(todoPath, updated);
    return 0;
  }

  console.log(
    `${C.red}✗ failed${C.reset} ${C.dim}(exit ${result.exitCode}, ${result.durationMs}ms)${C.reset}`
  );
  const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  for (const l of combined.split("\n").slice(-20)) {
    console.log(`  ${C.dim}│${C.reset} ${l}`);
  }

  return 1;
}

async function cmdLog(todoPath: string, args: string[]): Promise<number> {
  if (!existsSync(todoPath)) {
    console.error(`${C.red}greenlight: file not found: ${todoPath}${C.reset}`);
    return 1;
  }

  const contractId = args.find((a) => a.startsWith("--contract="))?.split("=")[1];
  const failedOnly = args.includes("--failed");
  const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const limit = limitArg ? parseInt(limitArg, 10) : 20;

  const records = queryRuns(todoPath, {
    contractId,
    passed: failedOnly ? false : undefined,
    limit,
  });

  if (records.length === 0) {
    console.log(`${C.dim}no run history found${C.reset}`);
    return 0;
  }

  console.log(`${C.bold}greenlight log${C.reset} ${C.dim}· ${records.length} run(s)${C.reset}\n`);
  for (const r of records) {
    const status = r.passed
      ? `${C.green}✓ passed${C.reset}`
      : `${C.red}✗ failed${C.reset}`;
    const ts = new Date(r.ts).toLocaleString();
    console.log(
      `${status}  ${C.bold}${r.contractTitle}${C.reset} ${C.dim}(${r.contractId})${C.reset}`
    );
    console.log(
      `  ${C.dim}${ts} · ${r.trigger} · exit ${r.exitCode} · ${r.durationMs}ms${C.reset}`
    );
  }
  return 0;
}

async function cmdMsg(subCmd: string, args: string[], todoPath: string): Promise<number> {
  if (subCmd === "send") {
    const [from, to, kind, payloadRaw] = args;
    if (!from || !to || !kind) {
      console.error(`${C.red}usage: greenlight msg send <from> <to> <kind> [payload-json]${C.reset}`);
      return 1;
    }
    let payload: unknown = null;
    if (payloadRaw) {
      try { payload = JSON.parse(payloadRaw); }
      catch { payload = payloadRaw; }
    }
    const msg = sendMessage(todoPath, {
      from,
      to,
      kind: kind as Parameters<typeof sendMessage>[1]["kind"],
      payload,
    });
    console.log(`${C.green}sent${C.reset} ${C.dim}(${msg.id})${C.reset}`);
    console.log(JSON.stringify(msg, null, 2));
    return 0;
  }

  if (subCmd === "list") {
    const toArg = args.find((a) => a.startsWith("--to="))?.split("=")[1];
    const kindArg = args.find((a) => a.startsWith("--kind="))?.split("=")[1];
    const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
    const messages = listMessages(todoPath, {
      to: toArg,
      kind: kindArg as import("./types.js").MessageKind | undefined,
      limit: limitArg ? parseInt(limitArg, 10) : 20,
    });
    if (messages.length === 0) {
      console.log(`${C.dim}no messages found${C.reset}`);
      return 0;
    }
    for (const m of messages) {
      console.log(
        `${C.cyan}${m.kind}${C.reset}  ${C.dim}${m.from} → ${m.to}${C.reset}  ${new Date(m.ts).toLocaleString()}`
      );
      if (m.contractId) console.log(`  ${C.dim}contract: ${m.contractId}${C.reset}`);
      console.log(`  ${C.dim}${JSON.stringify(m.payload)}${C.reset}`);
    }
    return 0;
  }

  console.error(`${C.red}unknown msg subcommand: ${subCmd}${C.reset}`);
  console.error(`  usage: greenlight msg send|list ...`);
  return 1;
}

function usage(): void {
  console.log(
    `
${C.bold}greenlight${C.reset} — eval-gated todos for agents

${C.bold}USAGE${C.reset}
  greenlight check  [path]              Run verifiers on pending contracts
  greenlight list   [path]              List contracts and their status
  greenlight retry  <id> [path]         Rerun a contract with last failure context
  greenlight log    [path] [--contract=<id>] [--failed] [--limit=N]
  greenlight msg    send <from> <to> <kind> [payload-json] [path]
  greenlight msg    list [--to=<agent>] [--kind=<kind>] [path]
  greenlight serve  [cwd]               Start MCP server on stdio
  greenlight watch  [path]              Start trigger daemon (schedule/watch/webhook)
  greenlight help                       Show this message

${C.bold}CONTRACT FORMAT${C.reset} (todo.md)
  - [ ] Refactor auth middleware to use JWT
    - eval: \`pnpm test src/auth && pnpm lint src/auth\`
    - retries: 3
    - budget: 50k

${C.dim}If no path is given, ./todo.md is used.${C.reset}
  `.trim()
  );
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);

  let exitCode = 0;
  switch (cmd) {
    case "check": {
      const todoPath = args[0] ?? "todo.md";
      exitCode = await cmdCheck(todoPath);
      break;
    }
    case "list": {
      const todoPath = args[0] ?? "todo.md";
      exitCode = await cmdList(todoPath);
      break;
    }
    case "retry": {
      const [contractId, todoPath = "todo.md"] = args;
      exitCode = await cmdRetry(contractId ?? "", todoPath);
      break;
    }
    case "log": {
      const flags = args.filter((a) => a.startsWith("--"));
      const positional = args.filter((a) => !a.startsWith("--"));
      const todoPath = positional[0] ?? "todo.md";
      exitCode = await cmdLog(todoPath, flags);
      break;
    }
    case "msg": {
      const [subCmd, ...rest] = args;
      // Last non-flag arg that looks like a path is the todoPath
      const flags = rest.filter((a) => a.startsWith("--"));
      const positional = rest.filter((a) => !a.startsWith("--"));
      const todoPath = (subCmd === "list"
        ? positional[0]
        : positional[4]) ?? "todo.md";
      // send: from to kind payload — pass all 4 positional args
      const msgArgs = subCmd === "list" ? flags : [...positional.slice(0, 4), ...flags];
      exitCode = await cmdMsg(subCmd ?? "", msgArgs, todoPath);
      break;
    }
    case "serve": {
      const cwd = args[0] ? resolve(args[0]) : process.cwd();
      startMcpServer(cwd);
      // startMcpServer keeps the process alive via readline — don't exit
      return;
    }
    case "watch": {
      const todoPath = resolve(args[0] ?? "todo.md");
      const portArg = args.find((a) => a.startsWith("--port="));
      const port = portArg ? parseInt(portArg.split("=")[1], 10) : 7778;
      const noSchedule = args.includes("--no-schedule");
      const noWatch = args.includes("--no-watch");
      const noWebhook = args.includes("--no-webhook");

      if (!existsSync(todoPath)) {
        console.error(`${C.red}greenlight: file not found: ${todoPath}${C.reset}`);
        process.exit(1);
      }

      const handle = startWatcher({
        todoPath,
        webhookPort: port,
        enableSchedule: !noSchedule,
        enableWatch: !noWatch,
        enableWebhook: !noWebhook,
      });

      process.on("SIGINT", () => { handle.stop(); process.exit(0); });
      process.on("SIGTERM", () => { handle.stop(); process.exit(0); });
      // Keep process alive — watcher engines hold open handles
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      console.error(`${C.red}unknown command: ${cmd}${C.reset}\n`);
      usage();
      exitCode = 1;
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(`${C.red}greenlight error:${C.reset}`, e?.stack ?? e);
  process.exit(1);
});
