# Greenfield Phase Two Threat Model

> **Status:** Phase 2 exit evidence for the greenfield server implementation.
>
> **Audit date:** 2026-08-06.
>
> **Scope limit:** This document covers trust and transport through authentication, MFA,
> WebAuthn, automation credentials, authenticated SSE, and the first-user Gateway credential
> probe. It does **not** claim that the browser UI, a persistent OpenClaw Gateway client, chat,
> privileged worker adapters, production cutover, or the complete rewrite is qualified.

## Protocol Authority

The Gateway probe was designed after inspecting the OpenClaw version installed on the target
host: `OpenClaw 2026.7.2-beta.7 (dabe191)`. The point-in-time audit covered the installed
`openclaw/docs/gateway/protocol.md` plus the installed compiled protocol, client, and WebSocket
server exports. Those sources define the current text-JSON-only protocol-v4 challenge, `connect`
request, structured error details, and `hello-ok` response.

For this installed release, Dashboard uses the trusted local-backend form: client ID
`gateway-client`, mode `backend`, protocol range `4..4`, and no device identity. Composition
accepts only an explicit root-path `ws://127.0.0.1:<port>/` or `ws://[::1]:<port>/` endpoint, with
no DNS name, TLS/remote endpoint, userinfo, query, or fragment. The production socket is created by
the backend without a browser Origin. Remote `wss://` requires device identity/pairing and is
outside this slice.

The probe waits for `connect.challenge` and submits the candidate through
`connect.params.auth.token`. It requests `operator.admin` only because this OpenClaw release
exposes `snapshot.authMode` to an admin-scoped handshake. It sends no post-connect RPC and
initiates close after the terminal outcome is known. Success requires a matching protocol-4
`hello-ok`, operator role, negotiated `operator.admin`, and
`snapshot.authMode: "token"`. This prevents an auth-disabled Gateway from accepting an arbitrary
candidate. Only structured `AUTH_TOKEN_MISMATCH` is classified as an invalid credential. Other
errors, malformed frames, close/error events, or incompatible protocol results fail closed as
Gateway unavailability.

The verifier accepts exactly one text challenge of at most 4 KiB followed by exactly one matching
text response. After sending `connect`, the response ceiling is the installed protocol's current
25 MiB maximum so a valid `hello-ok` snapshot can be received. Binary frames are unavailable;
unknown events or frame types, duplicate challenges, response-before-challenge, wrong response ID,
and contradictory success/error shapes fail immediately while verification is active. None is
treated as an ignorable protocol extension.

The HTTP upgrade carries no `Origin`, `Authorization`, `Forwarded`, `X-Forwarded-For`, or
`Sec-WebSocket-Protocol` header, and the credential never appears in the URL. It exists only in the
text `connect` frame after the challenge. The verifier has no internal reconnect or retry,
including for `startup-sidecars`; an operator or client retries the complete HTTP bootstrap request
under its durable cooldown policy.

Every future OpenClaw integration slice must repeat this audit against the version then installed
and record the result before changing protocol code. Current-production Dashboard Gateway, chat,
sessions, agents, and cron code is parity evidence only; it is not protocol authority and may be
replaced. In particular, this one-shot probe is not evidence for Phase 4's future persistent
Gateway connection, event recovery, session, or chat behavior.

## Security Objectives And Assets

| Asset or invariant               | Required protection                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Password hashes                  | Canonical bounded Argon2id parameters; no plaintext, attacker-selected work factor, or hash leakage.                                             |
| Session and pending-login tokens | Independent opaque validators, hashes at rest, narrow cookies, expiry, revocation, and authentication-version checks.                            |
| TOTP and recovery material       | Encrypted TOTP seeds, hashed recovery validators, atomic replay prevention, and no secret-bearing audit metadata.                                |
| WebAuthn state                   | Fixed RP trust policy, short-lived single-use challenges, public-key-only credential storage, and atomic counter/state updates.                  |
| Automation credentials           | Server-generated one-time tokens, domain-bound hashes at rest, exact capabilities, staged rotation, and immediate revocation/disable effects.    |
| Audit ledger                     | Redacted allowlisted metadata, atomic writes with state changes, and append-only persistence.                                                    |
| Realtime authorization           | Session/capability authorization before subscription, renewable leases, resumable cursors, and bounded consumers.                                |
| Gateway bootstrap credential     | In-memory one-shot verification only; never persisted, logged, audited, or returned.                                                             |
| Request provenance               | Exact Origin/Fetch Metadata and trusted-proxy handling before authentication or expensive work.                                                  |
| Availability budgets             | Bounded request bodies, Gateway frames, queues, concurrency, deadlines, rolling work budgets, durable cooldowns, and close-confirmed settlement. |

