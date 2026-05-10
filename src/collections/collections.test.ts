import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUtils, mockIsReady, mockIterator } = vi.hoisted(() => ({
    mockUtils: { writeUpsert: vi.fn(), writeDelete: vi.fn() },
    mockIsReady: vi.fn(() => false),
    mockIterator: vi.fn(() => ({
        next: () => ({ done: true, value: undefined }),
        [Symbol.iterator]() {
            return this;
        },
    })),
}));

vi.mock("@tanstack/query-db-collection", () => ({
    queryCollectionOptions: vi.fn(() => ({})),
}));

vi.mock("@tanstack/react-db", () => ({
    createCollection: vi.fn(() => ({
        isReady: mockIsReady,
        utils: mockUtils,
        [Symbol.iterator]: mockIterator,
        preload: vi.fn(),
    })),
}));

vi.mock("../lib/queryClient", () => ({
    queryClient: {},
    AUTO_REFRESH_MS: 5000,
}));

import { writeAgentsFromWebSocket } from "./agents";
import { writeLogFromWebSocket } from "./logs";
import { deleteSessionFromCollection, replaceSessionsFromWebSocket } from "./sessions";

describe("collections", () => {
    beforeEach(() => {
        mockUtils.writeUpsert.mockClear();
        mockUtils.writeDelete.mockClear();
        mockIsReady.mockReturnValue(false);
        mockIterator.mockReturnValue([]);
    });

    it("writeAgentsFromWebSocket skips when not ready", () => {
        writeAgentsFromWebSocket([{ id: "1", name: "test" }]);
        expect(mockUtils.writeUpsert).not.toHaveBeenCalled();
    });

    it("writeAgentsFromWebSocket writes when ready", () => {
        mockIsReady.mockReturnValue(true);
        writeAgentsFromWebSocket([{ id: "1", name: "test" }]);
        expect(mockUtils.writeUpsert).toHaveBeenCalled();
    });

    it("writeLogFromWebSocket skips when not ready", () => {
        writeLogFromWebSocket('{"level":"info","0":"hello"}');
        expect(mockUtils.writeUpsert).not.toHaveBeenCalled();
    });

    it("writeLogFromWebSocket skips blank lines", () => {
        mockIsReady.mockReturnValue(true);
        writeLogFromWebSocket("");
        expect(mockUtils.writeUpsert).not.toHaveBeenCalled();
    });

    it("writeLogFromWebSocket writes parsed log", () => {
        mockIsReady.mockReturnValue(true);
        writeLogFromWebSocket('{"level":"info","0":"hello"}');
        expect(mockUtils.writeUpsert).toHaveBeenCalled();
    });

    it("deleteSessionFromCollection skips when not ready", () => {
        deleteSessionFromCollection("key-1");
        expect(mockUtils.writeDelete).not.toHaveBeenCalled();
    });

    it("replaceSessionsFromWebSocket skips when not ready", () => {
        replaceSessionsFromWebSocket([{ key: "s1", id: "s1" }]);
        expect(mockUtils.writeUpsert).not.toHaveBeenCalled();
    });
});
