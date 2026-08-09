import { describe, expect, test } from "bun:test";

import type { GatewaySession } from "../../../contracts/gatewaySessions.ts";
import {
    gatewayPrimarySessionKey,
    gatewaySessionProjectionMaximum,
} from "../../../contracts/gatewaySessions.ts";
import type {
    GatewaySessionControlAuditAttempt,
    GatewaySessionControlAuditPort,
    GatewaySessionControlRequestContext,
} from "./controlAudit.ts";
import {
    GatewaySessionConflictError,
    GatewaySessionControlForbiddenError,
    GatewaySessionControlUnknownOutcomeError,
    GatewaySessionControlUnavailableError,
    GatewaySessionNotFoundError,
    GatewaySessionsUnavailableError,
} from "./errors.ts";
import {
    GatewaySessionProviderConflictError,
    GatewaySessionProviderNotFoundError,
    GatewaySessionProviderUnknownOutcomeError,
    type GatewaySessionProviderActionRequest,
    type GatewaySessionProviderDeleteRequest,
    type GatewaySessionProviderRequest,
    type GatewaySessionProviderSnapshot,
    type GatewaySessionsProvider,
} from "./provider.ts";
import {
    createGatewaySessionsService,
    type GatewaySessionsServiceDependencies,
} from "./service.ts";
import type { GatewaySessionTranscriptLifecyclePort } from "./transcriptLifecycle.ts";

const observedAtMs = 1_800_000_000_000;
const controlContext: GatewaySessionControlRequestContext = Object.freeze({
    actor: Object.freeze({
        authenticatorId: "a".repeat(32),
        id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
        kind: "user",
    }),
    requestId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b5",
});

class TestGatewaySessionControlAudit implements GatewaySessionControlAuditPort {
    public beginFailure: Error | undefined;
    public readonly events: string[] = [];
    public settlementPartial = false;

    public begin({
        action,
        context,
    }: Parameters<
        GatewaySessionControlAuditPort["begin"]
    >[0]): Promise<GatewaySessionControlAuditAttempt> {
        if (this.beginFailure !== undefined) return Promise.reject(this.beginFailure);
        this.events.push(`attempted:${action}:${context.requestId}`);
        return Promise.resolve({
            action,
            actor: context.actor,
            requestId: context.requestId,
            targetFingerprint: "sha256:".padEnd(71, "0"),
        });
    }

    public settle(
        attempt: GatewaySessionControlAuditAttempt,
        outcome: "failed" | "partial" | "succeeded"
    ): Promise<"partial" | "settled"> {
        this.events.push(`${outcome}:${attempt.action}:${attempt.requestId}`);
        return Promise.resolve(this.settlementPartial ? "partial" : "settled");
    }
}

const noOpGatewaySessionTranscriptLifecycle = Object.freeze({
    beginControl: () => Promise.resolve(),
    failControl: () => Promise.resolve(),
    observeSnapshot: () => Promise.resolve(),
    settleUnchangedControl: () => Promise.resolve(),
}) satisfies GatewaySessionTranscriptLifecyclePort;

function createTestGatewaySessionsService(
    dependencies: Omit<GatewaySessionsServiceDependencies, "controlAudit">,
    controlAudit: GatewaySessionControlAuditPort = new TestGatewaySessionControlAudit(),
    transcriptLifecycle: GatewaySessionTranscriptLifecyclePort = noOpGatewaySessionTranscriptLifecycle
) {
    return createGatewaySessionsService({
        ...dependencies,
        controlAudit,
        transcriptLifecycle,
    });
}

function session(
    key: string,
    kind: GatewaySession["kind"],
    updatedAtMs: number,
    overrides: Partial<GatewaySession> = {}
): GatewaySession {
    return {
        displayName: key,
        hasActiveRun: false,
        key,
        kind,
        totalTokensFresh: false,
        updatedAtMs,
        ...overrides,
    };
}

