# Host operations root provisioning

This subtree contains the complete reviewed root boundary for three fixed operations:
`system-restart`, `system-update`, and `system-cleanup`. It does not expose a shell,
command, path, unit, environment, or output parameter.

| Artifact                                     | Destination                                                      | Owner/mode       |
| -------------------------------------------- | ---------------------------------------------------------------- | ---------------- |
| `mira-dashboard-host-operation`              | `/usr/local/libexec/mira-dashboard-host-operation`               | `root:root 0755` |
| `mira-dashboard-host-system-restart.service` | `/etc/systemd/system/mira-dashboard-host-system-restart.service` | `root:root 0644` |
| `mira-dashboard-host-system-update.service`  | `/etc/systemd/system/mira-dashboard-host-system-update.service`  | `root:root 0644` |
| `mira-dashboard-host-system-cleanup.service` | `/etc/systemd/system/mira-dashboard-host-system-cleanup.service` | `root:root 0644` |
| `mira-dashboard-deferred-reboot.service`     | `/etc/systemd/system/mira-dashboard-deferred-reboot.service`     | `root:root 0644` |
| `mira-dashboard-deferred-reboot.timer`       | `/etc/systemd/system/mira-dashboard-deferred-reboot.timer`       | `root:root 0644` |
| `60-mira-dashboard-host-operations.rules`    | `/etc/polkit-1/rules.d/60-mira-dashboard-host-operations.rules`  | `root:root 0644` |

Do not invoke the root installer against the application-owned production release tree. First
transfer the exact release into a dedicated root-owned immutable staging tree. The staged release
root and every directory traversed below it must be `root:root 0500`; `release-manifest.json` and
every admitted provisioning artifact must be `root:root 0400`. Preserve the exact release ID as the
staged root's basename. The installer rejects an internally consistent manifest when any admitted
source object is owned by the application user or group.

Provision the exact Bun executable separately at
`/var/lib/mira-dashboard-host-provisioning/runtime/bun` as `root:root 0555`. Every ancestor of that
runtime path below the root-owned, non-group/other-writable
`/var/lib/mira-dashboard-host-provisioning` trust root must also be root-owned and not writable by
group or others. The root handoff must verify
the runtime and complete staged module tree before launch: Bun loads the entrypoint and its local
dependencies before in-process validation can run, so an application-owned interpreter or script
cannot establish its own authority.

Before transfer or ownership change, independently verify the candidate against the reviewed Git
commit/tree or approved release record and obtain the exact `release-manifest.json` SHA-256 through
trusted change control. Do not compute the value from the application checkout as part of the root
install command: that would merely trust the same potentially forged source twice. The installer
requires this out-of-band digest and compares it to the held root-owned manifest bytes before
parsing any artifact hash.

Install exact manifest-bound bytes only by invoking the staged script with that absolute runtime:

```sh
/var/lib/mira-dashboard-host-provisioning/runtime/bun \
  /var/lib/mira-dashboard-host-provisioning/releases/<commit>/scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts \
  --release-root=/var/lib/mira-dashboard-host-provisioning/releases/<commit> \
  --release-id=<40-hex-commit> \
  --release-manifest-sha256=<approved-64-hex-digest>
```

There is deliberately no package-manager script for this root operation. Do not run the installer
from the application checkout, with the application user's Bun executable, or through a relative
module path.

The installer does not reload systemd or polkit, create groups, enable timers, start an operation,
or compose the worker broker. The current web and worker user services share one Unix identity, so
that identity must never be added to `mira-dashboard-host-operations`: doing so would authorize the
web process too. A separately reviewed topology change must first move the worker to a distinct OS
principal. Only that principal may then join the fixed group before systemd/polkit reload and broker
composition. Until every step is complete, all three host operations remain unavailable.

Rollback reinstalls the same seven files from the previous immutable release and reloads
systemd/polkit. The deferred timer is never enabled; it is started only by the root-owned
restart helper after systemd accepts the reviewed restart unit.

Cleanup removes orphaned packages and stale package cache entries, rotates then vacuums
journald to fixed 14-day and 1 GiB limits, and prunes only unused Docker content older
than seven days. It never prunes Docker volumes. Every phase runs even when an earlier
phase fails, and the operation reports failure if any phase did not complete.
