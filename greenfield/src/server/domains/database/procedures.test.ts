import { describe, expect, test } from "bun:test";

import type { DatabaseOverview } from "../../../contracts/database.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import type { DatabaseObservabilityService } from "./service.ts";

const overview = Object.freeze({
    checkedAtMs: 2000,
    postgresql: Object.freeze({ state: "unavailable" }),
    sqlite: Object.freeze({
        connection: Object.freeze({
            busyPolicy: "non-blocking",
            checksEnforced: true,
            foreignKeysEnabled: true,
            journalMode: "wal",
            synchronousMode: "full",
            trustedSchemaEnabled: false,
            walAutoCheckpointPages: 1000,
        }),
        fileName: "mira-dashboard.db",
        lifecycle: Object.freeze({
            backupInventory: Object.freeze({
                reason: "inventory-unavailable",
                state: "unavailable",
            }),
            maintenance: Object.freeze({
                reason: "maintenance-unavailable",
                state: "unavailable",
            }),
            restoreVerification: Object.freeze({
                reason: "verification-unavailable",
                state: "unavailable",
            }),
        }),
        migrations: Object.freeze({ applied: 1, available: 1, current: true }),
        observedAtMs: 2000,
        state: "fresh",
        storage: Object.freeze({
            databaseBytes: 8192,
            freeBytes: 0,
            freePages: 0,
            freePercent: 0,
            pageCount: 2,
            pageSizeBytes: 4096,
            permissions: Object.freeze({
                dataDirectory: "0700",
                database: "0600",
                secure: true,
            }),
            requiresVacuumReview: false,
            shmBytes: 0,
            storageBytes: 8192,
            walBytes: 0,
        }),
    }),
}) satisfies DatabaseOverview;

async function caller(
    authentication = createTestSessionAuthentication(["database:read"]),
    databaseObservabilityService: DatabaseObservabilityService = Object.freeze({
        read: () => Promise.resolve(overview),
    })
) {
    const context = await createTestRequestContext(authentication, undefined, {
        databaseObservabilityService,
    });
    return appRouter.createCaller(context).database;
}

describe("database overview procedure", () => {
    test("returns bounded diagnostics to a capable browser session", async () => {
        const database = await caller();

        expect(await database.overview()).toEqual(overview);
        expect(await database.overview({})).toEqual(overview);
    });

    test("rejects anonymous, automation, and ungranted sessions before reading", async () => {
        let reads = 0;
        const service = Object.freeze({
            read: () => {
                reads += 1;
                return Promise.resolve(overview);
            },
        });
        const anonymous = await caller({ kind: "anonymous" }, service);
        const automation = await caller(
            createTestAutomationAuthentication(["database:read"]),
            service
        );
        const ungranted = await caller(createTestSessionAuthentication([]), service);

        expect(await captureFailure(() => anonymous.overview())).toMatchObject({
            code: "UNAUTHORIZED",
        });
        expect(await captureFailure(() => automation.overview())).toMatchObject({
            code: "FORBIDDEN",
        });
        expect(await captureFailure(() => ungranted.overview())).toMatchObject({
            code: "FORBIDDEN",
        });
        expect(reads).toBe(0);
    });
});
