import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../../src/shared/releaseManifest.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import {
    requireProductionDeliveryGeneratedDocumentation,
    runProductionDeliveryTargetSmoke,
    type ProductionDeliverySmokeTestHooks,
} from "./productionDeliverySmoke.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";

const temporaryDirectories: string[] = [];
const releaseId = "b".repeat(40);
const runtimeRevision = "c".repeat(40);
const checksum = "d".repeat(64);
const runId = "018f6f50-6a9e-7b88-8000-000000000002";
const diagnostics = Object.freeze({
    checkedAtMs: 1_800_000_000_000,
    checks: {
        application: { status: "ready" },
        database: { status: "ready" },
        frontend: { status: "ready" },
        release: { status: "verified" },
        worker: { status: "ready" },
    },
    dependencies: {
        gateway: {
            freshness: "fresh",
            phase: "connected",
            status: "observed",
        },
        sessions: {
            count: 1,
            observedAtMs: 1_800_000_000_000,
            state: "fresh",
            truncated: false,
        },
    },
    queue: {
        claimingPaused: false,
        runs: { queued: 0, running: 0 },
        status: "observed",
        workers: {
            capacity: 1,
            drainingCount: 0,
            freshCount: 1,
            onlineCount: 1,
        },
    },
    status: "ready",
});

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
});

function manifest() {
    return parseReleaseManifest({
        artifacts: [
            {
                bytes: 1,
                path: "server/productionDelivery.js",
                sha256: checksum,
            },
        ],
        buildCommands: [...releaseBuildCommands],
        deliveryProtocols: [...releaseDeliveryProtocols],
        display: {
            builtAtMs: 1_800_000_000_000,
            commitTitle: "Smoke test release",
            schemaTarget: 1,
        },
        documentationSha256: checksum,
        formatVersion: 1,
        lockfileSha256: checksum,
        migrations: [
            {
                id: "20260804022252_dashboard-foundation",
                migrationSha256: checksum,
                snapshotSha256: checksum,
            },
        ],
        packages: [{ name: "effect", scope: "dependency", version: "4.0.0" }],
        processRoles: [...releaseProcessRoles],
        runtime: { revision: runtimeRevision, version: "1.4.0" },
        source: { commitSha: releaseId, treeState: "clean" },
    });
}

