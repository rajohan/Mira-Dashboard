import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import {
    useAgentsConfig,
    useAgentsStatus,
    useAgentStatus,
    useAgentTaskHistory,
} from "./useAgents";

function mockJson(data: unknown) {
    const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: async () => data });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

describe("agent hooks", () => {
    it("fetches agents status", async () => {
        const fetchMock = mockJson({ agents: [], timestamp: 1 });

        const { result } = renderHook(() => useAgentsStatus(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual({ agents: [], timestamp: 1 });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/agents/status",
            expect.objectContaining({ credentials: "include" })
        );
    });

    it("fetches agents config", async () => {
        mockJson({ defaults: {}, list: [{ id: "main", default: true }] });

        const { result } = renderHook(() => useAgentsConfig(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.data?.list[0]?.id).toBe("main"));
    });

    it("includes history limit and agent id in query URLs", async () => {
        const fetchMock = mockJson({ tasks: [], timestamp: 2 });
        const { result: history } = renderHook(() => useAgentTaskHistory(3), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(history.current.isSuccess).toBe(true));
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/agents/tasks/history?limit=3",
            expect.any(Object)
        );

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ id: "main", name: "Mira" }),
        });
        const { result: status } = renderHook(() => useAgentStatus("main"), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(status.current.data?.id).toBe("main"));
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/agents/main/status",
            expect.any(Object)
        );
    });
});
