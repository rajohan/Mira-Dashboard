import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { OPS_ACTIONS, useExecJob, useStartOpsAction } from "./useOpsActions";

describe("ops actions hooks", () => {
    it("exports OPS_ACTIONS with expected entries", () => {
        expect(OPS_ACTIONS.length).toBeGreaterThanOrEqual(5);
        expect(OPS_ACTIONS.find((a) => a.id === "gateway_restart")).toBeDefined();
        expect(OPS_ACTIONS.find((a) => a.id === "system_restart")?.danger).toBe(true);
    });

    it("starts ops action and polls exec job", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ jobId: "j1" }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    jobId: "j1",
                    status: "done",
                    code: 0,
                    stdout: "ok",
                    stderr: "",
                    startedAt: 1,
                    endedAt: 2,
                }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: start } = renderHook(() => useStartOpsAction(), { wrapper });
        const action = OPS_ACTIONS.find((a) => a.id === "gateway_restart")!;
        await act(async () => {
            await start.current.mutateAsync(action);
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/exec/start",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ command: action.command, shell: true }),
            })
        );

        const { result: job } = renderHook(() => useExecJob("j1"), { wrapper });
        await waitFor(() => expect(job.current.data?.status).toBe("done"));

        const { result: disabledJob } = renderHook(() => useExecJob(null), { wrapper });
        expect(disabledJob.current.fetchStatus).toBe("idle");
    });
});