## Actors And Trust Boundaries

| Actor                                       | Trust and authority                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Operator browser                            | May hold a hardened Dashboard session cookie. It is still untrusted input and cannot assert recent authentication or capabilities.        |
| Automation caller                           | Presents one bearer credential and receives only the principal's exact registered capabilities. It cannot administer automation security. |
| Remote attacker                             | May submit cross-site requests, malformed bodies, guessed credentials, replayed proofs, or concurrency floods.                            |
| Trusted reverse proxy                       | The only component allowed to assert forwarded client identity and the absolute inbound body deadline.                                    |
| Dashboard web process                       | Owns request policy, the process `ManagedRuntime`, security services, and SQLite access. It is not a secret-free boundary.                |
| SQLite database                             | Durable authority for identities, validators, cooldowns, challenges, authorization versions, audit, and realtime events.                  |
| OpenClaw Gateway                            | External authority for the submitted Gateway token. During Phase 2 it is contacted only by the one-shot bootstrap probe.                  |
| Future worker and persistent Gateway client | Outside this threat-model closure; their adapters and protocols require separate qualification.                                           |

The security-relevant crossings are browser or automation caller to Dashboard, trusted proxy to
Dashboard, Dashboard to SQLite, Dashboard to the local OpenClaw Gateway, and Dashboard event
producer to authenticated SSE consumer. No bearer token is accepted in an SSE URL, no request
header can select the WebAuthn RP, and no automation credential can cross the browser-session-only
security-administration boundary.

## Misuse Cases, Controls, And Executable Evidence

