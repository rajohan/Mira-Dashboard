# Greenfield Rewrite Blueprint

> **Status:** implementation active. Phases 0 and 1 are complete, Phase 2 is complete for its
> stated server scope, and Phase 5 now has implemented Files, Logs, and interactive Terminal
> verticals. The remaining browser, domain, Gateway/chat, privileged, hardening, and cutover gates
> are incomplete. The rewrite now occupies the repository root and the retired implementation has
> been removed. Production is unchanged until a reviewed root-layout candidate is activated. The
> application targets a fresh database with no compatibility layer.
>
> **Audit date:** 2026-08-06. Package versions and the Bun canary snapshot in this document
> are point-in-time facts. They are rechecked during an explicit candidate-promotion round,
> not for ordinary feature or review commits.

## Blueprint Map

- [Implementation progress](greenfield-rewrite/progress.md) records completed qualification and delivery milestones.
- [Repository simplification audit](greenfield-rewrite/simplification-audit.md) records root promotion, test review, dead-code controls, and every retained `node:*` capability category.
- [Application architecture](greenfield-rewrite/application-architecture.md) defines the modular-monolith boundaries, API, realtime, and frontend design.
- [Data and security](greenfield-rewrite/data-and-security.md) defines SQLite, privileged operations, authentication, and trust boundaries.
- [Runtime and delivery](greenfield-rewrite/runtime-and-delivery.md) covers the Bun baseline, configuration, documentation, operations, quality gates, deployment, packages, and cutover.
- [Implementation plan](greenfield-rewrite/implementation-plan.md) contains the phased sequence, open decisions, definition of done, and reviewed sources.
- [Security threat model](../security/security-threat-model.md) records the trust-and-transport assets, misuse cases, controls, executable evidence, and residual risks.
