import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { appendRun } from "./log.js";
import type {
	CodeVerifier,
	Contract,
	DiffVerifier,
	HttpVerifier,
	LlmProvider,
	RunResult,
	SchemaVerifier,
	ShellVerifier,
	TriggerSource,
} from "./types.js";

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
		// detached: true puts the child in its own process group so we can
		// kill the entire group (shell + its children) with process.kill(-pid).
		// Without this, SIGTERM sent to the shell on Linux orphans grandchildren.
		const child = spawn(v.command, { shell: true, cwd, detached: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});

		function killGroup(signal: NodeJS.Signals): void {
			try {
				// Negative PID kills the process group (shell + all children).
				if (child.pid !== undefined) process.kill(-child.pid, signal);
			} catch {
				// Fallback in case the group is already gone.
				try {
					child.kill(signal);
				} catch {
					/* ignore */
				}
			}
		}

		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup("SIGTERM");
			sigkillTimer = setTimeout(() => killGroup("SIGKILL"), 2_000);
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
	aggregateTimeoutMs?: number,
): Promise<RunResult> {
	const start = Date.now();
	const outputs: string[] = [];
	let passed = false;
	let timedOut = false;

	for (const baseStep of steps) {
		let step = baseStep;
		// If an aggregate timeout is set, cap each remaining step to the budget left.
		if (aggregateTimeoutMs !== undefined) {
			const elapsed = Date.now() - start;
			const remaining = aggregateTimeoutMs - elapsed;
			if (remaining <= 0) {
				timedOut = true;
				outputs.push(`[aggregate timeout] exceeded ${aggregateTimeoutMs}ms`);
				passed = false;
				break;
			}
			// Clamp the per-step timeout to the remaining aggregate budget.
			step = { ...step, timeoutMs: Math.min(step.timeoutMs ?? 120_000, remaining) };
		}

		const r = await runShell(step, cwd);
		const stepPassed = r.exitCode === 0 && !r.timedOut;
		if (r.timedOut) timedOut = true;
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
		stderr: timedOut ? `[evalgate] composite verifier timed out after ${aggregateTimeoutMs}ms` : "",
		exitCode: passed ? 0 : 1,
		durationMs: Date.now() - start,
		timedOut,
	};
}

function getDefaultModel(provider: LlmProvider): string {
	if (provider === "openai") return "gpt-4o-mini";
	if (provider === "ollama") return "llama3.2";
	return "claude-haiku-4-5-20251001";
}

