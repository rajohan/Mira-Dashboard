import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    changeDirectory,
    getCompletions,
    stopTerminalJob,
    useStartTerminalCommand,
    useTerminalHistory,
    useTerminalJob,
} from "./useTerminal";

describe("terminal hooks", () => {
    it("starts terminal command and polls job", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ jobId: "t1" }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    jobId: "t1",
                    status: "done",
                    code: 0,
                    stdout: "ok",
                    stderr: "",
                    startedAt: 1,
                    endedAt: 2,
                }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: start } = renderHook(() => useStartTerminalCommand(), {
            wrapper,
        });
        await act(async () => {
            await start.current.mutateAsync({ command: "ls" });
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/exec/start",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalled();

        const { result: job } = renderHook(() => useTerminalJob("t1"), { wrapper });
        await waitFor(() => expect(job.current.data?.status).toBe("done"));

        const { result: disabledJob } = renderHook(() => useTerminalJob(null), {
            wrapper,
        });
        expect(disabledJob.current.fetchStatus).toBe("idle");
    });

    it("manages command history", () => {
        const { result } = renderHook(() => useTerminalHistory());

        let id = "";
        act(() => {
            id = result.current.addCommand({
                command: "ls",
                cwd: "/home",
                jobId: null,
                status: "pending",
                code: null,
                stdout: "",
                stderr: "",
                startedAt: 1,
                endedAt: null,
            });
        });
        expect(result.current.history.length).toBe(1);
        expect(result.current.history[0].command).toBe("ls");

        act(() => {
            result.current.updateCommand(id, { status: "done", code: 0 });
        });
        expect(result.current.history[0].status).toBe("done");

        act(() => {
            result.current.clearHistory();
        });
        expect(result.current.history.length).toBe(0);
    });

    it("calls helper functions", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                completions: [
                    { completion: "file.ts", type: "file", display: "file.ts" },
                ],
                commonPrefix: "file",
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const result = await getCompletions("fi", "/home");
        expect(result.commonPrefix).toBe("file");

        const cdMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, newCwd: "/tmp" }),
        });
        vi.stubGlobal("fetch", cdMock);
        const cdResult = await changeDirectory("/tmp", "/home");
        expect(cdResult.newCwd).toBe("/tmp");

        const stopMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", stopMock);
        await stopTerminalJob("j1");
        expect(stopMock).toHaveBeenCalledWith(
            "/api/exec/j1/stop",
            expect.objectContaining({ method: "POST" })
        );
    });
});
