import { afterEach, describe, expect, test } from "bun:test";

import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createJobRepository } from "../jobs/repository.ts";
import { reconcileJobSchedules } from "../jobs/service.ts";
import { createSqliteLifecycleReader } from "./sqliteLifecycle.ts";

const databases: Array<Awaited<ReturnType<typeof openFreshMigratedDatabase>>> = [];

afterEach(() => {
    for (const database of databases.splice(0)) database.sqlite.close(true);
});

describe("SQLite lifecycle reader", () => {
    test("projects the exact daily schedule, verified inventory, and independent LKG", async () => {
        const database = await openFreshMigratedDatabase();
        databases.push(database);
        const jobs = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        let nowMs = Date.parse("2026-08-12T12:00:00.000Z");
        await reconcileJobSchedules({
            nowMs: () => nowMs,
            repository: jobs,
            wakeEventPump: () => Promise.resolve(),
        });
        let inventoryFails = false;
        let scheduleFails = false;
        const reader = createSqliteLifecycleReader({
            inventory: () =>
                inventoryFails
                    ? Promise.reject(new Error("/private/state/backups"))
                    : Promise.resolve({
                          backups: [
                              {
                                  bytes: 4096,
                                  createdAtMs: nowMs - 1000,
                                  kind: "scheduled" as const,
                                  restoreVerifiedAtMs: nowMs - 1000,
                                  verificationLevel: "restore-copy-verified" as const,
                              },
                          ],
                          totalBytes: 4096,
                      }),
            nowMs: () => nowMs,
            repository: {
                findLatestSuccessfulRunForSchedule(id) {
                    if (scheduleFails) throw new Error("private repository failure");
                    return jobs.findLatestSuccessfulRunForSchedule(id);
                },
                findSchedule(id) {
                    if (scheduleFails) throw new Error("private repository failure");
                    return jobs.findSchedule(id);
                },
                listScheduleRuns(input) {
                    if (scheduleFails) throw new Error("private repository failure");
                    return jobs.listScheduleRuns(input);
                },
            },
            stateDirectory: "/private/state",
        });

        expect(await reader.read()).toEqual({
            backupInventory: {
                backups: [
                    {
                        bytes: 4096,
                        createdAtMs: nowMs - 1000,
                        kind: "scheduled",
                        restoreVerifiedAtMs: nowMs - 1000,
                        verificationLevel: "restore-copy-verified",
                    },
                ],
                observedAtMs: nowMs,
                state: "available",
                totalBytes: 4096,
            },
            maintenance: {
                enabled: true,
                nextRunAtMs: expect.any(Number),
                observedAtMs: nowMs,
                runs: [],
                schedule: { timeOfDay: "02:40", timeZone: "Europe/Oslo" },
                state: "available",
            },
            restoreVerification: {
                backupBytes: 4096,
                backupCreatedAtMs: nowMs - 1000,
                observedAtMs: nowMs,
                state: "verified",
                verifiedAtMs: nowMs - 1000,
            },
        });

        inventoryFails = true;
        scheduleFails = true;
        nowMs += 5000;
        const retained = await reader.read();
        expect(retained.backupInventory).toMatchObject({
            staleSinceMs: nowMs,
            state: "last-known-good",
        });
        expect(retained.restoreVerification).toMatchObject({
            staleSinceMs: nowMs,
            state: "last-known-good",
        });
        expect(retained.maintenance).toMatchObject({
            staleSinceMs: nowMs,
            state: "last-known-good",
        });
        expect(JSON.stringify(retained)).not.toContain("/private/");
        expect(JSON.stringify(retained)).not.toContain("repository failure");
    });
});