class TestGatewaySessionsProvider implements GatewaySessionsProvider {
    public readonly actions: Array<{
        action: string;
        expectedSessionId?: string;
        expectedUpdatedAtMs?: number;
        key: string;
    }> = [];
    public readonly limits: number[] = [];
    public actionFailure: Error | undefined;
    public snapshots: Array<GatewaySessionProviderSnapshot | Error> = [];

    public compactSession(
        request: GatewaySessionProviderActionRequest
    ): Promise<"compacted"> {
        this.actions.push({ action: "compact", key: request.key });
        return this.actionFailure === undefined
            ? Promise.resolve("compacted")
            : Promise.reject(this.actionFailure);
    }

    public deleteSessionTranscript(
        request: GatewaySessionProviderDeleteRequest
    ): Promise<void> {
        this.actions.push({
            action: "delete-transcript",
            expectedSessionId: request.expectedSessionId,
            ...(request.expectedUpdatedAtMs === undefined
                ? {}
                : { expectedUpdatedAtMs: request.expectedUpdatedAtMs }),
            key: request.key,
        });
        return this.actionFailure === undefined
            ? Promise.resolve()
            : Promise.reject(this.actionFailure);
    }

    public listCurrentSessions(
        request: GatewaySessionProviderRequest
    ): Promise<GatewaySessionProviderSnapshot> {
        this.limits.push(request.limit);
        const response = this.snapshots.shift();
        if (response === undefined) return Promise.reject(new Error("No test snapshot"));
        return response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve(response);
    }

    public resetSession(request: GatewaySessionProviderActionRequest): Promise<void> {
        this.actions.push({ action: "reset", key: request.key });
        return this.actionFailure === undefined
            ? Promise.resolve()
            : Promise.reject(this.actionFailure);
    }
}

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

function unsortedProjection(): GatewaySessionProviderSnapshot {
    return {
        sessions: [
            session("cron:daily", "cron", observedAtMs - 30_000),
            session("agent:main:subagent:old", "subagent", observedAtMs - 3_700_000),
            session("agent:coder:main", "subagent", observedAtMs - 20_000),
            session(gatewayPrimarySessionKey, "main", observedAtMs - 10_000, {
                hasActiveRun: true,
            }),
            session("hook:startup", "hook", observedAtMs - 40_000),
        ],
        truncated: false,
    };
}

