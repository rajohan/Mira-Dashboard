import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    jobKeys,
    useRunScheduledJob,
    useScheduledJobs,
    useUpdateScheduledJob,
} from "./useJobs";

describe("job hooks", () => {
    it("fetches scheduled jobs", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ jobs: [{ id: "cache.weather" }] }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useScheduledJobs(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() =>
            expect(result.current.data).toEqual([{ id: "cache.weather" }])
        );
        expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/jobs", expect.any(Object));
    });

    it("updates scheduled jobs and invalidates the list", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ job: { id: "cache.weather" }, ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

        const { result } = renderHook(() => useUpdateScheduledJob(), {
            wrapper: createQueryWrapper(queryClient),
        });

        await act(async () => {
            await result.current.mutateAsync({
                id: "cache.weather",
                patch: { enabled: false },
            });
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/jobs/cache.weather",
            expect.objectContaining({ method: "PATCH" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobKeys.list() });
    });

    it("runs scheduled jobs and invalidates the list", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, run: { id: 1 } }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

        const { result } = renderHook(() => useRunScheduledJob(), {
            wrapper: createQueryWrapper(queryClient),
        });

        await act(async () => {
            await result.current.mutateAsync({ id: "cache.weather" });
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/jobs/cache.weather/run",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobKeys.list() });
    });
});
