#!/usr/bin/env bash
#
# evalgate — Claude Code PostToolUse hook
# ------------------------------------------
# Runs `evalgate check` whenever the agent edits a todo.md file.
# If any newly-flipped checkbox fails its verifier, evalgate reverts it
# and this hook exits with code 2, which Claude Code treats as a "block"
# and feeds stderr back to the agent so it can retry.
#
# ─── Environment variables ────────────────────────────────────────────────────
#
#   EVALGATE_HOOK_SILENT=1
#     Suppress blocking behavior entirely. The hook will still run
#     `evalgate check` but always exits 0 regardless of result.
#     Useful in CI pipelines or when the agent is in an auto-retry
#     loop that manages its own retry logic.
#
#   EVALGATE_HOOK_TIMEOUT=30
#     Max wall-clock seconds to allow `evalgate check` to run before
#     killing it. Defaults to 30. Set to 0 to disable the timeout.
#     Requires the `timeout` command (coreutils on Linux, gnutimeout via
#     Homebrew on macOS: `brew install coreutils`).
#
# ─── Install ──────────────────────────────────────────────────────────────────
#
#   1. Make executable:
#        chmod +x /path/to/claude-code-posttooluse.sh
#
#   2. Wire it up in a Claude Code settings file.
#      Choose ONE of:
#
#      a) Global (applies to all projects):
#           ~/.claude/settings.json
#
#      b) Project-level (checked into the repo — scopes to this project only):
#           <project-root>/.claude/settings.json
#
#      Settings JSON structure (same for both):
#
#        {
#          "hooks": {
#            "PostToolUse": [
#              {
#                "matcher": "Edit|MultiEdit|Write",
#                "hooks": [
#                  {
#                    "type": "command",
#                    "command": "/absolute/path/to/claude-code-posttooluse.sh"
#                  }
#                ]
#              }
#            ]
#          }
#        }
#
#      Tip: for project-level install, store the hook inside the repo and use
#      a path relative to $HOME or an absolute path. Claude Code resolves
#      `command` as a shell command so you can also write:
#        "command": "bash $HOME/path/to/claude-code-posttooluse.sh"
#
# ─── Requires ─────────────────────────────────────────────────────────────────
#
#   - evalgate on PATH: npm i -g evalgate
#   - jq on PATH (preferred). If absent, falls back to grep/sed.
#   - timeout command (optional, for EVALGATE_HOOK_TIMEOUT).
#     macOS: brew install coreutils   (provides `gtimeout`)
#     Linux: already available as `timeout` (coreutils)

set -u

payload="$(cat)"

# ─── Parse tool name and file path ────────────────────────────────────────────
#
# Prefer jq for correctness. Fall back to grep+sed for environments where
# jq is not installed (common in CI containers or minimal dev machines).

if command -v jq >/dev/null 2>&1; then
  tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"
  file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')"
else
  # Fallback: extract "tool_name" via grep+sed.
  # This handles simple JSON where values are on the same line as their key.
  # It is intentionally conservative — if parsing fails we exit cleanly.
  tool_name="$(printf '%s' "$payload" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  # Try file_path first, then filePath.
  file_path="$(printf '%s' "$payload" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  if [ -z "$file_path" ]; then
    file_path="$(printf '%s' "$payload" | grep -o '"filePath"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"filePath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  fi
fi

# ─── Filter: only act on todo.md edits ────────────────────────────────────────

case "$tool_name" in
  Edit|MultiEdit|Write) ;;
  *) exit 0 ;;
esac

case "$(basename "$file_path")" in
  todo.md|TODO.md) ;;
  *) exit 0 ;;
esac

# ─── Resolve working directory ─────────────────────────────────────────────────

work_dir="$(dirname "$file_path")"
cd "$work_dir" || exit 0

# ─── Check evalgate is available ────────────────────────────────────────────

if ! command -v evalgate >/dev/null 2>&1; then
  echo "evalgate hook: 'evalgate' is not on PATH — install with 'npm i -g evalgate'" >&2
  exit 0
fi

# ─── Resolve timeout wrapper ───────────────────────────────────────────────────
#
# On macOS, GNU coreutils installs `timeout` as `gtimeout`.
# On Linux, `timeout` is the standard name.
# If neither is found and a timeout is configured, we warn and run without it.

EVALGATE_HOOK_TIMEOUT="${EVALGATE_HOOK_TIMEOUT:-30}"

timeout_cmd=""
if [ "$EVALGATE_HOOK_TIMEOUT" -gt 0 ] 2>/dev/null; then
  if command -v timeout >/dev/null 2>&1; then
    timeout_cmd="timeout $EVALGATE_HOOK_TIMEOUT"
  elif command -v gtimeout >/dev/null 2>&1; then
    timeout_cmd="gtimeout $EVALGATE_HOOK_TIMEOUT"
  else
    echo "evalgate hook: EVALGATE_HOOK_TIMEOUT is set but no 'timeout'/'gtimeout' command found — running without timeout" >&2
  fi
fi

# ─── Run evalgate check ─────────────────────────────────────────────────────

todo_file="$(basename "$file_path")"

# Capture output so we can extract the failed contract id for the error message.
check_output="$($timeout_cmd evalgate check "$todo_file" 2>&1)"
check_exit="$?"

if [ "$check_exit" -eq 0 ]; then
  exit 0
fi

# ─── Silent mode: swallow the block, let the agent continue ───────────────────

if [ "${EVALGATE_HOOK_SILENT:-0}" = "1" ]; then
  exit 0
fi

# ─── Extract failed contract id(s) from evalgate output ─────────────────────
#
# evalgate prints lines like:  FAIL  <id>  — <message>
# We collect all failing ids for the error message.

failed_ids="$(printf '%s' "$check_output" | grep -o 'FAIL[[:space:]]*[^[:space:]]*' | awk '{print $2}' | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

# ─── Block the turn and surface actionable feedback ───────────────────────────
#
# Exit code 2 tells Claude Code to block the current turn and feed stderr
# back to the agent as context so it can diagnose and retry.

{
  printf '\n'
  printf '⛔ evalgate: one or more contract verifiers failed.\n'
  printf '\n'
  printf '%s\n' "$check_output"
  printf '\n'

  if [ -n "$failed_ids" ]; then
    printf 'Failed contract(s): %s\n' "$failed_ids"
    printf '\n'
    # Print a retry hint for each id.
    for id in $failed_ids; do
      printf '  → To retry manually: evalgate retry %s\n' "$id"
    done
    printf '\n'
  fi

  printf 'Fix the underlying problem, then let me know so I can re-run the check.\n'
  printf 'Do not re-check the todo until the verifier passes.\n'
  printf '\n'
  printf 'Env knobs:\n'
  printf '  EVALGATE_HOOK_SILENT=1    — suppress blocking (useful in CI)\n'
  printf '  EVALGATE_HOOK_TIMEOUT=N  — kill evalgate check after N seconds (default 30)\n'
} >&2

exit 2
