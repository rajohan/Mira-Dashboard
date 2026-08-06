import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maxTime } from "date-fns/constants";

import { migrationsDirectory } from "../../test/support/freshDatabase.ts";
import { withTestTimeout } from "../../test/support/promise.ts";
import { createTestStructuredLogger } from "../../test/support/requestContext.ts";
import { RealtimeEventPump } from "../realtime/eventPump.ts";
import { insertEvent } from "../realtime/testSupport/eventPump.ts";
import { createDashboardApplicationRuntime } from "./applicationRuntime.ts";

const releaseId = "0".repeat(40);
const testTimeoutMs = 2000;
const temporaryDirectories: string[] = [];

const stableLease = {
    expiresAtMs: maxTime,
    renew: () => Promise.resolve(stableLease),
};

async function privateTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-app-runtime-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    return directory;
}

async function createTestDashboardRuntime() {
    const stateDirectory = await privateTemporaryDirectory();
    return createDashboardApplicationRuntime({
        database: {
            migrationsDirectory,
            releaseId,
            startupMode: "initialize-empty",
            stateDirectory,
        },
        logger: createTestStructuredLogger(),
    });
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

describe("Dashboard application runtime", () => {
    test("shares one runtime-owned ORM with the database-backed realtime pump", async () => {
        const runtime = await createTestDashboardRuntime();
        let iterator: AsyncIterator<unknown> | undefined;

        try {
            await runtime.initialize();
            const firstOrm = await runtime.database.orm();
            const secondOrm = await runtime.database.orm();
            expect(firstOrm).toBe(secondOrm);

            const eventId = insertEvent(
                { orm: firstOrm },
                { occurredAtMs: 1000, topic: "monitoring.reports" }
            );
            const deliveries = await runtime.services.realtimeEvents.stream(
                { afterId: "0", topics: ["monitoring.reports"] },
                stableLease
            );
            iterator = deliveries[Symbol.asyncIterator]();

            expect(
                await withTestTimeout(
                    iterator.next(),
                    testTimeoutMs,
                    "Runtime-owned realtime store did not read the inserted event"
                )
            ).toMatchObject({
                done: false,
                value: { id: String(eventId), kind: "change" },
            });
        } finally {
            try {
                await iterator?.return?.();
            } finally {
                await runtime.dispose();
            }
        }
    });

    test("finalizes the realtime layer before closing its database dependency", async () => {
        const order: string[] = [];
        const stateDirectory = await privateTemporaryDirectory();
        const databaseFilePath = path.join(stateDirectory, "mira-dashboard.db");
        const originalPumpClose = Object.getOwnPropertyDescriptor(
            RealtimeEventPump.prototype,
            "close"
        )?.value as (this: RealtimeEventPump) => void;
        const originalDatabaseClose = Object.getOwnPropertyDescriptor(
            Database.prototype,
            "close"
        )?.value as (this: Database, throwOnError?: boolean) => void;
        const pumpCloseSpy = spyOn(
            RealtimeEventPump.prototype,
            "close"
        ).mockImplementation(function (this: RealtimeEventPump) {
            order.push("realtime-close");
            return originalPumpClose.call(this);
        });
        const databaseCloseSpy = spyOn(Database.prototype, "close").mockImplementation(
            function (this: Database, throwOnError?: boolean) {
                if (this.filename === databaseFilePath) order.push("database-close");
                return originalDatabaseClose.call(this, throwOnError);
            }
        );
        const runtime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId,
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: createTestStructuredLogger(),
        });

        try {
            await runtime.initialize();
            await runtime.dispose();

            expect(order).toEqual(["realtime-close", "database-close"]);
        } finally {
            try {
                await runtime.dispose();
            } finally {
                databaseCloseSpy.mockRestore();
                pumpCloseSpy.mockRestore();
            }
        }
    });
});
