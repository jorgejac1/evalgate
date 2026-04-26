/**
 * Thin wrapper around git worktree commands.
 *
 * All operations are synchronous (execSync) because they are fast filesystem
 * calls and keeping them sync makes the caller code easier to reason about.
 * Errors from git are surfaced as thrown errors with the original stderr
 * message attached.
 */

import { type ExecSyncOptions, execSync } from "node:child_process";

function git(args: string, cwd: string): string {
	try {
		return execSync(`git ${args}`, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
		} satisfies ExecSyncOptions & { encoding: "utf8" });
	} catch (err) {
		const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
		const stderr = e.stderr?.toString().trim() ?? "";
		const stdout = e.stdout?.toString().trim() ?? "";
		const detail = [stderr, stdout].filter(Boolean).join("\n") || e.message || String(err);
		throw new Error(`git ${args.split(" ")[0]} failed: ${detail}`);
	}
}

/**
 * Returns the absolute repo root for any path inside a git repo.
 * Throws if `cwd` is not inside a git repo.
 */
export function getRepoRoot(cwd: string): string {
	return git("rev-parse --show-toplevel", cwd).trim();
}

/**
 * Creates a new worktree at `worktreePath` on a new branch named `branch`.
 * The branch is created from HEAD of the repo at `repoRoot`.
 */
export function createWorktree(repoRoot: string, branch: string, worktreePath: string): void {
	// Use -B (force-reset) so that a stale branch from a paused/retried run doesn't
	// cause worktree creation to fail with "branch already exists".
	git(`worktree add "${worktreePath}" -B "${branch}"`, repoRoot);
}

/**
 * Merges `branch` into the current branch of the repo at `repoRoot`.
 * Uses --no-edit so it never opens an editor.
 *
 * Aborts any in-progress merge first — a prior failed run can leave MERGE_HEAD
 * behind, which makes git refuse to start a new merge. This is safe to call
 * inside the swarm mutex because no other worker is touching the repo at the
 * same time.
 */
export function mergeWorktree(repoRoot: string, branch: string): void {
	try {
		git("merge --abort", repoRoot);
	} catch {
		// No merge in progress — expected case, ignore.
	}
	// -X theirs: when conflicts arise, prefer the worker branch's version.
	// This is safe because inside the mutex each worker re-reads the latest
	// main-branch todo.md before committing, so the worker branch is always
	// a strict superset of what is already on main.
	git(`merge --no-edit -X theirs "${branch}"`, repoRoot);
}

/**
 * Removes the worktree at `worktreePath`. Uses --force so it works even if
 * the worktree has uncommitted changes (we keep the branch for inspection).
 * Best-effort: logs but does not throw on failure.
 */
export function removeWorktree(repoRoot: string, worktreePath: string): void {
	try {
		git(`worktree remove --force "${worktreePath}"`, repoRoot);
	} catch {
		// best-effort — the directory may already be gone
	}
}

/**
 * Force-deletes a local branch. Best-effort: does not throw on failure.
 */
export function deleteBranch(repoRoot: string, branch: string): void {
	try {
		git(`branch -D "${branch}"`, repoRoot);
	} catch {
		// best-effort
	}
}
