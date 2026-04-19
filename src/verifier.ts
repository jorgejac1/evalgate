import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { resolve } from "node:path";
import { appendRun } from "./log.js";
import type { Contract, DiffVerifier, RunResult, ShellVerifier, TriggerSource } from "./types.js";

interface ShellOutcome {
	stdout: string;
	stderr: string;
	exitCode: number;
	durationMs: number;
	timedOut: boolean;
}

export async function runShell(v: ShellVerifier, cwd: string): Promise<ShellOutcome> {
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

		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			sigkillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
		}, timeoutMs);

		child.on("error", (err) => {
			clearTimeout(timer);
			clearTimeout(sigkillTimer);
			resolve({
				stdout,
				stderr: `${stderr}\n[spawn error] ${err.message}`,
				exitCode: -1,
				durationMs: Date.now() - start,
				timedOut: false,
			});
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			clearTimeout(sigkillTimer);
			resolve({
				stdout,
				stderr: timedOut ? `${stderr}\n[evalgate] verifier timed out after ${timeoutMs}ms` : stderr,
				exitCode: code ?? -1,
				durationMs: Date.now() - start,
				timedOut,
			});
		});
	});
}

async function runComposite(
	contract: Contract,
	cwd: string,
	mode: "all" | "any",
	steps: ShellVerifier[],
): Promise<RunResult> {
	const start = Date.now();
	const outputs: string[] = [];
	let passed = false;

	for (const step of steps) {
		const r = await runShell(step, cwd);
		const stepPassed = r.exitCode === 0 && !r.timedOut;
		outputs.push(
			`[${step.command}] exit ${r.exitCode}\n` +
				(r.stdout.trim() ? r.stdout : "") +
				(r.stderr.trim() ? r.stderr : ""),
		);

		if (mode === "any" && stepPassed) {
			passed = true;
			break;
		}
		if (mode === "all" && !stepPassed) {
			passed = false;
			break;
		}
		passed = stepPassed;
	}

	return {
		contract,
		passed,
		stdout: outputs.join("\n---\n"),
		stderr: "",
		exitCode: passed ? 0 : 1,
		durationMs: Date.now() - start,
	};
}

async function runLlmJudge(contract: Contract, prompt: string, model: string): Promise<RunResult> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: "ANTHROPIC_API_KEY is not set — required for eval.llm verifiers",
			exitCode: -1,
			durationMs: 0,
		};
	}

	const start = Date.now();
	const body = JSON.stringify({
		model,
		max_tokens: 64,
		messages: [
			{
				role: "user",
				content: `You are a code quality judge. Answer with exactly one word: PASS or FAIL.\n\n${prompt}`,
			},
		],
	});

	return new Promise((resolve) => {
		const req = request(
			{
				hostname: "api.anthropic.com",
				path: "/v1/messages",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let raw = "";
				res.on("data", (d) => {
					raw += d;
				});
				res.on("end", () => {
					const durationMs = Date.now() - start;
					try {
						const json = JSON.parse(raw) as {
							content?: Array<{ text?: string }>;
							error?: { message: string };
						};
						if (json.error) {
							resolve({
								contract,
								passed: false,
								stdout: "",
								stderr: json.error.message,
								exitCode: -1,
								durationMs,
							});
							return;
						}
						const text = (json.content?.[0]?.text ?? "").trim().toUpperCase();
						const passed = text.startsWith("PASS");
						resolve({
							contract,
							passed,
							stdout: text,
							stderr: "",
							exitCode: passed ? 0 : 1,
							durationMs,
						});
					} catch (e) {
						resolve({
							contract,
							passed: false,
							stdout: "",
							stderr: `parse error: ${e}`,
							exitCode: -1,
							durationMs,
						});
					}
				});
			},
		);
		req.on("error", (e) => {
			resolve({
				contract,
				passed: false,
				stdout: "",
				stderr: e.message,
				exitCode: -1,
				durationMs: Date.now() - start,
			});
		});
		req.write(body);
		req.end();
	});
}

function runDiff(verifier: DiffVerifier, cwd: string, contract: Contract): RunResult {
	const filePath = resolve(cwd, verifier.file);
	const start = Date.now();
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: `file not found: ${verifier.file}`,
			exitCode: 1,
			durationMs: Date.now() - start,
		};
	}
	let regex: RegExp;
	try {
		regex = new RegExp(verifier.pattern);
	} catch {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: `invalid regex pattern: ${verifier.pattern}`,
			exitCode: 1,
			durationMs: Date.now() - start,
		};
	}
	const matches = regex.test(content);
	const passed = verifier.mode === "has" ? matches : !matches;
	const stdout =
		verifier.mode === "has"
			? passed
				? `pattern found in ${verifier.file}`
				: `pattern not found in ${verifier.file}`
			: passed
				? `pattern absent from ${verifier.file}`
				: `pattern still present in ${verifier.file}`;
	return {
		contract,
		passed,
		stdout,
		stderr: "",
		exitCode: passed ? 0 : 1,
		durationMs: Date.now() - start,
	};
}

export async function runContract(
	contract: Contract,
	cwd: string,
	opts?: { todoPath?: string; trigger?: TriggerSource },
): Promise<RunResult> {
	if (!contract.verifier) {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: "no verifier defined",
			exitCode: -1,
			durationMs: 0,
		};
	}

	let result: RunResult;

	if (contract.verifier.kind === "shell") {
		const r = await runShell(contract.verifier, cwd);
		result = {
			contract,
			passed: r.exitCode === 0 && !r.timedOut,
			stdout: r.stdout,
			stderr: r.stderr,
			exitCode: r.exitCode,
			durationMs: r.durationMs,
		};
	} else if (contract.verifier.kind === "composite") {
		result = await runComposite(contract, cwd, contract.verifier.mode, contract.verifier.steps);
	} else if (contract.verifier.kind === "llm") {
		const model = contract.verifier.model ?? "claude-haiku-4-5-20251001";
		result = await runLlmJudge(contract, contract.verifier.prompt, model);
	} else if (contract.verifier.kind === "diff") {
		result = runDiff(contract.verifier, cwd, contract);
	} else {
		result = {
			contract,
			passed: false,
			stdout: "",
			stderr: `unknown verifier kind`,
			exitCode: -1,
			durationMs: 0,
		};
	}

	if (opts?.todoPath) {
		appendRun(result, opts.todoPath, opts.trigger ?? "manual");
	}

	return result;
}
