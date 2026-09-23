# Agent Browser Runtime

Read `README.md` for setup, and its Architecture section before changing the interface.

The load-bearing rule is: the investigating agent chooses what to do next, while
`BrowserSession` owns browser mechanics, safety, waiting, evidence, artifacts, and cleanup.
Adapters must not call Playwright or CDP directly.

Keep browser behavior in `src/core/`. Adapters translate transports and tool shapes only.
The orchestrator that owns a session also owns the final investigation verdict.

Quality gates:

```bash
pnpm typecheck
pnpm test
pnpm build
```

On macOS, virtual-display tests open visible Chromium windows. For local checks, run only the
affected test files, or `pnpm test:headless` (skips virtual-display tests). Scenario runs through
the MCP server stay headed.
