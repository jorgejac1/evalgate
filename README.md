# evalgate

> **Eval-gated todos for agentic coding.**
> Your agents can't tick the checkbox until the verifier passes.

[![MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18%2B-blue.svg)](#)
[![v0.10.1](https://img.shields.io/badge/version-v0.10.1-brightgreen.svg)](#roadmap)

---

Multi-agent coding is getting real. Claude Code subagents, Codex, Octogent,
OpenHarness — they all let you run *more* agents in parallel. The problem nobody
has solved is that **more agents means more plausible-looking output that's actually
wrong.** The completion signal today is "the agent said it was done," which scales
terribly.

`evalgate` fixes that with one primitive: **a todo item can't be flipped to `[x]`
until its attached verifier exits `0`.**

Zero runtime dependencies. Plain markdown. Plugs into any agent or CI pipeline.

---

## 30-second demo

Your `todo.md`:

```markdown
- [ ] Implement add(a, b)
  - eval: `npm run test:add`
  - retries: 2

- [ ] Implement subtract(a, b)
  - eval: `npm run test:subtract`
  - retries: 3
```

Run `evalgate check`:

```
evalgate · checking 2 contracts in todo.md

  ▸ Implement add(a, b) (implement-add) ... ✓ passed (412ms)
  ▸ Implement subtract(a, b) (implement-subtract) ... ✗ failed (exit 1, 388ms)
    │ subtract
    │   ✖ expected 2, got 8
    │   at file:///.../subtract.test.js:6:10

Summary: 1 passed, 1 failed
```

`add` flips to `[x]`. `subtract` stays `[ ]` — and the failure output is right
there for the agent to read and retry.

---

## Why this matters

Today's agent orchestrators give you more workers. `evalgate` gives those workers
a **contract**: each todo is a unit of work with a built-in quality gate. That unlocks:

- **Auto-retries with context.** The agent sees the verifier output and fixes the root
  cause instead of re-asking the human.
- **Honest progress bars.** `[x]` means the tests actually passed.
- **Safe parallelism.** Spawn 8 workers on 8 todos; only the ones that actually work
  commit their checkboxes.
- **Budget enforcement per task.** Each contract declares its token budget; `evalgate`
  tracks spend and can report overruns.
- **24/7 autonomous operation.** Trigger contracts on a schedule, file change, or
  webhook — no human needed to kick things off.

---

## Install

```bash
# Global CLI
npm install -g evalgate

# Or clone + link for development
git clone https://github.com/jorgejac1/evalgate
cd evalgate
pnpm install && pnpm build && npm link
```

## Quick start

```bash
cd examples/basic
npm install
evalgate list          # show contracts + verifiers
evalgate check         # run pending verifiers, flip checkboxes
```

---

## Contract format

Contracts live in any markdown file (convention: `todo.md`). A contract is a GFM
task-list item with indented sub-bullet fields:

```markdown
- [ ] Task title
  - eval: `shell command`
  - eval.all: `cmd1` | `cmd2`
  - eval.any: `cmd1` | `cmd2`
  - eval.llm: judge prompt as plain text
  - retries: 3
  - budget: 50k
  - id: stable-slug
  - on: schedule: "0 * * * *"
  - on: watch: "src/**/*.ts"
  - on: webhook: "/deploy-done"
```

### Field reference

| Field       | Required | Description |
| ----------- | -------- | ----------- |
| `eval`      | yes*     | Shell command. Exit 0 = pass, anything else = fail. |
| `eval.all`  | yes*     | Pipe-separated commands — **all** must exit 0. |
| `eval.any`  | yes*     | Pipe-separated commands — **any one** must exit 0. |
| `eval.llm`  | yes*     | Natural-language prompt judged by Claude. Answers PASS or FAIL. |
| `retries`   | no       | Max retry attempts hint for orchestrators. |
| `budget`    | no       | Token budget: `50k`, `1.5m`, or raw integer. |
| `id`        | no       | Stable slug for references and logs. Defaults to slugified title. |
| `provider`  | no       | Preferred model: `opus`, `sonnet`, or `haiku`. |
| `role`      | no       | Agent role hint: `coordinator`, `worker`, or `linter`. |
| `mcp`       | no       | Comma-separated list of MCP servers this contract may use. |
| `on`        | no       | Trigger: `schedule: "<cron>"`, `watch: "<glob>"`, or `webhook: "<path>"`. |

\* Exactly one `eval` variant is required for a gated contract. Items without any `eval` are **ungated** — they behave like normal checkboxes.

### Verifier variants

**Shell** — a single command:
```markdown
- [ ] Tests pass
  - eval: `npm test`
```

**Composite all** — every step must exit 0:
```markdown
- [ ] Build and lint pass
  - eval.all: `npm run build` | `npm run lint` | `npm test`
```

**Composite any** — at least one step must exit 0:
```markdown
- [ ] At least one mirror is up
  - eval.any: `curl -f https://mirror-1/health` | `curl -f https://mirror-2/health`
```

**LLM judge** — Claude evaluates the output; useful for prose, API contracts, or anything hard to assert mechanically:
```markdown
- [ ] README explains the feature clearly
  - eval.llm: Does the README at ./README.md explain the auth flow in plain English?
```

Requires `ANTHROPIC_API_KEY`. Defaults to `claude-haiku-4-5-20251001`.

### Trigger variants

```markdown
# Run on a cron schedule
- on: schedule: "*/30 * * * *"

# Re-check when source files change
- on: watch: "src/**/*.ts"

# Fire when a webhook hits the daemon
- on: webhook: "/deploy-done"
```

---

## CLI reference

| Command | Description |
| ------- | ----------- |
| `evalgate check [path]` | Run verifiers on all pending contracts. |
| `evalgate list [path]` | List all contracts with status and verifier. |
| `evalgate retry <id> [path]` | Rerun a single contract, injecting last failure as context. |
| `evalgate log [path]` | Show run history. Flags: `--contract=<id>`, `--failed`, `--limit=N`. |
| `evalgate msg send <from> <to> <kind> [payload-json] [path]` | Send a structured message between agents. |
| `evalgate msg list [path]` | List messages. Flags: `--to=<agent>`, `--kind=<kind>`. |
| `evalgate serve [cwd]` | Start the MCP server on stdio. |
| `evalgate watch [path]` | Start the trigger daemon (schedule / watch / webhook). |
| `evalgate ui [path] [--port=N]` | Launch web dashboard at `localhost:7777`. |
| `evalgate dash [path]` | ANSI terminal dashboard — live contract status. |
| `evalgate budget [path]` | Show token spend vs budget per contract. |
| `evalgate budget <id> <tokens> [path]` | Record token usage for a contract. |
| `evalgate suggest "<title>" [path]` | Find similar past completions for a new contract. |
| `evalgate patterns [path]` | Analyse failure patterns across all contracts. |
| `evalgate export [path] [--format=json\|md]` | Export full project snapshot. |
| `evalgate diff <snap1.json> <snap2.json> [--format=text\|json\|md]` | Compare two snapshots. |
| `evalgate swarm [path] [--concurrency=N] [--resume] [--agent=cmd]` | Spawn parallel agent workers. |
| `evalgate swarm status [path]` | Show last swarm run status. |

---

## Swarm Cockpit

`evalgate swarm` spawns parallel agent workers — one per pending contract — each in
its own git worktree. Workers implement their contract independently, then `evalgate`
runs the verifier in the worktree. Only workers whose verifier passes get merged back.

```bash
# Run swarm with up to 3 parallel workers (default)
evalgate swarm todo.md

# Custom concurrency
evalgate swarm todo.md --concurrency=5

# Resume a previous run (skip already-done workers)
evalgate swarm todo.md --resume

# Use a custom agent command
evalgate swarm todo.md --agent="claude --model opus"
```

Output during a swarm run:

```
evalgate swarm · todo.md · concurrency 3

  ✓ Implement add(a, b) (implement-add) done
  ✗ Implement subtract(a, b) (implement-subtract) failed
  ✓ Add TypeScript types (add-typescript-types) done

Swarm summary: 2 merged, 1 failed, 0 skipped
```

### Checking swarm status

After a run, inspect each worker's outcome:

```bash
evalgate swarm status todo.md
```

```
evalgate swarm status · swarm-a1b2c3d4 (2024-01-15 10:32:00)

✓ Implement add(a, b)  done (implement-add)
  duration: 8420ms
  verifier: passed  log: .evalgate/swarm/logs/implement-add.log

✗ Implement subtract(a, b)  failed (implement-subtract)
  duration: 12300ms
  verifier: failed  log: .evalgate/swarm/logs/implement-subtract.log
```

### Retrying a failed worker

```bash
# Retry a single failed contract (shows last failure output first)
evalgate retry implement-subtract todo.md
```

The retry command pulls the last failure output from the durable run log and
displays it before re-running the verifier, giving the agent concrete context
to fix the root cause.

---

## Web UI

```bash
# Browser dashboard at localhost:7777
evalgate ui todo.md

# Custom port
evalgate ui todo.md --port=8080
```

The web UI shows live contract status (auto-refreshing via SSE), run history,
failure output per contract, and budget gauges. It serves from Node's built-in
`http` module — no framework, no external dependencies.

---

## MCP server

`evalgate serve` exposes 15 tools over stdio MCP. Any MCP client (Claude Desktop,
Cursor, Windsurf) can invoke contracts as tools without touching the CLI.

### Add to Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "evalgate": {
      "command": "evalgate",
      "args": ["serve", "/path/to/your/project"]
    }
  }
}
```

### MCP tools

| Tool | Description |
| ---- | ----------- |
| `list_all` | All contracts with status. |
| `list_pending` | Contracts not yet passing. |
| `list_triggers` | Contracts with `on:` triggers and their next fire time. |
| `run_eval` | Run a single contract by id. |
| `check_all` | Run all pending contracts. |
| `get_retry_context` | Get last failure output formatted as a retry prompt. |
| `get_run_history` | Full run log, filterable by contract or status. |
| `get_last_failure` | Last failure details for a contract. |
| `send_message` | Send a structured agent message. |
| `list_messages` | List messages, filterable by recipient or kind. |
| `get_provider_hints` | Provider and role hints for all contracts. |
| `report_token_usage` | Record token spend for a contract. |
| `suggest_template` | Find similar past completions for a new task. |
| `get_patterns` | Failure pattern analysis across all contracts. |
| `export_state` | Full project snapshot as JSON or markdown. |

---

## Claude Code integration

Wire the provided `PostToolUse` hook to auto-check `todo.md` whenever Claude Code
edits it:

```bash
chmod +x hooks/claude-code-posttooluse.sh
```

Add to `~/.claude/settings.json` (or `.claude/settings.json` in your repo):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/hooks/claude-code-posttooluse.sh" }
        ]
      }
    ]
  }
}
```

Now whenever Claude Code edits `todo.md`, `evalgate check` runs automatically.
If a verifier fails, the hook exits `2` and Claude Code feeds the failure output
back into the agent's next turn.

---

## Triggers

Start the trigger daemon with `evalgate watch`. It handles three trigger kinds:

**Schedule** — cron expression, runs the contract verifier at the specified interval:
```markdown
- [ ] Sync exchange rates
  - eval: `node scripts/sync-rates.js`
  - on: schedule: "0 * * * *"
