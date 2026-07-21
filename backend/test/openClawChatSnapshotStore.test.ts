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
            interruptedAtByRun: {
                "persisted-run": 1_785_000_000_000,
            },
            pendingRequestBoundaries: {
                "dashboard-chat-pending": 7,
            },
            requestBoundary: 7,
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

    it("appends new event rows without rewriting earlier runtime payloads", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const firstSnapshot = snapshotFor(sessionKey, 1);
        const secondEvent = {
            ...firstSnapshot.events[0]!,
            payload: {
                runId: "run-1",
                sessionKey,
                stream: "thinking",
                text: "second update",
            },
            runtimeSequence: 2,
        };
        const expandedSnapshot: OpenClawRuntimeSnapshot = {
            completed: false,
            events: [...firstSnapshot.events, secondEvent],
            throughSequence: 2,
        };

        try {
            store.save(sessionKey, firstSnapshot);
            const firstEventRow = database
                .prepare(
                    `SELECT rowid
                     FROM chat_runtime_snapshot_events
                     WHERE gateway_scope = ? AND session_key = ? AND runtime_sequence = 1`
                )
                .get(gatewayScope, sessionKey) as { rowid: number };

            store.save(sessionKey, expandedSnapshot);

            const retainedEventRow = database
                .prepare(
                    `SELECT rowid
                     FROM chat_runtime_snapshot_events
                     WHERE gateway_scope = ? AND session_key = ? AND runtime_sequence = 1`
                )
                .get(gatewayScope, sessionKey) as { rowid: number };
            const eventCount = database
                .prepare(
                    `SELECT count(*) AS count
                     FROM chat_runtime_snapshot_events
                     WHERE gateway_scope = ? AND session_key = ?`
                )
                .get(gatewayScope, sessionKey) as { count: number };
            const metadata = database
                .prepare(
                    `SELECT length(snapshot_json) AS bytes,
                            json_extract(snapshot_json, '$.eventStorage') AS storage
                     FROM chat_runtime_snapshots
                     WHERE gateway_scope = ? AND session_key = ?`
                )
                .get(gatewayScope, sessionKey) as {
                bytes: number;
                storage: string;
            };

            expect(retainedEventRow.rowid).toBe(firstEventRow.rowid);
            expect(eventCount.count).toBe(2);
            expect(metadata).toEqual({ bytes: expect.any(Number), storage: "rows-v2" });
            expect(metadata.bytes).toBeLessThan(1000);
            expect(store.load(sessionKey)).toEqual(expandedSnapshot);
        } finally {
            store.clear();
        }
    });

    it("replaces stale event rows after replay coalescing changes the prefix", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const firstSnapshot = snapshotFor(sessionKey, 1);
        const coalescedSnapshot: OpenClawRuntimeSnapshot = {
            completed: false,
            events: [
                {
                    ...firstSnapshot.events[0]!,
                    payload: {
                        runId: "run-1",
                        sessionKey,
                        stream: "thinking",
                        text: "coalesced update",
                    },
                    runtimeSequence: 2,
                },
            ],
            throughSequence: 2,
        };

        try {
            store.save(sessionKey, firstSnapshot);
            store.save(sessionKey, coalescedSnapshot);

            const persistedSequences = (
                database
                    .prepare(
                        `SELECT runtime_sequence
                         FROM chat_runtime_snapshot_events
                         WHERE gateway_scope = ? AND session_key = ?
                         ORDER BY runtime_sequence ASC`
                    )
                    .all(gatewayScope, sessionKey) as Array<{
                    runtime_sequence: number;
                }>
            ).map((row) => row.runtime_sequence);
            expect(persistedSequences).toEqual([2]);
            expect(store.load(sessionKey)).toEqual(coalescedSnapshot);
        } finally {
            store.clear();
        }
    });

    it("replaces a persisted row when an envelope changes at the same sequence", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
        const sessionKey = `agent:test:${crypto.randomUUID()}`;
        const firstSnapshot = snapshotFor(sessionKey, 1);
        const rewrittenSnapshot: OpenClawRuntimeSnapshot = {
            ...firstSnapshot,
            events: [
                {
                    ...firstSnapshot.events[0]!,
                    payload: {
                        ...(firstSnapshot.events[0]!.payload as Record<string, unknown>),
                        text: "rewritten",
                    },
                },
            ],
        };

        try {
            store.save(sessionKey, firstSnapshot);
            store.save(sessionKey, rewrittenSnapshot);

            const rewrittenRow = database
                .prepare(
                    `SELECT json_extract(envelope_json, '$.payload.text') AS text
                     FROM chat_runtime_snapshot_events
                     WHERE gateway_scope = ? AND session_key = ? AND runtime_sequence = 1`
                )
                .get(gatewayScope, sessionKey) as { text: string };
            expect(rewrittenRow.text).toBe("rewritten");
            expect(store.load(sessionKey)).toEqual(rewrittenSnapshot);
        } finally {
            store.clear();
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
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
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
            const prunedEventCount = database
                .prepare(
                    `SELECT count(*) AS count
                     FROM chat_runtime_snapshot_events
                     WHERE gateway_scope = ? AND session_key = ?`
                )
                .get(gatewayScope, sessionKeys[0]!) as { count: number };
            expect(prunedEventCount.count).toBe(0);
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

    it("promotes an alias atomically at the persisted session limit", () => {
        const gatewayScope = `gateway-scope-${crypto.randomUUID()}`;
        const store = new SqliteOpenClawChatSnapshotStore(gatewayScope);
        const sourceKey = "main";
        const canonicalKey = "agent:main:main";
        const canonicalSnapshot = snapshotFor(canonicalKey, 100);
        const unrelatedKeys = Array.from(
            { length: MAX_CHAT_RUNTIME_SESSIONS - 1 },
            (_, index) => `agent:test:promotion-${index}`
        );

        try {
            for (const [index, sessionKey] of unrelatedKeys.entries()) {
                store.save(sessionKey, snapshotFor(sessionKey, index + 1));
            }
            store.save(sourceKey, snapshotFor(sourceKey, 100));

            store.promote(
                sourceKey,
                canonicalKey,
                { completed: false, events: [], throughSequence: 100 },
                canonicalSnapshot
            );

            const restartedStore = new SqliteOpenClawChatSnapshotStore(gatewayScope);
            const storedKeys = restartedStore.keys();
            expect(storedKeys).toHaveLength(MAX_CHAT_RUNTIME_SESSIONS);
            expect(storedKeys).not.toContain(sourceKey);
            expect(storedKeys).toContain(canonicalKey);
            expect(storedKeys).toEqual(expect.arrayContaining(unrelatedKeys));
            expect(restartedStore.load(canonicalKey)).toEqual(canonicalSnapshot);
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
