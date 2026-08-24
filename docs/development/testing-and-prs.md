# Testing and Pull Requests

## Standard gates

Run these commands from the repository root:

```bash
bun run check
bun run test
bun run test coverage
bun run build storybook
git diff --check
```

`bun run check` combines formatting, boundaries, lint, all three TypeScript graphs, generated docs,
and database schema verification. Focused diagnosis uses `bun run check <gate>`.

Use focused tests while iterating, then run the full affected suite before handoff. `bun run test`
runs the Bun, Happy DOM, and real-browser Storybook partitions in that order. All three use the
shared exact-inventory and batching engine with their checked-in `.bun-test-timings.json`,
`.bun-browser-test-timings.json`, and `.storybook-test-timings.json` files. Discovery must match
each inventory exactly. Every partition runs three deterministic, duration-balanced batches
sequentially; each Bun or Happy DOM child uses exactly `--parallel=3`, while each Storybook child
uses exactly `--maxWorkers=3`. Every child also uses Vitest/Bun's single `--no-isolate` switch so
the selected files reuse the child runtime's global and module registry instead of rebuilding them
for every file; the next batch starts in fresh worker processes. Three batches and three workers are repository policy in
the shared batching engine, not package-script or public CLI arguments; any attempted parallelism
override fails closed.

`bun run test coverage` uses the same three-by-three batch plan and merges all nine private LCOV
reports into `coverage/lcov.info`. Storybook contributes V8 coverage hits for production browser
modules. Stories, Storybook support and configuration, tests, and test support are excluded from
the production denominator. The gate requires at least 85% aggregate production line coverage,
rejects executable `scripts/` or `src/` modules missing entirely from LCOV, and publishes the same
report for Codecov's 85% patch gate. The local merge also calculates executable changed-line
coverage from Git and requires 85%: GitHub uses the PR base, while local stacked work can set
`MIRA_DASHBOARD_COVERAGE_BASE` to the exact parent branch (otherwise `origin/main` is used).

After adding, removing, or materially changing tests, refresh all three timing inventories before
push with:

```bash
bun run test timings bun
bun run test timings browser
bun run test timings storybook
```

Run all three commands when changing shared timing behavior. Each timing inventory is staged and
replaced atomically only after its own three batches pass; a failing partition keeps its tracked
file unchanged and stops the remaining updates.

In CI, `coverage-bun`, `coverage-browser`, and `coverage-storybook` run concurrently from the same
nine-batch plan. Each job owns exactly three private LCOV reports; only `coverage-storybook`
installs Chromium. The downstream `dashboard-checks` aggregator downloads the three explicit
artifacts, proves that all nine expected reports exist exactly once with no stale LCOV input,
revalidates the Storybook production-source records, and then applies the same aggregate and patch
85% gates using the fetched PR-base history.
It alone publishes `coverage/lcov.info` to Codecov. `dashboard-static-checks` owns the non-coverage
checks, while the separate `storybook` job only verifies the static build.

## TypeScript graphs

The project has exactly four TypeScript configurations in one solution:

- `tsconfig.json` owns every shared strict compiler rule. It has `files: []` and references
  `tsconfig.browser.json`, `tsconfig.storybook.json`, and `tsconfig.bun.json`, making it the
  conventional solution entry point for editors and `tsc -b` without claiming source files
  itself.
- `tsconfig.bun.json` extends the root rules and checks server, worker, repository scripts,
  non-browser tests, and non-browser test support. Its catch-all membership excludes the browser
  paths. It adds Bun and Node types with `ESNext` only, so DOM globals are unavailable.
- `tsconfig.browser.json` also extends the root rules and owns React/browser source and browser
  tests. It adds DOM/DOM iterable libraries, JSX, its narrow type declarations, and its explicit
  browser membership without exposing Bun or Node ambient types to production browser code.
- `tsconfig.storybook.json` owns Storybook preview, manager, stories, and browser-safe story
  support. It exposes DOM and Vite client types without exposing Bun or Node ambient types.

There is no `tsconfig.server.json` or per-role configuration proliferation. Runtime and import
authority inside the three referenced compiler graphs is enforced by the path-aware source-boundary
policy.

Browser tests are checked by the browser graph with DOM/JSX and the narrow `bun:test` declaration.
All remaining tests are included by the Bun graph. Every `*.test.ts(x)`, `*.spec.ts(x)`,
`__tests__/`, `test/`, and `testSupport/` file must therefore remain type-checked.

## Test ownership

Keep a module's tests beside that module. If one production module needs multiple concern-focused
suites, use `<module><Concern>.test.ts` rather than creating an omnibus suite.

- Put reusable executable helpers in the owning module's `testSupport/` directory.
- Keep browser-wide setup and self-contained browser build fixtures under `src/browser/test/`.
- Put genuinely cross-domain server harnesses in `src/server/test/support/`.
- Reserve `fixtures/` for immutable payloads, reviewed evidence, and self-contained build inputs;
  never put reusable helper logic there.
- Put cross-module contracts in `src/server/test/contracts/`.
- Put composition-root behavior in `src/server/test/system/`.
- Keep executable repository audits and tools under `scripts/`. Tests that directly verify one
  such script may remain colocated under `scripts/`; application, transport, and cross-process
  integration tests belong under the appropriate `src/test/` owner instead.

Production source must never import test or test-support code. Prefer event- or dependency-driven
test timing over arbitrary sleeps. Test-only overrides must preserve the production default and
exercise the same runtime path.

The Bun and Happy DOM partitions run through `scripts/runBatchedTestSuite.ts`, and the real-browser
partition runs through `scripts/runStorybookTests.ts`; coverage orchestrates all three with the same
batching and output policies. Their child processes preserve the failure code and fail an otherwise
green suite when output contains a forbidden React, browser, or Bun runtime diagnostic. Do not
bypass these runners in repository test scripts.

Every suite preloads the process-private test root and mock cleanup. The browser suite additionally
preloads Happy DOM, Testing Library matchers and cleanup, the React act-environment marker, and the
Headless UI animation mock. Browser tests and their support remain in the browser TypeScript graph.
The product-shell test renders the real QueryClient, router, accessible route, and error-boundary
composition. Build tests separately exercise the actual HTML entrypoint, React Compiler, Tailwind,
code splitting, compression, CSP policy, and bundle budgets.

## Lint and boundaries

Oxlint applies its baseline strict rules to tests as well as production source. Some
production-only restrictions deliberately exclude tests—for example, tests may import
`bun:test`, fixtures, or test support—but tests are not globally ignored.

The source-boundary checker scans `.storybook/`, `src/`, and `scripts/`, including test files. It
requires the adopted Storybook configuration files and rejects repository escapes, undeclared
packages, environment-authority violations, and imports that break the reviewed process
architecture.

## Pull-request evidence

Document the focused regression tests and all gates run. For visible browser behavior, include a
short manual smoke result or screenshot when a layout engine or browser API cannot be represented
faithfully by the Bun test environment. Explain any gate that could not be run.

Never commit secrets, tokens, private keys, production data, database files, or runtime state.
