import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduledJobKeys, useScheduledJobs } from "./useScheduledJobs";

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
});
