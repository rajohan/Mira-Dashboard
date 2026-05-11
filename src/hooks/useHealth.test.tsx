import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useHealth } from "./useHealth";

describe("useHealth", () => {
    it("fetches health status", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: "ok", gatewayConnected: true, sessionCount: 2 }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useHealth(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.data?.status).toBe("ok"));
        expect(result.current.data?.gatewayConnected).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.any(Object));
    });
});
