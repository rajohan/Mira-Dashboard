import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useFileExplorerState } from "./useFileExplorerState";

vi.mock("../utils/json", () => ({
    validateJsonString: (s: string) => {
        try {
            JSON.parse(s);
            return { valid: true, error: null };
        } catch (error) {
            return { valid: false, error: (error as Error).message };
        }
    },
}));

describe("useFileExplorerState", () => {
    it("initializes with defaults and handles file selection", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    files: [{ path: "/a", type: "directory", loaded: false }],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ path: "/a/b.txt", content: "hello", size: 5 }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.files.length).toBeGreaterThan(0));

        act(() => {
            result.current.handleSelect("/a/b.txt");
        });
        await waitFor(() => expect(result.current.editedContent).toBe("hello"));
        expect(result.current.hasChanges).toBe(false);
    });

    it("tracks content changes and saves", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ path: "/a/b.json", content: '{"x":1}', size: 7 }),
            })
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));

        act(() => {
            result.current.handleSelect("/a/b.json");
        });
        await waitFor(() => expect(result.current.editedContent).toBe('{"x":1}'));

        act(() => {
            result.current.handleContentChange('{"x":2}');
        });
        expect(result.current.hasChanges).toBe(true);
        expect(result.current.editedContent).toBe('{"x":2}');

        await act(async () => {
            await result.current.handleSave();
        });
        expect(result.current.hasChanges).toBe(false);
    });

    it("rejects save with invalid json when in json editing mode", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: [] }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ path: "/a/b.json", content: "{}", size: 2 }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleSelect("/a/b.json");
        });
        await waitFor(() => expect(result.current.editedContent).toBe("{}"));

        act(() => {
            result.current.setJsonPreview(false);
        });
        act(() => {
            result.current.handleContentChange("{invalid");
        });

        await act(async () => {
            await result.current.handleSave();
        });
        expect(result.current.error).toBeTruthy();
    });

    it("refreshes files and content", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ files: [] }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleRefresh();
        });
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
