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
import type { BudgetRecord, Contract } from "./types.js";

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
// Write
// ---------------------------------------------------------------------------

export function reportTokenUsage(
	todoPath: string,
	contractId: string,
	tokens: number,
	contract?: Contract,
): BudgetRecord {
	const record: BudgetRecord = {
		id: randomUUID(),
		ts: new Date().toISOString(),
		contractId,
		tokens,
	};

	ensureDir(todoPath);
	appendFileSync(budgetPath(todoPath), `${JSON.stringify(record)}\n`, "utf8");

	// Auto-emit a budget_exceeded message if this pushes the contract over its limit
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
