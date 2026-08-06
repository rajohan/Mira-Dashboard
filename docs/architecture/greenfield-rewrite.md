# Greenfield Rewrite Blueprint

> **Status:** implementation active. Phase 0 evidence is complete and Phase 2 is complete for its
> stated server scope; the remaining foundation, browser, domain, Gateway/chat, privileged,
> hardening, and cutover phases are not complete. The rewrite is built beside the current
> production implementation and targets a fresh database with no compatibility layer.
>
> **Audit date:** 2026-08-06. Package versions and the Bun canary snapshot in this document
> are point-in-time facts. They are rechecked during an explicit candidate-promotion round,
> not for ordinary feature or review commits.

## Blueprint Map

- [Implementation progress](greenfield-rewrite/progress.md) records completed qualification and delivery milestones.
- [Application architecture](greenfield-rewrite/application-architecture.md) defines the modular-monolith boundaries, API, realtime, and frontend design.
- [Data and security](greenfield-rewrite/data-and-security.md) defines SQLite, privileged operations, authentication, and trust boundaries.
- [Runtime and delivery](greenfield-rewrite/runtime-and-delivery.md) covers the Bun baseline, configuration, documentation, operations, quality gates, deployment, packages, and cutover.
- [Implementation plan](greenfield-rewrite/implementation-plan.md) contains the phased sequence, open decisions, definition of done, and reviewed sources.
- [Phase 2 threat model](../security/greenfield-phase-two-threat-model.md) records the trust-and-transport assets, misuse cases, controls, executable evidence, and residual risks.
