#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { parseTodo } from "./parser.js";
import { runContract } from "./verifier.js";
import { updateTodo } from "./writer.js";
import { startMcpServer } from "./mcp.js";
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
    const result = await runContract(c, cwd);
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

  const cwd = resolve(dirname(todoPath));
  process.stdout.write(`  ${C.dim}▸${C.reset} running verifier ... `);
  const result = await runContract(contract, cwd);

  if (result.passed) {
    console.log(`${C.green}✓ passed${C.reset} ${C.dim}(${result.durationMs}ms)${C.reset}`);
    const updated = updateTodo(source, [result]);
    if (updated !== source) writeFileSync(todoPath, updated);
    return 0;
  }

  console.log(
    `${C.red}✗ failed${C.reset} ${C.dim}(exit ${result.exitCode}, ${result.durationMs}ms)${C.reset}`
  );

  console.log(`\n${C.bold}Failure context for retry:${C.reset}`);
  const combined = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  const lines = combined.split("\n").slice(-30);
  for (const l of lines) {
    console.log(`  ${C.dim}│${C.reset} ${l}`);
  }

  return 1;
}

function usage(): void {
  console.log(
    `
${C.bold}greenlight${C.reset} — eval-gated todos for agents

${C.bold}USAGE${C.reset}
  greenlight check  [path]        Run verifiers on pending contracts
  greenlight list   [path]        List contracts and their status
  greenlight retry  <id> [path]   Rerun a single contract and show failure context
  greenlight serve  [cwd]         Start MCP server on stdio
  greenlight help                 Show this message

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
    case "serve": {
      const cwd = args[0] ? resolve(args[0]) : process.cwd();
      startMcpServer(cwd);
      // startMcpServer keeps the process alive via readline — don't exit
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
