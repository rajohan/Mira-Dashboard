import { describe, expect, test } from "bun:test";

import { rejectionError } from "../../scripts/testSupport/rejection.ts";
import {
    parseDatabaseMaintenanceArguments,
    runDashboardDatabaseMaintenance,
} from "./databaseMaintenance.ts";

const releaseId = "a".repeat(40);
const options = Object.freeze({
    migrationsDirectory: "/srv/mira/releases/release/migrations",
    operation: "migrate-candidate" as const,
    releaseId,
    stateDirectory: "/srv/mira/production/state/candidate",
});

function unexpectedSnapshot(): Promise<never> {
    return Promise.reject(new Error("Unexpected snapshot call"));
}

describe("Dashboard database maintenance process", () => {
    test("parses one exact order-independent argument set", () => {
        expect(
            parseDatabaseMaintenanceArguments([
                "--operation=migrate-candidate",
                `--release=${releaseId}`,
                "--state=/srv/mira/production/state/candidate",
                "--migrations=/srv/mira/releases/release/migrations",
            ])
        ).toEqual(options);

        expect(() =>
            parseDatabaseMaintenanceArguments([
                "--operation=migrate-candidate",
                `--release=${releaseId}`,
                `--release=${releaseId}`,
                "--state=relative",
            ])
        ).toThrow("Usage:");
    });

    test("initializes and always disposes the isolated Effect runtime", async () => {
        const events: string[] = [];
        await runDashboardDatabaseMaintenance(options, {
            createSnapshot: unexpectedSnapshot,
            createRuntime(observed) {
                const { operation: _operation, ...expected } = options;
                expect(observed).toEqual(expected);
                return Object.freeze({
                    dispose() {
                        events.push("dispose");
                        return Promise.resolve();
                    },
                    initialize() {
                        events.push("initialize");
                        return Promise.resolve();
                    },
                });
            },
        });

        expect(events).toEqual(["initialize", "dispose"]);
    });

    test("preserves initialization failure while still disposing", async () => {
        const failure = new Error("private database initialization failure");
        const events: string[] = [];
        const observed = await rejectionError(
            runDashboardDatabaseMaintenance(options, {
                createSnapshot: unexpectedSnapshot,
                createRuntime() {
                    return Object.freeze({
                        dispose() {
                            events.push("dispose");
                            return Promise.reject(
                                new Error("secondary disposal failure")
                            );
                        },
                        initialize() {
                            events.push("initialize");
                            return Promise.reject(failure);
                        },
                    });
                },
            })
        );

        expect(observed).toBe(failure);
        expect(events).toEqual(["initialize", "dispose"]);
    });

    test("routes an exact expected-state snapshot without constructing a runtime", async () => {
        const transitionId = Bun.randomUUIDv7();
        const command = parseDatabaseMaintenanceArguments([
            "--operation=snapshot",
            "--expected-state=absent",
            `--transition=${transitionId}`,
            "--state=/srv/mira/production/state",
        ]);
        const result = await runDashboardDatabaseMaintenance(command, {
            createRuntime() {
                throw new Error("Unexpected runtime construction");
            },
            createSnapshot(observed) {
                expect(observed).toEqual({
                    expectedState: "absent",
                    stateDirectory: "/srv/mira/production/state",
                    transitionId,
                });
                return Promise.resolve({ state: "absent", transitionId });
            },
        });

        expect(result).toEqual({ state: "absent", transitionId });
    });
});
