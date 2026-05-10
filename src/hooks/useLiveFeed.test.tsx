import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useLiveFeed } from "./useLiveFeed";

describe("useLiveFeed", () => {
    it("fetches histories, normalizes roles, filters blanks and sorts newest first", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            role: "toolResult",
                            content: "older",
                            timestamp: "2026-01-01T00:00:00Z",
                        },
                        { role: "assistant", content: "   " },
                    ],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            role: "user",
                            content: "newer",
                            timestamp: "2026-01-02T00:00:00Z",
                        },
                    ],
                }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(
            () =>
                useLiveFeed(
                    [
                        { key: "s1", displayName: "One", type: "direct", updatedAt: 1 },
                        { key: "s2", displayLabel: "Two", type: "group", updatedAt: 2 },
                    ] as never,
                    false
                ),
            { wrapper: createQueryWrapper() }
        );

        await waitFor(() =>
            expect(result.current.data?.map((item) => item.content)).toEqual([
                "newer",
                "older",
            ])
        );
        expect(result.current.data?.[1]?.role).toBe("tool_result");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/s1/history?limit=20&offset=0",
            expect.any(Object)
        );
    });

    it("stays disabled without valid sessions", () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useLiveFeed([] as never, false), {
            wrapper: createQueryWrapper(),
        });

        expect(result.current.fetchStatus).toBe("idle");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