```

**Watch** — glob pattern, re-checks when matching files change:
```markdown
- [ ] Auth tests must pass
  - eval: `pnpm test src/auth`
  - on: watch: "src/auth/**"
```

**Webhook** — HTTP endpoint, fires when a POST hits the daemon:
```markdown
- [ ] Deploy smoke test
  - eval: `./scripts/smoke-test.sh staging`
  - on: webhook: "/deploy-done"
```

The webhook server listens on `localhost:7778` by default.

---

## Agent messaging

Agents in a multi-worker setup can exchange structured messages through evalgate's
message bus. Messages persist to `.evalgate/messages.ndjson`.

```bash
# Coordinator tells worker-2 the schema is ready
evalgate msg send coordinator worker-2 schema_ready '{"table":"users"}'

# Worker lists its inbox
evalgate msg list --to=worker-2

# Or via MCP
send_message({ from: "coordinator", to: "worker-2", kind: "schema_ready", payload: {...} })
list_messages({ to: "worker-2" })
```

Message envelopes carry `from`, `to`, `kind`, `payload`, and a `correlation_id` for
tracing request/response pairs across turns.

---

## Budget tracking

Declare a token budget on any contract. Workers report their spend; evalgate tracks
cumulative usage and warns on overrun.

```markdown
- [ ] Generate migration SQL
  - eval: `pnpm db:validate`
  - budget: 50k
  - id: gen-migration
