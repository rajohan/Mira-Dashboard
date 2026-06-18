import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";
import { act } from "react";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import { stubGlobal } from "../test/testUtils";
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
        const fetchMock = jest
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
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    jobId: "",
                    status: "running",
                    code: null,
                    stdout: "",
                    stderr: "",
                    startedAt: 1,
                    endedAt: null,
                }),
            });
        stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");
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
        await act(async () => {
            await disabledJob.current.refetch();
        });
        expect(fetchMock).toHaveBeenLastCalledWith("/api/exec/", expect.any(Object));
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
            result.current.updateCommand("missing", { status: "error" });
        });
        expect(result.current.history[0].status).toBe("done");

        act(() => {
            result.current.clearHistory();
        });
        expect(result.current.history.length).toBe(0);
    });

    it("calls helper functions", async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                completions: [
                    { completion: "file.ts", type: "file", display: "file.ts" },
                ],
                commonPrefix: "file",
            }),
        });
        stubGlobal("fetch", fetchMock);

        const result = await getCompletions("fi", "/home");
        expect(result.commonPrefix).toBe("file");

        const cdMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ success: true, newCwd: "/tmp" }),
        });
        stubGlobal("fetch", cdMock);
        const cdResult = await changeDirectory("/tmp", "/home");
        expect(cdResult.newCwd).toBe("/tmp");

        const stopMock = jest
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        stubGlobal("fetch", stopMock);
        await stopTerminalJob("j1");
        expect(stopMock).toHaveBeenCalledWith(
            "/api/exec/j1/stop",
            expect.objectContaining({ method: "POST" })
        );
    });
});
