import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import {
    sessionKeys,
    useDeleteSession,
    useSessionAction,
    useSessionHistory,
} from "./useSessions";

vi.mock("../collections/sessions", () => ({
    deleteSessionFromCollection: vi.fn(),
}));

const { deleteSessionFromCollection } = await import("../collections/sessions");

describe("session hooks", () => {
    it("builds session history query keys", () => {
        expect(sessionKeys.history("abc")).toEqual(["sessions", "history", "abc"]);
    });
    it("fetches paginated session history and normalizes invalid messages", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ messages: null, hasMore: true, nextOffset: 50 }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useSessionHistory("agent:main", 25), {
            wrapper: createQueryWrapper(),
        });

        await act(async () => {
            await result.current.refetch();
        });

        expect(fetchMock).toHaveBeenCalled();

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/agent%3Amain/history?offset=0&limit=25",
            expect.any(Object)
        );
    });

    it("keeps valid history messages", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                messages: [{ role: "user", content: "hi" }],
                hasMore: false,
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useSessionHistory("agent:main"), {
            wrapper: createQueryWrapper(),
        });

        await act(async () => {
            await result.current.fetchNextPage();
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/agent%3Amain/history?offset=0&limit=50",
            expect.any(Object)
        );
    });

    it("stays disabled for blank history keys", () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useSessionHistory("   "), {
            wrapper: createQueryWrapper(),
        });

        expect(result.current.fetchStatus).toBe("idle");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts session actions", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useSessionAction(), {
            wrapper: createQueryWrapper(),
        });

        await act(async () => {
            await result.current.mutateAsync({ key: "session:key", action: "compact" });
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/session%3Akey/action",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ action: "compact" }),
            })
        );
    });

    it("deletes sessions and updates the collection", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useDeleteSession(), {
            wrapper: createQueryWrapper(),
        });

        await act(async () => {
            await result.current.mutateAsync("session:key");
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/session%3Akey",
            expect.objectContaining({ method: "DELETE" })
        );
        expect(deleteSessionFromCollection).toHaveBeenCalledWith("session:key");
    });
});
