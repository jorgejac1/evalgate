/**
 * evalgate run log — v3.0
 *
 * SQLite-backed persistent run log at .evalgate/runs.db.
 * Replaces the append-only NDJSON approach from v0.4.
 * Includes one-time migration from runs.ndjson → SQLite on first open.
 * Zero runtime dependencies beyond node:sqlite (Node 22+).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

/** Returns the .db path (previously .ndjson). Kept for backward compat. */
export function runsPath(todoPath: string): string {
	return join(logDir(todoPath), "runs.db");
}

function ndjsonPath(todoPath: string): string {
	return join(logDir(todoPath), "runs.ndjson");
}

function ensureDir(todoPath: string): void {
	const dir = logDir(todoPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// DB connection management
// ---------------------------------------------------------------------------

/**
 * Open (or reuse) a DatabaseSync for the given todoPath.
 *
 * We use a module-level map to avoid repeated schema checks on the same DB
 * within a single process. The key is the resolved .db path.
 *
 * If the DB file has been deleted or moved (e.g., git worktree cleanup),
 * the stale entry is evicted and a fresh connection is opened.
 */
const _dbs = new Map<string, DatabaseSync>();

function openFreshDb(dbPath: string, todoPath: string): DatabaseSync {
	const db = new DatabaseSync(dbPath);
	db.exec(`
		CREATE TABLE IF NOT EXISTS runs (
			id TEXT PRIMARY KEY,
			ts TEXT NOT NULL,
			contractId TEXT NOT NULL,
			contractTitle TEXT NOT NULL,
			trigger TEXT NOT NULL,
			passed INTEGER NOT NULL,
			exitCode INTEGER NOT NULL,
			durationMs INTEGER NOT NULL,
			stdout TEXT NOT NULL,
			stderr TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_runs_contractId ON runs(contractId);
		CREATE INDEX IF NOT EXISTS idx_runs_ts ON runs(ts);
	`);

	// One-time NDJSON → SQLite migration
	const njPath = ndjsonPath(todoPath);
	if (existsSync(njPath)) {
		const insert = db.prepare("INSERT OR IGNORE INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)");
		try {
			const raw = readFileSync(njPath, "utf8");
			for (const line of raw.split("\n").filter(Boolean)) {
				try {
					const r = JSON.parse(line) as RunRecord;
					insert.run(
						r.id,
						r.ts,
						r.contractId,
						r.contractTitle,
						r.trigger,
						r.passed ? 1 : 0,
						r.exitCode,
						r.durationMs,
						r.stdout,
						r.stderr,
					);
				} catch {
					/* skip malformed line */
				}
			}
		} catch {
			/* file unreadable — skip migration */
		}
		try {
			renameSync(njPath, `${njPath}.migrated`);
		} catch {
			/* best effort */
		}
	}

	return db;
}

function getDb(todoPath: string): DatabaseSync {
	const dbPath = runsPath(todoPath);
	const cached = _dbs.get(dbPath);
	if (cached) {
		// Verify the file still exists — if not, the worktree was cleaned up.
		// Evict the stale handle and open fresh.
		if (!existsSync(dbPath)) {
			_dbs.delete(dbPath);
		} else {
			return cached;
		}
	}

	ensureDir(todoPath);
	const db = openFreshDb(dbPath, todoPath);
	_dbs.set(dbPath, db);
	return db;
}

// ---------------------------------------------------------------------------
// Query options (same interface as before)
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

	const db = getDb(todoPath);
	db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)").run(
		record.id,
		record.ts,
		record.contractId,
		record.contractTitle,
		record.trigger,
		record.passed ? 1 : 0,
		record.exitCode,
		record.durationMs,
		record.stdout,
		record.stderr,
	);

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

type DbRow = {
	id: string;
	ts: string;
	contractId: string;
	contractTitle: string;
	trigger: string;
	passed: number;
	exitCode: number;
	durationMs: number;
	stdout: string;
	stderr: string;
};

export function queryRuns(todoPath: string, opts: QueryOptions = {}): RunRecord[] {
	const dbPath = runsPath(todoPath);
	// If neither .db nor legacy .ndjson exists, there are no records.
	// Otherwise call getDb() — it creates the DB and migrates NDJSON on first open.
	if (!existsSync(dbPath) && !existsSync(ndjsonPath(todoPath))) return [];

	const db = getDb(todoPath);

	const conditions: string[] = [];
	const params: (string | number)[] = [];

	if (opts.contractId !== undefined) {
		conditions.push("contractId = ?");
		params.push(opts.contractId);
	}
	if (opts.passed !== undefined) {
		conditions.push("passed = ?");
		params.push(opts.passed ? 1 : 0);
	}
	if (opts.trigger !== undefined) {
		conditions.push("trigger = ?");
		params.push(opts.trigger);
	}
	if (opts.from !== undefined) {
		conditions.push("ts >= ?");
		params.push(opts.from);
	}
	if (opts.to !== undefined) {
		conditions.push("ts <= ?");
		params.push(opts.to);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const limit = opts.limit !== undefined && opts.limit > 0 ? opts.limit : -1;
	const offset = opts.offset !== undefined && opts.offset > 0 ? opts.offset : 0;

	const limitClause =
		limit > 0 ? `LIMIT ${limit} OFFSET ${offset}` : offset > 0 ? `LIMIT -1 OFFSET ${offset}` : "";

	const sql = `SELECT * FROM runs ${where} ORDER BY ts DESC ${limitClause}`.trim();
	const rows = db.prepare(sql).all(...params) as DbRow[];

	return rows.map((row) => ({
		id: row.id,
		ts: row.ts,
		contractId: row.contractId,
		contractTitle: row.contractTitle,
		trigger: row.trigger as TriggerSource,
		passed: row.passed === 1,
		exitCode: row.exitCode,
		durationMs: row.durationMs,
		stdout: row.stdout,
		stderr: row.stderr,
	}));
}

export function getLastFailure(todoPath: string, contractId: string): RunRecord | null {
	const results = queryRuns(todoPath, { contractId, passed: false, limit: 1 });
	return results[0] ?? null;
}

export function getLastRun(todoPath: string, contractId: string): RunRecord | null {
	const results = queryRuns(todoPath, { contractId, limit: 1 });
	return results[0] ?? null;
}
