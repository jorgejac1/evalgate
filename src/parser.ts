import type {
	CodeVerifier,
	Contract,
	ContractTrigger,
	DiffVerifier,
	HttpVerifier,
	LlmProvider,
	LlmVerifier,
	ShellVerifier,
	Verifier,
} from "./types.js";
import { slugify } from "./utils.js";

const CHECKBOX_RE = /^(\s*)-\s+\[([ xX])\]\s+(.*)$/;
const SUB_BULLET_RE = /^(\s+)-\s+([a-zA-Z][\w.-]*)\s*:\s*(.*)$/;

/**
 * Parse a todo.md source into a list of Contracts.
 *
 * Format:
 *   - [ ] Title of the task
 *     - eval: `shell command`
 *     - retries: 3
 *     - budget: 50k
 *     - id: optional-stable-id
 */
export function parseTodo(source: string): Contract[] {
	const lines = source.split("\n");
	const contracts: Contract[] = [];

	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(CHECKBOX_RE);
		if (!m) {
			i++;
			continue;
		}

		const [, indent, checkMark, rawTitle] = m;
		const baseIndent = indent.length;
		const title = rawTitle.trim();
		const rawLines: number[] = [i];
		const fields: Record<string, string> = {};

		let j = i + 1;
		while (j < lines.length) {
			const sub = lines[j].match(SUB_BULLET_RE);
			if (!sub) break;
			const [, subIndent, key, value] = sub;
			// Sub-bullet must be indented MORE than the checkbox line.
			if (subIndent.length <= baseIndent) break;
			fields[key.toLowerCase()] = stripBackticks(value.trim());
			rawLines.push(j);
			j++;
		}

		const checked = checkMark.toLowerCase() === "x";
		const id = fields.id || slugify(title) || `item-${i}`;

		contracts.push({
			id,
			title,
			checked,
			status: checked ? "passed" : "pending",
			verifier: buildVerifier(fields),
			retries: fields.retries ? parseInt(fields.retries, 10) : undefined,
			budget: fields.budget ? parseBudget(fields.budget) : undefined,
			trigger: buildTrigger(fields),
			provider: buildProvider(fields),
			role: buildRole(fields),
			mcpServers: buildMcpServers(fields),
			priority: fields.priority ? parseInt(fields.priority, 10) : undefined,
			retryIf: buildRetryIf(fields),
			line: i,
			rawLines,
		});

		i = j;
	}

	return contracts;
}

