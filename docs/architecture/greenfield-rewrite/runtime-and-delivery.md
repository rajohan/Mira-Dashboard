# Greenfield Rewrite Runtime and Delivery

[Back to the blueprint map](../greenfield-rewrite.md)

## Bun 1.4 Runtime Baseline

### Audited qualification state

| Item                               | Verified value                             |
| ---------------------------------- | ------------------------------------------ |
| Repository channel                 | `1.4.0`                                    |
| Required runtime version           | `1.4.0`                                    |
| Running production release runtime | `1.4.0-canary.1+e82022145`                 |
| Audited qualification candidate    | `1.4.0-canary.1+17d684360`                 |
| Audited full revision              | `17d6843606d76620cb55d31424d7fb0aed51c367` |
| Audited commit date                | 2026-08-06 00:27:30 UTC                    |

The audited canary revision remains historical evidence for the original qualification round.
Normal CI now installs stable `1.4.0` and runs the complete gate set. Release creation captures
the resolved stable revision in the immutable release manifest, preserving exact deployment
identity without custom Bun download or mirroring infrastructure.

### What Bun 1.4 changes

Bun 1.4 is the Rust rewrite. Bun describes it as a mechanical port that keeps the existing
architecture and feature set, with stability, memory, size, and performance improvements. It
is not a reason to assume undocumented framework features exist.

Changes after the currently installed revision include relevant fixes for:

- `Bun.serve` lifetime and shutdown safety;
- WebSocket request retention and close dispatch;
- Fetch/body streaming and backpressure;
- `bun:sqlite` graceful close, outstanding statement finalization, and query caching;
- `bun test` event-loop and isolated fake-timer cleanup;
- React Compiler code generation; and
- experimental directory routes in `Bun.serve`.

The rewrite now qualifies the pinned stable release. The directory-route feature is not an
architectural dependency: compiled frontend assets may use
the Bun HTML pipeline, but workspace files and media retain explicit, policy-checked handlers.

### Mandatory runtime qualification

Before promoting a new repository baseline, run the following in an isolated, memory-capped
environment against the exact candidate binary:

1. Fetch-adapter query and mutation tests, including cookies, aborts, response headers, and
   typed errors.
2. SSE subscription tests for reconnect, `Last-Event-ID`, `tracked()` IDs, cancellation,
   proxy/TLS behavior, backpressure, and a rolling server restart.
3. Native Gateway WebSocket tests for headers, close/error behavior, fragmented messages,
   backpressure, and reconnect.
4. SQLite tests for WAL concurrency across web and worker, busy timeouts, nested
   transactions, prepared-statement disposal, backup, restore, and process termination.
5. Frontend build tests for HTML imports, Tailwind, React Compiler, lazy chunks, CSP, source
   maps, cache hashes, precompression, and bundle budgets.
6. Same-process Bun tests for fake timers, leaked handles, deterministic shutdown, and
   bounded concurrency, with explicit teardown after every test.

The historical 2026-08-06 Phase 0 qualification round passed on exact revision
`17d6843606d76620cb55d31424d7fb0aed51c367`: its then-current dedicated typecheck and full evidence
suite reported 151 tests, 758 assertions, and zero failures across 31 files. Most retained
mechanism evidence now lives in the normal test and audit structure rather than a top-level
qualification tree. It includes:

- compiler-first Bun HTML AOT output with Tailwind, lazy chunks, fail-closed inline-code and
  URL-bearing-attribute CSP checks, hashes, precompression, no production source maps, and
  enforced bundle budgets;
- Fetch/tRPC/SSE cancellation, resume, proxy, rolling-restart, and slow-consumer behavior;
- raw RFC 6455 continuation reassembly with a UTF-8 code point split across frames, protocol-close
  `1002`, application-bound `1009`, a 64 KiB limit, deterministic close, and exactly one connection
  attempt without reconnect;
- WAL SQLite with separate web and worker processes, actual busy/locked behavior, durable outbox
  delivery and lease recovery, statement disposal, checkpoint, backup, restore, and integrity;
- a two-generation shutdown with readiness withdrawal, SSE and Gateway closure, statement and
  database disposal, bounded non-cooperative stream cancellation, worker-lease recovery,
  child-process-group cleanup, WAL recovery, and no leaked process; and
- source-derived parity for 156 current HTTP operations plus `/ws`, together with 23 hash-pinned,
  redacted OpenClaw protocol and Control UI audit artifacts.

The exact-pinned TanStack DB adapter result and the 150 ms chat-delta batching result are historical
candidate evidence only; their Phase 0 spikes and provisional dependencies were deliberately not
retained as product code. The browser data layer and chat implementation slices must qualify those
behaviors again against their real production implementations before relying on either decision.

The candidate intentionally makes `server.stop(false)` wait for idle keep-alive connections. The
shutdown qualification therefore uses an Effect-scoped graceful-stop fiber with a bounded wait and
a separately bounded `server.stop(true)` escalation. The exact candidate records
`listener-force-stopped`, then closes SSE and every owned resource without a leak; the event model
permits exactly one graceful or forced terminal outcome.

