# Greenfield Rewrite Blueprint

> **Status:** implementation active. Foundations, trust/transport, core operator domains, and the
> privileged/external domain surface are complete. Gateway/chat production proof and the final
> hardening, rehearsal, activation, and monitoring gates remain open. The rewrite occupies the
> repository root, the retired implementation is removed, and the application targets a fresh
> database with no compatibility layer. Production remains unchanged until the exact reviewed
> release passes the remaining cutover gates.
>
> **Audit date:** 2026-08-23. Current package and runtime versions are generated into the
> packages-and-runtime reference and rechecked during candidate promotion.

## Blueprint Map

- [Implementation status](greenfield-rewrite/progress.md) records the current phase state, Overview composition, and remaining release gates.
- [Repository simplification audit](greenfield-rewrite/simplification-audit.md) records root promotion, test review, dead-code controls, and every retained `node:*` capability category.
- [Application architecture](greenfield-rewrite/application-architecture.md) defines the modular-monolith boundaries, API, realtime, and frontend design.
- [Data and security](greenfield-rewrite/data-and-security.md) defines SQLite, privileged operations, authentication, and trust boundaries.
- [Runtime and delivery](greenfield-rewrite/runtime-and-delivery.md) covers the Bun baseline, configuration, documentation, operations, quality gates, deployment, packages, and cutover.
- [Implementation plan](greenfield-rewrite/implementation-plan.md) contains the phased sequence, open decisions, definition of done, and reviewed sources.
- [Security threat model](../security/security-threat-model.md) records the trust-and-transport assets, misuse cases, controls, executable evidence, and residual risks.
