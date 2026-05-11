import { beforeEach, describe, expect, it, vi } from "vitest";

const { capturedOptions, mockUtils, mockIsReady, mockEntries } = vi.hoisted(() => ({
    capturedOptions: [] as Array<Record<string, unknown>>,
    mockUtils: { writeUpsert: vi.fn(), writeDelete: vi.fn() },
    mockIsReady: vi.fn(() => false),
    mockEntries: [] as Array<[string, unknown]>,
}));

vi.mock("@tanstack/query-db-collection", () => ({
    queryCollectionOptions: vi.fn((options: Record<string, unknown>) => {
        capturedOptions.push(options);
        return options;
    }),
}));

vi.mock("@tanstack/react-db", () => ({
    createCollection: vi.fn(() => ({
        isReady: mockIsReady,
        utils: mockUtils,
        preload: vi.fn(),
        [Symbol.iterator]: () => mockEntries[Symbol.iterator](),
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
        mockUtils.writeDelete.mockReset();
        mockIsReady.mockReturnValue(false);
        mockEntries.length = 0;
    });

    it("configures collection query options and getKey callbacks", async () => {
        const [agentsOptions, logsOptions, sessionsOptions] = capturedOptions;

        expect(agentsOptions?.queryKey).toEqual(["agents"]);
        await expect(
            (agentsOptions?.queryFn as () => Promise<unknown[]>)()
        ).resolves.toEqual([]);
        expect(
            (agentsOptions?.getKey as (item: { id: string }) => string)({ id: "agent-1" })
        ).toBe("agent-1");

        expect(logsOptions?.queryKey).toEqual(["logs"]);
        await expect(
            (logsOptions?.queryFn as () => Promise<unknown[]>)()
        ).resolves.toEqual([]);
        expect(
            (logsOptions?.getKey as (item: { id: string }) => string)({ id: "log-1" })
        ).toBe("log-1");

        expect(sessionsOptions?.queryKey).toEqual(["sessions"]);
        await expect(
            (sessionsOptions?.queryFn as () => Promise<unknown[]>)()
        ).resolves.toEqual([]);
        const getSessionKey = sessionsOptions?.getKey as (item: {
            key?: string;
            id?: string;
        }) => string;
        expect(getSessionKey({ key: "session-key", id: "session-id" })).toBe(
            "session-key"
        );
        expect(getSessionKey({ id: "session-id" })).toBe("session-id");
        expect(getSessionKey({ key: "  " })).toBe("unknown-session");
    });

    it("writeAgentsFromWebSocket skips when not ready", () => {
        writeAgentsFromWebSocket([{ id: "1", name: "test" }]);
        expect(mockUtils.writeUpsert).not.toHaveBeenCalled();
    });

    it("writeAgentsFromWebSocket writes when ready", () => {
        mockIsReady.mockReturnValue(true);
        writeAgentsFromWebSocket([{ id: "1", name: "test" }]);
        expect(mockUtils.writeUpsert).toHaveBeenCalledWith({ id: "1", name: "test" });
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
        expect(mockUtils.writeUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ level: "info", msg: "hello" })
        );
    });

    it("writeLogFromWebSocket catches parser errors", () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        mockIsReady.mockReturnValue(true);
        // Force writeUpsert to throw to exercise catch block around parsing/write handling.
        mockUtils.writeUpsert.mockImplementationOnce(() => {
            throw new Error("write failed");
        });
        writeLogFromWebSocket('{"level":"info","0":"hello"}');
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it("deleteSessionFromCollection skips when not ready", () => {
        deleteSessionFromCollection("key-1");
        expect(mockUtils.writeDelete).not.toHaveBeenCalled();
    });

    it("deleteSessionFromCollection ignores non-matching sessions", () => {
        mockIsReady.mockReturnValue(true);
        mockEntries.push(["other-key", {}]);
        deleteSessionFromCollection("key-1");
        expect(mockUtils.writeDelete).not.toHaveBeenCalled();
    });

    it("deleteSessionFromCollection deletes matching session", () => {
        mockIsReady.mockReturnValue(true);
        mockEntries.push(["key-1", {}]);
        deleteSessionFromCollection("key-1");
        expect(mockUtils.writeDelete).toHaveBeenCalledWith("key-1");
    });

    it("deleteSessionFromCollection swallows missing-session writeDelete errors", () => {
        mockIsReady.mockReturnValue(true);
        mockEntries.push(["key-1", {}]);
        mockUtils.writeDelete.mockImplementationOnce(() => {
            throw new Error("does not exist");
        });
        expect(() => deleteSessionFromCollection("key-1")).not.toThrow();
    });

    it("deleteSessionFromCollection rethrows unexpected writeDelete errors", () => {
        mockIsReady.mockReturnValue(true);
        mockEntries.push(["key-1", {}]);
        mockUtils.writeDelete.mockImplementationOnce(() => {
            throw new Error("boom");
        });
        expect(() => deleteSessionFromCollection("key-1")).toThrow("boom");
    });

    it("replaceSessionsFromWebSocket skips when not ready", () => {
        replaceSessionsFromWebSocket([{ key: "s1", id: "s1" }]);
        expect(mockUtils.writeUpsert).not.toHaveBeenCalled();
    });

    it("replaceSessionsFromWebSocket writes valid sessions and deletes stale ones", () => {
        mockIsReady.mockReturnValue(true);
        mockEntries.push(["old-session", {}]);
        replaceSessionsFromWebSocket([
            { key: "new-session", id: "new-session" },
            { key: "  ", id: "" },
            null,
        ]);

        expect(mockUtils.writeDelete).toHaveBeenCalledWith("old-session");
        expect(mockUtils.writeUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ key: "new-session" })
        );
        expect(mockUtils.writeUpsert).toHaveBeenCalledTimes(1);
    });

    it("replaceSessionsFromWebSocket keeps sessions that are still present", () => {
        mockIsReady.mockReturnValue(true);
        mockEntries.push(["same-session", {}]);
        replaceSessionsFromWebSocket([{ key: "same-session", id: "same-session" }]);

        expect(mockUtils.writeDelete).not.toHaveBeenCalled();
        expect(mockUtils.writeUpsert).toHaveBeenCalledWith(
            expect.objectContaining({ key: "same-session" })
        );
    });

    it("replaceSessionsFromWebSocket handles non-array input", () => {
        mockIsReady.mockReturnValue(true);
        replaceSessionsFromWebSocket({ sessions: [] });
        expect(mockUtils.writeUpsert).not.toHaveBeenCalled();
    });
});
