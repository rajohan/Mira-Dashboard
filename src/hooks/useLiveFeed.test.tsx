import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { feedItemFromSocketEvent, useLiveFeed } from "./useLiveFeed";

describe("useLiveFeed", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("fetches histories, normalizes roles, filters blanks and sorts newest first", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            id: "older",
                            role: "toolResult",
                            content: "older",
                            timestamp: "2026-01-01T00:00:00Z",
                        },
                        {
                            id: "fallback",
                            role: "tool-result",
                            content: "fallback timestamp",
                            timestamp: "not-a-date",
                        },
                        {
                            id: "tool-call",
                            role: "tool.call",
                            content: "tool call",
                            timestamp: "2026-01-01T00:00:01Z",
                        },
                        {
                            id: "system-event",
                            role: "developer",
                            content: "system event",
                            timestamp: "2026-01-01T00:00:02Z",
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
                            id: "newer",
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
                "system event",
                "tool call",
                "older",
                "fallback timestamp",
            ])
        );
        expect(result.current.data?.[1]?.role).toBe("system");
        expect(result.current.data?.[2]?.role).toBe("tool");
        expect(result.current.data?.[3]?.role).toBe("tool_result");
        expect(result.current.data?.[4]).toMatchObject({
            id: "s1-fallback",
            sessionLabel: "One",
            sessionType: "DIRECT",
            role: "tool_result",
            timestamp: 1,
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/s1/history?limit=20&offset=0",
            expect.any(Object)
        );
    });

    it("falls back to session key, unknown type, unknown role, and string content", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                messages: [{ role: null, content: 123, timestamp: undefined }],
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(
            () => useLiveFeed([{ key: "s3", updatedAt: 7 }] as never, false),
            { wrapper: createQueryWrapper() }
        );

        await waitFor(() =>
            expect(result.current.data?.[0]).toMatchObject({
                sessionLabel: "s3",
                sessionType: "UNKNOWN",
                role: "unknown",
                content: "123",
                timestamp: 7,
            })
        );
        expect(result.current.data?.[0]?.id).toMatch(/^s3-fallback-/u);
    });

    it("uses deterministic fallback ids when history rows lack ids and timestamps", async () => {
        vi.spyOn(Date, "now").mockReturnValue(987_654_321);
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                messages: [{ role: "assistant", content: "visible" }],
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(
            () => useLiveFeed([{ key: "s3", updatedAt: null }] as never, false),
            { wrapper: createQueryWrapper() }
        );

        await waitFor(() => expect(result.current.data?.[0]?.content).toBe("visible"));

        expect(result.current.data?.[0]?.timestamp).toBe(0);
        expect(result.current.data?.[0]?.id).toMatch(/^s3-fallback-/u);
        expect(result.current.data?.[0]?.id).not.toContain("987654321");
    });

    it("converts runtime socket events into feed rows for matching sessions", () => {
        const session = {
            activeRunId: "run-1",
            displayLabel: "Main",
            id: "session-1",
            key: "agent:main:main",
            type: "main",
        };

        expect(
            feedItemFromSocketEvent(
                {
                    event: "session.tool",
                    payload: {
                        data: {
                            args: { cmd: "gh pr checks 54" },
                            name: "exec_command",
                        },
                        runId: "run-1",
                    },
                    type: "event",
                },
                [session] as never,
                123
            )
        ).toMatchObject({
            content: "Exec command: gh pr checks 54",
            id: expect.stringMatching(/^agent:main:main-live-/u),
            role: "tool",
            sessionKey: "agent:main:main",
            sessionLabel: "Main",
            sessionType: "MAIN",
            timestamp: 123,
        });

        expect(
            feedItemFromSocketEvent(
                {
                    event: "session.message",
                    payload: {
                        message: "Working",
                        sessionKey: "agent:main:main",
                    },
                    type: "event",
                },
                [session] as never,
                124
            )
        ).toMatchObject({
            content: "Working",
            role: "assistant",
            timestamp: 124,
        });
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

    it("ignores non-array sessions and malformed history message lists", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ messages: null }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result: disabled } = renderHook(() => useLiveFeed(null as never, false), {
            wrapper: createQueryWrapper(),
        });
        expect(disabled.current.fetchStatus).toBe("idle");

        const { result } = renderHook(
            () => useLiveFeed([{ key: "valid", updatedAt: 1 }] as never, false),
            { wrapper: createQueryWrapper() }
        );

        await waitFor(() => expect(result.current.data).toEqual([]));
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/valid/history?limit=20&offset=0",
            expect.any(Object)
        );
    });

    it("keeps live feed working when one session history request fails", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({ error: "missing" }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    messages: [
                        {
                            role: "assistant",
                            content: "still visible",
                            timestamp: "2026-01-03T00:00:00Z",
                        },
                    ],
                }),
            });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(
            () =>
                useLiveFeed(
                    [
                        { key: "stale", updatedAt: 1 },
                        { key: "live", updatedAt: 2 },
                    ] as never,
                    false
                ),
            { wrapper: createQueryWrapper() }
        );

        await waitFor(() =>
            expect(result.current.data?.map((item) => item.content)).toEqual([
                "still visible",
            ])
        );
        expect(consoleError).toHaveBeenCalledWith(
            "Failed to fetch feed items for session:",
            "stale",
            expect.any(Error)
        );
    });

    it("uses fallbacks for sessions and messages with missing optional fields", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                messages: [{ role: "assistant", content: "visible" }, { role: "user" }],
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(
            () => useLiveFeed([{ key: "valid" }] as never, false),
            { wrapper: createQueryWrapper() }
        );

        await waitFor(() => expect(result.current.data?.[0]?.content).toBe("visible"));
        expect(result.current.data?.[0]).toMatchObject({
            sessionType: "UNKNOWN",
            sessionLabel: "valid",
            role: "assistant",
        });
    });
});