describe("Gateway sessions service", () => {
    test("requests one bounded projection and derives stable same-snapshot stats", async () => {
        const provider = new TestGatewaySessionsProvider();
        provider.snapshots.push(unsortedProjection(), unsortedProjection());
        const service = createTestGatewaySessionsService({
            nowMs: () => observedAtMs,
            provider,
        });

        expect(service.readHeartbeatProjection()).toEqual({ state: "unavailable" });
        expect(provider.limits).toEqual([]);
        const all = await service.list({ filter: "ALL" });
        expect(provider.limits).toEqual([gatewaySessionProjectionMaximum]);
        expect(all.sessions.map(({ key }) => key)).toEqual([
            gatewayPrimarySessionKey,
            "agent:coder:main",
            "agent:main:subagent:old",
            "hook:startup",
            "cron:daily",
        ]);
        expect(all.stats).toEqual({
            activeInLastHour: 4,
            byKind: { cron: 1, hook: 1, main: 1, subagent: 2, unknown: 0 },
            byModel: [],
            shown: 5,
            tokenTotalState: "partial",
            totalTokens: 0,
            unknownModelCount: 5,
        });

        const main = await service.list({ filter: "MAIN" });
        expect(main.sessions.map(({ key }) => key)).toEqual([gatewayPrimarySessionKey]);
        expect(main.stats).toEqual({
            activeInLastHour: 1,
            byKind: { cron: 0, hook: 0, main: 1, subagent: 0, unknown: 0 },
            byModel: [],
            shown: 1,
            tokenTotalState: "partial",
            totalTokens: 0,
            unknownModelCount: 1,
        });
        expect(service.readHeartbeatProjection()).toEqual({
            count: 5,
            observedAtMs,
            state: "fresh",
            truncated: false,
        });
    });

    test("returns stale last-known-good rows after a background failure", async () => {
        const provider = new TestGatewaySessionsProvider();
        provider.snapshots.push(
            unsortedProjection(),
            new Error("secret upstream detail")
        );
        let nowMs = observedAtMs;
        const service = createTestGatewaySessionsService({
            nowMs: () => nowMs,
            provider,
        });

        const fresh = await service.list({ filter: "ALL" });
        nowMs += 15_000;
        const stale = await service.list({ filter: "CRON" });

        expect(fresh.source).toEqual({
            checkedAtMs: observedAtMs,
            connection: "connected",
            freshness: "fresh",
            observedAtMs,
        });
        expect(stale.source).toEqual({
            checkedAtMs: observedAtMs + 15_000,
            connection: "disconnected",
            freshness: "stale",
            observedAtMs,
        });
        expect(stale.sessions.map(({ key }) => key)).toEqual(["cron:daily"]);
        expect(service.readHeartbeatProjection()).toEqual({
            count: 5,
            observedAtMs,
            staleSinceMs: observedAtMs + 15_000,
            state: "last-known-good",
            truncated: false,
        });
    });

    test("does not let an older in-flight refresh replace a newer projection", async () => {
        let resolveOlder: ((value: GatewaySessionProviderSnapshot) => void) | undefined;
        let resolveNewer: ((value: GatewaySessionProviderSnapshot) => void) | undefined;
        let call = 0;
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () => Promise.resolve(),
            listCurrentSessions: () => {
                call += 1;
                return new Promise<GatewaySessionProviderSnapshot>((resolve) => {
                    if (call === 1) resolveOlder = resolve;
                    else resolveNewer = resolve;
                });
            },
            resetSession: () => Promise.resolve(),
        };
        let nowMs = observedAtMs;
        const service = createTestGatewaySessionsService({
            nowMs: () => nowMs,
            provider,
        });
        const older = service.list({ filter: "ALL" });
        nowMs += 1000;
        const newer = service.list({ filter: "ALL" });

        resolveNewer?.({
            sessions: [session("cron:newer", "cron", nowMs)],
            truncated: false,
        });
        const newestProjection = await newer;
        resolveOlder?.({
            sessions: [session("cron:older", "cron", observedAtMs)],
            truncated: false,
        });
        const lateOlderProjection = await older;

        expect(newestProjection.sessions.map(({ key }) => key)).toEqual(["cron:newer"]);
        expect(lateOlderProjection.sessions.map(({ key }) => key)).toEqual([
            "cron:newer",
        ]);
        expect(lateOlderProjection.source.observedAtMs).toBe(observedAtMs + 1000);
    });

    test("returns stale seeded LKG when a confirmed delete invalidates an in-flight refresh", async () => {
        let resolvePreDelete:
            | ((value: GatewaySessionProviderSnapshot) => void)
            | undefined;
        let listCall = 0;
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () => Promise.resolve(),
            listCurrentSessions: () => {
                listCall += 1;
                if (listCall === 1) return Promise.resolve(unsortedProjection());
                if (listCall === 2) {
                    return new Promise<GatewaySessionProviderSnapshot>((resolve) => {
                        resolvePreDelete = resolve;
                    });
                }
                return Promise.reject(new Error("Post-delete refresh unavailable"));
            },
            resetSession: () => Promise.resolve(),
        };
        const service = createTestGatewaySessionsService({
            nowMs: () => observedAtMs,
            provider,
        });
        await service.list({ filter: "ALL" });
        const preDeleteRefresh = service.list({ filter: "ALL" });
        const deleted = await service.delete(
            {
                expectedSessionId: "cron-session-id",
                key: "cron:daily",
            },
            controlContext
        );

        expect(deleted.refresh.status).toBe("available");
        if (deleted.refresh.status !== "available") throw new Error("Missing LKG");
        expect(
            deleted.refresh.snapshot.sessions.some(({ key }) => key === "cron:daily")
        ).toBe(false);

        resolvePreDelete?.(unsortedProjection());
        const lateProjection = await preDeleteRefresh;
        expect(lateProjection.sessions.some(({ key }) => key === "cron:daily")).toBe(
            false
        );
        expect(lateProjection.source).toEqual({
            checkedAtMs: observedAtMs,
            connection: "disconnected",
            freshness: "stale",
            observedAtMs,
        });
        expect(service.readHeartbeatProjection()).toEqual({
            count: 4,
            observedAtMs,
            staleSinceMs: observedAtMs,
            state: "last-known-good",
            truncated: false,
        });
    });

    test("establishes the confirmed mutation barrier before terminal audit settles", async () => {
        const preDeleteRefresh = Promise.withResolvers<GatewaySessionProviderSnapshot>();
        const terminalAuditEntered = Promise.withResolvers<void>();
        const releaseTerminalAudit = Promise.withResolvers<void>();
        let listCall = 0;
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () => Promise.resolve(),
            listCurrentSessions: () => {
                listCall += 1;
                if (listCall === 1) return Promise.resolve(unsortedProjection());
                if (listCall === 2) return preDeleteRefresh.promise;
                return Promise.reject(new Error("Post-delete refresh unavailable"));
            },
            resetSession: () => Promise.resolve(),
        };
        const audit: GatewaySessionControlAuditPort = {
            begin: ({ action, context }) =>
                Promise.resolve({
                    action,
                    actor: context.actor,
                    requestId: context.requestId,
                    targetFingerprint: "sha256:".padEnd(71, "0"),
                }),
            settle: async (_attempt, outcome) => {
                if (outcome === "succeeded") {
                    terminalAuditEntered.resolve();
                    await releaseTerminalAudit.promise;
                }
                return "settled";
            },
        };
        const service = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider },
            audit
        );
        await service.list({ filter: "ALL" });
        const staleRefresh = service.list({ filter: "ALL" });
        const deletion = service.delete(
            { expectedSessionId: "cron-session-id", key: "cron:daily" },
            controlContext
        );

        await terminalAuditEntered.promise;
        preDeleteRefresh.resolve(unsortedProjection());
        const stale = await staleRefresh;
        expect(stale.sessions.some(({ key }) => key === "cron:daily")).toBe(false);
        expect(stale.source.freshness).toBe("stale");

        releaseTerminalAudit.resolve();
        const result = await deletion;
        expect(result.refresh.status).toBe("available");
        if (result.refresh.status !== "available") throw new Error("Missing LKG");
        expect(
            result.refresh.snapshot.sessions.some(({ key }) => key === "cron:daily")
        ).toBe(false);
    });

    test("fences refreshes and retains identities after an unknown control outcome", async () => {
        const preControlRefresh = Promise.withResolvers<GatewaySessionProviderSnapshot>();
        let listCall = 0;
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () =>
                Promise.reject(new GatewaySessionProviderUnknownOutcomeError()),
            listCurrentSessions: () => {
                listCall += 1;
                return listCall === 1
                    ? Promise.resolve(unsortedProjection())
                    : preControlRefresh.promise;
            },
            resetSession: () => Promise.resolve(),
        };
        const audit = new TestGatewaySessionControlAudit();
        const service = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider },
            audit
        );
        await service.list({ filter: "ALL" });
        const staleRefresh = service.list({ filter: "ALL" });

        expect(
            await captureFailure(() =>
                service.delete(
                    { expectedSessionId: "cron-session-id", key: "cron:daily" },
                    controlContext
                )
            )
        ).toBeInstanceOf(GatewaySessionControlUnknownOutcomeError);
        preControlRefresh.resolve(unsortedProjection());
        const stale = await staleRefresh;
        expect(stale.sessions.some(({ key }) => key === "cron:daily")).toBe(true);
        expect(stale.source.freshness).toBe("stale");
        expect(audit.events).toEqual([
            `attempted:delete:${controlContext.requestId}`,
            `partial:delete:${controlContext.requestId}`,
        ]);
        expect(service.readHeartbeatProjection()).toMatchObject({
            count: 5,
            state: "last-known-good",
        });
    });

    test("returns unavailable when a confirmed delete invalidates an unseeded refresh", async () => {
        let resolvePreDelete:
            | ((value: GatewaySessionProviderSnapshot) => void)
            | undefined;
        let listCall = 0;
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () => Promise.resolve(),
            listCurrentSessions: () => {
                listCall += 1;
                if (listCall === 1) {
                    return new Promise<GatewaySessionProviderSnapshot>((resolve) => {
                        resolvePreDelete = resolve;
                    });
                }
                return Promise.reject(new Error("Post-delete refresh unavailable"));
            },
            resetSession: () => Promise.resolve(),
        };
        const service = createTestGatewaySessionsService({
            nowMs: () => observedAtMs,
            provider,
        });
        const preDeleteRefresh = service.list({ filter: "ALL" });
        const deleted = await service.delete(
            {
                expectedSessionId: "cron-session-id",
                key: "cron:daily",
            },
            controlContext
        );

        expect(deleted.refresh).toEqual({ status: "unavailable" });
        resolvePreDelete?.(unsortedProjection());
        expect(await captureFailure(() => preDeleteRefresh)).toBeInstanceOf(
            GatewaySessionsUnavailableError
        );
        expect(service.readHeartbeatProjection()).toEqual({ state: "unavailable" });
    });

    test("fails safely when no valid current or cached projection exists", async () => {
        const provider = new TestGatewaySessionsProvider();
        provider.snapshots.push(new Error("private gateway response"));
        const service = createTestGatewaySessionsService({
            nowMs: () => observedAtMs,
            provider,
        });

        expect(
            await captureFailure(() => service.list({ filter: "ALL" }))
        ).toBeInstanceOf(GatewaySessionsUnavailableError);
    });

    test("executes only explicit controls and refreshes after confirmation", async () => {
        const provider = new TestGatewaySessionsProvider();
        provider.snapshots.push(
            unsortedProjection(),
            unsortedProjection(),
            unsortedProjection(),
            unsortedProjection()
        );
        const service = createTestGatewaySessionsService({
            nowMs: () => observedAtMs,
            provider,
        });

        await service.list({ filter: "ALL" });
        const compact = await service.compact(
            { key: gatewayPrimarySessionKey },
            controlContext
        );
        const reset = await service.reset({ key: "agent:coder:main" }, controlContext);
        const deleted = await service.delete(
            {
                expectedSessionId: "cron-session-id",
                key: "cron:daily",
            },
            controlContext
        );

        expect(provider.actions).toEqual([
            { action: "compact", key: gatewayPrimarySessionKey },
            { action: "reset", key: "agent:coder:main" },
            {
                action: "delete-transcript",
                expectedSessionId: "cron-session-id",
                key: "cron:daily",
            },
        ]);
        expect(compact.action).toBe("compact");
        expect(reset.action).toBe("reset");
        expect(deleted.action).toBe("delete");
        expect(deleted.refresh.status).toBe("available");
    });

    test("persists the transcript fence before provider dispatch and observes the refresh", async () => {
        const order: string[] = [];
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () => Promise.resolve(),
            listCurrentSessions: () => {
                order.push("provider:list");
                return Promise.resolve(unsortedProjection());
            },
            resetSession: () => {
                order.push("provider:reset");
                return Promise.resolve();
            },
        };
        const lifecycle: GatewaySessionTranscriptLifecyclePort = {
            beginControl: ({ action, controlId }) => {
                order.push(`lifecycle:begin:${action}:${controlId}`);
                return Promise.resolve();
            },
            failControl: () => Promise.resolve(),
            observeSnapshot: ({ observedAtMs: snapshotObservedAtMs }) => {
                order.push(`lifecycle:snapshot:${snapshotObservedAtMs}`);
                return Promise.resolve();
            },
            settleUnchangedControl: () => Promise.resolve(),
        };
        const service = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider },
            new TestGatewaySessionControlAudit(),
            lifecycle
        );

        await service.reset({ key: "agent:coder:main" }, controlContext);

        expect(order).toEqual([
            `lifecycle:begin:reset:${controlContext.requestId}`,
            "provider:reset",
            "provider:list",
            `lifecycle:snapshot:${observedAtMs}`,
        ]);
    });

    test("reopens only definitive failures and unchanged compact controls", async () => {
        async function exercise(
            failure: Error | undefined,
            compactOutcome: "compacted" | "unchanged" = "compacted"
        ): Promise<string[]> {
            const events: string[] = [];
            const provider: GatewaySessionsProvider = {
                compactSession: () =>
                    failure === undefined
                        ? Promise.resolve(compactOutcome)
                        : Promise.reject(failure),
                deleteSessionTranscript: () => Promise.resolve(),
                listCurrentSessions: () => Promise.resolve(unsortedProjection()),
                resetSession: () =>
                    failure === undefined ? Promise.resolve() : Promise.reject(failure),
            };
            const lifecycle: GatewaySessionTranscriptLifecyclePort = {
                beginControl: ({ action }) => {
                    events.push(`begin:${action}`);
                    return Promise.resolve();
                },
                failControl: ({ action }) => {
                    events.push(`fail:${action}`);
                    return Promise.resolve();
                },
                observeSnapshot: () => Promise.resolve(),
                settleUnchangedControl: ({ action }) => {
                    events.push(`unchanged:${action}`);
                    return Promise.resolve();
                },
            };
            const service = createTestGatewaySessionsService(
                { nowMs: () => observedAtMs, provider },
                new TestGatewaySessionControlAudit(),
                lifecycle
            );
            await (compactOutcome === "unchanged"
                ? service.compact({ key: "agent:coder:main" }, controlContext)
                : captureFailure(() =>
                      service.reset({ key: "agent:coder:main" }, controlContext)
                  ));
            return events;
        }

        expect(await exercise(new Error("definitive"))).toEqual([
            "begin:reset",
            "fail:reset",
        ]);
        expect(await exercise(new GatewaySessionProviderUnknownOutcomeError())).toEqual([
            "begin:reset",
        ]);
        expect(await exercise(undefined, "unchanged")).toEqual([
            "begin:compact",
            "unchanged:compact",
        ]);
    });

    test("keeps confirmed deletion successful when its refresh fails", async () => {
        const provider = new TestGatewaySessionsProvider();
        provider.snapshots.push(unsortedProjection(), new Error("refresh failed"));
        let nowMs = observedAtMs;
        const service = createTestGatewaySessionsService({
            nowMs: () => nowMs,
            provider,
        });

        await service.list({ filter: "ALL" });
        nowMs += 1000;
        const result = await service.delete(
            {
                expectedSessionId: "cron-session-id",
                key: "cron:daily",
            },
            controlContext
        );

        expect(result.refresh.status).toBe("available");
        if (result.refresh.status !== "available") throw new Error("Missing snapshot");
        expect(result.refresh.snapshot.source.freshness).toBe("stale");
        expect(
            result.refresh.snapshot.sessions.some(({ key }) => key === "cron:daily")
        ).toBe(false);
        expect(service.readHeartbeatProjection()).toEqual({
            count: 4,
            observedAtMs,
            staleSinceMs: observedAtMs + 1000,
            state: "last-known-good",
            truncated: false,
        });
    });

    test("reports a confirmed action even without any post-action snapshot", async () => {
        const provider = new TestGatewaySessionsProvider();
        provider.snapshots.push(new Error("refresh failed"));
        const service = createTestGatewaySessionsService({
            nowMs: () => observedAtMs,
            provider,
        });

        const result = await service.compact(
            { key: gatewayPrimarySessionKey },
            controlContext
        );
        expect(result).toEqual({
            action: "compact",
            key: gatewayPrimarySessionKey,
            outcome: "changed",
            refresh: { status: "unavailable" },
        });
    });

    test("keeps a confirmed action successful when cancellation reaches only its refresh", async () => {
        const actionDispatched = Promise.withResolvers<void>();
        const actionConfirmation = Promise.withResolvers<void>();
        const refreshDispatched = Promise.withResolvers<void>();
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () => Promise.resolve(),
            listCurrentSessions: ({ signal }) => {
                refreshDispatched.resolve();
                if (signal === undefined) {
                    return Promise.reject(new Error("Missing cancellation signal"));
                }
                signal.throwIfAborted();
                return new Promise<GatewaySessionProviderSnapshot>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () =>
                            reject(
                                signal.reason instanceof Error
                                    ? signal.reason
                                    : new Error("Caller cancelled")
                            ),
                        { once: true }
                    );
                });
            },
            resetSession: () => {
                actionDispatched.resolve();
                return actionConfirmation.promise;
            },
        };
        const audit = new TestGatewaySessionControlAudit();
        const service = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider },
            audit
        );
        const controller = new AbortController();

        const pending = service.reset(
            { key: "agent:coder:main" },
            controlContext,
            controller.signal
        );
        await actionDispatched.promise;
        actionConfirmation.resolve();
        await refreshDispatched.promise;
        controller.abort(new Error("caller cancelled after confirmation"));

        expect(await pending).toEqual({
            action: "reset",
            key: "agent:coder:main",
            outcome: "changed",
            refresh: { status: "unavailable" },
        });
        expect(audit.events).toEqual([
            `attempted:reset:${controlContext.requestId}`,
            `succeeded:reset:${controlContext.requestId}`,
        ]);
    });

    test("still propagates cancellation while an upstream action is unconfirmed", async () => {
        const actionDispatched = Promise.withResolvers<void>();
        const provider: GatewaySessionsProvider = {
            compactSession: () => Promise.resolve("compacted"),
            deleteSessionTranscript: () => Promise.resolve(),
            listCurrentSessions: () => Promise.reject(new Error("Unexpected refresh")),
            resetSession: ({ signal }) => {
                actionDispatched.resolve();
                return new Promise<void>((_resolve, reject) => {
                    signal?.addEventListener(
                        "abort",
                        () =>
                            reject(
                                signal.reason instanceof Error
                                    ? signal.reason
                                    : new Error("Caller cancelled")
                            ),
                        { once: true }
                    );
                });
            },
        };
        const audit = new TestGatewaySessionControlAudit();
        const service = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider },
            audit
        );
        const controller = new AbortController();
        const pending = service.reset(
            { key: "agent:coder:main" },
            controlContext,
            controller.signal
        );

        await actionDispatched.promise;
        controller.abort(new Error("caller cancelled"));

        expect(await captureFailure(() => pending)).toMatchObject({
            message: "caller cancelled",
        });
        expect(audit.events).toEqual([
            `attempted:reset:${controlContext.requestId}`,
            `failed:reset:${controlContext.requestId}`,
        ]);
    });

    test("maps provider action failures without retaining provider messages", async () => {
        for (const [failure, expected] of [
            [new GatewaySessionProviderNotFoundError(), GatewaySessionNotFoundError],
            [new GatewaySessionProviderConflictError(), GatewaySessionConflictError],
            [
                new GatewaySessionProviderUnknownOutcomeError(),
                GatewaySessionControlUnknownOutcomeError,
            ],
            [
                new Error("private provider failure"),
                GatewaySessionControlUnavailableError,
            ],
        ] as const) {
            const provider = new TestGatewaySessionsProvider();
            provider.actionFailure = failure;
            const service = createTestGatewaySessionsService({
                nowMs: () => observedAtMs,
                provider,
            });
            expect(
                await captureFailure(() =>
                    service.reset({ key: gatewayPrimarySessionKey }, controlContext)
                )
            ).toBeInstanceOf(expected);
        }
    });

    test("fails closed before provider dispatch when the attempted audit append fails", async () => {
        const provider = new TestGatewaySessionsProvider();
        const audit = new TestGatewaySessionControlAudit();
        audit.beginFailure = new Error("private audit failure");
        const service = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider },
            audit
        );

        expect(
            await captureFailure(() =>
                service.reset({ key: "agent:coder:main" }, controlContext)
            )
        ).toBeInstanceOf(GatewaySessionControlUnavailableError);
        expect(provider.actions).toEqual([]);
        expect(audit.events).toEqual([]);
    });

    test("settles upstream success and failure without exposing provider details", async () => {
        const successProvider = new TestGatewaySessionsProvider();
        successProvider.snapshots.push(new Error("refresh unavailable"));
        const successAudit = new TestGatewaySessionControlAudit();
        const successService = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider: successProvider },
            successAudit
        );
        await successService.reset({ key: "agent:coder:main" }, controlContext);

        const failureProvider = new TestGatewaySessionsProvider();
        failureProvider.actionFailure = new Error("private upstream failure");
        const failureAudit = new TestGatewaySessionControlAudit();
        const failureService = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider: failureProvider },
            failureAudit
        );
        const failure = await captureFailure(() =>
            failureService.reset({ key: "agent:coder:main" }, controlContext)
        );

        expect(successAudit.events).toEqual([
            `attempted:reset:${controlContext.requestId}`,
            `succeeded:reset:${controlContext.requestId}`,
        ]);
        expect(failureAudit.events).toEqual([
            `attempted:reset:${controlContext.requestId}`,
            `failed:reset:${controlContext.requestId}`,
        ]);
        expect(failure).toBeInstanceOf(GatewaySessionControlUnavailableError);
        expect(String(failure)).not.toContain("private upstream failure");
    });

    test("preserves both upstream truths when terminal audit settlement is partial", async () => {
        const successProvider = new TestGatewaySessionsProvider();
        successProvider.snapshots.push(new Error("refresh unavailable"));
        const successAudit = new TestGatewaySessionControlAudit();
        successAudit.settlementPartial = true;
        const successService = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider: successProvider },
            successAudit
        );
        expect(
            await successService.compact({ key: "agent:coder:main" }, controlContext)
        ).toMatchObject({ action: "compact", outcome: "changed" });

        const failureProvider = new TestGatewaySessionsProvider();
        failureProvider.actionFailure = new GatewaySessionProviderNotFoundError();
        const failureAudit = new TestGatewaySessionControlAudit();
        failureAudit.settlementPartial = true;
        const failureService = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider: failureProvider },
            failureAudit
        );
        expect(
            await captureFailure(() =>
                failureService.reset({ key: "agent:missing" }, controlContext)
            )
        ).toBeInstanceOf(GatewaySessionNotFoundError);
    });

    test("audits and rejects deletion of the reviewed primary session locally", async () => {
        const provider = new TestGatewaySessionsProvider();
        const audit = new TestGatewaySessionControlAudit();
        const service = createTestGatewaySessionsService(
            { nowMs: () => observedAtMs, provider },
            audit
        );

        expect(
            await captureFailure(() =>
                service.delete(
                    {
                        expectedSessionId: "primary-session-id",
                        key: gatewayPrimarySessionKey,
                    },
                    controlContext
                )
            )
        ).toBeInstanceOf(GatewaySessionControlForbiddenError);
        expect(provider.actions).toEqual([]);
        expect(audit.events).toEqual([
            `attempted:delete:${controlContext.requestId}`,
            `failed:delete:${controlContext.requestId}`,
        ]);
    });
});