function buildVerifier(fields: Record<string, string>): Verifier | undefined {
	// LLM-judge verifier: eval.llm: <prompt>
	if (fields["eval.llm"]) {
		const v: LlmVerifier = { kind: "llm", prompt: fields["eval.llm"] };
		if (fields["eval.llm.provider"]) {
			v.provider = fields["eval.llm.provider"] as LlmProvider;
		}
		if (fields["eval.llm.model"]) {
			v.model = fields["eval.llm.model"];
		}
		if (fields["eval.llm.baseurl"] ?? fields["eval.llm.base_url"]) {
			v.baseUrl = fields["eval.llm.baseurl"] ?? fields["eval.llm.base_url"];
		}
		return v;
	}

	// Diff verifier: eval.diff: <file> has|lacks "<pattern>"
	if (fields["eval.diff"]) {
		const m = fields["eval.diff"].match(/^(\S+)\s+(has|lacks)\s+"([^"]+)"$/);
		if (m) {
			return { kind: "diff", file: m[1], mode: m[2] as DiffVerifier["mode"], pattern: m[3] };
		}
	}

	// HTTP verifier: eval.http: <url>
	// Optional sub-fields: eval.http.status, eval.http.contains, eval.http.timeout
	if (fields["eval.http"]) {
		const verifier: HttpVerifier = { kind: "http", url: fields["eval.http"] };
		if (fields["eval.http.status"]) {
			verifier.status = parseInt(fields["eval.http.status"], 10);
		}
		if (fields["eval.http.contains"]) {
			verifier.contains = fields["eval.http.contains"];
		}
		if (fields["eval.http.timeout"]) {
			verifier.timeoutMs = parseInt(fields["eval.http.timeout"], 10);
		}
		return verifier;
	}

	// Schema verifier: eval.schema: <file> <inline-json-schema>
	if (fields["eval.schema"]) {
		const raw = fields["eval.schema"];
		const spaceIdx = raw.indexOf(" ");
		if (spaceIdx !== -1) {
			const file = raw.slice(0, spaceIdx);
			const schema = raw.slice(spaceIdx + 1).trim();
			return { kind: "schema", file, schema };
		}
	}

	// Composite verifier: eval.all or eval.any — pipe-separated commands
	for (const mode of ["all", "any"] as const) {
		const raw = fields[`eval.${mode}`];
		if (raw) {
			const steps: ShellVerifier[] = raw
				.split("|")
				.map((s) => s.trim().replace(/`/g, "").trim())
				.filter(Boolean)
				.map((cmd) => ({ kind: "shell" as const, command: cmd }));
			if (steps.length > 0) {
				return { kind: "composite", mode, steps };
			}
		}
	}

	// Code verifier: eval.code: <js-fn-expression>
	if (fields["eval.code"]) {
		const v: CodeVerifier = { kind: "code", fn: fields["eval.code"] };
		if (fields["eval.code.file"]) {
			v.file = fields["eval.code.file"];
		}
		if (fields["eval.code.timeout"]) {
			v.timeoutMs = parseInt(fields["eval.code.timeout"], 10);
		}
		return v;
	}

	// Shell verifier: eval: <command>
	if (fields.eval) {
		return { kind: "shell", command: fields.eval };
	}

	return undefined;
}

/**
 * Parse the `on:` field into a typed ContractTrigger.
 *
 * Supported formats:
 *   - on: schedule: "0 2 * * *"
 *   - on: watch: "src/auth/**"
 *   - on: webhook: "/ci-passed"
 */
function buildTrigger(fields: Record<string, string>): ContractTrigger | undefined {
	const raw = fields.on;
	if (!raw) return undefined;

	// Try "schedule: <cron>"
	const scheduleMatch = raw.match(/^schedule:\s*["']?([^"']+)["']?$/i);
	if (scheduleMatch) {
		return { kind: "schedule", cron: scheduleMatch[1].trim() };
	}

	// Try "watch: <glob>"
	const watchMatch = raw.match(/^watch:\s*["']?([^"']+)["']?$/i);
	if (watchMatch) {
		return { kind: "watch", glob: watchMatch[1].trim() };
	}

	// Try "webhook: <path>"
	const webhookMatch = raw.match(/^webhook:\s*["']?([^"']+)["']?$/i);
	if (webhookMatch) {
		const path = webhookMatch[1].trim();
		return { kind: "webhook", path: path.startsWith("/") ? path : `/${path}` };
	}

	return undefined;
}

function buildProvider(fields: Record<string, string>): Contract["provider"] {
	const v = fields.provider?.trim().toLowerCase();
	if (v === "opus" || v === "sonnet" || v === "haiku") return v;
	return undefined;
}

function buildRole(fields: Record<string, string>): Contract["role"] {
	const v = fields.role?.trim().toLowerCase();
	if (v === "coordinator" || v === "worker" || v === "linter") return v;
	return undefined;
}

function buildMcpServers(fields: Record<string, string>): string[] | undefined {
	const v = fields.mcp?.trim();
	if (!v) return undefined;
	const servers = v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return servers.length > 0 ? servers : undefined;
}

function buildRetryIf(fields: Record<string, string>): Contract["retryIf"] {
	const raw = fields["retry-if"];
	if (!raw) return undefined;

	// Supported: exit-code <op> <n>
	// Operators: !=, ==, >, <, >=, <=
	const m = raw.match(/^exit-code\s+(!=|==|>=|<=|>|<)\s+(\d+)$/);
	if (!m) return undefined;

	type RetryIfOp = NonNullable<Contract["retryIf"]>["exitCode"]["op"];
	const op = m[1] as RetryIfOp;
	const value = parseInt(m[2], 10);
	return { exitCode: { op, value } };
}

function stripBackticks(s: string): string {
	const m = s.match(/^`(.+)`$/);
	return m ? m[1] : s;
}

function parseBudget(s: string): number {
	const m = s.trim().match(/^([\d.]+)\s*([kKmM])?$/);
	if (!m) return parseInt(s, 10) || 0;
	const n = parseFloat(m[1]);
	const suffix = (m[2] || "").toLowerCase();
	if (suffix === "k") return Math.round(n * 1_000);
	if (suffix === "m") return Math.round(n * 1_000_000);
	return Math.round(n);
}
