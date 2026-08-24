# Operator runbooks

## Fresh production host

Install the exact Bun version in `.bun-version` as a root-owned executable that is not writable by
its group or other users, plus Git, GitHub CLI, Doppler CLI, Tailscale, Docker Engine, and sudo.
Docker must be running, its `docker` group must exist, and `ubuntu` must already be able to query
the daemon in its current login session. OpenClaw must be installed and initialized first so
`/home/ubuntu/.openclaw` exists as canonical `ubuntu`-owned mode `0700` state.
Doppler must be initialized for `ubuntu` with canonical `ubuntu`-owned mode `0700`
`/home/ubuntu/.doppler` state and a single-link mode `0600` `.doppler.yaml` config file.
Authenticate those host-owned tools outside chat. Clone GitHub `main` into
`/home/ubuntu/projects/mira-dashboard/production/checkout`, ensure `origin/main` is current, then run
as `ubuntu`:

```bash
bun run bootstrap
```

The command verifies a clean exact `main`, installs the frozen graph, downloads the permanent
assets from the GitHub release for that commit, verifies their receipt and immutable manifest, stages the release and
the `.bun-version` runtime under root ownership, installs systemd/polkit provisioning, creates the
log-maintenance group grant, applies the preview Tailscale operator, prepares fresh production
state, and activates the release through readiness. It is greenfield-only and contains no legacy
discovery, migration, stopping, removal, or cleanup behavior.

If bootstrap fails, fix the first reported prerequisite and rerun it. Resolve frozen-install
failures in the lockfile on a development branch; never weaken the target-host install. Missing
assets mean the exact `main` commit has not been published as a completed semantic release yet.

## Fresh checkout and local first start

For development, run `bun run bootstrap development`. Add `--no-start`, `--with-browser`, or
`--doppler` as documented in the local-development guide.

## Production candidate preflight

Run against one clean reviewed candidate with the exact `.bun-version` runtime:

```bash
bun run preflight
```

An isolated 4-vCPU/8-GiB worker may use `bun run preflight --parallel`. It preserves install-first
and immutable-release-last ordering while running only the independent middle gates in bounded
two-command phases. Production hosts and constrained machines should keep the sequential default.
The maintained Daytona/Crabbox Bun runner transfers enough repository metadata to preserve the
current commit, branch, and configured stacked coverage base, so the ordinary command can run
there without manually reconstructing Git state. Disposable workers must still be released after
their result and artifacts are recovered.

This performs frozen install, dependency audit, static checks, formatting check, complete coverage,
Storybook build, and immutable release build sequentially. Record the candidate commit, Bun
revision, release-manifest digest, and results in cutover evidence. Preflight qualifies an artifact;
it does not provision root-owned files or activate production.

## Production rehearsal and activation

Rehearse first in a disposable project root with the same project layout, systemd bytes,
release/runtime artifact, migration graph, readiness URL, and cgroup limits as production.

1. Confirm the candidate is clean and passed `bun run preflight` unchanged.
2. Prepare project-local production state:

    ```bash
    bun run delivery prepare-state --project-root=/absolute/dashboard/project/root
    ```

3. Independently approve the release-manifest digest. Transfer the exact candidate and Bun runtime
   into the root-owned staging roots described by the host-operations provisioning README.
4. Invoke the manifest-bound root installer from that staging root. Never expose it as a package
   script or derive its trust digest from the application checkout.
5. Verify installed unit bytes and principals. The installer enables but does not start services.
6. Activate with explicit absolute paths and a loopback readiness endpoint:

    ```bash
    bun run delivery activate \
      --project-root=/absolute/dashboard/project/root \
      --release-root=/absolute/immutable/release \
      --readiness-url=http://127.0.0.1:PORT/api/health/ready
    ```

7. Verify liveness, readiness, principals, restart counts, structured logs, worker claiming, one
   safe worker job, and every major external dependency before accepting activation.

Never restart the existing `mira-dashboard.service` while rehearsing from a development worktree.
Resolve the exact service, working directory, executable, release pointers, and port before any
lifecycle operation.

