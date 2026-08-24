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

### Phase 1: foundation

- create source boundaries, configuration, logging, errors, contract registry, Drizzle/native
  SQLite layer, migration runner, outbox, and generated docs;
- create immutable build/release manifests and resource-capped development/test scripts; and
- implement probes and observability.

**Exit gate:** empty database, docs, build, web, worker, and paired rollback work end-to-end.

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

## Mandatory Spikes and Open Decisions

The target choices are fixed unless one of these tests disproves the underlying assumption:

1. **Bun full-stack build:** verify React Compiler-first transforms, Tailwind, lazy chunks,
   source maps, CSP, asset hashes, precompression, and bundle budgets. Then select exactly one
   production build path.
2. **tRPC SSE on exact Bun:** verify credentials, aborts, tracked resume, error shapes,
   reverse-proxy behavior, deploy reconnect, and slow-consumer memory.
3. **SQLite outbox latency:** measure adaptive polling with web/worker processes under chat and
   job load. Keep the database authoritative; change only the wakeup mechanism if latency or
   I/O misses the target.
4. **Chat batching:** determine the smallest durable delta interval that preserves current
   visual streaming while bounding SQLite writes and restart loss.
5. **TanStack DB adapter:** prove snapshot replacement, direct batch writes, query-cache
   synchronization, optimistic-conflict handling, and route teardown without duplicate rows.
6. **Drizzle on Bun SQLite:** verify sync transactions, prepared statements, the `sql` tagged
   template, partial/unique indexes, generated migrations, Valibot row schemas, native-client
   access, and query plans on the exact pinned Drizzle version and resolved Bun qualification
   candidate.
7. **Bun canary shutdown:** verify graceful SSE, Gateway, prepared-statement, worker lease, and
   child-process cleanup under systemd stop/restart.
8. **Resource budgets:** measure build/test and representative privileged jobs in cgroups before
   finalizing service/job limits.

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
- the Drizzle schema, generated fresh baseline, and an introspected freshly initialized database
  agree in CI;
- authentication, step-up, automation scopes, dangerous adapters, file boundaries, secret
  redaction, and audit behavior pass security review;
- generated docs are complete, deterministic, CI-checked, and visible at `/docs` without secret
  disclosure;
- oxfmt, oxlint, typed lint, TypeScript, Bun tests, coverage gates, build, bundle budgets, and
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
- [Latest audited Bun commit](https://github.com/oven-sh/bun/commit/43783cedd5653fa29bb9ac83df34633eae10fe75)

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
- [Effect 4 migration and beta API map](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.103/MIGRATION.md)
- [Scoped `acquireRelease` resources](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.103/ai-docs/src/01_effect/05_resources/10_acquire-release.ts)
- [Schema-backed tagged errors and `catchTags`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.103/ai-docs/src/01_effect/04_errors/10_catch-tags.ts)

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
