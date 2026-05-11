import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const entries: Array<[string, unknown]> = [];
    const collection = {
        isReady: vi.fn(() => true),
        preload: vi.fn(),
        utils: {
            writeDelete: vi.fn(),
            writeUpsert: vi.fn(),
        },
        [Symbol.iterator]: vi.fn(() => entries[Symbol.iterator]()),
    };

    return {
        collection,
        createCollection: vi.fn(() => collection),
        entries,
        queryCollectionOptions: vi.fn((options: unknown) => options),
    };
});

vi.mock("@tanstack/react-db", () => ({
    createCollection: mocks.createCollection,
}));

vi.mock("@tanstack/query-db-collection", () => ({
    queryCollectionOptions: mocks.queryCollectionOptions,
}));

vi.mock("../lib/queryClient", () => ({
    queryClient: {},
}));

import {
    deleteSessionFromCollection,
    replaceSessionsFromWebSocket,
    sessionsCollection,
} from "./sessions";

describe("sessions collection", () => {
    beforeEach(() => {
        mocks.entries.length = 0;
        mocks.collection.isReady.mockClear();
        mocks.collection.isReady.mockReturnValue(true);
        mocks.collection.utils.writeDelete.mockClear();
        mocks.collection.utils.writeUpsert.mockClear();
    });

    it("configures a safe key fallback and preloads the sessions collection", () => {
        expect(mocks.queryCollectionOptions).toHaveBeenCalledWith(
            expect.objectContaining({
                queryKey: ["sessions"],
                staleTime: Number.POSITIVE_INFINITY,
            })
        );
        expect(sessionsCollection.preload).toHaveBeenCalled();

        const options = mocks.queryCollectionOptions.mock.calls[0]?.[0] as {
            getKey: (item: { id?: string; key?: string }) => string;
        };
        expect(options.getKey({ key: "agent:main:main", id: "fallback" })).toBe(
            "agent:main:main"
        );
        expect(options.getKey({ id: "session-id" })).toBe("session-id");
        expect(options.getKey({ key: "   " })).toBe("unknown-session");
    });

    it("replaces websocket sessions, filters malformed rows, and deletes stale keys", () => {
        mocks.entries.push(["old-session", {}], ["keep-session", {}]);

        replaceSessionsFromWebSocket([
            { key: "keep-session", id: "ignored-id", title: "Keep" },
            { id: "new-session", title: "New" },
            { key: "   ", title: "Malformed" },
            null,
            "bad",
        ]);

        expect(mocks.collection.utils.writeDelete).toHaveBeenCalledWith("old-session");
        expect(mocks.collection.utils.writeDelete).not.toHaveBeenCalledWith(
            "keep-session"
        );
        expect(mocks.collection.utils.writeUpsert).toHaveBeenCalledTimes(2);
        expect(mocks.collection.utils.writeUpsert).toHaveBeenNthCalledWith(1, {
            key: "keep-session",
            id: "ignored-id",
            title: "Keep",
        });
        expect(mocks.collection.utils.writeUpsert).toHaveBeenNthCalledWith(2, {
            id: "new-session",
            title: "New",
        });
    });

    it("ignores missing deletes and no-ops while unready", () => {
        mocks.entries.push(["missing-session", {}]);
        mocks.collection.utils.writeDelete.mockImplementationOnce(() => {
            throw new Error("Document does not exist");
        });

        expect(() => deleteSessionFromCollection("missing-session")).not.toThrow();

        mocks.collection.isReady.mockReturnValue(false);
        deleteSessionFromCollection("ignored");
        replaceSessionsFromWebSocket([{ id: "ignored" }]);

        expect(mocks.collection.utils.writeDelete).toHaveBeenCalledTimes(1);
        expect(mocks.collection.utils.writeUpsert).not.toHaveBeenCalled();
    });
});
