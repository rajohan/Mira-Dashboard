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
        parseLogLine: jest.fn(),
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

mock.module("../utils/logUtils", () => ({
    parseLogLine: mocks.parseLogLine,
}));

const { logsCollection, preloadLogsCollection, writeLogFromWebSocket } =
    await import("./logs");

describe("logs collection", () => {
    beforeEach(() => {
        mocks.collection.isReady.mockClear();
        mocks.collection.isReady.mockReturnValue(true);
        mocks.collection.utils.writeUpsert.mockClear();
        mocks.parseLogLine.mockReset();
    });

    it("configures and preloads the logs collection", () => {
        expect(mocks.queryCollectionOptions).toHaveBeenCalledWith(
            expect.objectContaining({
                queryKey: ["logs"],
                staleTime: Infinity,
            })
        );
        preloadLogsCollection();
        expect(logsCollection.preload).toHaveBeenCalled();
    });

    it("uses log id as the collection key", () => {
        const options = mocks.queryCollectionOptions.mock.calls[0]?.[0] as {
            getKey: (item: { id: string }) => string;
        };

        expect(options.getKey({ id: "line-1" })).toBe("line-1");
    });

    it("parses and writes valid websocket log lines", () => {
        mocks.parseLogLine.mockReturnValue({ id: "line-1", message: "hello" });

        writeLogFromWebSocket("raw log line");

        expect(mocks.parseLogLine).toHaveBeenCalledWith("raw log line");
        expect(mocks.collection.utils.writeUpsert).toHaveBeenCalledWith({
            id: "line-1",
            message: "hello",
        });
    });

    it("ignores unparseable logs, parser failures, and unready collections", () => {
        const consoleError = jest.spyOn(console, "error").mockImplementation(() => {
            // Suppress expected parser error noise for this negative-path assertion.
        });

        mocks.parseLogLine.mockReturnValueOnce(null);
        writeLogFromWebSocket("ignored");
        expect(mocks.collection.utils.writeUpsert).not.toHaveBeenCalled();

        mocks.parseLogLine.mockImplementationOnce(() => {
            throw new Error("bad log");
        });
        writeLogFromWebSocket("broken");
        expect(consoleError).toHaveBeenCalledWith(
            "Error parsing log line:",
            "broken",
            expect.any(Error)
        );

        mocks.collection.isReady.mockReturnValue(false);
        writeLogFromWebSocket("not ready");
        expect(mocks.parseLogLine).not.toHaveBeenCalledWith("not ready");

        consoleError.mockRestore();
    });
});
