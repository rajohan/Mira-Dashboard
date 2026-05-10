import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    dockerKeys,
    startDockerExec,
    stopDockerExec,
    useDeleteDockerImage,
    useDeleteDockerVolume,
    useDockerAction,
    useDockerContainer,
    useDockerContainerLogs,
    useDockerContainers,
    useDockerExecJob,
    useDockerImages,
    useDockerManualUpdate,
    useDockerPrune,
    useDockerUpdaterEvents,
    useDockerUpdaterServices,
    useDockerVolumes,
    useRunDockerUpdater,
} from "./useDocker";

describe("docker hooks", () => {
    it("fetches docker query resources and handles disabled queries", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ containers: [{ id: "c1" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ id: "c1", env: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ content: "logs" }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ images: [{ id: "img" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ volumes: [{ name: "vol" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ jobId: "job", status: "done" }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ services: [], summary: { total: 0 } }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ events: [{ id: 1 }] }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: containers } = renderHook(() => useDockerContainers(), {
            wrapper,
        });
        await waitFor(() => expect(containers.current.data?.[0]?.id).toBe("c1"));

        const { result: container } = renderHook(() => useDockerContainer("c1"), {
            wrapper,
        });
        await waitFor(() => expect(container.current.data?.id).toBe("c1"));

        const { result: logs } = renderHook(() => useDockerContainerLogs("c1", 25), {
            wrapper,
        });
        await waitFor(() => expect(logs.current.data).toBe("logs"));

        const { result: images } = renderHook(() => useDockerImages(), { wrapper });
        await waitFor(() => expect(images.current.data?.[0]?.id).toBe("img"));

        const { result: volumes } = renderHook(() => useDockerVolumes(), { wrapper });
        await waitFor(() => expect(volumes.current.data?.[0]?.name).toBe("vol"));

        const { result: execJob } = renderHook(() => useDockerExecJob("job"), {
            wrapper,
        });
        await waitFor(() => expect(execJob.current.data?.status).toBe("done"));

        const { result: updaterServices } = renderHook(() => useDockerUpdaterServices(), {
            wrapper,
        });
        await waitFor(() => expect(updaterServices.current.data?.summary.total).toBe(0));

        const { result: updaterEvents } = renderHook(() => useDockerUpdaterEvents(5), {
            wrapper,
        });
        await waitFor(() => expect(updaterEvents.current.data?.[0]?.id).toBe(1));

        const { result: disabledContainer } = renderHook(() => useDockerContainer(null), {
            wrapper,
        });
        const { result: disabledLogs } = renderHook(
            () => useDockerContainerLogs(null, 10),
            { wrapper }
        );
        const { result: disabledExec } = renderHook(() => useDockerExecJob(null), {
            wrapper,
        });
        expect(disabledContainer.current.fetchStatus).toBe("idle");
        expect(disabledLogs.current.fetchStatus).toBe("idle");
        expect(disabledExec.current.fetchStatus).toBe("idle");
    });

    it("runs docker mutations and invalidates relevant queries", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, output: "ok" }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: action } = renderHook(() => useDockerAction(), { wrapper });
        const { result: manualUpdate } = renderHook(() => useDockerManualUpdate(), {
            wrapper,
        });
        const { result: runUpdater } = renderHook(() => useRunDockerUpdater(), {
            wrapper,
        });
        const { result: deleteImage } = renderHook(() => useDeleteDockerImage(), {
            wrapper,
        });
        const { result: deleteVolume } = renderHook(() => useDeleteDockerVolume(), {
            wrapper,
        });
        const { result: prune } = renderHook(() => useDockerPrune(), { wrapper });

        await act(async () => {
            await action.current.mutateAsync({ containerId: "c/1", action: "restart" });
            await manualUpdate.current.mutateAsync(7);
            await runUpdater.current.mutateAsync();
            await deleteImage.current.mutateAsync("sha:abc");
            await deleteVolume.current.mutateAsync("vol/name");
            await prune.current.mutateAsync("images");
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/docker/containers/c%2F1/action",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/docker/updater/services/7/update",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/docker/updater/run",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            4,
            "/api/docker/images/sha%3Aabc",
            expect.objectContaining({ method: "DELETE" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            5,
            "/api/docker/volumes/vol%2Fname",
            expect.objectContaining({ method: "DELETE" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            6,
            "/api/docker/prune",
            expect.objectContaining({ body: JSON.stringify({ target: "images" }) })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dockerKeys.containers });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dockerKeys.images });
    });

    it("starts and stops docker exec jobs", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ jobId: "job" }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await startDockerExec("c1", "ls");
        await stopDockerExec("job/1");

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/docker/exec/start",
            expect.objectContaining({
                body: JSON.stringify({ containerId: "c1", command: "ls" }),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/docker/exec/job%2F1/stop",
            expect.objectContaining({ method: "POST" })
        );
    });
});