async function fixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-delivery-smoke-"));
    temporaryDirectories.push(projectRoot);
    const productionDirectory = path.join(projectRoot, "production");
    const stateDirectory = path.join(productionDirectory, "state");
    const releaseRoot = path.join(productionDirectory, "releases", releaseId);
    const documentation = path.join(releaseRoot, "docs/generated/README.md");
    await Promise.all([
        mkdir(stateDirectory, { mode: 0o700, recursive: true }),
        mkdir(path.dirname(documentation), { mode: 0o700, recursive: true }),
    ]);
    await writeFile(documentation, "# Generated production documentation\n", {
        mode: 0o400,
    });
    await chmod(documentation, 0o400);

    const databasePath = path.join(stateDirectory, "mira-dashboard.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            authentication_version INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            disabled_at INTEGER,
            mfa_enabled_at INTEGER
        );
        CREATE TABLE auth_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            validator_hash TEXT NOT NULL,
            validator_version INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            authenticated_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            authentication_version INTEGER NOT NULL,
            auth_method TEXT NOT NULL,
            password_verified_at INTEGER NOT NULL,
            mfa_verified_at INTEGER,
            user_agent TEXT
        );
    `);
    database
        .query(
            `INSERT INTO users (
                id, authentication_version, created_at, disabled_at, mfa_enabled_at
             ) VALUES (?, 1, ?, NULL, ?)`
        )
        .run("operator", 1_800_000_000_000, 1_800_000_000_000);
    database.close(true);

    const paths: PreparedProductionDeliveryPaths = Object.freeze({
        productionDirectory,
        releasesDirectory: path.dirname(releaseRoot),
        runtimesDirectory: path.join(productionDirectory, "runtimes"),
        stateDirectory,
    });
    const release: PublishedProductionRelease = Object.freeze({
        manifest: manifest(),
        releaseRoot,
    });
    const runtime: InstalledProductionRuntime = Object.freeze({
        executable: path.join(productionDirectory, "runtimes", "bun"),
        identity: { revision: runtimeRevision, version: "1.4.0" },
    });
    return Object.freeze({ databasePath, documentation, paths, release, runtime });
}

function queuedRun() {
    return {
        actionKey: "system.worker-smoke",
        attemptCount: 0,
        attemptLimit: 1,
        availableAtMs: 1_800_000_000_000,
        cancellationPolicy: "cooperative",
        displayName: "Worker smoke",
        eventCount: 1,
        id: runId,
        priority: 0,
        queuedAtMs: 1_800_000_000_000,
        resourceClass: "light",
        resourceKeys: ["database"],
        retrySafe: true,
        scheduledJobId: "system.worker-smoke",
        scheduledJobVersion: 1,
        state: "queued",
        stateVersion: 1,
        timeoutMs: 30_000,
        triggerType: "manual",
        updatedAtMs: 1_800_000_000_000,
    };
}

function succeededRun() {
    return {
        ...queuedRun(),
        attemptCount: 1,
        eventCount: 3,
        finishedAtMs: 1_800_000_002_000,
        firstStartedAtMs: 1_800_000_001_000,
        lastAttemptStartedAtMs: 1_800_000_001_000,
        state: "succeeded",
        stateVersion: 3,
        updatedAtMs: 1_800_000_002_000,
    };
}

function trpcResponse(value: unknown): Response {
    return Response.json({ result: { data: { json: value } } });
}

describe("production Delivery target smoke", () => {
    test("authorizes an MFA-enabled operator and retains an event emitted before enqueue returns", async () => {
        const { databasePath, paths, release, runtime } = await fixture();
        let observer:
            | Parameters<
                  NonNullable<ProductionDeliverySmokeTestHooks["subscribeToJobRuns"]>
              >[0]
            | undefined;
        const connected = Promise.withResolvers<void>();
        const subscriptionStarted = Promise.withResolvers<void>();
        let observedMfaProof = false;
        let scheduleRequested = false;
        let unsubscribed = false;
        const fetcher: NonNullable<ProductionDeliverySmokeTestHooks["fetch"]> = (
            input,
            init
        ) => {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            if (url.pathname === "/") {
                return Promise.resolve(
                    new Response("<!doctype html>", {
                        headers: { "content-type": "text/html; charset=utf-8" },
                    })
                );
            }
            if (url.pathname === "/trpc/system.runtimeIdentity") {
                return Promise.resolve(
                    trpcResponse({
                        revision: runtimeRevision,
                        version: "1.4.0",
                        versionWithRevision: `1.4.0+${runtimeRevision.slice(0, 8)}`,
                    })
                );
            }
            if (url.pathname === "/trpc/system.healthDiagnostics") {
                return Promise.resolve(trpcResponse(diagnostics));
            }
            if (url.pathname === "/trpc/schedules.run" && init?.method === "POST") {
                scheduleRequested = true;
                const database = new Database(databasePath, {
                    create: false,
                    readonly: true,
                    strict: true,
                });
                const session = database
                    .query<{ readonly mfaVerifiedAt: number | null }, []>(
                        `SELECT mfa_verified_at AS mfaVerifiedAt FROM auth_sessions`
                    )
                    .get();
                database.close(true);
                observedMfaProof = Number.isSafeInteger(session?.mfaVerifiedAt);
                observer?.onData({
                    data: {
                        event: {
                            entityId: runId,
                            entityType: "job-run",
                            occurredAtMs: 1_800_000_000_000,
                            operation: "created",
                            payload: { id: runId },
                            topic: "jobs.runs",
                        },
                        kind: "change",
                    },
                    id: "1",
                });
                return Promise.resolve(trpcResponse(queuedRun()));
            }
            if (url.pathname === "/trpc/jobs.getRun") {
                return Promise.resolve(
                    trpcResponse({
                        events: [],
                        result: { databaseReleaseId: releaseId, status: "ok" },
                        run: succeededRun(),
                    })
                );
            }
            return Promise.resolve(new Response(null, { status: 404 }));
        };

        const smoke = runProductionDeliveryTargetSmoke(
            paths,
            release,
            runtime,
            "http://127.0.0.1:3100/readyz",
            "018f6f50-6a9e-7b88-8000-000000000003",
            {
                fetch: fetcher,
                subscribeToJobRuns(input) {
                    observer = input;
                    subscriptionStarted.resolve();
                    return Object.freeze({
                        connected: connected.promise,
                        unsubscribe() {
                            unsubscribed = true;
                        },
                    });
                },
            }
        );

        await subscriptionStarted.promise;
        expect(scheduleRequested).toBeFalse();
        connected.resolve();
        await smoke;

        expect(observedMfaProof).toBeTrue();
        expect(unsubscribed).toBeTrue();
        const database = new Database(databasePath, {
            create: false,
            readonly: true,
            strict: true,
        });
        expect(
            database
                .query<{ readonly count: number }, []>(
                    "SELECT COUNT(*) AS count FROM auth_sessions"
                )
                .get()?.count
        ).toBe(0);
        database.close(true);
    });

    test("reads generated documentation through a stable held descriptor", async () => {
        const { release } = await fixture();
        expect(
            await requireProductionDeliveryGeneratedDocumentation(release)
        ).toBeUndefined();
    });

    test("fails closed when the documentation path is replaced after opening", async () => {
        const { documentation, release } = await fixture();
        const retired = `${documentation}.retired`;
        const error = await rejectionError(
            requireProductionDeliveryGeneratedDocumentation(release, {
                async afterDocumentationOpen() {
                    await rename(documentation, retired);
                    await writeFile(documentation, "# Replacement documentation\n", {
                        mode: 0o400,
                    });
                },
            })
        );
        expect(error.message).toBe("Production Delivery target smoke failed");
    });
});
