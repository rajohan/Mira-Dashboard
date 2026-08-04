# Testing And PR Workflow

## Standard Gates

Root/frontend:

```bash
bun run lint
bun run format:check
bun run build:frontend
bun run build:backend
bun run test:frontend
bun run test:backend
bun run test:frontend:coverage
bun run test:backend:coverage
```

`bun run build`, `bun run test`, and `bun run test:coverage` remain aggregate
shortcuts when both applications are in scope. The explicit names make
single-surface verification unambiguous and can be run from every worktree
without changing directories.

Application and test source is type-checked strictly. `skipLibCheck` remains
enabled only because current upstream declarations from Bun Canary, DnD Kit,
TanStack devtools, and the React Compiler/Babel stack do not all pass
TypeScript 7 declaration checking. Re-run both project builds with
`--skipLibCheck false` after those packages update, and remove the setting once
the upstream declaration errors are gone; do not add library-wide declaration
shims to hide them.

`test/bunCanaryMatchers.d.ts` is a separate, deliberately narrow compatibility
declaration for Bun Canary's current `AsymmetricMatcher = any` type. It narrows
only Bun's test matcher boundary to `unknown`, so the strict unsafe-value lint
rules still protect application and test code without changing matcher runtime
behavior. Both TypeScript projects include it. When Bun 1.4 is stable, check
the released `bun-types` declaration and remove this file once asymmetric
matchers no longer return `any`; keep the unrelated DOM matcher declarations
in `test/domMatchers.d.ts`.

Every documentation change, whether docs-only or accompanying code, must run
the Markdown formatter check and validate local Markdown links:

```bash
bunx oxfmt --check "docs/**/*.md"

python3 - <<'PY'
from pathlib import Path
import re

missing = []
for path in Path("docs").rglob("*.md"):
    for target in re.findall(r"\[[^]]+\]\(([^)]+)\)", path.read_text()):
        if "://" in target or target.startswith("#"):
            continue
        local_target = target.split("#", 1)[0]
        if local_target and not (path.parent / local_target).resolve().exists():
            missing.append(f"{path}: {target}")

if missing:
    raise SystemExit("\n".join(missing))
print("All local Markdown links resolve.")
PY

git diff --check
```

## Test Architecture

Dashboard uses Bun test for both applications. Frontend behavior runs through
happy-dom and Testing Library; backend behavior uses Bun-native integration,
contract, database, and service tests. Do not add a permanent Playwright,
Cypress, screenshot, or second browser-runner suite. Use a targeted manual dev
smoke when a layout engine or browser API cannot be represented faithfully by
the existing stack.

Test files live under domain-owned directories:

- `frontend/src/test/<domain>` for app, auth, chat, contracts, delivery,
  development, Docker, files, hooks, pages, settings, shared UI, and tasks;
- `backend/test/<domain>` for auth, cache, chat, database, delivery,
  development, Docker, Gateway, HTTP, jobs, observability, and operations;
- `backend/test/routes` and `backend/test/services` for broader route/service
  characterization suites that cross more than one domain seam;
- each `support` directory for reusable fixtures and harnesses, while fixture
  payloads remain under `fixtures`.

### Greenfield Server Tests

Keep tests owned by one greenfield server module beside that module. Name a
single suite after its production module. When one production module needs
several concern-focused suites, use `<module><Concern>.test.ts`, such as
`eventPumpSubscriptionReplay.test.ts` for `eventPumpSubscription.ts`, without
recreating an omnibus test file.

- Put shared helpers and harnesses in the owning module's `testSupport/`
  directory. Production modules must never import from `testSupport/`.
- Put genuinely cross-domain test infrastructure in `src/server/test/support/`;
  keep domain-specific helpers with their owner.
- Reserve `fixtures/` for static payloads; executable builders and lifecycle
  helpers belong in `testSupport/`.
- Put contracts spanning multiple modules in `src/server/test/contracts/` and
  composition-root behavior in `src/server/test/system/`.
- Keep tests for import-safe shared modules beside them in `src/shared/` or
  `src/contracts/`; `test:server` discovers all three greenfield roots.
- Keep runtime qualification tests separate from system composition tests.

Keep mutable mock, timer, collection, and cleanup state inside a per-suite
harness factory. Keep pure builders and assertions at module scope so they are
not recreated for every suite. Prefer event- or dependency-driven test timing
over production polling delays; test-only timing overrides must preserve the
production default and still exercise the real runtime path.

Use `test:frontend:changed` or `test:backend:changed` for quick local feedback,
then run the full affected suite and coverage gate before handoff. New tests
belong in the narrowest domain directory and should not recreate a general
omnibus file.

Documentation must be considered for changes to route families, response
shapes, cache projections, database state, operational workflows, user-facing
controls, and fallback/error behavior. If none applies, state
`Docs: not needed` with a reason in the PR body.

## Coverage

Coverage is uploaded to Codecov with two flags:

- `frontend`
- `backend`

Local total coverage can differ from Codecov patch coverage. When Codecov
fails, inspect the patch coverage and missing lines instead of relying only on
the local total percentage.

Do not use ignore comments or coverage config to hide meaningful gaps. Add
targeted functional coverage.

## GitHub Checks

Workflows:

- `Dashboard checks`: frontend and backend lint/build/coverage.
- `CodeQL`: JavaScript/TypeScript security and quality analysis.

Required PR reality:

- human review may still block even when checks are green;
- CodeRabbit can be advisory and sometimes rate-limited;
- Codecov patch failures need actual coverage or reduced risky diff.

## PR Hygiene

Use `mira-2026` git identity and GitHub token. Do not use connector write tools
that may authenticate as Raymond.

When creating/editing PR bodies, write the body to a temp file and use
`--body-file`; do not pass escaped newlines inline.

Verify body formatting:

```bash
GITHUB_TOKEN="$MIRA_GITHUB_TOKEN" gh pr view <number> --json body --jq .body | sed -n l
```

Expected: line endings shown as `$`, not literal `\\n`.

Apply useful labels. Common Dashboard labels:

- `type: documentation`
- `type: bugfix`
- `type: feature`
- `type: maintenance`
- `type: security`
- `area: frontend`
- `area: backend`
- `area: ci`
- `area: docker`
- `area: auth`
- `area: openclaw`
- `area: ops`

## Production Checkout

Feature and autopilot PR work must not edit, build, or pull inside the
production checkout. Do the implementation and verification in a separate
worktree, then finish with a read-only check that production is still clean
`main`:

```bash
cd /home/ubuntu/projects/mira-dashboard/production/checkout
git status --short --branch
```

Syncing the production checkout with `git pull --ff-only` belongs in the
approved deploy workflow, not in background PR preparation.
