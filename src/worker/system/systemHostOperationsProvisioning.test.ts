import { describe, expect, test } from "bun:test";
import path from "node:path";

import { fixedHostOperationUnits } from "../../shared/hostOperations.ts";

const artifacts = path.resolve(
    import.meta.dir,
    "../../../scripts/delivery/provisioning/host-operations"
);

function readTextFile(filePath: string): Promise<string> {
    return Bun.file(filePath).text();
}

describe("fixed host operations provisioning", () => {
    test("keeps the helper to three exact operations and fixed commands", async () => {
        const helper = await readTextFile(
            path.join(artifacts, "mira-dashboard-host-operation")
        );
        expect(helper).toContain("system-restart)");
        expect(helper).toContain("system-update)");
        expect(helper).toContain("system-cleanup)");
        expect(helper).toContain(
            "/usr/bin/systemctl start --no-block mira-dashboard-deferred-reboot.timer"
        );
        expect(helper).toContain("/usr/bin/apt-get update");
        expect(helper).toContain("/usr/bin/apt-get full-upgrade -y");
        expect(helper).toContain("/usr/bin/dpkg --configure -a");
        expect(helper.indexOf("/usr/bin/dpkg --configure -a")).toBeGreaterThan(
            helper.indexOf("/usr/bin/apt-get full-upgrade -y")
        );
        expect(helper).toContain("/usr/bin/apt-get autoremove -y");
        expect(helper).toContain("/usr/bin/apt-get autoclean -y");
        expect(helper).toContain("/usr/bin/journalctl --rotate");
        expect(helper).toContain(
            "/usr/bin/journalctl --vacuum-time=14d --vacuum-size=1G"
        );
        expect(helper).toContain(
            "/usr/bin/docker system prune --all --force --filter until=168h"
        );
        expect(helper.match(/\|\| cleanup_status=1/gu)).toHaveLength(5);
        expect(helper.indexOf('[ "$cleanup_status" -eq 0 ]')).toBeGreaterThan(
            helper.indexOf("/usr/bin/docker system prune")
        );
        expect(helper).not.toContain("eval");
        expect(helper).not.toContain("sh -c");
        expect(helper).not.toContain("sudo");
        expect(helper).not.toContain("--volumes");
    });

    test("binds the worker OS identity to only fixed host and application units", async () => {
        const policy = await readTextFile(
            path.join(artifacts, "60-mira-dashboard-host-operations.rules")
        );
        expect(policy.match(/mira-dashboard-host-system-/gu)).toHaveLength(3);
        for (const unit of Object.values(fixedHostOperationUnits).flat()) {
            expect(policy).toContain(`"${unit}"`);
        }
        expect(policy).toContain('subject.user !== "ubuntu"');
        expect(policy).toContain('verb === "start"');
        expect(policy).toContain('"mira-dashboard-web.service"');
        expect(policy).toContain('"mira-dashboard-worker.service"');
        expect(policy).toContain('["restart", "start", "stop"]');
        expect(policy).not.toContain("deferred-reboot");
        expect(policy).not.toContain("subject.isInGroup");
        expect(policy).not.toContain('"reload"');
    });

    test("defers reboot and preserves worker NoNewPrivileges", async () => {
        const [restart, update, cleanup, timer, reboot, worker, webRuntime] =
            await Promise.all([
                readTextFile(
                    path.join(artifacts, "mira-dashboard-host-system-restart.service")
                ),
                readTextFile(
                    path.join(artifacts, "mira-dashboard-host-system-update.service")
                ),
                readTextFile(
                    path.join(artifacts, "mira-dashboard-host-system-cleanup.service")
                ),
                readTextFile(
                    path.join(artifacts, "mira-dashboard-deferred-reboot.timer")
                ),
                readTextFile(
                    path.join(artifacts, "mira-dashboard-deferred-reboot.service")
                ),
                readTextFile(
                    path.resolve(
                        import.meta.dir,
                        "../../../systemd/mira-dashboard-worker.service"
                    )
                ),
                readTextFile(path.join(artifacts, "mira-dashboard-web-runtime")),
            ]);
        expect(restart).toContain("NoNewPrivileges=true");
        expect(update).not.toContain("NoNewPrivileges=");
        expect(cleanup).not.toContain("NoNewPrivileges=");
        expect(restart).toContain("ProtectKernelModules=true");
        expect(update).not.toContain("ProtectKernelModules=true");
        expect(cleanup).not.toContain("ProtectKernelModules=true");
        expect(restart).toContain("ProtectSystem=strict");
        expect(update).not.toContain("ProtectSystem=");
        expect(cleanup).not.toContain("ProtectSystem=");
        expect(update).not.toContain("ReadWritePaths=");
        expect(cleanup).not.toContain("ReadWritePaths=");
        expect(restart).toContain("PrivateDevices=true");
        expect(update).not.toContain("PrivateDevices=true");
        expect(cleanup).not.toContain("PrivateDevices=true");
        for (const packageOperation of [update, cleanup]) {
            expect(packageOperation).toContain("UMask=0022");
            expect(packageOperation).toContain("HOME=/root");
            expect(packageOperation).toContain("USER=root");
            expect(packageOperation).toContain("LOGNAME=root");
            expect(packageOperation).toContain("SHELL=/bin/sh");
            expect(packageOperation).not.toMatch(
                /^(?:LockPersonality|MemoryDenyWriteExecute|Private|Protect|ReadWritePaths|RemoveIPC|Restrict|SystemCallArchitectures)=/mu
            );
        }
        expect(worker).toContain("NoNewPrivileges=true");
        expect(timer).toContain("OnActiveSec=10s");
        expect(timer).not.toContain("WantedBy=");
        expect(reboot).toContain("ExecStart=/usr/bin/systemctl reboot");
        expect(update).toContain("StandardOutput=null");
        expect(update).toContain("StandardError=null");
        expect(update).toContain("ExecStopPost=/usr/bin/env -i");
        expect(update).toContain("/usr/bin/dpkg --configure -a");
        expect(update).toContain("TimeoutStartSec=115min");
        expect(restart).toContain("ExecStart=/usr/bin/env -i");
        expect(cleanup).toContain("ExecStart=/usr/bin/env -i");
        expect(cleanup).toContain("TimeoutStartSec=30min");
        expect(cleanup).toContain("StandardOutput=null");
        expect(cleanup).toContain("StandardError=null");
        expect(webRuntime).toContain(
            'mapping="X-mount.idmap=u:${owner_uid}:${web_uid}:1 g:${owner_gid}:${web_gid}:1"'
        );
        expect(webRuntime).toContain("--reuid=mira-dashboard-web");
        expect(webRuntime).toContain("--clear-groups");
        expect(webRuntime).toContain("--bounding-set=-all");
        expect(webRuntime).toContain("--no-new-privs");
        expect(webRuntime).not.toContain("eval");
        expect(webRuntime).not.toContain("sh -c");
        expect(webRuntime).not.toContain("sudo");
    });
});
