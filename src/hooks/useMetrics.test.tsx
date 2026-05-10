import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useMetrics } from "./useMetrics";

describe("useMetrics", () => {
    it("fetches metrics", async () => {
        const metrics = {
            cpu: {},
            memory: {},
            disk: {},
            system: {},
            network: {},
            tokens: {},
            timestamp: 1,
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => metrics });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useMetrics(5000), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.data).toBe(metrics));
        expect(fetchMock).toHaveBeenCalledWith("/api/metrics", expect.any(Object));
    });
});
