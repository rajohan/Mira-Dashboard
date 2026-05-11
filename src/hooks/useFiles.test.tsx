import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import { useFileContent, useFiles, useSaveFile } from "./useFiles";

describe("useFiles hooks", () => {
    it("fetches file listing and file content, handles null content path", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: [{ path: "/a", type: "file" }] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ path: "/a", content: "hello", size: 5 }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: files } = renderHook(() => useFiles(), { wrapper });
        await waitFor(() => expect(files.current.data?.[0]?.path).toBe("/a"));

        const { result: content } = renderHook(() => useFileContent("/a"), { wrapper });
        await waitFor(() => expect(content.current.data?.content).toBe("hello"));

        const { result: disabled } = renderHook(() => useFileContent(null), { wrapper });
        expect(disabled.current.fetchStatus).toBe("idle");
    });

    it("fetches path-specific listings and falls back to an empty file list", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFiles("/nested path"), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.data).toEqual([]));
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/files?path=%2Fnested%20path",
            expect.any(Object)
        );
    });

    it("saves file content and invalidates", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result } = renderHook(() => useSaveFile(), { wrapper });
        await act(async () => {
            await result.current.mutateAsync({ path: "/a", content: "updated" });
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/files/%2Fa",
            expect.objectContaining({ method: "PUT" })
        );
        expect(invalidateSpy).toHaveBeenCalled();
    });

    it("saves config files with config: prefix", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: content } = renderHook(
            () => useFileContent("config:agents.yaml"),
            { wrapper }
        );
        await waitFor(() => expect(content.current.fetchStatus).not.toBe("idle"));

        const { result: save } = renderHook(() => useSaveFile(), { wrapper });
        await act(async () => {
            await save.current.mutateAsync({
                path: "config:agents.yaml",
                content: "x: 1",
            });
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/config-files/agents.yaml",
            expect.objectContaining({ method: "PUT" })
        );
    });
});
