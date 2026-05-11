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
        parseLogLine: vi.fn(),
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

vi.mock("../utils/logUtils", () => ({
    parseLogLine: mocks.parseLogLine,
}));

import { logsCollection, writeLogFromWebSocket } from "./logs";

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
                staleTime: Number.POSITIVE_INFINITY,
            })
        );
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
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
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
