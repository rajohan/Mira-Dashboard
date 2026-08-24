# Local Development

The repository owns one source-watched development stack. It runs the browser, web process,
worker, authentication, SQLite state, files, jobs, chat, and terminal through the same application
composition used by release processes while keeping development state and host capabilities
isolated.

## Start

Use the Bun revision selected by `.bun-version` and install the frozen dependency graph. Before
starting the stack, provide its Gateway credential through either `OPENCLAW_GATEWAY_TOKEN` or the
absolute owner-only file named by `MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE`, and export the worker-only
`MOLTBOOK_API_KEY`. `MOLTBOOK_AGENT_NAME` remains optional and defaults to `mira_2026`. Then start
the loopback stack:

```bash
bun install --frozen-lockfile
bun run dev
```

The plain command has no secret-manager dependency. On the owner host, the explicit
`bun run dev:doppler` convenience wrapper loads the required Gateway and Moltbook credentials plus
optional session durations from the configured Doppler project before invoking the same stack
entrypoint.

The default listeners are:

- browser and API proxy: `http://localhost:3205` (`127.0.0.1:3205` listener);
- web process: `127.0.0.1:3206`;
- remote Host/HMR bridge when `dev:remote` is active: `127.0.0.1:3207`;
- optional Tailscale HTTPS route: port `3445`.

`bun run dev` couples all three child lifecycles. Bun's full-stack server owns HTML bundling, React
Fast Refresh, and browser HMR. The web and worker processes run with `--watch`. A child failure or
`SIGINT`/`SIGTERM` stops the complete stack; a repeated stop signal escalates to a bounded forceful
shutdown. Linux parent-death guards also terminate the three direct children if the coordinator is
killed without a cleanup opportunity.

## Bun HMR And React Compiler

The browser development path follows Bun's native contracts:

- `src/browser/index.html` is imported and passed directly to `Bun.serve({ routes })`;
- `development: { hmr: true, console: true }` enables Bun HMR and browser-console forwarding;
- `[serve.static]` in `bunfig.toml` runs the existing React Compiler plugin before Tailwind for
  every development bundle;
- the browser entry uses direct `import.meta.hot.data` access to retain one React root across hot
  module evaluation; Bun's React Fast Refresh runtime preserves eligible component state;
- production builds use the same compiler-first plugin order, while Bun removes the HMR-only data
  holder.

The implementation is anchored to Bun's official documentation:

- [Hot reloading](https://bun.com/docs/bundler/hot-reloading)
- [Fullstack dev server](https://bun.com/docs/bundler/fullstack)

`scripts/development/developmentFrontend.test.ts` boots the real Bun development server and proves
that the served client contains the HMR transport, React Fast Refresh runtime, retained root, and
React Compiler output.

## Remote HTTPS

For a stable WebAuthn origin and access from another Tailscale device:

```bash
bun run dev:remote
```

This command uses the same exported Gateway-token or token-file and `MOLTBOOK_API_KEY` contract as
`bun run dev` and does not require Doppler. The corresponding owner-host convenience wrapper is
`bun run dev:remote:doppler`.

The command verifies that port `3445` is free or already maps exactly to the loopback remote bridge,
creates `https://<MagicDNS>:3445 -> http://127.0.0.1:3207 -> http://127.0.0.1:3205` when needed,
and uses separate remote state. The bridge rewrites the public Host header required by Tailscale to
the fixed Bun frontend target. It rewrites Origin only for Bun's `/_bun/hmr` WebSocket; application
WebSockets retain the public HTTPS Origin and their subprotocols.

One host-local lock owns the dedicated Tailscale port from status inspection through route
activation, runtime, and cleanup. A concurrent route owner fails before it can mutate the route. A
route created by an invocation is removed during shutdown; a pre-existing exact route is left
untouched. Conflicting routes fail closed.

Explicit route controls are available without starting the stack:

```bash
bun run dev:remote:status
bun run dev:remote:enable
bun run dev:remote:disable
```

## Persistent Isolated State

When the source checkout is nested beneath the Dashboard project root, local and remote state
default to:

```text
<project-root>/development/state/source-local/
<project-root>/development/state/source-remote/
```

If the repository itself is the project root, that location would overlap the source tree. The local
root then falls back to
`${XDG_STATE_HOME:-~/.local/state}/mira-dashboard/development/source-local/`, with the remote root as
its `source-remote` sibling. An explicit `MIRA_DASHBOARD_DEV_STATE_ROOT` still takes precedence.

Each owner-marked root contains the Dashboard database, a persistent TOTP keyring, writable
workspace/OpenClaw roots, logs, job output, uploads, and terminal-broker state. Dev cookies are
port-namespaced and the proxy forwards only those namespaced authentication cookies, so production
cookies never authenticate the development backend.

One process-scoped lease prevents two stacks from sharing a root and blocks resets while its stack is
running. A crashed coordinator's exact stale lease is recovered only after its process identity is no
longer active; direct runtime children are parent-death guarded so they cannot continue using SQLite
after that recovery.

The database marker stores a deterministic fingerprint of the reviewed migration graph. When the
mutable pre-cutover baseline changes, the next start removes only the development SQLite database
and its sidecars, then initializes the current schema. The TOTP keyring, workspace, OpenClaw config,
and other state remain intact.

Manual resets are deliberately separate:

```bash
bun run dev:database:reset  # database and SQLite sidecars only
bun run dev:state:reset     # complete owner-marked development root
bun run dev:state:prepare
```

Both reset paths validate the exact owner marker and refuse symlinked or ambiguous targets.

## Trust Boundaries

- All listeners bind to loopback; only the explicit Tailscale Serve route publishes the browser.
- The Gateway URL must be loopback WebSocket transport, and only the required Gateway token enters
  the web/worker child environments.
- Worker task notifications stay inert in development, and log maintenance is restricted to the
  isolated state tree.
- The frontend proxy preserves compressed HTTP representations byte-for-byte, filters hop-by-hop
  and production credential headers, and enforces the terminal contract's message and backpressure
  budgets in both directions.
- Production releases, databases, services, and the existing preview route are not mutated by
  ordinary development startup.
