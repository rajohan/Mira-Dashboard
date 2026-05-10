import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    cronKeys,
    useCronJobs,
    useRunCronJobNow,
    useToggleCronJob,
    useUpdateCronJob,
} from "./useCron";

describe("cron hooks", () => {
    it("selects jobs from cron jobs response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ jobs: [{ id: "job-1", enabled: true }] }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useCronJobs(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() =>
            expect(result.current.data).toEqual([{ id: "job-1", enabled: true }])
        );
        expect(fetchMock).toHaveBeenCalledWith("/api/cron/jobs", expect.any(Object));
    });

    it("posts mutation payloads and invalidates jobs", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

        const wrapper = createQueryWrapper(queryClient);
        const { result: toggle } = renderHook(() => useToggleCronJob(), { wrapper });
        const { result: update } = renderHook(() => useUpdateCronJob(), { wrapper });
        const { result: runNow } = renderHook(() => useRunCronJobNow(), { wrapper });

        await act(async () => {
            await toggle.current.mutateAsync({ id: "job-1", enabled: false });
            await update.current.mutateAsync({ id: "job-1", patch: { enabled: true } });
            await runNow.current.mutateAsync({ id: "job-1" });
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/cron/jobs/job-1/toggle",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ enabled: false }),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/cron/jobs/job-1/update",
            expect.objectContaining({
                body: JSON.stringify({ patch: { enabled: true } }),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/cron/jobs/job-1/run",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: cronKeys.jobs() });
    });
});
