import { describe, expect, it } from "bun:test";

import type { OpenClawRuntimeSnapshot } from "../src/chat/openClawChatBridge.ts";
import { SqliteOpenClawChatSnapshotStore } from "../src/chat/openClawChatSnapshotStore.ts";

describe("OpenClaw chat snapshot store", () => {
    it("round-trips and deletes a bounded runtime snapshot", () => {
        const store = new SqliteOpenClawChatSnapshotStore();
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
});
