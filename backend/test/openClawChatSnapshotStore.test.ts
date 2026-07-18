import { describe, expect, it } from "bun:test";

import {
    MAX_CHAT_RUNTIME_SESSIONS,
    type OpenClawRuntimeSnapshot,
} from "../src/chat/openClawChatBridge.ts";
import { SqliteOpenClawChatSnapshotStore } from "../src/chat/openClawChatSnapshotStore.ts";
import { database } from "../src/database.ts";

function snapshotFor(sessionKey: string, sequence: number): OpenClawRuntimeSnapshot {
    return {
        completed: false,
        events: [
            {
                event: "agent",
                payload: {
                    runId: `run-${sequence}`,
                    sessionKey,
                    stream: "thinking",
                },
                runtimeRecordedAt: Date.now(),
                runtimeSequence: sequence,
                type: "event",
            },
        ],
        throughSequence: sequence,
    };
}

describe("OpenClaw chat snapshot store", () => {
    it("round-trips and deletes a bounded runtime snapshot", () => {
        const store = new SqliteOpenClawChatSnapshotStore(
            `gateway-scope-${crypto.randomUUID()}`
        );
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
            expect(store.maximumSequence()).toBe(7);

            store.delete(sessionKey);
            expect(store.load(sessionKey)).toBeUndefined();
            expect(store.maximumSequence()).toBe(0);
        } finally {
            store.delete(sessionKey);
        }
    });

    it("normalizes session keys across snapshot CRUD operations", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
        const canonicalKey = `agent:test:${crypto.randomUUID()}`;
        const mixedKey = `  ${canonicalKey.toUpperCase()}  `;
        const snapshot = snapshotFor(canonicalKey, 17);

        try {
            store.save(mixedKey, snapshot);

            expect(store.keys()).toEqual([canonicalKey]);
            expect(store.load(canonicalKey.toUpperCase())).toEqual(snapshot);
            store.delete(` ${canonicalKey.toUpperCase()} `);
            expect(store.load(canonicalKey)).toBeUndefined();
        } finally {
            store.clear();
        }
    });

    it("ignores unsafe watermarks when calculating the maximum sequence", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
        const validSessionKey = "agent:test:valid-watermark";

        try {
            store.save(validSessionKey, snapshotFor(validSessionKey, 73));
            database
                .prepare(
                    `INSERT INTO chat_runtime_snapshots (
                        gateway_scope,
                        session_key,
                        snapshot_json,
                        updated_at
                    ) VALUES (?, ?, ?, ?)`
                )
                .run(
                    gatewayScope,
                    "agent:test:unsafe-watermark",
                    JSON.stringify({
                        throughSequence: Number.MAX_SAFE_INTEGER + 1,
                    }),
                    "2026-07-17T20:00:00.000Z"
                );

            expect(store.maximumSequence()).toBe(73);
        } finally {
            store.clear();
        }
    });

    it("isolates identical session keys between gateway credentials", () => {
        const firstStore = new SqliteOpenClawChatSnapshotStore(
            `gateway-scope-${crypto.randomUUID()}`
        );
        const secondStore = new SqliteOpenClawChatSnapshotStore(
            `gateway-scope-${crypto.randomUUID()}`
        );
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

    it("treats a same-millisecond refresh as the newest persisted session", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(
            gatewayScope,
            () => "2026-07-17T20:00:00.000Z"
        );
        const sessionKeys = Array.from(
            { length: MAX_CHAT_RUNTIME_SESSIONS },
            (_, index) => `agent:test:same-time-${index}`
        );
        const overflowKey = "agent:test:same-time-overflow";

        try {
            for (const [index, sessionKey] of sessionKeys.entries()) {
                store.save(sessionKey, snapshotFor(sessionKey, index + 1));
            }
            store.save(sessionKeys[0]!, snapshotFor(sessionKeys[0]!, 100));
            store.save(overflowKey, snapshotFor(overflowKey, 101));

            expect(store.keys()).toHaveLength(MAX_CHAT_RUNTIME_SESSIONS);
            expect(store.load(sessionKeys[0]!)).toBeDefined();
            expect(store.load(sessionKeys[1]!)).toBeUndefined();
            expect(store.load(overflowKey)).toBeDefined();
        } finally {
            store.clear();
        }
    });

    it("deletes snapshots with invalid or inconsistent sequence metadata", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
        const invalidSnapshots = [
            { ...snapshotFor("agent:test:negative", 1), throughSequence: -1 },
            { ...snapshotFor("agent:test:fractional", 1), throughSequence: 1.5 },
            {
                ...snapshotFor("agent:test:event-negative", 1),
                events: [
                    {
                        ...snapshotFor("agent:test:event-negative", 1).events[0],
                        runtimeSequence: -1,
                    },
                ],
            },
            {
                ...snapshotFor("agent:test:event-fractional", 1),
                events: [
                    {
                        ...snapshotFor("agent:test:event-fractional", 1).events[0],
                        runtimeSequence: 0.5,
                    },
                ],
            },
            { ...snapshotFor("agent:test:behind", 2), throughSequence: 1 },
        ];

        try {
            for (const [index, snapshot] of invalidSnapshots.entries()) {
                const sessionKey = `agent:test:invalid-${index}`;
                database
                    .prepare(
                        `INSERT INTO chat_runtime_snapshots (
                            gateway_scope,
                            session_key,
                            snapshot_json,
                            updated_at
                        ) VALUES (?, ?, ?, ?)`
                    )
                    .run(
                        gatewayScope,
                        sessionKey,
                        JSON.stringify(snapshot),
                        "2026-07-17T20:00:00.000Z"
                    );

                expect(store.load(sessionKey)).toBeUndefined();
                expect(store.keys()).not.toContain(sessionKey);
            }
        } finally {
            store.clear();
        }
    });
});