## Failed activation and paired rollback

Activation is authoritative only after its record commits. Never improvise pointer or database
changes outside the activation journal.

- Before commit, preserve logs and the journal, rerun recovery with the same candidate, and prove
  that the previous release/database pair remains authoritative.
- After commit, use Delivery paired rollback so release, runtime, and database snapshot move
  together. Never roll back code without its paired database.
- If root-owned authority changed, reinstall the previous root-owned immutable release through the
  same manifest-digest handoff.
- For an unknown outcome, stop retries until activation record, pointers, journal, systemd state,
  readiness, and live process identities agree.

After recovery, verify release identities, database integrity, readiness, worker claiming, recent
jobs, and logs. Retain failed-candidate evidence until the incident is closed.

## Restore drill

The UI intentionally exposes no general database-restore control. Perform restore drills through
reviewed activation/rollback and backup-provider procedures in an isolated target:

1. Record candidate, snapshot identity, database size, WAL state, and expected schema.
2. Restore into an isolated path; never overwrite the live database during a drill.
3. Verify snapshot identity, SQLite integrity, migration graph, schema introspection, WAL handling,
   and readiness against the restored copy.
4. Exercise paired rollback across promotion and verify interrupted recovery does not replay an
   external effect.
5. Record elapsed time, peak disk/inodes and memory, result, and cleanup confirmation.

Kopia and WAL-G restore remain provider-owned. Credentials and resolved backup payloads must not
enter Dashboard arguments, logs, state, or evidence.

## External integration and credential cutover

After the Greenfield release is ready, an operator must:

- provision and smoke the dedicated PostgreSQL/PgBouncer observer and control alias;
- replace the tracked PgBouncer verifier with private runtime provisioning, rotate the affected
  credential, and retain a tested rollback;
- create the heartbeat principal with exactly `cache:read` and `monitoring:write`, atomically
  install its private credential, and CAS-update the OpenClaw heartbeat prompt; and
- prove exactly one heartbeat collection followed by one report.

Never pass secrets through arguments, URLs, messages, logs, artifacts, or evidence. Failed
credential cutover restores the prior private provider state and retries only from a known state.

## Post-cutover monitoring

Observe at least one full operational cycle before declaring Greenfield production-ready:

- readiness, liveness, restarts, cgroup resources, and disk/inode reserve;
- Gateway sessions/chat reconnect, one safe worker job, schedules, and heartbeat;
- SQLite maintenance, PostgreSQL/PgBouncer, Kopia/WAL-G, Docker updater, logs, Git, quotas,
  weather, notifications, incidents, and Delivery history; and
- current and rollback release/runtime/database identities.

Unknown activation, failed heartbeat or backup, repeated restart, readiness loss, integrity
failure, or a resource-limit event blocks completion and starts recovery.

## Account email verification and forgotten password

Bootstrap requires a valid email address and sends its verification link after creating the usable
account. Before verification, the operator can sign in and correct or resend the address under
Settings → Dashboard settings → Account email. The status badge shows **Unverified**, **Change
pending**, or **Verified**. A verified address remains the active recovery destination while a
replacement is pending, and is atomically replaced only when the new link is consumed. Links expire
after 15 minutes and can be used once. The verification result page remains visible until the
operator chooses **Continue**.

For password recovery, choose **Forgot password?** on the sign-in page, enter the username, and
follow the link sent by Resend. Recovery mail is sent only to a verified active address, while the
browser response remains identical for known, unknown, and unverified accounts. Reset links contain
a hashed-at-rest, single-use token, expire after 15 minutes, preserve MFA, and revoke every browser
session and pending login when consumed.

Production requires the paired `RESEND_API_KEY` and `MIRA_DASHBOARD_RESEND_FROM_EMAIL` settings.
Use a verified transactional sender such as `Mira Dashboard <no-reply@account.rajohan.no>`.
Keep click and open tracking disabled; no tracking subdomain is required. The configured public
origin controls verification and reset-link URLs. If delivery is unavailable, repair Resend/DNS configuration;
there is intentionally no release-bundled host password-reset executable.
