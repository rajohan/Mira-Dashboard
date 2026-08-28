import { describe, expect, test } from "bun:test";

import type { FixedSystemLogrotateBroker } from "./fixedSystemLogrotateBroker.ts";
import { createLogMaintenanceExecutor } from "./logMaintenanceExecutor.ts";
import type { ManagedLogRotationEngine } from "./managedLogRotation.ts";

function dependencies(options: { readonly managedOk?: boolean } = {}) {
    const calls: string[] = [];
    const managed: ManagedLogRotationEngine = {
        run: ({ dryRun = false } = {}) => {
            calls.push(`managed:${dryRun}`);
            return Promise.resolve({
                checkedTargets: 1,
                dryRun,
                finishedAtMs: 2,
                ok: options.managedOk ?? true,
                results: [],
                startedAtMs: 1,
            });
        },
        status: () =>
            Promise.resolve({
                observedAtMs: 1,
                policyId: "docker-managed",
                targetCount: 1,
            }),
    };
    const system: FixedSystemLogrotateBroker = {
        availablePolicies: () => Promise.resolve(["host-rsyslog"]),
        ensureManagedAccess: () => {
            calls.push("managed-access");
            return Promise.resolve();
        },
        run: (policyId) => {
            calls.push(policyId);
            return Promise.resolve();
        },
    };
    return { calls, executor: createLogMaintenanceExecutor({ managed, system }) };
}

describe("worker log maintenance executor", () => {
    test("routes managed and host policies to separate fixed authorities", async () => {
        const fixture = dependencies();
        expect(await fixture.executor.availablePolicies()).toEqual([
            "docker-managed",
            "host-rsyslog",
        ]);
        expect(await fixture.executor.run("docker-managed", true)).toMatchObject({
            actionCounts: { skipped: 0 },
            checkedTargets: 1,
            dryRun: true,
        });
        await fixture.executor.run("host-rsyslog", false);
        expect(fixture.calls).toEqual(["managed-access", "managed:true", "host-rsyslog"]);
    });

    test("fails with a constant error when any managed target fails", () => {
        expect(
            dependencies({ managedOk: false }).executor.run("docker-managed", false)
        ).rejects.toThrow("Fixed log maintenance execution failed");
    });

    test("rejects a host dry-run without invoking the fixed system broker", () => {
        const fixture = dependencies();
        expect(fixture.executor.run("host-rsyslog", true)).rejects.toThrow(
            "Fixed log maintenance execution failed"
        );
        expect(fixture.calls).toEqual([]);
    });
});
