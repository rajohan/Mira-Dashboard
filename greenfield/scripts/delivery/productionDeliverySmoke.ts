import { Database } from "bun:sqlite";
import { constants, type BigIntStats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { createTRPCUntypedClient, httpSubscriptionLink } from "@trpc/client";
import { EventSource, type EventSourceFetchInit } from "eventsource";
import superjson from "superjson";
import * as v from "valibot";

import { realtimeStreamOutputSchema } from "../../src/contracts/events.ts";
import { jobRunSummarySchema } from "../../src/contracts/jobModel.ts";
import { jobRealtimeTopics } from "../../src/contracts/jobRealtime.ts";
import { jobRunDetailSchema } from "../../src/contracts/jobs.ts";
import {
    runtimeIdentitySchema,
    systemHealthDiagnosticsSchema,
} from "../../src/contracts/system.ts";
import { runProductionAuthoritySmoke } from "./productionAuthoritySmoke.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";

const smokeFailureMessage = "Production Delivery target smoke failed";
const smokeDeadlineMs = 30_000;
const requestTimeoutMs = 2000;
const maximumDocumentationBytes = 64 * 1024;
const maximumPendingRealtimeRunIds = 128;
const documentationOpenFlags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const writePermissionBits = 0o222n;

interface TrpcEnvelope {
    readonly error?: unknown;
    readonly result?: { readonly data?: { readonly json?: unknown } };
}

interface ActiveUserRow {
    readonly authenticationVersion: number;
    readonly id: string;
    readonly mfaEnabledAt: number | null;
}

interface JobRunRealtimeObserver {
    readonly onData: (value: unknown) => void;
    readonly onError: (error: unknown) => void;
}

interface JobRunRealtimeSubscription {
    readonly connected: Promise<void>;
    readonly unsubscribe: () => void;
}

type ProductionDeliverySmokeFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

interface SubscribeToJobRunsInput extends JobRunRealtimeObserver {
    readonly baseUrl: URL;
    readonly cookie: string;
    readonly fetcher: ProductionDeliverySmokeFetch;
}

/** Deterministic transport and filesystem seams used only by focused smoke tests. */
export interface ProductionDeliverySmokeTestHooks {
    readonly afterDocumentationOpen?: () => Promise<void> | void;
    readonly fetch?: ProductionDeliverySmokeFetch;
    readonly subscribeToJobRuns?: (
        input: SubscribeToJobRunsInput
    ) => JobRunRealtimeSubscription;
}

function failure(): Error {
    return new Error(smokeFailureMessage);
}

function randomHex(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytes.toHex();
}

function sessionMaterial(): Readonly<{
    prefix: string;
    token: string;
    validatorHash: string;
}> {
    const prefix = randomHex(16);
    const validator = randomHex(32);
    return Object.freeze({
        prefix,
        token: `${prefix}.${validator}`,
        validatorHash: new Bun.CryptoHasher("sha256")
            .update(`mira-dashboard:session:v1:${prefix}:${validator}`)
            .digest("hex"),
    });
}

function smokeIdempotencyKey(transitionId: string): string {
    return new Bun.CryptoHasher("sha256")
        .update(`mira-dashboard:production-smoke:v1:${transitionId}`)
        .digest("hex");
}

async function trpcJson(
    baseUrl: URL,
    procedure: string,
    input: unknown,
    headers: Readonly<Record<string, string>>,
    fetcher: ProductionDeliverySmokeFetch,
    method: "GET" | "POST" = "GET"
): Promise<unknown> {
    const encoded = JSON.stringify({ json: input });
    const response = await fetcher(
        method === "GET"
            ? new URL(`/trpc/${procedure}?input=${encodeURIComponent(encoded)}`, baseUrl)
            : new URL(`/trpc/${procedure}`, baseUrl),
        {
            ...(method === "POST" ? { body: encoded } : {}),
            headers: {
                ...headers,
                ...(method === "POST" ? { "content-type": "application/json" } : {}),
            },
            method,
            redirect: "error",
            signal: AbortSignal.timeout(requestTimeoutMs),
        }
    );
    const body = (await response.json()) as TrpcEnvelope;
    if (response.status !== 200 || body.error !== undefined) throw failure();
    return body.result?.data?.json;
}

function eventSourceFetchWithCookie(
    cookie: string,
    fetcher: ProductionDeliverySmokeFetch,
    connected: PromiseWithResolvers<void>
) {
    return async (url: string | URL, init: EventSourceFetchInit): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set("cookie", cookie);
        try {
            const response = await fetcher(url, { ...init, headers, redirect: "error" });
            if (response.ok) {
                connected.resolve();
            } else {
                connected.reject(failure());
            }
            return response;
        } catch (error) {
            connected.reject(failure());
            throw error;
        }
    };
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.uid === right.uid &&
        left.ctimeNs === right.ctimeNs &&
        left.mtimeNs === right.mtimeNs
    );
}

