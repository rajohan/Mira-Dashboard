import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    scheduledJobKeys,
    useRunScheduledJobNow,
    useScheduledJobRuns,
    useScheduledJobs,
    useUpdateScheduledJob,
} from "./useScheduledJobs";

function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useScheduledJobs", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("fetches backend-native scheduled jobs", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    jobs: [
                        {
                            enabled: true,
                            id: "ops.log-rotation",
                            intervalSeconds: 86_400,
                            isRunning: false,
                            lastRun: undefined,
                            name: "Log rotation",
                            nextRunAt: "2026-05-11T02:10:00.000Z",
                            scheduleType: "daily",
                            timeOfDay: "02:10",
                        },
                    ],
                }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useScheduledJobs(), { wrapper });

        await waitFor(() => {
            expect(result.current.data?.[0]?.id).toBe("ops.log-rotation");
        });
        expect(fetchMock).toHaveBeenCalledWith("/api/jobs", expect.any(Object));
        expect(scheduledJobKeys.list()).toEqual(["scheduled-jobs", "list"]);
    });

    it("fetches scheduled job runs", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    runs: [
                        {
                            finishedAt: undefined,
                            id: 42,
                            jobId: "ops.log-rotation",
                            message: undefined,
                            output: {},
                            startedAt: "2026-05-11T02:10:00.000Z",
                            status: "running",
                            triggerType: "manual",
                        },
                    ],
                }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useScheduledJobRuns("ops.log-rotation"), {
            wrapper,
        });

        await waitFor(() => {
            expect(result.current.data?.[0]?.id).toBe(42);
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/jobs/ops.log-rotation/runs",
            expect.any(Object)
        );
        expect(scheduledJobKeys.runs("ops.log-rotation")).toEqual([
            "scheduled-jobs",
            "runs",
            "ops.log-rotation",
        ]);
    });

    it("updates and manually runs scheduled jobs", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    ok: true,
                    run: {
                        finishedAt: "2026-05-11T02:10:01.000Z",
                        id: 43,
                        jobId: "ops.log-rotation",
                        message: undefined,
                        output: {},
                        startedAt: "2026-05-11T02:10:00.000Z",
                        status: "success",
                        triggerType: "manual",
                    },
                }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result: update } = renderHook(() => useUpdateScheduledJob(), {
            wrapper,
        });
        const { result: runNow } = renderHook(() => useRunScheduledJobNow(), {
            wrapper,
        });

        await update.current.mutateAsync({
            id: "ops.log-rotation",
            patch: { enabled: false },
        });
        await runNow.current.mutateAsync({ id: "ops.log-rotation" });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/jobs/ops.log-rotation",
            expect.objectContaining({
                body: JSON.stringify({ patch: { enabled: false } }),
                method: "PATCH",
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/jobs/ops.log-rotation/run",
            expect.objectContaining({ method: "POST" })
        );
    });

    it("rejects failed manual scheduled job runs", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    ok: false,
                    run: {
                        finishedAt: "2026-05-11T02:10:01.000Z",
                        id: 44,
                        jobId: "ops.log-rotation",
                        message: "Rotation failed",
                        output: {},
                        startedAt: "2026-05-11T02:10:00.000Z",
                        status: "failed",
                        triggerType: "manual",
                    },
                }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useRunScheduledJobNow(), { wrapper });

        await expect(
            result.current.mutateAsync({ id: "ops.log-rotation" })
        ).rejects.toThrow("Rotation failed");
    });

    it("uses a fallback error for failed manual runs without messages", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () =>
                JSON.stringify({
                    ok: true,
                    run: {
                        finishedAt: "2026-05-11T02:10:01.000Z",
                        id: 45,
                        jobId: "ops.log-rotation",
                        message: undefined,
                        output: {},
                        startedAt: "2026-05-11T02:10:00.000Z",
                        status: "failed",
                        triggerType: "manual",
                    },
                }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useRunScheduledJobNow(), { wrapper });

        await expect(
            result.current.mutateAsync({ id: "ops.log-rotation" })
        ).rejects.toThrow("Scheduled job run failed");
    });
});
