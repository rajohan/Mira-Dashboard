import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";

import { createQueryWrapper } from "../test/queryClient";
import { stubGlobal } from "../test/testUtils";
import { useHealth } from "./useHealth";

describe("useHealth", () => {
    it("fetches health status", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: "ok", gatewayConnected: true, sessionCount: 2 }),
        });
        stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useHealth(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.data?.status).toBe("ok"));
        expect(result.current.data?.gatewayConnected).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.any(Object));
    });
});