async function closeFile(file: FileHandle | undefined): Promise<boolean> {
    if (!file) return true;
    try {
        await file.close();
        return true;
    } catch {
        return false;
    }
}

/** Verifies one generated documentation artifact through a held no-follow descriptor. */
export async function requireProductionDeliveryGeneratedDocumentation(
    release: PublishedProductionRelease,
    testHooks: ProductionDeliverySmokeTestHooks = {}
): Promise<void> {
    const documentation = path.join(release.releaseRoot, "docs/generated/README.md");
    let file: FileHandle | undefined;
    let failed = false;
    try {
        file = await open(documentation, documentationOpenFlags);
        const [before, canonical] = await Promise.all([
            file.stat({ bigint: true }),
            realpath(`/proc/self/fd/${String(file.fd)}`),
        ]);
        if (
            canonical !== documentation ||
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1n ||
            before.size <= 0n ||
            before.size > BigInt(maximumDocumentationBytes) ||
            typeof process.getuid !== "function" ||
            before.uid !== BigInt(process.getuid()) ||
            (before.mode & writePermissionBits) !== 0n
        ) {
            throw failure();
        }

        await testHooks.afterDocumentationOpen?.();
        const expectedBytes = Number(before.size);
        const contents = Buffer.alloc(expectedBytes + 1);
        let bytesRead = 0;
        while (bytesRead < contents.byteLength) {
            const result = await file.read(
                contents,
                bytesRead,
                contents.byteLength - bytesRead,
                bytesRead
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        const [after, canonicalAfter] = await Promise.all([
            file.stat({ bigint: true }),
            realpath(`/proc/self/fd/${String(file.fd)}`),
        ]);
        if (
            bytesRead !== expectedBytes ||
            canonicalAfter !== documentation ||
            !sameFileSnapshot(before, after)
        ) {
            throw failure();
        }
    } catch {
        failed = true;
    }
    if (!(await closeFile(file))) failed = true;
    if (failed) throw failure();
}

function subscribeToJobRuns(input: SubscribeToJobRunsInput): JobRunRealtimeSubscription {
    const connected = Promise.withResolvers<void>();
    const client = createTRPCUntypedClient({
        links: [
            httpSubscriptionLink({
                EventSource,
                eventSourceOptions: {
                    fetch: eventSourceFetchWithCookie(
                        input.cookie,
                        input.fetcher,
                        connected
                    ),
                },
                transformer: superjson,
                url: new URL("/trpc", input.baseUrl).toString(),
            }),
        ],
    });
    const subscription = client.subscription(
        "events.stream",
        { topics: [jobRealtimeTopics.runs] },
        { onData: input.onData, onError: input.onError }
    );
    return Object.freeze({
        connected: connected.promise,
        unsubscribe: () => subscription.unsubscribe(),
    });
}

async function withinRequestDeadline<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([
        operation,
        Bun.sleep(requestTimeoutMs).then(() => {
            throw failure();
        }),
    ]);
}

/**
 * Proves the exact target web/worker pair through authenticated public transports.
 * A five-minute session is inserted for one existing operator, used only over loopback,
 * and deleted in `finally`; no credential crosses argv, logs, receipts, or manifests.
 */
export async function runProductionDeliveryTargetSmoke(
    paths: PreparedProductionDeliveryPaths,
    release: PublishedProductionRelease,
    runtime: InstalledProductionRuntime,
    readinessUrl: string,
    transitionId: string,
    testHooks: ProductionDeliverySmokeTestHooks = {}
): Promise<void> {
    const fetcher = testHooks.fetch ?? fetch;
    const baseUrl = new URL(readinessUrl);
    baseUrl.pathname = "/";
    const database = new Database(path.join(paths.stateDirectory, "mira-dashboard.db"), {
        create: false,
        readwrite: true,
        strict: true,
    });
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
    const session = sessionMaterial();
    let inserted = false;
    try {
        const users = database
            .query<ActiveUserRow, []>(
                `SELECT id,
                        authentication_version AS authenticationVersion,
                        mfa_enabled_at AS mfaEnabledAt
                 FROM users
                 WHERE disabled_at IS NULL
                 ORDER BY created_at ASC, id ASC
                 LIMIT 2`
            )
            .all();
        const user = users[0];
        if (
            user === undefined ||
            !Number.isSafeInteger(user.authenticationVersion) ||
            (user.mfaEnabledAt !== null && !Number.isSafeInteger(user.mfaEnabledAt))
        ) {
            throw failure();
        }
        const now = Date.now();
        const mfaVerifiedAt = user.mfaEnabledAt === null ? null : now;
        database
            .query(
                `INSERT INTO auth_sessions (
                    id, user_id, validator_hash, validator_version,
                    created_at, authenticated_at, last_seen_at, expires_at,
                    authentication_version, auth_method, password_verified_at,
                    mfa_verified_at, user_agent
                 ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'password', ?, ?, NULL)`
            )
            .run(
                session.prefix,
                user.id,
                session.validatorHash,
                now,
                now,
                now,
                now + 5 * 60_000,
                user.authenticationVersion,
                now,
                mfaVerifiedAt
            );
        inserted = true;
        const cookie = `__Host-mira_dashboard_session=${session.token}`;
        const headers = Object.freeze({ cookie });

        const runtimeIdentity = v.parse(
            runtimeIdentitySchema,
            await trpcJson(baseUrl, "system.runtimeIdentity", {}, {}, fetcher)
        );
        if (runtimeIdentity.revision !== runtime.identity.revision) throw failure();

        const deadline = Date.now() + smokeDeadlineMs;
        let diagnostics: v.InferOutput<typeof systemHealthDiagnosticsSchema> | undefined;
        while (Date.now() < deadline) {
            try {
                diagnostics = v.parse(
                    systemHealthDiagnosticsSchema,
                    await trpcJson(
                        baseUrl,
                        "system.healthDiagnostics",
                        {},
                        headers,
                        fetcher
                    )
                );
                if (
                    diagnostics.status === "ready" &&
                    diagnostics.checks.worker.status === "ready" &&
                    diagnostics.dependencies.gateway.status === "observed" &&
                    diagnostics.dependencies.gateway.freshness === "fresh"
                ) {
                    break;
                }
            } catch {
                // Retry only inside the fixed smoke deadline.
            }
            await Bun.sleep(100);
        }
        if (
            diagnostics?.status !== "ready" ||
            diagnostics.dependencies.gateway.status !== "observed" ||
            diagnostics.dependencies.gateway.freshness !== "fresh"
        ) {
            throw failure();
        }
        await runProductionAuthoritySmoke();

        const frontend = await fetcher(baseUrl, {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (
            frontend.status !== 200 ||
            !frontend.headers.get("content-type")?.includes("text/html")
        ) {
            throw failure();
        }
        await requireProductionDeliveryGeneratedDocumentation(release, testHooks);

        const observedRun = Promise.withResolvers<void>();
        const pendingRunIds = new Set<string>();
        let expectedRunId: string | undefined;
        const subscription = (testHooks.subscribeToJobRuns ?? subscribeToJobRuns)({
            baseUrl,
            cookie,
            fetcher,
            onData(value: unknown) {
                const parsed = v.safeParse(realtimeStreamOutputSchema, value);
                if (!parsed.success) {
                    observedRun.reject(failure());
                    return;
                }
                const event = parsed.output;
                if (event.data.kind !== "change") return;
                const runId = event.data.event.entityId;
                if (expectedRunId === runId) {
                    observedRun.resolve();
                    return;
                }
                if (expectedRunId !== undefined) return;
                if (pendingRunIds.size >= maximumPendingRealtimeRunIds) {
                    observedRun.reject(failure());
                    return;
                }
                pendingRunIds.add(runId);
            },
            onError: observedRun.reject,
        });
        try {
            await withinRequestDeadline(subscription.connected);
            const queued = v.parse(
                jobRunSummarySchema,
                await trpcJson(
                    baseUrl,
                    "schedules.run",
                    {
                        id: "system.worker-smoke",
                        idempotencyKey: smokeIdempotencyKey(transitionId),
                    },
                    headers,
                    fetcher,
                    "POST"
                )
            );
            expectedRunId = queued.id;
            if (pendingRunIds.has(expectedRunId)) observedRun.resolve();
            pendingRunIds.clear();
            let succeeded = false;
            const runDeadline = Date.now() + smokeDeadlineMs;
            while (Date.now() < runDeadline) {
                const detail = v.parse(
                    jobRunDetailSchema,
                    await trpcJson(
                        baseUrl,
                        "jobs.getRun",
                        { id: queued.id },
                        headers,
                        fetcher
                    )
                );
                if (detail.run.state === "succeeded") {
                    if (
                        detail.result?.status !== "ok" ||
                        detail.result.databaseReleaseId !==
                            release.manifest.source.commitSha
                    ) {
                        throw failure();
                    }
                    succeeded = true;
                    break;
                }
                if (["cancelled", "failed", "timed-out"].includes(detail.run.state)) {
                    throw failure();
                }
                await Bun.sleep(100);
            }
            if (!succeeded) throw failure();
            await withinRequestDeadline(observedRun.promise);
        } finally {
            subscription.unsubscribe();
        }
    } catch {
        throw failure();
    } finally {
        if (inserted) {
            database.query("DELETE FROM auth_sessions WHERE id = ?").run(session.prefix);
        }
        database.close(true);
    }
}
