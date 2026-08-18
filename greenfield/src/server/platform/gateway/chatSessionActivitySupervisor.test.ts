/* oxlint-disable typescript/require-await -- Async doubles mirror the chat service port. */
import { describe, expect, test } from "bun:test";

import { createChatSessionActivitySupervisor } from "./chatSessionActivitySupervisor.ts";
import type { PersistentGatewayListener } from "./persistentGatewayTransport.ts";

const mediaReferences = {
    registerLocal: () => ({
        attachmentId: "00000000-0000-4000-8000-000000000002",
        fileName: "logo.jpg",
        locatorFingerprint: "fixture",
    }),
    registerManaged: () => ({
        attachmentId: "00000000-0000-4000-8000-000000000002",
    }),
};

async function flush(): Promise<void> {
    for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

function activity(reason: string | undefined, sessionKey = "agent:main:main") {
    return {
        connectionGeneration: 1,
        frame: {
            event: "sessions.changed" as const,
            sessionActivity: {
                occurredAtMs: 1000,
                reason,
                sessionKey,
            },
            type: "event" as const,
        },
        receivedAtMs: 1000,
    };
}

function persistedMessage(sessionKey = "agent:main:main") {
    return {
        connectionGeneration: 1,
        frame: {
            event: "session.message" as const,
            sessionMessage: { sessionKey },
            type: "event" as const,
        },
        receivedAtMs: 1000,
    };
}

function persistedUserMessage(sessionKey = "agent:main:main") {
    const messageId =
        sessionKey === "agent:main:main"
            ? "message-user-1"
            : `message-user-${sessionKey}`;
    return {
        connectionGeneration: 1,
        frame: {
            event: "session.message" as const,
            sessionMessage: {
                sessionKey,
                userMessage: {
                    attachments: [
                        {
                            contentType: "image/jpeg",
                            fileName: "logo.jpg",
                            sizeBytes: 7861,
                            url: "media://inbound/b2ea3e92-1844-42d3-a512-d0c48e560657.jpg",
                        },
                    ],
                    idempotencyKey: messageId,
                    messageId,
                    providerRunIds: ["provider-run-1"],
                    text: "Visible immediately",
                },
            },
            type: "event" as const,
        },
        receivedAtMs: 1001,
    };
}

describe("chat session activity supervisor", () => {
    test("observes persisted user text while canonical reconciliation is blocked", async () => {
        let listener: PersistentGatewayListener | undefined;
        let releaseReconciliation: (() => void) | undefined;
        const reconciliationBlocked = new Promise<void>((resolve) => {
            releaseReconciliation = resolve;
        });
        const observedUsers: Parameters<
            Parameters<
                typeof createChatSessionActivitySupervisor
            >[0]["chat"]["observeProviderUserMessage"]
        >[0][] = [];
        const supervisor = createChatSessionActivitySupervisor({
            chat: {
                observeProviderUserMessage: async (message) => {
                    observedUsers.push(message);
                },
                reconcileProviderSessionActivity: async () => reconciliationBlocked,
            },
            mediaReferences,
            transport: {
                subscribe(next) {
                    listener = next;
                    return () => {};
                },
            },
        });

        listener!.onEvent?.(activity("send"));
        await flush();
        listener!.onEvent?.(persistedUserMessage());
        await flush();

        expect(observedUsers).toEqual([
            expect.objectContaining({
                attachments: [
                    expect.objectContaining({
                        kind: "attachment",
                        mediaType: "image/jpeg",
                        renderPolicy: "inline-image",
                    }),
                ],
                messageId: "message-user-1",
            }),
        ]);
        releaseReconciliation!();
        await supervisor.stop();
    });

    test("coalesces accepted and persisted messages into canonical reconciliation", async () => {
        const reconciled: string[] = [];
        const observedUsers: string[] = [];
        let listener: PersistentGatewayListener | undefined;
        let unsubscribed = 0;
        const supervisor = createChatSessionActivitySupervisor({
            chat: {
                observeProviderUserMessage: async (message) => {
                    observedUsers.push(message.messageId);
                },
                reconcileProviderSessionActivity: async (sessionKey) => {
                    reconciled.push(sessionKey);
                },
            },
            mediaReferences,
            transport: {
                subscribe(next) {
                    listener = next;
                    return () => {
                        unsubscribed += 1;
                    };
                },
            },
        });
        listener!.onEvent?.(activity("send"));
        listener!.onEvent?.(activity("send"));
        listener!.onEvent?.(activity("steer", "agent:ops:main"));
        listener!.onEvent?.(activity(undefined, "agent:coder:main"));
        listener!.onEvent?.(persistedMessage());
        listener!.onEvent?.(persistedUserMessage());
        listener!.onEvent?.(persistedMessage("agent:researcher:main"));
        listener!.onEvent?.(activity("metadata"));
        await flush();

        expect(reconciled).toEqual([
            "agent:main:main",
            "agent:ops:main",
            "agent:coder:main",
            "agent:researcher:main",
        ]);
        expect(observedUsers).toEqual(["message-user-1"]);
        await supervisor.stop();
        expect(unsubscribed).toBe(1);
    });

    test("continues both drains after one queued item rejects", async () => {
        const reconciled: string[] = [];
        const observedUsers: string[] = [];
        const failures: unknown[] = [];
        let listener: PersistentGatewayListener | undefined;
        const supervisor = createChatSessionActivitySupervisor({
            chat: {
                observeProviderUserMessage: async (message) => {
                    observedUsers.push(message.messageId);
                    if (message.messageId === "message-user-1")
                        throw new Error("user failed");
                },
                reconcileProviderSessionActivity: async (sessionKey) => {
                    reconciled.push(sessionKey);
                    if (sessionKey === "agent:main:main")
                        throw new Error("session failed");
                },
            },
            mediaReferences,
            onFailure: (error) => failures.push(error),
            transport: {
                subscribe(next) {
                    listener = next;
                    return () => {};
                },
            },
        });
        listener!.onEvent?.(persistedUserMessage());
        listener!.onEvent?.(persistedUserMessage("agent:ops:main"));
        listener!.onEvent?.(persistedMessage("agent:ops:main"));
        await flush();

        expect(reconciled).toEqual(["agent:main:main", "agent:ops:main"]);
        expect(observedUsers).toEqual(["message-user-1", "message-user-agent:ops:main"]);
        expect(failures).toHaveLength(2);
        await supervisor.stop();
    });
});
