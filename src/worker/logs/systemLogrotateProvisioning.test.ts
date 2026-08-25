import { describe, expect, test } from "bun:test";
import path from "node:path";

const artifacts = path.resolve(
    import.meta.dir,
    "../../../scripts/delivery/provisioning/log-maintenance"
);

describe("fixed Ubuntu logrotate provisioning", () => {
    test("checks policy link count, owner, mode, and exact host allowlist", async () => {
        const broker = await Bun.file(
            path.join(artifacts, "mira-dashboard-log-maintenance")
        ).text();
        expect(broker).toContain("stat -c '%h'");
        expect(broker).toContain("stat -c '%u'");
        expect(broker).toContain("su root adm");
        expect(broker).toContain(
            '/usr/sbin/logrotate --state /var/lib/logrotate/status "$configuration"'
        );
        expect(broker).toContain("host-rsyslog)");
        expect(broker).toContain("host-apport)");
        expect(broker).toContain("host-dpkg)");
        expect(broker).toContain("host-alternatives)");
        expect(broker).not.toContain("docker-managed)");
        expect(broker).not.toContain("/opt/docker");
    });

    test("grants polkit access to the same four units only", async () => {
        const policy = await Bun.file(
            path.join(artifacts, "60-mira-dashboard-log-maintenance.rules")
        ).text();
        expect(policy.match(/mira-dashboard-log-maintenance@host-/gu)).toHaveLength(4);
        expect(policy).not.toContain("docker-managed");
    });
});
