import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";

import { createQueryWrapper } from "../test/queryClient";
import { stubGlobal } from "../test/testUtils";
import { useLogContent, useLogFiles } from "./useLogs";

describe("log hooks", () => {
    it("filters invalid log files and fetches content", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    logs: [
                        {
                            modified: "2026-05-11T00:00:00.000Z",
                            name: "app.log",
                            size: 123,
                        },
                        { modified: "2026-05-11T00:00:00.000Z", name: "", size: 0 },
                        null,
                    ],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ content: "hello" }),
            });
        stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: files } = renderHook(() => useLogFiles(), { wrapper });
        await waitFor(() =>
            expect(files.current.data).toEqual([
                { modified: "2026-05-11T00:00:00.000Z", name: "app.log", size: 123 },
            ])
        );

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

    it("handles missing log arrays and non-string content", async () => {
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ logs: "nope" }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ content: null }),
            });
        stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: files } = renderHook(() => useLogFiles(), { wrapper });
        await waitFor(() => expect(files.current.data).toEqual([]));

        const { result: content } = renderHook(() => useLogContent("app log", 10), {
            wrapper,
        });
        await waitFor(() => expect(content.current.data).toBe(""));

        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/logs/content?file=app%20log&lines=10",
            expect.any(Object)
        );
    });

    it("does not fetch content when disabled or file is missing", () => {
        const fetchMock = jest.fn();
        stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useLogContent(null, 20), {
            wrapper: createQueryWrapper(),
        });

        expect(result.current.fetchStatus).toBe("idle");
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
