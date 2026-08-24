# Greenfield Rewrite Implementation Plan

[Back to the blueprint map](../greenfield-rewrite.md)

## Implementation Sequence

This is a new implementation beside the current production release, not an endpoint-by-endpoint
compatibility migration inside it.

### Phase 0: evidence and qualification

- freeze the current frontend parity inventory and redacted integration fixtures;
- qualify the latest Bun canary, tRPC Fetch/SSE, frontend build mode, Drizzle/native SQLite
  behavior, SQLite concurrency, and the TanStack DB direct-write model;
- measure current bundle, latency, memory, job, chat, and database baselines; and
- lock ADRs, exact package versions, and the Bun channel/version policy.

**Exit gate:** every architecture risk marked mandatory below has a passing executable spike.

**Status (2026-08-06): complete.** Exact-candidate qualification, source-derived parity, and the
eight executable spikes below pass. This closes evidence selection only; Phase 1 foundation and
the remaining rewrite phases are still incomplete.

### Phase 1: foundation

- create source boundaries, configuration, logging, errors, contract registry, Drizzle/native
  SQLite layer, migration runner, outbox, and generated docs;
- create immutable build/release manifests and resource-capped development/test scripts; and
- implement probes and observability.

**Exit gate:** greenfield bootstrap protects the existing project ancestor chain and provisions one
canonical `<project-root>/production/state` root for the static web/worker UID; empty database,
docs, build, web, worker, and paired rollback then work end-to-end.

**Status (2026-08-06): complete in the greenfield future root.** The executable browser/web/worker
build, manifest-verified runtime and systemd artifacts, protected project-local state, copied
candidate migration, atomic database promotion, crash journal, paired rollback, readiness, logs,
and shutdown pass a disposable-project lifecycle. Production cutover, authenticated product
smokes, and the remaining domain/UI phases are deliberately not claimed by this foundation gate.

### Phase 2: trust and transport

- implement bootstrap, sessions, password, MFA, WebAuthn, recovery, step-up, automation
  principals, exact capabilities, staged credential rotation, audit, tRPC context, raw HTTP
  policy, and one browser SSE stream.

**Exit gate:** security threat-model tests, reconnect/resume tests, and lost-response-safe
credential rotation pass. Automation administration must be browser-session-only, revalidate
recent MFA inside the state-change transaction, and prove that revocation, capability replacement,
and terminal disablement affect new requests and renewable leases without a process restart.

The server-side Phase 2 exit is now evidenced by the automation lifecycle, native one-shot Gateway
credential verifier, authenticated resumable SSE, and the consolidated
[Phase 2 threat model](../../security/greenfield-phase-two-threat-model.md). The Gateway verifier
uses a protocol-v4 handshake audited against installed OpenClaw `2026.7.2-beta.7 (dabe191)` and is
restricted to the installed protocol's direct-loopback backend path. It requires token-mode proof
in the authenticated hello and is bounded by the process-owned authentication Effect service. This
closes trust and transport for the stated server scope; the greenfield browser UI, persistent
Gateway client, chat, production credential cutover, and complete rewrite remain later phases.

### Phase 3: core operator domains

- implement tasks/agents, reports/incidents/notifications, schedules/jobs, cache/metrics, and
  their frontend routes/collections;
- verify incident reopen and notification exactly-once semantics under concurrency.

**Exit gate:** dashboard, tasks, agents, jobs, reports, and notifications satisfy parity tests.

### Phase 4: Gateway and chat

- re-audit the current installed OpenClaw source and protocol before implementation, then implement
  the native persistent Gateway client, session operations, chat state machine/journal, adapters,
  attachments, reconciliation, recovery, and the full virtualized frontend. Current-production
  Dashboard Gateway/chat/session/agent/cron code is parity evidence, not protocol authority.

**Exit gate:** recorded Gateway fixtures and live smoke tests cover every chat parity item,
including restart during streaming.

### Phase 5: privileged and external domains

- implement files/logs/media/STT/TTS, Docker, database, Moltbook, settings, terminal/exec,
  GitHub/PR/release/deploy/rollback, backup, and OpenClaw operations through worker adapters.

**Exit gate:** capability, step-up, audit, cancellation, resource-limit, and failure-recovery
tests pass for every privileged operation.

### Phase 6: parity, hardening, and cutover

- finish responsive/accessibility/visual parity, generated `/docs`, retention, load/resource
  tests, restore drills, fresh-database cutover rehearsal, and production runbooks;