```

```bash
# Worker reports spend after its turn
evalgate budget gen-migration 12400

# See all contracts vs budget
evalgate budget
#   gen-migration   12,400 / 50,000   24%
#   auth-refactor   61,200 / 50,000   122%  ⚠ over budget
```

The `report_token_usage` MCP tool lets agents self-report without shelling out.

---

## Terminal dashboard

```bash
# ANSI live dashboard in the terminal
evalgate dash todo.md
```

The ANSI dashboard is useful inside tmux or when you want a heads-up display without
leaving the terminal. It refreshes on every run event via the durable log.

---

## Memory and learning

evalgate indexes successful contract completions so future contracts can get a
head start:

```bash
# Find templates similar to a new task
evalgate suggest "migrate users table to Postgres"
#   85% match: migrate_products_table — passed in 1 attempt
#   72% match: migrate_orders_table   — passed in 2 attempts, retries=3

# See failure patterns across all contracts
evalgate patterns
#   Most common failure: exit 1 in test:subtract — 8 occurrences
#   Fastest to fix after failure: lint contracts — avg 1.2 retries
```

The `suggest_template` and `get_patterns` MCP tools expose the same data to agents
directly, so they can self-tune without human intervention.

---

## Persistence

All state lives in `.evalgate/` at the project root:

```
.evalgate/
  runs.ndjson           — full run history (contract id, exit code, output, duration)
  messages.ndjson       — agent message log
  budget.ndjson         — token spend per contract
  swarm-state.json      — last swarm run state
  swarm/logs/           — per-worker agent session logs
