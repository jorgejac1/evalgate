/**
 * evalgate budget tracking — v0.6
 *
 * Append-only NDJSON log at .evalgate/budget.ndjson.
 * Agents report token usage via reportTokenUsage(). When cumulative spend
 * exceeds a contract's budget, a budget_exceeded message is sent automatically.
 * Zero runtime dependencies.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "./log.js";
import { sendMessage } from "./messages.js";
import { swarmEvents } from "./swarm.js";
import type { BudgetExceededEvent, BudgetRecord, Contract, CostEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

export function budgetPath(todoPath: string): string {
	return join(logDir(todoPath), "budget.ndjson");
}

function ensureDir(todoPath: string): void {
	const dir = logDir(todoPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Cost estimation — exported so consumers (e.g. conductor) avoid hardcoding rates
// ---------------------------------------------------------------------------

const PRICING = {
	sonnet4: { input: 3, output: 15 },
	haiku4: { input: 0.8, output: 4 },
	opus4: { input: 15, output: 75 },
} as const;

/**
 * Estimate cost in USD given token counts and optional model.
 * Defaults to Sonnet 4 rates ($3/$15 per MTok in/out).
 */
export function estimateUsd(
	inputTokens: number,
	outputTokens: number,
	model: keyof typeof PRICING = "sonnet4",
): number {
	const { input, output } = PRICING[model];
	return (inputTokens * input + outputTokens * output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function reportTokenUsage(
	todoPath: string,
	contractId: string,
	tokens: number,
	contract?: Contract,
	opts?: { inputTokens?: number; outputTokens?: number; workerId?: string },
): BudgetRecord {
	const record: BudgetRecord = {
		id: randomUUID(),
		ts: new Date().toISOString(),
		contractId,
		tokens,
		inputTokens: opts?.inputTokens,
		outputTokens: opts?.outputTokens,
		workerId: opts?.workerId,
	};

	ensureDir(todoPath);
	appendFileSync(budgetPath(todoPath), `${JSON.stringify(record)}\n`, "utf8");

	const inputTok = opts?.inputTokens ?? 0;
	const outputTok = opts?.outputTokens ?? 0;
	const estimatedUsd = estimateUsd(inputTok, outputTok);

	// Emit structured cost event (v0.12)
	swarmEvents.emit("cost", {
		type: "cost",
		workerId: opts?.workerId ?? "",
		contractId,
		tokens: { input: inputTok, output: outputTok },
		estimatedUsd,
	} satisfies CostEvent);

	// Auto-emit a budget_exceeded message and swarm event if this crosses the contract limit
	if (contract?.budget) {
		const total = getTotalTokens(todoPath, contractId);
		if (total > contract.budget) {
			sendMessage(todoPath, {
				from: "evalgate",
				to: "*",
				kind: "budget_exceeded",
				contractId,
				payload: {
					contractTitle: contract.title,
					budgetTokens: contract.budget,
					usedTokens: total,
					overBy: total - contract.budget,
				},
			});
			swarmEvents.emit("budget-exceeded", {
				type: "budget-exceeded",
				todoPath,
				contractId,
				totalTokens: total,
				estimatedUsd: estimateUsd(total, 0),
				budget: contract.budget,
			} satisfies BudgetExceededEvent);
		}
	}

	return record;
}

// ---------------------------------------------------------------------------
// Read + aggregate
// ---------------------------------------------------------------------------

export function queryBudgetRecords(todoPath: string, contractId?: string): BudgetRecord[] {
	const path = budgetPath(todoPath);
	if (!existsSync(path)) return [];

	const raw = readFileSync(path, "utf8");
	const lines = raw.split("\n").filter(Boolean);

	const records: BudgetRecord[] = [];
	for (const line of lines) {
		try {
			records.push(JSON.parse(line) as BudgetRecord);
		} catch {
			// Skip malformed lines
		}
	}

	if (contractId !== undefined) {
		return records.filter((r) => r.contractId === contractId);
	}
	return records;
}

export function getTotalTokens(todoPath: string, contractId: string): number {
	return queryBudgetRecords(todoPath, contractId).reduce((sum, r) => sum + r.tokens, 0);
}

/** Per-contract budget summary for all contracts. */
export function getBudgetSummary(
	todoPath: string,
	contracts: Contract[],
): Array<{
	contractId: string;
	contractTitle: string;
	budget: number | undefined;
	used: number;
	remaining: number | undefined;
	exceeded: boolean;
}> {
	const records = queryBudgetRecords(todoPath);

	// Sum usage per contractId
	const usageMap = new Map<string, number>();
	for (const r of records) {
		usageMap.set(r.contractId, (usageMap.get(r.contractId) ?? 0) + r.tokens);
	}

	return contracts.map((c) => {
		const used = usageMap.get(c.id) ?? 0;
		const remaining = c.budget !== undefined ? c.budget - used : undefined;
		return {
			contractId: c.id,
			contractTitle: c.title,
			budget: c.budget,
			used,
			remaining,
			exceeded: c.budget !== undefined && used > c.budget,
		};
	});
}
