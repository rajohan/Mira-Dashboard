import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const collection = {
        isReady: vi.fn(() => true),
        preload: vi.fn(),
        utils: {
            writeUpsert: vi.fn(),
        },
    };

    return {
        collection,
        createCollection: vi.fn(() => collection),
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

import { agentsCollection, writeAgentsFromWebSocket } from "./agents";

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
                staleTime: Number.POSITIVE_INFINITY,
            })
        );
        expect(mocks.createCollection).toHaveBeenCalled();
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
