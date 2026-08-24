# Greenfield Rewrite Runtime and Delivery

[Back to the blueprint map](../greenfield-rewrite.md)

## Bun 1.4 Runtime Baseline

### Audited qualification state

| Item                               | Verified value                             |
| ---------------------------------- | ------------------------------------------ |
| Repository channel                 | `canary`                                   |
| Required runtime version           | `1.4.0`                                    |
| Running production release runtime | `1.4.0-canary.1+e82022145`                 |
| Audited qualification candidate    | `1.4.0-canary.1+43783cedd`                 |
| Audited full revision              | `43783cedd5653fa29bb9ac83df34633eae10fe75` |
| Audited commit date                | 2026-08-03 22:02:12 UTC                    |

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

Before the new repository baseline is locked, run the following in an isolated, memory-capped
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
6. `bun test --isolate` tests for fake timers, leaked handles, deterministic shutdown, and
   bounded concurrency.

The current one-shot Phase 2 verifier qualifies complete text `MessageEvent` delivery only. Raw
continuation-frame reassembly and fragmented-message behavior remain an explicit open Phase 0
native-WebSocket gate and must be qualified against the then-current Bun candidate before the
repository baseline is locked.

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

The preferred frontend build uses Bun's HTML entrypoint and ahead-of-time production build.
The React Compiler plugin must run before other Babel transforms, followed by Bun and the
Tailwind plugin. Because Bun still labels the full-stack development server as work in
progress, phase 0 must choose one proven build mode:

- preferred: Bun HTML import/full-stack entry with an AOT production build; or
- if the qualification fails: explicit browser and server `Bun.build` entrypoints.

Only the selected mode is implemented. There is no production fallback or duplicate build
path. In either case, the release contains prebuilt assets, hashes, compressed variants,
source-map policy, and a manifest; production never compiles the frontend on request.

## Configuration From Scratch

Configuration is parsed once at each composition root through a Valibot schema. There are no
scattered `process.env` reads and no truthy-string parsing. Every field declares:

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

The target repository uses a base TypeScript configuration plus strict browser, server/worker, and
script project references so browser libraries are unavailable to server code and Bun/filesystem
types are unavailable to browser code. The current rewrite has a complete strict server graph and
selected restricted-import/composition tests, but it does not yet have every target project
reference or path boundary. Completing and mechanically enforcing those partitions remains a
cutover gate. `bunfig.toml` contains only shared Bun test and selected serve-plugin configuration;
operational policy lives in typed source, not hidden shell environment.

## Generated Documentation

Documentation generation is a product feature and a CI invariant, not an optional wiki task.

### Sources of truth

| Source                          | Generated facts                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| Procedure registry              | tRPC names, kinds, auth/capabilities, input/output schemas, errors, examples, emitted events |
| Raw HTTP registry               | methods, paths, auth, content types, range/stream behavior, status codes                     |
| Event registry                  | topic, event type, entity/operation, payload schema, retention, snapshot/resync procedure    |
| Valibot config schema           | environment/settings names, types, defaults, secret flags, process ownership                 |
| Drizzle schema                  | intended tables, columns, types, relations, constraints, and declared indexes                |
| Applied temporary SQLite schema | tables, columns, checks, foreign keys, indexes, partial predicates                           |
| Browser route registry          | URL, navigation label, feature owner, query/search schema, required procedures               |
| Lockfile and Bun policy         | exact direct versions, selected channel/version, build identity                              |

The database generator compares Drizzle's declared schema with a temporary SQLite database
created by applying every tracked migration, then inspects `sqlite_schema`,
`PRAGMA table_xinfo`, `foreign_key_list`, `index_list`, and `index_xinfo`. It does not attempt
to parse SQL with regular expressions.

### Generated outputs

The following is the **target** artifact set. The checked-in
`docs/generated/README.md` identifies the smaller subset the current generator actually emits and
lists the references still required before cutover.

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

The new `/docs` frontend route renders the checked-in generated artifacts with navigation and
search. Rendering uses the existing Markdown/sanitization boundary and never reads source files
or secrets from production. A release may add its non-secret build identity at runtime without
rewriting deterministic documentation.

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
- separate fast lint from memory-heavier type-aware lint and run them sequentially on the VPS;
- cap Bun test concurrency and isolate tests that leak global runtime state; and
- record cgroup OOM/limit exits as failed jobs with an actionable message.

## Build, Test, and Quality Tooling

### Required scripts

The exact naming may change. This is the **target** Bun command-role inventory, not a claim that
the current `package.json` already exposes every alias. Today the rewrite uses separate strict
`typecheck:server` and `typecheck:qualification` graphs plus the existing frontend/backend lanes;
the complete project-reference partitions remain the future cutover gate described above.

```text
dev                     local Bun server + worker + frontend development
build                   deterministic browser and server/worker artifacts
typecheck               target project-reference partitions, no emit (future cutover gate)
lint                    fast oxlint rules
lint:typed              oxlint type-aware rules in a separately budgeted process
format / format:check   oxfmt
test:unit               pure domain and utility tests
test:database           temporary SQLite repository/migration tests
test:contracts          tRPC caller, raw HTTP registry, schema, and docs tests
test:realtime           SSE/outbox/reconnect/race/backpressure tests
test:frontend           Happy DOM + Testing Library behavior tests
test:integration        Bun server/worker/Gateway fixture tests
test:parity             named current-feature acceptance suite
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
qualification job before a release can be promoted.

## Deployment and Runtime Layout

Keep the host-native deployment. Dashboard needs controlled access to systemd, local files,
Docker, OpenClaw, Git worktrees, and host databases; putting the application itself in a
container would add mounts and privilege plumbing without isolating the important child jobs.

Recommended layout:

```text
production/
  releases/<release-id>/
    server/
    browser/
    migrations/
    docs/generated/
    scripts/
    release-manifest.json
  releases/current -> <release-id>
  releases/previous -> <release-id>
  runtimes/bun/<exact-revision>/bun
  state/
    mira-dashboard.db
    backups/
    job-output/
    logs/
```

The release manifest contains Git commit, clean-tree state, Bun revision, lockfile hash,
direct package versions, schema migration/checksum set, asset hashes, docs hash, build commands,
and required process roles. It contains no secrets.

Deployment flow:

1. Build and test one artifact using the same resolved Bun runtime throughout the build.
2. Transfer or materialize it into a new immutable release directory and verify every hash.
3. Acquire the deployment lease, drain active jobs, enter maintenance mode, and quiesce all
   database writers.
4. Snapshot and verify the current database while writers remain stopped.
5. Apply migrations to a copy, run schema/preflight checks, then atomically promote the
   database state.
6. Start worker and web against the candidate, with readiness deadlines.
7. Run authenticated smoke checks, including tRPC, SSE, Gateway, docs, and one safe queued job.
8. Atomically record current/previous and prune only releases whose manifests verify.

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
| `effect`                     |       4.0.0-beta.103 | server typed errors, cancellation, schedules, and scoped resources |
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
- small UI packages that have a verified import, accessible behavior, and acceptable bundle
  cost.

TanStack DB is exact-pinned and accessed through a narrow local adapter because its current
version is pre-1.0. This is not a compatibility wrapper: it isolates a volatile dependency from
domain code.

### Remove or do not introduce

- `@dnd-kit/react`, which has no current code import; keep only the used DnD packages;
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