- perform the fresh-database cutover and monitor the full operational cycle.

**Exit gate:** the definition of done below is satisfied; no compatibility code remains.

Given the current chat, auth, worker, delivery, and host-integration surface, this is roughly
**50–80 focused engineer-days**, not a small transport refactor. Automation can reduce elapsed
time, but it cannot remove the qualification, security, restore, and parity gates.

## Mandatory Spikes and Decisions

All eight Phase 0 spikes have executable evidence on the audited Bun candidate. Their selected
outcomes remain normative unless a later runtime or dependency qualification disproves them:

1. **Passed — Bun full-stack build:** use one compiler-first Bun HTML ahead-of-time production
   build. Tailwind, lazy chunks, CSP, hashes, precompression, source-map policy, and bundle budgets
   pass in the mechanism fixture and actual frontend build; there is no fallback build path.
2. **Passed — tRPC SSE on exact Bun:** credentials, cancellation, tracked resume, typed errors,
   proxy/TLS streaming, rolling reconnect, and bounded slow-consumer behavior pass.
3. **Passed — SQLite outbox latency:** separate web and worker processes deliver a WAL-backed
   durable outbox without gaps or duplicates, classify observed busy/locked outcomes, and recover an
   expired claim after hard worker termination.
4. **Passed — chat batching:** use ordered 150 ms token/thinking batches. One, four, and eight
   concurrent runs meet the selected write/delay policy, while tool/item, terminal, cancel, and
   completion boundaries flush immediately.
5. **Passed — TanStack DB adapter:** the exact-pinned local adapter proves snapshot replacement,
   direct batch writes, query-cache synchronization, optimistic-conflict resolution, forwarded
   cancellation, and subscription teardown without duplicate rows.
6. **Passed — Drizzle on Bun SQLite:** synchronous transactions, prepared-statement lifetime,
   native access, constraints/indexes/query plans, schema validation, migrations, checkpoint,
   backup, restore, and integrity pass on the exact candidate.
7. **Passed — Bun canary shutdown:** two service generations prove readiness withdrawal, SSE and
   Gateway closure, prepared-statement/database disposal, worker-lease recovery, process-group
   cleanup, WAL recovery, and bounded Effect-owned graceful-to-force listener shutdown.
8. **Passed — resource budgets:** capped sequential build, test, SQLite, chat, shutdown, and child
   cancellation runs complete without high/max/OOM events, memory pressure, or leaked resources.

The exact candidate qualification additionally covers raw RFC 6455 continuation and fragmented
UTF-8 reassembly, protocol/application size closes, deterministic cancellation, and explicit
absence of reconnect. The source-derived inventory accounts for 156 HTTP operations plus `/ws`.

The OpenClaw audit is deliberately point-in-time. The Phase 2 one-shot verifier records the
installed `2026.7.2-beta.7 (dabe191)` protocol-v4 behavior, but it does not qualify persistent
transport. Repeat the installed-source/protocol audit before every later OpenClaw integration
slice; do not infer current protocol requirements from legacy Dashboard implementation details.

A failed spike changes the design before implementation. It does not create a permanent dual
path.

## Definition of Done

The rewrite is ready only when all of the following are true:

- every item in the frontend parity table has an automated acceptance test or named manual
  check with evidence;
- every old endpoint is accounted for without preserving the old contract;
- Bun runtime and generated docs agree on the 1.4 channel policy, the lockfile pins a compatible
  `bun-types` snapshot, and each immutable artifact records its exact resolved runtime revision;
- tRPC queries/mutations and SSE subscriptions pass adapter, reconnect, resync, abort, and
  backpressure tests on the production Bun revision;
- Gateway chat passes streaming, ordering, reconciliation, restart, cancellation, and
  attachment tests against recorded fixtures and a live smoke session;
- incident notifications are concurrency-tested to notify once while active and again only
  after a resolved incident reappears;
- database constraints, query plans, migrations, backup, restore, retention, WAL, and paired
  rollback are verified;
- greenfield bootstrap provisions the same canonical `<project-root>/production/state` root for web
  and worker, and activation fails before pointer promotion on ancestor ownership, mode, symlink,
  or identity drift;
- the Drizzle schema, generated fresh baseline, and an introspected freshly initialized database
  agree in CI;
- authentication, step-up, automation scopes, dangerous adapters, file boundaries, secret
  redaction, and audit behavior pass security review;
- generated docs are complete, deterministic, CI-checked, and visible at `/docs` without secret
  disclosure;
