/**
 * evalgate memory + learning layer — v0.7
 *
 * Three capabilities, zero runtime dependencies:
 *   suggest()       — trigram similarity over past successful completions
 *   detectPatterns() — failure pattern analysis from run history
 *   exportSnapshot() — full project state as portable JSON
 *   snapshotToMarkdown() — render snapshot as a Markdown sprint report
 */

import { existsSync, readFileSync } from "node:fs";
import { getBudgetSummary } from "./budget.js";
import { queryRuns } from "./log.js";
import { listMessages } from "./messages.js";
import { parseTodo } from "./parser.js";
import type { Contract, RunRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Trigram similarity (Jaccard over 3-char n-grams)
// ---------------------------------------------------------------------------

function trigrams(s: string): Set<string> {
	const normalized = s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	const padded = `  ${normalized}  `;
	const result = new Set<string>();
	for (let i = 0; i < padded.length - 2; i++) {
		result.add(padded.slice(i, i + 3));
	}
	return result;
}

function similarity(a: string, b: string): number {
	const tA = trigrams(a);
	const tB = trigrams(b);
	if (tA.size === 0 && tB.size === 0) return 1;
	if (tA.size === 0 || tB.size === 0) return 0;
	let intersection = 0;
	for (const t of tA) {
		if (tB.has(t)) intersection++;
	}
	const union = tA.size + tB.size - intersection;
	return intersection / union;
}

// ---------------------------------------------------------------------------
// suggest — find similar past successful completions
// ---------------------------------------------------------------------------

export interface SuggestResult {
	contractId: string;
	contractTitle: string;
	verifier: string;
	similarity: number;
	passRate: number;
	runCount: number;
}

export function suggest(todoPath: string, query: string, limit = 5): SuggestResult[] {
	const runs = queryRuns(todoPath, { limit: 500 });

	// Build a de-duped map of contractId → best metadata from passed runs
	const seen = new Map<
		string,
		{ title: string; verifier: string; passes: number; total: number }
	>();

	for (const r of runs) {
		const entry = seen.get(r.contractId) ?? {
			title: r.contractTitle,
			verifier: "",
			passes: 0,
			total: 0,
		};
		entry.total++;
		if (r.passed) entry.passes++;
		seen.set(r.contractId, entry);
	}

	// Also pull verifier commands from current todo if available
	if (existsSync(todoPath)) {
		const contracts = parseTodo(readFileSync(todoPath, "utf8"));
		for (const c of contracts) {
			const entry = seen.get(c.id);
			if (entry && c.verifier?.kind === "shell") {
				entry.verifier = c.verifier.command;
			}
		}
	}

	// Score each past contract against the query
	const results: SuggestResult[] = [];
	for (const [id, meta] of seen) {
		if (meta.passes === 0) continue; // only suggest things that have passed
		const score = similarity(query, meta.title);
		results.push({
			contractId: id,
			contractTitle: meta.title,
			verifier: meta.verifier,
			similarity: Math.round(score * 100) / 100,
			passRate: Math.round((meta.passes / meta.total) * 100) / 100,
			runCount: meta.total,
		});
	}

	return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

// ---------------------------------------------------------------------------
// detectPatterns — failure pattern analysis
// ---------------------------------------------------------------------------

export interface FailurePattern {
	contractId: string;
	contractTitle: string;
	totalRuns: number;
	failures: number;
	passes: number;
	failureRate: number;
	/** true if contract has both passes and failures — suggests flakiness */
	flaky: boolean;
	/** Most frequent non-empty error lines from failed run outputs */
	topErrors: string[];
}

export function detectPatterns(todoPath: string): FailurePattern[] {
	const runs = queryRuns(todoPath, { limit: 1000 });

	// Group runs by contractId
	const grouped = new Map<string, RunRecord[]>();
	for (const r of runs) {
		const arr = grouped.get(r.contractId) ?? [];
		arr.push(r);
		grouped.set(r.contractId, arr);
	}

	const patterns: FailurePattern[] = [];

	for (const [id, contractRuns] of grouped) {
		const failures = contractRuns.filter((r) => !r.passed);
		const passes = contractRuns.filter((r) => r.passed);

		if (failures.length === 0) continue; // no failures, skip

		// Extract meaningful error lines from failed runs
		const errorLines: string[] = [];
		for (const r of failures) {
			const combined = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join("\n");
			const lines = combined
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 10 && /error|fail|assert|expected|throw/i.test(l));
			errorLines.push(...lines);
		}

		// Count line frequencies and take top 3
		const freq = new Map<string, number>();
		for (const l of errorLines) {
			// Truncate to 120 chars for display
			const key = l.slice(0, 120);
			freq.set(key, (freq.get(key) ?? 0) + 1);
		}
		const topErrors = [...freq.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([line]) => line);

		patterns.push({
			contractId: id,
			contractTitle: contractRuns[0].contractTitle,
			totalRuns: contractRuns.length,
			failures: failures.length,
			passes: passes.length,
			failureRate: Math.round((failures.length / contractRuns.length) * 100) / 100,
			flaky: passes.length > 0 && failures.length > 0,
			topErrors,
		});
	}

	// Most problematic first (by failure count)
	return patterns.sort((a, b) => b.failures - a.failures);
}

// ---------------------------------------------------------------------------
// exportSnapshot — full project state as portable JSON
// ---------------------------------------------------------------------------

export interface ProjectSnapshot {
	exportedAt: string;
	todoPath: string;
	version: string;
	contracts: Contract[];
	runs: RunRecord[];
	budget: ReturnType<typeof getBudgetSummary>;
	messages: ReturnType<typeof listMessages>;
	patterns: FailurePattern[];
	summary: {
		totalContracts: number;
		passedContracts: number;
		pendingContracts: number;
		totalRuns: number;
		totalPassed: number;
		totalFailed: number;
	};
}

export function exportSnapshot(todoPath: string): ProjectSnapshot {
	const contracts = existsSync(todoPath) ? parseTodo(readFileSync(todoPath, "utf8")) : [];
	const runs = queryRuns(todoPath, { limit: 200 });
	const messages = listMessages(todoPath, { limit: 100 });
	const budget = getBudgetSummary(todoPath, contracts);
	const patterns = detectPatterns(todoPath);

	const passed = contracts.filter((c) => c.checked).length;
	const pending = contracts.filter((c) => !c.checked && c.verifier).length;
	const totalPassed = runs.filter((r) => r.passed).length;
	const totalFailed = runs.filter((r) => !r.passed).length;

	return {
		exportedAt: new Date().toISOString(),
		todoPath,
		version: "0.7.0",
		contracts,
		runs,
		budget,
		messages,
		patterns,
		summary: {
			totalContracts: contracts.length,
			passedContracts: passed,
			pendingContracts: pending,
			totalRuns: runs.length,
			totalPassed,
			totalFailed,
		},
	};
}

// ---------------------------------------------------------------------------
// snapshotToMarkdown — Markdown sprint report
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// diffSnapshots — compare two project snapshots
// ---------------------------------------------------------------------------

export interface SnapshotDiff {
	from: string; // exportedAt of snapshot A
	to: string; // exportedAt of snapshot B
	contracts: {
		added: string[]; // titles of new contracts
		removed: string[]; // titles of removed contracts
		nowPassed: string[]; // were pending/failed, now passed
		nowPending: string[]; // were passed, now pending
	};
	runs: {
		added: number; // new run records since snapshot A
		passRate: { before: number; after: number };
	};
	budget: {
		contractsExceeded: string[]; // newly exceeded since snapshot A
	};
	messages: {
		added: number;
	};
}

export function diffSnapshots(a: ProjectSnapshot, b: ProjectSnapshot): SnapshotDiff {
	const aIds = new Set(a.contracts.map((c) => c.id));
	const bIds = new Set(b.contracts.map((c) => c.id));
	const aById = new Map(a.contracts.map((c) => [c.id, c]));
	const bById = new Map(b.contracts.map((c) => [c.id, c]));

	const added = b.contracts.filter((c) => !aIds.has(c.id)).map((c) => c.title);
	const removed = a.contracts.filter((c) => !bIds.has(c.id)).map((c) => c.title);

	const nowPassed: string[] = [];
	const nowPending: string[] = [];
	for (const [id, bC] of bById) {
		const aC = aById.get(id);
		if (!aC) continue;
		if (!aC.checked && bC.checked) nowPassed.push(bC.title);
		if (aC.checked && !bC.checked) nowPending.push(bC.title);
	}

	const aRunIds = new Set(a.runs.map((r) => r.id));
	const newRuns = b.runs.filter((r) => !aRunIds.has(r.id));
	const aPassRate = a.runs.length > 0 ? a.runs.filter((r) => r.passed).length / a.runs.length : 0;
	const bPassRate = b.runs.length > 0 ? b.runs.filter((r) => r.passed).length / b.runs.length : 0;

	const aExceeded = new Set(
		a.budget.filter((entry) => entry.exceeded).map((entry) => entry.contractId),
	);
	const contractsExceeded = b.budget
		.filter((bi) => bi.exceeded && !aExceeded.has(bi.contractId))
		.map((bi) => bi.contractTitle);

	const aMsgIds = new Set(a.messages.map((m) => m.id));
	const newMessages = b.messages.filter((m) => !aMsgIds.has(m.id)).length;

	return {
		from: a.exportedAt,
		to: b.exportedAt,
		contracts: { added, removed, nowPassed, nowPending },
		runs: {
			added: newRuns.length,
			passRate: {
				before: Math.round(aPassRate * 100),
				after: Math.round(bPassRate * 100),
			},
		},
		budget: { contractsExceeded },
		messages: { added: newMessages },
	};
}

export function diffToMarkdown(diff: SnapshotDiff): string {
	const lines: string[] = [];
	const push = (s = "") => {
		lines.push(s);
	};

	push(`# evalgate diff`);
	push(`> ${new Date(diff.from).toLocaleString()} → ${new Date(diff.to).toLocaleString()}`);
	push();

	push(`## Contracts`);
	if (diff.contracts.nowPassed.length > 0) {
		push(`**Newly passed:**`);
		for (const t of diff.contracts.nowPassed) push(`- ✓ ${t}`);
	}
	if (diff.contracts.nowPending.length > 0) {
		push(`**Regressed to pending:**`);
		for (const t of diff.contracts.nowPending) push(`- ○ ${t}`);
	}
	if (diff.contracts.added.length > 0) {
		push(`**Added:**`);
		for (const t of diff.contracts.added) push(`- + ${t}`);
	}
	if (diff.contracts.removed.length > 0) {
		push(`**Removed:**`);
		for (const t of diff.contracts.removed) push(`- - ${t}`);
	}
	if (
		diff.contracts.nowPassed.length === 0 &&
		diff.contracts.nowPending.length === 0 &&
		diff.contracts.added.length === 0 &&
		diff.contracts.removed.length === 0
	) {
		push(`_No contract changes._`);
	}
	push();

	push(`## Runs`);
	push(`- New runs: **${diff.runs.added}**`);
	push(`- Pass rate: ${diff.runs.passRate.before}% → **${diff.runs.passRate.after}%**`);
	push();

	if (diff.budget.contractsExceeded.length > 0) {
		push(`## Budget`);
		push(`**Newly exceeded:**`);
		for (const t of diff.budget.contractsExceeded) push(`- ⚠ ${t}`);
		push();
	}

	if (diff.messages.added > 0) {
		push(`## Messages`);
		push(`- New messages: **${diff.messages.added}**`);
		push();
	}

	return lines.join("\n");
}

export function snapshotToMarkdown(snap: ProjectSnapshot): string {
	const lines: string[] = [];
	const push = (s = "") => {
		lines.push(s);
	};

	push(`# evalgate sprint report`);
	push(`> Exported ${new Date(snap.exportedAt).toLocaleString()} · ${snap.todoPath}`);
	push();

	// Summary
	push(`## Summary`);
	push();
	push(`| | |`);
	push(`|---|---|`);
	push(`| Contracts | ${snap.summary.totalContracts} |`);
	push(`| Passed | ${snap.summary.passedContracts} ✓ |`);
	push(`| Pending | ${snap.summary.pendingContracts} |`);
	push(`| Total runs | ${snap.summary.totalRuns} |`);
	push(
		`| Pass rate | ${snap.summary.totalRuns > 0 ? Math.round((snap.summary.totalPassed / snap.summary.totalRuns) * 100) : 0}% |`,
	);
	push();

	// Contracts
	push(`## Contracts`);
	push();
	for (const c of snap.contracts) {
		const mark = c.checked ? "✓" : c.verifier ? "○" : "·";
		const verifier =
			c.verifier?.kind === "shell"
				? `\`${c.verifier.command}\``
				: c.verifier
					? "composite"
					: "_no verifier_";
		push(`- [${mark}] **${c.title}** \`(${c.id})\``);
		if (c.verifier) push(`  - eval: ${verifier}`);
		if (c.provider) push(`  - provider: ${c.provider}`);
		if (c.budget) push(`  - budget: ${c.budget.toLocaleString()} tokens`);
	}
	push();

	// Budget
	const budgeted = snap.budget.filter((b) => b.budget !== undefined || b.used > 0);
	if (budgeted.length > 0) {
		push(`## Budget`);
		push();
		push(`| Contract | Used | Budget | Status |`);
		push(`|---|---|---|---|`);
		for (const b of budgeted) {
			const status = b.exceeded ? "⚠ exceeded" : "ok";
			push(
				`| ${b.contractTitle} | ${b.used.toLocaleString()} | ${b.budget?.toLocaleString() ?? "—"} | ${status} |`,
			);
		}
		push();
	}

	// Failure patterns
	if (snap.patterns.length > 0) {
		push(`## Failure Patterns`);
		push();
		for (const p of snap.patterns) {
			const flag = p.flaky ? " _(flaky)_" : "";
			push(`### ${p.contractTitle}${flag}`);
			push(`- Runs: ${p.totalRuns} · Failures: ${p.failures} · Passes: ${p.passes}`);
			push(`- Failure rate: ${Math.round(p.failureRate * 100)}%`);
			if (p.topErrors.length > 0) {
				push(`- Top errors:`);
				for (const e of p.topErrors) {
					push(`  - \`${e}\``);
				}
			}
			push();
		}
	}

	// Recent messages
	if (snap.messages.length > 0) {
		push(`## Agent Messages`);
		push();
		push(`| Kind | From | To | When |`);
		push(`|---|---|---|---|`);
		for (const m of snap.messages.slice(0, 20)) {
			push(`| ${m.kind} | ${m.from} | ${m.to} | ${new Date(m.ts).toLocaleString()} |`);
		}
		push();
	}

	return lines.join("\n");
}
