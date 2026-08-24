# Testing and Pull Requests

## Standard gates

Before cutover, run these commands from `greenfield/`. That directory is the self-contained
future repository root; after cutover, the same commands run from the repository root without a
compatibility wrapper or path translation:

```bash
bun run check:boundaries
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run test:coverage
bun run storybook:test
bun run storybook:build
bun run docs:check
bun run db:check
git diff --check
```

Use focused Bun tests while iterating, then run the full affected suite before handoff. The
coverage gate requires at least 85% aggregate production line coverage, rejects executable
`scripts/` or `src/` modules missing entirely from LCOV, and publishes the same report for
Codecov's 85% patch gate.

The non-browser coverage partition uses three isolated Bun worker processes. The checked-in
`.bun-test-timings.json` file is only a scheduling hint: it starts the slowest files first without
changing test discovery, assertions, coverage collection, or the 85% gate. Browser tests stay in
Bun's default per-file isolation because a shared `--no-isolate` environment can retain preload
teardown state and has triggered a native Bun panic. Browser files use the same three-worker cap,
with their own `.bun-browser-test-timings.json` scheduling hints. After adding, removing, or
materially changing tests, refresh both timing inventories before push with:

```bash
bun run setup:before-push
```

The setup stays explicit while linked worktrees are in use. They share Git's default hooks
directory, so installing a worktree-local Lefthook executable there could make every worktree's
hook depend on whichever worktree installed it last.

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

Every Bun package test command runs through `scripts/runTestSuite.ts`; the separate real-browser
Storybook command runs through `scripts/runStorybookTests.ts`. Both preserve the child failure code
and fail an otherwise green suite when output contains a forbidden React, browser, or Bun runtime
diagnostic. Do not bypass these runners in repository test scripts.

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
