/**
 * evalgate run log — v0.4
 *
 * Append-only NDJSON log at .evalgate/runs.ndjson.
 * One RunRecord per line. Crash-safe: partial writes leave prior records intact.
 * Zero runtime dependencies.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RunRecord, RunResult, TriggerSource } from "./types.js";

// ---------------------------------------------------------------------------
// In-process SSE emitter — listeners are notified after each run is appended
// ---------------------------------------------------------------------------

type RunListener = (record: RunRecord) => void;
const _runListeners = new Set<RunListener>();

/** Subscribe to run completions. Returns an unsubscribe function. */
export function onRun(listener: RunListener): () => void {
	_runListeners.add(listener);
	return () => {
		_runListeners.delete(listener);
	};
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function logDir(todoPath: string): string {
	return join(resolve(dirname(todoPath)), ".evalgate");
}

export function runsPath(todoPath: string): string {
	return join(logDir(todoPath), "runs.ndjson");
}

function ensureDir(todoPath: string): void {
	const dir = logDir(todoPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function appendRun(
	result: RunResult,
	todoPath: string,
	trigger: TriggerSource = "manual",
): RunRecord {
	const record: RunRecord = {
		id: randomUUID(),
		ts: new Date().toISOString(),
		contractId: result.contract.id,
		contractTitle: result.contract.title,
		trigger,
		passed: result.passed,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		stdout: result.stdout,
		stderr: result.stderr,
	};

	ensureDir(todoPath);
	appendFileSync(runsPath(todoPath), `${JSON.stringify(record)}\n`, "utf8");

	// Notify in-process listeners (SSE server, dash)
	for (const fn of _runListeners) {
		try {
			fn(record);
		} catch {
			/* ignore listener errors */
		}
	}

	return record;
}

// ---------------------------------------------------------------------------
// Read + filter
// ---------------------------------------------------------------------------

export interface QueryOptions {
	contractId?: string;
	passed?: boolean;
	trigger?: TriggerSource;
	limit?: number;
	/** Skip the first N results after filtering (for pagination). */
	offset?: number;
	/** ISO 8601 date — include only records at or after this timestamp. */
	from?: string;
	/** ISO 8601 date — include only records at or before this timestamp. */
	to?: string;
}

export function queryRuns(todoPath: string, opts: QueryOptions = {}): RunRecord[] {
	const path = runsPath(todoPath);
	if (!existsSync(path)) return [];

	const raw = readFileSync(path, "utf8");
	const lines = raw.split("\n").filter(Boolean);

	const records: RunRecord[] = [];
	for (const line of lines) {
		try {
			records.push(JSON.parse(line) as RunRecord);
		} catch {
			// Skip malformed lines — append-only means this line may be a partial write
		}
	}

	let filtered = records;
	if (opts.contractId !== undefined) {
		filtered = filtered.filter((r) => r.contractId === opts.contractId);
	}
	if (opts.passed !== undefined) {
		filtered = filtered.filter((r) => r.passed === opts.passed);
	}
	if (opts.trigger !== undefined) {
		filtered = filtered.filter((r) => r.trigger === opts.trigger);
	}
	if (opts.from !== undefined) {
		const from = opts.from;
		filtered = filtered.filter((r) => r.ts >= from);
	}
	if (opts.to !== undefined) {
		const to = opts.to;
		filtered = filtered.filter((r) => r.ts <= to);
	}

	// Most recent first
	filtered.reverse();

	if (opts.offset !== undefined && opts.offset > 0) {
		filtered = filtered.slice(opts.offset);
	}
	if (opts.limit !== undefined && opts.limit > 0) {
		filtered = filtered.slice(0, opts.limit);
	}

	return filtered;
}

export function getLastFailure(todoPath: string, contractId: string): RunRecord | null {
	const results = queryRuns(todoPath, { contractId, passed: false, limit: 1 });
	return results[0] ?? null;
}

export function getLastRun(todoPath: string, contractId: string): RunRecord | null {
	const results = queryRuns(todoPath, { contractId, limit: 1 });
	return results[0] ?? null;
}
