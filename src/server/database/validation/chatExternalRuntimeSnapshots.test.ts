import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { chatExternalRunsPerSessionMaximum } from "../../../contracts/chatModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import {
    chatExternalRuntimeSnapshotInsertSchema,
    chatExternalRuntimeSnapshotPayloadSchema,
    chatExternalRuntimeSnapshotSelectSchema,
    parseChatExternalRuntimeSnapshotPayload,
} from "./chatExternalRuntimeSnapshots.ts";

const sessionKey = "agent:main:main";

function activeEntry(providerRunId = "provider-run-1") {
    return {
        lastProviderSequence: 12,
        observationKind: "live" as const,
        run: {
            continuity: "complete" as const,
            hasUnprojectedActivity: false,
            lifecycle: "active" as const,
            observationEpoch: 7,
            observedAtMs: 1000,
            parts: [
                {
                    kind: "thinking" as const,
                    sequence: 1,
                    text: "Checking the provider state.",
                },
            ],
            projectionTruncated: false,
            providerRunId,
            sessionKey,
            source: "provider-runtime" as const,
            text: "",
            updatedAtMs: 1100,
        },
    };
}

function storedRow(snapshot: unknown) {
    const snapshotJson = JSON.stringify(snapshot);
    return {
        gatewayScope: "default",
        observationEpoch: 7,
        schemaVersion: 1 as const,
        sessionKey,
        snapshotBytes: utf8ByteLength(snapshotJson),
        snapshotJson,
        transcriptGeneration: 3,
        updatedAt: new Date(1200),
    };
}

describe("external chat runtime snapshot row schemas", () => {
    test("accepts active and terminal-pending-history restart envelopes", () => {
        const activeSnapshot = {
            entries: [activeEntry()],
            truncated: false,
        };
        const activeRow = storedRow(activeSnapshot);

        expect(v.parse(chatExternalRuntimeSnapshotInsertSchema, activeRow)).toBeDefined();
        expect(v.parse(chatExternalRuntimeSnapshotSelectSchema, activeRow)).toBeDefined();
        expect(parseChatExternalRuntimeSnapshotPayload(activeRow.snapshotJson)).toEqual(
            activeSnapshot
        );

        const terminalSnapshot = {
            entries: [
                {
                    ...activeEntry(),
                    historyCatchUpSignaled: true as const,
                    historyReplayRemainder: null,
                    pendingAssistantAppend: "final suffix",
                    run: {
                        ...activeEntry().run,
                        lifecycle: "terminal-pending-history" as const,
                    },
                    terminalObservedAtMs: 1150,
                },
            ],
            truncated: false,
        };
        expect(
            v.parse(chatExternalRuntimeSnapshotSelectSchema, storedRow(terminalSnapshot))
        ).toBeDefined();
    });

    test("requires unique bounded entries and exact terminal metadata", () => {
        const duplicate = {
            entries: [activeEntry(), activeEntry()],
            truncated: false,
        };
        expect(
            v.safeParse(chatExternalRuntimeSnapshotPayloadSchema, duplicate).success
        ).toBeFalse();

        const tooMany = {
            entries: Array.from(
                { length: chatExternalRunsPerSessionMaximum + 1 },
                (_, index) => activeEntry(`provider-run-${index}`)
            ),
            truncated: true,
        };
        expect(
            v.safeParse(chatExternalRuntimeSnapshotPayloadSchema, tooMany).success
        ).toBeFalse();

        const terminalWithoutObservation = {
            entries: [
                {
                    ...activeEntry(),
                    run: {
                        ...activeEntry().run,
                        lifecycle: "terminal-pending-history" as const,
                    },
                },
            ],
            truncated: false,
        };
        expect(
            v.safeParse(
                chatExternalRuntimeSnapshotPayloadSchema,
                terminalWithoutObservation
            ).success
        ).toBeFalse();

        const activeWithTerminalObservation = {
            entries: [{ ...activeEntry(), terminalObservedAtMs: 1150 }],
            truncated: false,
        };
        expect(
            v.safeParse(
                chatExternalRuntimeSnapshotPayloadSchema,
                activeWithTerminalObservation
            ).success
        ).toBeFalse();
    });

    test("rejects unknown JSON fields and row-envelope disagreement", () => {
        const snapshot = {
            entries: [activeEntry()],
            truncated: false,
        };
        expect(() =>
            parseChatExternalRuntimeSnapshotPayload(
                JSON.stringify({ ...snapshot, unexpected: true })
            )
        ).toThrow();

        const row = storedRow(snapshot);
        for (const overrides of [
            { observationEpoch: 6 },
            { sessionKey: "agent:main:other" },
            { snapshotBytes: row.snapshotBytes + 1 },
            { updatedAt: new Date(1099) },
        ]) {
            expect(
                v.safeParse(chatExternalRuntimeSnapshotSelectSchema, {
                    ...row,
                    ...overrides,
                }).success
            ).toBeFalse();
        }
    });
});
