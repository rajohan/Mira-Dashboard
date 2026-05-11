import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    cacheKeys,
    useCacheEntry,
    useCacheHeartbeat,
    useRefreshCacheEntry,
} from "./useCache";

describe("cache hooks", () => {
    it("fetches heartbeat and encoded cache entries", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ generatedAt: "now", count: 0, entries: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ key: "system.host", data: { ok: true } }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const wrapper = createQueryWrapper();
        const { result: heartbeat } = renderHook(() => useCacheHeartbeat(1000), {
            wrapper,
        });
        await waitFor(() => expect(heartbeat.current.data?.generatedAt).toBe("now"));

        const { result: entry } = renderHook(() => useCacheEntry("system.host"), {
            wrapper,
        });
        await waitFor(() => expect(entry.current.data?.key).toBe("system.host"));

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/cache/heartbeat",
            expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/cache/system.host",
            expect.any(Object)
        );
    });

    it("refreshes non-moltbook entries without broad moltbook invalidation", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

        const { result } = renderHook(() => useRefreshCacheEntry(), {
            wrapper: createQueryWrapper(queryClient),
        });

        await act(async () => {
            await result.current.mutateAsync("system.host");
        });

        expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["moltbook"] });
    });

    it("refreshes comma-separated entries and invalidates related queries", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, entry: { key: "moltbook.home" } }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

        const { result } = renderHook(() => useRefreshCacheEntry(), {
            wrapper: createQueryWrapper(queryClient),
        });

        await act(async () => {
            await result.current.mutateAsync(" system.host, moltbook.home ");
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/cache/system.host/refresh",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/cache/moltbook.home/refresh",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: cacheKeys.heartbeat() });
        expect(invalidateSpy).toHaveBeenCalledWith({
            queryKey: cacheKeys.entry("system.host"),
        });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["moltbook"] });
    });
});
