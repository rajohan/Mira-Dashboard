import { describe, expect, test } from "bun:test";

import { projectChatExternalRun } from "./chatContractAdapter.ts";
import {
    chatRuntimeMessages,
    chatRuntimePlans,
    createChatRuntimeStore,
    retainedFailedOptimisticSendByteLimit,
    retainedFailedOptimisticSendLimit,
    type ChatExternalRunProjection,
    type ChatRuntimeEvent,
    type ChatRuntimeEventInput,
} from "./chatRuntimeStore.ts";

const sessionKey = "agent:main:main";
const occurredAtMs = 1_800_000_000_000;

function event(sequence: number, value: ChatRuntimeEventInput): ChatRuntimeEvent {
    return {
        ...value,
        cursor: sequence,
        eventId: `event-${sequence}`,
        occurredAtMs: occurredAtMs + sequence,
        runId: "run-1",
        sequence,
        sessionKey,
    };
}

function attachment() {
    return {
        file: new File(["hello"], "note.txt", { type: "text/plain" }),
        id: "attachment-1",
        mediaType: "text/plain",
        name: "note.txt",
        progress: 100,
        reference: "attachment-reference",
        sizeBytes: 5,
        status: "ready" as const,
    };
}

function containsFile(value: unknown): boolean {
    if (value instanceof File) return true;
    if (Array.isArray(value)) return value.some((entry) => containsFile(entry));
    if (typeof value !== "object" || value === null) return false;
    return Object.values(value).some((entry) => containsFile(entry));
}

function retainedBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function providerShapeRichParts(tail: string) {
    return [
        {
            kind: "text" as const,
            sourceKey: "provider-shape-flip:assistant-1",
            text: "A",
        },
        {
            callId: "command-1",
            kind: "tool" as const,
            name: "bash",
            status: "completed" as const,
        },
        {
            kind: "text" as const,
            sourceKey: "provider-shape-flip:assistant-2",
            text: tail,
        },
    ];
}

function providerAnchorPart(key: string) {
    return {
        kind: "thinking" as const,
        sourceKey: `provider-anchors:${key}`,
        status: "running" as const,
        text: key,
    };
}

