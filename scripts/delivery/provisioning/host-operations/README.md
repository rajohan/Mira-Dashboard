# Host operations root provisioning

This subtree contains the complete reviewed root boundary for the production web/worker
identity split and three fixed operations: `system-restart`, `system-update`, and
`system-cleanup`. It does not expose a shell, command, path, unit, environment, or output
parameter.

| Artifact                                          | Destination                                                           | Owner/mode       |
| ------------------------------------------------- | --------------------------------------------------------------------- | ---------------- |
| `mira-dashboard-host-operation`                   | `/usr/local/libexec/mira-dashboard-host-operation`                    | `root:root 0755` |
| `mira-dashboard-web-runtime`                      | `/usr/local/libexec/mira-dashboard-web-runtime`                       | `root:root 0755` |
| `mira-dashboard-host-system-restart.service`      | `/etc/systemd/system/mira-dashboard-host-system-restart.service`      | `root:root 0644` |
| `mira-dashboard-host-system-update.service`       | `/etc/systemd/system/mira-dashboard-host-system-update.service`       | `root:root 0644` |
| `mira-dashboard-host-system-cleanup.service`      | `/etc/systemd/system/mira-dashboard-host-system-cleanup.service`      | `root:root 0644` |
| `mira-dashboard-deferred-reboot.service`          | `/etc/systemd/system/mira-dashboard-deferred-reboot.service`          | `root:root 0644` |
| `mira-dashboard-deferred-reboot.timer`            | `/etc/systemd/system/mira-dashboard-deferred-reboot.timer`            | `root:root 0644` |
| `60-mira-dashboard-host-operations.rules`         | `/etc/polkit-1/rules.d/60-mira-dashboard-host-operations.rules`       | `root:root 0644` |
| `mira-dashboard-production-authority.conf`        | `/etc/sysusers.d/mira-dashboard-production-authority.conf`            | `root:root 0644` |
| `mira-dashboard-production-provisioning@.service` | `/etc/systemd/system/mira-dashboard-production-provisioning@.service` | `root:root 0644` |
| `systemd/mira-dashboard-web.service`              | `/etc/systemd/system/mira-dashboard-web.service`                      | `root:root 0644` |
| `systemd/mira-dashboard-worker.service`           | `/etc/systemd/system/mira-dashboard-worker.service`                   | `root:root 0644` |

Do not invoke the root installer against the application-owned production release tree. First
transfer the exact release into a dedicated root-owned immutable staging tree. The staged release
root and every directory traversed below it must be `root:root 0500`; `release-manifest.json` and
every admitted provisioning artifact must be `root:root 0400`. Preserve the exact release ID as the
staged root's basename. The installer rejects an internally consistent manifest when any admitted
source object is owned by the application user or group.

Provision the exact Bun executable and `server/productionProvisioning.js` together under
`/var/lib/mira-dashboard-host-provisioning/pairs/<commit>/` as `root:root 0555`. Select the complete
pair through the atomically replaced `current` symlink. The systemd unit resolves that selector once
as its working directory before launching `./bun ./productionProvisioning.js`, so a host stop or
selector change cannot combine files from different releases. Every directory below the root-owned,
non-group/other-writable provisioning trust root must remain root-owned and not writable by group or
others.

Before transfer or ownership change, independently verify the candidate against the reviewed Git
commit/tree or approved release record and obtain the exact `release-manifest.json` SHA-256 through
trusted change control. Do not compute the value from the application checkout as part of the root
install command: that would merely trust the same potentially forged source twice. The installer
requires this out-of-band digest and compares it to the held root-owned manifest bytes before
parsing any artifact hash.

Install exact manifest-bound bytes only by invoking the staged script with that absolute runtime:

```sh
/var/lib/mira-dashboard-host-provisioning/pairs/<commit>/bun \
  /var/lib/mira-dashboard-host-provisioning/releases/<commit>/scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts \
  --release-root=/var/lib/mira-dashboard-host-provisioning/releases/<commit> \
  --release-id=<40-hex-commit> \
  --release-manifest-sha256=<approved-64-hex-digest>
```

There is deliberately no package-manager script for this root operation. Do not run the installer
from the application checkout, with the application user's Bun executable, or through a relative
module path.

After all bytes have been revalidated, the real-root invocation runs only three fixed activation
commands: `systemd-sysusers` for the exact installed configuration, `systemctl daemon-reload`, and
`systemctl enable` for the two Dashboard system units. It never starts, stops, or restarts a
service. Test-root installations perform no activation.

The system topology retains `ubuntu` as the trusted production-state and worker principal and moves
the internet-facing web process to `mira-dashboard-web`. A root-owned fixed launcher creates
id-mapped mounts inside web's private mount namespace for only the reviewed project, OpenClaw, and
production-state paths. The operator-owned `0700` Doppler directory is mounted read-only without
identity mapping; the launcher validates its owner/mode, uses it only while privileged to request
the fixed web secret allowlist, unmounts the credential inside the private namespace, and passes
only those selected values through the environment while irreversibly dropping to the web UID.
Startup fails unless the dropped principal cannot read or traverse the operator credential before
projection and the credential file is absent afterwards. The web process therefore cannot reuse Doppler authority to
retrieve worker-only GitHub, Docker, database, or provider secrets. It has no supplementary groups
or capabilities, cannot see Docker or system-manager IPC, and must pass those negative checks
before startup. The exact polkit rule authorizes only the
`ubuntu` worker identity: `start` for the three fixed host-operation units and
`start|stop|restart` for the two Dashboard units. Arbitrary units and verbs remain denied.

Activation verifies the root-installed application unit bytes against the exact candidate manifest
before changing release pointers. The authenticated delivery smoke then verifies the live distinct
principals, exact root fragment paths, empty web supplementary groups, and worker Docker group. Only
after this complete proof does the production worker advertise the fixed host-operation broker.

Rollback invokes this same installer with the previous root-owned immutable release, restoring all
exact authority files and reloading systemd. The deferred timer is never enabled; it is started only by the root-owned
restart helper after systemd accepts the reviewed restart unit.

Normal Delivery activation starts only the fixed
`mira-dashboard-production-provisioning@<commit>--<tag>--<receipt-sha256>--<archive-sha256>.service`
boundary. The root-owned
provisioner independently resolves the stable GitHub tag, downloads the permanent
`receipt.json` and `release.tar` assets, verifies their published digests and immutable
release identity, then installs candidate authority after the running Dashboard services
have stopped. The root boundary obtains only `MIRA_GITHUB_TOKEN` through the host's canonical
Doppler configuration; the credential is neither persisted in the release tree nor inherited by
child installers. Tagged provisioning always revalidates and replaces any cached copy for that commit;
only `--local` rollback trusts an already root-staged release. Provisioning never removes a root
while activation outcome is unknown. After activation commits and readiness passes, the controller
starts the same boundary with `--local--settled` to validate the complete immutable root inventory.
Release roots are not deleted until a future garbage collector can prove they are unreferenced by
activation or rollback state. Rollback starts the boundary with `--local` and reinstalls the retained
previous authority before the previous services restart.

Cleanup removes orphaned packages and stale package cache entries, rotates then vacuums
journald to fixed 14-day and 1 GiB limits, and prunes only unused Docker content older
than seven days. It never prunes Docker volumes. Every phase runs even when an earlier
phase fails, and the operation reports failure if any phase did not complete.
