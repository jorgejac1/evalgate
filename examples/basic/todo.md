# Math library — agent todos

The agent is working through these items. Each one with an `eval` field
is a **contract**: the checkbox cannot be flipped to `[x]` until the
verifier passes.

- [x] Scaffold package.json and test harness
- [ ] Write scratch notes for the next session
- [x] Implement `add(a, b)`
  - eval: `npm run test:add --silent`
  - retries: 2
  - budget: 20k
- [x] Implement `subtract(a, b)`
  - eval: `npm run test:subtract --silent`
  - retries: 3
  - budget: 30k

- [x] Watch trigger test
  - eval: `echo "file changed!" && exit 0`
  - on: watch: "examples/basic/**"

- [x] Webhook trigger test
  - eval: `echo "webhook fired!" && exit 0`
  - on: webhook: "/deploy-done"

- [x] Schedule trigger test
  - eval: `echo "cron fired!"`
  - on: schedule: "* * * * *"
