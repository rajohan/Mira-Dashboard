import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useFileExplorerState } from "./useFileExplorerState";

vi.mock("../utils/json", () => ({
    validateJsonString: (s: string) => {
        if (s === "missing error") {
            return { valid: false, error: null };
        }

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

    it("expands directory and loads children", async () => {
        const dirFiles = [
            { path: "/root", type: "directory", loaded: false },
            { path: "/root/other.txt", type: "file", loaded: false },
        ];
        const childFiles = [
            { path: "/root/child1.txt", type: "file" },
            { path: "/root/sub", type: "directory" },
        ];

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: dirFiles }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: childFiles }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.files.length).toBeGreaterThan(0));

        // Expand the directory
        await act(async () => {
            await result.current.handleToggle("/root");
        });

        expect(result.current.expandedPaths.has("/root")).toBe(true);
    });

    it("collapses an expanded directory", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                files: [{ path: "/dir", type: "directory", loaded: true }],
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.files.length).toBeGreaterThan(0));

        // Expand then collapse
        await act(async () => {
            await result.current.handleToggle("/dir");
        });
        expect(result.current.expandedPaths.has("/dir")).toBe(true);

        await act(async () => {
            await result.current.handleToggle("/dir");
        });
        expect(result.current.expandedPaths.has("/dir")).toBe(false);
    });

    it("loads a nested directory through recursive lookup", async () => {
        const rootFiles = [
            {
                path: "/root",
                type: "directory",
                loaded: true,
                children: [{ path: "/root/sub", type: "directory", loaded: false }],
            },
        ];
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: rootFiles }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    files: [{ path: "/root/sub/file.txt", type: "file" }],
                }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.files.length).toBe(1));
        await act(async () => {
            await result.current.handleToggle("/root/sub");
        });
        expect(result.current.expandedPaths.has("/root/sub")).toBe(true);
    });

    it("refreshes selected file content", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: [] }),
            })
            .mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ path: "/a/b.txt", content: "hello", size: 5 }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleSelect("/a/b.txt");
        });
        await waitFor(() => expect(result.current.editedContent).toBe("hello"));
        act(() => {
            result.current.handleRefresh();
        });
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("uses empty content fallback for sparse file responses", async () => {
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
                json: async () => ({ path: "/empty.txt", size: 0 }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleSelect("/empty.txt");
        });
        await waitFor(() => expect(result.current.fileContent?.path).toBe("/empty.txt"));
        expect(result.current.editedContent).toBe("");
    });

    it("handles large file warning", async () => {
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
                json: async () => ({
                    path: "/big.txt",
                    content: "x".repeat(200_000),
                    size: 200_000,
                }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleSelect("/big.txt");
        });
        await waitFor(() => expect(result.current.largeFileWarning).toBe(true));
    });

    it("handles save error", async () => {
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
                json: async () => ({
                    path: "/a/b.txt",
                    content: "original",
                    size: 8,
                }),
            })
            .mockRejectedValueOnce(new Error("Network error"));
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleSelect("/a/b.txt");
        });
        await waitFor(() => expect(result.current.editedContent).toBe("original"));

        act(() => {
            result.current.handleContentChange("changed");
        });

        await act(async () => {
            await result.current.handleSave();
        });
        expect(result.current.error).toBeTruthy();
    });

    it("handles save without selection", async () => {
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

        // No file selected, save should return early
        await act(async () => {
            await result.current.handleSave();
        });
        expect(result.current.error).toBeNull();
    });

    it("validates json5 editing mode", async () => {
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
                json: async () => ({
                    path: "/a/b.json5",
                    content: "{a: 1}",
                    size: 6,
                }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleSelect("/a/b.json5");
        });
        await waitFor(() => expect(result.current.editedContent).toBe("{a: 1}"));

        // Switch to json editing mode
        act(() => {
            result.current.setJsonPreview(false);
        });

        expect(result.current.isJsonEditing).toBe(true);
    });

    it("handles code edit mode and markdown preview toggle", async () => {
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
            result.current.setCodeEditMode(true);
        });
        expect(result.current.codeEditMode).toBe(true);

        act(() => {
            result.current.setMarkdownPreview(false);
        });
        expect(result.current.markdownPreview).toBe(false);
    });

    it("handles unloaded directories with missing children payloads", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    files: [{ path: "/empty-dir", type: "directory", loaded: false }],
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({}),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.files.length).toBe(1));
        await act(async () => {
            await result.current.handleToggle("/empty-dir");
        });

        expect(result.current.files[0]?.children).toEqual([]);
    });

    it("handles toggles for missing nested targets without loading children", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({
                files: [
                    {
                        path: "/root",
                        type: "directory",
                        loaded: true,
                        children: [{ path: "/root/file.txt", type: "file" }],
                    },
                ],
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.files.length).toBe(1));
        await act(async () => {
            await result.current.handleToggle("/root/missing");
        });

        expect(result.current.expandedPaths.has("/root/missing")).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("uses parse-error fallback for invalid JSON without an error message", async () => {
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
            result.current.handleContentChange("missing error");
        });

        await act(async () => {
            await result.current.handleSave();
        });

        expect(result.current.error).toBe("Invalid JSON: parse error");
    });

    it("uses generic save error fallback for non-error failures", async () => {
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
                json: async () => ({ path: "/a/b.txt", content: "original", size: 8 }),
            })
            .mockRejectedValueOnce("boom");
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.rootLoading).toBe(false));
        act(() => {
            result.current.handleSelect("/a/b.txt");
        });
        await waitFor(() => expect(result.current.editedContent).toBe("original"));
        act(() => {
            result.current.handleContentChange("changed");
        });

        await act(async () => {
            await result.current.handleSave();
        });

        expect(result.current.error).toBe("Failed to save");
    });

    it("handles directory toggle failure gracefully", async () => {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const dirFiles = [{ path: "/fail", type: "directory", loaded: false }];
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ files: dirFiles }),
            })
            .mockRejectedValueOnce(new Error("Failed to load directory"));
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useFileExplorerState(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.files.length).toBeGreaterThan(0));

        await act(async () => {
            await result.current.handleToggle("/fail");
        });
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            "Failed to load directory:",
            expect.any(Error)
        );
        expect(result.current.expandedPaths.has("/fail")).toBe(true);
        consoleErrorSpy.mockRestore();
    });
});
