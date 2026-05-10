import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    logRotationKeys,
    useLogRotationStatus,
    useRunLogRotationDryRun,
    useRunLogRotationNow,
} from "./useLogRotation";

describe("log rotation hooks", () => {
    it("fetches log rotation status", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                success: true,
                lastRun: { ok: true, dryRun: false, rotatedFiles: 3 },
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useLogRotationStatus(), {
            wrapper: createQueryWrapper(),
        });
        await waitFor(() => expect(result.current.data?.lastRun?.rotatedFiles).toBe(3));
    });

    it("runs dry-run (no invalidation) and live run (invalidates)", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                success: true,
                result: { ok: true, dryRun: true, rotatedFiles: 0 },
                stderr: "",
            }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: dryRun } = renderHook(() => useRunLogRotationDryRun(), {
            wrapper,
        });
        await act(async () => {
            await dryRun.current.mutateAsync();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/ops/log-rotation/dry-run",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).not.toHaveBeenCalled();

        const { result: liveRun } = renderHook(() => useRunLogRotationNow(), { wrapper });
        await act(async () => {
            await liveRun.current.mutateAsync();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/ops/log-rotation/run",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: logRotationKeys.status });
    });
});
