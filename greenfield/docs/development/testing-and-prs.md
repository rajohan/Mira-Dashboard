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
bun run docs:check
bun run db:check
git diff --check
```

Use focused Bun tests while iterating, then run the full affected suite before handoff. The
coverage gate requires at least 85% aggregate production line coverage, rejects executable
`src/` modules missing entirely from LCOV, and publishes the same report for Codecov's 85% patch
gate.

## TypeScript graphs

The project has exactly three TypeScript configurations in one solution:

- `tsconfig.json` owns every shared strict compiler rule. It has `files: []` and references only
  `tsconfig.browser.json` and `tsconfig.bun.json`, making it the conventional solution entry point
  for editors and `tsc -b` without claiming source files itself.
- `tsconfig.bun.json` extends the root rules and checks server, worker, repository scripts,
  non-browser tests, and non-browser test support. Its catch-all membership excludes the browser
  paths. It adds Bun and Node types with `ESNext` only, so DOM globals are unavailable.
- `tsconfig.browser.json` also extends the root rules and owns React/browser source and browser
  tests. It adds DOM/DOM iterable libraries, JSX, its narrow type declarations, and its explicit
  browser membership without exposing Bun or Node ambient types to production browser code.

There is no `tsconfig.server.json` or per-role configuration proliferation. Runtime and import
authority inside the two referenced compiler graphs is enforced by the path-aware source-boundary
policy.

Browser tests are checked by the browser graph with DOM/JSX and the narrow `bun:test` declaration.
All remaining tests are included by the Bun graph. Every `*.test.ts(x)`, `*.spec.ts(x)`,
`__tests__/`, and `testSupport/` file must therefore remain type-checked.

## Test ownership

Keep a module's tests beside that module. If one production module needs multiple concern-focused
suites, use `<module><Concern>.test.ts` rather than creating an omnibus suite.

- Put reusable executable helpers in the owning module's `testSupport/` directory.
- Put genuinely cross-domain server harnesses in `src/server/test/support/`.
- Reserve `fixtures/` for immutable payloads and reviewed evidence.
- Put cross-module contracts in `src/server/test/contracts/`.
- Put composition-root behavior in `src/server/test/system/`.
- Keep executable repository audits and tools under `scripts/`. Tests that directly verify one
  such script may remain colocated under `scripts/`; application, transport, and cross-process
  integration tests belong under the appropriate `src/test/` owner instead.

Production source must never import test or test-support code. Prefer event- or dependency-driven
test timing over arbitrary sleeps. Test-only overrides must preserve the production default and
exercise the same runtime path.

Every package test command runs through `scripts/runTestSuite.ts`. It preserves Bun's failure code
and additionally fails an otherwise green suite when output contains a React missing-`act(...)`
warning, an unconfigured React act environment warning, or a Bun panic/crash banner. Do not bypass
that runner in repository test scripts.

## Lint and boundaries

Oxlint applies its baseline strict rules to tests as well as production source. Some
production-only restrictions deliberately exclude tests—for example, tests may import
`bun:test`, fixtures, or test support—but tests are not globally ignored.

The source-boundary checker scans `src/` and `scripts/`, including test files. It rejects
repository escapes, undeclared packages, environment-authority violations, and imports that break
the reviewed process architecture.

## Pull-request evidence

Document the focused regression tests and all gates run. For visible browser behavior, include a
short manual smoke result or screenshot when a layout engine or browser API cannot be represented
faithfully by the Bun test environment. Explain any gate that could not be run.

Never commit secrets, tokens, private keys, production data, database files, or runtime state.