```

NDJSON format — human-readable, grep-friendly, no database required.

---

## Programmatic API

```ts
import { parseTodo, runContract, updateTodo } from "evalgate";
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("todo.md", "utf8");
const contracts = parseTodo(src);

const results = [];
for (const c of contracts.filter((c) => !c.checked && c.verifier)) {
  results.push(await runContract(c, process.cwd()));
}

writeFileSync("todo.md", updateTodo(src, results));
```

Full export surface:

```ts
// Core
import { parseTodo, runContract, runShell, updateTodo } from "evalgate";

// Persistence
import { appendRun, queryRuns, getLastFailure, getLastRun, onRun } from "evalgate";
import { sendMessage, listMessages } from "evalgate";
import { reportTokenUsage, queryBudgetRecords, getTotalTokens, getBudgetSummary } from "evalgate";

// Memory + analysis
import { suggest, detectPatterns, exportSnapshot, snapshotToMarkdown, diffSnapshots, diffToMarkdown } from "evalgate";

// Servers
import { startMcpServer, startUiServer, startWatcher, startDash } from "evalgate";

// Cron helpers
import { parseCron, matchesCron, nextFireMs } from "evalgate";
```

---

## Other integrations

### Codex / any CLI / git hooks

`evalgate check` is provider-agnostic. Wire it anywhere a shell command runs:

```bash
# post-commit hook inside a worktree
evalgate check todo.md || echo "Contracts failed — review before merging."
```

### CI (GitHub Actions)

```yaml
- name: Check evalgate contracts
  run: npx evalgate check
