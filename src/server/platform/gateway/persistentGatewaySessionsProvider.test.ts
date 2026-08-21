import { describe, expect, test } from "bun:test";

import { gatewaySessionProjectionMaximum } from "../../../contracts/gatewaySessions.ts";
import {
    GatewaySessionProviderAbortError,
    GatewaySessionProviderConflictError,
    GatewaySessionProviderNotFoundError,
    GatewaySessionProviderUnknownOutcomeError,
    GatewaySessionProviderUnavailableError,
} from "../../domains/gatewaySessions/provider.ts";
import type {
    PersistentGatewayAdminMethod,
    PersistentGatewayWebReadMethod,
} from "./persistentGatewayProtocol.ts";
import {
    createPersistentGatewaySessionsProvider,
    persistentGatewaySessionCompactionTimeoutMs,
    persistentGatewaySessionControlTimeoutMs,
    persistentGatewaySessionsListTimeoutMs,
    type PersistentGatewaySessionsTransport,
} from "./persistentGatewaySessionsProvider.ts";
import {
    PersistentGatewayAbortError,
    PersistentGatewayRequestError,
    type PersistentGatewayRequestOptions,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";

interface CapturedRequest {
    readonly lane: "admin" | "persistent";
    readonly method: string;
    readonly options: PersistentGatewayRequestOptions | undefined;
    readonly parameters: Readonly<Record<string, unknown>>;
}

class TestPersistentGatewaySessionsTransport implements PersistentGatewaySessionsTransport {
    public readonly calls: CapturedRequest[] = [];
    public readonly responses: unknown[] = [];

    public request(
        method: PersistentGatewayWebReadMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        return this.respond({ lane: "persistent", method, options, parameters });
    }

    public requestAdmin(
        method: PersistentGatewayAdminMethod,
        parameters: Readonly<Record<string, unknown>>,
        options?: PersistentGatewayRequestOptions
    ): Promise<unknown> {
        return this.respond({ lane: "admin", method, options, parameters });
    }

    private respond(request: CapturedRequest): Promise<unknown> {
        this.calls.push(request);
        const response = this.responses.shift();
        if (response instanceof Error) return Promise.reject(response);
        return Promise.resolve(response);
    }
}

function upstreamSession(
    key: string,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return {
        key,
        kind: "direct",
        updatedAt: 1_800_000_000_000,
        ...overrides,
    };
}

function listResponse(
    sessions: readonly Readonly<Record<string, unknown>>[],
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return {
        count: sessions.length,
        creators: [],
        defaults: {},
        hasMore: false,
        limitApplied: sessions.length || 1,
        nextOffset: null,
        path: "(multiple)",
        sessions,
        totalCount: sessions.length,
        ts: 1_800_000_000_100,
        ...overrides,
    };
}

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

describe("persistent Gateway sessions provider", () => {
    test("projects one bounded current snapshot through the persistent lane", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        const abortController = new AbortController();
        transport.responses.push(
            listResponse(
                [
                    upstreamSession("agent:main:main", {
                        channel: "webchat",
                        displayName: "Main",
                        hasActiveRun: true,
                        model: "gpt-5.6-sol",
                        modelProvider: "openai",
                        sessionId: "session-main-1",
                        totalTokens: 42,
                        totalTokensFresh: true,
                    }),
                    upstreamSession("agent:main:subagent:child", {
                        createdVia: "spawn",
                        displayName: "Child",
                        totalTokens: 12,
                        totalTokensFresh: false,
                    }),
                    upstreamSession("agent:main:hook:startup", {
                        label: "Startup hook",
                        updatedAt: null,
                    }),
                    upstreamSession("agent:main:cron:daily", {
                        createdVia: "cron",
                        displayName: "Daily cron",
                    }),
                    upstreamSession("future-session-format", {
                        displayName: "Future session",
                        kind: "unknown",
                    }),
                ],
                {
                    hasMore: true,
                    limitApplied: 5,
                    nextOffset: 5,
                    offset: null,
                    totalCount: 6,
                }
            )
        );
        const provider = createPersistentGatewaySessionsProvider(transport);

        const snapshot = await provider.listCurrentSessions({
            limit: 5,
            signal: abortController.signal,
        });

        expect(transport.calls).toEqual([
            {
                lane: "persistent",
                method: "sessions.list",
                options: {
                    signal: abortController.signal,
                    timeoutMs: persistentGatewaySessionsListTimeoutMs,
                },
                parameters: {
                    archived: false,
                    includeGlobal: true,
                    includeUnknown: true,
                    limit: 5,
                    sortBy: "updatedAt",
                },
            },
        ]);
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.sessions).toEqual([
            {
                channel: "webchat",
                displayName: "Main",
                hasActiveRun: true,
                key: "agent:main:main",
                kind: "main",
                model: "gpt-5.6-sol",
                modelProvider: "openai",
                sessionId: "session-main-1",
                totalTokens: 42,
                totalTokensFresh: true,
                updatedAtMs: 1_800_000_000_000,
            },
            {
                displayName: "Child",
                hasActiveRun: false,
                key: "agent:main:subagent:child",
                kind: "subagent",
                totalTokens: 12,
                totalTokensFresh: false,
                updatedAtMs: 1_800_000_000_000,
            },
            {
                displayName: "Startup hook",
                hasActiveRun: false,
                key: "agent:main:hook:startup",
                kind: "hook",
                totalTokensFresh: false,
            },
            {
                displayName: "Daily cron",
                hasActiveRun: false,
                key: "agent:main:cron:daily",
                kind: "cron",
                totalTokensFresh: false,
                updatedAtMs: 1_800_000_000_000,
            },
            {
                displayName: "Future session",
                hasActiveRun: false,
                key: "future-session-format",
                kind: "unknown",
                totalTokensFresh: false,
                updatedAtMs: 1_800_000_000_000,
            },
        ]);
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.sessions)).toBe(true);
    });

    test("retains source-valid long metadata with explicit truncation and omission markers", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        const longLabel = "Long operator-facing label ".repeat(20);
        const longMetadata = "metadata".repeat(64);
        transport.responses.push(
            listResponse(
                [
                    upstreamSession("agent:main:subagent:long-metadata", {
                        channel: longMetadata,
                        displayName: longLabel,
                        elevatedLevel: longMetadata,
                        model: longMetadata,
                        modelProvider: longMetadata,
                        reasoningLevel: longMetadata,
                        sessionId: "session-long-metadata-1",
                        thinkingDefault: longMetadata,
                        thinkingLevel: longMetadata,
                        thinkingLevels: [{ id: longMetadata, label: longMetadata }],
                        thinkingOptions: [longMetadata],
                        verboseLevel: longMetadata,
                    }),
                ],
                { limitApplied: 1 }
            )
        );
        const provider = createPersistentGatewaySessionsProvider(transport);

        const snapshot = await provider.listCurrentSessions({ limit: 1 });

        expect(snapshot.sessions).toHaveLength(1);
        expect(snapshot.sessions[0]).toMatchObject({
            displayNameTruncated: true,
            key: "agent:main:subagent:long-metadata",
            omittedMetadataFields: [
                "channel",
                "elevatedLevel",
                "model",
                "modelProvider",
                "reasoningLevel",
                "thinkingDefault",
                "thinkingLevel",
                "thinkingLevels",
                "thinkingOptions",
                "verboseLevel",
            ],
            sessionId: "session-long-metadata-1",
        });
        const projectedName = snapshot.sessions[0]?.displayName;
        let projectedNameLength = 0;
        for (const _codePoint of projectedName ?? "") projectedNameLength += 1;
        expect(projectedNameLength).toBe(256);
        expect(projectedName).toEndWith("…");
        expect(projectedName).not.toBe(longLabel);
        expect(snapshot.sessions[0]?.model).toBeUndefined();
        expect(snapshot.sessions[0]?.channel).toBeUndefined();
    });

    test("classifies only agent:main identities as main legacy sessions", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        transport.responses.push(
            listResponse(
                [
                    upstreamSession("agent:main:main"),
                    upstreamSession("agent:main:review"),
                    upstreamSession("agent:coder:main"),
                ],
                { limitApplied: 3 }
            )
        );
        const provider = createPersistentGatewaySessionsProvider(transport);

        const snapshot = await provider.listCurrentSessions({ limit: 3 });

        expect(snapshot.sessions.map(({ key, kind }) => ({ key, kind }))).toEqual([
            { key: "agent:main:main", kind: "main" },
            { key: "agent:main:review", kind: "main" },
            { key: "agent:coder:main", kind: "subagent" },
        ]);
    });

    test("rejects requests and responses outside the 200-row projection budget", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        const provider = createPersistentGatewaySessionsProvider(transport);

        expect(
            await captureFailure(() =>
                provider.listCurrentSessions({
                    limit: gatewaySessionProjectionMaximum + 1,
                })
            )
        ).toBeInstanceOf(GatewaySessionProviderUnavailableError);
        expect(transport.calls).toHaveLength(0);

        const oversizedSessions = Array.from(
            { length: gatewaySessionProjectionMaximum + 1 },
            (_, index) => upstreamSession(`agent:main:subagent:${index}`)
        );
        transport.responses.push(
            listResponse(oversizedSessions, {
                count: gatewaySessionProjectionMaximum,
                limitApplied: gatewaySessionProjectionMaximum,
            })
        );
        expect(
            await captureFailure(() =>
                provider.listCurrentSessions({
                    limit: gatewaySessionProjectionMaximum,
                })
            )
        ).toBeInstanceOf(GatewaySessionProviderUnavailableError);
    });

    test("fails closed on malformed, duplicate, or inconsistent list responses", async () => {
        for (const { limit, response } of [
            { limit: 1, response: { sessions: "private malformed payload" } },
            {
                limit: 2,
                response: listResponse(
                    [
                        upstreamSession("agent:main:main"),
                        upstreamSession("agent:main:main"),
                    ],
                    { limitApplied: 2 }
                ),
            },
            {
                limit: 1,
                response: listResponse([upstreamSession("agent:main:main")], {
                    hasMore: false,
                    limitApplied: 1,
                    nextOffset: 1,
                }),
            },
            {
                limit: 2,
                response: listResponse([upstreamSession("agent:main:main")], {
                    count: 2,
                    limitApplied: 2,
                    totalCount: 2,
                }),
            },
            {
                limit: 1,
                response: listResponse([upstreamSession("agent:main:main")], {
                    hasMore: false,
                    limitApplied: 1,
                    totalCount: 2,
                }),
            },
            {
                limit: 1,
                response: listResponse([upstreamSession("agent:main:main")], {
                    hasMore: true,
                    limitApplied: 1,
                    nextOffset: 2,
                    totalCount: 2,
                }),
            },
            {
                limit: 1,
                response: listResponse(
                    [
                        upstreamSession("agent:main:main", {
                            displayName: "private\ncontrol text",
                        }),
                    ],
                    { limitApplied: 1 }
                ),
            },
        ]) {
            const transport = new TestPersistentGatewaySessionsTransport();
            transport.responses.push(response);
            const provider = createPersistentGatewaySessionsProvider(transport);
            const error = await captureFailure(() =>
                provider.listCurrentSessions({ limit })
            );
            expect(error).toBeInstanceOf(GatewaySessionProviderUnavailableError);
            expect(String(error)).not.toContain("private");
        }
    });

    test("uses fresh admin lanes and explicit deadlines for all three controls", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        transport.responses.push(
            {
                compacted: true,
                key: "agent:main:main",
                ok: true,
            },
            {
                entry: {},
                key: "agent:main:subagent:child",
                ok: true,
                resolved: {},
            },
            {
                archived: ["/managed/archive/transcript.jsonl"],
                deleted: true,
                key: "agent:main:cron:daily",
                ok: true,
            }
        );
        const provider = createPersistentGatewaySessionsProvider(transport);

        expect(await provider.compactSession({ key: "agent:main:main" })).toBe(
            "compacted"
        );
        await provider.resetSession({ key: "agent:main:subagent:child" });
        await provider.deleteSessionTranscript({
            expectedSessionId: "session-cron-1",
            expectedUpdatedAtMs: 1_800_000_000_000,
            key: "agent:main:cron:daily",
        });

        expect(transport.calls).toEqual([
            {
                lane: "admin",
                method: "sessions.compact",
                options: { timeoutMs: persistentGatewaySessionCompactionTimeoutMs },
                parameters: { key: "agent:main:main" },
            },
            {
                lane: "admin",
                method: "sessions.reset",
                options: { timeoutMs: persistentGatewaySessionControlTimeoutMs },
                parameters: {
                    key: "agent:main:subagent:child",
                    reason: "reset",
                },
            },
            {
                lane: "admin",
                method: "sessions.delete",
                options: { timeoutMs: persistentGatewaySessionControlTimeoutMs },
                parameters: {
                    deleteTranscript: true,
                    expectedSessionId: "session-cron-1",
                    expectedSessionUpdatedAt: 1_800_000_000_000,
                    key: "agent:main:cron:daily",
                },
            },
        ]);
    });

    test("maps an unconfirmed deletion to the narrow not-found error", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        transport.responses.push({
            archived: [],
            deleted: false,
            key: "agent:main:subagent:missing",
            ok: true,
        });
        const provider = createPersistentGatewaySessionsProvider(transport);

        expect(
            await captureFailure(() =>
                provider.deleteSessionTranscript({
                    expectedSessionId: "session-missing-1",
                    key: "agent:main:subagent:missing",
                })
            )
        ).toBeInstanceOf(GatewaySessionProviderNotFoundError);
    });

    test("preserves a confirmed compact no-op as unchanged", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        transport.responses.push({
            compacted: false,
            key: "agent:main:main",
            ok: false,
            reason: "no transcript",
        });
        const provider = createPersistentGatewaySessionsProvider(transport);

        expect(await provider.compactSession({ key: "agent:main:main" })).toBe(
            "unchanged"
        );
    });

    test("requires a positive acknowledgement when compact reports a change", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        transport.responses.push({
            compacted: true,
            key: "agent:main:main",
            ok: false,
        });
        const provider = createPersistentGatewaySessionsProvider(transport);

        expect(
            await captureFailure(() =>
                provider.compactSession({ key: "agent:main:main" })
            )
        ).toBeInstanceOf(GatewaySessionProviderUnknownOutcomeError);
    });

    test("classifies mismatched and malformed success acknowledgements as unknown", async () => {
        for (const response of [
            {
                deleted: true,
                key: "agent:main:subagent:different",
                ok: true,
            },
            {
                archived: [],
                deleted: true,
                key: "private\ninvalid-key",
                ok: true,
            },
        ]) {
            const transport = new TestPersistentGatewaySessionsTransport();
            transport.responses.push(response);
            const provider = createPersistentGatewaySessionsProvider(transport);
            const error = await captureFailure(() =>
                provider.deleteSessionTranscript({
                    expectedSessionId: "session-target-1",
                    key: "agent:main:subagent:target",
                })
            );
            expect(error).toBeInstanceOf(GatewaySessionProviderUnknownOutcomeError);
            expect(String(error)).not.toContain("private");
        }
    });

    test("preserves the transport unknown-outcome boundary for every control", async () => {
        for (const action of ["compact", "reset", "delete"] as const) {
            const transport = new TestPersistentGatewaySessionsTransport();
            transport.responses.push(new PersistentGatewayUnknownOutcomeError());
            const provider = createPersistentGatewaySessionsProvider(transport);
            const error = await captureFailure(() => {
                switch (action) {
                    case "compact": {
                        return provider.compactSession({ key: "agent:main:main" });
                    }
                    case "reset": {
                        return provider.resetSession({ key: "agent:main:main" });
                    }
                    case "delete": {
                        return provider.deleteSessionTranscript({
                            expectedSessionId: "session-main-1",
                            key: "agent:main:main",
                        });
                    }
                }
            });
            expect(error).toBeInstanceOf(GatewaySessionProviderUnknownOutcomeError);
        }
    });

    test("turns aborted or raw transport failures into safe provider errors", async () => {
        const abortedTransport = new TestPersistentGatewaySessionsTransport();
        abortedTransport.responses.push(new PersistentGatewayAbortError());
        const abortController = new AbortController();
        abortController.abort("private abort reason");
        const abortedProvider = createPersistentGatewaySessionsProvider(abortedTransport);
        const abortError = await captureFailure(() =>
            abortedProvider.listCurrentSessions({
                limit: 1,
                signal: abortController.signal,
            })
        );
        expect(abortError).toBeInstanceOf(GatewaySessionProviderAbortError);
        expect(String(abortError)).not.toContain("private");
        expect(abortedTransport.calls).toHaveLength(0);

        const failedTransport = new TestPersistentGatewaySessionsTransport();
        failedTransport.responses.push(new Error("private upstream failure"));
        const failedProvider = createPersistentGatewaySessionsProvider(failedTransport);
        const unavailableError = await captureFailure(() =>
            failedProvider.listCurrentSessions({ limit: 1 })
        );
        expect(unavailableError).toBeInstanceOf(GatewaySessionProviderUnavailableError);
        expect(String(unavailableError)).not.toContain("private");
    });

    test("maps only the audited lifecycle-change reason to a conflict", async () => {
        const transport = new TestPersistentGatewaySessionsTransport();
        transport.responses.push(
            new PersistentGatewayRequestError({
                code: "INVALID_REQUEST",
                reason: "session-changed",
            })
        );
        const provider = createPersistentGatewaySessionsProvider(transport);

        expect(
            await captureFailure(() =>
                provider.deleteSessionTranscript({
                    expectedSessionId: "session-target-1",
                    expectedUpdatedAtMs: 1_800_000_000_000,
                    key: "agent:main:subagent:target",
                })
            )
        ).toBeInstanceOf(GatewaySessionProviderConflictError);

        expect(transport.calls[0]).toMatchObject({
            method: "sessions.delete",
            parameters: {
                deleteTranscript: true,
                expectedSessionId: "session-target-1",
                expectedSessionUpdatedAt: 1_800_000_000_000,
                key: "agent:main:subagent:target",
            },
        });
    });
});
