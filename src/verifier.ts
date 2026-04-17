import { spawn } from "node:child_process";
import type { Contract, RunResult, ShellVerifier, TriggerSource } from "./types.js";
import { appendRun } from "./log.js";

interface ShellOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export async function runShell(
  v: ShellVerifier,
  cwd: string
): Promise<ShellOutcome> {
  const start = Date.now();
  const timeoutMs = v.timeoutMs ?? 120_000;

  return new Promise((resolve) => {
    const child = spawn(v.command, { shell: true, cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: -1,
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: timedOut
          ? stderr + `\n[greenlight] verifier timed out after ${timeoutMs}ms`
          : stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export async function runContract(
  contract: Contract,
  cwd: string,
  opts?: { todoPath?: string; trigger?: TriggerSource }
): Promise<RunResult> {
  if (!contract.verifier) {
    return {
      contract,
      passed: false,
      stdout: "",
      stderr: "no verifier defined",
      exitCode: 0,
      durationMs: 0,
    };
  }

  if (contract.verifier.kind !== "shell") {
    return {
      contract,
      passed: false,
      stdout: "",
      stderr: `verifier kind '${contract.verifier.kind}' not supported in v0.1`,
      exitCode: -1,
      durationMs: 0,
    };
  }

  const r = await runShell(contract.verifier, cwd);
  const result: RunResult = {
    contract,
    passed: r.exitCode === 0 && !r.timedOut,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
  };

  // Write to durable log if a todoPath was provided
  if (opts?.todoPath) {
    appendRun(result, opts.todoPath, opts.trigger ?? "manual");
  }

  return result;
}
