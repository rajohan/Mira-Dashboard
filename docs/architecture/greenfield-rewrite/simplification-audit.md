# Repository simplification and `node:*` compatibility audit

**Audit date:** 2026-08-21

**Runtime:** Bun 1.4.0

**Scope:** repository-root application, scripts, Storybook configuration, tests, CI, and delivery

## Result

The rewrite is the repository root. The retired `backend/`, `frontend/`, legacy test tree,
package graph, scripts, and systemd units are deleted. GitHub Actions now installs and tests only
the root package. The public package surface has ten typed entrypoints instead of 53 aliases.

Repository checks found no additional safely removable production module. Oxlint's
unused-import/local rules, three strict TypeScript graphs, exact source discovery, exact test
inventories, and the coverage source-presence gate remain the executable dead-code defenses.
Historical parity fixtures remain because the parity inventory still consumes them; they are not
runtime compatibility code.

An independent Knip 5.63.1 scan was also run with TypeScript 5.9 because Knip does not yet load the
repository's native TypeScript 7 package. Its file and export findings are not deletion evidence in
this repository: the reported files are configuration, declared test setup, exact child-process
entrypoints, generated-contract exports, or public/test-consumed symbols. The dependency finding
was actionable: the root's unused direct `@tanstack/db` declaration was removed because the exact
package is already owned transitively by `@tanstack/query-db-collection` and no repository source
imports it directly. Tooling packages reported as unused are invoked by configuration or executable
name and remain required.

One transitional helper was removed during this audit: Git-hook installation no longer discovers
or preserves a nested `greenfield/` prefix. It configures the committed root `.githooks` directly.

The ignore audit removed obsolete npm, Yarn, pnpm, Lerna, Vite SSR, and retired test-runtime
patterns. It also narrowed Oxlint and Oxfmt from `**/data/**` to `data/**`: root runtime state stays
excluded without accidentally excluding `src/browser/data/`. Enabling that source tree exposed and
fixed two lint findings and normalized the module and its test. Generated documentation and
migrations remain Oxfmt exclusions because their generators own byte-stable output; both remain
covered by their dedicated drift checks.

## `node:*` inventory and decisions

The non-test application/script/Storybook scan contains 325 compatibility-import occurrences in
156 files. Tests and test support use the same capability categories but are excluded from these
counts so fixture volume does not obscure the runtime decision.

