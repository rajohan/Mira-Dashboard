import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import express from "express";

import execRoutes, { __testing } from "./exec.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    execRoutes(app, express);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.body === undefined
                ? undefined
                : { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

async function waitForJob(
    server: TestServer,
    jobId: string
): Promise<{
    jobId: string;
    status: "running" | "done";
    code: number | null;
    stdout: string;
    stderr: string;
}> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await requestJson<{
            jobId: string;
            status: "running" | "done";
            code: number | null;
            stdout: string;
            stderr: string;
        }>(server, `/api/exec/${jobId}`);

        assert.equal(response.status, 200);
        if (response.body.status === "done") {
            return response.body;
        }

        await delay(25);
    }

    throw new Error(`Timed out waiting for exec job ${jobId}`);
}

describe("exec routes", () => {
    let server: TestServer;

    before(async () => {
        server = await startServer();
    });

    after(async () => {
        await server.close();
        __testing.jobs.clear();
    });

    it("covers exec helper and cleanup edge cases", () => {
        const longOutput = "x".repeat(120_000);
        assert.equal(__testing.trimOutput(longOutput).length, 100_000);
        assert.equal(__testing.resolveCwd(void 0), process.cwd());
        assert.deepEqual(__testing.parseDirectCommand("/bin/echo"), {
            executable: "/bin/echo",
            args: [],
        });
        assert.throws(
            () => __testing.getApprovedShellCommand("echo not approved"),
            /approved ops commands/u
        );
        assert.deepEqual(__testing.execErrorResponse(new Error("boom")), {
            status: 500,
            error: "internal server error",
        });

        __testing.jobs.clear();
        for (let index = 0; index < 101; index += 1) {
            const id = `cleanup-${index}`;
            __testing.jobs.set(id, {
                id,
                status: "done",
                code: 0,
                stdout: "",
                stderr: "",
                startedAt: index,
                endedAt: index,
                process:
                    index === 0
                        ? ({
                              killed: false,
                              kill(signal: NodeJS.Signals): boolean {
                                  assert.equal(signal, "SIGTERM");
                                  return true;
                              },
                          } as never)
                        : undefined,
            });
        }
        __testing.cleanupJobs();
        assert.equal(__testing.jobs.size, 100);
        assert.equal(__testing.jobs.has("cleanup-0"), false);

        __testing.updateExecJobOutput("missing", {
            id: "",
            status: "running",
            code: null,
            stdout: "ignored",
            stderr: "ignored",
            startedAt: 0,
            endedAt: null,
        });
        __testing.completeExecJob("missing", {
            code: 0,
            stdout: "ignored",
            stderr: "ignored",
        });
        __testing.failExecJob("missing", new Error("ignored"));
        __testing.jobs.clear();
        __testing.cleanupJobs();

        __testing.jobs.set("state-helper", {
            id: "state-helper",
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
            endedAt: null,
        });
        __testing.updateExecJobOutput("state-helper", {
            id: "",
            status: "running",
            code: null,
            stdout: "partial",
            stderr: "warning",
            startedAt: 0,
            endedAt: null,
        });
        assert.equal(__testing.jobs.get("state-helper")?.stdout, "partial");
        __testing.completeExecJob("state-helper", {
            code: 0,
            stdout: "done",
            stderr: "",
        });
        assert.equal(__testing.jobs.get("state-helper")?.status, "done");
        assert.equal(__testing.jobs.get("state-helper")?.stdout, "done");

        __testing.jobs.set("state-fail", {
            id: "state-fail",
            status: "running",
            code: null,
            stdout: "",
            stderr: "before",
            startedAt: Date.now(),
            endedAt: null,
        });
        __testing.failExecJob("state-fail", new Error("after"));
        assert.equal(__testing.jobs.get("state-fail")?.code, 1);
        assert.match(__testing.jobs.get("state-fail")?.stderr || "", /after/u);

        __testing.jobs.set("primitive-fail", {
            id: "primitive-fail",
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
            endedAt: null,
        });
        __testing.failExecJob("primitive-fail", "plain failure");
        assert.equal(__testing.jobs.get("primitive-fail")?.code, 1);
        assert.match(
            __testing.jobs.get("primitive-fail")?.stderr || "",
            /plain failure/u
        );
    });

    it("runs one-shot commands with explicit args", async () => {
        const response = await requestJson<{
            code: number;
            stdout: string;
            stderr: string;
        }>(server, "/api/exec", {
            method: "POST",
            body: {
                command: process.execPath,
                args: ["-e", "console.log('hello exec'); console.error('warn exec')"],
            },
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.code, 0);
        assert.equal(response.body.stdout, "hello exec\n");
        assert.equal(response.body.stderr, "warn exec\n");
    });

    it("keeps arbitrary shell syntax out of one-shot direct commands", async () => {
        const rejected = await requestJson<{ error: string }>(server, "/api/exec", {
            method: "POST",
            body: { command: "echo safe && echo unsafe" },
        });

        assert.equal(rejected.status, 400);
        assert.match(rejected.body.error, /shell operators/u);
    });

    it("rejects unparsable and invalid direct commands before spawning", async () => {
        const cases = [
            [{ command: "echo ${bad" }, /could not be parsed/u],
            [{ command: '"' }, /command must start with an executable path/u],
        ] as const;

        for (const [body, expectedError] of cases) {
            const response = await requestJson<{ error: string }>(server, "/api/exec", {
                method: "POST",
                body,
            });
            assert.equal(response.status, 400);
            assert.match(response.body.error, expectedError);
        }
    });

    it("rejects malformed exec request fields", async () => {
        const cases = [
            [[], "request body must be a JSON object"],
            [{ command: "" }, "command must be a non-empty string"],
            [{ command: "x".repeat(4097) }, "command exceeds maximum length"],
            [{ command: "echo\nnope" }, "disallowed control characters"],
            [{ command: process.execPath, shell: "yes" }, "shell must be a boolean"],
            [
                { command: process.execPath, args: ["-v"], shell: true },
                "args cannot be combined with shell mode",
            ],
            [
                { command: "echo unsafe", args: ["hello"] },
                "command must be an executable path",
            ],
            [{ command: process.execPath, args: "bad" }, "args must be an array"],
            [{ command: process.execPath, args: ["ok", 1] }, "all args must be strings"],
            [
                { command: process.execPath, args: ["bad\0arg"] },
                "args cannot contain null bytes",
            ],
            [{ command: process.execPath, cwd: 1 }, "cwd must be a string"],
            [
                { command: process.execPath, cwd: "relative" },
                "cwd must be an absolute path",
            ],
            [
                { command: process.execPath, cwd: "/path/that/does/not/exist" },
                "cwd does not exist",
            ],
        ] as const;

        for (const [body, expectedError] of cases) {
            const response = await requestJson<{ error: string }>(server, "/api/exec", {
                method: "POST",
                body,
            });
            assert.equal(response.status, 400);
            assert.match(response.body.error, new RegExp(expectedError, "u"));
        }
    });

    it("preserves shell operators for background terminal commands", async () => {
        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: { command: "printf alpha && printf beta" },
        });

        assert.equal(started.status, 200);
        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.status, "done");
        assert.equal(job.code, 0);
        assert.equal(job.stdout, "alphabeta");
        assert.equal(job.stderr, "");
    });

    it("allows approved ops commands to run through explicit shell mode", async () => {
        const response = await requestJson<{
            code: number;
            stdout: string;
            stderr: string;
        }>(server, "/api/exec", {
            method: "POST",
            body: {
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            },
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.code, 127);
        assert.match(response.body.stderr, /not found/u);
    });

    it("reports spawn failures without exposing internals", async () => {
        const oneShot = await requestJson<{ error: string }>(server, "/api/exec", {
            method: "POST",
            body: {
                command: "/path/that/does/not/exist",
                args: [],
            },
        });
        assert.equal(oneShot.status, 500);
        assert.equal(oneShot.body.error, "internal server error");

        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: {
                command: "/path/that/does/not/exist",
                args: [],
            },
        });
        assert.equal(started.status, 200);

        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.status, "done");
        assert.equal(job.code, 1);
        assert.match(job.stderr, /ENOENT|no such file/i);
    });

    it("reports synchronous start failures after creating a job", async () => {
        const originalRealpathSync = fs.realpathSync;
        try {
            fs.realpathSync = ((target: fs.PathLike) => {
                if (target === "/tmp") {
                    const error = new Error("permission denied") as NodeJS.ErrnoException;
                    error.code = "EACCES";
                    throw error;
                }
                return originalRealpathSync(target);
            }) as typeof fs.realpathSync;

            const response = await requestJson<{ error: string }>(
                server,
                "/api/exec/start",
                {
                    method: "POST",
                    body: {
                        command: process.execPath,
                        args: ["-v"],
                        cwd: "/tmp",
                    },
                }
            );

            assert.equal(response.status, 500);
            assert.equal(response.body.error, "internal server error");
        } finally {
            fs.realpathSync = originalRealpathSync;
        }
    });

    it("rejects unapproved shell mode commands", async () => {
        const rejected = await requestJson<{ error: string }>(server, "/api/exec", {
            method: "POST",
            body: { command: "echo nope", shell: true },
        });

        assert.equal(rejected.status, 400);
        assert.match(rejected.body.error, /approved ops commands/u);
    });

    it("allows approved shell mode commands for background jobs", async () => {
        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: {
                command: "__mira_dashboard_shell_smoke_test__",
                shell: true,
            },
        });

        assert.equal(started.status, 200);
        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.status, "done");
        assert.equal(job.code, 127);
        assert.match(job.stderr, /not found/u);
    });

    it("rejects unapproved shell mode commands for background jobs", async () => {
        const rejected = await requestJson<{ error: string }>(server, "/api/exec/start", {
            method: "POST",
            body: { command: "echo nope", shell: true },
        });

        assert.equal(rejected.status, 400);
        assert.match(rejected.body.error, /approved ops commands/u);
    });

    it("starts background jobs and exposes their final state", async () => {
        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: {
                command: process.execPath,
                args: ["-e", "setTimeout(() => console.log('done async'), 10)"],
            },
        });

        assert.equal(started.status, 200);
        assert.match(started.body.jobId, /^[\da-f-]{36}$/u);

        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.jobId, started.body.jobId);
        assert.equal(job.status, "done");
        assert.equal(job.code, 0);
        assert.equal(job.stdout, "done async\n");
        assert.equal(job.stderr, "");
    });

    it("reports missing jobs and refuses to stop completed jobs", async () => {
        const missing = await requestJson<{ error: string }>(
            server,
            "/api/exec/00000000-0000-0000-0000-000000000000"
        );
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, "Exec job not found");

        const missingStop = await requestJson<{ error: string }>(
            server,
            "/api/exec/00000000-0000-0000-0000-000000000000/stop",
            { method: "POST" }
        );
        assert.equal(missingStop.status, 404);
        assert.equal(missingStop.body.error, "Exec job not found");

        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: {
                command: process.execPath,
                args: ["-e", "console.log('already done')"],
            },
        });
        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.status, "done");

        const stop = await requestJson<{ error: string }>(
            server,
            `/api/exec/${started.body.jobId}/stop`,
            { method: "POST" }
        );
        assert.equal(stop.status, 400);
        assert.equal(stop.body.error, "Job is not running");
    });

    it("reports unavailable process handles for running jobs", async () => {
        const jobId = "running-without-process";
        __testing.jobs.set(jobId, {
            id: jobId,
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
            endedAt: null,
        });

        try {
            const stop = await requestJson<{ error: string }>(
                server,
                `/api/exec/${jobId}/stop`,
                { method: "POST" }
            );

            assert.equal(stop.status, 400);
            assert.equal(stop.body.error, "Process not available");
        } finally {
            __testing.jobs.delete(jobId);
        }
    });

    it("stops running background jobs", async () => {
        const started = await requestJson<{ jobId: string }>(server, "/api/exec/start", {
            method: "POST",
            body: {
                command: process.execPath,
                args: ["-e", "setTimeout(() => {}, 10_000)"],
            },
        });

        assert.equal(started.status, 200);

        const stop = await requestJson<{ success: true; message: string }>(
            server,
            `/api/exec/${started.body.jobId}/stop`,
            { method: "POST" }
        );

        assert.equal(stop.status, 200);
        assert.deepEqual(stop.body, { success: true, message: "Stop signal sent" });

        const job = await waitForJob(server, started.body.jobId);
        assert.equal(job.status, "done");
        assert.equal(job.code, 130);
    });

    it("falls back to direct process kill when process group stop fails", async () => {
        const originalKill = process.kill;
        const jobId = "running-with-fallback-kill";
        let fallbackKilled = false;
        const fakeProcess = {
            killed: false,
            pid: 123_456,
            kill(signal: NodeJS.Signals): boolean {
                assert.equal(signal, "SIGTERM");
                fakeProcess.killed = true;
                fallbackKilled = true;
                return true;
            },
        };
        __testing.jobs.set(jobId, {
            id: jobId,
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
            endedAt: null,
            process: fakeProcess as never,
        });

        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            assert.equal(pid, -123_456);
            assert.equal(signal, "SIGTERM");
            throw new Error("no process group");
        }) as typeof process.kill;

        try {
            const stop = await requestJson<{ success: true; message: string }>(
                server,
                `/api/exec/${jobId}/stop`,
                { method: "POST" }
            );

            assert.equal(stop.status, 200);
            assert.equal(fallbackKilled, true);
            fakeProcess.killed = true;
        } finally {
            process.kill = originalKill;
            __testing.jobs.delete(jobId);
        }
    });

    it("force kills lingering stopped jobs and ignores missing process groups", async () => {
        const originalKill = process.kill;
        const jobId = "running-with-force-kill";
        const signals: Array<NodeJS.Signals | number | undefined> = [];
        const fakeProcess = {
            killed: false,
            pid: 234_567,
            kill(signal: NodeJS.Signals): boolean {
                assert.equal(signal, "SIGTERM");
                fakeProcess.killed = true;
                return true;
            },
        };
        __testing.jobs.set(jobId, {
            id: jobId,
            status: "running",
            code: null,
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
            endedAt: null,
            process: fakeProcess as never,
        });

        process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
            assert.equal(pid, -234_567);
            signals.push(signal);
            if (signal === "SIGKILL") {
                throw new Error("already gone");
            }
            return true;
        }) as typeof process.kill;

        try {
            const stop = await requestJson<{ success: true; message: string }>(
                server,
                `/api/exec/${jobId}/stop`,
                { method: "POST" }
            );

            assert.equal(stop.status, 200);
            await delay(3_050);
            assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
        } finally {
            process.kill = originalKill;
            __testing.jobs.delete(jobId);
        }
    });
});
