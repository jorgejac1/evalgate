# Contributing to greenlight

Thanks for the interest. A few principles keep this project healthy.

## Scope

greenlight is a **primitive**, not a framework. The value is that it does
one small thing well and composes with everything else.

**In scope:**

- Parser improvements, edge cases, better error messages.
- New verifier kinds (`composite`, `llm-judge`, `semantic-diff`).
- Hook / integration scripts for other agents (Cursor, Windsurf, Aider, Codex).
- MCP server (v0.2).
- Trigger system (v0.3): cron, webhooks, git events.

**Out of scope:**

- A dashboard / web UI.
- An orchestrator. (Use Octogent or OpenHarness; greenlight plugs into them.)
- Anything that tries to replace Claude Code, Codex, or an MCP client.
- LLM provider abstractions.

If you're unsure, open an issue first.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Run the example end-to-end:

```bash
cd examples/basic
npm install
../../dist/cli.js check
```

## Code style

- No runtime dependencies. The whole point is that greenlight is a thin,
  trusted primitive. Dev dependencies are fine.
- TypeScript strict mode. No `any` without a comment justifying it.
- Prefer Node built-ins over packages.
- One clear idea per PR.

## Claude Code hook

The hook lives at `hooks/claude-code-posttooluse.sh`. It fires after every
`Edit`, `MultiEdit`, or `Write` tool call and runs `greenlight check` when
the edited file is a `todo.md`.

### Installing the hook

Make it executable, then reference it from a Claude Code settings file.

**Global** (`~/.claude/settings.json` — applies to every project):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-code-posttooluse.sh"
          }
        ]
      }
    ]
  }
}
```

**Project-level** (`<project-root>/.claude/settings.json` — scoped to one repo):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-code-posttooluse.sh"
          }
        ]
      }
    ]
  }
}
```

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `GREENLIGHT_HOOK_SILENT` | `0` | Set to `1` to suppress blocking. The check still runs but the hook always exits 0. Useful in CI. |
| `GREENLIGHT_HOOK_TIMEOUT` | `30` | Max seconds before the `greenlight check` call is killed. Set to `0` to disable. Requires `timeout` (Linux) or `gtimeout` (`brew install coreutils` on macOS). |

### Changing the hook

- The fallback parser (grep/sed) is intentionally conservative. If a JSON
  structure change in Claude Code's payload breaks it, adding a `jq`
  dependency in the environment is always the safer fix.
- Keep the hook POSIX-compatible. It runs in whatever shell Claude Code
  uses to invoke the command, which may not be bash on all platforms.
- Any change to the exit-code contract (0 = pass, 2 = block) must be
  documented in the hook header.

## Commits

Conventional commits are appreciated but not required. A good commit message
explains *why*, not what.
