import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    backupKeys,
    useKopiaBackup,
    useRunKopiaBackup,
    useRunWalgBackup,
    useWalgBackup,
} from "./useBackups";
import { cacheKeys } from "./useCache";

describe("backup hooks", () => {
    it("fetches kopia and walg backup state", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ job: null }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ job: { id: "walg", status: "running" } }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: kopia } = renderHook(() => useKopiaBackup(), { wrapper });
        await waitFor(() => expect(kopia.current.data?.job).toBeNull());

        const { result: walg } = renderHook(() => useWalgBackup(), { wrapper });
        await waitFor(() => expect(walg.current.data?.job?.id).toBe("walg"));

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/backups/kopia",
            expect.any(Object)
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/backups/walg",
            expect.any(Object)
        );
    });

    it("runs backups and invalidates status caches", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, job: { id: "job" } }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: kopia } = renderHook(() => useRunKopiaBackup(), { wrapper });
        const { result: walg } = renderHook(() => useRunWalgBackup(), { wrapper });

        await act(async () => {
            await kopia.current.mutateAsync();
            await walg.current.mutateAsync();
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/backups/kopia/run",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/backups/walg/run",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: backupKeys.kopia() });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: backupKeys.walg() });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: cacheKeys.heartbeat() });
    });
});