| Misuse case                                                                                                                                          | Control                                                                                                                                                                                                                                                                                                                                             | Executable evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two unauthenticated callers race first-user creation.                                                                                                | Recheck the empty-user invariant in one immediate transaction; publish user/session only after Gateway and Argon2 work succeeds.                                                                                                                                                                                                                    | `src/server/domains/security/authenticationLifecycle.bootstrap.test.ts`; `src/server/test/system/serverGatewayCredentialVerification.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A guessed password or bootstrap token consumes unbounded CPU or bypasses cooldowns by rotating usernames/sources.                                    | Hashed source and global durable buckets, process rolling budgets, bounded admission, queued cooldown recheck, and active-permit retention through failure settlement.                                                                                                                                                                              | `src/server/domains/security/authenticationLifecycle.rateLimit.test.ts`; `src/server/domains/security/authenticationWorkBudget.test.ts`; `src/server/domains/security/authenticationWorkGate.test.ts`                                                                                                                                                                                                                                                                                                                                                             |
| A corrupt password row selects excessive Argon2 work.                                                                                                | Validate the one canonical PHC form and parameters before invoking Bun.                                                                                                                                                                                                                                                                             | `src/server/domains/security/authenticationLifecycle.password.test.ts`; `src/server/database/migrations/securityIdentitySchema.browser.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A stolen, stale, replaced, or future-dated session remains usable.                                                                                   | Hash validators at rest; enforce idle/absolute expiry, authentication version, rotation/revocation, and fail-closed clock checks.                                                                                                                                                                                                                   | `src/server/domains/security/authenticationLifecycle.sessions.test.ts`; `src/server/domains/security/requestAuthenticationSession.test.ts`; `src/server/test/system/serverAuthenticationResponses.test.ts`                                                                                                                                                                                                                                                                                                                                                        |
| Cross-site or ambiguous credentials reach authentication work.                                                                                       | Exact Origin and Fetch Metadata policy, exact trusted-proxy allowlist, body budgets, no-store responses, and rejection of simultaneous cookie plus bearer credentials.                                                                                                                                                                              | `src/server/test/system/serverAuthenticationTransport.test.ts`; `src/server/rawHttp/authenticationCredentials.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A TOTP step or recovery code is replayed, or concurrent proofs both win.                                                                             | Revalidate pending/session state and consume proof by compare-and-swap in the same immediate transaction as session rotation and audit.                                                                                                                                                                                                             | `src/server/domains/security/mfa/loginLifecycle.totp.test.ts`; `src/server/domains/security/mfa/loginLifecycle.recovery.test.ts`; `src/server/domains/security/mfa/accountLifecycle.proofs.test.ts`; `src/server/test/system/serverMfaAuthentication.test.ts`                                                                                                                                                                                                                                                                                                     |
| Factor removal or MFA disable strands or silently preserves sessions.                                                                                | Count usable TOTP plus current-RP WebAuthn factors transactionally; final-factor protection; disable removes all MFA state, rotates the current session, and removes every other session.                                                                                                                                                           | `src/server/domains/security/mfa/accountLifecycle.factors.test.ts`; `src/server/domains/security/mfa/accountLifecycle.maintenance.test.ts`; `src/server/test/system/serverMfaAuthentication.test.ts`                                                                                                                                                                                                                                                                                                                                                              |
| A WebAuthn response replays, crosses purpose/session/RP boundaries, leaks raw ceremony data, or races a counter update.                              | Fixed RP ID/origins and ES256 policy, bounded preflight, one short-lived replaced challenge consumed on first admitted verification, public-key-only storage, and credential counter compare-and-swap.                                                                                                                                              | `src/server/domains/security/mfa/webauthn/relyingPartyConfiguration.test.ts`; `src/server/domains/security/mfa/webauthn/adapter.test.ts`; `src/server/domains/security/mfa/webauthn/credentialState.test.ts`; `src/server/domains/security/mfa/accountLifecycle.webAuthn.test.ts`; `src/server/domains/security/mfa/loginLifecycle.webAuthn.test.ts`; `src/server/test/system/serverWebAuthnAuthentication.test.ts`                                                                                                                                               |
| An automation token escalates capabilities, self-administers, survives revocation, or is lost during rotation.                                       | Exact capability membership, browser-session-only administration with transactional recent-MFA revalidation, authorization-version CAS, staged replacement, explicit revoke, terminal disable, and renewable lease validation.                                                                                                                      | `src/server/domains/security/automation/lifecyclePrincipal.test.ts`; `src/server/domains/security/automation/lifecycleCredential.test.ts`; `src/server/domains/security/automation/lifecycleRepository.test.ts`; `src/server/domains/security/automation/procedures.test.ts`; `src/server/domains/security/requestAuthenticationAutomation.test.ts`; `src/server/test/system/serverAutomationSecurity.test.ts`; `src/server/test/system/serverAutomationSecurityLostResponse.test.ts`; `src/server/test/system/serverAutomationSecurityLeaseInvalidation.test.ts` |
| Secret material appears in list output, errors, logs, or audit.                                                                                      | Output schemas omit validators/hashes, secret-return procedures expose a token once, errors are redacted, and audit persists only allowlisted metadata.                                                                                                                                                                                             | `src/server/domains/security/automation/procedures.test.ts`; `src/server/test/system/serverAutomationSecurity.test.ts`; `src/server/test/system/serverGatewayCredentialVerification.test.ts`                                                                                                                                                                                                                                                                                                                                                                      |
| An SSE subscriber requests unauthorized topics, retains revoked authority, creates a replay gap, or consumes unbounded memory.                       | Authorize before pump access, renew the authentication lease, use durable tracked cursors, reject invalid gaps, bound each subscriber, and disconnect slow consumers.                                                                                                                                                                               | `src/server/domains/realtime/procedures.test.ts`; `src/server/domains/realtime/authenticationLeaseStream.test.ts`; `src/server/platform/realtime/eventPumpSubscriptionReplay.test.ts`; `src/server/platform/realtime/eventPumpSubscriptionBackpressure.test.ts`; `src/server/test/system/serverRealtime.test.ts`; `qualification/realtime/eventFeed.test.ts`; `qualification/topology/rollingReleaseSse.test.ts`; `qualification/resources/pausedTlsSseClient.test.ts`                                                                                            |
| Configuration redirects the device-less verifier off the trusted local backend or puts the credential in upgrade metadata.                           | Accept only literal IPv4/IPv6 loopback `ws://` with an explicit port and root path; reject DNS, remote, `wss://`, userinfo, path, query, and fragment forms. Send no Origin, authorization, proxy, or subprotocol header and no token-bearing URL.                                                                                                  | `src/server/platform/gateway/gatewayCredentialVerifier.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A fake or auth-disabled Gateway sends binary, unknown, malformed, oversized, duplicate, out-of-order, wrong-ID, contradictory, or permissive frames. | Accept text JSON only; cap the challenge at 4 KiB and current installed hello at 25 MiB; allow exactly challenge plus matching response; require operator role, `operator.admin` requested only for this handshake, and token auth mode; fail every unknown or contradictory frame immediately; classify only structured token mismatch as invalid. | `src/server/platform/gateway/gatewayCredentialProtocol.test.ts`; `src/server/platform/gateway/gatewayCredentialVerifier.test.ts`; `src/server/test/system/serverGatewayCredentialVerification.test.ts`                                                                                                                                                                                                                                                                                                                                                            |
| Gateway startup or transport unavailability creates an internal retry storm or bypasses durable throttling.                                          | Never reconnect or retry inside the verifier, including `startup-sidecars`; redact the failure and require the operator/client to retry the whole HTTP bootstrap request under durable cooldown.                                                                                                                                                    | `src/server/platform/gateway/gatewayCredentialVerifier.test.ts`; `src/server/test/system/serverGatewayCredentialVerification.test.ts`; `src/server/domains/security/authenticationLifecycle.rateLimit.test.ts`                                                                                                                                                                                                                                                                                                                                                    |
| A success, failure, setup error, or abort settles Effect work while the native socket remains alive.                                                 | Once a socket exists, every terminal path initiates close and the Promise remains pending until native close is observed; the enclosing Effect permit therefore remains held until the transport actually settles.                                                                                                                                  | `src/server/platform/gateway/gatewayCredentialVerifier.test.ts`; `src/server/domains/security/authenticationWorkGate.test.ts`; `src/server/test/system/serverGatewayCredentialVerification.test.ts`                                                                                                                                                                                                                                                                                                                                                               |
| A schema or migration weakens a security invariant.                                                                                                  | One checksummed unpublished baseline, strict tables, constraint/introspection tests, and Drizzle no-drift checks.                                                                                                                                                                                                                                   | `src/server/database/migrations/securityIdentitySchema.baseline.test.ts`; `src/server/database/migrations/securityIdentitySchema.automation.test.ts`; `src/server/database/migrations/mfaLifecycleSchema.test.ts`; `src/server/database/migrations/migrationGraph.test.ts`                                                                                                                                                                                                                                                                                        |

