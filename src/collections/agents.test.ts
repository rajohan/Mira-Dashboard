import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

import { hoisted } from "../test/testUtils";

const mocks = hoisted(() => {
    const collection = {
        isReady: jest.fn(() => true),
        preload: jest.fn(),
        utils: {
            writeUpsert: jest.fn(),
        },
    };

    return {
        collection,
        createCollection: jest.fn(() => collection),
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

const { agentsCollection, preloadAgentsCollection, writeAgentsFromWebSocket } =
    await import("./agents");

describe("agents collection", () => {
    beforeEach(() => {
        mocks.collection.isReady.mockClear();
        mocks.collection.isReady.mockReturnValue(true);
        mocks.collection.utils.writeUpsert.mockClear();
    });

    it("configures and preloads the agents collection", () => {
        expect(mocks.queryCollectionOptions).toHaveBeenCalledWith(
            expect.objectContaining({
                queryKey: ["agents"],
                staleTime: Infinity,
            })
        );
        expect(mocks.createCollection).toHaveBeenCalled();
        preloadAgentsCollection();
        expect(agentsCollection.preload).toHaveBeenCalled();
    });

    it("uses agent id as the collection key", () => {
        const options = mocks.queryCollectionOptions.mock.calls[0]?.[0] as {
            getKey: (item: { id: string }) => string;
        };

        expect(options.getKey({ id: "main" })).toBe("main");
    });

    it("writes websocket agents only after the collection is ready", () => {
        writeAgentsFromWebSocket([
            { id: "main", name: "Mira" } as never,
            { id: "ops", name: "Ops" } as never,
        ]);

        expect(mocks.collection.utils.writeUpsert).toHaveBeenCalledTimes(2);
        expect(mocks.collection.utils.writeUpsert).toHaveBeenNthCalledWith(1, {
            id: "main",
            name: "Mira",
        });

        mocks.collection.utils.writeUpsert.mockClear();
        mocks.collection.isReady.mockReturnValue(false);

        writeAgentsFromWebSocket([{ id: "ignored", name: "Ignored" } as never]);

        expect(mocks.collection.utils.writeUpsert).not.toHaveBeenCalled();
    });
});
