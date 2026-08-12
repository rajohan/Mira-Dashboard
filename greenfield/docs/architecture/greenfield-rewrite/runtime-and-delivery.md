# Greenfield Rewrite Runtime and Delivery

[Back to the blueprint map](../greenfield-rewrite.md)

## Bun 1.4 Runtime Baseline

### Audited qualification state

| Item                               | Verified value                             |
| ---------------------------------- | ------------------------------------------ |
| Repository channel                 | `canary`                                   |
| Required runtime version           | `1.4.0`                                    |
| Running production release runtime | `1.4.0-canary.1+e82022145`                 |
| Audited qualification candidate    | `1.4.0-canary.1+17d684360`                 |
| Audited full revision              | `17d6843606d76620cb55d31424d7fb0aed51c367` |
| Audited commit date                | 2026-08-06 00:27:30 UTC                    |

The audited revision is evidence for this qualification round, not a repository-wide pin.
Normal CI resolves the `canary` channel and runs the complete gate set. Release creation then
captures the resolved revision in the immutable release manifest, preserving exact deployment
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

The rewrite should qualify the latest canary rather than copy the installed revision. The
directory-route feature is not an architectural dependency: compiled frontend assets may use
the Bun HTML pipeline, but workspace files and media retain explicit, policy-checked handlers.

### Mandatory canary qualification

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

`.bun-version` selects the `canary` channel through the official `setup-bun` action. The serving
process enforces Bun `1.4.0`, while the runtime revision remains diagnostic until release creation
records it as part of the immutable build identity. When Bun 1.4 is officially released, the
version file changes to `1.4.0` without redesigning CI or deployment. npm does not publish a
`bun-types` snapshot for every runtime canary: the repository pins and qualifies the latest
available snapshot (`1.4.0-canary.20260519T150915`) instead of claiming source-revision parity.
The types pin is requalified only during an explicit Bun/types upgrade round and is replaced by
the official Bun 1.4 types when stable ships.

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
bun run docs:generate   # write deterministic generated files
bun run docs:check      # generate in a temporary directory and compare
bun run docs:serve      # optional local docs view through the normal app
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

The exact naming may change as product areas arrive. The future-root package exposes one
`typecheck` gate over the root solution; focused browser and Bun child checks may remain as
developer aliases. There are no per-domain, server, worker, script, or qualification TypeScript
projects. `check:boundaries` enforces the finer source roles. Retained Phase 0 mechanisms run
through the ordinary Bun test graph. Product and
cross-process integration tests live under `src/`; a focused test of a repository script may
remain colocated with that script.

```text
dev                     local Bun server + worker + frontend development
build                   deterministic browser and server/worker artifacts
typecheck               root TypeScript solution (browser + Bun), no emit
lint                    oxlint type-aware rules and type-check diagnostics, partitioned by runtime
format / format:check   oxfmt
test                    Bun graph followed by browser graph
test:bun                scripts, server, worker, contracts, integration, and parity tests
test:browser            Happy DOM + Testing Library behavior tests
test:coverage           all tests + 85% executable-source line gate and LCOV
docs:generate/check     deterministic generated documentation
verify                  sequential local gate with explicit resource caps
```

`oxfmt` owns formatting, import sorting, package sorting, and Tailwind class sorting. `oxlint`
owns JavaScript/TypeScript lint. Type-aware Oxc rules are enabled in a separate command because
their TypeScript analysis has a different memory profile; they do not silently turn every
editor lint into a large typecheck. TypeScript remains the authoritative compile-time project
boundary check unless an evaluated Oxc type-check mode proves equivalent for this codebase.

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

The future repository root ships new `systemd/` web and worker units as part of the immutable
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

The web process also derives the fixed `<MIRA_DASHBOARD_OPENCLAW_ROOT>/media` descriptor boundary
from that same reviewed root. It exposes no configurable media directory, recursive listing, or
browser-supplied path route. Local-history transcript carriers become opaque session/message-bound
references and reuse `GET`/`HEAD /api/chat/media/:attachmentId`; each access reauthorizes the exact
projected transcript association before descriptor traversal begins. The local adapter enforces
same-owner/same-device no-follow traversal, one-link regular files, stable identity, a 16 MiB body
ceiling, and a 1 MiB text-preview ceiling. Its retained root descriptor and process-local reference
state are disposed with the web runtime, while bounded history refresh reconstructs only an already
authorized association after restart.

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
installer accepts only those manifest artifacts, atomically replaces current-user-owned regular
unit files, and performs only `systemctl --user daemon-reload`; enabling or service control is a
separate activation action. Activation prepares and reloads the verified units for the currently
running release—or the candidate on an empty host—before its first stop, so first deployment does
not depend on pre-existing unit files. Only installed copies of systemd unit files may live outside
`<project-root>/development` or `<project-root>/production`; all Dashboard state, logs, backups,
runtime binaries, checkouts, and release artifacts remain inside those project directories.

Recommended layout:

```text
<project-root>/
  production/
    checkout/
    releases/<release-id>/
      server/
      browser/
      migrations/
      docs/generated/
      metadata/
      systemd/
      release-manifest.json
    releases/current -> <release-id>
    releases/previous -> <release-id>
    runtimes/bun/<exact-revision>/bun
    state/
      mira-dashboard.db
      backups/
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
and required process roles. It contains no secrets.

Deployment flow:

1. Build and test one artifact using the same resolved Bun runtime throughout the build.
2. Transfer or materialize it into a new immutable release directory and verify every hash.
3. Prepare and verify `<project-root>/production/state` plus its protected ancestor chain before
   changing the active release pointer.
4. Acquire the deployment lease, install/reload the verified stop-owner units, drain active jobs,
   enter maintenance mode, durably journal the exact stop intent, and only then quiesce all
   database writers. Recovery treats this pre-snapshot phase as database-unmodified and
   idempotently restores the previous service owner before clearing the journal.
5. Snapshot and verify the current database while writers remain stopped.
6. Apply migrations to a copy, run schema/preflight checks, then atomically promote the
   database state.
7. Reinstall the candidate release's manifest-verified user units, reload user systemd, then let
   the deployment-held activation start worker in `validate-only` mode before web, with readiness
   deadlines. A rollback reinstalls the previous release's units before restarting its paired
   release/database state.
8. Run authenticated smoke checks, including tRPC, SSE, Gateway, docs, and one safe queued job.
9. Atomically record current/previous and prune only releases whose manifests verify.

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
