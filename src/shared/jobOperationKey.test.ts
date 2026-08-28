import { describe, expect, test } from "bun:test";

import { jobOperationKey } from "./jobOperationKey.ts";

describe("durable job operation identity", () => {
    test("preserves exact button identities for every payload-qualified job family", () => {
        expect(jobOperationKey("docker.updater", { operation: "updater-scan" })).toBe(
            "job:docker.updater:scan"
        );
        expect(
            jobOperationKey("docker.updater", {
                operation: "updater-update-service",
                serviceId: "service-id",
            })
        ).toBe("job:docker.updater:service:service-id");
        expect(
            jobOperationKey("maintenance.rotate-logs", {
                dryRun: false,
                policyId: "docker-managed",
            })
        ).toBe("log-maintenance:docker-managed:run");
        expect(
            jobOperationKey("backup.execute", {
                operation: "restore",
                type: "kopia",
            })
        ).toBe("backup:kopia:restore");
        expect(jobOperationKey("delivery.execute", { operation: "deploy" })).toBe(
            "delivery:deploy"
        );
        expect(
            jobOperationKey("cache.refresh.overview", { key: "docker.overview" })
        ).toBe("cache-refresh:docker.overview");
    });

    test("maps fixed service actions and fails closed to the action identity", () => {
        expect(jobOperationKey("host.system.update", {})).toBe(
            "service-action:system-update"
        );
        expect(jobOperationKey("system.worker-smoke", {})).toBe(
            "job:system.worker-smoke"
        );
    });
});
