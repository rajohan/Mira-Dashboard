import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";

import { createQueryWrapper } from "../test/queryClient";
import { stubGlobal } from "../test/testUtils";
import { useMetrics } from "./useMetrics";

describe("useMetrics", () => {
    it("fetches metrics", async () => {
        const metrics = {
            cpu: { count: 8, loadAvg: [0.1, 0.2, 0.3], loadPercent: 12, model: "x64" },
            memory: {
                free: 2048,
                percent: 50,
                total: 4096,
                totalGB: 4,
                used: 2048,
                usedGB: 2,
            },
            disk: { percent: 25, total: 1000, totalGB: 1, used: 250, usedGB: 0.25 },
            system: { hostname: "mira", platform: "linux", uptime: 3600 },
            network: { downloadMbps: 1, uploadMbps: 2 },
            tokens: { byAgent: [], byModel: {}, sessionsByModel: {}, total: 0 },
            timestamp: 1,
        };
        const fetchMock = jest
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => metrics });
        stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useMetrics(5000), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.data).toBe(metrics));
        expect(fetchMock).toHaveBeenCalledWith("/api/metrics", expect.any(Object));
    });
});
