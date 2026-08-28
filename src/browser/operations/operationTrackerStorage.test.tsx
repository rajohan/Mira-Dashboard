import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
    clearTrackedOperations,
    readStoredOperations,
    reconcileTrackedOperationsIdentity,
    storeOperations,
    trackedOperationsStorageChangedEvent,
} from "./operationTrackerStorage.ts";

beforeEach(() => {
    globalThis.sessionStorage.clear();
});

afterEach(() => {
    globalThis.sessionStorage.clear();
});

const operation = {
    jobRunId: "run-1",
    label: "Running backup",
    operationKey: "backup-run",
    terminal: false,
} as const;

describe("operation tracker storage", () => {
    test("claims an empty store for the first resolved identity", () => {
        reconcileTrackedOperationsIdentity("authenticated:session-a");
        storeOperations([operation]);

        reconcileTrackedOperationsIdentity("authenticated:session-a");

        expect(readStoredOperations()).toEqual([operation]);
    });

    test("does not publish a redundant update for an empty owned store", () => {
        const onChange = mock(() => {});
        reconcileTrackedOperationsIdentity("authenticated:session-a");
        globalThis.addEventListener(trackedOperationsStorageChangedEvent, onChange);
        try {
            reconcileTrackedOperationsIdentity("authenticated:session-a");

            expect(onChange).not.toHaveBeenCalled();
        } finally {
            globalThis.removeEventListener(
                trackedOperationsStorageChangedEvent,
                onChange
            );
        }
    });

    test("rejects unowned operations when the first identity resolves", () => {
        storeOperations([operation]);

        reconcileTrackedOperationsIdentity("anonymous");

        expect(readStoredOperations()).toEqual([]);
    });

    test("preserves operations when the same identity resolves after refresh", () => {
        reconcileTrackedOperationsIdentity("authenticated:session-a");
        storeOperations([operation]);

        reconcileTrackedOperationsIdentity("authenticated:session-a");

        expect(readStoredOperations()).toEqual([operation]);
    });

    test("clears mounted and persisted operations when identity changes", () => {
        const onClear = mock(() => {});
        globalThis.addEventListener(trackedOperationsStorageChangedEvent, onClear);
        try {
            reconcileTrackedOperationsIdentity("authenticated:session-a");
            storeOperations([operation]);

            reconcileTrackedOperationsIdentity("anonymous");

            expect(readStoredOperations()).toEqual([]);
            expect(onClear).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.removeEventListener(trackedOperationsStorageChangedEvent, onClear);
        }
    });

    test("rejects malformed storage and supports explicit clearing", () => {
        globalThis.sessionStorage.setItem(
            "mira-dashboard:operations:v2",
            JSON.stringify({ operations: [{ jobRunId: 42 }] })
        );
        expect(readStoredOperations()).toEqual([]);

        storeOperations([operation]);
        clearTrackedOperations();

        expect(readStoredOperations()).toEqual([]);
    });
});
