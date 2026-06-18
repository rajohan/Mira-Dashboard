import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

import { hoisted } from "../test/testUtils";

const mocks = hoisted(() => {
    const entries: Array<[string, unknown]> = [];
    const collection = {
        isReady: jest.fn(() => true),
        preload: jest.fn(),
        utils: {
            writeDelete: jest.fn(),
            writeUpsert: jest.fn(),
        },
        [Symbol.iterator]: jest.fn(() => entries[Symbol.iterator]()),
    };

    return {
        collection,
        createCollection: jest.fn(() => collection),
        entries,
        queryCollectionOptions: jest.fn((options: unknown) => options),
    };
});

mock.module("@tanstack/react-db", () => ({
    createCollection: mocks.createCollection,
}));

mock.module("@tanstack/query-db-collection", () => ({
    queryCollectionOptions: mocks.queryCollectionOptions,
}));

mock.module("../lib/queryClient", () => ({
    queryClient: {},
}));

const {
    deleteSessionFromCollection,
    preloadSessionsCollection,
    replaceSessionsFromWebSocket,
    sessionsCollection,
} = await import("./sessions");

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
                staleTime: Infinity,
            })
        );
        preloadSessionsCollection();
        expect(sessionsCollection.preload).toHaveBeenCalled();

        const options = mocks.queryCollectionOptions.mock.calls[0]?.[0] as {
            getKey: (item: { id?: string; key?: string }) => string;
        };
        expect(options.getKey({ key: "agent:main:main", id: "fallback" })).toBe(
            "agent:main:main"
        );
        expect(options.getKey({ id: "session-id" })).toBe("session-id");
        expect(options.getKey({ key: " ".repeat(3) })).toBe("unknown-session");
    });

    it("replaces websocket sessions, filters malformed rows, and deletes stale keys", () => {
        mocks.entries.push(["old-session", {}], ["keep-session", {}]);

        replaceSessionsFromWebSocket([
            { key: "keep-session", id: "ignored-id", title: "Keep" },
            { id: "new-session", title: "New" },
            { key: " ".repeat(3), title: "Malformed" },
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