## Selective Effect Boundary

Effect owns process-lifetime orchestration where interruption or lifetime matters: separate bounded
Gateway, Argon2, TOTP, and WebAuthn gates; queues; rolling work budgets; deadlines; cancellation;
tagged failures; and fibers retained until non-cooperative work actually settles. The native
Gateway adapter initiates close on success, rejection, listener-setup failure, transport error, or
abort, and its Promise settles only after the native close is observed. The Effect permit therefore
cannot be released while the socket is still live. Gateway and WebAuthn libraries remain
Promise-facing adapters inside that boundary.

Valibot parsing, deterministic state policy, token generation and hashing, constant-time compare,
audit redaction, and synchronous SQLite immediate-transaction callbacks remain ordinary
TypeScript. An `async` function or `await` alone is not a reason to add an Effect service, and no
request constructs its own runtime.

## Residual Risks And Deferred Work

- The one-shot v4 Gateway credential probe does not qualify a persistent connection, reconnect,
  event ordering, snapshot/resync, session operations, chat streaming, or OpenClaw cron behavior.
  Those remain Phase 4 or later work.
- OpenClaw is versioned independently. A later installed release may change protocol fields,
  roles, scopes, error details, or trusted-backend policy; integration work must re-audit it.
- Bun's native WebSocket allocates the incoming wire frame before the application can apply its
  4 KiB/25 MiB text limits. Literal loopback composition, the installed Gateway's own protocol
  limits, and bounded verifier concurrency reduce exposure, but the application check is not a
  pre-allocation network-frame limit.
- The Phase 2 tests consume complete native text `MessageEvent` values. Raw continuation-frame
  reassembly remains an explicit Phase 0 Bun-candidate qualification gate rather than a claimed
  property of this one-shot verifier.
- The reverse proxy, not Bun's already-buffered Fetch handler, owns the absolute inbound body-read
  deadline. Production cutover must verify that ingress configuration.
- Process-local admission and rolling budgets assume one web process. A multi-process topology
  would require a separately designed shared admission policy.
- Wall-clock rollback is handled fail-closed for persisted security timestamps, but host time
  integrity remains an operational dependency.
- Host, process-memory, SQLite-file, Doppler, or OpenClaw compromise is outside application-level
  credential isolation and requires operating-system and infrastructure controls.
- Browser UI behavior, accessibility, full parity, production credential cutover, worker-owned
  privileged actions, backup/restore, and release rollback remain later phase gates.

## Phase 2 Exit Evidence

Phase 2 is closed only for the server-side scope stated above. The evidence consists of:

1. focused unit, repository, lifecycle, adapter, and system tests at the exact paths in the misuse
   table;
2. `bun run typecheck:server`, `bun run test:server`, and the security-relevant qualification
   suites;
3. `bun run test:server:docs`, `bun run docs:check`, and `bun run db:check`; and
4. the explicit remaining-phase status in
   `docs/architecture/greenfield-rewrite/progress.md`.

Passing this gate authorizes the next stacked implementation slice. It does not satisfy the full
rewrite definition of done in `docs/architecture/greenfield-rewrite/implementation-plan.md`.