```

---

## Roadmap

| Version | Feature | Status |
| ------- | ------- | ------ |
| v0.1 | Parser, shell verifier, CLI (`check`, `list`), Claude Code hook | Shipped |
| v0.2 | MCP server (15 tools), `evalgate serve` | Shipped |
| v0.3 | Triggers (`schedule`, `watch`, `webhook`), `evalgate watch` | Shipped |
| v0.4 | Durable run log, structured agent messaging, `evalgate retry` | Shipped |
| v0.5 | Web UI (`evalgate ui`), ANSI dashboard (`evalgate dash`) | Shipped |
| v0.6 | Budget tracking, provider/role hints, MCP-scoped contracts | Shipped |
| v0.7 | Memory/learning (`suggest`, `patterns`), `export`, failure analysis | Shipped |
| v0.8 | Composite verifiers (`eval.all`, `eval.any`), LLM-judge (`eval.llm`), `diff`, GitHub Actions CI, Biome linter | Shipped |
| v0.9 | Swarm orchestrator — parallel workers, git worktrees, verifier-gated merge | Shipped |
| v0.10 | Export swarm/worktree/spawn APIs for orchestrator consumers, `retryWorker` with failure-context injection | Shipped |

**Up next:**
- `--watch` mode for continuous re-checking on file save
- Semantic-diff verifier kind (assert structural changes, not just exit codes)
- MCP per-contract server scoping (whitelist which servers each worker can reach)
- Vector-indexed template memory for smarter `suggest` results

---

## Prior art and positioning

- **[conductor](https://github.com/jorgejac1/conductor-agents)** — multi-agent orchestrator
  built on top of evalgate. If you want tentacle-scoped parallel workers with a web
  dashboard and CLI, use conductor. evalgate is its quality gate engine.
- **Octogent / OpenHarness** — orchestrate multiple Claude Code sessions.
  `evalgate` slots underneath them as the quality-gate layer they're missing.
- **promptfoo / braintrust** — eval LLM outputs at the prompt level.
  `evalgate` evals *agent-produced changes* at the task level.
- **Claude Code native subagents** — invisible spawning, no quality gate.
  `evalgate` contracts are plain markdown you can read, edit, and version.

```
conductor           ← orchestrator built on evalgate (tentacles, UI, retry)
    ↓
evalgate            ← primitive, no deps, quality gate layer
    ↑
Octogent            ← orchestrator, Claude Code only, no quality gate
OpenHarness         ← full harness, multi-provider
```

---

## Contributing

PRs welcome. Keep the zero-dependency constraint — it's a hard rule, not a preference.
New verifier kinds belong in `types.ts` first, then `verifier.ts`, then a test.
The parser is the most critical file; edge cases matter more than features.

### Development setup

```bash
pnpm install       # install dev deps (typescript, tsx, biome)
pnpm build         # compile TypeScript → dist/
pnpm test          # run all unit tests
pnpm typecheck     # TypeScript strict check, no emit
pnpm lint          # biome lint check (src/ and test/)
pnpm lint:fix      # auto-fix lint issues
```

A **pre-commit hook** runs `typecheck` + `lint` automatically on every commit.
If it blocks, run `pnpm lint:fix` to auto-fix, then re-stage.

### Adding a verifier kind

1. Add the interface to `src/types.ts` and union it into `Verifier`
2. Handle it in `src/parser.ts` (`buildVerifier`)
3. Handle it in `src/verifier.ts` (`runContract`)
4. Add tests in `test/parser.test.ts` and a new `test/<kind>.test.ts`
5. Export from `src/index.ts`

---

## License

MIT
