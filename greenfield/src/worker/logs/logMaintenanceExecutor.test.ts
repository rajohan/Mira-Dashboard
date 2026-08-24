import { describe, expect, test } from "bun:test";

import type { FixedSystemLogrotateBroker } from "./fixedSystemLogrotateBroker.ts";
import { createLogMaintenanceExecutor } from "./logMaintenanceExecutor.ts";
import type { ManagedLogRotationEngine } from "./managedLogRotation.ts";

function dependencies(options: { readonly managedOk?: boolean } = {}) {
    const calls: string[] = [];
    const managed: ManagedLogRotationEngine = {
        run: () => {
            calls.push("managed");
            return Promise.resolve({
                checkedTargets: 1,
                dryRun: false,
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
        await fixture.executor.run("docker-managed");
        await fixture.executor.run("host-rsyslog");
        expect(fixture.calls).toEqual(["managed", "host-rsyslog"]);
    });

    test("fails with a constant error when any managed target fails", () => {
        expect(
            dependencies({ managedOk: false }).executor.run("docker-managed")
        ).rejects.toThrow("Fixed log maintenance execution failed");
    });
});
