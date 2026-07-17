import { describe, expect, it } from "bun:test";

import {
    MAX_CHAT_RUNTIME_SESSIONS,
    type OpenClawRuntimeSnapshot,
} from "../src/chat/openClawChatBridge.ts";
import { SqliteOpenClawChatSnapshotStore } from "../src/chat/openClawChatSnapshotStore.ts";

describe("OpenClaw chat snapshot store", () => {
    it("round-trips and deletes a bounded runtime snapshot", () => {
        const store = new SqliteOpenClawChatSnapshotStore("gateway-scope-a");
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const snapshot: OpenClawRuntimeSnapshot = {
            completed: false,
            events: [
                {
                    event: "agent",
                    payload: {
                        runId: "persisted-run",
                        sessionKey,
                        stream: "thinking",
                    },
                    runtimeRecordedAt: Date.now(),
                    runtimeSequence: 7,
                    type: "event",
                },
            ],
            throughSequence: 7,
        };

        try {
            store.save(sessionKey, snapshot);
            expect(store.keys()).toContain(sessionKey);
            expect(store.load(sessionKey)).toEqual(snapshot);

            store.delete(sessionKey);
            expect(store.load(sessionKey)).toBeUndefined();
        } finally {
            store.delete(sessionKey);
        }
    });

    it("isolates identical session keys between gateway credentials", () => {
        const firstStore = new SqliteOpenClawChatSnapshotStore("gateway-scope-a");
        const secondStore = new SqliteOpenClawChatSnapshotStore("gateway-scope-b");
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const snapshot = (runId: string): OpenClawRuntimeSnapshot => ({
            completed: false,
            events: [
                {
                    event: "agent",
                    payload: { runId, sessionKey, stream: "thinking" },
                    runtimeRecordedAt: Date.now(),
                    runtimeSequence: 1,
                    type: "event",
                },
            ],
            throughSequence: 1,
        });
        const firstSnapshot = snapshot("first-run");
        const secondSnapshot = snapshot("second-run");

        try {
            firstStore.save(sessionKey, firstSnapshot);
            secondStore.save(sessionKey, secondSnapshot);

            expect(firstStore.load(sessionKey)).toEqual(firstSnapshot);
            expect(secondStore.load(sessionKey)).toEqual(secondSnapshot);

            firstStore.clear();
            expect(firstStore.load(sessionKey)).toBeUndefined();
            expect(secondStore.load(sessionKey)).toEqual(secondSnapshot);
        } finally {
            firstStore.delete(sessionKey);
            secondStore.delete(sessionKey);
        }
    });

    it("bounds persisted sessions per gateway scope across process lifetimes", () => {
        const store = new SqliteOpenClawChatSnapshotStore(
            `gateway-scope-${crypto.randomUUID()}`
        );
        const sessionKeys = Array.from(
            { length: MAX_CHAT_RUNTIME_SESSIONS + 1 },
            (_, index) => `agent:test:bounded-${index}`
        );

        try {
            for (const [index, sessionKey] of sessionKeys.entries()) {
                store.save(sessionKey, {
                    completed: false,
                    events: [
                        {
                            event: "agent",
                            payload: {
                                runId: `run-${index}`,
                                sessionKey,
                                stream: "thinking",
                            },
                            runtimeRecordedAt: Date.now(),
                            runtimeSequence: index + 1,
                            type: "event",
                        },
                    ],
                    throughSequence: index + 1,
                });
            }

            expect(store.keys()).toHaveLength(MAX_CHAT_RUNTIME_SESSIONS);
            expect(store.load(sessionKeys[0]!)).toBeUndefined();
            expect(store.load(sessionKeys.at(-1)!)).toBeDefined();
        } finally {
            store.clear();
        }
    });
});
