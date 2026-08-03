import { describe, expect, it, jest } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import * as processModule from "../../src/lib/processes.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend exec services", () => {
    const {
        createTemporaryRoot,
        readableUtf8Stream,
        startTestScheduledExecutor,
        waitFor,
    } = createServiceBehaviorHarness();
    it("validates exec requests and maps route errors without starting unsafe commands", async () => {
        const { execErrorResponse, getExecJob, runExecOnce, startExecJob } =
            await import("../../src/services/execJobs.ts");
        const { execRoutes } = await import("../../src/routes/execRoutes.ts");
        expect(runExecOnce()).rejects.toThrow("request body must be a JSON object");
        expect(
            runExecOnce({
                args: [],
                command: "node",
                shell: true,
            })
        ).rejects.toThrow("args cannot be combined with shell mode");
        expect(
            runExecOnce({
                args: [],
                command: "node/child",
            })
        ).rejects.toThrow("command must be an approved executable name");
        expect(
            runExecOnce({
                args: [],
                command: "node",
            })
        ).rejects.toThrow("command executable is not approved");
        expect(
            runExecOnce({
                args: ["-lc", "echo hi"],
                command: "bash",
            })
        ).rejects.toThrow("bash argv execution requires job tracking");
        expect(
            runExecOnce({
                args: "not-array",
                command: "__mira_dashboard_shell_smoke_test__",
            })
        ).rejects.toThrow("args must be an array");
        expect(
            runExecOnce({
                args: [42],
                command: "__mira_dashboard_shell_smoke_test__",
            })
        ).rejects.toThrow("all args must be strings");
        expect(
            runExecOnce({
                args: ["bad\0arg"],
                command: "__mira_dashboard_shell_smoke_test__",
            })
        ).rejects.toThrow("args cannot contain null bytes");
        expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: 42,
                shell: true,
            })
        ).rejects.toThrow("cwd must be a string");
        expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: "relative",
                shell: true,
            })
        ).rejects.toThrow("cwd must be an absolute path");
        const execFileCwd = path.join(createTemporaryRoot("mira-exec-cwd-"), "file");
        writeFileSync(execFileCwd, "not a directory");
        expect(
            runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                cwd: execFileCwd,
                shell: true,
            })
        ).rejects.toThrow("cwd must be a directory");
        const notFoundError = Object.assign(new Error("missing"), {
            statusCode: 404,
        });
        expect(execErrorResponse(notFoundError)).toEqual({
            code: "exec_request_failed",
            message: "missing",
            status: 404,
        });
        expect(execErrorResponse(new Error("boom"))).toEqual({
            code: "exec_internal_error",
            message: "internal server error",
            status: 500,
        });
        expect(() =>
            startExecJob({
                command: "node",
            })
        ).toThrow("args are required unless shell mode is enabled");
        expect(() =>
            startExecJob({
                args: ["-lc", "x".repeat(4097)],
                command: "bash",
            })
        ).toThrow("command exceeds maximum length");
        expect(() => getExecJob("missing-job")).toThrow("Exec job not found");
        const invalidPost = await execRoutes["/api/exec"].POST(
            new Request("https://test.local/api/exec", {
                body: JSON.stringify({
                    command: "node",
                }),
                method: "POST",
            })
        );
        expect(invalidPost.status).toBe(400);
        expect(invalidPost.json()).resolves.toEqual({
            error: {
                code: "exec_invalid_request",
                message: "args are required unless shell mode is enabled",
                requestId: expect.any(String),
            },
        });
        const malformedStart = await execRoutes["/api/exec/start"].POST(
            new Request("https://test.local/api/exec/start", {
                body: "{bad json",
                method: "POST",
            })
        );
        expect(malformedStart.status).toBe(400);
        expect(malformedStart.json()).resolves.toEqual({
            error: {
                code: "invalid_json",
                message: "Invalid JSON",
                requestId: expect.any(String),
            },
        });
        const missingJobRequest = Object.assign(
            new Request("https://test.local/api/exec/missing-job"),
            {
                params: {
                    jobId: "missing-job",
                },
            }
        );
        const missingJob = execRoutes["/api/exec/:jobId"].GET(missingJobRequest);
        expect(missingJob.status).toBe(404);
        expect(missingJob.json()).resolves.toEqual({
            error: {
                code: "exec_job_not_found",
                message: "Exec job not found",
                requestId: expect.any(String),
            },
        });
        const stopMissingJob =
            execRoutes["/api/exec/:jobId/stop"].POST(missingJobRequest);
        expect(stopMissingJob.status).toBe(404);
        expect(stopMissingJob.json()).resolves.toEqual({
            error: {
                code: "exec_job_not_found",
                message: "Exec job not found",
                requestId: expect.any(String),
            },
        });
    });
    it("starts, stops, and reports exec jobs through the service lifecycle", async () => {
        const { getExecJob, registerExecExecutionActions, startExecJob, stopExecJob } =
            await import("../../src/services/execJobs.ts");
        const exit = Promise.withResolvers<number>();
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: exit.promise,
                    kill: () => {
                        exit.resolve(143);
                    },
                    pid: 123,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(""),
                }) as unknown as processModule.BunProcess
        );
        try {
            registerExecExecutionActions();
            await startTestScheduledExecutor();
            const { jobId } = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            expect(getExecJob(jobId)).toMatchObject({
                jobId,
                status: "running",
            });
            await waitFor(() => spawnSpy.mock.calls.length === 1, 3000);
            expect(stopExecJob(jobId)).toEqual({
                isSuccess: true,
                message: "Stop signal sent",
            });
            await waitFor(() => getExecJob(jobId).status === "done", 3000);
            expect(() => stopExecJob(jobId)).toThrow("Job is not running");
        } finally {
            exit.resolve(0);
            await Bun.sleep(0);
            spawnSpy.mockRestore();
        }
    });
    it("serializes concurrent exec jobs through global execution capacity", async () => {
        const { registerExecExecutionActions, startExecJob } =
            await import("../../src/services/execJobs.ts");
        const exits: Array<ReturnType<typeof Promise.withResolvers<number>>> = [];
        const spawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(() => {
                const exit = Promise.withResolvers<number>();
                exits.push(exit);
                return {
                    exited: exit.promise,
                    kill: () => {},
                    pid: 987,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(""),
                } as unknown as processModule.BunProcess;
            });
        try {
            registerExecExecutionActions();
            await startTestScheduledExecutor();
            const first = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            const second = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            expect(first.jobId).not.toBe(second.jobId);
            await waitFor(() => exits.length === 1, 3000);
            exits[0]?.resolve(0);
            await waitFor(() => exits.length === 2, 3000);
            exits[1]?.resolve(0);
        } finally {
            for (const exit of exits) {
                exit.resolve(0);
            }
            await Bun.sleep(0);
            spawnSpy.mockRestore();
        }
    });
    it("records exec process failures and trims oversized output", async () => {
        const { getExecJob, registerExecExecutionActions, runExecOnce, startExecJob } =
            await import("../../src/services/execJobs.ts");
        const longOutput = `${"x".repeat(101_000)}tail`;
        const spawnSpy = jest.spyOn(processModule, "spawnProcess").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve(0),
                    kill: () => {},
                    pid: 123,
                    stderr: readableUtf8Stream(""),
                    stdout: readableUtf8Stream(longOutput),
                }) as unknown as processModule.BunProcess
        );
        try {
            registerExecExecutionActions();
            await startTestScheduledExecutor();
            const once = await runExecOnce({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            expect(once.code).toBe(0);
            expect(once.stdout).toHaveLength(10_000);
            expect(once.stdout.endsWith("tail")).toBe(true);
        } finally {
            spawnSpy.mockRestore();
        }
        const failingSpawnSpy = jest
            .spyOn(processModule, "spawnProcess")
            .mockImplementation(
                () =>
                    ({
                        exited: Promise.reject(new Error("spawn exit failed")),
                        kill: () => {},
                        pid: 456,
                        stderr: readableUtf8Stream("before failure"),
                        stdout: readableUtf8Stream(""),
                    }) as unknown as processModule.BunProcess
            );
        try {
            const started = startExecJob({
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            });
            const deadline = Date.now() + 2000;
            let job = getExecJob(started.jobId);
            while (job.status === "running" && Date.now() < deadline) {
                await Bun.sleep(10);
                job = getExecJob(started.jobId);
            }
            expect(job).toMatchObject({
                code: 1,
                status: "done",
            });
            expect(job.stderr).toContain("spawn exit failed");
        } finally {
            failingSpawnSpy.mockRestore();
        }
    });
});
