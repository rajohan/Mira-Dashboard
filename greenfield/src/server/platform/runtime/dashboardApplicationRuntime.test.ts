import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { maxTime } from "date-fns/constants";

import { gatewayRealtimeTopics } from "../../../contracts/gatewayRealtime.ts";
import type { RuntimeOwnedDatabase } from "../../database/runtime/databaseService.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { migrationsDirectory } from "../../test/support/freshDatabase.ts";
import { withTestTimeout } from "../../test/support/promise.ts";
import { createTestStructuredLogger } from "../../test/support/requestContext.ts";
import {
    PersistentGatewayUnavailableError,
    type PersistentGatewayListener,
    type PersistentGatewayTransport,
} from "../gateway/persistentGatewayTransport.ts";
import { RealtimeEventPump } from "../realtime/eventPump.ts";
import { insertEvent, waitForCondition } from "../realtime/testSupport/eventPump.ts";
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

function unavailablePersistentGatewayRequest(): Promise<never> {
    return Promise.reject(new PersistentGatewayUnavailableError());
}

function createFakePersistentGatewayTransport(): {
    readonly calls: string[];
    readonly transport: PersistentGatewayTransport;
} {
    const calls: string[] = [];
    let listener: PersistentGatewayListener | undefined;
    const transport: PersistentGatewayTransport = {
        request: unavailablePersistentGatewayRequest,
        requestAdmin: unavailablePersistentGatewayRequest,
        snapshot: {
            connectionGeneration: 0,
            phase: "stopped",
            reconnectAttempt: 0,
        },
        start() {
            calls.push("start");
            listener?.onState?.({
                connectionGeneration: 1,
                phase: "connected",
                reconnectAttempt: 0,
            });
            listener?.onEvent?.({
                connectionGeneration: 1,
                frame: { event: "sessions.changed", type: "event" },
                receivedAtMs: 1000,
            });
        },
        stop() {
            calls.push("stop");
            listener?.onState?.({
                connectionGeneration: 1,
                phase: "stopped",
                reconnectAttempt: 0,
            });
            return Promise.resolve();
        },
        subscribe(nextListener) {
            calls.push("subscribe");
            listener = nextListener;
            nextListener.onState?.({
                connectionGeneration: 0,
                phase: "stopped",
                reconnectAttempt: 0,
            });
            return () => {
                calls.push("unsubscribe");
                if (listener === nextListener) listener = undefined;
            };
        },
    };
    return { calls, transport };
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

    test("owns the durable Gateway bridge across transport startup and shutdown", async () => {
        const stateDirectory = await privateTemporaryDirectory();
        const databaseFilePath = path.join(stateDirectory, "mira-dashboard.db");
        const gateway = createFakePersistentGatewayTransport();
        const runtime = createDashboardApplicationRuntime({
            database: {
                migrationsDirectory,
                releaseId,
                startupMode: "initialize-empty",
                stateDirectory,
            },
            logger: createTestStructuredLogger(),
            persistentGatewayTransport: gateway.transport,
        });

        try {
            await runtime.initialize();
            const orm = await runtime.database.orm();
            await waitForCondition(
                () => orm.select().from(realtimeEvents).all().length === 3,
                "Gateway startup realtime events"
            );
            expect(
                orm
                    .select({ topic: realtimeEvents.topic })
                    .from(realtimeEvents)
                    .orderBy(realtimeEvents.id)
                    .all()
            ).toEqual([
                { topic: gatewayRealtimeTopics.connection },
                { topic: gatewayRealtimeTopics.sessions },
                { topic: gatewayRealtimeTopics.cron },
            ]);

            await runtime.dispose();
            expect(gateway.calls).toEqual(["subscribe", "start", "stop", "unsubscribe"]);

            const verificationDatabase = new Database(databaseFilePath, {
                readonly: true,
                strict: true,
            });
            try {
                const topics = verificationDatabase
                    .query("SELECT topic FROM realtime_events ORDER BY id")
                    .all() as Array<{ topic: string }>;
                expect(topics.slice(0, 3)).toEqual([
                    { topic: gatewayRealtimeTopics.connection },
                    { topic: gatewayRealtimeTopics.sessions },
                    { topic: gatewayRealtimeTopics.cron },
                ]);
                expect(
                    topics
                        .slice(3)
                        .toSorted((left, right) => left.topic.localeCompare(right.topic))
                ).toEqual(
                    [
                        { topic: gatewayRealtimeTopics.connection },
                        { topic: gatewayRealtimeTopics.sessions },
                        { topic: gatewayRealtimeTopics.cron },
                    ].toSorted((left, right) => left.topic.localeCompare(right.topic))
                );
            } finally {
                verificationDatabase.close(true);
            }
        } finally {
            await runtime.dispose();
        }
    });

    test("finishes a claimed database settlement before disposing its database scope", async () => {
        const runtime = await createTestDashboardRuntime();
        let competingWriter: Database | undefined;

        try {
            await runtime.initialize();
            const orm = (await runtime.database.orm()) as RuntimeOwnedDatabase;
            const databasePath = orm.$client.filename;
            orm.$client.run(
                "CREATE TABLE disposal_settlement_probe (value TEXT NOT NULL)"
            );

            competingWriter = new Database(databasePath, { strict: true });
            competingWriter.run("PRAGMA busy_timeout = 0");
            competingWriter.run("BEGIN IMMEDIATE");

            const firstAdmissionAttempt = Promise.withResolvers<void>();
            let callbackCalls = 0;
            const verification = runtime.services.authentication.runWebAuthnVerification(
                () => Promise.resolve("verified"),
                {
                    onResultBeforeRelease: () =>
                        runtime.database.run((markTransactionStarted) => {
                            firstAdmissionAttempt.resolve();
                            return orm.$client
                                .transaction(() => {
                                    markTransactionStarted();
                                    callbackCalls += 1;
                                    orm.$client.run(
                                        "INSERT INTO disposal_settlement_probe (value) VALUES ('committed')"
                                    );
                                })
                                .immediate();
                        }),
                    timeoutMs: 5000,
                }
            );
            const observedVerification = verification.catch(() => null);
            await firstAdmissionAttempt.promise;

            let disposalCompleted = false;
            const disposal = runtime.dispose().then(() => {
                disposalCompleted = true;
                return true;
            });
            await Bun.sleep(30);

            expect(disposalCompleted).toBeFalse();
            expect(callbackCalls).toBe(0);

            competingWriter.run("ROLLBACK");
            await disposal;
            await observedVerification;
            expect(disposalCompleted).toBeTrue();
            expect(callbackCalls).toBe(1);

            const verificationDatabase = new Database(databasePath, {
                readonly: true,
                strict: true,
            });
            try {
                expect(
                    verificationDatabase
                        .query("SELECT value FROM disposal_settlement_probe")
                        .all()
                ).toEqual([{ value: "committed" }]);
            } finally {
                verificationDatabase.close(true);
            }
        } finally {
            if (competingWriter?.inTransaction) competingWriter.run("ROLLBACK");
            competingWriter?.close(true);
            await runtime.dispose();
        }
    });
});
