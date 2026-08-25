# Fixed Ubuntu logrotate broker artifacts

These root-owned artifacts are intentionally not installed or activated by a source build.
The reviewed root installer verifies a frozen commit-addressed release twice, completes a
non-mutating descriptor-anchored preflight of every existing destination directory and
target file, then creates `/usr/local/libexec` as `root:root 0755` when it is absent, and
replaces each file atomically with these exact ownership and modes:

| Source artifact                           | Destination                                                     | Owner/mode       |
| ----------------------------------------- | --------------------------------------------------------------- | ---------------- |
| `mira-dashboard-log-maintenance`          | `/usr/local/libexec/mira-dashboard-log-maintenance`             | `root:root 0755` |
| `mira-dashboard-log-maintenance@.service` | `/etc/systemd/system/mira-dashboard-log-maintenance@.service`   | `root:root 0644` |
| `60-mira-dashboard-log-maintenance.rules` | `/etc/polkit-1/rules.d/60-mira-dashboard-log-maintenance.rules` | `root:root 0644` |

Run it explicitly as root against one already-published immutable release:

```text
bun scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts \
  --release-root=/home/ubuntu/projects/mira-dashboard/production/releases/<commit> \
  --release-id=<commit>
```

The command only creates the exact reviewed support directory when needed and installs
manifest-bound files. It does not reload systemd or polkit, create or modify groups,
enable units, or start services. Those activation steps remain a separate reviewed
deployment transition after the installed bytes have been inspected.

Create the fixed `mira-dashboard-log-maintenance` group and grant it only to the worker
runtime identity before reloading systemd and polkit. The web process must never join this
group. Deployment must remove the group grant on rollback.

After creating the maintenance group, bootstrap runs the descriptor-bound
`provisionManagedLogAccess.ts` boundary. It reads the same managed-log manifest as the
rotation worker and grants bounded group access to every file target that opts into shared
maintenance. It preserves each admitted source owner, rejects symlinks and owner drift,
and applies one source-agnostic directory/file policy. Adding or removing a shared log
therefore changes the manifest only; bootstrap has no Docker-, application-, or
container-specific path rules. The separate `migrateManagedApplicationLogs.ts` boundary
reassigns the four fixed Dashboard stdout/stderr files from the root launcher to the service
user before state admission.

The broker accepts exactly four identifiers, each mapped to an existing root-owned Ubuntu
policy under `/etc/logrotate.d/{rsyslog,apport,dpkg,alternatives}`. It rejects extra
arguments and any policy that is not a single-link, root-owned, non-writable regular file.
It runs normal `/usr/sbin/logrotate` policy evaluation rather than forced rotation.

Dashboard, OpenClaw, Docker, and application logs do **not** cross this broker. The
worker-owned `src/worker/logs/managedLogRotation.ts` engine handles that fixed manifest,
including bounded size/cadence rotation, compression, retention, archive-only cleanup,
state, locking, status, and dry-run behavior.