describe("chat runtime store", () => {
    test("renders a provider user event before any following provider activity", () => {
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active",
                hasUnprojectedActivity: false,
                observationEpoch: 1,
                observedAtMs: occurredAtMs,
                parts: [
                    {
                        kind: "user",
                        messageId: "provider-user-message",
                        occurredAtMs,
                        sequence: 1,
                        text: "**Immediate** [link](https://example.com)",
                    },
                ],
                projectionTruncated: false,
                providerRunId: "provider-user-fast-path",
                sessionKey,
                source: "provider-runtime",
                text: "",
                updatedAtMs: occurredAtMs,
            }),
        ]);

        expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([
            expect.objectContaining({
                idempotencyKey: "provider-user-message",
                parts: [
                    {
                        kind: "text",
                        text: "**Immediate** [link](https://example.com)",
                    },
                ],
                role: "user",
                timestampMs: occurredAtMs,
            }),
        ]);
    });

    test("starts conservatively before inventory or realtime proof arrives", () => {
        expect(createChatRuntimeStore().state.connection).toBe("reconnecting");
    });

    test("keeps provider part boundaries when text resumes after a tool", () => {
        const store = createChatRuntimeStore();
        store.apply(event(1, { clientRunId: "client-1", kind: "started" }));
        store.apply(event(2, { kind: "assistant", mode: "append", text: "Before" }));
        store.apply(
            event(3, {
                callId: "tool-1",
                input: { query: "status" },
                kind: "tool-started",
                name: "status",
            })
        );
        store.apply(event(4, { kind: "assistant", mode: "append", text: "After" }));

        expect(chatRuntimeMessages(store.state, sessionKey)[0]?.parts).toEqual([
            { kind: "text", text: "Before" },
            {
                callId: "tool-1",
                input: { query: "status" },
                kind: "tool",
                name: "status",
                status: "running",
            },
            { kind: "text", text: "After" },
        ]);
    });

    test("overlap-merges shared agent and chat assistant segments exactly once", () => {
        const store = createChatRuntimeStore();
        store.apply(
            event(1, { kind: "assistant", mode: "replace", text: "Release status" })
        );
        store.apply(event(2, { kind: "assistant", mode: "merge", text: "status" }));
        store.apply(
            event(3, {
                kind: "assistant",
                mode: "merge",
                text: "Release status is healthy",
            })
        );
        store.apply(event(4, { kind: "assistant", mode: "merge", text: "." }));
        expect(chatRuntimeMessages(store.state, sessionKey)[0]?.parts).toEqual([
            { kind: "text", text: "Release status is healthy." },
        ]);
    });

    test("deduplicates delivery and accepts process-global cursor gaps", () => {
        const store = createChatRuntimeStore();
        const started = event(1, { kind: "started" });
        store.apply(started);
        store.apply(started);
        store.apply(event(3, { kind: "assistant", mode: "replace", text: "Recovered" }));

        const session = store.state.sessions[sessionKey];
        expect(session?.eventIdentities).toEqual(["event-1", "event-3"]);
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(false);
        store.apply(event(4, { kind: "interrupted" }));
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(true);
        expect(store.state.sessions[sessionKey]?.runs["run-1"]?.phase).toBe(
            "unresolved"
        );
        store.markReconciled(sessionKey, 4);
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(true);
    });

    test("reconciles interruptions per run without unrelated snapshots clearing them", () => {
        const store = createChatRuntimeStore();
        store.apply(event(1, { kind: "interrupted" }));
        const snapshot = {
            lastSequence: 1,
            message: {
                attachments: [],
                id: `runtime:${sessionKey}:run-1`,
                parts: [],
                role: "assistant" as const,
                runId: "run-1",
                sequence: 1,
                sessionKey,
            },
            phase: "active" as const,
            reconciliation: "runtime-authoritative" as const,
            runId: "run-1",
        };
        store.installSnapshots(sessionKey, [snapshot], 1, false);
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(false);

        store.installSnapshots(
            sessionKey,
            [{ ...snapshot, reconciliation: "pending" }],
            2,
            true
        );
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(true);
        store.installSnapshots(
            sessionKey,
            [
                {
                    ...snapshot,
                    reconciliation: "history-authoritative",
                    runId: "run-2",
                    message: {
                        ...snapshot.message,
                        id: `runtime:${sessionKey}:run-2`,
                        runId: "run-2",
                    },
                },
            ],
            3,
            false
        );
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(true);

        store.installSnapshots(
            sessionKey,
            [{ ...snapshot, reconciliation: "failed" }],
            4,
            true
        );
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(true);
        store.installSnapshots(sessionKey, [], 5, true);
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(false);
    });

    test("atomically retires the prior browser transcript when generation changes", () => {
        const store = createChatRuntimeStore();
        store.installSnapshots(sessionKey, [], 1, true, 1);
        store.enqueue({
            attachments: [],
            clientRunId: "client-before-reset",
            createdAtMs: occurredAtMs,
            delivery: "sending",
            idempotencyKey: "0123456789abcdef0123456789abcdef",
            sessionKey,
            text: "Before reset",
        });
        store.apply(event(2, { clientRunId: "client-before-reset", kind: "started" }));
        store.installExternalRuns(sessionKey, [
            {
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                message: {
                    attachments: [],
                    id: "external-before-reset",
                    parts: [],
                    role: "assistant",
                    sequence: 1,
                    sessionKey,
                },
                observationEpoch: 1,
                observedAtMs: occurredAtMs,
                projectionTruncated: false,
                providerRunId: "provider-before-reset",
                source: "provider-runtime",
                updatedAtMs: occurredAtMs,
            },
        ]);

        store.installSnapshots(sessionKey, [], 7, true, 2);

        expect(store.cursorFor(sessionKey)).toBe(7);
        expect(store.transcriptGenerationFor(sessionKey)).toBe(2);
        expect(store.state.sessions[sessionKey]).toMatchObject({
            eventIdentities: [],
            externalRuns: {},
            externalRunsTruncated: false,
            optimisticSends: {},
            runs: {},
        });
    });

    test("retires optimistic and live rows through canonical admission identities", () => {
        const store = createChatRuntimeStore();
        store.enqueue({
            attachments: [attachment()],
            clientRunId: "client-1",
            createdAtMs: occurredAtMs,
            delivery: "sending",
            idempotencyKey: "0123456789abcdef0123456789abcdef",
            sessionKey,
            text: "Hello",
        });
        store.apply(event(1, { clientRunId: "client-1", kind: "started" }));
        store.apply(event(2, { kind: "final", text: "Final answer" }));
        const activeRun = store.state.sessions[sessionKey]?.runs["run-1"];
        if (activeRun === undefined) throw new Error("Expected runtime run");
        store.installSnapshots(
            sessionKey,
            [
                {
                    lastSequence: activeRun.lastSequence,
                    message: {
                        ...activeRun.message,
                        providerRunId: "provider-run-1",
                    },
                    phase: activeRun.phase,
                    projectionTruncated: activeRun.projectionTruncated,
                    reconciliation: activeRun.reconciliation,
                    runId: "run-1",
                },
            ],
            2,
            false
        );

        const beforeHistory = chatRuntimeMessages(store.state, sessionKey);
        expect(beforeHistory.map((message) => message.id)).toEqual([
            "optimistic:client-1",
            `runtime:${sessionKey}:run-1`,
        ]);
        expect(beforeHistory[1]?.parts).toEqual([{ kind: "text", text: "Final answer" }]);
        expect(beforeHistory[0]).toMatchObject({ delivery: "sent" });

        store.reconcileHistory(sessionKey, {
            clientRunIds: ["client-1"],
            idempotencyKeys: [],
            providerRunIds: ["provider-run-1"],
            runIds: [],
            throughCursor: 2,
        });
        expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([]);
        store.reconcileHistory(sessionKey, {
            clientRunIds: ["client-1"],
            idempotencyKeys: [],
            providerRunIds: ["provider-run-1"],
            runIds: [],
            throughCursor: 2,
        });
        expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([]);
    });

    test("retains only file-free optimistic metadata through every local delivery phase", () => {
        const store = createChatRuntimeStore();
        const inputAttachment = attachment();
        store.enqueue({
            attachments: [inputAttachment],
            clientRunId: "client-file-free",
            createdAtMs: occurredAtMs,
            delivery: "sending",
            idempotencyKey: "file-free-optimistic-send",
            sessionKey,
            text: "Upload safely",
        });
        expect(inputAttachment.file).toBeInstanceOf(File);
        expect(containsFile(store.state)).toBe(false);
        expect(
            store.state.sessions[sessionKey]?.optimisticSends["client-file-free"]
                ?.attachments[0]
        ).not.toHaveProperty("file");

        store.updateSend(sessionKey, "client-file-free", {
            delivery: "reconciling",
            error: "Outcome is unknown",
        });
        expect(containsFile(store.state)).toBe(false);
        store.updateSend(sessionKey, "client-file-free", {
            delivery: "failed",
            error: "Send failed",
        });
        expect(containsFile(store.state)).toBe(false);
    });

    test("bounds retained failed optimistic rows and their serialized metadata bytes", () => {
        const store = createChatRuntimeStore();
        for (let index = 0; index < retainedFailedOptimisticSendLimit + 8; index += 1) {
            const clientRunId = `count-capped-${index}`;
            store.enqueue({
                attachments: [attachment()],
                clientRunId,
                createdAtMs: occurredAtMs + index,
                delivery: "sending",
                idempotencyKey: `count-capped-idempotency-${index}`,
                sessionKey,
                text: `Failure ${index}`,
            });
            store.updateSend(sessionKey, clientRunId, {
                delivery: "failed",
                error: "Send failed",
            });
        }
        const countCapped = Object.values(
            store.state.sessions[sessionKey]?.optimisticSends ?? {}
        );
        expect(countCapped).toHaveLength(retainedFailedOptimisticSendLimit);
        expect(
            countCapped.some(({ clientRunId }) => clientRunId === "count-capped-0")
        ).toBe(false);
        expect(
            countCapped.some(
                ({ clientRunId }) =>
                    clientRunId ===
                    `count-capped-${retainedFailedOptimisticSendLimit + 7}`
            )
        ).toBe(true);

        const byteSessionKey = "agent:byte-cap:main";
        for (let index = 0; index < 8; index += 1) {
            const clientRunId = `byte-capped-${index}`;
            store.enqueue({
                attachments: [],
                clientRunId,
                createdAtMs: occurredAtMs + index,
                delivery: "sending",
                idempotencyKey: `byte-capped-idempotency-${index}`,
                sessionKey: byteSessionKey,
                text: "x".repeat(64 * 1024),
            });
            store.updateSend(byteSessionKey, clientRunId, {
                delivery: "failed",
                error: "Send failed",
            });
        }
        const byteCapped = Object.values(
            store.state.sessions[byteSessionKey]?.optimisticSends ?? {}
        );
        expect(
            byteCapped.reduce((total, send) => total + retainedBytes(send), 0)
        ).toBeLessThanOrEqual(retainedFailedOptimisticSendByteLimit);
        expect(byteCapped.length).toBeLessThan(8);
    });

    test("retains an acknowledged optimistic user row with actual provider failure", () => {
        const store = createChatRuntimeStore();
        store.enqueue({
            attachments: [],
            clientRunId: "run-1",
            createdAtMs: occurredAtMs,
            delivery: "queued",
            idempotencyKey: "0123456789abcdef0123456789abcdef",
            sessionKey,
            text: "Fail after admission",
        });
        store.apply(
            event(1, {
                idempotencyKey: "0123456789abcdef0123456789abcdef",
                kind: "user",
                text: "Fail after admission",
            })
        );
        expect(chatRuntimeMessages(store.state, sessionKey)[0]).toMatchObject({
            delivery: "sent",
            id: "optimistic:run-1",
        });

        store.apply(event(2, { kind: "failed", text: "Provider failed" }));
        const messages = chatRuntimeMessages(store.state, sessionKey);
        expect(messages[0]).toMatchObject({
            delivery: "failed",
            id: "optimistic:run-1",
        });
        expect(messages[1]?.parts).toContainEqual({
            kind: "control",
            text: "Provider failed",
            tone: "danger",
        });
        expect(messages.map(({ id }) => id)).not.toContain(
            `runtime-user:${sessionKey}:run-1`
        );
    });

    test("updates failed sends, settles tool/thinking state, and clears one session", () => {
        const store = createChatRuntimeStore();
        store.enqueue({
            attachments: [],
            clientRunId: "client-2",
            createdAtMs: occurredAtMs,
            delivery: "queued",
            idempotencyKey: "fedcba9876543210fedcba9876543210",
            sessionKey,
            text: "Second",
        });
        store.updateSend(sessionKey, "client-2", {
            delivery: "failed",
            error: "Send failed",
        });
        expect(
            store.state.sessions[sessionKey]?.optimisticSends["client-2"]
        ).toMatchObject({
            delivery: "failed",
            error: "Send failed",
        });
        store.dismissSend(sessionKey, "client-2");
        store.apply(event(1, { kind: "thinking", mode: "replace", text: "Checking" }));
        store.apply(
            event(2, {
                callId: "tool-2",
                kind: "tool-started",
                name: "lookup",
            })
        );
        store.apply(
            event(3, {
                callId: "tool-2",
                error: "Unavailable",
                kind: "tool-failed",
            })
        );
        store.apply(event(4, { kind: "failed", text: "Run failed" }));
        expect(chatRuntimeMessages(store.state, sessionKey)[0]?.parts).toEqual([
            { kind: "thinking", status: "complete", text: "Checking" },
            {
                callId: "tool-2",
                error: "Unavailable",
                kind: "tool",
                name: "lookup",
                status: "failed",
            },
            { kind: "control", text: "Run failed", tone: "danger" },
        ]);
        store.setConnection("disconnected");
        expect(store.state.connection).toBe("disconnected");
        store.clearSession(sessionKey);
        expect(store.state.sessions[sessionKey]).toBeUndefined();
    });

    test("preserves known provider detail through compact and poorer reconnect snapshots", () => {
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            {
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                message: {
                    attachments: [],
                    id: `external:${sessionKey}:provider-1`,
                    parts: [
                        { kind: "text", text: "External activity" },
                        {
                            kind: "thinking",
                            status: "running",
                            text: "Inspecting",
                        },
                        {
                            callId: "tool-1",
                            kind: "tool",
                            name: "lookup",
                            status: "running",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey,
                },
                plan: {
                    description: "Explain the active work.",
                    items: [
                        {
                            id: "provider:provider-1:plan:0",
                            label: "External step",
                            status: "in-progress",
                        },
                    ],
                    runId: "provider:provider-1",
                    title: "OpenClaw plan",
                },
                observationEpoch: 1,
                observedAtMs: occurredAtMs,
                projectionTruncated: false,
                providerRunId: "provider-1",
                source: "provider-runtime",
                updatedAtMs: occurredAtMs,
            },
        ]);

        expect(chatRuntimeMessages(store.state, sessionKey)).toHaveLength(1);
        expect(chatRuntimePlans(store.state, sessionKey)).toHaveLength(1);
        expect(store.state.sessions[sessionKey]?.runs).toEqual({});

        store.installExternalRuns(sessionKey, [
            {
                continuity: "interrupted",
                lifecycle: "active" as const,
                hasUnprojectedActivity: true,
                message: {
                    attachments: [],
                    id: `external:${sessionKey}:provider-1`,
                    parts: [
                        {
                            callId: "tool-1",
                            kind: "tool",
                            name: "lookup",
                            output: "done",
                            status: "completed",
                        },
                        {
                            callId: "tool-2",
                            kind: "tool",
                            name: "inspect",
                            output: "new detail",
                            status: "completed",
                        },
                        {
                            kind: "thinking",
                            status: "running",
                            text: "InspectingNew reasoning",
                        },
                        { kind: "text", text: "External activity updated" },
                        {
                            kind: "control",
                            text: "Some OpenClaw activity details were not returned.",
                            tone: "warning",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey,
                },
                observationEpoch: 2,
                observedAtMs: occurredAtMs + 1,
                projectionTruncated: true,
                providerRunId: "provider-1",
                source: "provider-in-flight",
                updatedAtMs: occurredAtMs + 1,
            },
        ]);
        const preserved = store.state.sessions[sessionKey]?.externalRuns["provider-1"];
        expect(preserved).toMatchObject({
            continuity: "interrupted",
            lifecycle: "active" as const,
            observationEpoch: 2,
            plan: {
                description: "Explain the active work.",
                items: [{ label: "External step" }],
            },
            projectionTruncated: true,
            source: "provider-in-flight",
        });
        expect(preserved?.message.parts).toEqual([
            { kind: "text", text: "External activity" },
            { kind: "thinking", status: "running", text: "Inspecting" },
            {
                callId: "tool-1",
                kind: "tool",
                name: "lookup",
                output: "done",
                status: "completed",
            },
            {
                callId: "tool-2",
                kind: "tool",
                name: "inspect",
                output: "new detail",
                status: "completed",
            },
            { kind: "thinking", status: "running", text: "New reasoning" },
            { kind: "text", text: " updated" },
            {
                kind: "control",
                text: "Some OpenClaw activity details were not returned.",
                tone: "warning",
            },
        ]);
        store.installExternalRuns(sessionKey, [
            {
                ...preserved!,
                message: {
                    ...preserved!.message,
                    parts: [
                        {
                            kind: "thinking",
                            status: "running",
                            text: "InspectingNew reasoning",
                        },
                    ],
                },
            },
        ]);
        expect(
            store.state.sessions[sessionKey]?.externalRuns[
                "provider-1"
            ]?.message.parts.filter(({ kind }) => kind === "thinking")
        ).toEqual([
            { kind: "thinking", status: "running", text: "Inspecting" },
            { kind: "thinking", status: "running", text: "New reasoning" },
        ]);

        store.installExternalRuns(sessionKey, [
            {
                ...preserved!,
                message: { ...preserved!.message, parts: [] },
                plan: undefined,
                projectionTruncated: false,
            },
        ]);
        expect(
            store.state.sessions[sessionKey]?.externalRuns["provider-1"]?.plan
        ).toBeUndefined();
        expect(
            store.state.sessions[sessionKey]?.externalRuns["provider-1"]?.message.parts
        ).not.toEqual([]);

        store.installExternalRuns(sessionKey, []);
        expect(
            store.state.sessions[sessionKey]?.externalRuns["provider-1"]
        ).toBeUndefined();
        expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([]);
        expect(chatRuntimePlans(store.state, sessionKey)).toEqual([]);
    });

    test("preserves known detail only during non-reset truncated catch-up", () => {
        const store = createChatRuntimeStore();
        const full = {
            lastSequence: 4,
            message: {
                attachments: [],
                id: `runtime:${sessionKey}:run-1`,
                parts: [{ kind: "text" as const, text: "Known detail" }],
                role: "assistant" as const,
                runId: "run-1",
                sequence: 1,
                sessionKey,
            },
            phase: "active" as const,
            projectionTruncated: false,
            reconciliation: "runtime-authoritative" as const,
            runId: "run-1",
        };
        const truncated = {
            ...full,
            lastSequence: 8,
            message: {
                ...full.message,
                parts: [
                    {
                        kind: "control" as const,
                        text: "Runtime projection detail was omitted.",
                        tone: "warning" as const,
                    },
                ],
            },
            projectionTruncated: true,
            reconciliation: "pending" as const,
        };
        store.installSnapshots(sessionKey, [full], 4, true);
        store.installSnapshots(sessionKey, [truncated], 8, false);
        expect(chatRuntimeMessages(store.state, sessionKey)[0]?.parts).toEqual([
            { kind: "text", text: "Known detail" },
            {
                kind: "control",
                text: "Runtime projection detail was omitted.",
                tone: "warning",
            },
        ]);
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(true);

        store.installSnapshots(sessionKey, [truncated], 8, true);
        expect(chatRuntimeMessages(store.state, sessionKey)[0]?.parts).toEqual(
            truncated.message.parts
        );
        store.reconcileHistory(sessionKey, {
            clientRunIds: [],
            idempotencyKeys: [],
            runIds: ["run-1"],
            throughCursor: 8,
        });
        expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([]);
        expect(store.state.sessions[sessionKey]?.needsReconciliation).toBe(false);
    });

    test("replays identified truncated provider parts idempotently and keeps inserted tools between anchors", () => {
        const store = createChatRuntimeStore();
        const projection = {
            continuity: "complete" as const,
            lifecycle: "active" as const,
            hasUnprojectedActivity: false,
            message: {
                attachments: [],
                id: `external:${sessionKey}:provider-replay`,
                parts: [
                    {
                        kind: "thinking" as const,
                        sourceKey: "provider-replay:reasoning-1",
                        status: "running" as const,
                        text: "Reasoning one.",
                    },
                    {
                        callId: "command-1",
                        input: { cmd: "pwd" },
                        kind: "tool" as const,
                        name: "bash",
                        status: "running" as const,
                    },
                    {
                        kind: "thinking" as const,
                        sourceKey: "provider-replay:reasoning-2",
                        status: "running" as const,
                        text: "Reasoning two.",
                    },
                    {
                        kind: "text" as const,
                        sourceKey: "provider-replay:assistant-1",
                        text: "Answer.",
                    },
                    {
                        kind: "control" as const,
                        text: "Some OpenClaw activity details were not returned.",
                        tone: "warning" as const,
                    },
                ],
                role: "assistant" as const,
                sequence: 1,
                sessionKey,
            },
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            projectionTruncated: true,
            providerRunId: "provider-replay",
            source: "provider-runtime" as const,
            updatedAtMs: occurredAtMs,
        };
        store.installExternalRuns(sessionKey, [projection]);
        for (let replay = 0; replay < 10; replay += 1) {
            store.installExternalRuns(sessionKey, [projection]);
        }
        expect(
            store.state.sessions[sessionKey]?.externalRuns["provider-replay"]?.message
                .parts
        ).toEqual(projection.message.parts);

        const originalTool = projection.message.parts[1];
        if (originalTool?.kind !== "tool") throw new Error("Expected tool fixture");
        const updatedParts = [
            projection.message.parts[0]!,
            {
                callId: "command-inserted",
                input: { cmd: "git status" },
                kind: "tool" as const,
                name: "bash",
                output: "clean",
                status: "completed" as const,
            },
            {
                ...originalTool,
                output: "/workspace",
                status: "completed" as const,
            },
            ...projection.message.parts.slice(2),
        ];
        store.installExternalRuns(sessionKey, [
            {
                ...projection,
                message: { ...projection.message, parts: updatedParts },
                observationEpoch: 2,
                updatedAtMs: occurredAtMs + 1,
            },
        ]);

        const parts =
            store.state.sessions[sessionKey]?.externalRuns["provider-replay"]?.message
                .parts;
        expect(
            parts?.map((part) => (part.kind === "tool" ? part.callId : part.kind))
        ).toEqual([
            "thinking",
            "command-inserted",
            "command-1",
            "thinking",
            "text",
            "control",
        ]);
        expect(parts?.filter((part) => part.kind === "tool")).toEqual([
            updatedParts[1],
            updatedParts[2],
        ]);
    });

    test("uses rich assistant segments instead of duplicate compact aggregates in both prefix directions", () => {
        const base = {
            continuity: "complete" as const,
            lifecycle: "active" as const,
            hasUnprojectedActivity: false,
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            projectionTruncated: true,
            providerRunId: "provider-shape-flip",
            source: "provider-runtime" as const,
            updatedAtMs: occurredAtMs,
        };
        const projection = (
            parts: readonly ReturnType<typeof providerShapeRichParts>[number][]
        ) => ({
            ...base,
            message: {
                attachments: [],
                id: `external:${sessionKey}:provider-shape-flip`,
                parts,
                role: "assistant" as const,
                sequence: 1,
                sessionKey,
            },
        });
        const compact = (text: string) =>
            projection([
                {
                    kind: "text",
                    sourceKey: "provider-shape-flip:aggregate:assistant",
                    text,
                },
            ]);

        const assertRichAbc = (store: ReturnType<typeof createChatRuntimeStore>) => {
            expect(
                store.state.sessions[sessionKey]?.externalRuns["provider-shape-flip"]
                    ?.message.parts
            ).toEqual(providerShapeRichParts("BC"));
        };

        const richThenCompact = createChatRuntimeStore();
        richThenCompact.installExternalRuns(sessionKey, [
            projection(providerShapeRichParts("B")),
        ]);
        for (let replay = 0; replay < 10; replay += 1) {
            richThenCompact.installExternalRuns(sessionKey, [compact("ABC")]);
        }
        assertRichAbc(richThenCompact);

        const richThenShortCompact = createChatRuntimeStore();
        richThenShortCompact.installExternalRuns(sessionKey, [
            projection(providerShapeRichParts("BC")),
        ]);
        richThenShortCompact.installExternalRuns(sessionKey, [compact("AB")]);
        assertRichAbc(richThenShortCompact);

        const compactThenRich = createChatRuntimeStore();
        compactThenRich.installExternalRuns(sessionKey, [compact("ABC")]);
        for (let replay = 0; replay < 10; replay += 1) {
            compactThenRich.installExternalRuns(sessionKey, [
                projection(providerShapeRichParts("BC")),
            ]);
        }
        assertRichAbc(compactThenRich);

        const shortCompactThenLongRich = createChatRuntimeStore();
        shortCompactThenLongRich.installExternalRuns(sessionKey, [compact("AB")]);
        shortCompactThenLongRich.installExternalRuns(sessionKey, [
            projection(providerShapeRichParts("BC")),
        ]);
        assertRichAbc(shortCompactThenLongRich);

        const mismatchedCompact = createChatRuntimeStore();
        mismatchedCompact.installExternalRuns(sessionKey, [compact("XYZ")]);
        mismatchedCompact.installExternalRuns(sessionKey, [
            projection(providerShapeRichParts("B")),
        ]);
        expect(
            mismatchedCompact.state.sessions[sessionKey]?.externalRuns[
                "provider-shape-flip"
            ]?.message.parts
        ).toEqual(providerShapeRichParts("B"));

        const authoritativeCompact = createChatRuntimeStore();
        const staleRun = {
            continuity: "complete" as const,
            lifecycle: "active" as const,
            hasUnprojectedActivity: true,
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            parts: [
                {
                    callId: "command-before",
                    isError: false,
                    kind: "tool" as const,
                    name: "bash",
                    output: "before",
                    phase: "succeeded" as const,
                    sequence: 1,
                },
                {
                    kind: "assistant" as const,
                    segmentId: "assistant-stale",
                    sequence: 2,
                    streamId: "assistant",
                    text: "stale tail",
                },
                {
                    callId: "command-after",
                    isError: false,
                    kind: "tool" as const,
                    name: "bash",
                    output: "after",
                    phase: "succeeded" as const,
                    sequence: 3,
                },
            ],
            projectionTruncated: true,
            providerRunId: "provider-authoritative-compact",
            sessionKey,
            source: "provider-runtime" as const,
            text: "stale tail",
            updatedAtMs: occurredAtMs,
        };
        authoritativeCompact.installExternalRuns(sessionKey, [
            projectChatExternalRun(staleRun),
        ]);
        const refreshed = projectChatExternalRun({
            ...staleRun,
            observationEpoch: 2,
            text: "The complete accumulated assistant response.",
            updatedAtMs: occurredAtMs + 1,
        });
        authoritativeCompact.installExternalRuns(sessionKey, [refreshed]);
        expect(
            authoritativeCompact.state.sessions[sessionKey]?.externalRuns[
                "provider-authoritative-compact"
            ]?.message.parts
        ).toEqual(refreshed.message.parts);

        const authoritativeRich = createChatRuntimeStore();
        const oldRichRun = {
            ...staleRun,
            providerRunId: "provider-authoritative-rich",
            parts: [
                staleRun.parts[0]!,
                {
                    kind: "assistant" as const,
                    segmentId: "assistant-old",
                    sequence: 2,
                    streamId: "assistant",
                    text: "Old answer.",
                },
                staleRun.parts[2]!,
            ],
            text: "Old answer.",
        };
        authoritativeRich.installExternalRuns(sessionKey, [
            projectChatExternalRun(oldRichRun),
        ]);
        const replacedRich = projectChatExternalRun({
            ...oldRichRun,
            observationEpoch: 2,
            parts: [
                oldRichRun.parts[0]!,
                oldRichRun.parts[2]!,
                {
                    kind: "assistant",
                    segmentId: "assistant-new",
                    sequence: 4,
                    streamId: "assistant",
                    text: "New answer.",
                },
            ],
            text: "New answer.",
            updatedAtMs: occurredAtMs + 1,
        });
        authoritativeRich.installExternalRuns(sessionKey, [replacedRich]);
        expect(
            authoritativeRich.state.sessions[sessionKey]?.externalRuns[
                "provider-authoritative-rich"
            ]?.message.parts
        ).toEqual(replacedRich.message.parts);

        const authoritativeThinking = createChatRuntimeStore();
        const oldThinkingRun = {
            ...staleRun,
            providerRunId: "provider-authoritative-thinking",
            parts: [
                {
                    kind: "thinking" as const,
                    segmentId: "reasoning-old",
                    sequence: 1,
                    streamId: "agent:reasoning",
                    text: "Old reasoning.",
                },
                staleRun.parts[2]!,
            ],
            text: "",
        };
        authoritativeThinking.installExternalRuns(sessionKey, [
            projectChatExternalRun(oldThinkingRun),
        ]);
        const replacedThinking = projectChatExternalRun({
            ...oldThinkingRun,
            observationEpoch: 2,
            parts: [
                oldThinkingRun.parts[1]!,
                {
                    kind: "thinking",
                    segmentId: "reasoning-new",
                    sequence: 3,
                    streamId: "agent:reasoning",
                    text: "Replacement reasoning.",
                },
            ],
            streamResets: [
                {
                    resetId: "reasoning-reset-2",
                    streamId: "agent:reasoning",
                },
            ],
            updatedAtMs: occurredAtMs + 1,
        });
        authoritativeThinking.installExternalRuns(sessionKey, [replacedThinking]);
        expect(
            authoritativeThinking.state.sessions[sessionKey]?.externalRuns[
                "provider-authoritative-thinking"
            ]?.message.parts
        ).toEqual(replacedThinking.message.parts);
    });

    test("applies compact run-level stream resets once when response budgeting omits parts", () => {
        const providerRunId = "provider-compact-stream-reset";
        const reasoningStreamKey = `${providerRunId}:agent:reasoning`;
        const reset = [
            {
                resetKey: `${providerRunId}:reasoning-reset-2`,
                sourceStreamKey: reasoningStreamKey,
            },
        ] as const;
        const projection = (
            parts: ChatExternalRunProjection["message"]["parts"],
            streamResets?: ChatExternalRunProjection["streamResets"]
        ): ChatExternalRunProjection => ({
            continuity: "complete",
            hasUnprojectedActivity: true,
            lifecycle: "active",
            message: {
                attachments: [],
                id: `external:${sessionKey}:${providerRunId}`,
                parts,
                providerRunId,
                role: "assistant",
                sequence: 1,
                sessionKey,
                timestampMs: occurredAtMs,
            },
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            projectionTruncated: true,
            providerRunId,
            source: "provider-runtime",
            ...(streamResets === undefined ? {} : { streamResets }),
            updatedAtMs: occurredAtMs,
        });
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            projection([
                {
                    kind: "thinking",
                    sourceKey: `${providerRunId}:reasoning-old`,
                    sourceStreamKey: reasoningStreamKey,
                    status: "running",
                    text: "Old reasoning.",
                },
                {
                    kind: "thinking",
                    sourceKey: `${providerRunId}:preamble-1`,
                    sourceStreamKey: `${providerRunId}:agent:preamble`,
                    status: "running",
                    text: "Keep commentary.",
                },
                {
                    callId: "command-1",
                    kind: "tool",
                    name: "bash",
                    status: "completed",
                },
            ]),
        ]);

        const compact = projection(
            [
                {
                    kind: "control",
                    text: "Some OpenClaw activity details were not returned.",
                    tone: "warning",
                },
            ],
            reset
        );
        store.installExternalRuns(sessionKey, [compact]);
        let parts =
            store.state.sessions[sessionKey]?.externalRuns[providerRunId]?.message.parts;
        expect(
            parts?.flatMap((part) => (part.kind === "thinking" ? [part.text] : []))
        ).toEqual(["Keep commentary."]);
        expect(parts?.some((part) => part.kind === "tool")).toBeTrue();

        store.installExternalRuns(sessionKey, [
            projection(
                [
                    {
                        kind: "thinking",
                        sourceKey: `${providerRunId}:reasoning-new`,
                        sourceStreamKey: reasoningStreamKey,
                        status: "running",
                        text: "New reasoning.",
                    },
                ],
                reset
            ),
        ]);
        store.installExternalRuns(sessionKey, [compact]);
        parts =
            store.state.sessions[sessionKey]?.externalRuns[providerRunId]?.message.parts;
        expect(
            parts?.flatMap((part) => (part.kind === "thinking" ? [part.text] : []))
        ).toEqual(["Keep commentary.", "New reasoning."]);
    });

    test("applies an assistant reset to an already compact aggregate", () => {
        const providerRunId = "provider-compact-assistant-reset";
        const run = (text: string, resetId?: string) =>
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: true,
                observationEpoch: resetId === undefined ? 1 : 2,
                observedAtMs: occurredAtMs,
                parts: [],
                projectionTruncated: true,
                providerRunId,
                sessionKey,
                source: "provider-runtime",
                ...(resetId === undefined
                    ? {}
                    : {
                          streamResets: [
                              {
                                  resetId,
                                  streamId: "assistant",
                              },
                          ],
                      }),
                text,
                updatedAtMs: occurredAtMs,
            });
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [run("ABC")]);
        store.installExternalRuns(sessionKey, [run("AB", "assistant-reset-2")]);

        expect(
            store.state.sessions[sessionKey]?.externalRuns[
                providerRunId
            ]?.message.parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
        ).toEqual(["AB"]);
    });

    test("retains a run-level reset when a 512-part window drops the replaced segment", () => {
        const providerRunId = "provider-window-stream-reset";
        const reasoningStreamKey = `${providerRunId}:agent:reasoning`;
        const projection = (
            parts: ChatExternalRunProjection["message"]["parts"],
            streamResets?: ChatExternalRunProjection["streamResets"]
        ): ChatExternalRunProjection => ({
            continuity: "complete",
            hasUnprojectedActivity: true,
            lifecycle: "active",
            message: {
                attachments: [],
                id: `external:${sessionKey}:${providerRunId}`,
                parts,
                providerRunId,
                role: "assistant",
                sequence: 1,
                sessionKey,
            },
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            projectionTruncated: true,
            providerRunId,
            source: "provider-runtime",
            ...(streamResets === undefined ? {} : { streamResets }),
            updatedAtMs: occurredAtMs,
        });
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            projection([
                {
                    kind: "thinking",
                    sourceKey: `${providerRunId}:reasoning-old`,
                    sourceStreamKey: reasoningStreamKey,
                    status: "running",
                    text: "Old reasoning.",
                },
            ]),
        ]);
        const retainedWindow: ChatExternalRunProjection["message"]["parts"] = [
            ...Array.from({ length: 511 }, (_, index) => ({
                callId: `command-${index}`,
                kind: "tool" as const,
                name: "bash",
                status: "completed" as const,
            })),
            {
                kind: "thinking",
                sourceKey: `${providerRunId}:reasoning-later`,
                sourceStreamKey: reasoningStreamKey,
                status: "running",
                text: "Later reasoning.",
            },
        ];
        store.installExternalRuns(sessionKey, [
            projection(retainedWindow, [
                {
                    resetKey: `${providerRunId}:reasoning-reset-2`,
                    sourceStreamKey: reasoningStreamKey,
                },
            ]),
        ]);

        const parts =
            store.state.sessions[sessionKey]?.externalRuns[providerRunId]?.message.parts;
        expect(parts).toHaveLength(512);
        expect(
            parts?.flatMap((part) => (part.kind === "thinking" ? [part.text] : []))
        ).toEqual(["Later reasoning."]);
        expect(parts?.at(0)).toMatchObject({ callId: "command-0", kind: "tool" });
        expect(parts?.at(-1)).toMatchObject({
            kind: "thinking",
            text: "Later reasoning.",
        });
    });

    test("inserts identified replay parts around one or two anchors and tails no-overlap parts", () => {
        const createProjection = (
            parts: readonly {
                readonly kind: "thinking";
                readonly sourceKey: string;
                readonly status: "running";
                readonly text: string;
            }[]
        ) => ({
            continuity: "complete" as const,
            lifecycle: "active" as const,
            hasUnprojectedActivity: false,
            message: {
                attachments: [],
                id: `external:${sessionKey}:provider-anchors`,
                parts,
                role: "assistant" as const,
                sequence: 1,
                sessionKey,
            },
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            projectionTruncated: true,
            providerRunId: "provider-anchors",
            source: "provider-runtime" as const,
            updatedAtMs: occurredAtMs,
        });
        const keys = (store: ReturnType<typeof createChatRuntimeStore>) =>
            store.state.sessions[sessionKey]?.externalRuns[
                "provider-anchors"
            ]?.message.parts.map((candidate) =>
                candidate.kind === "thinking" ? candidate.text : candidate.kind
            );

        const successorOnly = createChatRuntimeStore();
        successorOnly.installExternalRuns(sessionKey, [
            createProjection([providerAnchorPart("A"), providerAnchorPart("C")]),
        ]);
        successorOnly.installExternalRuns(sessionKey, [
            createProjection([providerAnchorPart("B"), providerAnchorPart("C")]),
        ]);
        expect(keys(successorOnly)).toEqual(["A", "B", "C"]);

        const twoAnchors = createChatRuntimeStore();
        twoAnchors.installExternalRuns(sessionKey, [
            createProjection([providerAnchorPart("A"), providerAnchorPart("C")]),
        ]);
        twoAnchors.installExternalRuns(sessionKey, [
            createProjection([
                providerAnchorPart("A"),
                providerAnchorPart("B"),
                providerAnchorPart("C"),
            ]),
        ]);
        expect(keys(twoAnchors)).toEqual(["A", "B", "C"]);

        const noOverlap = createChatRuntimeStore();
        noOverlap.installExternalRuns(sessionKey, [
            createProjection([providerAnchorPart("A"), providerAnchorPart("C")]),
        ]);
        noOverlap.installExternalRuns(sessionKey, [
            createProjection([providerAnchorPart("D"), providerAnchorPart("E")]),
        ]);
        expect(keys(noOverlap)).toEqual(["A", "C", "D", "E"]);
    });

    test("accepts a lower authoritative reset cursor and ignores stale merge snapshots", () => {
        const store = createChatRuntimeStore();
        store.apply(
            event(10, {
                kind: "assistant",
                mode: "replace",
                text: "Current runtime detail",
            })
        );
        const stale = {
            lastSequence: 9,
            message: {
                attachments: [],
                id: `runtime:${sessionKey}:run-1`,
                parts: [{ kind: "text" as const, text: "Stale snapshot" }],
                role: "assistant" as const,
                runId: "run-1",
                sequence: 1,
                sessionKey,
            },
            phase: "active" as const,
            reconciliation: "runtime-authoritative" as const,
            runId: "run-1",
            updatedAtMs: occurredAtMs + 9,
        };
        store.installSnapshots(sessionKey, [stale], 11, false);
        expect(chatRuntimeMessages(store.state, sessionKey)[0]?.parts).toEqual([
            { kind: "text", text: "Current runtime detail" },
        ]);
        expect(store.state.sessions[sessionKey]?.runs["run-1"]?.lastSequence).toBe(10);

        store.installSnapshots(sessionKey, [], 2, true);
        expect(store.cursorFor(sessionKey)).toBe(2);
        expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([]);
    });

    test("retains the newest settled runs by observation time, not local sequence", () => {
        const store = createChatRuntimeStore();
        const snapshots = Array.from({ length: 33 }, (_, index) => ({
            lastSequence: index === 0 ? 10_000 : 1,
            message: {
                attachments: [],
                id: `runtime:${sessionKey}:settled-${index}`,
                parts: [{ kind: "text" as const, text: `Run ${index}` }],
                role: "assistant" as const,
                runId: `settled-${index}`,
                sequence: 1,
                sessionKey,
                timestampMs: occurredAtMs + index,
            },
            phase: "completed" as const,
            reconciliation: "history-authoritative" as const,
            runId: `settled-${index}`,
            updatedAtMs: occurredAtMs + index,
        }));
        store.installSnapshots(sessionKey, snapshots, 1, true);
        expect(Object.keys(store.state.sessions[sessionKey]?.runs ?? {})).toHaveLength(
            32
        );
        expect(store.state.sessions[sessionKey]?.runs["settled-0"]).toBeUndefined();
        expect(store.state.sessions[sessionKey]?.runs["settled-32"]).toBeDefined();
    });

    test("orders timestamp-less runtime controls in an explicit fallback bucket", () => {
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            {
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                message: {
                    attachments: [],
                    id: "without-timestamp",
                    parts: [],
                    role: "control",
                    sequence: 1,
                    sessionKey,
                },
                observationEpoch: 1,
                observedAtMs: occurredAtMs - 1,
                projectionTruncated: false,
                providerRunId: "without-timestamp",
                source: "provider-runtime",
                updatedAtMs: occurredAtMs - 1,
            },
            {
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                message: {
                    attachments: [],
                    id: "with-timestamp",
                    parts: [],
                    role: "assistant",
                    sequence: 99,
                    sessionKey,
                    timestampMs: occurredAtMs,
                },
                observationEpoch: 1,
                observedAtMs: occurredAtMs,
                projectionTruncated: false,
                providerRunId: "with-timestamp",
                source: "provider-runtime",
                updatedAtMs: occurredAtMs,
            },
        ]);
        expect(chatRuntimeMessages(store.state, sessionKey).map(({ id }) => id)).toEqual([
            "with-timestamp",
            "without-timestamp",
        ]);
    });

    test("keeps same-run activity around a steer and folds the later tool result", () => {
        const store = createChatRuntimeStore();
        const providerRunId = "provider-steer";
        const initial = projectChatExternalRun({
            continuity: "complete",
            lifecycle: "active" as const,
            hasUnprojectedActivity: false,
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            parts: [
                {
                    kind: "thinking",
                    segmentId: "reasoning-before",
                    sequence: 1,
                    streamId: "agent:reasoning",
                    text: "Before steer",
                },
                {
                    callId: "call-before",
                    input: '{"cmd":"bun test"}',
                    isError: false,
                    kind: "tool",
                    name: "bash",
                    phase: "started",
                    sequence: 2,
                },
            ],
            projectionTruncated: false,
            providerRunId,
            sessionKey,
            source: "provider-runtime",
            text: "",
            updatedAtMs: occurredAtMs,
        });
        store.installExternalRuns(sessionKey, [initial]);
        store.enqueue({
            attachments: [],
            clientRunId: "client-steer",
            createdAtMs: occurredAtMs + 1,
            delivery: "accepted",
            idempotencyKey: "steer-idempotency",
            sessionKey,
            text: "Continue",
        });
        store.installExternalRuns(sessionKey, [
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                observationEpoch: 2,
                observedAtMs: occurredAtMs,
                parts: [
                    {
                        kind: "thinking",
                        segmentId: "reasoning-before",
                        sequence: 1,
                        streamId: "agent:reasoning",
                        text: "Before steer",
                    },
                    {
                        callId: "call-before",
                        input: '{"cmd":"bun test"}',
                        isError: false,
                        kind: "tool",
                        name: "bash",
                        phase: "started",
                        sequence: 2,
                    },
                    { kind: "user", sequence: 3, text: "Continue" },
                    {
                        callId: "call-before",
                        isError: false,
                        kind: "tool",
                        name: "bash",
                        output: "passed",
                        phase: "succeeded",
                        sequence: 4,
                    },
                    {
                        kind: "thinking",
                        segmentId: "reasoning-after",
                        sequence: 5,
                        streamId: "agent:reasoning",
                        text: "After steer",
                    },
                ],
                projectionTruncated: false,
                providerRunId,
                sessionKey,
                source: "provider-runtime",
                text: "",
                updatedAtMs: occurredAtMs + 2,
            }),
        ]);

        const messages = chatRuntimeMessages(store.state, sessionKey);
        expect(messages.map((message) => message.role)).toEqual([
            "assistant",
            "assistant",
            "user",
            "assistant",
        ]);
        expect(messages.flatMap((message) => message.parts)).toEqual([
            expect.objectContaining({ kind: "thinking", text: "Before steer" }),
            expect.objectContaining({
                input: '{"cmd":"bun test"}',
                kind: "tool",
                output: "passed",
                status: "completed",
            }),
            { kind: "text", text: "Continue" },
            expect.objectContaining({ kind: "thinking", text: "After steer" }),
        ]);
    });

    test("retires an omitted external diagnostic tail from an authoritative poll", () => {
        const store = createChatRuntimeStore();
        const projection = projectChatExternalRun({
            continuity: "complete",
            lifecycle: "active" as const,
            hasUnprojectedActivity: false,
            observationEpoch: 1,
            observedAtMs: occurredAtMs,
            parts: [
                {
                    kind: "thinking",
                    sequence: 1,
                    text: "Still active",
                },
            ],
            projectionTruncated: false,
            providerRunId: "provider-terminal-lag",
            sessionKey,
            source: "provider-runtime",
            text: "",
            updatedAtMs: occurredAtMs,
        });
        store.installExternalRuns(sessionKey, [projection]);

        store.installExternalRuns(sessionKey, []);
        expect(
            store.state.sessions[sessionKey]?.externalRuns["provider-terminal-lag"]
        ).toBeUndefined();
        expect(chatRuntimeMessages(store.state, sessionKey)).toEqual([]);
        expect(chatRuntimePlans(store.state, sessionKey)).toEqual([]);
    });

    test("does not retire external activity from a canonical user echo", () => {
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [
            projectChatExternalRun({
                continuity: "complete",
                lifecycle: "active" as const,
                hasUnprojectedActivity: false,
                observationEpoch: 1,
                observedAtMs: occurredAtMs,
                parts: [{ kind: "thinking", sequence: 1, text: "Retain me" }],
                projectionTruncated: false,
                providerRunId: "provider-user-echo",
                sessionKey,
                source: "provider-runtime",
                text: "",
                updatedAtMs: occurredAtMs,
            }),
        ]);
        store.reconcileHistory(sessionKey, {
            clientRunIds: [],
            idempotencyKeys: ["user-echo"],
            providerRunIds: [],
            runIds: [],
            throughCursor: 0,
        });
        expect(
            store.state.sessions[sessionKey]?.externalRuns["provider-user-echo"]
        ).toBeDefined();

        store.reconcileHistory(sessionKey, {
            clientRunIds: [],
            idempotencyKeys: [],
            providerRunIds: ["provider-user-echo"],
            runIds: [],
            throughCursor: 0,
        });
        expect(
            store.state.sessions[sessionKey]?.externalRuns["provider-user-echo"]
        ).toBeDefined();
    });
});
