import { describe, expect, test } from "bun:test";
import path from "node:path";

import { deriveDashboardProjectLayout } from "../../server/platform/filesystem/projectLayout.ts";
import {
    createDevelopmentLogMaintenanceExecutor,
    developmentManagedLogManifest,
} from "./developmentLogMaintenance.ts";

describe("development log maintenance", () => {
    test("contains every target beneath isolated Dashboard development state", () => {
        const layout = deriveDashboardProjectLayout("/srv/mira-dashboard-dev");
        const manifest = developmentManagedLogManifest(layout);

        expect(manifest.archiveTargets).toEqual([]);
        expect(manifest.fileTargets).toHaveLength(4);
        for (const target of manifest.fileTargets) {
            expect(path.dirname(target.filePath)).toBe(layout.production.state.logs);
        }
        expect(JSON.stringify(manifest)).not.toContain("/opt/docker");
        expect(JSON.stringify(manifest)).not.toContain("/tmp/openclaw");
    });

    test("never advertises fixed host policies", async () => {
        const layout = deriveDashboardProjectLayout("/srv/mira-dashboard-dev");
        const executor = createDevelopmentLogMaintenanceExecutor(layout);

        const policies = await executor.availablePolicies();
        expect(policies.every((policyId) => policyId === "docker-managed")).toBeTrue();
        const failure = await executor.run("host-rsyslog", false).then(
            () => null,
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error("Expected fixed-policy failure");
        expect(failure.message).toContain("Fixed log maintenance execution failed");
    });
});
