# Storybook

Storybook is the browser-only component workbench for the greenfield Dashboard. Bun remains the
runtime for application development, tests, coverage, and production builds; Vite is a
Storybook-only development dependency.

## Commands

```bash
bun run storybook
bun run storybook:test
bun run storybook:build
```

The development server listens on port 6006. The static verification build is written under
`dist/storybook`. The real-browser test command runs every story and `play` function in headless
Chromium, with accessibility violations configured as errors. Both commands run in a separate CI
job so they do not extend the coverage job's critical path. On a new development machine, install
the pinned browser once with `bun run storybook:install-browser`. The project-local browser cache
keeps Storybook's Playwright version isolated from other tools on the same host.

Storybook trusts only its directly bound host by default. A development proxy with a different DNS
host must set `MIRA_DASHBOARD_STORYBOOK_ALLOWED_HOST` to that exact lowercase DNS name. Schemes,
ports, wildcards, IP addresses, whitespace, and invalid DNS labels are rejected. Keep the variable
unset for ordinary local development and static verification builds. The browser-facing proxy
listener stays on the documented port 6006 even when the upstream Storybook process binds a
different loopback port; the same configuration keeps Vite's WebSocket client on that public port.

Story files run through three Chromium workers. This keeps local and CI resource use predictable and
avoids cross-file browser state while the faster Bun and Happy DOM suites continue to use three
timing-balanced workers. The Storybook runner also applies the repository test-output policy, so an
unexpected browser `console.error` or unhandled error fails CI even when Vitest would otherwise
return success. Browser diagnostics are not filtered or suppressed; stories that exercise an error
state must model it without leaking an unexpected console or lifecycle diagnostic.

Both the Storybook manager and component canvas use a dark theme by default. The canvas imports
a Storybook-only Tailwind entrypoint that shares the production base styles and theme while adding
story sources to its own class inventory. Production CSS explicitly excludes stories and story
support. AutoDocs uses the dark documentation theme and restores scrolling inside its iframe.

## Version policy

All Storybook packages are pinned together at `10.6.0-alpha.5`. That release contains the
required Headless UI focus instrumentation fix and the TanStack Router fixes used by the route
stories. Do not use a floating `next`, `alpha`, or `beta` tag. Upgrade the complete Storybook
set together when a stable 10.6 release contains the same fixes.

## Story ownership

Stories use `*.stories.tsx` and live in a `stories/` directory owned by the component or feature
area, for example `src/browser/ui/stories/`. Browser-safe shared story providers belong in an
explicit `storySupport/` directory. Do not import test setup, server code, environment authority,
or production API clients into stories.

The source-boundary checker gives stories their own non-production role and gives Storybook/Vitest
configuration a separate tooling role. Production browser code cannot import stories or story
support, and story files do not count toward Bun production coverage. Storybook real-browser tests
supplement rather than replace focused Bun/Happy DOM tests.

AutoDocs documents React component props and examples. The generated tRPC, JSON Schema, raw HTTP,
realtime, configuration, and runtime references under `docs/generated/` remain the canonical API
and operations documentation.