- oxfmt, typed Oxlint, TypeScript, Bun tests, coverage gates, build, bundle budgets, and
  release preflight pass;
- web, worker, child jobs, streams, caches, logs, and test/build commands have observed resource
  bounds below their cgroup limits;
- production smoke checks cover every major external dependency and one safe worker job;
- the new source contains no REST compatibility API, old browser WebSocket protocol, schema
  compatibility layer, legacy fallback, or old-payload parser; and
- no code, script, migration, or test fixture imports data from the old database.

## Official Documentation Reviewed

The architectural recommendations above were checked against current official documentation,
not package memory alone:

### Bun

- [Bun in Rust](https://bun.com/blog/bun-in-rust)
- [HTTP routing](https://bun.com/docs/runtime/http/routing)
- [WebSockets](https://bun.com/docs/runtime/http/websockets)
- [`bun:sqlite`](https://bun.com/docs/runtime/sqlite)
- [`bun test`](https://bun.com/docs/test)
- [Full-stack development server and HTML imports](https://bun.com/docs/bundler/fullstack)
- [Official canary release asset](https://github.com/oven-sh/bun/releases/tag/canary)
- [Latest audited Bun commit](https://github.com/oven-sh/bun/commit/17d6843606d76620cb55d31424d7fb0aed51c367)

### tRPC and validation

- [tRPC documentation](https://trpc.io/docs)
- [Fetch adapter](https://trpc.io/docs/server/adapters/fetch)
- [Subscriptions and SSE](https://trpc.io/docs/server/subscriptions)
- [TanStack React Query client](https://trpc.io/docs/client/tanstack-react-query)
- [Validators](https://trpc.io/docs/server/validators)
- [Procedure metadata](https://trpc.io/docs/server/metadata)
- [Data transformers](https://trpc.io/docs/server/data-transformers)
- [Valibot JSON Schema](https://valibot.dev/guides/json-schema/)
- [SuperJSON](https://github.com/flightcontrolhq/superjson)

### Effect

- [Effect-oriented coding-agent workflow](https://www.effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive)
- [Effect 4 migration and beta API map](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/MIGRATION.md)
- [Scoped `acquireRelease` resources](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/ai-docs/src/01_effect/05_resources/10_acquire-release.ts)
- [Schema-backed tagged errors and `catchTags`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/ai-docs/src/01_effect/04_errors/10_catch-tags.ts)

### React and TanStack

- [React Compiler installation](https://react.dev/learn/react-compiler/installation)
- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)
- [TanStack DB overview](https://tanstack.com/db/latest/docs/overview)
- [Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection)
- [TanStack Router](https://tanstack.com/router/latest/docs/framework/react/overview)
- [Router search-parameter validation](https://tanstack.com/router/latest/docs/framework/react/guide/search-params)
- [TanStack Form validation](https://tanstack.com/form/latest/docs/framework/react/guides/validation)
- [TanStack Store React quick start](https://tanstack.com/store/latest/docs/framework/react/quick-start)
- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction)
- [TanStack Pacer](https://tanstack.com/pacer/latest/docs/overview)
- [TanStack Markdown](https://tanstack.com/markdown/latest/docs/overview)
- [TanStack Highlight](https://tanstack.com/highlight/latest/docs/overview)
- [TanStack Charts](https://tanstack.com/charts/latest/docs/overview)
- [Recharts](https://www.npmjs.com/package/recharts)
- [React Resizable Panels](https://www.npmjs.com/package/react-resizable-panels)
- [Motion for React](https://motion.dev/docs/react)
- [SWR](https://swr.vercel.app/)

### Database, security, and tooling

- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [SQLite partial indexes](https://www.sqlite.org/partialindex.html)
- [Drizzle Bun SQLite integration](https://orm.drizzle.team/docs/sqlite/connect-bun-sqlite)
- [Drizzle parameterized SQL operator](https://orm.drizzle.team/docs/sqlite/sql)
- [Drizzle Valibot integration](https://orm.drizzle.team/docs/valibot)
- [Drizzle Kit check](https://orm.drizzle.team/docs/drizzle-kit-check)
- [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server/)
- [Oxc type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware)
- [Oxfmt](https://oxc.rs/docs/guide/usage/formatter)

All direct dependencies were also checked through the package registry at the audit time. When
implementation begins, repeat both the registry audit and the official-documentation review for
every retained or newly introduced architectural dependency.