async function runLlmJudge(
	contract: Contract,
	prompt: string,
	model: string,
	provider: LlmProvider = "anthropic",
	baseUrl?: string,
): Promise<RunResult> {
	const start = Date.now();
	const LLM_TIMEOUT_MS = 60_000;
	const systemPrompt = `You are a code quality judge. Answer with exactly one word: PASS or FAIL.\n\n${prompt}`;

	if (provider === "anthropic") {
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

		const body = JSON.stringify({
			model,
			max_tokens: 64,
			messages: [{ role: "user", content: systemPrompt }],
		});

		return new Promise((resolvePromise) => {
			let settled = false;
			function settle(result: RunResult): void {
				if (settled) return;
				settled = true;
				resolvePromise(result);
			}

			const req = httpsRequest(
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
								settle({
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
							settle({
								contract,
								passed,
								stdout: text,
								stderr: "",
								exitCode: passed ? 0 : 1,
								durationMs,
							});
						} catch (e) {
							settle({
								contract,
								passed: false,
								stdout: "",
								stderr: `parse error: ${e}`,
								exitCode: -1,
								durationMs: Date.now() - start,
							});
						}
					});
				},
			);

			const timeoutTimer = setTimeout(() => {
				req.destroy();
				settle({
					contract,
					passed: false,
					stdout: "",
					stderr: `[evalgate] LLM verifier timed out after ${LLM_TIMEOUT_MS}ms`,
					exitCode: -1,
					durationMs: Date.now() - start,
					timedOut: true,
				});
			}, LLM_TIMEOUT_MS);
			if (timeoutTimer.unref) timeoutTimer.unref();

			req.on("error", (e) => {
				clearTimeout(timeoutTimer);
				settle({
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

	if (provider === "openai") {
		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) {
			return {
				contract,
				passed: false,
				stdout: "",
				stderr: "OPENAI_API_KEY is not set — required for eval.llm provider:openai verifiers",
				exitCode: -1,
				durationMs: 0,
			};
		}

		const body = JSON.stringify({
			model,
			max_tokens: 64,
			messages: [{ role: "user", content: systemPrompt }],
		});

		const endpoint = new URL(`${baseUrl ?? "https://api.openai.com"}/v1/chat/completions`);
		const requestFn = endpoint.protocol === "https:" ? httpsRequest : httpRequest;

		return new Promise((resolvePromise) => {
			let settled = false;
			function settle(result: RunResult): void {
				if (settled) return;
				settled = true;
				resolvePromise(result);
			}

			const req = requestFn(
				{
					hostname: endpoint.hostname,
					path: endpoint.pathname,
					port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
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
								choices?: Array<{ message?: { content?: string } }>;
								error?: { message: string };
							};
							if (json.error) {
								settle({
									contract,
									passed: false,
									stdout: "",
									stderr: json.error.message,
									exitCode: -1,
									durationMs,
								});
								return;
							}
							const text = (json.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
							const passed = text.startsWith("PASS");
							settle({
								contract,
								passed,
								stdout: text,
								stderr: "",
								exitCode: passed ? 0 : 1,
								durationMs,
							});
						} catch (e) {
							settle({
								contract,
								passed: false,
								stdout: "",
								stderr: `parse error: ${e}`,
								exitCode: -1,
								durationMs: Date.now() - start,
							});
						}
					});
				},
			);

			const timeoutTimer = setTimeout(() => {
				req.destroy();
				settle({
					contract,
					passed: false,
					stdout: "",
					stderr: `[evalgate] LLM verifier timed out after ${LLM_TIMEOUT_MS}ms`,
					exitCode: -1,
					durationMs: Date.now() - start,
					timedOut: true,
				});
			}, LLM_TIMEOUT_MS);
			if (timeoutTimer.unref) timeoutTimer.unref();

			req.on("error", (e) => {
				clearTimeout(timeoutTimer);
				settle({
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

	// ollama
	const body = JSON.stringify({
		model,
		stream: false,
		messages: [{ role: "user", content: systemPrompt }],
	});

	const endpoint = new URL(`${baseUrl ?? "http://localhost:11434"}/api/chat`);
	const requestFn = endpoint.protocol === "https:" ? httpsRequest : httpRequest;

	return new Promise((resolvePromise) => {
		let settled = false;
		function settle(result: RunResult): void {
			if (settled) return;
			settled = true;
			resolvePromise(result);
		}

		const req = requestFn(
			{
				hostname: endpoint.hostname,
				path: endpoint.pathname,
				port: endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
				method: "POST",
				headers: {
					"Content-Type": "application/json",
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
							message?: { content?: string };
							error?: string;
						};
						if (json.error) {
							settle({
								contract,
								passed: false,
								stdout: "",
								stderr: json.error,
								exitCode: -1,
								durationMs,
							});
							return;
						}
						const text = (json.message?.content ?? "").trim().toUpperCase();
						const passed = text.startsWith("PASS");
						settle({
							contract,
							passed,
							stdout: text,
							stderr: "",
							exitCode: passed ? 0 : 1,
							durationMs,
						});
					} catch (e) {
						settle({
							contract,
							passed: false,
							stdout: "",
							stderr: `parse error: ${e}`,
							exitCode: -1,
							durationMs: Date.now() - start,
						});
					}
				});
			},
		);

		const timeoutTimer = setTimeout(() => {
			req.destroy();
			settle({
				contract,
				passed: false,
				stdout: "",
				stderr: `[evalgate] LLM verifier timed out after ${LLM_TIMEOUT_MS}ms`,
				exitCode: -1,
				durationMs: Date.now() - start,
				timedOut: true,
			});
		}, LLM_TIMEOUT_MS);
		if (timeoutTimer.unref) timeoutTimer.unref();

		req.on("error", (e) => {
			clearTimeout(timeoutTimer);
			settle({
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

async function runCode(v: CodeVerifier, cwd: string, contract: Contract): Promise<RunResult> {
	const filePath = resolve(cwd, v.file ?? "output.txt");
	const start = Date.now();
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: `eval.code: file not found: ${v.file ?? "output.txt"}`,
			exitCode: 1,
			durationMs: Date.now() - start,
		};
	}

	const timeoutMs = v.timeoutMs ?? 5_000;
	try {
		const script = new Script(`(${v.fn})(output)`);
		const result = script.runInNewContext({ output: content }, { timeout: timeoutMs });
		const passed = Boolean(result);
		return {
			contract,
			passed,
			stdout: `code verifier returned: ${String(result)}`,
			stderr: "",
			exitCode: passed ? 0 : 1,
			durationMs: Date.now() - start,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const timedOut = msg.includes("Script execution timed out");
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: timedOut
				? `[evalgate] code verifier timed out after ${timeoutMs}ms`
				: `code verifier error: ${msg}`,
			exitCode: 1,
			durationMs: Date.now() - start,
			timedOut: timedOut || undefined,
		};
	}
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

async function runHttp(v: HttpVerifier, contract: Contract): Promise<RunResult> {
	const start = Date.now();
	const expectedStatus = v.status ?? 200;
	const timeoutMs = v.timeoutMs ?? 10_000;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(v.url, { signal: controller.signal });
		clearTimeout(timer);
		const body = await res.text();
		const durationMs = Date.now() - start;

		if (res.status !== expectedStatus) {
			return {
				contract,
				passed: false,
				stdout: body,
				stderr: `expected status ${expectedStatus}, got ${res.status}`,
				exitCode: 1,
				durationMs,
			};
		}

		if (v.contains !== undefined && !body.includes(v.contains)) {
			return {
				contract,
				passed: false,
				stdout: body,
				stderr: `response body does not contain: ${v.contains}`,
				exitCode: 1,
				durationMs,
			};
		}

		return {
			contract,
			passed: true,
			stdout: body,
			stderr: "",
			exitCode: 0,
			durationMs,
		};
	} catch (err) {
		clearTimeout(timer);
		const durationMs = Date.now() - start;
		const isAbort = err instanceof Error && err.name === "AbortError";
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: isAbort
				? `[evalgate] HTTP verifier timed out after ${timeoutMs}ms`
				: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
			exitCode: 1,
			durationMs,
			timedOut: isAbort || undefined,
		};
	}
}

// ---------------------------------------------------------------------------
// Minimal zero-dep JSON schema validator (type + required + properties.type)
// ---------------------------------------------------------------------------

type JsonSchemaType = "object" | "array" | "string" | "number" | "boolean";

interface MinimalSchema {
	type?: JsonSchemaType;
	required?: string[];
	properties?: Record<string, { type?: JsonSchemaType }>;
}

function checkJsonType(value: unknown, expected: JsonSchemaType): boolean {
	switch (expected) {
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "boolean":
			return typeof value === "boolean";
	}
}

function runSchema(v: SchemaVerifier, cwd: string, contract: Contract): RunResult {
	const filePath = resolve(cwd, v.file);
	const start = Date.now();

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: `file not found: ${v.file}`,
			exitCode: 1,
			durationMs: Date.now() - start,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: `invalid JSON in file: ${v.file}`,
			exitCode: 1,
			durationMs: Date.now() - start,
		};
	}

	let schema: MinimalSchema;
	try {
		schema = JSON.parse(v.schema) as MinimalSchema;
	} catch {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: `invalid schema JSON: ${v.schema}`,
			exitCode: 1,
			durationMs: Date.now() - start,
		};
	}

	// Check top-level type
	if (schema.type !== undefined && !checkJsonType(parsed, schema.type)) {
		return {
			contract,
			passed: false,
			stdout: "",
			stderr: `expected type "${schema.type}", got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
			exitCode: 1,
			durationMs: Date.now() - start,
		};
	}

	const obj = parsed as Record<string, unknown>;

	// Check required fields
	if (schema.required !== undefined) {
		for (const key of schema.required) {
			if (!(key in obj)) {
				return {
					contract,
					passed: false,
					stdout: "",
					stderr: `missing required field: "${key}"`,
					exitCode: 1,
					durationMs: Date.now() - start,
				};
			}
		}
	}

	// Check properties types
	if (schema.properties !== undefined) {
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			if (
				propSchema.type !== undefined &&
				key in obj &&
				!checkJsonType(obj[key], propSchema.type)
			) {
				return {
					contract,
					passed: false,
					stdout: "",
					stderr: `property "${key}" expected type "${propSchema.type}", got ${Array.isArray(obj[key]) ? "array" : typeof obj[key]}`,
					exitCode: 1,
					durationMs: Date.now() - start,
				};
			}
		}
	}

	return {
		contract,
		passed: true,
		stdout: "schema validation passed",
		stderr: "",
		exitCode: 0,
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
			timedOut: r.timedOut || undefined,
		};
	} else if (contract.verifier.kind === "composite") {
		result = await runComposite(
			contract,
			cwd,
			contract.verifier.mode,
			contract.verifier.steps,
			contract.verifier.timeoutMs,
		);
	} else if (contract.verifier.kind === "llm") {
		const provider = contract.verifier.provider ?? "anthropic";
		const model = contract.verifier.model ?? getDefaultModel(provider);
		result = await runLlmJudge(
			contract,
			contract.verifier.prompt,
			model,
			provider,
			contract.verifier.baseUrl,
		);
	} else if (contract.verifier.kind === "code") {
		result = await runCode(contract.verifier, cwd, contract);
	} else if (contract.verifier.kind === "diff") {
		result = runDiff(contract.verifier, cwd, contract);
	} else if (contract.verifier.kind === "http") {
		result = await runHttp(contract.verifier, contract);
	} else if (contract.verifier.kind === "schema") {
		result = runSchema(contract.verifier, cwd, contract);
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