| Module             | Occurrences | Decision and concrete capability reason                                                                                                                                                                                                                            |
| ------------------ | ----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node:path`        |         143 | Retain. Descriptor-rooted containment, normalized release/state paths, relative inventory identities, and cross-platform build/config paths need the complete stable path API; Bun has no more capable native replacement.                                         |
| `node:fs/promises` |          97 | Retain. The implementation depends on `FileHandle`, `lstat`/`realpath`, atomic rename/link, directory iteration, explicit modes, and bounded descriptor I/O. `Bun.file` is used where suitable but is not equivalent for these security and durability operations. |
| `node:fs`          |          63 | Retain. Constants such as `O_NOFOLLOW`, bigint stat types, synchronous metadata needed during configuration, and stream/descriptor interop enforce filesystem trust boundaries that `Bun.file` does not replace.                                                   |
| `node:os`          |          10 | Retain. Host metrics, identity, platform architecture, user identity, uptime, memory totals, and secure temporary roots have no equally complete Bun API.                                                                                                          |
| `node:net`         |           6 | Retain. Canonical IP validation and raw socket/proxy evidence use capabilities not replaced more safely by Bun's HTTP server API.                                                                                                                                  |
| `node:crypto`      |           2 | Retain. Constant-time byte comparison is required at security-sensitive filesystem/log boundaries; Bun's hashing APIs do not replace `timingSafeEqual`.                                                                                                            |
| `node:url`         |           2 | Retain. Storybook/Vite configuration needs standards-based file-URL conversion in tooling loaded across Bun and Vite.                                                                                                                                              |
| `node:readline`    |           1 | Retain. Break-glass password recovery requires controlled interactive TTY input with echo suppression; a generic prompt is not equivalent.                                                                                                                         |
| `node:zlib`        |           1 | Retain. Browser artifact generation requires deterministic Brotli compression and exact Brotli parameters; Bun's convenience compression APIs do not expose the same contract.                                                                                     |

No `node:child_process`, `node:cluster`, `node:inspector`, `node:module`, `node:repl`, `node:test`,
`node:vm`, `node:wasi`, or `node:worker_threads` import is present in executable non-test source.
Child processes use the reviewed Bun process boundary.

## Test simplification review

- Runner policy is unchanged: Bun, browser, and Storybook each use three duration-balanced batches
  and three workers with exact checked-in timing inventories.
- The current inventories contain 510 Bun, 193 browser, and 90 Storybook test files. Bun timings
  were regenerated after adding the command/bootstrap tests.
- Full preflight reports 89.00% aggregate production line coverage against an 85% requirement and
  rejects any executable `scripts/` or `src/` module absent from LCOV.
- No test was removed merely for duration. The reviewed slow tests exercise immutable release,
  activation, source-boundary, authentication, and real-browser contracts that are not duplicated
  by cheaper unit tests.
- The new Git-hook installer received an injected process boundary and direct coverage after the
  source-presence gate correctly rejected it as untested.

Patch coverage is also a local merge gate. It compares executable changed lines from the Git diff
with merged LCOV and requires at least 85%. GitHub uses the pull request base; local runs use
`origin/main` unless `MIRA_DASHBOARD_COVERAGE_BASE` selects a nearer stacked-PR base. Codecov remains
the independent hosted enforcement.

## Suppression and ignore audit

Every checked-in lint, type, coverage, test, formatter, and CodeQL suppression was reviewed. There
are no skipped or todo tests, production TypeScript diagnostic suppressions, coverage exclusions,
or blanket source-tree lint exclusions.

| Mechanism                        |        Retained scope | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | --------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CodeQL `file-system-race`        | 3 reviewed operations | Node/Bun expose descriptor-safe `O_NOFOLLOW` opens but not `openat`/`unlinkat`. Each remaining pathname step is paired with a held descriptor plus post-operation inode/device validation and adversarial swap tests. A fourth check/open sequence was eliminated with one descriptor-safe open. Ineffective inline `lgtm` directives were removed; analyzer false positives are reviewed with this evidence rather than hidden in source. |
| CodeQL weak SHA-1                |         1 test helper | WebSocket RFC 6455 requires SHA-1 for the public handshake accept value; it is not used for authentication, signatures, or stored secrets. The reason remains an ordinary code comment, not an analyzer directive.                                                                                                                                                                                                                         |
| Oxlint/ESLint rule directives    |        7 single lines | Framework-owned dialog semantics, WAI-ARIA composite roles, user-provided media without authored captions, one responsive focus trap, one DOM-derived React synchronization, and one HappyDOM regression probe. Each directive names one rule and explains the constraint.                                                                                                                                                                 |
| TypeScript diagnostic directives |    test fixtures only | Literal fixture strings verify that the source-boundary checker rejects these directives; one compiled negative probe is marked with `@ts-expect-error`. Production policy rejects all such directives.                                                                                                                                                                                                                                    |

The prior CodeQL missing-await suppression was removed by using an explicit request generation for
the shared in-flight identity slot. Oxlint also rejects unused disable directives, so a suppression
whose triggering condition disappears fails the normal check.

Configuration ignores are limited to generated/build/runtime ownership boundaries: dependencies,
Git/editor metadata, logs, root runtime `data/`, coverage, distribution output, and TypeScript build
metadata. Oxfmt additionally leaves generated documentation, generated migrations, and minified
assets byte-stable. Test files are excluded only from production-specific trust-direction rules;
they are still linted, formatted, typechecked, discovered exactly, and executed by their suite.
