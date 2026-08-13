import { Database } from "bun:sqlite";
import { lstat, readFile } from "node:fs/promises";
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
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";

const smokeFailureMessage = "Production Delivery target smoke failed";
const smokeDeadlineMs = 30_000;
const requestTimeoutMs = 2000;
const maximumDocumentationBytes = 64 * 1024;

interface TrpcEnvelope {
    readonly error?: unknown;
    readonly result?: { readonly data?: { readonly json?: unknown } };
}

interface ActiveUserRow {
    readonly authenticationVersion: number;
    readonly id: string;
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
    method: "GET" | "POST" = "GET"
): Promise<unknown> {
    const encoded = JSON.stringify({ json: input });
    const response = await fetch(
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

function eventSourceFetchWithCookie(cookie: string) {
    return (url: string | URL, init: EventSourceFetchInit): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set("cookie", cookie);
        return fetch(url, { ...init, headers, redirect: "error" });
    };
}

async function requireGeneratedDocumentation(
    release: PublishedProductionRelease
): Promise<void> {
    const documentation = path.join(release.releaseRoot, "docs/generated/README.md");
    const status = await lstat(documentation, { bigint: true });
    if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.size <= 0n ||
        status.size > BigInt(maximumDocumentationBytes)
    ) {
        throw failure();
    }
    const contents = await readFile(documentation);
    if (contents.byteLength !== Number(status.size)) throw failure();
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
    transitionId: string
): Promise<void> {
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
                `SELECT id, authentication_version AS authenticationVersion
                 FROM users
                 WHERE disabled_at IS NULL
                 ORDER BY created_at ASC, id ASC
                 LIMIT 2`
            )
            .all();
        const user = users[0];
        if (user === undefined || !Number.isSafeInteger(user.authenticationVersion)) {
            throw failure();
        }
        const now = Date.now();
        database
            .query(
                `INSERT INTO auth_sessions (
                    id, user_id, validator_hash, validator_version,
                    created_at, authenticated_at, last_seen_at, expires_at,
                    authentication_version, auth_method, password_verified_at,
                    mfa_verified_at, user_agent
                 ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'password', ?, NULL, NULL)`
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
                now
            );
        inserted = true;
        const cookie = `__Host-mira_dashboard_session=${session.token}`;
        const headers = Object.freeze({ cookie });

        const runtimeIdentity = v.parse(
            runtimeIdentitySchema,
            await trpcJson(baseUrl, "system.runtimeIdentity", {}, {})
        );
        if (runtimeIdentity.revision !== runtime.identity.revision) throw failure();

        const deadline = Date.now() + smokeDeadlineMs;
        let diagnostics: v.InferOutput<typeof systemHealthDiagnosticsSchema> | undefined;
        while (Date.now() < deadline) {
            try {
                diagnostics = v.parse(
                    systemHealthDiagnosticsSchema,
                    await trpcJson(baseUrl, "system.healthDiagnostics", {}, headers)
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

        const frontend = await fetch(baseUrl, {
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
        await requireGeneratedDocumentation(release);

        const client = createTRPCUntypedClient({
            links: [
                httpSubscriptionLink({
                    EventSource,
                    eventSourceOptions: { fetch: eventSourceFetchWithCookie(cookie) },
                    transformer: superjson,
                    url: new URL("/trpc", baseUrl).toString(),
                }),
            ],
        });
        const observedRun = Promise.withResolvers<void>();
        let expectedRunId: string | undefined;
        const subscription = client.subscription(
            "events.stream",
            { topics: [jobRealtimeTopics.runs] },
            {
                onData(value: unknown) {
                    const parsed = v.safeParse(realtimeStreamOutputSchema, value);
                    if (!parsed.success) {
                        observedRun.reject(failure());
                        return;
                    }
                    const event = parsed.output;
                    if (
                        expectedRunId !== undefined &&
                        event.data.kind === "change" &&
                        event.data.event.entityId === expectedRunId
                    ) {
                        observedRun.resolve();
                    }
                },
                onError: observedRun.reject,
            }
        );
        try {
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
                    "POST"
                )
            );
            expectedRunId = queued.id;
            let succeeded = false;
            const runDeadline = Date.now() + smokeDeadlineMs;
            while (Date.now() < runDeadline) {
                const detail = v.parse(
                    jobRunDetailSchema,
                    await trpcJson(baseUrl, "jobs.getRun", { id: queued.id }, headers)
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
            await Promise.race([
                observedRun.promise,
                Bun.sleep(requestTimeoutMs).then(() => {
                    throw failure();
                }),
            ]);
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
