# Authentication and trust boundaries

## Host-local password recovery

Forgotten-password recovery is deliberately outside the browser, HTTP, tRPC, WebSocket, and
automation-credential trust boundaries. It requires an interactive terminal on the Dashboard
host and executes the recovery artifact from the active immutable release with its pinned Bun
runtime. No network endpoint can invoke it, and the password is never accepted in argv or the
environment.

The CLI verifies the project layout, active release identity, runtime revision, private state
directory, database ownership, and database migration state before mutation. Password hashing
happens before the write transaction. The transaction then compare-and-swaps the user's current
authentication state, updates the password once, revokes sessions and in-flight authentication
ceremonies, clears only user-scoped account-password/account-MFA cooldowns, and records a redacted
system audit event. `--reset-mfa` additionally removes every MFA factor and recovery code; without
that flag, confirmed MFA remains intact while unconfirmed authenticator enrollment is discarded.
Any concurrency conflict or persistence failure rolls the entire operation back.

The active-release executable is required release inventory but is not a long-running process
role. This keeps break-glass authority out of both systemd services and normal application
configuration while ensuring the reviewed code and runtime exactly match production.
