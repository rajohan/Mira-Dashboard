import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useLogContent, useLogFiles } from "./useLogs";

describe("log hooks", () => {
    it("filters invalid log files and fetches content", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ logs: [{ name: "app.log" }, { name: "" }, null] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ content: "hello" }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: files } = renderHook(() => useLogFiles(), { wrapper });
        await waitFor(() => expect(files.current.data).toEqual([{ name: "app.log" }]));

        const { result: content } = renderHook(() => useLogContent("app.log", 50), {
            wrapper,
        });
        await waitFor(() => expect(content.current.data).toBe("hello"));

        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/logs/content?file=app.log&lines=50",
            expect.any(Object)
        );
    });

    it("does not fetch content when disabled or file is missing", () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useLogContent(null, 20), {
            wrapper: createQueryWrapper(),
        });

        expect(result.current.fetchStatus).toBe("idle");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
