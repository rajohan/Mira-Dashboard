import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

    test("advertises only managed maintenance from prepared development state", async () => {
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-dashboard-development-logs-")
        );
        const layout = deriveDashboardProjectLayout(temporaryRoot);
        await mkdir(layout.production.state.logMaintenance, { recursive: true });
        const executor = createDevelopmentLogMaintenanceExecutor(layout);

        try {
            expect(await executor.availablePolicies()).toEqual(["docker-managed"]);
            const failure = await executor.run("host-rsyslog", false).then(
                () => null,
                (error: unknown) => error
            );
            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error))
                throw new Error("Expected fixed-policy failure");
            expect(failure.message).toContain("Fixed log maintenance execution failed");
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });
});