The candidate resource checks also pass without `high`, `max`, `oom`, or `oom_kill` memory
events, memory pressure, or leaked process, unit, or temporary state. The dated
[Phase 0 progress record](progress.md#2026-08-06--phase-0-evidence-and-qualification-closed)
owns the authoritative resource measurements.

These measurements qualify the mechanisms and current limits; Phase 6 still owns final
production-shaped load, restore, and cutover evidence.

`.bun-version` and the greenfield GitHub jobs select stable `1.4.0`. The serving process enforces
that version, while the exact runtime revision remains diagnostic until release creation records
it as part of the immutable build identity. `bun-types` is pinned to the matching stable `1.4.0`
declarations.

### Server and build shape

`Bun.serve` remains the actual web server. tRPC is a router and protocol inside its Fetch
handler, not a second backend process:

```ts
const server = Bun.serve({
    routes: {
        "/api/health/live": liveResponse,
        "/api/health/ready": () => readinessResponse(),
    },
    async fetch(request) {
        const pathname = new URL(request.url).pathname;

        if (pathname.startsWith("/trpc")) {
            return fetchRequestHandler({
                endpoint: "/trpc",
                req: request,
                router: appRouter,
                createContext,
            });
        }

        return handleRegisteredRawRouteOrFrontend(request);
    },
});
```

Phase 0 selects Bun's HTML entrypoint with an ahead-of-time production build. The production
devtools stub runs first when present, React Compiler then runs before Tailwind, and no runtime
full-stack development server is part of delivery. The executable fixture and actual frontend
build prove lazy chunks, CSP-compatible external assets, content hashes, absent production source
maps, precompressed variants, and bundle budgets. There is no production fallback or duplicate
build path: releases contain prebuilt assets and production never compiles the frontend on request.

## Configuration From Scratch

The greenfield web configuration parser accepts only its registered-key projection. The web and
worker composition roots invoke their role-specific parser exactly once. App, server, and worker
source has no scattered
runtime-environment reads and no truthy-string parsing. Repository scripts are greenfield-owned
tools checked by the Bun graph and source-boundary policy; they do not import code outside the
self-contained future root.
Every registered field declares:

- name, type, allowed values, and default;
- required process (`web`, `worker`, build, or script);
- whether it is secret;
- whether it is safe to expose as presence-only metadata;
- operational effect and restart requirement; and
- development/test override policy.

Use separate typed objects for immutable environment/infrastructure configuration, editable
non-secret settings, and encrypted secrets. A setting is not duplicated across environment and
database with implicit precedence. If bootstrap requires a temporary precedence rule, it is
explicitly modeled as a bootstrap state and disappears after completion.

Each process composition resolves the configured project root to a real path before deriving and
opening managed production paths. The parser's project-root field remains a lexically normalized
absolute value so parsing itself performs no host I/O; the composition boundary owns the stronger
filesystem identity and containment checks.

The target repository has exactly three TypeScript configuration files. `tsconfig.json` owns all
shared strict compiler options, has `files: []`, and references only `tsconfig.browser.json` and
`tsconfig.bun.json`. Both child configurations extend it. The Bun child adds `ESNext`, Bun/Node
types, catch-all membership, and browser-path exclusions for server, worker, scripts, and
non-browser tests. The browser child adds DOM/DOM iterable libraries, JSX, narrow type declarations,
and explicit browser source/test membership. There is no server-specific configuration or
per-role configuration proliferation. The two child graphs are checked independently; the root
solution checks both together, while the path-aware boundary gate owns finer runtime/import
authority. Adding an unclassified composition root or forbidden edge fails that gate.
`bunfig.toml` contains only shared Bun test and selected serve-plugin configuration; operational
policy lives in typed source, not hidden shell environment.

### Source-development parity profile

The ordinary source-watched web and worker keep the exact production route, procedure, cache,
Service Action, Job-action, and schedule inventories. One runtime adapter supplies representative
contract-valid database, Docker, Delivery, backup, Git, quota, and weather state through the same
worker cache executors. Accepted mutations remain normal durable Jobs and settle through normal UI
results, but their only effect is a sanitized receipt beneath the exact owner-marked development
root. Source conflicts and unknown outcomes therefore remain testable without retaining provider,
Docker-daemon, GitHub, PostgreSQL, systemd, production-Git, or production-path authority.

The fixed Docker broker may run in ordinary development only when backed by those simulated
operations. Managed PR previews do not compose the adapter or broker and continue to advertise only
the manifest-bound worker smoke action. The machine-verifiable runtime authority bundle requires
exact production/development action and schedule equality and an explicit `isolated`, `live-read`,
or `simulated` disposition for every production capability.

## Generated Documentation

Documentation generation is a product feature and a CI invariant, not an optional wiki task.

### Sources of truth

| Source                          | Generated facts                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Procedure registry              | tRPC names, kinds, auth/capabilities, input/output schemas, errors, examples, emitted events |
| Raw HTTP registry               | methods, paths, auth, content types, range/stream behavior, status codes                     |
| Event registry                  | topic, event type, entity/operation, payload schema, retention, snapshot/resync procedure    |
| Application config registry     | environment/settings names, types, defaults, secret flags, process ownership                 |
| Drizzle schema                  | intended tables, columns, types, relations, constraints, and declared indexes                |
| Applied temporary SQLite schema | tables, columns, checks, foreign keys, indexes, partial predicates                           |
| Browser route registry          | URL, navigation label, feature owner, query/search schema, required procedures               |
| Lockfile and Bun policy         | exact direct versions, selected channel/version, build identity                              |

The database generator compares Drizzle's declared schema with a temporary SQLite database
created by applying every tracked migration, then inspects `sqlite_schema`,
`PRAGMA table_xinfo`, `foreign_key_list`, `index_list`, and `index_xinfo`. It does not attempt
to parse SQL with regular expressions.

### Generated outputs

The following is the **target** artifact set. The current generator emits the procedure, raw HTTP,
realtime, configuration, browser route/feature, package/runtime, and transport-schema references.
The checked-in `docs/generated/README.md` lists the database and OpenAPI references still required
before cutover.

```text
docs/generated/
  procedures.md
  raw-http.md
  realtime-events.md
  database.md
  configuration.md
  routes-and-features.md
  packages-and-runtime.md
  schemas/*.schema.json
  openapi.raw-http.json
```

`@valibot/to-json-schema` generates JSON Schema for transport-compatible Valibot schemas. Plain-JSON
storage and journal schemas fail generation with a useful location when they contain an
unrepresentable transform or non-JSON type. A tRPC contract that deliberately uses a richer
SuperJSON type must declare an explicit documentation/wire representation; generation fails when
that representation is absent. OpenAPI 3.1 documents only true raw HTTP endpoints; it must not
pretend the tRPC wire format is a conventional REST API. The tRPC `AppRouter` type remains the
client contract.

A later `/docs` frontend slice will render the checked-in generated artifacts with navigation and
search. Rendering must use the Markdown/sanitization boundary and never read source files or
secrets from production. The current immutable release already carries the generated artifacts;
adding their browser route remains part of full UI parity rather than the delivery foundation.

### Generation commands and checks

```text
bun run generate docs  # write deterministic generated files
bun run check docs     # generate in a temporary directory and compare
```

CI fails when:

- a registered procedure, route, event, config field, table, or browser route lacks required
  descriptive metadata;
- generated output differs from the tracked files;
- examples no longer validate;
- a referenced capability or event does not exist;
- a browser route references an undocumented procedure; or
- a secret field is marked browser-visible.

Architecture decisions, threat models, rationale, and operational runbooks remain handwritten.
Only facts that can be derived reliably are generated.

## Observability and Operations

Every request, job, Gateway call, and domain transaction receives a correlation ID. Structured
logs use stable event names and include release identity, process role, duration, outcome, and
safe identifiers. They do not serialize arbitrary request bodies or command environments.

The production web runtime requires one process logger, installs it as the only Effect
logger in the application scope, and reuses that exact instance at ordinary HTTP/tRPC boundaries.
The Dashboard composition root coordinates that application `ManagedRuntime` with a separate,
retained database `ManagedRuntime`. The database-backed realtime layer and all repositories receive
the same SQLite/Drizzle service through narrow ports. After the listener settles, the application
scope finalizes realtime and authentication work before the database scope performs its passive
checkpoint and strict close; the synchronous log sink flushes last. Its serializer emits bounded
NDJSON from event-specific allowlisted fields, and a sink failure emits one constant direct-stderr
fallback without recursive logging. The executable web and worker composition roots own creation
of the project-file sink, release/config identity, and startup/shutdown events. Their production
units bind both stdout and stderr, including the direct-stderr fallback, to files beneath
`<project-root>/production/state/logs`; default journald persistence, `LogsDirectory=`, and a
configurable external log root are forbidden. Transient job units route their streams beneath
`<project-root>/production/state/job-output` instead.

Expose distinct probes:

- **live:** the process event loop can answer;
- **ready:** configuration is valid, schema is current, required database access works, and the
  process can perform its role;
- **diagnostics:** authenticated, detailed dependency and queue status for the Dashboard UI;
- **metrics:** authenticated or loopback-scoped machine-readable counters and gauges.

Minimum operational signals include:

- request latency/error counts by procedure or raw route;
- SQLite busy time, WAL size, checkpoint progress, backup age, migration identity, and query
  latency groups;
- SSE subscribers, reconnects, cursor lag, outbox rows/age, forced resyncs, buffer depth, and
  slow-consumer disconnects;
- Gateway state, reconnect attempts, request latency, unmatched events, and chat journal rates;
- queued/running/expired/cancelled jobs, lease age, resource class, worker heartbeat, and child
  resource exits;
- incidents by state/severity, notification insert conflicts, and monitor completeness;
- cache freshness/failure streaks and external provider latency; and
- release/Bun/package identity and rollback readiness.

The Dashboard displays the last known good operational data with a freshness marker when a
refresh fails. It never converts a dependency outage into an empty healthy-looking screen.

The implemented Database page applies this operational model without adding a privileged request
path. One worker refresh produces the bounded PostgreSQL/PgBouncer snapshot and persists it through
the existing claim-fenced cache protocol; refresh work is not repeated per browser request.
Dashboard SQLite lifecycle facts come from the already-retained process database runtime and are
joined with that cached external projection by `database.overview`. Collection is sequential or
low-concurrency, abortable, deadline-bound, and constrained by a database-specific 128 KiB payload
limit beneath the generic 256 KiB cache ceiling, plus contract row limits. Missing or failed external data remains explicitly unavailable
or last-known-good. The `/database` route is lazy and session-gated, retains validated data during
background failure, and offers no mutation controls. Backup/restore and Kopia/WAL-G operations are
not enabled by this observability composition. The read-only SQLite inventory composes scheduled
and activation/cutover snapshots only. The activation snapshot is the reviewed greenfield
consolidation of legacy pre-deploy and pre-migration recovery purposes, not an import of those old
artifact kinds. A scheduled snapshot is not published until a separate temporary copy passes
SQLite integrity and migration checks; crash-left staging/verification directories are reconciled
under the exclusive maintenance job. Fourteen scheduled snapshots are retained. The deployment
lease enforces cutover retention on every committed/recovered/same-candidate success: at most five
snapshots, at most two days for unreferenced snapshots, and unconditional preservation of current,
previous, and active-journal identities. Both namespaces use parent-descriptor atomic `.retire-*`
rename plus fsync before bounded resumable descriptor-anchored reaping under the trusted same-UID
deployment lease, so a crash never requires mutating or recursively deleting a published immutable
snapshot in place.
Before either snapshot path writes, capacity uses `page_count * page_size` under the validated
SQLite connection. Scheduled maintenance budgets the simultaneously resident VACUUM snapshot and
restore-verification copy; activation budgets possible checkpoint expansion plus its VACUUM
snapshot before issuing the truncate checkpoint. Both retain the fixed free-space reserve and a
post-snapshot restore-copy recheck.

Database-observability provisioning is a separate fail-closed delivery step. It creates one
dedicated monitoring login with zero role memberships and grants PgBouncer `stats_users` without
admin authority. An isolated `NOLOGIN` capability owner holds exactly direct
`pg_read_all_stats` membership plus direct per-database `SELECT` on
`pg_catalog.pg_statistic`. The observer receives only direct database `CONNECT`, private-schema
`USAGE`, and `EXECUTE` on the exact no-input, bounded `connection_metrics()`, identity-free
`statement_metrics()`, `table_health()`, and `maintenance_metrics()` functions. `PUBLIC` and the
observer have no raw `pg_stat_statements` source-view or extension-routine access. Database names
are not release inventory: each
refresh derives the bounded, sorted set from `pg_catalog.pg_database`, and generic per-database
policy checks admit detail reads. The existing hourly
`cache.refresh.database-observability` job composes a separate privileged collection-lease port
only when the provider is configured. Administrative psql authority never enters Dashboard
configuration or the collector. Between attempts the observer is `NOLOGIN`, has expired
`VALID UNTIL`, and has zero PostgreSQL sessions. The fixed attempt closes leftovers; invokes
`open-approved-collection` to verify approval and identity, perform the full bounded idempotent
ACL-and-capability reconcile, retain `NOLOGIN`, and prepare a one-use token bound to the exact
catalog digest; `enable-approved-collection` then rechecks approval, identity, policy, and digest
before atomically consuming the token and setting `LOGIN` plus a short `VALID UNTIL`;
collects once; and invokes a shielded
mandatory close that restores and proves the exact closed state. The port returns a fresh payload
only after close proof, so the generic cache executor commits afterward. Any open, collection, or
close failure instead preserves last-known-good and settles as a retryable redacted failure without
a fresh commit.

Explicit activation alone creates or refreshes the approval marker bound to the PostgreSQL
`system_identifier` and the exact current and previous immutable-release policy digests; the policy
version alone is not authorization, and lease operations cannot mutate the approval. Every open
checks that binding and performs and verifies the full bounded, idempotent reconcile before the
separate one-use enable; no persisted
fingerprint, verification-age state, or reduced path is used. Reconciliation removes `PUBLIC`
database privileges, grants direct observer `CONNECT` only to non-template connectable databases,
applies and verifies every sanitized capability, and rejects catalog, policy-digest, or endpoint
races. No additional action,
schedule, loop, sidecar, systemd unit, function-executor login, credential, or exclusive admission
is introduced. Adding, removing, or renaming a database therefore requires no Dashboard source,
manifest, or configuration edit. A new database is reconciled by the next approved open before
that attempt collects it; the pass removes unsafe database authority, grants the exact observer
ACL, and installs the verified interfaces.
After the manual first-install prerequisites, explicit `activate-current-catalog --approved` must
be the first runner operation because `verify-current-catalog --approved` requires an existing
matching approval. Activation finishes closed; verification then proves the approved state. On a
later release, verification may precede activation only when the retained current or previous
policy digest already approves that release. Otherwise activation must run first.
PostgreSQL close proof cannot prove that PgBouncer has no already-authenticated waiting client; a
waiting client that interferes causes a failed attempt, while `NOLOGIN`, expiry, and termination
prevent it from obtaining a new backend after close. The observer password is the sole Dashboard
credential input. On every snapshot
attempt the worker runs bounded `docker ps -a` followed by one batched, fixed-template
`docker inspect`, then requires exactly one running, healthy container with
the explicit `mira.dashboard.database-observability=pgbouncer-v1` capability label and exactly one
loopback-published TCP binding. That single capability owns the fixed
`mira_dashboard_observability` PgBouncer control alias. Approved provisioning creates the
dedicated same-named physical database from `template0`, and PgBouncer's existing wildcard route
preserves the client database name without an explicit mapping or environment interpolation. No
database-name label or Dashboard setting exists. Container, Compose project/service, image, and
host-port values are observations, never configured authority; application-database renames and
port changes therefore reconcile without an application or secret edit. Credential absence,
discovery absence or ambiguity, privilege drift, catalog overflow, or an unexpected row shape
causes an explicit unavailable/last-known-good state and never widens authority or falls back to
an application credential. App-specific relations and cards, including the legacy Comet and
Bitmagnet torrent counts, cannot define the generic inventory. The sole named exception is an
optional, count-only `mira_dashboard_observability.torrent_count` probe in those two databases.
Its reviewed fixed identifiers are isolated capability metadata: a missing database or view makes
only that card unavailable and never hides or fails unrelated dynamically discovered databases.
The inspect template admits only ID, state/health, the one database capability label, standard
Compose project/service identity, and structured published ports; it never ingests container
environment, mounts, or the remaining labels into the Dashboard process.

The approval-gated provisioning runner has a separate Docker execution boundary. It pins the
local Engine socket and root Compose file/project directory, resolves the one healthy PostgreSQL
dependency of that capability, and runs container-local psql over the fixed Unix socket. A fixed
launcher carries only the existing non-secret administrative username into `env -i`; it discards
host/container endpoint variables and passwords. Every bounded stdin execution verifies the
probed superuser role OID and PostgreSQL system identifier before SQL runs. Provisioning artifacts
are allowlisted, descriptor-pinned, bounded immutable-release children with contained `\ir`
expansion. The operator command uses the exact production Bun/current-release pointers, not host
psql, ambient `PG*`, or PATH-selected Bun.

Production credential cutover remains a release gate for this provider. The existing
`DATABASE_USERNAME`/`DATABASE_PASSWORD` Doppler pair is administrative/application-stack input;
it must not become a Dashboard runtime fallback or grant the worker PostgreSQL/PgBouncer admin
authority. Doppler must instead supply the distinct observer password named by the application
configuration registry, while host and port remain discovery-owned and the control alias, physical
control database, and role name remain code/capability-owned as described above. The observer credential is
applied by a reviewed activation
path that withholds it from argv, output, logs, manifests, and generated documentation.

The currently deployed `/opt/docker/apps/pgbouncer/userlist.txt` is a Git-tracked SCRAM auth file.
Its verifier is not a cleartext password, and the repository is private, but it remains
credential material: repository access and Git history widen its lifetime and permit offline
guessing of a weak password. Before Phase 5 closure or production cutover, the Docker source of
truth must stop tracking that file, provision an equivalent PgBouncer auth input from Doppler at
runtime with no group/world-readable copy, and rotate the affected credential after the new path
has passed a rollback-capable PgBouncer authentication smoke test. Historical Git rewriting is a
separate destructive decision and is not implied; rotation makes the retained historical verifier
obsolete. Validation uses `/opt/docker/bin/docker-compose-doppler` in a mode that emits no resolved
Compose document or secret values. The app-owned PgBouncer Compose file must carry the exact single
database-observability capability label and fixed control alias, and the worker must compose the
separate privileged collection-lease port into the existing hourly cache action, before this
provider is enabled.

## Resource Safety

At this audit, the production web service used about 247 MiB with a recorded peak of 379 MiB;
the worker used about 54 MiB with a recorded peak of 62 MiB. The existing multi-gigabyte unit
limits are therefore not useful early-warning boundaries.

Start the rewritten services with measured, deliberately conservative budgets:

| Process            | `MemoryHigh` | `MemoryMax` | `TasksMax` | `CPUQuota` |
| ------------------ | -----------: | ----------: | ---------: | ---------: |
| Web                |      768 MiB |       1 GiB |         96 |       100% |
| Worker coordinator |      768 MiB |     1.5 GiB |        128 |       150% |

These are starting limits, not eternal constants. Load tests and production metrics may adjust
them through a reviewed change. Resource-heavy child jobs receive smaller task-specific caps
in separate transient units; they do not borrow the worker's full ceiling.

Additional safeguards:

- build release artifacts in hosted CI or a disposable capped scope, never unbounded beside
  production;
- one resource-heavy worker job at a time on the VPS;
- bounded database pages, event batches, log buffers, file reads, child output, caches, and
  retries;
- use stream backpressure and abort propagation rather than accumulating chunks;
- no unbounded `Promise.all` over files, containers, tests, sessions, or API results;
- server-side pagination or cursors for every append-only history;
- run the Bun and browser type-aware lint partitions sequentially on the VPS;
- cap Bun test concurrency and require deterministic same-process cleanup of global state; and
- record cgroup OOM/limit exits as failed jobs with an actionable message.

## Build, Test, and Quality Tooling

### Required scripts

The future-root package keeps a small stable command surface. Runtime partitions and operational
subcommands are typed arguments behind repository-owned entrypoints instead of separate package
scripts. There are no per-domain, server, worker, script, or qualification TypeScript projects.
`check boundaries` remains the focused finer source-role gate. Retained Phase 0
mechanisms run through the ordinary Bun test graph. Product and cross-process integration tests
live under `src/`; a focused test of a repository script may remain colocated with that script.

```text
bootstrap               frozen first install, generated checks, state preparation, local start
dev [subcommand]         local stack, isolated state, and remote-route lifecycle
check                    format, lint, typecheck, boundaries, docs, and database
build [subcommand]       deterministic browser, process, Storybook, and release artifacts
test                    Bun, Happy DOM browser, then real-browser Storybook graphs
test bun                scripts, server, worker, contracts, integration, and parity tests
test browser            Happy DOM + Testing Library behavior tests
test storybook          real Chromium stories, interactions, and accessibility tests
test coverage           all three graphs + 85% executable-source line gate and LCOV
generate/check docs     deterministic generated documentation
delivery [subcommand]   explicit state preparation and immutable release activation
preflight               frozen audit, complete unchanged gates, and immutable release build
```

`oxfmt` owns formatting, import sorting, package sorting, and Tailwind class sorting. `oxlint`
owns JavaScript/TypeScript lint. Type-aware Oxc rules are enabled in a separate command because
their TypeScript analysis has a different memory profile; they do not silently turn every
editor lint into a large typecheck. TypeScript remains the authoritative compile-time project
boundary check unless an evaluated Oxc type-check mode proves equivalent for this codebase.

Lefthook `2.1.10` owns only local pre-commit/pre-push feedback and is installed idempotently by
bootstrap; CI remains authoritative. Pino is not part of the runtime: the existing process-scoped
structured logger and Effect bridge already own redaction, bounds, identity, sinks, and fallback,
so a second logging implementation would weaken rather than simplify that boundary.

### Test strategy

- Pure services and state machines use deterministic unit tests with injected time/IDs.
- Module tests are colocated as `<module>.test.ts`. When one module needs several focused
  suites, each keeps the module prefix as `<module><Concern>.test.ts`, while reusable fixtures
  live in a local `testSupport/` directory. Cross-module server behavior belongs under
  `src/server/test/system/`.
- Every repository runs against a real temporary `bun:sqlite` database with foreign keys and
  production PRAGMAs.
- Migrations are tested only against the new schema's own supported versions, beginning with an
  empty database, then verified with constraint-enforcement PRAGMAs, `foreign_key_check`, full
  `integrity_check`, and schema snapshots.
- tRPC procedures are tested through `createCaller` for domain behavior and through Bun HTTP
  for cookies, headers, aborts, batching, and serialization.
- Realtime tests force the exact race windows: mutation before subscription, during snapshot,
  disconnect after commit/before receive, duplicate delivery, cursor expiry, worker-originated
  event, slow client, and server restart.
- Chat uses recorded, redacted Gateway event fixtures and model-provider adapters to verify
  sequence, reconciliation, cancellation, and recovery.
- Frontend tests assert visible behavior and accessibility rather than hook implementation.
- Bundle tests enforce route chunk and initial-load budgets and verify React Compiler output.
- Deployment tests activate a disposable release and database, run probes, and exercise paired
  rollback.

Hosted CI may parallelize independent jobs within runner limits. On the VPS, `verify` is
sequential and capped; deployment runs only lightweight artifact, schema-copy, and readiness
checks. Every pull request and `main` run resolves the selected Canary channel and executes the
required future-root test and evidence gates before a release can be promoted.

## Deployment and Runtime Layout

Keep the host-native deployment. Dashboard needs controlled access to systemd, local files,
Docker, OpenClaw, Git worktrees, and host databases; putting the application itself in a
container would add mounts and privilege plumbing without isolating the important child jobs.

The Docker stack remains a separate project and source of truth beneath `/opt/docker`. Dashboard
does not absorb its compose files, application data, or deployment lifecycle into the Dashboard
repository or state tree. Dashboard is the control plane: browser requests select reviewed
operations, durable jobs and audit records preserve intent/outcome, and worker-only adapters touch
the Docker project within explicit policy and resource bounds.

The implemented Docker slice discovers topology at runtime rather than shipping a service catalog.
A worker-owned, read-only adapter enumerates Docker Engine containers and collects batched
projected inspect data; standard Compose project/service labels are observed metadata, not required
names. The canonical Compose trust root constrains where mutation policy may resolve files, but it
does not decide which running containers are visible. Bounded reconciliation adds, removes, and
renames containers, services, projects, images, and volumes without manual Dashboard handling.
Ambiguous or disappearing items fail closed individually, while a source-wide Engine/Compose
failure keeps the last known good inventory with an explicit freshness state.

Update discovery reuses the Compose policy already deployed under `/opt/docker`:
`mira.updater.enabled`, `mira.updater.autoUpdate`, `mira.updater.track`,
`mira.updater.tagPattern`, and `mira.updater.tagPatternIsRegex`. Both list and map label syntax are
normalized, tag regexes are safety-checked, and Compose project/service identity is joined against
Engine labels rather than container names. Greenfield tightens the legacy default: inventory is
automatic, but an update mutation requires an explicit valid `mira.updater.enabled=true`; absent,
ambiguous, or invalid labels remain visible and non-mutable. The implementation normalizes the
supported list/map label forms and does not maintain a parallel Dashboard service catalog.

`/opt/docker/compose.yaml` is the canonical whole-stack project entrypoint. The worker resolves its
bounded recursive include graph with canonical regular-file containment beneath `/opt/docker`, so
root-level start/stop and service-level update operations use the same project definition. The only
admitted Compose executor is `/opt/docker/bin/docker-compose-doppler`, invoked from `/opt/docker`
with a fixed executable and worker-constructed argv. Browser input cannot select an executable,
working directory, Compose path, environment file, or free-form flag. Root `/opt/docker/.env` and
app-local `.env` files are opaque inputs consumed by Compose/Doppler; Dashboard may verify metadata
needed for a fail-closed preflight but never returns, logs, diffs, rewrites, or persists their
contents. Resolved Compose output that could contain injected secret values is likewise forbidden
from contracts and logs.

Each managed container's update labels and editable `services.<service>.image` source live in its
included app Compose file. Discovery joins Engine project/config/service labels to the canonical
root include graph and records the exact defining file/field under the Docker trust root. An update
re-resolves that ownership under the worker lease, verifies the expected old scalar and whole-file
hash, and atomically replaces only the exact image-scalar byte range. Indentation, spacing,
comments, quoting, line endings, and every byte outside that scalar remain unchanged. The worker
validates the complete root project before calling the Doppler wrapper for the resolved service.
If includes, labels, image ownership, or source text changed concurrently, the attempt does not
guess: it aborts, restores the pre-edit file when necessary, refreshes discovery, and requires a
new intent.

The existing Job/Worker/Schedule runtime owns Docker refresh and mutation. The
`cache.refresh.docker-overview` action re-discovers and publishes the bounded `docker.overview`
projection every minute with a five-minute TTL; a failed attempt retains the validated prior
payload for at most 24 hours as explicit last-known-good. `/docker` can enqueue that same
idempotent cache action immediately and receives only its durable Job summary, never the
domain-only cache payload. The `docker.updater` action runs daily at
04:10 Europe/Oslo and the same action also executes manual source-revision-fenced scans, automatic
runs, and one exact-service update. Updater services and the newest 100 updater events remain in
that cache row, while durable attempts and outcomes remain ordinary Jobs history.

Fixed Docker operations are recent-MFA, audit-first, idempotent durable jobs. The admitted union is
container start/stop/restart, canonical whole-stack start/stop/restart, exact unused image or
volume deletion, actor-bound preview/ticket prune execution, updater scan/run, and one exact
service update. All requests carry the current source revision and fail closed if topology changed.
The worker uses fixed `/usr/bin/docker` argv and the one Compose wrapper above; it never accepts a
container command, shell, cwd, environment, arbitrary flag, or generic Docker exec request. The
three actively consumed legacy Docker-console routes instead map to the already bounded Terminal
prepare/status/terminate lifecycle. The Docker page carries only the exact validated container ID;
the Terminal starts one fixed interactive `/bin/sh` handoff for that container and then retains its
normal ephemeral PTY input. No Docker-specific persisted exec surface is retained.

Two live read operations cannot be served from the cache: bounded redacted container logs and a
current prune preview. The existing worker process exposes only those two strict messages over a
`0600` Unix socket in its validated `0700` state directory. The web process is a bounded client;
the worker remains the Docker authority. The broker starts and stops with the existing worker, has
bounded connections, frames, output, and deadlines, and requires no additional service, systemd
unit, timer, or schedule.

The updater records the exact pre-update running image ID before applying a service. If the
pre-commit path must roll back, it rebinds a mutable old tag to that ID and recreates the service
with `--pull never --force-recreate`; recovery is accepted only after both Compose bytes and the
running image ID are revalidated. After a successful image edit/apply, the updater's worker-only Git adapter stages only the exact
changed per-app Compose paths, proves the expected repository HEAD and before/after blobs, creates
one fixed-author commit, and pushes the configured `github.com` upstream. Before any Compose
mutation, authenticated `ls-remote` and dry-run-push probes must pass with the worker-only GitHub
credential. Global/system Git configuration, ambient credential stores, prompts, hooks, and SSH
are disabled. Existing unrelated staged or pending
work blocks the attempt. Remote readback distinguishes pushed, committed-push-pending,
unavailable, and unknown outcomes; uncertainty is not replayed or called success. The canonical
Git source is resolved per operation rather than during worker composition, so a missing
`/opt/docker` source degrades only Docker and can recover later without process restart. Bounded updater
history remains authoritative in `docker.overview`, and material discovery, availability, success,
failure, source-sync-pending, and unknown-outcome transitions are idempotently projected
into the existing global notification catalog. Each successful projection retries its complete
bounded event window by stable notification ID, including after a partial earlier batch. Queue
admission is not an updater event: the durable Jobs run and its queued event are authoritative, and
the response links directly to that run. `/docker` shows the inventory, freshness/LKG,
stats, logs, fixed controls, updater policy/status/history, registry checks, exact updates, images,
volumes, deletion, prune previews, links to durable Jobs history, and a direct path to the existing
interactive Terminal for operator Docker CLI work.

The repository root ships new `systemd/` web and worker units as part of the immutable
release. The legacy units were deliberately not copied: they change into a `backend` working
directory, execute retired `dist/*Start.js` entrypoints, and retain pre-measurement multi-gigabyte
limits. The replacement units invoke the exact project-local Bun runtime and release pointers,
bind logs beneath project state, and enforce the measured web/worker resource ceilings. Both units
preserve the explicit `MIRA_DASHBOARD_OPENCLAW_ROOT`; web treats it as a fixed descriptor-read
manifest, while worker uses a separate exact replacement manifest for `openclaw.json` and
`hooks/transforms/agentmail.ts`. Exact replacement admits at most 2 MiB per reviewed source, while
web preview remains capped at 1 MiB. Larger reviewed sources are listable but read-only and expose
only a revision-stable 1 MiB prefix with explicit truncation metadata; raw configuration still
requires a short-lived actor-bound recent-MFA ticket. The worker's atomic replacement needs
target-directory write access for its private stage file, `renameat2` exchange, and exact rolling
`.bak` sibling, so the unit does not advertise an exact-file `ReadWritePaths` sandbox that would fail
at runtime. Descriptor validation, per-file bounds, CAS, and the fixed worker manifest are the write
boundary.

The fixed Service Actions contract and Overview include host cleanup, host restart, and host
update. A fixed `/usr/bin/systemctl` broker and root-owned helper, policy, service/timer, and
manifest-verified installer artifacts ship in the release. The root-installed topology keeps
`ubuntu` as the trusted production-state/worker principal and moves web to the dedicated
`mira-dashboard-web` UID. The production worker now composes the broker; web has no supplementary
groups and cannot see Docker or broker paths.

Before the worker can request the fixed restart unit, it atomically arms the database-global
restart claim fence using the validated Linux `/proc/sys/kernel/random/boot_id` identity. Arming
requires that exact owned restart lease to be the only globally running job; once armed, all
worker processes stop claiming new jobs. The current broker has no proof that a rejection, abort,
timeout, or lost response occurred before `systemctl start --no-block` accepted the reboot timer;
therefore every outcome after dispatch begins retains the fence. A new boot identity reconciles
it, while five-minute same-boot expiry restores admission if no reboot occurs. This safety fence
is independent of the operator-controlled queue pause.

Host-action enablement is a reviewed delivery/topology operation rather than an application
toggle. The two system services run as distinct OS principals; a root-owned fixed launcher creates
only the reviewed id-mapped project/OpenClaw/state mounts inside web's private mount namespace.
The operator's `0700` Doppler directory remains root-launcher-readable but is never identity-mapped
to the web principal. The launcher validates its ownership and modes, requests only the fixed web
secret allowlist, and fails startup unless the dropped web identity cannot read or traverse the
credential directory. The projected phase unmounts that directory and verifies the credential
file is absent before it proves Docker and system-manager IPC absent and irreversibly drops to the
web UID with no groups or capabilities. The root polkit policy admits only
the `ubuntu` worker identity, the three exact host units with `start`, and the two Dashboard units
with `start|stop|restart`. It rejects every arbitrary unit and verb.
The root installer must never consume the application-owned release tree directly. A reviewed
handoff first transfers the exact release into a dedicated root-owned immutable staging path. The
release root and every traversed source directory must be `root:root 0500`; the release identity,
manifest, and every admitted helper/unit/policy artifact must be `root:root 0400`. Source hashes
from an application-owned release do not establish authority, even when internally consistent.
The handoff also provisions one exact root-owned Bun runtime at
`/var/lib/mira-dashboard-host-provisioning/runtime/bun` with mode `0555`; every ancestor is
root-owned and not group/other-writable beneath the root-owned, non-group/other-writable
`/var/lib/mira-dashboard-host-provisioning` trust root. It invokes the root-owned staged installer
by absolute path, never a package script or application-checkout module. This pre-execution boundary is
mandatory because Bun loads the entrypoint and its local dependencies before their in-process
runtime/source checks can execute. The installer then validates its exact `process.execPath` and
ancestor ownership/modes again before admitting release bytes.
Before ownership transfer or launch, change control independently verifies the candidate against
the reviewed Git commit/tree and supplies the exact release-manifest SHA-256 out of band. The root
command must not derive that trust anchor from the application checkout. The installer compares
the supplied digest to the held root-owned manifest bytes before parsing any artifact digest, so an
internally consistent app-forged release and manifest are insufficient.
OpenClaw cleanup, restart, and update do not use this deferred host authority: their exact
worker-only Gateway operations are already implemented and remain available only when a fresh
exact-release worker advertises them. Restart reuses the same fixed action provider as the Settings
control rather than adding a second lifecycle executor.

The fixed `system-cleanup` unit preserves the consumed cleanup behavior behind one reviewed
authority. It attempts package autoremove and cache cleanup, journald rotate plus 14-day/1 GiB
vacuum bounds, and Docker system prune for unused content older than 168 hours; it never passes
`--volumes`. Each phase is attempted, any failure fails the unit, output is discarded, and the
worker receives only a completed status. Together with the bounded PTY this defines the narrow
replacement for the legacy `POST /api/exec/start` behavior without recreating the old shared shell
boundary. That parity row is implemented through the PTY plus fixed Service Actions; no generic
command, argv, shell, cwd, or raw output contract is restored.

The web process also derives the fixed `<MIRA_DASHBOARD_OPENCLAW_ROOT>/media` descriptor boundary
from that same reviewed root. It exposes no configurable media directory, recursive listing, or
browser-supplied path route. Local-history transcript carriers become opaque session/message-bound
references and reuse `GET`/`HEAD /api/chat/media/:attachmentId`; each access reauthorizes the exact
projected transcript association before descriptor traversal begins. The local adapter enforces
same-owner/same-device no-follow traversal, one-link regular files, stable identity, a 16 MiB body
ceiling, and a 1 MiB text-preview ceiling. Its retained root descriptor and process-local reference
state are disposed with the web runtime, while bounded history refresh reconstructs only an already
authorized association after restart. The stable identifier prefix is a non-secret routing hint;
serialized refresh admission, per-class cooldown, an eight-request queue bound, and a global
page-weighted token budget—not identifier secrecy—bound restart work.

Persistent state remains inside the existing Dashboard project layout at
`<project-root>/production/state`, but outside every immutable release directory. Production
composition derives that path from `MIRA_DASHBOARD_PROJECT_ROOT`; neither configuration nor a
systemd `StateDirectory=` may select a separate state root. The greenfield bootstrap/release
boundary creates that directory as current-user-owned `0700` and protects its existing ancestor
chain before activation. For a non-sticky ancestor owned by the managed UID, preparation may only
clear group/other write bits through a no-follow directory descriptor, preserve every other
permission, verify device/inode before and after, and then revalidate the whole chain. It must fail
closed for symlinks, ownership drift, or a writable foreign-owned ancestor; application runtime
startup never repairs permissions. On the current host, first cutover therefore requires
`chmod go-w /home/ubuntu/projects` (currently `0775` to `0755`) without moving any project data.
Unit source remains under `<project-root>/production/checkout/systemd` or the active development
worktree, and the exact two unit files are copied into and hashed by every immutable release. The
root installer accepts only those manifest artifacts, atomically replaces root-owned regular unit
files, creates the fixed web principal, reloads root systemd, and enables only the two Dashboard
units without starting them. Activation never rewrites root state: it verifies both installed unit
bytes against the exact candidate manifest before its first stop. The authenticated target smoke
then proves distinct live principals, exact root fragment paths, empty web supplementary groups,
and the worker Docker group. Reinstalling the previous root-owned immutable release is the explicit
rollback. Only installed copies of systemd unit files may live outside
`<project-root>/development` or `<project-root>/production`; all Dashboard state, logs, backups,
runtime binaries, checkouts, and release artifacts remain inside those project directories.

The first production cutover is an explicit operator-run replacement, not a rolling activation
through the previously published user-systemd executor. The operator stops, disables, and removes
the legacy user units, stages and runs the manifest-bound root installer, verifies the exact
root-owned candidate units and principals, and only then invokes `bun run delivery activate`
directly from the verified candidate. It does not launch the previously published
`server/productionDelivery.js` or its user-unit installer, and the legacy service pair is not
recorded as a Greenfield rollback target. The candidate repository therefore contains no
compatibility installer for user units. After this one-time authority transfer, ordinary
Greenfield activation controls only root systemd and fails closed before service effects whenever
the installed root-unit bytes differ from the candidate manifest; changed unit bytes require the
root provisioning step before activation.

Recommended layout:

```text
<project-root>/
  production/
    checkout/
    releases/<release-id>/
      server/
        openClawHeartbeat.js
        productionDelivery.js
        resetDashboardPassword.js
      browser/
      migrations/
      docs/generated/
      metadata/
      systemd/
      release-manifest.json
    releases/current -> <release-id>
    runtimes/bun/<exact-revision>/bun
    runtimes/bun/current -> <exact-revision>
    state/
      activation.json  # authoritative current/previous release-runtime pairs
      mira-dashboard.db
      backups/
      delivery-production-operations/
      job-output/
      log-maintenance/
      logs/
      terminal-broker/
      workspace-file-uploads/
  development/
    state/
      local/
      preview/
      remote/
    worktrees/<name>/
```

The release manifest contains Git commit, clean-tree state, Bun revision, lockfile hash,
direct package versions, schema migration/checksum set, asset hashes, docs hash, build commands,
required process roles, and the exact cross-release Delivery protocol. Every release contains the
manifest-bound `productionDelivery.js` executor for `delivery.production.v1`. It contains no
secrets.

Every release also contains the manifest-bound `openClawHeartbeat.js` executable and the exact
`scripts/delivery/provisioning/openclaw-heartbeat/HEARTBEAT.md` Markdown prompt source. The retained
artifact filename is release inventory, not the runtime target. The executable has only `collect`
and `report` modes and reads `openclaw-heartbeat.token` from its fixed private client path. OpenClaw
owns the live authority at `agents.entries.ops.heartbeat.prompt`; Dashboard build, publication,
retention, ordinary activation, and service restart never install or reset either that config value
or the external credential.

Every release also contains `server/resetDashboardPassword.js` as a manifest-required ancillary
executable. It is not a managed process role or systemd service. The host-only
`auth:reset-password` package command starts that executable from `releases/current` with the Bun
binary from `runtimes/bun/current`, an empty environment except for `NODE_ENV=production`, and the
fixed production project root. The executable resolves the immutable active release, validates
its release/runtime identity, and opens only the protected production state owned by that project.
The operator supplies the password only through a TTY prompt with echo disabled.

Heartbeat cutover is a manual one-time external transition after Greenfield is active and ready:

1. Create or qualify the Greenfield principal `openclaw-heartbeat` with exactly `cache:read` and
   `monitoring:write`, then issue a new canonical `greenfield-opaque-token-v1` credential. The
   incompatible legacy `openclaw-heartbeat.<64-hex>` token is never reused.
2. Atomically install the new token in the fixed private credential file and reverify its owner,
   `0600` mode, regular-file identity, and non-symlink boundary.
3. Read the current OpenClaw config and base hash, validate the manifest-bound candidate prompt,
   dry-run the exact patch, and CAS patch only `agents.entries.ops.heartbeat.prompt`.
4. Allow the `agents.entries` change to hot-restart the heartbeat scheduler without a full Gateway
   restart, then run one isolated authenticated heartbeat and prove exactly one schema-v5
   collection followed by one complete-snapshot report.

No app-owned cutover executor, config writer, credential rotator, activation journal, or legacy
token parser is introduced. Legacy is removed rather than retained as a rollback target. Later
Greenfield release rollbacks keep the same external schema-v5 prompt and credential. Heartbeat
parity remains planned until the live smoke succeeds.

PR-preview publication requires one explicit new-host bootstrap: a root operator runs the
manifest-inventoried Tailscale provisioning artifact, which delegates the fixed local account
`ubuntu` through `/usr/bin/tailscale set --operator=ubuntu`. The production worker keeps
`NoNewPrivileges=true` and invokes only the fixed `/usr/bin/tailscale` binary directly; it never
uses `sudo`. Production cutover reads Tailscale preferences and requires the exact operator before
confirming the journal or stopping services. Missing or drifted delegation therefore fails closed
before deployment effects, and bootstrap is never applied implicitly by deployment.

Post-cutover Greenfield deployment flow:

1. Build and test one artifact using the same resolved Bun runtime throughout the build.
2. Verify every source artifact hash and the exact runtime identity without copying into the
   production artifact roots yet.
3. Prepare and verify `<project-root>/production/state` plus its protected ancestor chain before
   changing the active release pointer.
4. Acquire the deployment lease, recover any durable activation journal, and run verified
   release/runtime retention before copying. Admit the missing source-tree and Bun runtime using
   destination allocation blocks, conservative directory metadata, free-inode capacity, a fixed
   64 MiB byte reserve, and 64 free reserve inodes. Each copied file and the directory tree are
   fsynced bottom-up before the immutable stage is renamed, and that rename's parent is fsynced
   before publication or runtime installation returns. Install/publication failure repeats the
   same journal-aware retention pass immediately; a crash between those operations is reconciled
   before the next attempt, so distinct failed candidates cannot accumulate indefinitely or consume
   space needed by the authoritative pair. The worker then fsyncs one secret-free
   `delivery.production.v1` capsule containing the exact original production Job payload, actor,
   authenticator, audit, idempotency, source, release, runtime, and snapshot CAS identities. It
   manifest-verifies the current immutable executor and launches it through a fixed transient
   user-systemd unit in a separate cgroup with `env -i`; GitHub, Doppler, Gateway, Docker, and
   reviewer credentials never cross that handoff. The executor confirms the exact journal before
   verifying the manifest-bound root-installed stop-owner units, draining active jobs, entering maintenance
   mode, and quiescing database writers. Recovery treats the pre-snapshot phase as
   database-unmodified and idempotently restores the previous service owner.
5. Snapshot and verify the current database while writers remain stopped.
6. Apply migrations to a copy, run schema/preflight checks, then atomically promote the
   database state.
7. Reverify the candidate release's manifest-bound root units, then let the deployment-held
   activation start worker in `validate-only` mode before web, with readiness deadlines. The
   authoritative activation record is not committed until target readiness and the required target
   validation succeed. A rollback preloads only the exact authoritative previous snapshot,
   snapshots the current database before restoring it, and records that fresh snapshot beside the
   now-previous release. Repeated `current → previous → current` rollback therefore preserves the
   correct database state in both directions.
8. Run authenticated smoke checks, including tRPC, SSE, Gateway, docs, and one safe queued job.
9. Store one immutable terminal operation receipt before clearing the in-flight record. A restarted
   worker reconciles that receipt before ordinary Job claiming; if paired rollback restored an
   older SQLite snapshot, it rehydrates the exact original run from the capsule and settles through
   the normal coordinator without repeating the external effect. Receipts remain pinned while
   current, previous, or in-flight snapshots can resurrect their Job rows. Atomically record
   current/previous and run release/runtime retention only after the complete
   managed inventories verify. Retention preserves the authoritative current and rollback pairs
   plus the candidate while a transition is being prepared, so successful activation converges to
   at most two immutable releases and at most two Bun revisions. Every other commit-addressed
   release must pass its manifest/tree verification, and every other runtime must pass its exact
   revision probe, before either root is mutated. Selected directories are atomically renamed to
   `.retire-*`, the parent is synced, and bounded descriptor-rooted, same-owner/same-mount,
   no-symlink reaping resumes after interruption. Files move through private tombstones and are
   checked against held descriptors and observed inodes immediately before pathname-based unlink.
   Linux provides no inode-conditional unlink. These checks fail closed for accidental or stale
   path/rename drift; every authorized mutation by the trusted application UID is instead
   serialized by the exact deployment lease. A malicious concurrent process with that same UID is
   outside the current application-owned threat boundary because it can already rewrite manifests,
   pointers, and roots. Defending against it requires the planned root-owned immutable handoff and
   different-principal garbage collection. Bounded crash-left `.stage-*` trees and `.current-*`
   pointer stages are reconciled by the same pass. An
   unknown entry, pointer/reference mismatch, invalid artifact, path replacement, or oversized
   inventory fails activation closed without deleting the authoritative pairs.

Because the new application carries no schema compatibility code, rollback is a **release and
database pair**. If activation crosses a non-backward-compatible migration, rollback restores
the matching pre-activation snapshot before starting the previous release. A code-only rollback
against an arbitrary schema is forbidden.

## Package Decisions

### Add

| Package                      |      Audited version | Purpose                                                            |
| ---------------------------- | -------------------: | ------------------------------------------------------------------ |
| `@trpc/server`               |              11.18.0 | server router, Fetch adapter, errors, tracked subscriptions        |
| `@trpc/client`               |              11.18.0 | batch and subscription links for browser/automation                |
| `@trpc/tanstack-react-query` |              11.18.0 | current TanStack Query integration                                 |
| `@valibot/to-json-schema`    |                1.7.1 | generated contract JSON Schema                                     |
| `drizzle-orm`                | 1.0.0-rc.4 candidate | typed Bun SQLite schema/query layer and Valibot integration        |
| `drizzle-kit`                | 1.0.0-rc.4 candidate | reviewed SQL migration generation from the schema                  |
| `effect`                     |       4.0.0-beta.106 | server typed errors, cancellation, schedules, and scoped resources |
| `superjson`                  |                2.2.6 | symmetric tRPC transformer for deliberately richer API types       |

### Keep as architectural dependencies

- React 19, React DOM, and React Compiler;
- TanStack Query, DB, Query DB Collection, Router, Form, Store, Table, and Virtual;
- Valibot;
- Drizzle over the retained native `bun:sqlite` client, exact-pinned after qualification;
- `@simplewebauthn/browser` and `@simplewebauthn/server`;
- Tailwind CSS and the Bun Tailwind plugin;
- `oxlint`, `oxlint-tsgolint`, the selected Oxc plugins/presets, and `oxfmt`;
- Testing Library and Happy DOM under `bun test`;
- Markdown/GFM/sanitization packages; and
- the existing Dashboard date-picker, DnD, headless-component, JSON-view, icon, QR,
  error-boundary, and class-composition packages needed by the planned parity surface.

TanStack DB is exact-pinned and accessed through a narrow local adapter because its current
version is pre-1.0. This is not a compatibility wrapper: it isolates a volatile dependency from
domain code.

The retained browser packages are a future-root dependency baseline, not permission to reproduce
legacy components. Each browser slice must still verify its imports, accessible behavior, and
bundle cost, and remove packages it replaces or does not adopt.

### Remove or do not introduce

- handwritten REST client types and the browser `/ws` protocol/client;
- JWT session/access tokens, Axios, or `dotenv`; opaque revocable validators, native `fetch`, and
  composition-root configuration parsing already own those concerns;
- duplicate global auth/server caches superseded by Query and focused stores;
- a second ORM, active-record/data-mapper layer, or production schema auto-push;
- Zod alongside Valibot;
- Node `ws`, Socket.IO, Express, Hono, Nest, Next.js, or a second web server;
- GraphQL, gRPC, Connect, Redis, a message broker, or microservice RPC;
- `trpc-openapi` or private tRPC router introspection; and
- TypeDoc for the whole internal application. Generated domain references are more useful than
  an API site for every private function.

Leaf UI packages should not be churned merely for novelty. At implementation start, run a
direct-dependency usage audit, current-version audit, bundle audit, and official-doc check. Keep
or replace each based on actual use. At this audit all current direct packages were at their
latest resolved version except `oxlint-config-presets`, where `0.1.18` superseded `0.1.17`.

## Fresh Database Cutover

No production code, script, migration, or test fixture reads the old schema. The current
migration files are a historical implementation reference only and are never part of the new
database path. Cutover is deliberately simple:

1. Stop old web and worker writers.
2. Create and verify a final immutable old-database snapshot.
3. Initialize a new database solely from the tracked greenfield baseline.
4. Bootstrap the sole operator again and re-enroll MFA/passkeys rather than copying live session
   or challenge state.
5. Run parity smoke checks, then activate the new release/database pair.
6. Preserve the old database only as a read-only operational archive for its chosen retention
   period; the new application never opens it.
7. Recreate any selected tasks, policies, schedules, or configuration manually through the new
   validated application interfaces after acceptance.

Do not add nullable columns, legacy enums, parser branches, compatibility tables, or one-off
import code to make old data fit.
